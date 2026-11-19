// NOSTRA(nostra.olgong.xyz)의 시장 목록(/api/v1/markets 응답)을 이 플랫폼의 이벤트로 바꾼다.
// - 예/아니오 시장 → 마켓 1개짜리 이벤트 ("해당 없음" = 아니오)
// - 선택지·구간 시장 → 선택지마다 마켓이 있는 이벤트 (정확히 하나가 정답)
// - NOSTRA의 현재 확률은 첫 체결 전 참고 가격으로 넣는다.
import { createHash } from 'node:crypto';
import type { Command } from './platform.ts';

export interface NostraOutcome {
  idx?: number;
  label: string;
  price?: number | string; // 0~1, 또는 백만분율(micro)
}

export interface NostraMarket {
  slug: string;
  question: string;
  description?: string;
  resolution_criteria?: string;
  resolution_sources?: string[];
  category?: string;
  type?: 'binary' | 'categorical' | 'scalar';
  status?: string;
  close_at: string;
  outcomes?: NostraOutcome[];
}

type CreateEvent = Extract<Command, { t: 'createEvent' }>;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** NOSTRA slug를 이벤트 id로 (영문·숫자·_- 40자). 맞지 않으면 해시로 대신한다. */
export function eventIdFor(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const base = `n-${clean}`;
  if (ID_RE.test(base) && base.length <= 34) return base;
  const h = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `n-${clean.slice(0, 26).replace(/-+$/, '')}-${h}`;
}

/** 0~1 확률 또는 백만분율을 예 가격(1~99)으로 */
export function toYesPrice(price: number | string | undefined): number | undefined {
  if (price === undefined || price === null || price === '') return undefined;
  let p = Number(price);
  if (!Number.isFinite(p)) return undefined;
  if (p > 1) p = p / 1_000_000;
  return Math.min(99, Math.max(1, Math.round(p * 100)));
}

const YES_LABELS = new Set(['yes', '예', '네', 'y']);

export function rulesText(m: NostraMarket): string {
  const parts = [m.resolution_criteria?.trim(), m.description?.trim()].filter(Boolean) as string[];
  if (m.resolution_sources?.length) parts.push(`출처: ${m.resolution_sources.join(', ')}`);
  parts.push(`(NOSTRA에서 가져온 문제: ${m.slug})`);
  return parts.join('\n\n').slice(0, 2000);
}

export function toCreateEvent(m: NostraMarket): CreateEvent {
  if (!m.slug || !m.question || !m.close_at) throw new Error('slug, question, close_at 이 필요합니다');
  const id = eventIdFor(m.slug);
  const outcomes = [...(m.outcomes ?? [])].sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
  const type = m.type ?? (outcomes.length > 2 ? 'categorical' : 'binary');
  let markets: { id: string; title: string; refPrice?: number }[];
  if (type === 'binary') {
    const yes = outcomes.find((o) => YES_LABELS.has(o.label.trim().toLowerCase())) ?? outcomes[0];
    const ref = toYesPrice(yes?.price);
    markets = [{ id: `${id}-y`, title: '예', ...(ref !== undefined ? { refPrice: ref } : {}) }];
  } else {
    if (outcomes.length < 2) throw new Error(`${m.slug}: 선택지가 2개 미만`);
    markets = outcomes.map((o, i) => {
      const ref = toYesPrice(o.price);
      return { id: `${id}-${i + 1}`, title: o.label.slice(0, 100), ...(ref !== undefined ? { refPrice: ref } : {}) };
    });
  }
  return {
    t: 'createEvent',
    id,
    title: m.question.slice(0, 120),
    category: (m.category ?? '기타').slice(0, 20),
    rules: rulesText(m),
    closesAt: new Date(m.close_at).toISOString(),
    exhaustive: markets.length > 1,
    markets,
    source: `nostra:${m.slug}`,
  };
}

/** /api/v1/markets 응답({items}), 배열, 또는 시장 하나를 받아 시장 배열로 */
export function parseNostraPayload(data: unknown): NostraMarket[] {
  if (Array.isArray(data)) return data as NostraMarket[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.items)) return d.items as NostraMarket[];
    if (Array.isArray(d.markets)) return d.markets as NostraMarket[];
    if (typeof d.slug === 'string') return [d as unknown as NostraMarket];
  }
  throw new Error('NOSTRA 시장 목록 형식이 아닙니다');
}
