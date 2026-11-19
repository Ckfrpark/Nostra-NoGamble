// 데모 데이터: node scripts/seed.ts [DB_PATH]  (기존 DB가 비어 있을 때만)
import { Platform } from '../src/platform.ts';
import { SqliteStore } from '../src/journal.ts';
import { hashCi } from '../src/identity.ts';

const path = process.argv[2] ?? process.env.DB_PATH ?? 'data/alal.db';
const store = new SqliteStore(path);
if (store.all().length > 0) {
  console.log('이미 데이터가 있어 건너뜁니다:', path);
  process.exit(0);
}
const p = new Platform(store);
const day = 86400000;
const now = Date.now();
const users = ['예측왕', '신중한곰', '데이터덕후', '야구광', '날씨요정', '경제통'].map((nick, i) => {
  const userId = p.newUserId();
  // 개발용 인증과 같은 방식: 휴대폰 010-0000-000i
  p.exec({ t: 'register', userId, identityId: hashCi(`dev-phone:0100000000${i}`, process.env.IDENTITY_SECRET ?? 'dev-only-secret'), nickname: nick });
  return userId;
});
const ev = (id: string, title: string, category: string, rules: string, days: number, markets: string[], exhaustive = true) =>
  p.exec({ t: 'createEvent', id, title, category, rules, closesAt: new Date(now + days * day).toISOString(), exhaustive: markets.length > 1 && exhaustive,
    markets: markets.map((m, i) => ({ id: `${id}-${i + 1}`, title: m })) });

ev('seoul-rain', '이번 주말 서울에 비가 올까?', '날씨', '기상청 서울(108) 관측소 기준 토·일 중 하루라도 일 강수량 0.1mm 이상이면 "예".', 2, ['비 온다']);
ev('kospi-3000', '연말 코스피 종가가 3,000을 넘을까?', '경제', '한국거래소 12월 마지막 거래일 코스피 종가 기준.', 40, ['3,000 이상']);
ev('ks-2026', '2026 한국시리즈 MVP 소속팀은?', '스포츠', 'KBO 공식 발표 기준. 발표가 없으면 무효.', 5, ['LG', '두산', 'KIA', '삼성']);
ev('bok-rate', '다음 금통위에서 기준금리는?', '경제', '한국은행 금융통화위원회 다음 정기 회의 결정 기준.', 20, ['인하', '동결', '인상']);
ev('snow-first', '11월 안에 서울 첫눈이 관측될까?', '날씨', '기상청 서울 첫눈 공식 관측 발표 기준.', 10, ['관측된다']);

const o = (u: number, m: string, s: 'yes' | 'no', price: number, qty: number) => p.exec({ t: 'order', userId: users[u], marketId: m, side: s, price, qty });
o(1, 'seoul-rain-1', 'no', 38, 5); o(0, 'seoul-rain-1', 'yes', 62, 5); o(2, 'seoul-rain-1', 'yes', 58, 4); o(3, 'seoul-rain-1', 'no', 35, 6); o(4, 'seoul-rain-1', 'yes', 55, 3);
o(5, 'kospi-3000-1', 'yes', 41, 6); o(2, 'kospi-3000-1', 'no', 59, 6); o(1, 'kospi-3000-1', 'yes', 38, 4); o(0, 'kospi-3000-1', 'no', 55, 3);
o(3, 'ks-2026-1', 'yes', 45, 4); o(1, 'ks-2026-1', 'no', 55, 4); o(3, 'ks-2026-3', 'yes', 25, 4); o(0, 'ks-2026-3', 'no', 75, 2); o(4, 'ks-2026-2', 'yes', 18, 5); o(5, 'ks-2026-2', 'no', 82, 3); o(2, 'ks-2026-4', 'yes', 12, 3);
o(5, 'bok-rate-2', 'yes', 70, 4); o(0, 'bok-rate-2', 'no', 30, 4); o(5, 'bok-rate-1', 'yes', 24, 3); o(2, 'bok-rate-1', 'no', 76, 2); o(1, 'bok-rate-3', 'yes', 6, 5);
o(4, 'snow-first-1', 'yes', 33, 5); o(3, 'snow-first-1', 'no', 67, 5);

// 이미 끝난 이벤트 하나: 정산 내역과 랭킹을 보여주기 위해
ev('demo-done', '지난주 프로야구 개막전, 홈팀이 이겼을까?', '스포츠', 'KBO 공식 기록 기준.', 1, ['홈팀 승리']);
o(0, 'demo-done-1', 'yes', 52, 4); o(1, 'demo-done-1', 'no', 48, 4); o(2, 'demo-done-1', 'yes', 50, 2); o(3, 'demo-done-1', 'no', 50, 2);
p.exec({ t: 'settle', eventId: 'demo-done', winner: 'demo-done-1' });
console.log('데모 데이터 생성 완료:', path, p.supply());
store.close();
