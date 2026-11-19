// 알 공급(인플레이션)과 악용 시나리오 시뮬레이션
// 실행: node sim/simulate.ts
import { Engine, EngineError, type Config } from '../src/engine.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Result {
  supply: number[];
  refunds: number;
  fees: number;
  topBalance: number;
  medianBalance: number;
  colluderGain: number;
  colluderSkill: number;
}

function run(label: string, cfg: Partial<Config>, opts: { days: number; users: number; eventsPerDay: number; stakeFrac: number }): Result {
  const R = rng(42);
  const e = new Engine(cfg);
  const ids: string[] = [];
  for (let i = 0; i < opts.users; i++) {
    e.registerUser(`u${i}`, `ci-${i}`);
    ids.push(`u${i}`);
  }
  // 담합 2인: 매 이벤트 서로 반대편을 최대한 산다
  e.registerUser('c1', 'ci-c1');
  e.registerUser('c2', 'ci-c2');
  const supply: number[] = [];
  let evn = 0;
  const tryOrder = (uid: string, mid: string, side: 'yes' | 'no', price: number, budget: number) => {
    let qty = Math.floor(budget / price);
    while (qty > 0) {
      try {
        e.placeOrder(uid, mid, side, price, qty);
        return;
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        qty = Math.floor(qty / 2);
      }
    }
  };
  for (let day = 0; day < opts.days; day++) {
    for (const id of [...ids, 'c1', 'c2']) e.claimDailyAllowance(id, day);
    const today: { id: string; mid: string; q: number }[] = [];
    for (let k = 0; k < opts.eventsPerDay; k++) {
      const id = `E${evn++}`;
      const mid = `${id}-M`;
      e.createEvent(id, id, [{ id: mid, title: mid }], false);
      today.push({ id, mid, q: 0.05 + 0.9 * R() });
    }
    for (const ev of today) {
      const fair = Math.round(ev.q * 100);
      // 담합 쌍: 공정가로 서로 반대편 (가격 밴드를 피하려고 공정가 사용)
      const cBudget = 1e9;
      tryOrder('c1', ev.mid, 'yes', fair, Math.min(e.user('c1').balance, cBudget));
      tryOrder('c2', ev.mid, 'no', 100 - fair, Math.min(e.user('c2').balance, cBudget));
      // 일반 사용자: 공정가 근처의 주관적 확률로 주문
      const order = [...ids].sort(() => R() - 0.5);
      for (const uid of order) {
        if (R() < 0.5) continue;
        const belief = Math.min(97, Math.max(3, Math.round(fair + (R() - 0.5) * 30)));
        const u = e.user(uid);
        const budget = u.balance * opts.stakeFrac;
        if (R() < 0.5) tryOrder(uid, ev.mid, 'yes', Math.max(1, belief - 2), budget);
        else tryOrder(uid, ev.mid, 'no', Math.max(1, 100 - belief - 2), budget);
      }
    }
    for (const ev of today) e.settleEvent(ev.id, R() < ev.q ? ev.mid : null);
    supply.push(e.checkInvariant());
  }
  const bals = ids.map((id) => e.user(id).balance).sort((a, b) => a - b);
  const res: Result = {
    supply,
    refunds: e.refundsMinted,
    fees: e.feesBurned,
    topBalance: bals[bals.length - 1],
    medianBalance: bals[Math.floor(bals.length / 2)],
    colluderGain: e.user('c1').balance + e.user('c2').balance - 2000,
    colluderSkill: e.user('c1').skillScore + e.user('c2').skillScore,
  };
  const n = opts.users + 2;
  const fmt = (x: number) => Math.round(x).toLocaleString('en-US');
  console.log(`\n=== ${label} ===`);
  for (const d of [9, 29, 59, opts.days - 1]) if (d < opts.days) console.log(`  ${d + 1}일차 1인당 평균 알: ${fmt(supply[d] / n)}`);
  console.log(`  누적 손실보호 발행: ${fmt(res.refunds)}  /  수수료 소각: ${fmt(res.fees)}`);
  console.log(`  일반 사용자 잔액 중앙값: ${fmt(res.medianBalance)}  /  최고: ${fmt(res.topBalance)}`);
  console.log(`  담합 2인 잔액 증가 합계: ${fmt(res.colluderGain)}  /  담합 2인 실력점수 합계: ${fmt(res.colluderSkill)}`);
  return res;
}

const opts = { days: 90, users: 200, eventsPerDay: 4, stakeFrac: 0.3 };

const naive = run('단순 보호 (한도 = 잔액, 이벤트 한도 없음)', {
  exposureCapFn: () => Number.POSITIVE_INFINITY,
  eventExposureCap: Number.POSITIVE_INFINITY,
  profitFeeRate: 0,
  allowanceCeiling: Number.POSITIVE_INFINITY,
}, opts);

const designed = run('설계안 (잔액 무관 한도 + 이익 수수료 + 출석 상한)', {}, opts);

const ratio = naive.supply[opts.days - 1] / designed.supply[opts.days - 1];
console.log(`\n90일 후 총 공급: 단순 보호가 설계안의 ${ratio.toFixed(1)}배`);
