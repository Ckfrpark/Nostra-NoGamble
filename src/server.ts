// HTTP API 서버 + 정적 웹 화면.
// 실행: node src/server.ts   (환경변수: PORT, DB_PATH, ADMIN_TOKEN, IDENTITY_SECRET)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, type Side } from './engine.ts';
import { Platform, kstDay } from './platform.ts';
import { openStore, type SessionStore } from './journal.ts';
import { DevIdentityProvider, type IdentityProvider } from './identity.ts';
import { olgongAuthorizeUrl, olgongConfigFromEnv, verifyOlgongToken, type OlgongConfig } from './olgong.ts';
import { parseNostraPayload, toCreateEvent } from './nostra-import.ts';

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
  /** 개발용 본인인증 (휴대폰 번호). 운영에서는 넣지 않는다. */
  devIdentity?: IdentityProvider;
  /** 올공나라 로그인 */
  olgong?: OlgongConfig | null;
  olgongFetch?: typeof fetch;
  /** 올공나라 사이트에서 바로 로그인시켜 주는 폼 POST를 받을 출처 */
  olgongPortalOrigin?: string;
  publicBaseUrl?: string;
  adminToken: string;
  now?: () => Date;
  secureCookie?: boolean;
}

/** 아주 단순한 메모리 요청 제한 (프로세스 하나 기준) */
function rateLimiter() {
  const hits = new Map<string, number[]>();
  return (key: string, max: number, windowMs: number) => {
    const t = Date.now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= max) throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요');
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 50_000) hits.clear();
  };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, '요청이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, '요청이 너무 큽니다');
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
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
  const { platform: p, sessions } = opts;
  const now = opts.now ?? (() => new Date());
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${opts.secureCookie ? '; Secure' : ''}`;
  const limit = rateLimiter();
  const clientIp = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'local';

  const currentUser = async (req: IncomingMessage) => {
    const token = cookies(req).sid;
    const uid = token ? await sessions.getSession(token) : undefined;
    return uid && p.engine.users.has(uid) ? uid : undefined;
  };
  const requireUser = async (req: IncomingMessage) => {
    const uid = await currentUser(req);
    if (!uid) throw new HttpError(401, '로그인이 필요합니다');
    return uid;
  };
  const requireAdmin = (req: IncomingMessage) => {
    const t = req.headers['x-admin-token'];
    if (!opts.adminToken || typeof t !== 'string' || !safeEqual(t, opts.adminToken)) throw new HttpError(403, '관리자 권한이 필요합니다');
  };
  const login = async (uid: string) => {
    const token = randomBytes(32).toString('hex');
    await sessions.createSession(token, uid, now().toISOString());
    return { 'set-cookie': `sid=${token}; ${cookieFlags}; Max-Age=${60 * 60 * 24 * 30}` };
  };
  /** 쓰고 있는 닉네임이면 뒤에 숫자를 붙인다 */
  const freeNickname = (base: string) => {
    const taken = new Set(p.nicknames.values());
    let n = base.trim().slice(0, 16);
    if (n.length < 2) n = '회원';
    if (!taken.has(n)) return n;
    for (let i = 0; i < 1000; i++) {
      const c = `${n.slice(0, 11)}${Math.floor(1000 + Math.random() * 9000)}`;
      if (!taken.has(c)) return c;
    }
    throw new HttpError(409, '닉네임을 만들지 못했습니다');
  };
  /** identityId로 로그인하거나 가입한다. 닉네임이 없으면 needs_nickname. */
  const enter = async (res: ServerResponse, identityId: string, nickname: string | undefined) => {
    const existing = p.engine.identities.get(identityId);
    if (existing) return send(res, 200, { status: 'logged_in', me: p.me(existing, now()) }, await login(existing));
    if (nickname === undefined) return send(res, 200, { status: 'needs_nickname' });
    const userId = p.newUserId();
    await p.exec({ t: 'register', userId, identityId, nickname }, now());
    return send(res, 201, { status: 'registered', me: p.me(userId, now()) }, await login(userId));
  };
  const optNickname = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : str(v, '닉네임', 16));

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';
    await p.closeDueEvents(now());
    let m: RegExpMatchArray | null;

    // --- 인증 ---
    if (method === 'GET' && path === '/api/config') {
      const base = opts.publicBaseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
      const redirect = `${base.replace(/\/+$/, '')}/auth/olgong`;
      return send(res, 200, {
        devLogin: !!opts.devIdentity,
        olgong: opts.olgong
          ? { kakao: olgongAuthorizeUrl(opts.olgong, 'kakao', redirect), google: olgongAuthorizeUrl(opts.olgong, 'google', redirect) }
          : null,
      });
    }
    if (method === 'POST' && path === '/api/auth/verify') {
      if (!opts.devIdentity) throw new HttpError(404, '개발용 인증이 꺼져 있습니다');
      limit(`verify:${clientIp(req)}`, 30, 10 * 60_000);
      const body = await readJson(req);
      const identityId = await opts.devIdentity.verify(body);
      if (!identityId) throw new HttpError(400, '본인인증에 실패했습니다');
      return enter(res, identityId, optNickname(body.nickname));
    }
    if (method === 'POST' && path === '/api/auth/olgong') {
      if (!opts.olgong) throw new HttpError(404, '올공나라 로그인이 설정되지 않았습니다');
      limit(`olgong:${clientIp(req)}`, 30, 10 * 60_000);
      const body = await readJson(req);
      const who = await verifyOlgongToken(opts.olgong, String(body.access_token ?? ''), opts.olgongFetch);
      if (!who) throw new HttpError(401, '올공나라 로그인을 확인하지 못했습니다. 다시 로그인해 주세요');
      const nick = optNickname(body.nickname) ?? (who.nickname ? freeNickname(who.nickname) : undefined);
      return enter(res, who.identityId, nick);
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = cookies(req).sid;
      if (token) await sessions.deleteSession(token);
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
      const uid = await currentUser(req);
      return send(res, 200, { me: uid ? p.me(uid, now()) : null });
    }
    if (method === 'POST' && path === '/api/allowance') {
      const uid = await requireUser(req);
      const r = await p.exec({ t: 'allowance', userId: uid, day: kstDay(now()) }, now());
      return send(res, 200, { ...(r as object), me: p.me(uid, now()) });
    }
    if (method === 'GET' && path === '/api/portfolio') return send(res, 200, p.portfolio(await requireUser(req)));
    if (method === 'POST' && path === '/api/orders') {
      const uid = await requireUser(req);
      limit(`order:${uid}`, 120, 60_000);
      const b = await readJson(req);
      const side = b.side;
      if (side !== 'yes' && side !== 'no') throw new HttpError(400, 'side는 yes 또는 no');
      const r = await p.exec(
        { t: 'order', userId: uid, marketId: str(b.marketId, 'marketId', 40), side: side as Side, price: int(b.price, '가격'), qty: int(b.qty, '수량') },
        now(),
      );
      return send(res, 201, { ...(r as object), me: p.me(uid, now()) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/orders\/(\d+)$/))) {
      const uid = await requireUser(req);
      await p.exec({ t: 'cancel', userId: uid, orderId: Number(m[1]) }, now());
      return send(res, 200, { ok: true, me: p.me(uid, now()) });
    }

    // --- 관리자 ---
    if (path.startsWith('/api/admin/')) {
      requireAdmin(req);
      if (method === 'GET' && path === '/api/admin/supply') return send(res, 200, p.supply());
      if (method === 'GET' && path === '/api/admin/flags') return send(res, 200, { flags: p.flags() });
      if (method === 'POST' && path === '/api/admin/season') return send(res, 200, await p.exec({ t: 'season' }, now()));
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
        const r = await p.exec(
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
        if (m[2] === 'close') return send(res, 200, await p.exec({ t: 'close', eventId }, now()));
        if (m[2] === 'void') return send(res, 200, await p.exec({ t: 'void', eventId }, now()));
        const b = await readJson(req);
        const winner = b.winner === null ? null : str(b.winner, 'winner', 40);
        return send(res, 200, await p.exec({ t: 'settle', eventId, winner }, now()));
      }
      if (method === 'POST' && path === '/api/admin/import-nostra') {
        const items = parseNostraPayload(await readJson(req, 2 * 1024 * 1024).then((b) => (b.payload !== undefined ? b.payload : b)));
        const created: string[] = [];
        const skipped: { slug: string; reason: string }[] = [];
        for (const it of items) {
          const slug = String(it?.slug ?? '?');
          if (it.status && it.status !== 'open') { skipped.push({ slug, reason: `상태 ${it.status}` }); continue; }
          if (Date.parse(it.close_at) <= now().getTime()) { skipped.push({ slug, reason: '마감 시각이 지남' }); continue; }
          if (p.sources.has(`nostra:${slug}`)) { skipped.push({ slug, reason: '이미 가져옴' }); continue; }
          try {
            const cmd = toCreateEvent(it);
            await p.exec(cmd, now());
            created.push(cmd.id);
          } catch (err) {
            skipped.push({ slug, reason: (err as Error).message });
          }
        }
        return send(res, 200, { created, skipped });
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
        ...SECURITY_HEADERS,
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(data);
    } catch {
      // SPA: 알 수 없는 경로는 index.html
      if (!extname(full)) return serveStatic(res, '/');
      send(res, 404, { error: 'not found' });
    }
  }

  /** 올공나라 사이트에서 access_token 을 폼으로 보내면 로그인시키고 첫 화면으로 보낸다. */
  async function fromOlgong(req: IncomingMessage, res: ServerResponse) {
    if (!opts.olgong || !opts.olgongPortalOrigin) throw new HttpError(404, '없는 주소');
    if (req.headers.origin !== opts.olgongPortalOrigin) throw new HttpError(403, '올공나라에서 다시 접속해 주세요');
    limit(`olgong-portal:${clientIp(req)}`, 30, 10 * 60_000);
    const form = await readForm(req);
    const who = await verifyOlgongToken(opts.olgong, form.get('access_token') ?? '', opts.olgongFetch);
    if (!who) throw new HttpError(401, '올공나라에서 다시 로그인해 주세요');
    let uid = p.engine.identities.get(who.identityId);
    if (!uid) {
      uid = p.newUserId();
      await p.exec({ t: 'register', userId: uid, identityId: who.identityId, nickname: freeNickname(who.nickname ?? '회원') }, now());
    }
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...(await login(uid)) });
    res.end();
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/auth/from-olgong') await fromOlgong(req, res);
      else if (url.pathname.startsWith('/api/')) {
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
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.IDENTITY_SECRET || env.IDENTITY_SECRET.length < 32)) throw new Error('운영에서는 32자 이상 IDENTITY_SECRET 이 필요합니다');
  if (production && env.ALLOW_DEV_LOGIN === '1') throw new Error('운영에서는 ALLOW_DEV_LOGIN 을 켤 수 없습니다');
  const store = await openStore(env);
  const platform = await Platform.open(store);
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (!adminToken) console.warn('ADMIN_TOKEN이 없어 운영 API가 꺼져 있습니다.');
  const olgong = olgongConfigFromEnv(env);
  const app = createApp({
    platform,
    sessions: store,
    devIdentity: env.ALLOW_DEV_LOGIN === '1' ? new DevIdentityProvider(env.IDENTITY_SECRET ?? 'dev-only-secret') : undefined,
    olgong,
    olgongPortalOrigin: env.OLGONG_PORTAL_ORIGIN ?? 'https://olgong.xyz',
    publicBaseUrl: env.PUBLIC_BASE_URL,
    adminToken,
    secureCookie: production,
  });
  if (!olgong && env.ALLOW_DEV_LOGIN !== '1') console.warn('로그인 방법이 없습니다. OLGONG_SUPABASE_URL/KEY 또는 ALLOW_DEV_LOGIN=1 을 설정하세요.');
  // 마감 시각이 지난 이벤트는 요청이 없어도 30초마다 마감
  setInterval(() => platform.closeDueEvents().catch((e) => console.error(e)), 30_000).unref();
  const port = Number(env.PORT ?? 3000);
  app.listen(port, () => console.log(`http://localhost:${port} (${env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'})`));
  const shutdown = () => app.close(() => store.close().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
