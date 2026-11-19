# StoneHash Attest — 국경간 송금·PoR 테스트 가이드

> 2026-11-10 기준 (R1·R2·PoR P1·P2 구현분 전체 커버)
> 모든 데모는 합성 자금·모의 기관·사설 체인입니다. 외부 접속 시 `<HOST>` = 서버 공개 IP (예: 3.36.101.90).

## 0. 포트·URL 지도

| 포트 | 서비스 | 데모에서의 역할 | 주요 URL |
|---|---|---|---|
| :8787 | attest core (pm2 `stonehash-attest-core`) | StoneHash 플랫폼 | `/console/` 콘솔 · `/playground/por.html` PoR 공개검증 · `/v1/remit/meta` |
| :3200 | demo-bank (`stonehash-bank-demo`) | 송금측 은행 (VN) | `/remit.html` **송금 데모 메인** · `/` 기존 문서공증 |
| :3400 | demo-customers (`stonehash-customers`) | 고객사 3사 포털 (제조사·거래소·은행) | `/` 탭 3개 |
| :3300 | demo-partners (`stonehash-partners`) | 수취측: Triple-A 모의 BFI + SG수취은행 + 정산주체 | `/` 수취측 콘솔·통장 |
| :8545 | anvil (`stonehash-anvil`) | mUSDC 정산 체인 (로컬) | — |
| :18443 | bitcoind regtest | 증빙 앵커 체인 | — |

**재기동(인스턴스 재시작 후)**: bitcoind regtest 기동 → `pm2 resurrect`. 파트너만 다시 세우려면 `attest/deploy/run-partners.sh`.
**상태 확인**: `curl -s localhost:8787/readyz` · `curl -s localhost:3300/healthz` · `pm2 list`.

## 0.5 저장소 — MySQL이 기본 엔진

샌드박스는 이름만 샌드박스일 뿐 상용 서버에 올라가는 동일 모듈이므로, 저장소도 상용과 동일한 **MySQL 8.0** 입니다 (`storage ready engine=mysql` 부팅 로그로 확인). SQLite는 단위테스트·무설정 폴백 전용.

- **자격증명**: `deploy/mysql.env` (STONEHASH_DB_URL · 600 퍼미션). core는 `attest/apps/core/.env`의 `STONEHASH_DB_URL`로 붙습니다.
- **직접 조회**: `source deploy/mysql.env && mysql -h127.0.0.1 -ustonehash -p"$MYSQL_PASSWORD" stonehash_attest -e "SELECT COUNT(*) FROM remit_payments;"`
- **리셋**: `deploy/reset-sandbox.sh`가 스키마 DROP→CREATE 후 재프로비저닝 (파일 삭제가 아니라 DB 초기화).
- **SQLite→MySQL 이관**(일회성, 이미 완료): `attest/apps/core/scripts/migrate-sqlite-to-mysql.mjs` — 테이블별 카운트 + 삽입순서(rowseq) 검증 포함.
- **MySQL 다운이면**: core가 부팅 거부(`cannot reach MySQL at …`). `sudo systemctl start mysql` 후 `pm2 restart stonehash-attest-core`.

## 0.6 송금 거래 검색·페이징 (수천 건 대비)

`GET /v1/settlements`는 서버측 필터 + **키셋 커서** 페이징입니다 (OFFSET 아님 — 동시 삽입에도 누락·중복 없음).

```
GET /v1/settlements?q=131f&state=EVIDENCE_ANCHORED&limit=25&cursor=<이전 응답의 page.next_cursor>
→ { data: [...], page: { total, returned, next_cursor } }
```

- `q` 거래 ID 부분일치(대소문자 무관) · `state` 정확일치 · `from`/`to` created_at ISO 범위 · `limit` 1–100(기본 25)
- 콘솔 **송금** 메뉴 = 같은 API: 검색창(300ms 디바운스) + 상태 콤보 + "더 보기"(이미 펼친 행 유지한 채 append)
- SDK: `client.list({ q, state, cursor, limit })` (@stonehash/attest-remit)
- **볼륨 시더**(실파이프라인 N건, INSERT 아님): `cd attest && node deploy/seed-remit-volume.mjs --count 36 --concurrency 6` — RETURNED·L1·RFI 혼합이라 상태 필터까지 체감 가능. 콘솔 로그인은 ops@demo-bank.example (암호는 :3200 연동 정보 카드).

## 1. 자동 검증 (스모크 3종 + 테스트 스위트)

```bash
cd ~/bitcert-attest/attest

# ① 송금 해피패스 E2E — 구독→견적→HSM서명 지시→JWE 트래블룰→BFI 승인
#    →anvil USDC 실전송→FAST 입금(L3)→6축 대사→앵커→독립검증
bash deploy/smoke-remit.sh

# ② PoR(C안) E2E — 합성 1만리프→SDK 로컬 트리→선언문 제출→챌린지 8리프 개봉
#    →검증→준비금 온체인 실측(커버리지)→앵커→사용자 오프라인 증명 검증
bash deploy/smoke-por.sh

# ③ 예외 매트릭스 7종 — 제재거절/지급실패·반환/L1보류/RFI왕복/취소/모드B/Manifest누락적발
bash deploy/smoke-exceptions.sh

# 유닛+통합 테스트 전체 (remit 11종·attest-por 10종 포함 395+)
pnpm -r --no-bail test
pnpm -r --no-bail typecheck
```

세 스모크가 각각 `✓ … passed`로 끝나면 전 기능이 살아있는 것입니다. 스모크는 반복 실행해도 안전합니다(멱등 프로비저닝).

## 1.5 셀프서브 고객 경로 — 직접 테스트 (가입→구독→API)

실제 고객이 밟는 동선 그대로, 처음부터 끝까지 본인 계정으로:

1. **요금 확인**: `http://<HOST>:3100/pricing` (푸터 "요금 안내") → "샌드박스 콘솔 열기".
2. **가입**: `http://<HOST>:8787/console/` → 계정 생성 → **API 키가 1회 표시됨(복사 필수)** → 랜딩은 **대시보드**(계정 요약 + 구독·사용량).
3. **구독 섹션**(구 상품): Attest Core가 이미 "구독 중"(가입 시 자동). 상품 카드 3종이 한 화면 그리드로, 각각 상태·과금 축·활성화 폼.
4. **PoR 활성화**: Proof of Reserves 카드 → 기관명 입력·국가 선택(콤보) → 서명키 드롭다운 **"＋ 브라우저에서 새 서명키 생성"** → [구독 활성화] → **개인키 PEM 자동 다운로드**(유일본, 서버엔 공개키만) → **기관 ID는 자동 발급**되어(예: `KY-EX-3F2A1B`) "다음 단계" 패널의 명령에 채워져 나옵니다. HTTP 오리진에서도 키 생성이 동작합니다(순수 JS 폴백).
5. **Remit 활성화**: 같은 방식(국가 VN 등 선택, Webhook은 비워도 됨 — 폴링 동작). 기관 ID 자동 발급.
6. **PoR 실행** (카드의 명령 복사, API키·PEM 경로만 치환):
   ```bash
   cd ~/bitcert-attest/attest
   node quickstart/por.mjs --core http://<HOST>:8787 --api-key sk_test_…      --key ~/Downloads/stonehash-por-signing-key.pem --institution <자동발급 ID — 카드 명령에 표기> --users 1000
   ```
   → 합성부채→로컬 트리→제출→8리프 챌린지 개봉→앵커→사용자 증명까지 자동. 산출물 `quickstart/out/por-*/user-proof.json`을 `playground/por.html`에 붙여 브라우저 검증.
7. **송금 실행**:
   ```bash
   node quickstart/remit.mjs --core http://<HOST>:8787 --api-key sk_test_…      --key ~/Downloads/stonehash-remit-signing-key.pem --institution <자동발급 ID — 구독 화면의 "다음 단계" 안내에 표시> --amount 1000.00
   ```
   → 견적→내 키로 3요소+승인 서명→제출→상태 폴링→L3 증빙 독립검증. 금액 레버(§2)도 그대로 먹힘(*.13 반환 등). 수취 확인은 `:3300`.
8. **콘솔 재확인**: 송금 섹션(내 거래·이벤트 로그·증빙 다운로드), 대시보드/구독(사용량 — Attest used는 안 늘고 송금/PoR "포함 앵커"만 증가), 앵커링 기록(상품 = 준비금 증명 — 스냅샷 줄을 열면 ID·루트·표본 확인), 검증(내려받은 증빙·번들·준비금 증명 파일 확인).

주의: 브라우저 생성 키의 **PEM 파일을 잃으면 서명 불가**(재발급 = 새 키 생성 후 재활성화). 퀵스타트는 등록 공개키와 PEM 일치 여부를 먼저 대조해 친절히 실패합니다.

**환경 초기화**: `bash attest/deploy/reset-sandbox.sh` — 전 데이터 삭제 후 데모은행·수취파트너 재프로비저닝(무거래 상태).

## 1.7 서명키 SDK 경로 + 웹훅 퍼블릭 IP (2026-11-11)

**서명키(상용 경로)** — 브라우저 민트 대신 서버측 SDK로:
```js
import { generateSigningKey, registerIssuerKey } from '@stonehash/attest-remit'; // attest-por에도 동일 export
const k = generateSigningKey();                     // ES256 로컬 생성, privateKeyPem이 유일본
await registerIssuerKey({ core, apiKey, publicKeySpkiBase64: k.publicKeySpkiBase64, label: 'bank HSM #1' });
```
- API: `POST /v1/issuer-keys`(Bearer, SPKI 파싱 검증, 동일 키 멱등 200 already) · `GET /v1/issuer-keys`
- 등록된 키는 콘솔 구독 활성화의 키 목록에 즉시 나타남 → 선택해 활성화. 가이드: 개발자 허브 por (송금 가이드는 2026-11-18부터 콘솔에서 하는 절차를 다루지 않습니다).

**SDK 다운로드 배포(고객사 시스템 실행)**: 개발자 허브가 tarball 3종을 호스팅 — `/docs/download/attest-{sign,remit,por}.tar.gz`(+.sha256, 재현가능 tar). docs 빌드가 매번 소스에서 패킹(stale 불가), 의존성(@stonehash/attest-verify·rules)은 소스+심링크로 동봉. 고객사 절차: 내려받아 체크섬을 확인하고 압축을 푼 뒤, Node ≥22.18에서 자기 시스템 소스가 `import './packages/attest-remit/src/index.ts'`로 호출(빌드·npm install 없음). 송금 tarball에는 2026-11-18부터 명령줄 도구(`cli.ts`)·폴더 어댑터(`adapter.ts`)·`quickstart/remit.mjs`가 들어가지 않습니다 — 저장소에만 있는 내부 시험 도구입니다. 검증 레시피: 리포 밖 임시 디렉토리에서 추출본만으로 실거래 1건 완주 + 증빙 4체크(위 E2E 수행됨).

**웹훅은 퍼블릭 IP로**: demo-bank 구독의 webhook_url = `http://3.36.101.90:3200/api/remit/webhook` (로컬호스트 아님 — 외부에서 실제 배달 경로 검증). demo-bank 서버는 `BANK_PUBLIC_BASE` env로 자기 주소를 알며(pm2에 반영·save됨), 리셋 후 재프로비저닝 시에도 이 env가 설정된 상태로 bank-demo를 띄워야 같은 URL이 등록됩니다. 배달 확인: `remit_webhook_deliveries`에서 url LIKE 'http://3.36.%' AND status='delivered'.

## 2. 데모 레버 (전부 "데이터"로 트리거 — 숨은 스위치 없음)

| 레버 | 발동 조건 | 결과 |
|---|---|---|
| 제재 적중 | 수취인명에 `SANCTIONED` 포함 (시나리오 선택 시 자동) | 트래블룰 거절 → `CANCELLED` |
| EDD·RFI | 무역금액 **≥ USD 20,000** | 질의 2건 수신, 답변 전까지 정지 |
| 지급 실패·반환 | 금액 끝자리 **`.13`** | FAST 거절 → USDC 온체인 반환 → `RETURNED` |
| L1 증거등급 | 금액 끝자리 **`.01`** | 무서명 통보 → `EVIDENCE_INSUFFICIENT`, 확정 보류 |
| L2 증거등급 | 금액 끝자리 **`.02`** | BFI 서명만(참조번호 없음)으로 확정 |
| 정상(L3) | 그 외 | 현지은행 참조 + 은행 자체서명 중첩으로 확정 |

## 3. 브라우저 데모 A — 송금 해피패스 (5분)

`http://<HOST>:3200/remit.html` 열기 (수취측 `http://<HOST>:3300/`을 다른 탭에 함께).

1. **[구독]** 좌측 "송금 상품 구독"이 비활성이면 **구독 활성화** 클릭 → Trust Registry 등록 + Webhook 연결 표시.
2. **[수입업체 화면]** 인보이스 번호·금액(기본 10000.00)·시나리오 **"정상 거래 (L3)"** → **송금 신청**.
3. **[은행 심사역]** 오른쪽 카드 클릭해 펼침 → **① 플랫폼 견적 조회** → 수납 VND·지급 SGD·만료 확인 → 체크리스트 3개(KYB·무역서류·외환) 체크 → **② VND 수납 → HSM 서명 → 지급지시 제출**.
   - 각 step의 "상세"를 열면: 수납 전표, openssl HSM 서명 바이트, JCS 서명대상, 멱등키, 202 응답 원문이 그대로 보입니다.
4. **[타임라인]** 상태가 1→8로 흐르는 것 확인. 볼 것:
   - 모든 행의 `Webhook` 태그 + **서명검증✓** (플랫폼 서명을 은행이 검증)
   - **"수취측 지급 진행중 — 입금확정 아님"**과 **"수취인 입금 확인"**이 구분 표기되는 것 (라스트마일 원칙)
5. **[수취측 탭]** Triple-A 콘솔에 거래 상태, **SG 수취은행 통장에 SGD 입금 + FAST 참조번호**가 찍힌 것 확인 — "실제로 돈이 간" 증거는 상대 기관 화면에서.
6. **[증빙]** 완료 카드에서 L3 뱃지·FAST 참조·anvil TX·앵커 attestation 확인 → **증빙 패키지 다운로드** → **독립 검증 실행** → 4체크 (커밋 재계산 / 요소서명 6건 / 6축 재판정 일치 / 비트코인 번들) 전부 ✅.

## 4. 브라우저 데모 B — 예외 시나리오 (각 1~2분)

같은 신청 폼에서 **시나리오만 바꿔** 반복:

- **제재 적중**: 신청 → 심사·제출 → 타임라인에 "트래블룰 거절" → `취소됨`. 수취측 콘솔에도 거절 기록.
- **EDD·RFI (고액)**: 제출 후 카드에 **노란 RFI 패널**(질문 2개) 등장 → 답변 입력 → **답변 서명·제출** → 정산이 재개되어 끝까지 완주. 타임라인에 "RFI → 답변 수리" 흔적.
- **지급 실패·반환**: 제출 → USDC 전송까지 정상 → "현지 지급 실패" → **빨간 반환 카드**: 사유 + 반환 TX + "당행이 고객 VND 환불" 안내. 수취측 지갑 패널에서 트레저리 잔액이 복구된 것도 보임.
- **L1**: 완료 통보는 오지만 **노란 "증거 불충분" 카드** — 실패가 아니라 INSUFFICIENT_EVIDENCE로, 입금확정이 선언되지 않음. 증빙 다운로드 버튼이 안 뜨는 것이 정상.
- **L2**: 확정은 되지만 결과 카드에 현지은행 참조번호가 없음(L3와 비교 포인트).
- **취소**: RFI 시나리오로 제출 → RFI 패널이 뜬 "멈춘" 상태에서 **취소 버튼** → `CANCELLED`. (사전승인 이후에는 취소 버튼이 사라지는 것도 확인 포인트.)
- **모드 B**: 신청 시 "트래블룰 모드 B" 체크 → 제출 steps에 **"은행측 암호화"** 단계 추가 — IVMS101 구성과 JWE 암호화가 은행 쪽에서 일어나고, 플랫폼은 암호문만 중계(상세에서 ciphertext·필수필드 어설션 확인).

## 5. 브라우저 데모 C — 일별 마감 대사 (Manifest)

좌측 **"일별 마감 대사"** 카드:

1. 그냥 **제출** → 은행 목록 vs 플랫폼 목록 양방향 비교 결과. *주의*: 스모크를 돌린 날이면 스모크가 직접 넣은 거래가 `missing_in_manifest`로 적발되어 DISCREPANT가 뜹니다 — **이게 완전성 통제가 작동한다는 증거**입니다(은행 장부 밖 거래 적발).
2. **"1건 누락 시뮬레이션"** 체크 후 제출 → 뺀 payment_id가 정확히 지목되는 것 확인.
3. 결과의 커밋이 앵커(attestation id)로 이어지는 것 확인 — 대사 결과 자체가 비트코인에 고정됩니다.

## 6. 데모 D — PoR (거래소 SDK: 잔고 파일 → 루트 → 서명·제출 → 사용자 검증)

**CLI가 곧 거래소 데모**입니다 (C안: 트리는 거래소 서버에서만). 2026-11-16부터
기본 제출은 서명된 선언문만 보내며(`ACCEPTED`), 표본 확인은 `--spot-check`를
줄 때만 합니다(`VERIFIED`). 고객용 안내는 개발자 허브의 "준비금 증명: 잔고 파일".

```bash
cd ~/bitcert-attest/attest
# 전 과정 자동(두 경로 모두): bash deploy/smoke-por.sh  (아래는 수동 분해)

CLI=packages/attest-por/src/cli.ts
# 예시 잔고 파일로 검사 → 빌드 (세로형·소수 표기)
node $CLI check --csv packages/attest-por/samples/balances.long.csv \
  --assets BTC:8,ETH:18,USDT:6 --amounts decimal
node $CLI build --csv packages/attest-por/samples/balances.long.csv --amounts decimal \
  --exchange EX-DEMO-001 --name "Demo Exchange (sim)" --asof $(date -u +%FT%TZ) \
  --assets BTC:8,ETH:18,USDT:6 --out /tmp/por-run
# → snapshot.json(선언문) / leaves.jsonl·seed.hex·tree.json(거래소 내부, 0600) / build-report.json

# 서명 → 제출 (스모크가 프로비저닝한 거래소 계정·서명키 사용)
node $CLI sign --tree /tmp/por-run --key apps/core/.data/por-exchange-key.pem
STONEHASH_API_KEY=<apps/core/.data/por-exchange.json 의 apiKey> \
  node $CLI submit --tree /tmp/por-run --core http://127.0.0.1:8787 --wait
# → submission.json(전송되는 전부) / receipt.json(스냅샷 ID·앵커 상태)
```

**사용자 입장 검증** (스모크가 끝난 뒤):
1. 스모크 출력의 snapshot id 복사.
2. 사용자 증명 발급: `node $CLI prove --tree apps/core/.data/por-run --user-ref user-0000042 --out /tmp/proof.json`
3. **오프라인 CLI 검증**: `node $CLI verify-proof --proof /tmp/proof.json --snapshot apps/core/.data/por-run/snapshot.json` → `root+totals MATCH`.
4. **브라우저 검증**: `http://<HOST>:8787/playground/por.html` → ① proof.json 붙여넣기 ② snapshot id로 "가져오기" ③ user_ref에 `user-0000042` → **검증 실행** → 5체크(거래소 서명 / 포함증명·총액 바인딩 / 계정 대조 / 커밋 / 앵커 번들) + **내 잔고 표시** + **준비금 커버리지**(USDT는 체인 실측 ~110%, BTC는 "미실측—선언만").
5. 음성 테스트: proof.json의 잔고 숫자 하나 고치고 재검증 → 포함증명 ❌.

콘솔(`:8787/console/` → **앵커링 기록**, 상품 = 준비금 증명)에서 스냅샷과 앵커 상태도 확인 가능 — 줄의 "스냅샷 …"을 누르면 스냅샷 ID·루트·계정 수·표본 확인이 열림. 데모 거래소 계정: `ops@demo-exchange.example` (비번은 `attest/apps/core/.data/por-exchange.json`).

## 7. 데모 E — 콘솔 (송금 + 상품)

**대시보드(랜딩)**: 로그인 직후 화면이 `GET /v1/console/dashboard` 집계 한 번으로 그려집니다.
- **주의 필요** 스트립: RFI 답변 대기 · L1 보류 · 예외 · 웹훅 소진 · 미확정 앵커 — 전부 0이면 "모두 정상". demo-bank 계정은 예외 스모크 흔적(L1 보류·예외)이 그대로 보입니다.
- 구독한 상품만 카드가 뜹니다: **송금**(오늘/이달 건수·금액 $합계, 상태 분포, 오늘 Manifest 대사 칩, 웹훅 건강, 평균 입금확정 소요, 최근 5건) · **PoR**(최신 스냅샷 asof·VERIFIED·앵커·자산별 커버리지 칩, 추이, 마지막 제출 경과) · **Attest**(확정/미확정, 상태 깔때기, 평균 확정 소요, 서명·등록키 비율, 최근 5건).
- 커버리지 칩: reserves 포함 발행(스모크 PoR)이면 "USDT 109.99%", 미포함(quickstart)이면 "미측정".

`http://<HOST>:8787/console/` 로그인(데모은행: `ops@demo-bank.example`, 비번은 demo-bank 첫 화면 "연동 정보"에 표시).

**송금 섹션** (플랫폼 쪽에서 본 거래 원장 — 은행 화면과 같은 거래를 플랫폼 상태머신으로):
- 거래 목록: payment_id·상태(한글 뱃지, "지급 진행중 ≠ 입금확정" 구분)·금액 3단(무역 USD/수납 VND/지급 SGD)·증거등급·앵커 상태·USDC tx
- 행의 **"서명 이벤트 로그"**를 펼치면 이벤트별 발행 기관·서명 여부(서명/내부 칩)·시각
- **증빙 패키지 내려받기(JSON)** — demo-bank에서 받는 것과 동일한 패키지를 콘솔에서도 직접
- **일별 Manifest 카드**: 날짜별 MATCHED/DISCREPANT, 양방향 누락 목록, 커밋·앵커 상태 (제출 자체는 은행 어댑터가 함)

**상품 섹션**:
- 구독 현황(remit — VN-BANK-001 / COLLECTION_BANK, por — EX-DEMO-001)과 엔드포인트 표시
- 활성화 폼: 기관 ID·서명키(등록된 발행인 키 선택)·Webhook으로 신규 조직도 셀프서브 등록 가능
- (2026-11-18부터) PoR 스냅샷 목록은 이 섹션이 아니라 **앵커링 기록**에 있음 — 상품 = 준비금 증명으로 좁히고 줄을 열면 상태·앵커·공개 검증 페이지 링크

## 7.5 데모 F — 빌링 표면 (요금 정책이 보이는 곳)

- **홈페이지 공개 요금**: `http://<HOST>:3100/pricing` (nginx 뒤면 `/pricing`) — 상단 네비 "요금 안내". 4카드(샌드박스 무료/Attest Core/PoR/송금)와 과금 축, "Evidence Included" 원칙 3개, 라이브 요율은 "파일럿 계약 확정 + 요율표 요청" CTA. **숫자 요율은 의도적으로 미게시** — 확정 시 `data/translations.json`의 `pricing.*` 키에 기입.
- **콘솔 내 플랜·사용량**: 콘솔 → 상품 → "플랜 · 이번 달 사용량" — Attest 쿼터(고객 직접 앵커만 n/1000), 송금(정산 건수 + 포함 발행 앵커, 쿼터 미차감 표기), PoR(스냅샷 수 + 포함 앵커).
- **계량 분리 확인**: 송금을 1건 완주시킨 뒤 상품 화면에서 Attest `used`가 **늘지 않고** 송금의 `포함 발행 앵커`만 +1(증빙) 되는지. 일별 Manifest 제출 시에도 동일(+1 remit).

## 7.8 데모 G — 고객사 3사 포털 (타깃 고객 유형별, 전부 공개 API·SDK)

`http://<HOST>:3400/` — 탭 하나가 고객사 하나이고, 각 탭의 백엔드가 그 고객사가 작성할 연동 코드입니다(플랫폼 내부 모듈 import 0):

| 탭 | 고객사 | 사용하는 것 | 해보기 |
|---|---|---|---|
| 🏭 한빛정밀 | 문서·기록 앵커링만 쓰는 제조사 | `attest-sign.signStatement` + `POST /v1/attestations/signed` + `attest-verify.verifyBundle` | 파일 올리면 해시→발행인 서명→앵커→독립검증, 번들 다운로드 |
| 🪙 OrbitX | 주기적 PoR 발행 거래소 | `attest-por` — `buildPorTree`(로컬)·`PorClient.publish`(서명·제출·챌린지 응답) | 고객 수 입력→스냅샷 발행→공개자료·사용자 증명 다운로드 |
| 🏦 데모은행 | 국경간 정산 은행 — 콘솔 계정 `ops@demo-bank.example`(VN-BANK-001)로 지급하므로 콘솔 송금 원장에 그대로 보임 (2026-11-17~) | `attest-remit` — `RemitClient.submitSwift`(SWIFT 전문) · `commandSigner`(HSM 서명) · `verifyEvidencePackage` 4체크 | 표본 전문(MT103·pacs.008·pain.001) 불러와 실행 → 변환 내역·SWIFT 상태·pacs.002 내려받기·콘솔 바로가기, 또는 금액만 입력 (금액 레버 동작) |

3사는 `demo-customers/setup.mjs`가 셀프서브 경로(가입→키→활성화, 기관 ID 자동발급) 그대로 프로비저닝합니다. 리셋 스크립트에 포함되어 있습니다.

**개발자 허브**(`:8787/docs/`)에 **국경간 정산 / 준비금 증명 가이드**(한/영)와 **API 레퍼런스 19개 오퍼레이션**(remit·por 전 라우트 — 서버와 양방향 대조 테스트로 고정)이 추가됐습니다. 고객 개발자 온보딩 경로: 홈페이지 → /pricing → 콘솔 가입·구독 → docs 가이드 → SDK(quickstart와 동일 코드).

## 7.9 SWIFT 전문 연동 시험 (2026-11-17)

은행이 이미 만드는 전문(MT103 · pacs.008 · pain.001)을 SDK가 지급지시로 바꾸고, 상태를 pacs.002로 돌려줍니다. 허브 가이드: `:8787/docs/#corridor` (2026-11-18: SWIFT 전문 연동 페이지를 이 페이지로 합쳤고, 허브는 은행이 자기 시스템 소스에서 SDK를 호출하는 연동만 안내합니다). 아래의 명령줄 도구와 폴더 어댑터는 내부 시험용으로 저장소에 남아 있으며, 허브에는 안내하지 않고 내려받기 파일에도 들어가지 않습니다(저장소에서 실행).

```bash
cd attest
# 단위 테스트 112건 — 전문 판독·변환·상태보고(31) + 리더·매핑·상태 보강(54) + 서명기·읽기 전용 클라이언트·모드 B·중복 방지·폴더 어댑터(22) + 증빙 검증(2) + 기존(3)
# 중복 방지 테스트의 대역 플랫폼은 플랫폼의 실제 저장 로직(apps/core/src/remit/store.ts)을 인메모리 DB로 돌립니다 (test/support/source-ledger.ts)
(cd packages/attest-remit && node --test 'test/*.test.ts')

# 오프라인 판독: 전문의 각 값이 지급지시의 어디로 가는지, 무엇이 빠졌는지
node packages/attest-remit/src/cli.ts inspect packages/attest-remit/samples/mt103.sample.txt
node packages/attest-remit/src/cli.ts inspect packages/attest-remit/samples/mt103.sample.txt \
  --parties packages/attest-remit/samples/parties.sample.json

# 실제 제출 (기관 ID·API 키·서명키는 콘솔에서 발급받은 값)
export STONEHASH_CORE=http://127.0.0.1:8787 STONEHASH_API_KEY=sk_test_… STONEHASH_INSTITUTION=VN-BANK-…
node packages/attest-remit/src/cli.ts submit packages/attest-remit/samples/pacs008.sample.xml --key bank-signing.key --wait

# 폴더 어댑터 (코드 없는 연동): inbox에 전문을 넣으면 outbox에 pacs.002·증빙이 쌓임
node packages/attest-remit/src/cli.ts run --key bank-signing.key --inbox ./inbox --outbox ./outbox \
  --parties packages/attest-remit/samples/parties.sample.json --once
```

- 같은 전문을 다시 넣으면 새 지급을 만들지 않습니다. 지급 ID는 전문의 참조에서만 만들어집니다 — UETR이 있으면 `PAY-<UETR 첫 8자>-<해시 10자>`(작성일은 들어가지 않으므로 다음 날 재출력도 같은 지급), 없으면 전문번호·지시번호·End-to-end ID·결제일.
- 같은 UETR인데 금액·당사자·계좌·인보이스가 다른 전문은 반복으로 보지 않고 `reference_reused`로 거절합니다(전송 없음).
- 거절되는 것: MT103이 아닌 전문(MT202, 헤더 없는 MT102·커버 전문), 다른 경로(VN→SG가 아닌 지급), 개인으로 식별된 당사자, 시험 전문(23B `CRTS`·시험용 BIC — 시험 키에서만 수용), 같은 필드가 두 번 나오는 MT103.
- 파일 하나에 전문 여러 건(`$` 구분 포함)·문서 여러 건이 들어 있으면 건마다 송금이 됩니다. 어댑터 출력 파일 이름은 `<지시번호>.<지급 ID>.…`입니다.
- `submit --wait` 종료 코드: `0` 입금 완료 · `3` 지급되지 않음(거절·취소·반환) · `4` 조치 대기(질문·정지).
- 모드 B(`--travel-rule B`)에서는 은행 서명이 메시지 digest와 암호문 해시까지 덮습니다. 암호문을 바꿔 넣은 지급지시는 코어가 `400 invalid_fields_assertion`으로 거절합니다.
- 콘솔 송금 검색창은 UETR·지시번호·End-to-end ID·전문번호·은행 승인번호로도 찾습니다.
- 브라우저에서는 `:3400` 은행 탭의 "SWIFT 전문으로"가 같은 경로입니다.

## 8. 문제 해결

| 증상 | 처치 |
|---|---|
| 송금이 `EXCEPTION` + "partner not reachable" | `pm2 restart stonehash-partners` (anvil 먼저: `:8545` 응답 확인) |
| 앵커가 `pending`에서 멈춤 | bitcoind regtest 확인: `curl -s localhost:8787/readyz` |
| Webhook 미수신(타임라인에 폴링만) | demo-bank 재기동 후 재구독: 구독 카드에서 활성화 1회 (멱등) |
| 코드 수정 반영 | 코어/파트너/뱅크 각각 `pm2 restart <이름>` (빌드 불필요 — node가 TS 직접 실행; 콘솔·플레이그라운드만 `pnpm build`) |
| 데이터 초기화 | demo-bank: `data/remit-cases.json` 삭제 · partners: `data/*.json` 삭제 · 플랫폼: `.data/attest-test.sqlite` (주의: 전체 초기화) |
