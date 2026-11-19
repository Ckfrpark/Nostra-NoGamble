import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../src/server.ts';
import { Platform } from '../src/platform.ts';
import { SqliteStore } from '../src/journal.ts';
import { DevIdentityProvider } from '../src/identity.ts';

const ADMIN = 'test-admin';

async function boot(dbPath: string, now = () => new Date('2026-11-20T03:00:00Z'), extra: Partial<AppOptions> = {}) {
  const store = new SqliteStore(dbPath);
  const platform = await Platform.open(store);
  const app = createApp({ platform, sessions: store, devIdentity: new DevIdentityProvider('s'), adminToken: ADMIN, now, ...extra });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const stop = () => new Promise<void>((r) => { app.close(() => { store.close(); r(); }); app.closeAllConnections(); });
  return { base, platform, stop };
}

function client(base: string) {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: (await res.json()) as any };
  };
}

const admin = { 'x-admin-token': ADMIN };
const eventBody = {
  id: 'rain', title: '내일 서울에 비가 올까?', category: '날씨', rules: '기상청 서울 관측소 일 강수량 0.1mm 이상이면 예',
  closesAt: '2026-11-21T00:00:00Z', markets: [{ id: 'rain-yes', title: '비 온다' }],
};

test('가입부터 거래, 정산, 손실 보호, 재시작 복원까지', async () => {
  const db = join(mkdtempSync(join(tmpdir(), 'alal-')), 'db.sqlite');
  let s = await boot(db);
  const a = client(s.base);
  const b = client(s.base);
  const anon = client(s.base);

  assert.equal((await a('POST', '/api/auth/verify', { phone: '010-1111-2222' })).body.status, 'needs_nickname');
  assert.equal((await a('POST', '/api/auth/verify', { phone: '010-1111-2222', nickname: '예측왕' })).status, 201);
  assert.equal((await b('POST', '/api/auth/verify', { phone: '01033334444', nickname: '신중한곰' })).status, 201);
  // 같은 번호로 다시 인증하면 새 계정이 아니라 로그인
  const again = client(s.base);
  assert.equal((await again('POST', '/api/auth/verify', { phone: '01011112222' })).body.status, 'logged_in');

  assert.equal((await anon('POST', '/api/admin/events', eventBody)).status, 403);
  assert.equal((await anon('POST', '/api/admin/events', eventBody, admin)).status, 201);
  assert.equal((await anon('POST', '/api/orders', { marketId: 'rain-yes', side: 'yes', price: 60, qty: 5 })).status, 401);

  assert.equal((await b('POST', '/api/orders', { marketId: 'rain-yes', side: 'no', price: 40, qty: 5 })).status, 201);
  const r = await a('POST', '/api/orders', { marketId: 'rain-yes', side: 'yes', price: 60, qty: 5 });
  assert.equal(r.body.fills.length, 1);
  assert.equal(r.body.me.protectedPrincipal, 300);

  const ev = await anon('GET', '/api/events/rain');
  assert.equal(ev.body.markets[0].lastYesPrice, 60);
  assert.equal(ev.body.markets[0].volume, 5);

  assert.equal((await a('POST', '/api/orders', { marketId: 'rain-yes', side: 'yes', price: 150, qty: 1 })).status, 400);

  // 재시작해도 상태가 같다
  await s.stop();
  s = await boot(db);
  const a2 = client(s.base);
  const anon2 = client(s.base);
  await a2('POST', '/api/auth/verify', { phone: '01011112222' });
  assert.equal((await a2('GET', '/api/me')).body.me.protectedPrincipal, 300);

  const settle = await anon2('POST', '/api/admin/events/rain/settle', { winner: null }, admin);
  assert.equal(settle.status, 200);
  const me = (await a2('GET', '/api/me')).body.me;
  assert.equal(me.balance, 1000); // 졌지만 손실 보호로 원금 회복
  assert.equal(me.seasonScore, -300);
  const pf = (await a2('GET', '/api/portfolio')).body;
  assert.equal(pf.history[0].refund, 300);

  const lb = (await anon2('GET', '/api/leaderboard')).body;
  assert.equal(lb.rows[0].nickname, '신중한곰');
  assert.equal((await anon2('GET', '/api/admin/supply', undefined, admin)).body.refundsMinted, 300);
  await s.stop();
});

test('마감 시각이 지나면 자동으로 거래가 마감된다', async () => {
  let t = new Date('2026-11-20T03:00:00Z');
  const s = await boot(':memory:', () => t);
  const a = client(s.base);
  await a('POST', '/api/auth/verify', { phone: '01055556666', nickname: '시계' });
  await a('POST', '/api/admin/events', eventBody, admin);
  t = new Date('2026-11-21T00:00:01Z');
  const r = await a('POST', '/api/orders', { marketId: 'rain-yes', side: 'yes', price: 50, qty: 1 });
  assert.equal(r.status, 400);
  assert.equal((await a('GET', '/api/events/rain')).body.status, 'closed');
  await s.stop();
});

test('출석 지급은 한국 날짜 기준 하루 한 번', async () => {
  let t = new Date('2026-11-20T03:00:00Z');
  const s = await boot(':memory:', () => t);
  const a = client(s.base);
  await a('POST', '/api/auth/verify', { phone: '01077778888', nickname: '출석러' });
  assert.equal((await a('POST', '/api/allowance')).body.granted, 100);
  assert.equal((await a('POST', '/api/allowance')).body.granted, 0);
  t = new Date('2026-11-20T15:00:01Z'); // 한국 시간 11/21 00:00:01
  assert.equal((await a('POST', '/api/allowance')).body.granted, 100);
  await s.stop();
});

test('다른 사람의 주문은 취소할 수 없다', async () => {
  const s = await boot(':memory:');
  const a = client(s.base);
  const b = client(s.base);
  await a('POST', '/api/auth/verify', { phone: '01012345678', nickname: '에이' });
  await b('POST', '/api/auth/verify', { phone: '01087654321', nickname: '비이' });
  await a('POST', '/api/admin/events', eventBody, admin);
  const { body } = await a('POST', '/api/orders', { marketId: 'rain-yes', side: 'yes', price: 30, qty: 1 });
  assert.equal((await b('DELETE', `/api/orders/${body.orderId}`)).status, 400);
  assert.equal((await a('DELETE', `/api/orders/${body.orderId}`)).status, 200);
  await s.stop();
});
