// 플랫폼 계층: 엔진 + 명령 저널(DB).
// 모든 상태 변경은 "명령"으로 표현되고, 엔진에서 성공한 명령만 저널에 기록된다.
// 서버를 다시 켜면 저널을 처음부터 재생해 같은 상태를 복원한다 (엔진은 결정적).
import { randomUUID } from 'node:crypto';
import { Engine, EngineError, type Config, type Side, type SettlementLine } from './engine.ts';
import type { Journal } from './journal.ts';

export type Command =
  | { t: 'register'; userId: string; identityId: string; nickname: string }
  | { t: 'allowance'; userId: string; day: number }
  | {
      t: 'createEvent';
      id: string;
      title: string;
      category: string;
      rules: string;
      closesAt: string; // ISO
      exhaustive: boolean;
      markets: { id: string; title: string }[];
    }
  | { t: 'order'; userId: string; marketId: string; side: Side; price: number; qty: number }
  | { t: 'cancel'; userId: string; orderId: number }
  | { t: 'close'; eventId: string }
  | { t: 'settle'; eventId: string; winner: string | null }
  | { t: 'void'; eventId: string }
  | { t: 'season' };

export interface EventMeta {
  category: string;
  rules: string;
  closesAt: string;
  createdAt: string;
  result?: string | null; // 정답 마켓 id, null = 해당 없음
}

export interface HistoryLine extends SettlementLine {
  eventId: string;
  at: string;
  kind: 'settled' | 'void';
}

/** 한국 시간 기준 날짜 번호 (출석 지급용) */
export function kstDay(d: Date): number {
  return Math.floor((d.getTime() + 9 * 3600_000) / 86_400_000);
}

export class Platform {
  engine: Engine;
  journal: Journal;
  nicknames = new Map<string, string>();
  meta = new Map<string, EventMeta>();
  volume = new Map<string, number>(); // marketId -> 체결 계약 수
  history = new Map<string, HistoryLine[]>(); // userId -> 정산 내역
  private replaying = false;

  constructor(journal: Journal, cfg: Partial<Config> = {}) {
    this.engine = new Engine(cfg);
    this.journal = journal;
    this.replaying = true;
    for (const { cmd, ts } of journal.all()) this.apply(cmd as Command, ts);
    this.replaying = false;
    this.engine.checkInvariant();
  }

  /** 명령 실행. 성공하면 저널에 기록하고 결과를 돌려준다. EngineError는 그대로 던진다. */
  exec(cmd: Command, now = new Date()): unknown {
    const ts = now.toISOString();
    const result = this.apply(cmd, ts);
    this.journal.append(cmd, ts);
    return result;
  }

  private apply(cmd: Command, ts: string): unknown {
    const e = this.engine;
    switch (cmd.t) {
      case 'register': {
        const nick = cmd.nickname.trim();
        if (!this.replaying) {
          if (nick.length < 2 || nick.length > 16) throw new EngineError('닉네임은 2~16자');
          for (const n of this.nicknames.values()) if (n === nick) throw new EngineError('이미 쓰는 닉네임');
        }
        e.registerUser(cmd.userId, cmd.identityId);
        this.nicknames.set(cmd.userId, nick);
        return { userId: cmd.userId };
      }
      case 'allowance':
        return { granted: e.claimDailyAllowance(cmd.userId, cmd.day) };
      case 'createEvent': {
        if (!this.replaying) {
          if (this.engine.events.has(cmd.id)) throw new EngineError('이미 있는 이벤트 id');
          for (const m of cmd.markets) if (this.engine.markets.has(m.id)) throw new EngineError(`이미 있는 마켓 id: ${m.id}`);
          if (Number.isNaN(Date.parse(cmd.closesAt))) throw new EngineError('마감 시각 형식 오류');
        }
        e.createEvent(cmd.id, cmd.title, cmd.markets, cmd.exhaustive);
        this.meta.set(cmd.id, { category: cmd.category, rules: cmd.rules, closesAt: cmd.closesAt, createdAt: ts });
        return { eventId: cmd.id };
      }
      case 'order': {
        const r = e.placeOrder(cmd.userId, cmd.marketId, cmd.side, cmd.price, cmd.qty);
        for (const f of r.fills) this.volume.set(f.marketId, (this.volume.get(f.marketId) ?? 0) + f.qty);
        return { orderId: r.order?.id ?? null, fills: r.fills };
      }
      case 'cancel': {
        const o = e.orders.get(cmd.orderId);
        if (!o || o.userId !== cmd.userId) throw new EngineError('취소할 수 없는 주문');
        e.cancelOrder(cmd.orderId);
        return { ok: true };
      }
      case 'close':
        e.closeEvent(cmd.eventId);
        return { ok: true };
      case 'settle': {
        const lines = e.settleEvent(cmd.eventId, cmd.winner);
        this.meta.get(cmd.eventId)!.result = cmd.winner;
        for (const l of lines) this.pushHistory(l.userId, { ...l, eventId: cmd.eventId, at: ts, kind: 'settled' });
        return { lines };
      }
      case 'void': {
        const ev = e.events.get(cmd.eventId);
        const users = ev ? [...e.accounts.keys()].filter((k) => k.endsWith(`|${cmd.eventId}`)).map((k) => k.split('|')[0]) : [];
        e.voidEvent(cmd.eventId);
        for (const u of users) this.pushHistory(u, { userId: u, rawPnl: 0, refund: 0, fee: 0, eventId: cmd.eventId, at: ts, kind: 'void' });
        return { ok: true };
      }
      case 'season':
        return e.startNewSeason();
    }
  }

  private pushHistory(userId: string, line: HistoryLine) {
    let h = this.history.get(userId);
    if (!h) this.history.set(userId, (h = []));
    h.push(line);
  }

  newUserId() {
    return `u_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /** 마감 시각이 지난 열린 이벤트를 마감한다. */
  closeDueEvents(now = new Date()) {
    for (const [id, m] of this.meta) {
      const ev = this.engine.events.get(id)!;
      if (ev.status === 'open' && Date.parse(m.closesAt) <= now.getTime()) this.exec({ t: 'close', eventId: id }, now);
    }
  }

  // ---------- 화면용 조회 ----------
  marketView(marketId: string) {
    const m = this.engine.markets.get(marketId)!;
    const book = this.engine.bookLevels(marketId);
    const bestYesBid = book.yesBids[0]?.price ?? null;
    const bestNoBid = book.noBids[0]?.price ?? null;
    return {
      id: m.id,
      title: m.title,
      lastYesPrice: m.lastYesPrice ?? null,
      // 지금 바로 살 수 있는 가격 = 100 - 반대편 최고 매수호가
      yesAsk: bestNoBid === null ? null : 100 - bestNoBid,
      noAsk: bestYesBid === null ? null : 100 - bestYesBid,
      volume: this.volume.get(m.id) ?? 0,
      book,
    };
  }

  eventView(eventId: string, withBook = false) {
    const ev = this.engine.events.get(eventId);
    if (!ev) return null;
    const meta = this.meta.get(eventId)!;
    return {
      id: ev.id,
      title: ev.title,
      status: ev.status,
      exhaustive: ev.exhaustive,
      category: meta.category,
      rules: meta.rules,
      closesAt: meta.closesAt,
      result: meta.result,
      markets: ev.marketIds.map((mid) => {
        const v = this.marketView(mid);
        return withBook ? v : { ...v, book: undefined };
      }),
    };
  }

  listEvents() {
    return [...this.engine.events.keys()].map((id) => this.eventView(id)!).reverse();
  }

  me(userId: string, now = new Date()) {
    const u = this.engine.user(userId);
    const principal = this.engine.protectedPrincipal(userId).reduce((s, p) => s + p.amount, 0);
    return {
      userId,
      nickname: this.nicknames.get(userId),
      balance: u.balance,
      protectedPrincipal: principal,
      exposureUsed: this.engine.totalExposure(userId),
      exposureCap: this.engine.exposureCap(u),
      eventExposureCap: this.engine.cfg.eventExposureCap,
      seasonScore: u.seasonScore,
      skillScore: u.skillScore,
      season: this.engine.season,
      allowanceClaimable: u.lastAllowanceDay < kstDay(now) && u.balance < this.engine.cfg.allowanceCeiling,
    };
  }

  portfolio(userId: string) {
    const e = this.engine;
    const titleOf = (mid: string) => {
      const m = e.markets.get(mid)!;
      return { marketTitle: m.title, eventId: m.eventId, eventTitle: e.events.get(m.eventId)!.title };
    };
    return {
      positions: e.userPositions(userId).map((p) => ({ ...p, ...titleOf(p.marketId), lastYesPrice: e.markets.get(p.marketId)!.lastYesPrice ?? null })),
      orders: e.userOrders(userId).map((o) => ({ id: o.id, marketId: o.marketId, side: o.side, price: o.price, qty: o.qty, ...titleOf(o.marketId) })),
      protected: e.protectedPrincipal(userId).map((p) => ({ ...p, eventTitle: e.events.get(p.eventId)!.title })),
      history: [...(this.history.get(userId) ?? [])].reverse().map((h) => ({ ...h, eventTitle: e.events.get(h.eventId)!.title })),
    };
  }

  leaderboard() {
    return {
      season: this.engine.season,
      rows: this.engine.leaderboard(100).map((r) => ({ rank: r.rank, nickname: this.nicknames.get(r.userId), score: r.score })),
    };
  }

  supply() {
    const e = this.engine;
    return { total: e.checkInvariant(), minted: e.minted, burned: e.burned, refundsMinted: e.refundsMinted, feesBurned: e.feesBurned, users: e.users.size };
  }

  flags() {
    const byIdentity = new Map<string, string>();
    for (const u of this.engine.users.values()) byIdentity.set(u.identityId, u.id);
    return this.engine.concentrationFlags().map((f) => ({
      ...f,
      nickname: this.nicknames.get(byIdentity.get(f.identity)!),
      counterpartyNickname: this.nicknames.get(byIdentity.get(f.counterparty)!),
    }));
  }
}
