import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';

function setup(cfg = {}) {
  const e = new Engine({ eventExposureCap: 1000, ...cfg });
  e.registerUser('a', 'ci-a');
  e.registerUser('b', 'ci-b');
  e.registerUser('c', 'ci-c');
  e.createEvent('E1', '내일 서울 비?', [{ id: 'M1', title: '비 온다' }], false);
  return e;
}

test('예 60 + 아니오 40 이 체결되고 정답 측이 100을 받는다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  const { fills } = e.placeOrder('a', 'M1', 'yes', 60, 10);
  assert.equal(fills.length, 1);
  assert.equal(e.user('a').balance, 1000 - 600);
  assert.equal(e.user('b').balance, 1000 - 400);
  const lines = e.settleEvent('E1', 'M1');
  const a = lines.find((l) => l.userId === 'a')!;
  const b = lines.find((l) => l.userId === 'b')!;
  assert.equal(a.rawPnl, 400);
  assert.equal(a.fee, 40);
  assert.equal(b.rawPnl, -400);
  assert.equal(b.refund, 400);
  assert.equal(e.user('a').balance, 1360);
  assert.equal(e.user('b').balance, 1000); // 손실 없음
  e.checkInvariant();
});

test('테이커는 더 좋은 메이커 가격으로 체결되고 차액을 돌려받는다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 45, 5); // 예 55에 파는 것과 같음
  e.placeOrder('a', 'M1', 'yes', 60, 5);
  assert.equal(e.user('a').balance, 1000 - 275);
  e.checkInvariant();
});

test('어떤 사용자도 이벤트 정산 후 잔액이 줄지 않는다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 30, 10);
  e.placeOrder('a', 'M1', 'yes', 70, 10);
  e.placeOrder('c', 'M1', 'yes', 75, 5);
  e.placeOrder('a', 'M1', 'no', 25, 5); // a가 절반을 75에 매도
  e.settleEvent('E1', null); // 아니오가 정답
  for (const id of ['a', 'b', 'c']) assert.ok(e.user(id).balance >= 1000, id);
  e.checkInvariant();
});

test('양쪽 매수 악용: 같은 마켓 예·아니오는 상계되어 이득이 0', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  e.placeOrder('a', 'M1', 'yes', 60, 10);
  e.placeOrder('c', 'M1', 'yes', 55, 10);
  e.placeOrder('a', 'M1', 'no', 45, 10); // a가 아니오도 매수 → 예와 상계
  assert.equal(e.position('a', 'M1').yes, 0);
  assert.equal(e.position('a', 'M1').no, 0);
  e.settleEvent('E1', 'M1');
  assert.equal(e.user('a').balance, 1000); // 손실 5×10은 보전, 이익은 없음
  e.checkInvariant();
});

test('여러 후보 전부 매수 악용: 이벤트 단위로 합산되어 이득이 0', () => {
  const e = new Engine();
  e.registerUser('a', 'ci-a');
  e.registerUser('m', 'ci-m');
  e.createEvent('E', '누가 우승?', [{ id: 'X', title: 'X' }, { id: 'Y', title: 'Y' }, { id: 'Z', title: 'Z' }], true);
  e.placeOrder('m', 'X', 'no', 50, 3);
  e.placeOrder('m', 'Y', 'no', 70, 3);
  e.placeOrder('m', 'Z', 'no', 80, 3);
  e.placeOrder('a', 'X', 'yes', 50, 3);
  e.placeOrder('a', 'Y', 'yes', 30, 3);
  e.placeOrder('a', 'Z', 'yes', 20, 3);
  const line = e.settleEvent('E', 'Y').find((l) => l.userId === 'a')!;
  assert.equal(line.rawPnl, 0); // 마켓별로 보전했다면 X,Z 손실 210이 공짜 이득이 됐을 것
  assert.equal(line.refund, 0);
  e.checkInvariant();
});

test('여러 후보 전부 매수의 최악 손실은 0이라 보호 한도를 거의 쓰지 않는다', () => {
  const e = new Engine();
  e.registerUser('a', 'ci-a');
  e.createEvent('E', '누가 우승?', [{ id: 'X', title: 'X' }, { id: 'Y', title: 'Y' }], true);
  e.placeOrder('a', 'X', 'yes', 50, 5);
  assert.equal(e.worstCaseLoss('a', 'E'), 250);
  e.placeOrder('a', 'Y', 'yes', 50, 5);
  assert.equal(e.worstCaseLoss('a', 'E'), 0);
});

test('보호 한도: 이벤트당 최악 손실이 한도를 넘는 주문은 거부', () => {
  const e = setup({ eventExposureCap: 500 });
  e.placeOrder('a', 'M1', 'yes', 50, 10);
  assert.throws(() => e.placeOrder('a', 'M1', 'yes', 10, 1), /이벤트 보호 한도/);
});

test('보호 한도는 잔액이 늘어도 커지지 않는다 (실력 점수로만 완만히 증가)', () => {
  const e = setup();
  const u = e.user('a');
  const cap0 = e.exposureCap(u);
  u.balance = 1_000_000;
  assert.equal(e.exposureCap(u), cap0);
  u.skillScore = 2500;
  assert.equal(e.exposureCap(u), cap0 + 20 * 50);
});

test('1인 1계정: 같은 본인인증으로 두 번째 계정 불가', () => {
  const e = setup();
  assert.throws(() => e.registerUser('a2', 'ci-a'), /1인 1계정/);
});

test('자기거래 차단: 자신의 대기 주문과는 체결되지 않고 대기 주문이 취소된다', () => {
  const e = setup();
  const { order } = e.placeOrder('a', 'M1', 'no', 40, 5);
  const { fills } = e.placeOrder('a', 'M1', 'yes', 60, 5);
  assert.equal(fills.length, 0);
  assert.ok(!e.orders.has(order!.id));
  e.checkInvariant();
});

test('가격 밴드: 직전 체결가에서 크게 벗어난 칩 덤핑 체결은 막힌다', () => {
  const e = setup({ priceBand: 20 });
  e.placeOrder('b', 'M1', 'no', 90, 1);
  e.placeOrder('c', 'M1', 'yes', 10, 1); // 직전 체결가 10
  e.placeOrder('b', 'M1', 'yes', 99, 5); // 공모자가 예를 99에 사겠다고 걸어둠
  const { fills } = e.placeOrder('a', 'M1', 'no', 1, 5); // 본계정이 1에 아니오 매수(=예 99 매도) 시도
  assert.equal(fills.length, 0);
  e.checkInvariant();
});

test('거래상대 집중도 감시가 특정 상대와만 거래하는 쌍을 잡아낸다', () => {
  const e = setup({ concentrationMinVolume: 20, eventExposureCap: 10_000, baseExposureCap: 10_000 });
  for (let i = 0; i < 10; i++) {
    e.placeOrder('b', 'M1', 'no', 50, 2);
    e.placeOrder('a', 'M1', 'yes', 50, 2);
  }
  const flags = e.concentrationFlags();
  assert.ok(flags.some((f) => f.identity === 'ci-a' && f.counterparty === 'ci-b'));
});

test('이벤트 무효 시 모두 원금을 돌려받고 실력 점수는 변하지 않는다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  e.placeOrder('a', 'M1', 'yes', 60, 10);
  e.voidEvent('E1');
  assert.equal(e.user('a').balance, 1000);
  assert.equal(e.user('b').balance, 1000);
  assert.equal(e.user('a').skillScore, 0);
  e.checkInvariant();
});

test('출석 지급은 하루 한 번, 잔액 상한 이상이면 지급하지 않는다', () => {
  const e = setup();
  assert.equal(e.claimDailyAllowance('a', 1), 100);
  assert.equal(e.claimDailyAllowance('a', 1), 0);
  e.user('a').balance = 5000;
  assert.equal(e.claimDailyAllowance('a', 2), 0);
});

test('새 시즌은 랭킹 점수만 초기화하고 알 잔액과 보호 한도는 유지한다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  e.placeOrder('a', 'M1', 'yes', 60, 10);
  e.settleEvent('E1', 'M1');
  assert.equal(e.leaderboard()[0].userId, 'a');
  const balance = e.user('a').balance;
  const cap = e.exposureCap(e.user('a'));
  const { season, finalStandings } = e.startNewSeason();
  assert.equal(season, 1);
  assert.equal(finalStandings[0].score, 400);
  assert.equal(e.user('a').seasonScore, 0);
  assert.equal(e.user('a').balance, balance);
  assert.equal(e.exposureCap(e.user('a')), cap);
  e.checkInvariant();
});

test('거래 마감 후에는 주문이 막히고 정산은 가능하다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  e.placeOrder('a', 'M1', 'yes', 60, 10);
  e.placeOrder('c', 'M1', 'yes', 30, 1); // 대기 주문
  e.closeEvent('E1');
  assert.equal(e.userOrders('c').length, 0);
  assert.throws(() => e.placeOrder('c', 'M1', 'yes', 50, 1), /거래 종료/);
  e.settleEvent('E1', 'M1');
  e.checkInvariant();
});

test('보호 원금은 열린 이벤트에 들어간 순지불액이고 정산 후 최소 그만큼 돌려받는다', () => {
  const e = setup();
  e.placeOrder('b', 'M1', 'no', 40, 10);
  e.placeOrder('a', 'M1', 'yes', 60, 10);
  assert.deepEqual(e.protectedPrincipal('a'), [{ eventId: 'E1', amount: 600 }]);
  const before = e.user('a').balance + 600;
  e.settleEvent('E1', null);
  assert.ok(e.user('a').balance >= before);
  assert.deepEqual(e.protectedPrincipal('a'), []);
});

test('호가 요약은 가격대별 잔량을 높은 가격부터 보여준다', () => {
  const e = setup();
  e.placeOrder('a', 'M1', 'yes', 30, 2);
  e.placeOrder('b', 'M1', 'yes', 30, 3);
  e.placeOrder('c', 'M1', 'yes', 35, 1);
  assert.deepEqual(e.bookLevels('M1').yesBids, [{ price: 35, qty: 1 }, { price: 30, qty: 5 }]);
});
