# StoneHash Attest — 국경간 송금(Remit) · 준비금 증명(PoR) 확장 설계

> 버전 0.1 (설계안) | 2026-11-10 | 대상: 현행 샌드박스(`attest/` + `demo-bank/`) 확장
>
> 참조: `ref/StoneHash 국경간 송금 아키텍처 — 은행 × StoneHash × 수취측 인가기관.docx`(이하 **아키문서**),
> `ref/비SWIFT 마지막 구간의 지급 결과 확인.docx`(이하 **라스트마일 문서**), `ref/StoneHash_Attest_ClaudeCode_구현가이드.md`
>
> **가드레일**: 전 기능은 아키문서 §10-1의 **단계 0 (Evidence Lab — 현재 샌드박스 확장)** 범위다.
> 모든 자금 이동은 합성(로컬 체인·모의 원장)이며, Triple-A는 **"Triple-A 프로파일의 모의 BFI"**로만 표기한다.
> 실제 파트너 API가 운영 중인 것처럼 표현하지 않는다(구현가이드 §1.2).

---

## 0. 한 장 요약

지금 샌드박스는 **"증거를 검증하는 곳"**(샘플 데이터로 6축 판정, 변조 실험, 패키지 재검증)이다.
이번 확장으로 **"거래가 흐르면서 증거가 생기는 곳"**이 된다.

- 은행이 콘솔에서 **Cross-border Settlement 상품을 구독** → remit 스코프 API 키 발급.
- 은행(demo-bank)이 **POST /v1/quotes → POST /v1/settlements**(JWS 서명 지급지시)를 호출.
- 플랫폼이 **IVMS101 트래블룰을 JWE로 암호화해 BFI(Triple-A 프로파일 모의, 싱가포르)에 송신** → 서명된 사전승인 수신.
- **정산주체 지갑이 anvil 로컬 체인에서 USDC(모의)를 실제 전송** → BFI가 수취 확인 → 모의 SG 수취은행 FAST 원장에 SGD 입금 → 입금 참조번호 발급.
- BFI가 서명한 `PAYOUT_COMPLETED`(L3: 현지은행 참조번호 포함)를 받아 대사(기존 6축 엔진 재사용) 후
  **Evidence Package 생성 → 커밋을 기존 배치 머클·비트코인 regtest 앵커링 경로로 앵커**.
- 은행은 전 과정을 **Webhook(JWS 서명) + GET 폴링** 이중화로 수신(라스트마일 문서의 업계 공통 패턴).
- demo-bank에 **수입업체(송금인) 신청 → 은행 심사·승인 → 플랫폼 호출 → 상태 타임라인 → 증빙 다운로드·독립검증** 시나리오 추가.
- 별도 트랙으로 **거래소 PoR**: 부채 스냅샷 수신 → **머클 합 트리** 구축 → 루트를 기존 앵커링 경로로 앵커 → 사용자 포함증명 공개 검증.

핵심 설계 방침: **신규 코드는 "오케스트레이션과 시뮬레이터"에 집중하고, 검증·대사·앵커링·서명은 전부 기존 자산을 재사용**한다.

---

## 1. 요구사항 → 기능 목록

| # | 요구(사용자 요청 + 아키문서) | 이번 설계의 응답 |
|---|---|---|
| R1 | 은행이 플랫폼 **구독**을 통해 견적·지급지시 | 콘솔 Products 페이지 + `subscriptions` 테이블 + API 키 스코프 (§4) |
| R2 | **견적(quote)** | `POST /v1/quotes` — 환율·수수료·지급예상액·만료시각 (§5) |
| R3 | **지급지시(settlement)** | `POST /v1/settlements` — 은행 JWS `bank_authorization` + 멱등키 (§5) |
| R4 | **트래블룰 데이터 송신 내재화** (Triple-A류 수취국 인가업자에) | Travel Rule Relay: IVMS101 매핑 + JWE(ECDH-ES+A256GCM) + BFI Connector 플러그인 (§7–8) |
| R5 | 데모에서 Triple-A·실제 SG 수취은행을 가정하고 **실제로 송금** | `demo-partners` 프로세스: Triple-A 프로파일 BFI + SG 수취은행 원장 + 정산주체 지갑, anvil 체인 USDC 실전송 (§8–10) |
| R6 | 은행데모에 **수입업체가 송금하는 시나리오** | demo-bank에 송금 탭(수입업체 퍼소나 + 은행 심사 퍼소나) (§12) |
| R7 | 송금은행이 **최종 입금을 아는 방법** (라스트마일 문서) | Webhook+폴링 이중화, `PAYOUT_PROCESSED` ≠ `BENEFICIARY_CREDIT_CONFIRMED` 분리, L1~L3 증거등급, 일별 Manifest (§6, §10) |
| R8 | **거래소 PoR 데이터 수신 → 머클트리 → 앵커링** | `attest-por` 패키지(머클 합 트리) + 스냅샷 API + 공개 포함증명 검증 (§13) — **수신 방식은 §13-3 선택지로 제시** |

---

## 2. 현재 자산 인벤토리와 재사용 맵

| 기존 자산 (실측) | 위치 | 이번 확장에서의 역할 |
|---|---|---|
| 계정·조직·API 키·세션 | `core/src/account.ts`, `db.ts` (orgs/api_keys/accounts) | 구독·스코프의 토대. 테이블 추가만 |
| issuer_keys (기관 서명키 등록, ES256) | `core/src/db.ts`, `http/console.ts` | **Trust Registry의 뼈대** — role 컬럼 추가로 은행/BFI/정산주체 구분 |
| 배치 머클 + bitcoind regtest 앵커 + 인스크립션 | `core/src/merkle`, `anchor/`, `worker.ts` | Evidence 커밋·PoR 루트 앵커링 **무수정 재사용** |
| 6축 판정 엔진 + corridor 증거 모델 | `packages/attest-rules` (engine/types/corridor/layers) | **실거래 이벤트 → SettlementEvidence 매핑 후 그대로 판정** (§11). 샌드박스 화면과 동일 코드 경로라는 기존 원칙 유지 |
| Evidence 번들·PDF·ZIP | `packages/attest-evidence` | Evidence Package 산출물 생성 재사용 |
| 독립 검증기 (merkle/p256/jcs/recon/anchor) | `packages/attest-verify` | 은행측 번들 재검증. PoR용 머클 합 트리 검증기만 추가 |
| attest-sign CLI + Docker 배포 패턴 | `packages/attest-sign`, demo-bank vendor | 은행 HSM 서명 패턴 재사용. (P2에서 트래블룰 모드 B 암호화 추가 지점) |
| demo-bank (openssl HSM, 파이프라인 step UI, state.json 프로비저닝) | `demo-bank/server.mjs` | 송금 시나리오의 **Bank Adapter 레퍼런스 구현**으로 확장 |
| 정적 FX·정책 데이터 모델 | `attest-rules/policy.ts`, `samples.ts` | 견적 엔진의 정책·허용오차 어휘 재사용 |
| 미구현 (net-new) | — | 상태머신 오케스트레이터, Webhook 발송기, Travel Rule Relay(JWE), BFI Connector, demo-partners 시뮬레이터, anvil USDC 레일, 구독 게이트, PoR 합 트리·스냅샷 API |

---

## 3. 전체 아키텍처

```
┌──────────────────────── demo-bank :3200 (은행 내부망 역할) ────────────────────────┐
│  수입업체 화면(신청)   은행 심사 화면(승인)   Bank Adapter(멱등·서명·Webhook수신)  │
│  openssl HSM (ES256)  ← bank_authorization JWS 서명                               │
└──────────────┬────────────────────────────────────────────────▲──────────────────┘
               │ mTLS 가정(샌드박스는 HTTP+Bearer)               │ Webhook(JWS) + GET 폴링
               ▼                                                │
┌──────────────────────── attest core :8787 (StoneHash) ────────┴──────────────────┐
│  Gateway(스코프·멱등·JWS검증)                                                     │
│  Remit Orchestrator(상태머신 9상태+예외) ── Travel Rule Relay(IVMS101→JWE)        │
│  BFI Connector(플러그인) ── Webhook Dispatcher(at-least-once, seq)                │
│  Evidence Mapper(이벤트→SettlementEvidence) → attest-rules 6축 판정               │
│  PoR Snapshot Service → attest-por 머클 합 트리                                   │
│  커밋 → [기존] 배치 머클 → bitcoind regtest 앵커/인스크립션                       │
└───────┬──────────────────────────────┬───────────────────────────────────────────┘
        │ BFI API(견적·TR·사전승인·지급상태)      │ 정산지시
        ▼                              ▼
┌─────────────── demo-partners :3300 (수취측 생태계 모의) ──────────────────────────┐
│  [키1] Triple-A 프로파일 BFI(SG MPI 모의): JWE복호→제재검사→PAYOUT_ACCEPTED 서명  │
│        USDC 수취감시 → FX → SG은행 지급지시 → PAYOUT_COMPLETED(L3) 서명           │
│  [키2] SG 수취은행(FAST 모의): 수출업체 계좌 원장, 입금 참조번호 발급             │
│  [키3] 정산주체 지갑(모델 B): 화이트리스트·한도 검사 → USDC 전송 서명             │
│  미니 UI: Triple-A 콘솔 뷰 + SG은행 입출금 내역 뷰 (수취 측 '실제 입금' 증빙)     │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                ▼
        anvil :8545 (eip155:31337, MockUSDC ERC-20)        bitcoind regtest (기존)
```

- **프로세스 3개 + 체인 2개**. demo-partners는 운영 편의상 단일 프로세스지만 **기관별 서명키 3개를 물리적으로 분리**해
  "각 기관은 자신이 확인한 사실에만 서명한다"(아키문서 설계원칙)를 증거 레벨에서 유지한다.
- 아키문서의 역할분리 대응: demo-bank=송금측 협력은행, core=StoneHash, demo-partners[키1]=BFI,
  [키2]=현지 지급은행, [키3]=인가된 정산주체(운영모델 B).

---

## 4. 구독 모델 — 은행이 플랫폼을 구독하는 방식

콘솔(기존 가입·로그인 재사용)에 **Products** 페이지를 추가한다.

1. 조직이 `Cross-border Settlement` 구독 활성화 → `subscriptions` 레코드 생성(plan=`sandbox`).
2. 활성화 마법사에서 입력: 기관 식별자(institution_id, 예: `VN-BANK-001`), 역할(`COLLECTION_BANK`),
   코리도(`VN→SG`), **Webhook URL**, 서명키 선택(기존 issuer_keys에서 지정 — demo-bank의 HSM 공개키).
3. 완료 시: API 키에 `remit` 스코프 부여, Trust Registry에 기관 등록, 샘플 curl·어댑터 설정 안내 표시.
4. PoR 상품(`Proof of Reserves`)도 같은 틀: 역할 `EXCHANGE`, `por` 스코프.

게이트: remit 라우트는 `requireScope('remit')` + 활성 구독 검사. 기존 `/v1/attestations`는 영향 없음.

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  product TEXT NOT NULL CHECK (product IN ('remit','por')),
  plan TEXT NOT NULL DEFAULT 'sandbox', status TEXT NOT NULL DEFAULT 'active',
  config TEXT NOT NULL DEFAULT '{}',          -- corridors, webhook_url, institution_id …
  created_at TEXT NOT NULL, UNIQUE (org_id, product));

CREATE TABLE institutions (                    -- Trust Registry (아키문서 §7-2 축약)
  id TEXT PRIMARY KEY,                         -- 'VN-BANK-001', 'SG-BFI-001', 'SETTLE-001', 'SG-PAYBANK-001'
  org_id TEXT REFERENCES orgs(id),             -- 플랫폼 밖 기관(BFI 등)은 NULL
  role TEXT NOT NULL CHECK (role IN ('COLLECTION_BANK','BENEFICIARY_FI','SETTLEMENT_ENTITY','LOCAL_PAYOUT_BANK','EXCHANGE','STONEHASH')),
  name TEXT NOT NULL, country TEXT,
  signing_spki TEXT,                           -- ES256 공개키(JWS 검증용)
  encryption_jwk TEXT,                         -- P-256 JWK(JWE 수신용, BFI만)
  authority TEXT NOT NULL DEFAULT '[]',        -- 허용 이벤트 유형 목록
  created_at TEXT NOT NULL);
```

샌드박스 v1은 X.509 체인 대신 **SPKI 등록 + authority 목록**으로 단순화한다(기존 issuer_keys 방식과 동일 철학).
X.509·CRL·TSA는 P2 과제로 명시(아키문서 §7-1은 목표 규격으로 문서화만).

---

## 5. Remit API v1 — 은행이 호출하는 표면

아키문서 §4-2를 그대로 따른다. 기존 `/v1/settlements/reconcile`·`/v1/settlements/bundle`(무상태 평가기)은
그대로 두고, 경로 토큰 `reconcile`·`bundle`을 settlement id로 예약 금지해 충돌을 차단한다.

| 메서드 | 경로 | 목적 | 비고 |
|---|---|---|---|
| POST | `/v1/quotes` | 코리도·금액 기준 견적 | `Idempotency-Key` 선택. 응답: rate, fees[], payout_amount, expires_at(10분), required_travel_rule_fields[] |
| POST | `/v1/settlements` | **지급지시** — 은행 서명 승인 제출 | `Idempotency-Key` 필수, body의 `bank_signature.jws` 검증(아래) |
| GET | `/v1/settlements/{id}` | 상태+이벤트 이력 (폴링) | Webhook 유실 대비 (라스트마일 문서 §5) |
| GET | `/v1/settlements/{id}/evidence` | Evidence Package | 대사 완료 후 생성, 앵커 전이면 `anchor: pending` |
| POST | `/v1/settlements/{id}/cancel` | 사전승인 전 취소 | 상태 1–4에서만 허용 |
| POST | `/v1/manifests/daily` | 은행 서명 일별 승인목록 → 완전성 대사 | R2 단계 |
| Webhook | 구독 설정 URL | 상태 전이마다 StoneHash JWS 이벤트 | `event_id`+`sequence`, at-least-once, 5회 백오프 재시도 후 폴링 안내 |

`POST /v1/settlements` 본문은 아키문서 §4-3 예시를 **그대로 채택**한다(필드명 포함:
`request_id, payment_id, quote_id, corridor, amount{collected,payout}, bank_authorization{...},
commercial_reference{invoice_ref, invoice_commitment}, beneficiary{institution_id, beneficiary_ref},
compliance_payload{format, encryption, recipient_kid, ciphertext_ref | plaintext(모드A)}, bank_signature{alg:ES256, kid, jws}`).

- `bank_signature.jws`는 `bank_authorization`의 **JCS(RFC 8785) 정규화 바이트**에 대한 ES256 — 정규화 함수는
  `attest-verify/jcs.ts` 재사용. 검증 성공 → 이벤트 `BANK_AUTHORIZATION_VERIFIED`.
- 멱등성: 아키문서 §8-3 — `Idempotency-Key`(요청) + `payment_id`(거래) 이중 키, 동일 키 재전송=캐시 응답, 충돌=409.
- 샌드박스 견적 엔진: 정적 테이블 `VND→USDC(모의 25,380/USDC)`, `USDC→SGD(모의 1.335)` + 스프레드·수수료 설정값.
  환율 원천은 config로 분리해 실연동 시 교체 지점을 명시.

---

## 6. 상태머신과 이벤트 모델

아키문서 §8-1의 9상태 + 예외 3종을 그대로 구현한다.

```
QUOTED → REQUEST_ACCEPTED → BANK_AUTHORIZED → TRAVEL_RULE_PENDING → PAYOUT_PRE_APPROVED
       → ONCHAIN_SETTLED → PAYOUT_IN_PROGRESS → BENEFICIARY_CREDIT_CONFIRMED → EVIDENCE_ANCHORED
예외: CANCELLED · RETURNED · EXCEPTION
```

- **상태는 전진만** 한다. 정정은 새 이벤트(`RETURNED`, `CORRECTION`)로 추가(§8-3).
- 모든 전이는 `payment_events`에 **서명 주체별 JWS와 함께 append-only** 저장. 이벤트 타입은 아키문서 §3의
  증거 목록을 그대로 사용: `QUOTE_ISSUED, FIAT_FUNDS_RECEIVED, PAYMENT_RELEASE_AUTHORIZED, REQUEST_ACCEPTED,
  BANK_AUTHORIZATION_VERIFIED, TRAVEL_RULE_SENT, TRAVEL_RULE_RECEIVED, RFI_*, PAYOUT_ACCEPTED,
  SETTLEMENT_INSTRUCTED, USDC_TRANSFER_CONFIRMED, USDC_RECEIVED, PAYOUT_SUBMITTED, PAYOUT_COMPLETED,
  SETTLEMENT_RECONCILED, EVIDENCE_ANCHORED (+ PAYOUT_FAILED, USDC_RETURNED, REJECTED)`.
- **핵심 규칙 2개를 오케스트레이터 불변식으로 강제**: ① `PAYOUT_ACCEPTED`(BFI 서명) 이전에 정산지시 금지,
  ② `PAYOUT_COMPLETED` L2 이상 + 대사 MATCHED 이전에 `BENEFICIARY_CREDIT_CONFIRMED` 선언 금지.
- 라스트마일 문서 요구: 은행 전달 상태에서 `PAYOUT_IN_PROGRESS`(BFI 처리중)와
  `BENEFICIARY_CREDIT_CONFIRMED`(입금 근거 확보)를 **반드시 구분 표기**. demo-bank UI 카피에도 반영.

```sql
CREATE TABLE payments (
  id TEXT PRIMARY KEY,                         -- payment_id (은행 제시 값, 유일)
  org_id TEXT NOT NULL, quote_id TEXT NOT NULL,
  corridor_origin TEXT NOT NULL, corridor_dest TEXT NOT NULL,
  collected_ccy TEXT, collected_value TEXT, payout_ccy TEXT, payout_value TEXT,
  usdc_value TEXT, state TEXT NOT NULL, evidence_level TEXT,       -- L1|L2|L3
  beneficiary_institution TEXT NOT NULL, request_body TEXT NOT NULL,
  attestation_id TEXT,                         -- 앵커 연결(기존 attestations FK)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  seq INTEGER NOT NULL, type TEXT NOT NULL, issuer TEXT NOT NULL,  -- institution_id
  payload TEXT NOT NULL, jws TEXT,            -- 서명자 없는 내부 이벤트는 NULL
  created_at TEXT NOT NULL, UNIQUE (payment_id, seq));

CREATE TABLE quotes (id TEXT PRIMARY KEY, org_id TEXT, corridor TEXT, request TEXT,
  response TEXT, expires_at TEXT, created_at TEXT);
CREATE TABLE idempotency (org_id TEXT, key TEXT, request_hash TEXT, response TEXT,
  created_at TEXT, PRIMARY KEY (org_id, key));
CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, org_id TEXT, event_id TEXT,
  url TEXT, attempt INTEGER, status TEXT, last_error TEXT, next_retry_at TEXT, created_at TEXT);
```

---

## 7. Travel Rule Relay — 송신 내재화

**2계층 데이터 모델**(아키문서 §6-1)을 메시지에 모두 담는다: 기초 무역대금(수입기업↔수출기업, 은행↔현지은행)
+ USDC 기관 간 이전(정산주체↔BFI). IVMS101-2023 JSON 매핑 모듈 `core/src/remit/ivms101.ts`.

처리 모드(아키문서 §6-3): **v1은 모드 A(서버 모드)** — 은행이 `compliance_payload.plaintext`로 당사자 정보를
보내면 Relay가 IVMS101 매핑→검증→**JWE 암호화**→BFI 전송. 모드 B(은행 SDK 암호화, attest-sign 확장)는 P2.
UI·문서에 "모드 A: 플랫폼이 평문 처리(파일럿용), 상용 권장은 모드 B" 라벨을 명시해 과장 금지 원칙 유지.

JWE 규격(아키문서 §6-4): `ECDH-ES + A256GCM`, 수신자 = Trust Registry의 BFI `encryption_jwk`(P-256).
의존성 없이 `node:crypto`로 구현: ECDH(P-256) + Concat KDF(NIST SP 800-56A) + AES-256-GCM, RFC 7518 테스트 벡터로 검증.
새 모듈 `core/src/remit/jwe.ts` (+ demo-partners의 복호 대칭 구현).

증거 처리: 평문은 저장하지 않는다. `travel_rule_messages`에는 **암호문, ivms101Digest(SHA-256), 전달 메타**만 저장
— 기존 `TravelRuleExchange` 모델("digest만, 원문 금지")과 정확히 일치. BFI ACK의 서명 digest가 `approvalDigest`가 된다.

```sql
CREATE TABLE travel_rule_messages (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL,
  direction TEXT, protocol TEXT DEFAULT 'IVMS101/JWE',
  ciphertext TEXT, ivms101_digest TEXT, recipient_kid TEXT,
  status TEXT,                                 -- SENT|ACK|RFI|REJECTED
  response TEXT, created_at TEXT);
```

RFI 흐름(R2): BFI가 RFI 반환 → 상태 `TRAVEL_RULE_PENDING` 유지 + Webhook으로 은행에 보완요청 전달 →
은행이 `POST /v1/settlements/{id}/rfi-response` 제출 → 재심사. 시한 초과 시 CANCELLED.

---

## 8. BFI Connector와 Triple-A 프로파일 시뮬레이터

Connector는 아키문서 §5-3 인터페이스를 TypeScript로 고정한다(플러그인 구조 — 수취국·기관 확장점):

```ts
interface BfiConnector {
  getQuote(corridor, amount, payoutMethod): Promise<BfiQuote>;
  sendTravelRule(paymentId, jwe, senderSig): Promise<{messageId}>;
  requestPayoutApproval(paymentId): Promise<SignedPayoutApproval>;   // 수취 USDC 주소+유효시간, BFI JWS
  notifySettlement(paymentId, txid, chainId): Promise<void>;
  onPayoutStatus(cb): void;                    // Webhook 수신 + 폴링 통합
  getSignerCertificates(): Promise<RegistryEntry>;
  dailyReconcile(date): Promise<SignedRecon>;  // R2
}
```

v1 구현체는 `TripleAProfileSim` 하나 — demo-partners의 HTTP API를 호출한다.
**demo-partners 내 BFI 로직**(Triple-A 프로파일, SG MPI 모의):

1. `/bfi/quotes` — USDC→SGD 레이트+수수료+만료 반환.
2. `/bfi/travel-rule` — JWE 복호 → IVMS101 필수필드 검증 → 수취인명 모의 제재리스트 대조
   → ACK(정상) / RFI(필드 누락) / REJECT(제재 적중, 데모 트리거: 수취인명에 `SANCTIONED` 포함).
3. `/bfi/payout-approval` — **거래별 USDC 수취주소** 발급 + 유효시간, `PAYOUT_ACCEPTED` JWS(키1) 반환.
4. USDC 수취 감시 — anvil `eth_getLogs`(Transfer 토픽, 수취주소) 폴링 → `USDC_RECEIVED` JWS.
5. FX 후 SG 수취은행 모듈에 지급지시 → `PAYOUT_SUBMITTED` JWS.
6. SG은행이 입금 참조번호 반환 → **`PAYOUT_COMPLETED` JWS에 `bank_reference`·`credited_at` 포함(L3)**
   → core Webhook으로 송신. (증거등급은 설정으로 L1/L2/L3 전환 가능 — 라스트마일 문서의 등급 비교 데모용)
7. 실패 주입: 설정/특수금액으로 `PAYOUT_FAILED` → USDC를 정산주체 주소로 반환 전송 → `USDC_RETURNED` JWS (R2).

---

## 9. USDC 정산 레일 — anvil + 정산주체 지갑 (운영모델 B)

- **체인**: anvil(`:8545`, chain_id 31337). setup 스크립트가 MockUSDC(ERC-20, 6 decimals) 배포 후
  정산주체 계정에 트레저리 민팅. **의존성 없는 연동**: anvil unlocked 계정의 `eth_sendTransaction` 사용
  (클라이언트측 서명·keccak 불필요), `transfer(address,uint256)` 셀렉터·Transfer 이벤트 토픽은 사전계산 상수,
  배포는 커밋된 컴파일 산출물 바이트코드로. ethers/foundry 런타임 의존 없음(anvil 바이너리만 필요).
- **정산주체 지갑**(demo-partners 키3): core는 `SETTLEMENT_INSTRUCTED`(승인 파생 지시: 금액·수취주소·payment_id)만
  보낸다. 지갑 서비스가 **화이트리스트(BFI 발급 주소)·한도 정책 검사 후 서명·전송** → 블록 확정 확인 →
  `USDC_TRANSFER_CONFIRMED { chain_id:'eip155:31337', tx_hash, block }` JWS 반환.
  "StoneHash는 기술 실행, 통제권은 정산주체"(운영모델 B)가 코드 구조로 드러나는 지점.
- **전송 지시는 payment_id당 1회**, 재시도는 TXID 조회 후에만(§8-3). memo는 ERC-20에 없으므로
  `settlementIdMemo`는 **커밋 방식**: 지시 JWS에 payment_id↔tx 바인딩(기존 ChainTransfer 모델의 주석 그대로).
- 폴백: `CHAIN_BACKEND=mock`이면 인메모리 원장으로 동일 인터페이스 구동(anvil 미설치 환경·CI용).

## 10. 마지막 구간 — SG 수취은행과 입금 확인

demo-partners 키2 = **SG 수취은행(FAST 모의)**: 수출업체 계좌 원장(`accounts.json`),
`/sgbank/credit` 수신 시 즉시 입금 + 참조번호(`FAST-20261110-XXXX`) 발급, 미니 UI로 **수출업체 통장 화면** 제공
— "실제로 입금됐다"를 데모에서 눈으로 확인하는 장치.

송금은행이 결과를 아는 경로는 라스트마일 문서의 결론 그대로:
**BFI → StoneHash(Webhook) → 은행 Adapter(Webhook) + GET 폴링 이중화**, 재전송 한계 후 pull 보완,
`PAYOUT_IN_PROGRESS`와 `BENEFICIARY_CREDIT_CONFIRMED` 분리, L3(참조번호+BFI 서명)일 때만 CREDIT_CONFIRMED.

---

## 11. Evidence Package — 기존 6축 엔진 재사용과 앵커링

**이번 설계의 중심 재사용.** 실거래에서 쌓인 `payment_events`를 기존 `SettlementEvidence`로 매핑해
샌드박스 화면과 **같은 엔진**(`attest-rules/engine.evaluate`)으로 판정한다.

| payment_events | → SettlementEvidence 요소 |
|---|---|
| FIAT_FUNDS_RECEIVED + PAYMENT_RELEASE_AUTHORIZED (은행 JWS) | `bankInstruction` + `bankApproval`(fxQuote=견적) |
| 인보이스 커밋(commercial_reference) | `commercialDocs` (digest, citedOnly 처리) |
| TRAVEL_RULE_SENT/ACK + PAYOUT_ACCEPTED (BFI JWS) | `travelRule` (ivms101Digest, approvalDigest, approvedBeneficiaryAddress, approvedAt) |
| USDC_TRANSFER_CONFIRMED (정산주체 JWS + 온체인) | `chainTransfer` (txRef, settlementIdMemo=지시 커밋) |
| PAYOUT_COMPLETED (BFI JWS, L등급, bank_reference) | `payoutReceipts[]` |

판정 통과(6축 MATCH) → `SETTLEMENT_RECONCILED`(플랫폼 JWS) → **Evidence Package 조립**
(아키문서 §7-3 `stonehash.payment-evidence.v1` 스키마: events[], reconciliation, attestation, registry snapshot)
→ 패키지 커밋을 **내부적으로 기존 attestation 생성 경로에 투입**(은행 org 소유로 콘솔에도 노출) →
기존 배치 머클 → regtest 앵커 → `EVIDENCE_ANCHORED` Webhook(§3 단계 15·16 분리 — 지급완료 통보를 앵커가 지연시키지 않음).

corridor 시나리오 P("트래블룰 승인 전 자금 방출")·Q·W·R은 이제 **실파이프라인 실패 주입**으로도 재현 가능
— 데모 각본상 기존 Lab(합성)과 신규 레일(실흐름)이 같은 판정 화면에서 만난다.

완전성(R2): `POST /v1/manifests/daily`(은행 JWS: date, payment_ids[], count, 합계) ↔ 플랫폼 정산목록 대사,
Manifest 커밋도 당일 배치에 앵커(아키문서 §7-4).

---

## 12. demo-bank 확장 — 수입업체 송금 시나리오

기존 문서 공증 탭은 유지하고 **"국경간 송금(무역대금)"** 탭을 추가. 두 퍼소나를 한 앱에서 전환:

1. **수입업체(송금인) 화면** — 회사 선택(예: 비나무역), 인보이스 등록(금액 SGD, 수출업체·SG계좌),
   VND 환산 견적 미리보기(플랫폼 `POST /v1/quotes` 경유), "송금 신청" 제출.
2. **은행 심사 화면** — 신청 큐에서 선택 → 체크리스트(KYB 확인·무역서류 심사·외환심사) 클릭 승인 →
   "VND 수납 기록" → **openssl HSM으로 `bank_authorization` JWS 서명**(기존 HSM 패턴 재사용) →
   `POST /v1/settlements` 제출. 요청 전문·서명 바이트를 기존 step UI 형식으로 투명 표시.
3. **진행 타임라인** — Webhook 수신(서명 검증 후 반영) + 3초 폴링 병행. 9상태 각 단계에 "누가 무엇에 서명했나" 카드.
   `PAYOUT_IN_PROGRESS`와 `BENEFICIARY_CREDIT_CONFIRMED`를 분리 표기, 증거등급 뱃지(L3 등).
4. **증빙** — Evidence Package 다운로드, 동봉 `attest-verify`로 **독립 재검증**(기존 bundle 검증 step과 동일 패턴),
   regtest 앵커 TXID 표시.

Adapter 책임(아키문서 §4-4 축약판): Idempotency Store(로컬 json), Evidence Signer(openssl),
Status Receiver(Webhook JWS 검증→타임라인), Evidence Verifier(로컬). Protocol Listener(TCP/MQ 전문)는 범위 외로 명시.

---

## 13. PoR 확장 — 거래소 준비금 증명

### 13-1. 산출 구조

- 새 패키지 `attest/packages/attest-por`: **머클 합 트리**(업계 표준형 — 노드 = `(hash, 자산별 합계 벡터)`,
  `hash = H(L.hash‖R.hash‖L.sums‖R.sums)`), 리프 = `H("STONEHASH-POR-LEAF-V1"‖salt‖user_ref_hash‖balances)`.
  잔고는 정수 최소단위 decimal 문자열(기존 `decimal.ts` 재사용). OKX/Binance 공개 방식과 비교 가능한 형태.
- 스냅샷 = 부채 트리 루트 + 자산별 총부채 + (선택) 준비금 측: 거래소 서명 주소·잔고 명세.
  샌드박스 v1 준비금은 **거래소 서명 선언문**으로 두고 `DEMO` 라벨(온체인 잔고 실측은 후속) — 솔벤시 비율 표시.
- 루트+메타를 **기존 attestation 경로로 앵커**(issuer=거래소 서명키, 콘솔·공개 verify 재사용).
- 검증: `attest-verify`에 `merkle-sum.ts` 추가 → playground에 **사용자 포함증명 검증 페이지**
  (user_ref+salt+잔고+proof 입력 → 루트 재계산 → 앵커 확인, 전부 브라우저/CLI 오프라인 가능).

### 13-2. API (스냅샷 세션)

```
POST /v1/por/snapshots                 {asof, assets[], mode}        → {id}
POST /v1/por/snapshots/{id}/liabilities  JSONL 청크(seq 멱등, {user_ref_hash, salt?, balances{...}})
POST /v1/por/snapshots/{id}/finalize   → 트리 구축, 루트 attestation 생성, 앵커 개시
GET  /v1/por/snapshots/{id}            → 루트, 총액, 리프 수, 앵커 상태
GET  /v1/por/snapshots/{id}/proofs/{leaf}  → 포함증명 (거래소가 사용자에게 배포)
```

```sql
CREATE TABLE por_snapshots (id TEXT PRIMARY KEY, org_id TEXT, asof TEXT, status TEXT,
  assets TEXT, root TEXT, totals TEXT, leaf_count INTEGER, attestation_id TEXT,
  ingest_mode TEXT, created_at TEXT);
-- 리프 원본은 스냅샷별 파일(.data/por/<id>.jsonl)로 보관(모드에 따라 미보관 가능), DB는 메타만.
```

### 13-3. 수신 방식 — 선택지 (★ 결정 필요)

| 안 | 방식 | 장점 | 단점 | 적합 |
|---|---|---|---|---|
| A | 콘솔 파일 업로드 (CSV/JSONL) | 즉시 데모 가능, 구현 최소 | 대용량·자동화 한계 | 데모·소규모 |
| **B** | **REST 스트리밍 push (위 API)** | 통합 현실성, 멱등·재개 가능, 데모·실용 겸장 | 거래소 잔고가 플랫폼에 노출 | **샌드박스 v1 권장** |
| **C** | **PoR SDK 로컬 트리** — 거래소가 SDK로 자체 트리 구축, **루트+총액+샘플 개봉만 제출** | 잔고·user 데이터가 밖으로 안 나감 — "원본은 원천기관에" 철학·attest-sign 패턴과 동일 | SDK 배포·검증 스팟체크 설계 필요 | **상용 목표형** |
| D | SFTP/오브젝트 스토리지 배치 pull | 엔터프라이즈 운영 관행 | 샌드박스 과잉 | 후순위 |

**권장: B를 v1로 구현하되, 리프 해시·트리 로직을 `attest-por` 패키지에 두어 C(SDK 모드)가 같은 코드의
재배포가 되도록 처음부터 분리**(attest-sign 타르볼 벤더링과 같은 공정). A는 B 위의 콘솔 편의 기능으로 덤.

### 13-4. 데모 구성

거래소 데모는 별도 앱 없이 **콘솔 PoR 페이지 + 합성 데이터 생성기**(1만 리프 샘플)로 시작.
필요 시 demo-exchange 앱은 후속. 공개 검증 페이지가 사용자측 데모를 담당.

---

## 14. 신규 모듈 배치

```
attest/apps/core/src/remit/   orchestrator.ts statemachine.ts quotes.ts ivms101.ts jwe.ts
                              bfi/{connector.ts, triplea-sim.ts} wallet-client.ts
                              webhook.ts evidence-map.ts manifest.ts routes.ts
attest/apps/core/src/por/     snapshots.ts routes.ts
attest/packages/attest-por/   sumtree.ts proofs.ts index.ts (+test)
attest/packages/attest-verify/src/merkle-sum.ts   (검증기 추가)
demo-partners/                server.mjs keys/{bfi,sgbank,wallet}.key chain/{anvil-client.mjs, musdc-artifact.json}
                              public/ (Triple-A 콘솔·SG통장 미니 UI) setup.mjs
demo-bank/                    (확장) remit UI + adapter 모듈 + webhook receiver
attest/deploy/                run-partners.sh anvil.sh (ecosystem.config.cjs에 프로세스 추가)
```

테스트: 기존 `pnpm -r test` 틀에 패키지별 node:test 추가. E2E 스모크 `deploy/smoke-remit.sh`
(견적→지시→…→앵커까지 1건 자동 주행 + 예외 3종).

## 15. 구현 단계

> **✅ R1 구현 완료 (2026-11-10)** — 아래 완료 기준 전부 실측 통과. 구현 노트는 §18.

| 단계 | 범위 | 완료 기준 |
|---|---|---|
| **R1 — 송금 해피패스 E2E** | 구독·Trust Registry, quotes/settlements, 상태머신(해피패스), TR 모드A+JWE, demo-partners(BFI·SG은행·지갑·anvil), Webhook+폴링, demo-bank 수입업체+심사 시나리오, 6축 대사+Evidence Package+앵커 | demo-bank에서 신청→승인→**SG 통장 입금 확인**→L3 증빙 다운로드·독립검증·regtest 앵커까지 클릭만으로 완주 |
| **R2 — 예외·완전성** | cancel, 견적만료, 멱등 충돌, RFI 왕복, BFI 거절, 지급실패→USDC 반환→RETURNED, L1/L2/L3 전환, 일별 Manifest+누락 탐지, 아키문서 §10-2 테스트 시나리오 전부 | 예외 각본이 demo-bank·partners UI에서 재현되고 증거에 남음 |
| **P1 — PoR v1** | attest-por 합 트리, 스냅샷 API(B안)+콘솔 업로드(A안), finalize→앵커, 포함증명·공개 검증 페이지 | 합성 1만 리프 스냅샷 앵커 + 브라우저 오프라인 포함증명 검증 |
| **P2 — 심화** | TR 모드 B(attest-sign 확장), PoR SDK 모드(C안), X.509·TSA, 준비금 온체인 실측 | — |

R1과 P1은 모듈이 겹치지 않아 병행 가능. 권장 순서는 R1 → P1 → R2 → P2
(송금 데모를 먼저 완성하고, PoR 골격을 올린 뒤 예외 각본 보강).

## 16. 가드레일 (표현·보안)

- 모든 화면·문서에 `Synthetic Demo` 라벨. "Triple-A 프로파일 모의 BFI", "FAST 모의" 등 모의임을 상시 표기.
- 실자금·실파트너 API 호출 없음. 제재검사는 데모 리스트. STR 관련 데이터는 어떤 형태로도 다루지 않음.
- 트래블룰 평문 미저장(digest·암호문만). 공개 원장에는 커밋만(기존 원칙 유지).
- HTTP 200 ≠ 송금 성공 — 모든 응답·UI는 상태머신 상태로만 결과를 말한다(아키문서 §4-1).

## 17. 결정 요청 (사용자)

1. **PoR 수신 방식**: ✅ 확정(2026-11-10) — C안(SDK 로컬 트리) 채택. 트리 로직은 `attest-por` 패키지로 분리해 SDK 재배포 형태로 제공.
2. **USDC 레일**: anvil 실체인(권장, foundry 설치 필요) vs 인메모리 mock만. 둘 다 구현하되 기본값 선택 필요.
3. **demo-partners 단일 프로세스**(키 3개 분리, 권장) vs 기관별 프로세스 분리.
4. 구현 착수 순서: R1부터 바로 진행해도 되는지.


---

## 18. R1 구현 노트 (2026-11-10 완료)

### 실제 배치
| 컴포넌트 | 위치 | 비고 |
|---|---|---|
| Remit 모듈 | `attest/apps/core/src/remit/` (sign·jwe·ivms101·quotes·registry·store·orchestrator·evidence·webhook·partners-client·routes·worker) | 코어 단일 프로세스에 탑재, `REMIT_ENABLED` |
| DB | `db.ts`에 remit 테이블 8종 추가 (additive) | subscriptions·institutions·remit_* |
| 파트너 사유지 | `demo-partners/` :3300 (pm2 `stonehash-partners`) | 키 3개 분리(bfi/sgbank/wallet) + BFI JWE 복호키 |
| 체인 | anvil :8545 (pm2 `stonehash-anvil`), MockUSDC solc 0.8.24 artifact 커밋 | `CHAIN_BACKEND=mock` 폴백 내장 |
| 은행 데모 | `demo-bank/remit.mjs` + `public/remit.{html,js,css}` | openssl HSM으로 요소 3종+승인 서명, Webhook 수신(서명검증)+폴링 병합 |
| 스모크 | `attest/deploy/smoke-remit.sh` | 구독→견적→지시→앵커→독립검증 자동 주행 |
| 기동 | `attest/deploy/run-partners.sh`, ecosystem.config.cjs에 anvil·partners 추가 | `pm2 save` 반영 |

### 설계 대비 확정 사항
- **서명 규약**: compact JWS 대신 기존 attest-rules 규약과 동일한 **도메인분리 + JCS + ES256 raw r‖s** 2종
  (`stonehash:evidence:sig:v1` 요소용 / `stonehash:remit:event:v1` 이벤트용). X.509·RFC7515 compact는 P2 유지.
- **증거 요소는 발행 기관이 직접 서명해 제출** — 은행은 `evidence_elements`(지시·외환승인·상업서류)를 요청에 동봉,
  BFI는 travelRule·payoutReceipt를, 정산주체는 chainTransfer를 이벤트에 동봉. 코어는 매핑·digest 재계산만 수행
  → 6축 issuer 축이 Trust Registry 공개키 기준 **진짜 VALID**.
- **단위계**: 무역은 USD 표시(정책상 USD≡USDC 1:1 그룹), VND 수납·SGD 지급은 견적 고정환율의 부속 필드로 요소에 내재
  (엔진 원칙 "환산은 엔진 밖에서" 준수). 영수증에 `local_amount/local_rate/quote_ref` 포함.
- **샌드박스 상한**: dataMode=SYNTHETIC 규칙상 `regulatoryMapping=REVIEW_REQUIRED`·`businessFinality=DEMO_ONLY`가 상한.
  확정 게이트는 나머지 4축 녹색 + 규제필드 누락 0건 + (샌드박스 허용) 두 상한 축으로 정의.
- **L3 강화**: payoutReceipt 안에 SG 수취은행 키가 서명한 `local_credit_confirmation`을 중첩 — BFI 전언이 아니라
  현지은행 자체 서명으로 입금을 증명.
- **구독 표면**: 콘솔 API(`/v1/console/products`)로 구현, 콘솔 UI 페이지는 R2. 은행 데모의 "구독 활성화" 버튼이 이 API를 호출.

### 실측 결과 (스모크)
- 상태머신: 접수→…→`BENEFICIARY_CREDIT_CONFIRMED`→`EVIDENCE_ANCHORED` 전진 전이, Webhook 11건 전부 플랫폼 서명 검증 통과.
- 체인: anvil 실 TX(ERC-20 Transfer 로그를 BFI가 자체 감시로 확인), regtest 앵커 TXID 확정.
- 은행측 독립 검증 4종 전부 통과: 커밋 재계산 / 요소 서명 6건 재검증 / 벤더링 엔진 6축 재판정 일치 / 앵커 번들 검증.
- 테스트: 워크스페이스 전체 typecheck 0 오류, 376+9 테스트 통과 (remit 단위테스트 9종 — RFC7518 KDF 벡터, JWE 왕복,
  골드패스 6축, 변조 검출, 상태머신 포함).

### R2로 넘긴 것
cancel/RFI/거절/지급실패→RETURNED 각본 UI, 일별 Manifest 완전성 대사, L1/L2/L3 전환 데모,
콘솔 Products UI, 모드 B(은행측 암호화), X.509/TSA. (PoR P1은 C안 — `attest-por` SDK 분리 설계로 진행 예정)


---

## 19. PoR P1 구현 노트 — C안 (2026-11-10 완료)

### 실제 배치
| 컴포넌트 | 위치 | 비고 |
|---|---|---|
| 검증 스펙(소유자=검증측) | `packages/attest-verify/src/merkle-sum.ts` | 리프/노드/빈노드 해시, `verifyPorInclusion`(루트+**자산별 총액 동시 바인딩**), 커밋. 동기·브라우저 공용 |
| SDK | `packages/attest-por` | `sumtree`(빌더는 검증측 함수를 import — 드리프트 불가), `snapshot`, `synth`, CLI(`synth·build·prove·open·verify-proof`) |
| 코어 API | `apps/core/src/por/routes.ts` + `por_snapshots` 테이블 | 제출→랜덤 8리프 챌린지→개봉 검증→VERIFIED→커밋을 기존 attestation 경로로 앵커. 공개 `GET /v1/public/por/snapshots/:id`(선언문+거래소서명+공개키+앵커번들) |
| 구독 | 콘솔 `POST /v1/console/products` product=`por` | 역할 EXCHANGE, 발행인 키 재사용 |
| 사용자 검증 | `playground/por.html` (+por.css/por.js) | 브라우저 오프라인 5체크: 거래소서명(WebCrypto)·포함증명·user_ref 대조·커밋 재계산·앵커 번들. CSP `style-src 'self'` 준수 |
| 스모크 | `attest/deploy/smoke-por.sh` | 프로비저닝→synth 10k→build→제출→챌린지→개봉→앵커→유저 오프라인 검증→공개자료 재검증 |

### 해시 스펙 (v1 고정)
- 리프 `SHA256("STONEHASH-POR-LEAF-V1\n"‖salt(32B)‖user_ref_hash‖JCS(balances))`, 잔고=음수 금지 정수 문자열(최소단위)
- 노드 `SHA256("STONEHASH-POR-NODE-V1\n"‖L.hash‖R.hash‖JCS(L.sums)‖JCS(R.sums))`, 합계는 BigInt 정밀
- 홀수 레벨 패딩=빈노드(`"STONEHASH-POR-EMPTY-V1"`, 합계 0) — **복제 패딩은 잔고 이중계상이라 금지**
- `user_ref_hash = SHA256("STONEHASH-POR-USER-V1\n"+exchange_id+"\n"+user_ref)`, salt=HMAC(마스터시드,user_ref)
- 선언문 커밋 `SHA256("STONEHASH-POR-V1\n"‖JCS(statement))` = 앵커 리프
- 리프는 user_ref_hash 정렬 → 동일 데이터=동일 루트(재현성)

### C안 경계 (코드로 강제됨)
밖으로 나가는 것: 선언문(루트·총액·파라미터)+서명, 챌린지된 8리프의 가명 개봉, 사용자 본인에게 주는 증명.
안 나가는 것: liabilities 파일, tree.json, seed.hex(0600), 그 외 전체 리프.
스팟체크 한계(전수 아님·8리프 가명 노출)는 공개 페이지와 코드 주석에 명시 — 완전성은 ZK 확장(P2)으로.

### 실측
10,000리프 빌드 336ms · 챌린지 8리프 검증·앵커 confirmed · 사용자 `verify-proof` root+totals MATCH ·
공개자료 재검증(커밋+번들 6체크) · 조작 개봉→`422 REJECTED`(루트 불일치 지목) · 워크스페이스 typecheck 0오류·전 테스트 통과(+attest-por 10종).

### P2로 넘긴 것
준비금 온체인 실측(선언문 `reserves`는 DECLARED_DEMO 슬롯만), 솔벤시 비율 화면, 콘솔 PoR UI,
ZK 완전성 증명, 대용량 트리 바이너리 포맷, SDK 타르볼 배포(attest-sign식 vendoring).


---

## 20. R2 + P2 구현 노트 (2026-11-10 완료) — 로드맵 종결

> **ZK 완전성 증명은 사용자 결정으로 로드맵에서 제외** (스팟체크 한계는 공개 페이지에 명시로 유지).
> 테스트 절차 전체는 `docs/TESTING-GUIDE.md`.

### R2 — 예외·완전성 (전부 구현·E2E 검증)
| 기능 | 구현 | 검증 |
|---|---|---|
| 재개형 파이프라인 | orchestrator.advance가 상태 기반으로 남은 leg만 실행 — RFI 정지·재개·재시작 안전 | smoke-exceptions ④ |
| RFI 왕복 | BFI RFI(고액≥2만 트리거) → `TRAVEL_RULE_RFI` 이벤트+웹훅 → 은행 서명 답변 `POST /v1/settlements/:id/rfi-response` → JWE 재송신 → ACK → 재개 | ④ 완주 |
| 취소 | `POST /v1/settlements/:id/cancel` — 사전승인 전(상태1~3), 은행 서명, BFI 통지로 사전승인 잔상 제거 | ⑤ |
| 지급실패→반환 | 트리거 *.13 → `PAYOUT_FAILED` → BFI가 예치주소에서 트레저리로 USDC 반환 tx → `USDC_RETURNED`(서명+tx) → `RETURNED` | ② |
| L1/L2/L3 | *.01/*.02 트리거. **L1은 실패가 아니라 `EVIDENCE_INSUFFICIENT`** — 확정 차단, PAYOUT_IN_PROGRESS 유지(구현가이드 §4.3·라스트마일 실행조건). L2=서명만(참조 없음) 확정 허용 | ③ + 유닛(무서명 영수증→issuer 축 UNKNOWN_ISSUER) |
| 일별 Manifest | `POST /v1/manifests/daily` — 은행 서명 목록 ↔ 플랫폼 목록 양방향 대조, 플랫폼 역서명, `STONEHASH-MANIFEST-V1` 커밋 앵커. remit_manifests UNIQUE(org,date) | ⑦ 누락 적발 + 스모크 우회거래 적발 |
| 트래블룰 모드 B | 은행측 IVMS101 구성+JWE 암호화(demo-bank 자체 구현=레퍼런스), 플랫폼은 암호문 중계+`fields_assertion`(은행 서명) 검증, BFI가 digest 대조·실질 검증 | ⑥ 완주 |
| demo-bank UI | 시나리오 셀렉터 6종, RFI 질의응답 패널, 취소 버튼, 반환/증거불충분 카드, Manifest 카드(누락 시뮬레이션), 모드B 토글+encrypt step | 수동+스모크 |

### P2 — PoR 심화 (구현분)
- **준비금 온체인 실측**: SDK `--reserves`(주소 선언, 잔고 미기재) → 개봉 검증 통과 시 코어가 `eth_call balanceOf` 실측(`POR_CHAIN_RPC`) → `MEASURED`/`DECLARED_ONLY`/`UNREACHABLE` 구분 → **솔벤시 커버리지**(자산별, bp 정밀) 저장·공개. 주소 *소유* 증명은 선언으로 명시(라이브 통제). 스모크: USDT 110% 펀딩→109.99% 실측.
- **공개 검증 페이지**: 솔벤시 표 추가(실측/미실측 구분 표기).
- **콘솔 UI**: `상품` 섹션 — 구독 현황, remit/por 활성화 폼(발행인 키 거버넌스 재사용), PoR 스냅샷 목록.

### 의도적으로 남긴 것 (실연동 단계 과제)
X.509 체인·RFC3161 TSA(현재 SPKI 레지스트리), 준비금 주소 소유서명, PoR SDK 타르볼 배포 공정, 대용량 트리 바이너리 포맷, 분할지급 정책. ZK는 제외 확정.


---

## 21. 상품·빌링 표면 (2026-11-11)

**상품 구조 확정**: Attest Core=수평 인프라(월 구독+앵커 종량) · PoR=Attest 수직(스냅샷 주기 구독) · 송금=독립 솔루션(건당+bps, **Evidence Included**). 솔루션 내재 앵커는 완전 내재(별도 계량 없음) — 선례: Twilio Verify/S3-KMS/Stripe Radar 패턴.

**구현**:
- `attestations.product`('attest'|'remit'|'por') — svc.issue 옵션으로 스탬프, 기존 행은 descriptor kind로 1회 백필. 콘솔 쿼터는 `product='attest'`만 계산(솔루션 발행분 쿼터 불침범이 코드로 강제).
- `GET /v1/console/products`에 `billing` 블록: 상품별 과금 축 + 당월 사용량(attest used/quota, remit settlements+included_anchors, por snapshots+included_anchors).
- 콘솔 상품 섹션에 "플랜·이번 달 사용량" 카드.
- 홈페이지 `/pricing` (라우트+페이지+ko/en 33키+헤더·푸터 링크): 과금 철학("검증 무료, 발행 과금"), 4카드, 원칙 3개(포함은 포함/검증 무과금/증빙은 구독보다 오래감), 라이브 요율은 파일럿 협의 — **숫자 미게시는 의도**(미확정 요율 날조 금지, 확정 시 translations의 pricing.* 에 기입). 상단 네비 정책 테스트를 "Company 단독→Pricing+Company"로 의도 변경.


## 22. 저장계층 — MySQL 전환 (2026-11-11)

**결정**: 샌드박스=상용 동일 모듈(유료상품)이므로 기록되는 모든 것(앵커·계정·송금·PoR)을 MySQL 8.0(InnoDB, utf8mb4_bin)에 저장. SQLite는 단위테스트 전용 폴백.

**구조** (`apps/core/src/db.ts` 단일 파일):
- 동형 async 인터페이스 `Db { prepare(sql).get/all/run, exec, tx(fn), dialect }` — 기존 호출부 모양 유지, 전면 async화(16파일).
- 어댑터 2종: `MysqlDb`(mysql2 풀, tx는 전용 커넥션) · `SqliteDb`(단일 프라미스 체인 직렬화 — async tx 중 타 요청 문장이 열린 트랜잭션에 끼어드는 위험을 구조로 차단).
- 선택: `STONEHASH_DB_URL=mysql://…` 있으면 MySQL, 없으면 `dbPath` SQLite.

**방언 차이의 위치** — 어댑터가 숨기지 않고 호출부에서 분기(가시성):
| 항목 | SQLite | MySQL |
|---|---|---|
| upsert(manifest) | ON CONFLICT … DO UPDATE excluded.* | INSERT … AS new ON DUPLICATE KEY UPDATE new.* |
| 중복무시(구독) | ON CONFLICT DO NOTHING | INSERT IGNORE |
| idempotency | REPLACE INTO (공통 철자) | 동일 |
| 삽입순서 | rowid | attestations.rowseq BIGINT AUTO_INCREMENT (`insertionOrder(db)`) — 어댑터가 SELECT 결과에서 rowseq 제거(API 누설 방지) |
| partial index | 유지 | (predicate, col) 복합 인덱스로 변환, IF NOT EXISTS 없어 information_schema로 존재확인 |
| TEXT DEFAULT | 리터럴 | 불가 → descriptor/config/authority는 INSERT가 항상 공급 |
| 타입 | TEXT/INTEGER | id·해시·enum·시각=VARCHAR/CHAR(인덱스 가능), 페이로드=MEDIUMTEXT, CHECK(leaf 64) 유지 |

**검증**: 전 스위트 398/0 (core 127 = 기존 121 + `mysql-parity` 6: 부트스트랩·rowseq 위생·tx 롤백·REPLACE·키셋 페이징을 stonehash_test_* 실서버에서). 스모크 3종(해피·예외7·PoR 1만리프) MySQL 경로 통과. 데이터 이관 293행 전 테이블 카운트+삽입순서 일치.

**송금 검색·페이징**: `RemitStore.search` — (created_at,id) 키셋 커서(opaque base64url), UPPER LIKE(양 엔진 대소문자 정책 통일), limit+1 선읽기로 has_more, COUNT는 커서 제외 필터 기준. 인덱스 `remit_payments_org_state(org_id,state,created_at)`. 콘솔·SDK·openapi 반영.

## 23. PoR 수신 기본값 변경 — 루트만 받아 앵커링 (2026-11-16)

**결정(소유자, 2026-11-16).** 거래소는 계정 단위 데이터를 밖으로 내보내지 않는다는
현실을 기준으로, 기본 제출은 **서명된 선언문만** 받아 곧바로 앵커링한다. 무작위 표본
확인(8개 리프 개봉)은 거래소가 요청할 때만 수행하는 선택 기능으로 남긴다. §17의
"루트 + 총액 + 표본 개봉"(2026-11-10)은 이 결정으로 대체된다.

- `POST /v1/por/snapshots` — `spot_check` 생략·false: 서명·형식 확인 후 즉시 발행,
  상태 `ACCEPTED`. 같은 선언문 재제출은 기존 기록을 `already: true`로 돌려줌.
  `spot_check: true`: 종전대로 `CHALLENGED` → 개봉 → `VERIFIED`.
- 공개 자료에 `spot_check`, `platform_checks`, `verified_sampling.sampled`(표본 확인이
  없으면 0)를 실어, 보지 않은 표본을 본 것처럼 말하지 않는다. 공개 검증 페이지도
  스냅샷마다 플랫폼이 확인한 범위를 표시한다.
- 스키마 변경 없음: `challenge` 열에 `{"spot_check":false,"indices":[]}` 저장.

**SDK(고객 측) 확장.** 구 SaaS(`bitcert-attest-module`)는 CSV 업로드·DB 접속으로
플랫폼이 트리를 만들었다. 그 수신 로직(헤더 기준 CSV 검증, 가로형→세로형, 정수 전용
파싱)만 고객 측 SDK로 옮기고, 트리 형식은 기존 `merkle-sum-sha256-v1`을 유지한다.
(2026-11-17 갱신: 그 뒤 보유한 잔고만 적는 `merkle-sum-sha256-v2`를 기본 형식으로 추가했고,
잔고 파일은 세로형·가로형·자산별 잔고/부채 열 CSV와 계정 배열 JSON 네 형태를 받는다. v1은 계속
접수·검증된다. 배경과 실측은 `docs/POR-REFERENCE-ANALYSIS.md`.)

- `check` / `build --csv`: 세로형·가로형 CSV, 금액 표기(`--amounts decimal|base`)는
  필수, 정확 변환 아니면 거부, 문제 있는 파일로는 아무것도 만들지 않음.
- `sign` → `submission.json`(전송되는 전부) → `submit`(`--spot-check`, `--wait`) →
  `receipt.json`. `status`로 플랫폼 보관 내용 조회.
- 비공개 파일은 `leaves.jsonl` + `seed.hex` + `tree.json`(헤더). 트리는 저장하지 않고
  리프에서 다시 만들며, 기록된 루트와 다르면 증명 발급을 거부한다.
- DB 직접 접속은 넣지 않음: 고객이 자기 DB 클라이언트로 CSV를 내보내고, 허브
  가이드와 `samples/export-queries.sql`이 쿼리 예시를 제공한다.

**확인된 규모와 한계.** 계정 100만·자산 3종: 빌드 60초, 최대 메모리 2.8GB. 모든
노드가 자산마다 합계를 들고 있어 메모리가 계정 수 × 자산 수에 비례한다 — 기본
설정에서 자산 30종이면 약 29만, 100종이면 약 10만, 300종이면 약 3.5만 계정.
자산 수백 종·계정 수십만 이상의 원장은 트리 저장 구조(노드별 희소 합계)를 다시
설계해야 하며 이번 범위 밖이다.
