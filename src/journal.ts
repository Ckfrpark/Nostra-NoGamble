// 명령 저널과 세션 저장소 (SQLite, Node 내장 node:sqlite).
// 운영 환경에서는 같은 인터페이스로 PostgreSQL 구현을 붙이면 된다.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Journal {
  all(): { seq: number; ts: string; cmd: unknown }[];
  append(cmd: unknown, ts: string): void;
}

export interface SessionStore {
  create(token: string, userId: string, ts: string): void;
  get(token: string): string | undefined;
  delete(token: string): void;
}

export class SqliteStore implements Journal, SessionStore {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cmd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }

  all() {
    const rows = this.db.prepare('SELECT seq, ts, cmd FROM commands ORDER BY seq').all() as { seq: number; ts: string; cmd: string }[];
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, cmd: JSON.parse(r.cmd) }));
  }

  append(cmd: unknown, ts: string) {
    this.db.prepare('INSERT INTO commands (ts, cmd) VALUES (?, ?)').run(ts, JSON.stringify(cmd));
  }

  create(token: string, userId: string, ts: string) {
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, ts);
  }

  get(token: string) {
    const r = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: string } | undefined;
    return r?.user_id;
  }

  delete(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  close() {
    this.db.close();
  }
}
