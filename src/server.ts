// HTTP API 서버 + 정적 웹 화면.
// 실행: node src/server.ts   (환경변수: PORT, DB_PATH, ADMIN_TOKEN, IDENTITY_SECRET)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, type Side } from './engine.ts';
import { Platform, kstDay } from './platform.ts';
import { SqliteStore, type SessionStore } from './journal.ts';
import { DevIdentityProvider, type IdentityProvider } from './identity.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface AppOptions {
  platform: Platform;
  sessions: SessionStore;
  identity: IdentityProvider;
  adminToken: string;
  now?: () => Date;
  secureCookie?: boolean;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, '요청이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'JSON 형식 오류');
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const int = (v: unknown, name: string) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, `${name}은(는) 정수여야 합니다`);
  return v;
};
const str = (v: unknown, name: string, max = 500) => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new HttpError(400, `${name}이(가) 올바르지 않습니다`);
  return v.trim();
};
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function createApp(opts: AppOptions): Server {
  const { platform: p, sessions, identity } = opts;
  const now = opts.now ?? (() => new Date());
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${opts.secureCookie ? '; Secure' : ''}`;

  const currentUser = (req: IncomingMessage) => {
    const token = cookies(req).sid;
    const uid = token ? sessions.get(token) : undefined;
    return uid && p.engine.users.has(uid) ? uid : undefined;
  };
  const requireUser = (req: IncomingMessage) => {
    const uid = currentUser(req);
    if (!uid) throw new HttpError(401, '로그인이 필요합니다');
    return uid;
  };
  const requireAdmin = (req: IncomingMessage) => {
    const t = req.headers['x-admin-token'];
    if (!opts.adminToken || typeof t !== 'string' || !safeEqual(t, opts.adminToken)) throw new HttpError(403, '관리자 권한이 필요합니다');
  };
  const login = (uid: string) => {
    const token = randomBytes(32).toString('hex');
    sessions.create(token, uid, now().toISOString());
    return { 'set-cookie': `sid=${token}; ${cookieFlags}; Max-Age=${60 * 60 * 24 * 30}` };
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    p.closeDueEvents(now());
    let m: RegExpMatchArray | null;

    // --- 인증 ---
    if (method === 'POST' && path === '/api/auth/verify') {
      const body = await readJson(req);
      const identityId = await identity.verify(body);
      if (!identityId) throw new HttpError(400, '본인인증에 실패했습니다');
      const existing = p.engine.identities.get(identityId);
      if (existing) return send(res, 200, { status: 'logged_in', me: p.me(existing, now()) }, login(existing));
      if (body.nickname === undefined) return send(res, 200, { status: 'needs_nickname' });
      const userId = p.newUserId();
      p.exec({ t: 'register', userId, identityId, nickname: str(body.nickname, '닉네임', 16) }, now());
      return send(res, 201, { status: 'registered', me: p.me(userId, now()) }, login(userId));
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = cookies(req).sid;
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true }, { 'set-cookie': `sid=; ${cookieFlags}; Max-Age=0` });
    }

    // --- 공개 조회 ---
    if (method === 'GET' && path === '/api/events') return send(res, 200, { events: p.listEvents() });
    if (method === 'GET' && (m = path.match(/^\/api\/events\/([^/]+)$/))) {
      const v = p.eventView(decodeURIComponent(m[1]), true);
      if (!v) throw new HttpError(404, '이벤트가 없습니다');
      return send(res, 200, v);
    }
    if (method === 'GET' && path === '/api/leaderboard') return send(res, 200, p.leaderboard());

    // --- 로그인 사용자 ---
    if (method === 'GET' && path === '/api/me') {
      const uid = currentUser(req);
      return send(res, 200, { me: uid ? p.me(uid, now()) : null });
    }
    if (method === 'POST' && path === '/api/allowance') {
      const uid = requireUser(req);
      const r = p.exec({ t: 'allowance', userId: uid, day: kstDay(now()) }, now());
      return send(res, 200, { ...(r as object), me: p.me(uid, now()) });
    }
    if (method === 'GET' && path === '/api/portfolio') return send(res, 200, p.portfolio(requireUser(req)));
    if (method === 'POST' && path === '/api/orders') {
      const uid = requireUser(req);
      const b = await readJson(req);
      const side = b.side;
      if (side !== 'yes' && side !== 'no') throw new HttpError(400, 'side는 yes 또는 no');
      const r = p.exec(
        { t: 'order', userId: uid, marketId: str(b.marketId, 'marketId', 40), side: side as Side, price: int(b.price, '가격'), qty: int(b.qty, '수량') },
        now(),
      );
      return send(res, 201, { ...(r as object), me: p.me(uid, now()) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/orders\/(\d+)$/))) {
      const uid = requireUser(req);
      p.exec({ t: 'cancel', userId: uid, orderId: Number(m[1]) }, now());
      return send(res, 200, { ok: true, me: p.me(uid, now()) });
    }

    // --- 관리자 ---
    if (path.startsWith('/api/admin/')) {
      requireAdmin(req);
      if (method === 'GET' && path === '/api/admin/supply') return send(res, 200, p.supply());
      if (method === 'GET' && path === '/api/admin/flags') return send(res, 200, { flags: p.flags() });
      if (method === 'POST' && path === '/api/admin/season') return send(res, 200, p.exec({ t: 'season' }, now()));
      if (method === 'POST' && path === '/api/admin/events') {
        const b = await readJson(req);
        const id = str(b.id, '이벤트 id', 40);
        if (!ID_RE.test(id)) throw new HttpError(400, '이벤트 id는 영문·숫자·_- 40자 이내');
        if (!Array.isArray(b.markets) || b.markets.length === 0 || b.markets.length > 30) throw new HttpError(400, '마켓은 1~30개');
        const markets = b.markets.map((x: unknown, i: number) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const mid = o.id === undefined ? `${id}-${i + 1}` : str(o.id, '마켓 id', 40);
          if (!ID_RE.test(mid)) throw new HttpError(400, '마켓 id는 영문·숫자·_- 40자 이내');
          return { id: mid, title: str(o.title, '마켓 제목', 100) };
        });
        const r = p.exec(
          {
            t: 'createEvent',
            id,
            title: str(b.title, '제목', 120),
            category: typeof b.category === 'string' && b.category.trim() ? b.category.trim().slice(0, 20) : '기타',
            rules: str(b.rules, '정산 규칙', 2000),
            closesAt: new Date(str(b.closesAt, '마감 시각', 40)).toISOString(),
            exhaustive: markets.length > 1 && b.exhaustive !== false,
            markets,
          },
          now(),
        );
        return send(res, 201, r);
      }
      if (method === 'POST' && (m = path.match(/^\/api\/admin\/events\/([^/]+)\/(close|settle|void)$/))) {
        const eventId = decodeURIComponent(m[1]);
        if (m[2] === 'close') return send(res, 200, p.exec({ t: 'close', eventId }, now()));
        if (m[2] === 'void') return send(res, 200, p.exec({ t: 'void', eventId }, now()));
        const b = await readJson(req);
        const winner = b.winner === null ? null : str(b.winner, 'winner', 40);
        return send(res, 200, p.exec({ t: 'settle', eventId, winner }, now()));
      }
    }
    throw new HttpError(404, '없는 API');
  }

  async function serveStatic(res: ServerResponse, path: string) {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const full = normalize(join(WEB_DIR, rel));
    if (!full.startsWith(WEB_DIR)) return send(res, 404, { error: 'not found' });
    try {
      const data = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
      });
      res.end(data);
    } catch {
      // SPA: 알 수 없는 경로는 index.html
      if (!extname(full)) return serveStatic(res, '/');
      send(res, 404, { error: 'not found' });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['content-type'] && !String(req.headers['content-type']).startsWith('application/json'))
          throw new HttpError(415, 'JSON만 받습니다');
        await api(req, res, url.pathname);
      } else await serveStatic(res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else if (err instanceof EngineError) send(res, 400, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: '서버 오류' });
      }
    }
  });
}

// 직접 실행 시 서버 시작
if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new SqliteStore(process.env.DB_PATH ?? 'data/alal.db');
  const adminToken = process.env.ADMIN_TOKEN ?? '';
  if (!adminToken) console.warn('ADMIN_TOKEN이 없어 관리자 API가 꺼져 있습니다.');
  const secret = process.env.IDENTITY_SECRET ?? 'dev-only-secret';
  const app = createApp({
    platform: new Platform(store),
    sessions: store,
    identity: new DevIdentityProvider(secret),
    adminToken,
    secureCookie: process.env.NODE_ENV === 'production',
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`http://localhost:${port}`));
}
