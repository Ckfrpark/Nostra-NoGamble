# Nostra NoGamble — 알(Alal) 예측시장

무료 포인트 "알"로 거래하고, 거래 손실은 플랫폼이 상쇄해 주는 예측시장입니다.
알은 구매할 수 없고, 현금화·환전·이체가 불가능합니다.

설계와 악용 방지 장치는 [DESIGN.md](DESIGN.md)를 보세요.

## 실행

Node.js 22.18 이상이 필요합니다. 외부 패키지 없이 TypeScript를 그대로 실행하고, DB는 Node 내장 SQLite를 씁니다.

```bash
npm run seed                 # 데모 데이터 (data/alal.db가 비어 있을 때만)
ADMIN_TOKEN=원하는값 npm start  # http://localhost:3000
npm test                     # 엔진 + API 테스트
npm run sim                  # 인플레이션·담합 시뮬레이션
```

- 데모 계정: 로그인 창에서 휴대폰 번호 `010-0000-0000` ~ `010-0000-0005` (개발용 인증)
- 운영 화면: 화면 아래 "운영" 링크 → `ADMIN_TOKEN` 입력

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 서버 포트 |
| `DB_PATH` | data/alal.db | SQLite 파일 |
| `ADMIN_TOKEN` | (없음) | 운영 API 토큰. 없으면 운영 API가 꺼짐 |
| `IDENTITY_SECRET` | dev-only-secret | 본인인증 CI 해시용 비밀키. 운영에서는 반드시 바꿀 것 |
| `NODE_ENV` | | `production`이면 쿠키에 Secure 지정 |

## 구조

| 경로 | 내용 |
|---|---|
| `src/engine.ts` | 주문서·체결·상계·정산·손실 보호·한도·악용 감시 (순수 로직) |
| `src/platform.ts` | 명령 실행과 저널 기록, 재시작 시 재생, 화면용 조회 |
| `src/journal.ts` | SQLite 명령 저널·세션 저장소 |
| `src/identity.ts` | 본인인증 인터페이스와 개발용 구현 |
| `src/server.ts` | HTTP API + 정적 파일 |
| `web/` | 웹 화면 (마켓, 이벤트·주문, 내 자산, 랭킹, 운영) |
| `scripts/seed.ts` | 데모 데이터 |
| `sim/simulate.ts` | 공급 시뮬레이션 |
