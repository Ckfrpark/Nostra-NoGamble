# Nostra NoGamble — 알(Alal) 예측시장

무료 포인트 "알"로 거래하고, 거래 손실은 플랫폼이 상쇄해 주는 예측시장입니다.
알은 구매할 수 없고, 현금화·환전·이체가 불가능합니다.

설계와 악용 방지 장치는 [DESIGN.md](DESIGN.md)를 보세요.

## 실행 (로컬)

Node.js 22.18 이상. TypeScript를 그대로 실행하고, 외부 패키지는 `pg` 하나입니다.

```bash
npm install
npm run seed                                   # 데모 데이터 (data/alal.db, SQLite)
ALLOW_DEV_LOGIN=1 ADMIN_TOKEN=dev npm start    # http://localhost:3000
npm test                                       # 엔진·API·가져오기·로그인 테스트
TEST_DATABASE_URL=postgres://... npm test      # PostgreSQL 저널 테스트까지
```

- 개발용 로그인: 휴대폰 번호 `010-0000-0000` ~ `010-0000-0005` (데모 계정). `ALLOW_DEV_LOGIN=1`일 때만 켜지고, 운영에서는 켤 수 없습니다.
- 운영 화면: 화면 아래 "운영" 링크 → `ADMIN_TOKEN`

## 운영 배포

[docs/deploy.md](docs/deploy.md): Railway + PostgreSQL, 올공나라 로그인 설정, NOSTRA 문제 가져오기. 환경변수는 [.env.example](.env.example).

## 구조

| 경로 | 내용 |
|---|---|
| `src/engine.ts` | 주문서·체결·상계·정산·손실 보호·한도·악용 감시 (순수 로직) |
| `src/platform.ts` | 명령 실행과 저널 기록, 재시작 시 재생, 화면용 조회 |
| `src/journal.ts` | 명령 저널·세션 저장소 (PostgreSQL, 로컬은 SQLite) |
| `src/olgong.ts` | 올공나라 로그인 (Supabase 토큰 확인) |
| `src/nostra-import.ts` | NOSTRA 시장 목록 → 이벤트 변환 |
| `src/identity.ts` | 개발용 로그인, CI 해시 |
| `src/server.ts` | HTTP API + 정적 파일 |
| `web/` | 웹 화면 (마켓, 이벤트·주문, 내 자산, 랭킹, 운영) |
| `scripts/seed.ts` | 로컬 데모 데이터 (운영에서는 실행 거부) |
| `sim/simulate.ts` | 공급 시뮬레이션 |
