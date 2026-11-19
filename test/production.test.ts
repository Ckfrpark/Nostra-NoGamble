import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../src/server.ts';
import { Platform } from '../src/platform.ts';
import { SqliteStore, PgStore, type Store } from '../src/journal.ts';
import { eventIdFor, parseNostraPayload, toCreateEvent, toYesPrice } from '../src/nostra-import.ts';

const ADMIN = 'adm';
const NOW = new Date('2026-11-20T03:00:00Z');

async function boot(extra: Partial<AppOptions> = {}, store: Store = new SqliteStore(':memory:')) {
  const platform = await Platform.open(store);
  const app = createApp({ platform, sessions: store, adminToken: ADMIN, now: () => NOW, ...extra });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const stop = () => new Promise<void>((r) => { app.close(() => r()); app.closeAllConnections(); });
  return { base, platform, stop };
}

const nostraBinary = {
  slug: 'lmarena-google-2026-11-30',
  question: '2026년 11월 30일 LMArena 텍스트 리더보드 1위 모델은 Google 모델일까?',
  description: '설명',
  resolution_criteria: '11월 30일 23:59 KST 기준 LMArena 텍스트 1위 모델의 개발사가 Google 이면 예',
  resolution_sources: ['https://lmarena.ai/leaderboard'],
  category: '기술',
  type: 'binary',
  status: 'open',
  close_at: '2026-11-30T14:00:00Z',
  outcomes: [{ idx: 0, label: 'YES', price: 850000 }, { idx: 1, label: 'NO', price: 150000 }],
};
const nostraCat = {
  slug: 'starship-flight-16',
  question: '스타십 16번째 비행 결과는?',
  category: '과학',
  type: 'categorical',
  status: 'open',
  close_at: '2026-12-31T15:00:00Z',
  outcomes: [{ idx: 0, label: '성공', price: 0.6 }, { idx: 1, label: '부분 성공', price: 0.3 }, { idx: 2, label: '실패', price: 0.1 }],
};

test('NOSTRA 예/아니오 시장은 마켓 1개 이벤트로, 확률은 참고 가격으로', () => {
  const c = toCreateEvent(nostraBinary as any);
  assert.equal(c.exhaustive, false);
  assert.equal(c.markets.length, 1);
  assert.equal(c.markets[0].refPrice, 85);
  assert.match(c.rules, /lmarena\.ai/);
  assert.equal(c.source, 'nostra:lmarena-google-2026-11-30');
  assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(c.id) && `${c.id}-y`.length <= 40);
});

test('NOSTRA 선택지 시장은 선택지마다 마켓이 있는 이벤트로', () => {
  const c = toCreateEvent(nostraCat as any);
  assert.equal(c.exhaustive, true);
  assert.deepEqual(c.markets.map((m) => [m.title, m.refPrice]), [['성공', 60], ['부분 성공', 30], ['실패', 10]]);
});

test('긴 slug나 한글 slug도 안전한 id로', () => {
  for (const slug of ['아주-긴-한글-슬러그-입니다-'.repeat(5), 'x'.repeat(80), 'a b c']) {
    const id = eventIdFor(slug);
    assert.ok(/^[A-Za-z0-9_-]{1,40}$/.test(id) && id.length <= 37, id);
  }
  assert.equal(toYesPrice(0.004), 1);
  assert.equal(toYesPrice('999999'), 99);
  assert.equal(parseNostraPayload({ items: [nostraBinary] }).length, 1);
});

test('운영 화면에서 NOSTRA 시장 목록을 가져오면 이벤트가 생기고 다시 가져와도 중복되지 않는다', async () => {
  const s = await boot();
  const post = (body: unknown) => fetch(`${s.base}/api/admin/import-nostra`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify(body) }).then((r) => r.json() as any);
  const closed = { ...nostraBinary, slug: 'old', status: 'resolved' };
  const r1 = await post({ items: [nostraBinary, nostraCat, closed] });
  assert.equal(r1.created.length, 2);
  assert.equal(r1.skipped[0].slug, 'old');
  const r2 = await post({ items: [nostraBinary] });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.skipped[0].reason, '이미 가져옴');
  const ev = await (await fetch(`${s.base}/api/events/${r1.created[0]}`)).json() as any;
  assert.equal(ev.markets[0].lastYesPrice, 85);
  await s.stop();
});

function fakeOlgong(users: Record<string, { id: string; nickname?: string }>): typeof fetch {
  return (async (input: any, init: any) => {
    const url = new URL(String(input));
    const tok = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    const u = users[tok];
    if (url.pathname === '/auth/v1/user') return u ? Response.json({ id: u.id, email: 'x@example.com' }) : new Response('no', { status: 401 });
    if (url.pathname === '/rest/v1/member_profiles') return Response.json(u?.nickname ? [{ nickname: u.nickname }] : []);
    return new Response('?', { status: 404 });
  }) as typeof fetch;
}

const olgong = { url: 'https://olgong.example', key: 'pub', secret: 'x'.repeat(32) };

test('올공나라 로그인: 토큰 확인 후 가입·로그인, 잘못된 토큰은 거부, 개발용 인증은 꺼짐', async () => {
  const s = await boot({ olgong, olgongFetch: fakeOlgong({ ['t'.repeat(30)]: { id: 'olg-1', nickname: '올공회원' }, ['n'.repeat(30)]: { id: 'olg-2' } }) });
  const call = (path: string, body: unknown) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cfg = await (await fetch(`${s.base}/api/config`)).json() as any;
  assert.equal(cfg.devLogin, false);
  assert.match(cfg.olgong.kakao, /provider=kakao/);
  assert.equal((await call('/api/auth/verify', { phone: '01011112222' })).status, 404);
  assert.equal((await call('/api/auth/olgong', { access_token: 'bad'.repeat(10) })).status, 401);
  const r1 = await call('/api/auth/olgong', { access_token: 't'.repeat(30) });
  assert.equal(r1.status, 201);
  assert.equal(((await r1.json()) as any).me.nickname, '올공회원');
  assert.equal(((await (await call('/api/auth/olgong', { access_token: 't'.repeat(30) })).json()) as any).status, 'logged_in');
  // 올공 닉네임이 없으면 닉네임을 받는다
  assert.equal(((await (await call('/api/auth/olgong', { access_token: 'n'.repeat(30) })).json()) as any).status, 'needs_nickname');
  assert.equal((await call('/api/auth/olgong', { access_token: 'n'.repeat(30), nickname: '새회원' })).status, 201);
  await s.stop();
});

test('올공나라 사이트에서 넘어오는 로그인은 올공 출처만 받는다', async () => {
  const s = await boot({ olgong, olgongPortalOrigin: 'https://olgong.xyz', olgongFetch: fakeOlgong({ ['t'.repeat(30)]: { id: 'olg-1', nickname: '올공회원' } }) });
  const form = (origin: string) => fetch(`${s.base}/auth/from-olgong`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `access_token=${'t'.repeat(30)}` });
  assert.equal((await form('https://evil.example')).status, 403);
  const ok = await form('https://olgong.xyz');
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('set-cookie') ?? '', /sid=/);
  await s.stop();
});

test('PostgreSQL 저널: 기록 후 재시작하면 복원되고, 저널은 수정할 수 없다', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = process.env.TEST_DATABASE_URL!;
  let store = await PgStore.open(url);
  await store.pool.query('DROP TABLE IF EXISTS commands CASCADE; DROP TABLE IF EXISTS sessions');
  await store.close();
  store = await PgStore.open(url);
  const p = await Platform.open(store);
  await p.exec({ t: 'register', userId: 'u1', identityId: 'i1', nickname: '하나' });
  await p.exec({ t: 'createEvent', id: 'e', title: 'q', category: 'c', rules: 'r', closesAt: '2027-01-01T00:00:00Z', exhaustive: false, markets: [{ id: 'e-y', title: '예', refPrice: 40 }] });
  await p.exec({ t: 'order', userId: 'u1', marketId: 'e-y', side: 'yes', price: 30, qty: 2 });
  await store.createSession('tok', 'u1', new Date().toISOString());
  await assert.rejects(store.pool.query('DELETE FROM commands'), /append-only/);
  await store.close();
  const store2 = await PgStore.open(url);
  const p2 = await Platform.open(store2);
  assert.equal(p2.engine.user('u1').balance, 940);
  assert.equal(p2.engine.markets.get('e-y')!.lastYesPrice, 40);
  assert.equal(await store2.getSession('tok'), 'u1');
  await store2.close();
});
