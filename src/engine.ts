// 알(Alal) 예측시장 핵심 엔진
// - 이벤트(Event) 안에 상호배타적 이진 마켓(Market)들이 있고, 각 계약은 정답이면 100알을 지급한다.
// - 주문서는 "예 매수"와 "아니오 매수" 두 호가창으로 이루어지며, 예 p + 아니오 q >= 100 이면 체결된다.
// - 같은 마켓에서 예·아니오를 함께 보유하면 즉시 1쌍당 100알로 상계(netting)된다.
// - 손실 보호: 이벤트 정산 시 사용자별 "이벤트 순손익"이 음수면 그만큼 새로 발행해 돌려준다.
// - 악용 방지: 잔액과 무관한 노출 한도, 이벤트 단위 손익 합산, 본인인증 단위 자기거래 차단,
//   체결 가격 밴드, 거래상대 집중도 감시, 이익 수수료 소각, 보호 전 원손익 기반 실력 점수.

export type Side = 'yes' | 'no';

export interface Config {
  signupGrant: number; // 가입 지급 알
  dailyAllowance: number; // 출석 지급 알
  allowanceCeiling: number; // 잔액이 이 이상이면 출석 지급 없음
  eventExposureCap: number; // 이벤트당 최대 보호 대상 손실(최악의 경우)
  baseExposureCap: number; // 모든 열린 이벤트 합산 최대 보호 대상 손실 (기본)
  skillCapFactor: number; // 실력 점수에 따른 추가 한도 = factor * sqrt(max(0, 실력점수))
  maxExposureCap: number; // 합산 한도 상한
  profitFeeRate: number; // 이벤트 순이익에 대한 수수료(소각) 비율
  priceBand: number; // 직전 체결가 대비 허용 체결 가격 폭
  concentrationMinVolume: number; // 집중도 감시 최소 거래량(계약 수)
  concentrationThreshold: number; // 한 상대와의 거래 비중이 이 이상이면 플래그
  // 시뮬레이션 비교용: 지정하면 기본 한도 공식을 대체한다.
  exposureCapFn?: (u: User) => number;
}

export const DEFAULT_CONFIG: Config = {
  signupGrant: 1000,
  dailyAllowance: 100,
  allowanceCeiling: 3000,
  eventExposureCap: 500,
  baseExposureCap: 1000,
  skillCapFactor: 20,
  maxExposureCap: 5000,
  profitFeeRate: 0.1,
  priceBand: 20,
  concentrationMinVolume: 200,
  concentrationThreshold: 0.5,
};

export interface User {
  id: string;
  identityId: string; // 본인인증 CI 해시. 같은 사람의 계정은 같은 값 → 1인 1계정, 자기거래 차단
  balance: number;
  skillScore: number; // 보호·수수료 적용 전 누적 원손익 (제로섬)
  lastAllowanceDay: number;
}

export interface Order {
  id: number;
  userId: string;
  marketId: string;
  side: Side;
  price: number; // 1..99
  qty: number; // 남은 수량
  reserved: number; // 신규 진입분에 대해 묶어둔 알
  closeQty: number; // 반대 포지션을 청산하는 수량 (알 대신 보유 계약을 담보로 잠금)
  seq: number;
}

export interface Market {
  id: string;
  eventId: string;
  title: string;
  yesBids: Order[];
  noBids: Order[];
  lastYesPrice?: number;
}

export type EventStatus = 'open' | 'settled' | 'void';

export interface MarketEvent {
  id: string;
  title: string;
  marketIds: string[];
  exhaustive: boolean; // true면 마켓 중 정확히 하나가 정답, false면 "해당 없음" 결과도 가능
  status: EventStatus;
  escrow: number;
}

export interface EventAccount {
  cashOut: number; // 이 이벤트에서 지불한 알
  cashIn: number; // 이 이벤트에서 받은 알 (상계, 정산)
}

export interface Fill {
  marketId: string;
  takerUserId: string;
  makerUserId: string;
  takerSide: Side;
  takerPrice: number;
  makerPrice: number;
  qty: number;
}

export interface SettlementLine {
  userId: string;
  rawPnl: number;
  refund: number; // 손실 보호로 발행된 알
  fee: number; // 소각된 수수료
}

export interface Position {
  yes: number;
  no: number;
  lockedYes: number; // 매도(반대편 매수) 대기 주문에 담보로 잡힌 수량
  lockedNo: number;
}

export class EngineError extends Error {}

const opp = (s: Side): Side => (s === 'yes' ? 'no' : 'yes');
const lockKey = (s: Side) => (s === 'yes' ? 'lockedYes' : 'lockedNo') as const;

export class Engine {
  cfg: Config;
  users = new Map<string, User>();
  identities = new Map<string, string>(); // identityId -> userId (1인 1계정)
  markets = new Map<string, Market>();
  events = new Map<string, MarketEvent>();
  positions = new Map<string, Position>(); // key user|market
  accounts = new Map<string, EventAccount>(); // key user|event
  orders = new Map<number, Order>();
  pairVolume = new Map<string, Map<string, number>>(); // identity -> counterparty identity -> 계약 수
  fills: Fill[] = [];
  minted = 0;
  burned = 0;
  refundsMinted = 0;
  feesBurned = 0;
  private seq = 0;

  constructor(cfg: Partial<Config> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  // ---------- 발행 ----------
  private mint(u: User, amount: number) {
    u.balance += amount;
    this.minted += amount;
  }

  registerUser(id: string, identityId: string): User {
    if (this.users.has(id)) throw new EngineError('이미 존재하는 계정');
    if (this.identities.has(identityId)) throw new EngineError('본인인증 1인 1계정 위반');
    const u: User = { id, identityId, balance: 0, skillScore: 0, lastAllowanceDay: -1 };
    this.users.set(id, u);
    this.identities.set(identityId, id);
    this.mint(u, this.cfg.signupGrant);
    return u;
  }

  claimDailyAllowance(userId: string, day: number): number {
    const u = this.user(userId);
    if (u.lastAllowanceDay >= day) return 0;
    u.lastAllowanceDay = day;
    if (u.balance >= this.cfg.allowanceCeiling) return 0;
    const amt = Math.min(this.cfg.dailyAllowance, this.cfg.allowanceCeiling - u.balance);
    this.mint(u, amt);
    return amt;
  }

  // ---------- 마켓 ----------
  createEvent(id: string, title: string, markets: { id: string; title: string }[], exhaustive: boolean) {
    if (markets.length === 0) throw new EngineError('마켓이 없음');
    if (exhaustive && markets.length < 2) throw new EngineError('단일 마켓 이벤트는 exhaustive=false');
    const ev: MarketEvent = { id, title, marketIds: markets.map((m) => m.id), exhaustive, status: 'open', escrow: 0 };
    this.events.set(id, ev);
    for (const m of markets) {
      this.markets.set(m.id, { id: m.id, eventId: id, title: m.title, yesBids: [], noBids: [] });
    }
    return ev;
  }

  // ---------- 조회 도우미 ----------
  user(id: string): User {
    const u = this.users.get(id);
    if (!u) throw new EngineError(`사용자 없음: ${id}`);
    return u;
  }
  position(userId: string, marketId: string) {
    const k = `${userId}|${marketId}`;
    let p = this.positions.get(k);
    if (!p) {
      p = { yes: 0, no: 0, lockedYes: 0, lockedNo: 0 };
      this.positions.set(k, p);
    }
    return p;
  }
  account(userId: string, eventId: string): EventAccount {
    const k = `${userId}|${eventId}`;
    let a = this.accounts.get(k);
    if (!a) {
      a = { cashOut: 0, cashIn: 0 };
      this.accounts.set(k, a);
    }
    return a;
  }

  exposureCap(u: User): number {
    if (this.cfg.exposureCapFn) return this.cfg.exposureCapFn(u);
    const bonus = this.cfg.skillCapFactor * Math.sqrt(Math.max(0, u.skillScore));
    return Math.min(this.cfg.maxExposureCap, Math.floor(this.cfg.baseExposureCap + bonus));
  }

  /**
   * 이벤트에서 사용자의 최악의 경우 손실 = 플랫폼이 보전해야 할 최대 금액.
   * 미체결 주문은 모두 지정가로 체결된다고 가정(보수적).
   */
  worstCaseLoss(userId: string, eventId: string, extra?: { marketId: string; side: Side; price: number; qty: number }): number {
    const ev = this.events.get(eventId)!;
    const acc = this.accounts.get(`${userId}|${eventId}`);
    let netCost = acc ? acc.cashOut - acc.cashIn : 0;
    const yes = new Map<string, number>();
    const no = new Map<string, number>();
    for (const mid of ev.marketIds) {
      const p = this.positions.get(`${userId}|${mid}`);
      yes.set(mid, p?.yes ?? 0);
      no.set(mid, p?.no ?? 0);
      const m = this.markets.get(mid)!;
      for (const o of [...m.yesBids, ...m.noBids]) {
        if (o.userId !== userId) continue;
        netCost += o.price * o.qty;
        (o.side === 'yes' ? yes : no).set(mid, (o.side === 'yes' ? yes : no).get(mid)! + o.qty);
      }
    }
    if (extra) {
      netCost += extra.price * extra.qty;
      const mp = extra.side === 'yes' ? yes : no;
      mp.set(extra.marketId, mp.get(extra.marketId)! + extra.qty);
    }
    const outcomes: (string | null)[] = [...ev.marketIds];
    if (!ev.exhaustive) outcomes.push(null);
    let worst = 0;
    for (const w of outcomes) {
      let payoff = 0;
      for (const mid of ev.marketIds) payoff += 100 * (mid === w ? yes.get(mid)! : no.get(mid)!);
      worst = Math.max(worst, netCost - payoff);
    }
    return worst;
  }

  totalExposure(userId: string, extra?: { marketId: string; side: Side; price: number; qty: number }): number {
    let total = 0;
    const extraEvent = extra ? this.markets.get(extra.marketId)!.eventId : undefined;
    for (const ev of this.events.values()) {
      if (ev.status !== 'open') continue;
      total += this.worstCaseLoss(userId, ev.id, ev.id === extraEvent ? extra : undefined);
    }
    return total;
  }

  // ---------- 주문 ----------
  placeOrder(userId: string, marketId: string, side: Side, price: number, qty: number): { order?: Order; fills: Fill[] } {
    const u = this.user(userId);
    const m = this.markets.get(marketId);
    if (!m) throw new EngineError('마켓 없음');
    const ev = this.events.get(m.eventId)!;
    if (ev.status !== 'open') throw new EngineError('거래 종료된 이벤트');
    if (!Number.isInteger(price) || price < 1 || price > 99) throw new EngineError('가격은 1~99 정수');
    if (!Number.isInteger(qty) || qty <= 0) throw new EngineError('수량은 양의 정수');
    // 반대편 보유 계약이 있으면 그만큼은 청산(=매도)이므로 알이 필요 없다
    const pos = this.position(userId, marketId);
    const closeQty = Math.min(qty, pos[opp(side)] - pos[lockKey(opp(side))]);
    const cost = price * (qty - closeQty);
    if (u.balance < cost) throw new EngineError('알 잔액 부족');

    const extra = { marketId, side, price, qty };
    if (this.worstCaseLoss(userId, ev.id, extra) > this.cfg.eventExposureCap)
      throw new EngineError('이벤트 보호 한도 초과');
    if (this.totalExposure(userId, extra) > this.exposureCap(u)) throw new EngineError('전체 보호 한도 초과');

    u.balance -= cost;
    pos[lockKey(opp(side))] += closeQty;
    const order: Order = { id: ++this.seq, userId, marketId, side, price, qty, reserved: cost, closeQty, seq: this.seq };
    const fills = this.match(order, m, ev);
    if (order.qty > 0) {
      const book = side === 'yes' ? m.yesBids : m.noBids;
      book.push(order);
      book.sort((a, b) => b.price - a.price || a.seq - b.seq);
      this.orders.set(order.id, order);
      return { order, fills };
    }
    // 완전 체결: 남은 예치금(가격 개선분)은 match에서 이미 반환됨
    return { fills };
  }

  cancelOrder(orderId: number) {
    const o = this.orders.get(orderId);
    if (!o) return;
    const m = this.markets.get(o.marketId)!;
    const book = o.side === 'yes' ? m.yesBids : m.noBids;
    const i = book.indexOf(o);
    if (i >= 0) book.splice(i, 1);
    this.user(o.userId).balance += o.reserved;
    this.position(o.userId, o.marketId)[lockKey(opp(o.side))] -= o.closeQty;
    o.reserved = 0;
    o.closeQty = 0;
    o.qty = 0;
    this.orders.delete(orderId);
  }

  private match(taker: Order, m: Market, ev: MarketEvent): Fill[] {
    const fills: Fill[] = [];
    const book = taker.side === 'yes' ? m.noBids : m.yesBids;
    const takerU = this.user(taker.userId);
    let i = 0;
    while (taker.qty > 0 && i < book.length) {
      const maker = book[i];
      if (taker.price + maker.price < 100) break;
      const makerU = this.user(maker.userId);
      // 자기거래 차단: 같은 본인인증 → 대기 주문 취소
      if (makerU.identityId === takerU.identityId) {
        this.cancelOrder(maker.id);
        continue;
      }
      const takerPrice = 100 - maker.price; // 메이커 가격으로 체결
      // 가격 밴드: 직전 체결가에서 너무 벗어난 체결은 막는다 (칩 덤핑 방지)
      const execYes = taker.side === 'yes' ? takerPrice : maker.price;
      if (m.lastYesPrice !== undefined && Math.abs(execYes - m.lastYesPrice) > this.cfg.priceBand) {
        i++;
        continue;
      }
      const q = Math.min(taker.qty, maker.qty);
      ev.escrow += 100 * q;
      this.applyFill(taker, takerPrice, q, ev);
      this.applyFill(maker, maker.price, q, ev);
      this.netPairs(taker.userId, m, ev);
      this.netPairs(maker.userId, m, ev);
      this.recordPair(takerU.identityId, makerU.identityId, q);
      m.lastYesPrice = execYes;
      const f: Fill = { marketId: m.id, takerUserId: taker.userId, makerUserId: maker.userId, takerSide: taker.side, takerPrice, makerPrice: maker.price, qty: q };
      fills.push(f);
      this.fills.push(f);
      if (maker.qty === 0) {
        book.splice(i, 1);
        this.orders.delete(maker.id);
      }
    }
    return fills;
  }

  /**
   * 체결 반영. 청산분은 체결가를 내고 즉시 1쌍당 100알로 상계되므로 (100 - 체결가)를 받는다.
   * 신규분은 예치금에서 체결가를 내고, 지정가보다 싸게 체결되면 차액을 돌려준다.
   */
  private applyFill(o: Order, execPrice: number, q: number, ev: MarketEvent) {
    const u = this.user(o.userId);
    const pos = this.position(o.userId, o.marketId);
    const close = Math.min(q, o.closeQty);
    const open = q - close;
    o.qty -= q;
    o.closeQty -= close;
    o.reserved -= o.price * open;
    u.balance += (o.price - execPrice) * open + (100 - execPrice) * close;
    pos[o.side] += open;
    pos[opp(o.side)] -= close;
    pos[lockKey(opp(o.side))] -= close;
    ev.escrow -= 100 * close;
    const acc = this.account(o.userId, ev.id);
    acc.cashOut += execPrice * q;
    acc.cashIn += 100 * close;
  }

  /** 같은 마켓의 예·아니오를 1쌍당 100알로 상계 (Kalshi와 같은 포지션 넷팅) */
  private netPairs(userId: string, m: Market, ev: MarketEvent) {
    const p = this.position(userId, m.id);
    const k = Math.min(p.yes - p.lockedYes, p.no - p.lockedNo);
    if (k === 0) return;
    p.yes -= k;
    p.no -= k;
    ev.escrow -= 100 * k;
    this.user(userId).balance += 100 * k;
    this.account(userId, ev.id).cashIn += 100 * k;
  }

  private recordPair(a: string, b: string, q: number) {
    for (const [x, y] of [[a, b], [b, a]]) {
      let mp = this.pairVolume.get(x);
      if (!mp) this.pairVolume.set(x, (mp = new Map()));
      mp.set(y, (mp.get(y) ?? 0) + q);
    }
  }

  /** 한 상대와의 거래 비중이 비정상적으로 높은 본인인증 쌍 (담합·칩 덤핑 의심) */
  concentrationFlags(): { identity: string; counterparty: string; share: number; volume: number }[] {
    const out = [];
    for (const [id, mp] of this.pairVolume) {
      let total = 0;
      for (const v of mp.values()) total += v;
      if (total < this.cfg.concentrationMinVolume) continue;
      for (const [cp, v] of mp) {
        const share = v / total;
        if (share >= this.cfg.concentrationThreshold) out.push({ identity: id, counterparty: cp, share, volume: total });
      }
    }
    return out;
  }

  // ---------- 정산 ----------
  private closeBooks(ev: MarketEvent) {
    for (const mid of ev.marketIds) {
      const m = this.markets.get(mid)!;
      for (const o of [...m.yesBids, ...m.noBids]) this.cancelOrder(o.id);
    }
  }

  private eventUsers(ev: MarketEvent): string[] {
    const ids: string[] = [];
    for (const k of this.accounts.keys()) {
      const [uid, eid] = k.split('|');
      if (eid === ev.id) ids.push(uid);
    }
    return ids;
  }

  /** winningMarketId: 정답 마켓, null이면 "해당 없음" (exhaustive=false 이벤트만) */
  settleEvent(eventId: string, winningMarketId: string | null): SettlementLine[] {
    const ev = this.events.get(eventId);
    if (!ev || ev.status !== 'open') throw new EngineError('정산할 수 없는 이벤트');
    if (winningMarketId === null && ev.exhaustive) throw new EngineError('exhaustive 이벤트는 정답 필요');
    if (winningMarketId !== null && !ev.marketIds.includes(winningMarketId)) throw new EngineError('이벤트에 없는 마켓');
    this.closeBooks(ev);
    for (const mid of ev.marketIds) {
      for (const [k, p] of this.positions) {
        const [uid, m] = k.split('|');
        if (m !== mid) continue;
        const payout = 100 * (mid === winningMarketId ? p.yes : p.no);
        if (payout > 0) {
          ev.escrow -= payout;
          this.user(uid).balance += payout;
          this.account(uid, ev.id).cashIn += payout;
        }
        p.yes = p.no = p.lockedYes = p.lockedNo = 0;
      }
    }
    if (ev.escrow !== 0) throw new Error(`에스크로 불일치: ${ev.escrow}`);
    ev.status = 'settled';

    const lines: SettlementLine[] = [];
    for (const uid of this.eventUsers(ev)) {
      const u = this.user(uid);
      const acc = this.account(uid, ev.id);
      const rawPnl = acc.cashIn - acc.cashOut;
      u.skillScore += rawPnl;
      let refund = 0;
      let fee = 0;
      if (rawPnl < 0) {
        // 손실 보호: 이벤트 순손실만큼 새로 발행해 상쇄
        refund = -rawPnl;
        this.mint(u, refund);
        this.refundsMinted += refund;
      } else if (rawPnl > 0) {
        fee = Math.floor(rawPnl * this.cfg.profitFeeRate);
        u.balance -= fee;
        this.burned += fee;
        this.feesBurned += fee;
      }
      lines.push({ userId: uid, rawPnl, refund, fee });
    }
    return lines;
  }

  /** 이벤트 무효(취소): 모든 사용자에게 순지불액을 돌려준다. 손익 0. */
  voidEvent(eventId: string) {
    const ev = this.events.get(eventId);
    if (!ev || ev.status !== 'open') throw new EngineError('무효 처리할 수 없는 이벤트');
    this.closeBooks(ev);
    for (const uid of this.eventUsers(ev)) {
      const acc = this.account(uid, ev.id);
      const back = acc.cashOut - acc.cashIn;
      ev.escrow -= back;
      this.user(uid).balance += back;
      acc.cashIn += back;
    }
    for (const mid of ev.marketIds)
      for (const [k, p] of this.positions) if (k.endsWith(`|${mid}`)) p.yes = p.no = p.lockedYes = p.lockedNo = 0;
    if (ev.escrow !== 0) throw new Error(`에스크로 불일치: ${ev.escrow}`);
    ev.status = 'void';
  }

  // ---------- 감사 ----------
  /** 총 공급 = 잔액 + 주문 예치금 + 에스크로. 발행 - 소각과 항상 같아야 한다. */
  checkInvariant() {
    let held = 0;
    for (const u of this.users.values()) held += u.balance;
    for (const o of this.orders.values()) held += o.reserved;
    for (const ev of this.events.values()) held += ev.escrow;
    if (held !== this.minted - this.burned) throw new Error(`공급 불일치 held=${held} minted-burned=${this.minted - this.burned}`);
    return held;
  }
}
