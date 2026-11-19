# 운영 배포 (Railway 기준)

NOSTRA와 같은 Railway 프로젝트에 서비스 2개를 더하면 됩니다. 앱은 프로세스 하나로 돌아야 합니다(매칭 엔진이 메모리에 있음). 복제본을 늘리지 마세요.

## 1. 서비스 만들기

| 서비스 | 만드는 법 |
| --- | --- |
| Postgres | `+ New` → Database → PostgreSQL (NOSTRA와 다른 새 DB) |
| web | `+ New` → GitHub Repo → `Ckfrpark/Nostra-NoGamble`. `railway.json`을 그대로 씀. Networking에서 도메인 생성 |

## 2. 변수 (web)

| 이름 | 값 |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` (Dockerfile에 이미 있음) |
| `ADMIN_TOKEN` | 무작위 40자 이상 |
| `IDENTITY_SECRET` | 무작위 32자 이상. 바꾸면 기존 회원이 모두 새 계정이 되므로 한 번 정하면 그대로 |
| `PUBLIC_BASE_URL` | `https://<web 도메인>` |
| `OLGONG_SUPABASE_URL` | 올공나라 회원 프로젝트 주소 (NOSTRA의 로그인과 같은 프로젝트) |
| `OLGONG_SUPABASE_KEY` | 그 프로젝트의 공개(publishable) 키 |

`ALLOW_DEV_LOGIN`은 넣지 않습니다.

## 3. 올공나라 쪽 설정

1. 올공 Supabase → Authentication → URL Configuration → Redirect URLs에 `https://<web 도메인>/auth/olgong` 추가.
2. (선택) 올공나라 화면에서 바로 넘어오게 하려면, NOSTRA처럼 `https://<web 도메인>/auth/from-olgong`으로 `access_token`을 폼 POST 하는 링크를 올공나라에 추가.

## 4. 문제 가져오기

1. 브라우저에서 `https://nostra.olgong.xyz/api/v1/markets?limit=100`을 열고 내용을 저장합니다.
2. 새 서비스의 `/#/admin`에서 `ADMIN_TOKEN`으로 들어가 "NOSTRA 문제 가져오기"에 붙여넣고 가져오기를 누릅니다.
3. 거래 중인 문제만 들어오고, 다시 해도 중복되지 않습니다. NOSTRA의 현재 확률은 첫 거래 전 참고 가격이 됩니다.

## 5. 확인

- `/api/events`가 200을 돌려주는지 (헬스체크)
- 카카오·구글 로그인 → 1,000알 지급 확인
- 운영 화면 "알 공급"의 총 공급이 회원 수 × 1,000 + 출석 지급과 맞는지

## 데이터

모든 변경은 `commands` 테이블에 순서대로 쌓이고(수정·삭제는 DB 트리거가 막음), 서버가 켜질 때 처음부터 재생해 상태를 만듭니다. 백업은 이 테이블 하나면 충분합니다. Railway Postgres 백업을 켜 두세요.
