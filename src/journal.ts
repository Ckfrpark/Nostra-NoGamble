// 명령 저널과 세션 저장소.
// - PostgreSQL (운영): DATABASE_URL 이 있으면 사용
// - SQLite (로컬 개발·테스트): Node 내장 node:sqlite
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

export interface JournalRow {
  seq: number;
  ts: string;
  cmd: unknown;
}

export interface Journal {
  all(): Promise<JournalRow[]>;
  append(cmd: unknown, ts: string): Promise<void>;
}

export interface SessionStore {
  createSession(token: string, userId: string, ts: string): Promise<void>;
  getSession(token: string): Promise<string | undefined>;
  deleteSession(token: string): Promise<void>;
}

export type Store = Journal & SessionStore & { close(): Promise<void> };

const SESSION_DAYS = 30;
/** 세션 토큰은 해시로만 저장한다 (DB가 유출돼도 토큰을 쓸 수 없게). */
const th = (token: string) => createHash('sha256').update(token).digest('hex');

export class SqliteStore implements Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cmd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    `);
  }

  async all() {
    const rows = this.db.prepare('SELECT seq, ts, cmd FROM commands ORDER BY seq').all() as { seq: number; ts: string; cmd: string }[];
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, cmd: JSON.parse(r.cmd) }));
  }

  async append(cmd: unknown, ts: string) {
    this.db.prepare('INSERT INTO commands (ts, cmd) VALUES (?, ?)').run(ts, JSON.stringify(cmd));
  }

  async createSession(token: string, userId: string, ts: string) {
    const exp = new Date(Date.parse(ts) + SESSION_DAYS * 86_400_000).toISOString();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(th(token), userId, ts, exp);
  }

  async getSession(token: string) {
    const r = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(th(token), new Date().toISOString()) as
      | { user_id: string }
      | undefined;
    return r?.user_id;
  }

  async deleteSession(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th(token));
  }

  async close() {
    this.db.close();
  }
}

export class PgStore implements Store {
  pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async open(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commands (
        seq BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        cmd JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      -- 저널은 추가만 가능: 수정·삭제를 DB 수준에서 막는다
      CREATE OR REPLACE FUNCTION commands_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'commands is append-only'; END $$;
      DROP TRIGGER IF EXISTS commands_no_change ON commands;
      CREATE TRIGGER commands_no_change BEFORE UPDATE OR DELETE ON commands FOR EACH ROW EXECUTE FUNCTION commands_append_only();
    `);
    return new PgStore(pool);
  }

  async all() {
    const r = await pool(this).query('SELECT seq, ts, cmd FROM commands ORDER BY seq');
    return r.rows.map((x) => ({ seq: Number(x.seq), ts: new Date(x.ts).toISOString(), cmd: x.cmd }));
  }

  async append(cmd: unknown, ts: string) {
    await pool(this).query('INSERT INTO commands (ts, cmd) VALUES ($1, $2)', [ts, JSON.stringify(cmd)]);
  }

  async createSession(token: string, userId: string, ts: string) {
    await pool(this).query(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $3::timestamptz + interval '${SESSION_DAYS} days')`,
      [th(token), userId, ts],
    );
  }

  async getSession(token: string) {
    const r = await pool(this).query('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [th(token)]);
    return r.rows[0]?.user_id as string | undefined;
  }

  async deleteSession(token: string) {
    await pool(this).query('DELETE FROM sessions WHERE token_hash = $1', [th(token)]);
  }

  async close() {
    await this.pool.end();
  }
}

const pool = (s: PgStore) => s.pool;

/** DATABASE_URL 이 있으면 PostgreSQL, 없으면 SQLite 파일. */
export async function openStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  if (env.DATABASE_URL) return PgStore.open(env.DATABASE_URL);
  return new SqliteStore(env.DB_PATH ?? 'data/alal.db');
}
