# 송금 레일 인계 메모

- **상태:** 2026-11-18 작성. 송금 세션(`c7`)이 Java 전환 실행 세션(`a7`)에 넘깁니다.
- **무엇을 위한 문서인가:** 코드만 읽어서는 알 수 없는 것 — 규칙의 이유, 겪은 결함, 약속, 손대면 안 되는 자리.
- **기준:** 이 메모와 코드가 `JAVA-BACKEND-MIGRATION.md` 4장의 송금 목록과 다르면 이 메모와 코드를 따릅니다.
- **운영 중인 코드:** `attest/apps/core/src/remit/` (TypeScript). 코어는 2026-11-18 06:02:18Z에 마지막으로 재시작했고, 아래 규칙이 샌드박스에 그대로 살아 있습니다.

---

## 1. 규칙과 그 이유

### 1.1 전문 하나에 송금 하나

**무엇을 막는가.** 은행이 SWIFT 전문(MT103 · pacs.008 · pain.001)으로 지급지시를 만들 때, 같은 지급이
두 번 송금되는 것. 그리고 그 반대 — 같아 보이는 다른 지급이 "이미 지급됨"으로 답해져 지급되지 않는 것.
둘 다 실제로 재현된 결함입니다(아래 "겪은 결함").

**왜 플랫폼이 판정하는가.** SDK는 "원장에 이미 있는가"를 미리 볼 수는 있지만, 두 요청이 같은 순간에
오면 둘 다 "없음"을 봅니다. 접수 시점에, 한 트랜잭션 안에서 판정해야만 막을 수 있습니다. SDK의 사전
확인은 빠른 답을 위한 것이고, 송금이 둘이 되지 않게 하는 것은 플랫폼입니다.

**은행이 서명해 넣는 참조** — `evidence_elements.bankInstruction.sourceMessage`:

| 필드 | 뜻 | 플랫폼이 읽는 방식 (`sourceRefOf`) |
|---|---|---|
| `type` | `MT103`, `pacs.008.001.08` … | 필수, 40자 이내 |
| `sha256` | 은행 시스템이 쓴 파일 바이트의 SHA-256 | 필수, 64 hex, 소문자로 |
| `index` | 여러 건이 든 파일 안의 순번(0부터) | 없으면 0, 정수 0..1,000,000 |
| `uetr` | UETR | UUID여야 함, 소문자로 |
| `messageId` `instructionId` `endToEndId` | 전문의 식별자 | 256자 이내, 앞뒤 공백 제거. `endToEndId`의 `NOTPROVIDED`·`NONREF`·`NOREF`(대소문자 무시)는 "없음" |
| `valueDate` | 결제일 | 달력에 있는 `YYYY-MM-DD`만. 다른 형식은 거절 |
| `content` | 지급 내용 다이제스트(SDK가 계산) | 64 hex, 소문자로. 플랫폼은 비교만 함 |

형식이 틀린 값은 적힌 대로 받지 않고 `400 invalid_source_message`로 거절합니다. 느슨하게 받으면 같은
참조가 다르게 적혔을 때 중복 판정을 그대로 통과하기 때문입니다(예: `20261117`과 `2026-11-17`).

**DB에 저장되는 해시의 정확한 입력** (Java가 그대로 재현해야 기존 행과 맞습니다):

- 쌍둥이 키(`remit_source_refs.twin_key`) — `content`가 없으면 키 없음(NULL). 있으면:
  - `instructionId` 또는 `endToEndId`가 있으면
    `SHA-256( JSON.stringify(['stonehash:remit:twin:v1', instructionId, endToEndId, valueDate, content]) )`
  - 둘 다 없고 `messageId`가 있으면
    `SHA-256( JSON.stringify(['stonehash:remit:twin-by-message:v1', type, messageId, index, valueDate, content]) )`
  - 그 밖에는 키 없음.
  - 입력값은 위 표의 정규화를 거친 값입니다: 식별자는 trim한 문자열(없으면 `""`), `endToEndId`의
    "없음" 단어는 `""`, `valueDate`는 없으면 `""`, `content`는 소문자 hex, `index`는 **숫자**(따옴표 없음),
    `type`은 적힌 그대로.
  - JCS가 아니라 JavaScript `JSON.stringify`의 바이트입니다: 배열, 구분자 뒤 공백 없음, 문자열은
    JSON 이스케이프(`"`, `\`, 제어문자는 `\uXXXX` 소문자 hex, 그 밖의 비ASCII 문자는 그대로 UTF-8).
    `Json.canonical`로 만들면 배열에서는 같은 바이트가 나오지만, 반쪽 서로게이트 처리 등 가장자리는
    확인이 필요합니다.
- 멱등 요청 해시(`remit_idempotency.request_hash`) — `sha256hex(JSON.stringify(body))`. 요청 본문을
  파싱한 객체를 **키 순서 그대로** 다시 직렬화한 바이트입니다. 같은 지시라도 키 순서가 다르면 다른
  해시가 되어 `409 idempotency_conflict`가 납니다(RR-20). Java에서 이 값을 재현하려면 본문의 키
  순서를 보존하는 파서를 써야 합니다. 전환 시점에 이 표를 비우는 편이 간단합니다 — 저장되는 것은
  202 응답뿐이고, 재시도 창(견적 유효 10분)이 지나면 쓸모가 없습니다.

**표** (`db.ts`, 두 엔진 모두):

- `remit_source_refs(payment_id PK, org_id, message_type, sha256, idx, uetr NULL, value_date NULL, content NULL, twin_key NULL, created_at)`
  — UNIQUE `(org_id, uetr)`, UNIQUE `(org_id, sha256, idx)`, INDEX `(org_id, twin_key)`, INDEX `(org_id, content)`.
  전문에서 만들어진 송금 하나에 행 하나. 자체 데이터로 만든 송금은 행이 없습니다.
- `remit_source_matches(org_id, sha256, idx → payment_id, created_at)` — PK `(org_id, sha256, idx)`,
  INDEX `(org_id, payment_id, sha256)`. "이 파일의 이 거래는 이 송금으로 인식됐다"는 기록.

**판정 순서** (`store.ts` `sourceConflict`, 조직 안에서, 먼저 해당하는 것이 결정):

1. 같은 `sha256` + `idx`의 행 → 같은 지급. `duplicate_source_message`, ground `message`.
   (내용 다이제스트가 달라도 같은 지급입니다 — SDK 판이 달라 같은 바이트를 다르게 읽은 경우.)
2. 이 `(sha256, idx)`에 대한 인식 기록 → 그때의 송금. ground `twin`.
3. 새 전문에 UETR이 있고 그 UETR의 행이 있음 → 같은 파일의 다른 순번이거나 양쪽 `content`가 있는데
   다르면 `reference_reused`(ground `uetr`). 아니면 `duplicate_source_message` ground `uetr` + 인식 기록.
4. 쌍둥이 키가 같고 `sha256`이 다른 행 가운데 — 새 전문에 UETR이 있으면 UETR 없는 행만 — **새 전문과
   같은 파일의 다른 거래가 이미 인식된 송금은 빼고** 가장 오래된 것(`created_at`, `payment_id` 순).
   - 새 전문에 결제일이 없으면: 거절하되 인식은 아님. ground `twin_undated`, 기록 없음.
   - 있으면: ground `twin`, 인식 기록, 그리고 새 전문에 UETR이 있으면 그 행이 그 UETR을 가짐.
5. 충돌 없음 → 송금 행과 참조 행을 넣음.

서로 다른 UETR 둘은 언제나 두 지급이고, 한 파일의 두 거래도 언제나 두 지급입니다.

4번의 "가장 오래된 것"은 형제가 차지하지 않은 것 가운데서입니다. 그래서 송금이 여럿 얽힌 순서에서는
409가 가장 오래된 송금이 아니라 나중 송금을 가리키고, 그 송금이 UETR을 이어받기도 합니다. 예:
같은 내용의 두 거래가 든 파일 F(UETR 없음)로 F0·F1이 서 있고, 재출력본 F'의 0번이 F0으로 인식된 뒤,
F'의 1번이 UETR을 달고 오면 → F0은 형제가 차지했으므로 F1이 쌍둥이이고 F1이 그 UETR을 가집니다.
규칙대로이며, 플랫폼의 실제 store와 Java 대역이 같은 답을 냅니다(a7 확인) — Java 백엔드의 테스트로
그대로 쓰십시오.

**왜 4번이 이렇게 복잡한가.** 처음 구현은 쌍둥이를 "가장 오래된 송금"에 다대일로 붙였습니다. 그러면
같은 내용의 분할 지급 2건이 든 파일에서 첫 건만 나간 뒤 파일을 재출력해 보내면, 둘째 건이 첫 건의
쌍둥이로 거절되고 SDK가 "이미 지급됨"으로 답합니다 — 지급 누락. 그래서 인식을 기록하고, 같은 파일의
형제 거래가 이미 차지한 송금은 후보에서 뺍니다(1:1). UETR 승계도 같은 이유입니다: UETR 없는 송금
하나에 서로 다른 UETR의 지급 둘이 모두 쌍둥이로 붙던 것을, 처음 인식된 UETR이 그 송금의 것이
되게 해 막습니다.

**트랜잭션** (`asSourceWriter` → `createFromMessage`):

1. MySQL: `SELECT id FROM orgs WHERE id = ? FOR UPDATE` — **트랜잭션의 첫 문장이어야 합니다.**
   REPEATABLE READ에서는 첫 일반 SELECT에서 스냅샷이 잡히므로, 잠금보다 먼저 일반 SELECT를 하면
   앞선 요청이 커밋한 행을 보지 못합니다. 이 순서 덕에 격리수준과 무관하게 맞습니다(READ COMMITTED로
   바꿔도 됨). SQLite는 트랜잭션 본문이 큐에서 혼자 돕니다.
2. `payment_id`가 이미 있으면 → `409 duplicate_payment`.
3. 위 판정. 충돌이면 아무것도 만들지 않고(인식 기록 · UETR 승계는 커밋됨) 409.
4. `remit_payments` INSERT → `remit_source_refs` INSERT.
5. 같은 트랜잭션 안에서 첫 이벤트 셋(`REQUEST_ACCEPTED`, `BANK_EVIDENCE_SUBMITTED`,
   `BANK_AUTHORIZATION_VERIFIED`)과 `BANK_AUTHORIZED` 전이(`born` 콜백). 이것을 따로 하면, 경합에서 진
   요청이 "증거 이벤트가 아직 없는 송금"을 읽고 다른 지급으로 오판합니다(실샌드박스에서 재현).
6. 그 밖의 중복 키 오류는 `409 duplicate_payment`로 답합니다(`isDuplicateKeyError`).

**거절 문구** (`orchestrator.ts` `sourceConflictError`; 본문에 `existing_payment_id`, `ground` 포함):

- `reference_reused`: `UETR <uetr> is already on settlement <id>, which is a different payment — its amount, parties, accounts or identifiers differ, or it is another transaction of the same file. Nothing was accepted. A UETR names one payment: give this one its own`
- `duplicate_source_message` (ground `twin_undated`): `this payment cannot be told from settlement <id>: the same identifiers and the same content, and the message states no value date to tell two payments apart. Nothing was accepted. If it is that payment, read its state with GET /v1/settlements/<id>; if it is another one, give it a reference of its own — another instruction or end-to-end identifier`
- `duplicate_source_message` (그 밖): `this message's payment is already settlement <id> — <근거>. Nothing was accepted; read its state with GET /v1/settlements/<id> instead of sending it again` — 근거는
  `the same UETR (<uetr>)` / `the same transaction of the same message` /
  `the same identifiers, the same value date and the same content, in another message`. ground가 `twin`이면
  끝에 `. If it is meant as another payment, give it a reference of its own — another instruction or end-to-end identifier`.
- `duplicate_payment`: `payment_id <id> already exists — if this is a retry, read its state with GET /v1/settlements/<id> instead of resending; a new instruction needs a new payment_id`

**조회.** `GET /v1/settlements?source_uetr=` / `?source_content=`(`&source_value_date=`) — `remit_source_refs`의
행으로 답하는 정확 일치 조회(승계한 UETR 포함). 형식 오류는 `400 invalid_source_lookup`. 정렬은 목록과
같이 최신순, `limit`·`cursor` 그대로. SDK는 `source_uetr`만 씁니다(아래 1.2).

**backfill** (`backfillSourceRefs`, 코어 시작 때마다):

- 표가 생기기 전의 송금에서 서명된 참조를 읽어 자리를 줍니다. 옛 참조는 너그럽게 읽습니다
  (`legacySourceRefOf`): 읽을 수 있는 UETR·다이제스트·날짜는 살리고, 파일 다이제스트를 못 읽으면
  `sha256('stonehash:remit:legacy-source:' + payment_id)`를 씁니다.
- 같은 전문의 옛 송금이 둘이면 취소·반환·정지가 아닌 쪽이 먼저, 그다음 오래된 쪽이 자리를 가집니다.
  진 쪽은 행이 없습니다(원장에는 남고, 조회·판정의 대상이 아닐 뿐).
- 쌍둥이 키가 없는 기존 행은 다시 계산합니다(rekey).
- **운영 DB에서 한 일:** 04:41Z 첫 실행에서 송금 157건 중 참조가 있는 58건이 모두 자리를 받음
  (중복 0, 못 읽은 것 0, 실패 0). 이후 실행은 대상 0건. 2026-11-17의 시험 송금 13건은 `content`가
  없어 쌍둥이 키가 없습니다(그날의 SDK는 다이제스트를 넣지 않았음) — 같은 파일·같은 UETR로만 인식됩니다.
- **전환 직전 점검** — backfill을 Java 부팅으로 옮기지 않으므로, 넘기기 전에 남은 대상이 0건인지 확인:

  ```sql
  SELECT COUNT(*) FROM remit_payments p
    JOIN remit_events e ON e.payment_id = p.id AND e.type = 'BANK_EVIDENCE_SUBMITTED'
   WHERE e.payload LIKE '%"sourceMessage"%'
     AND NOT EXISTS (SELECT 1 FROM remit_source_refs r WHERE r.payment_id = p.id);
  ```

  0이 아니면 그 행들은 "같은 전문의 다른 송금이 자리를 가진 옛 중복"이거나 실패한 행입니다. 코어 로그의
  `remit source references…` 줄에 `duplicates`·`failed`·`failures`가 찍힙니다. 중복은 그대로 두면
  되고(운영 DB에는 현재 없음), `failed`가 있으면 그 송금의 참조를 손으로 확인해야 합니다.

**알려진 한계 (고치지 않은 것, 의도):**

- **내용 다이제스트의 판.** `content`는 SDK의 판독 결과로 계산합니다(`stonehash:swift:content:v1`:
  지시·결제·기준 금액, 양 당사자의 이름과 계좌, InstrId·EndToEndId·TxId, 인보이스 참조, 송금 정보).
  리더 수정이 어떤 필드의 판독을 바꾸면 같은 전문의 다이제스트가 바뀝니다 — 오늘의 보강에서도
  바뀐 입력이 있습니다(예: 50K 첫 줄 `/C/…`의 계좌). 같은 파일이면 1번 근거로 여전히 같은 지급이지만,
  재출력본은 "같은 UETR, 다른 내용"(`reference_reused`)이 되거나 쌍둥이로 인식되지 않습니다.
  **출시 뒤에는 다이제스트 판을 올리지 않는 판독 변경을 금지해야 합니다.**
- 식별자도 전문번호도 UETR도 없는 지급은 인식하지 않습니다(근거가 없음).
- MT103과 그 ISO 번역본을 둘 다 보내는 경우: UETR이 같고 내용 다이제스트가 다르면
  `reference_reused`입니다(이름 표기가 달라지므로). 지급은 막히지만 안내 문구는 맞지 않습니다.
- 취소·반환·정지로 끝난 송금도 전문의 자리를 계속 가집니다. 다시 지급하려면 다른 지시번호나
  End-to-end ID를 가진 새 전문이어야 합니다(새 UETR만으로는 UETR 있는 송금과만 구분됨).
- `payment_id`는 전역 PK입니다. 다른 조직의 id와도 충돌하고, 그때 `409 duplicate_payment`로 존재가
  드러납니다. 테넌트 범위로 바꿔야 합니다.

### 1.2 식별자와 참조

- `payment_id`: `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$`, 예약어 `reconcile`·`bundle` 제외(`400 invalid_payment_id`).
- SDK가 전문에서 만드는 id는 23자 `PAY-<8>-<10>` — 콘솔 원장의 열 너비가 이 길이에 맞춰져 있습니다.
  UETR이 있으면 `PAY-<UETR 첫 8자>-<sha256(기관\nuetr|<uetr>) 앞 10자>`. 없으면
  `ids|type|msgId|instrId|e2e|valueDate|(#index)`의 해시(파일 안에서 식별자가 겹칠 때만 `#index`).
  날짜·작성시각은 들어가지 않습니다 — 재출력해도 같은 id가 되어야 하기 때문입니다.
  **2026-11-18부터 `e2e` 자리는 `NOTPROVIDED`·`NONREF`·`NOREF`·빈 값이면 `''`입니다**(그전에는 원문).
  이전 id로 만들어진 송금은 플랫폼의 쌍둥이 판정(전문번호 근거)과 1번 근거로 인식됩니다.
- 명시한 `paymentId`는 이름일 뿐입니다. 이미 송금이 있는 전문으로 두 번째 지급을 만들지 못합니다.
  단 UETR이 없고 "같은 식별자, 다른 내용"인 경우에는 명시 id가 "별개 지급"이라는 선언으로 통합니다
  (은행이 자기 번호를 다시 쓰는 경우; 플랫폼도 내용이 다르면 쌍둥이로 보지 않음).
- **SDK의 사전 확인은 세 가지뿐입니다**: 자기 id의 송금, (명시 id일 때) 파생 id의 송금, UETR을 가진
  송금. `source_content` 조회로 쌍둥이를 고르지 않습니다 — 같아 보이는 송금 여럿 가운데 하나를 SDK가
  고르면 위의 지급 누락이 SDK 쪽에서 다시 생깁니다. 나머지는 POST 뒤 409의 `existing_payment_id`를
  그대로 답으로 씁니다(`ground`가 `twin_undated`일 때만 예외로 오류를 그대로 전달).
  견적 1회와 서명 1회가 버려지는 비용이 듭니다.
- `bankInstruction.ref`는 `payment_id`여야 합니다(`400 evidence_inconsistent`).
- `Idempotency-Key`: 8자 이상 필수. 202 응답만 저장합니다. 거절은 저장하지 않으므로 같은 키로 다시
  보내면 다시 판정합니다. SDK의 키는 `swift-<payment_id>`.

### 1.3 금액

- 금액은 전 구간 십진 문자열입니다. 견적 산술은 고정소수 문자열 연산(`quotes.ts` `mulDecimal`,
  `addDecimal`)이고 부동소수는 쓰지 않습니다. SDK의 비교도 자릿수 비교(`compareDecimal`)입니다.
- 지급지시의 `amount.collected`·`amount.payout`은 견적의 통화와 값을 **문자열로 정확히** 되풀이해야
  합니다(`400 amount_mismatch`). `bankInstruction.amount`는 견적의 `trade.amount`, 통화는 `USD`
  (`400 evidence_inconsistent`).
- 샌드박스 경로는 VN → SG, 거래 통화 USD, 수납 VND, 지급 SGD뿐입니다(`400 unsupported_corridor`,
  `unsupported_trade_currency`, `unsupported_leg_currency`, `invalid_amount`). 견적 유효 10분
  (`REMIT_QUOTE_TTL_MS`), 수수료 `REMIT_FEE_USD`(기본 25.00).
- 전문의 금액 판독(SDK): MT의 쉼표는 소수점, XML의 쉼표는 거절. 지시 금액과 결제 금액이 둘 다 USD면
  작은 쪽. 15자리·소수 5자리까지.

### 1.4 거절 사유와 오류 코드

접수(`POST /v1/settlements`)의 검사 순서: Idempotency-Key → `payment_id` 형식 → id 중복(409) → 견적
(없음 400 · 만료 409) → 금액 → 수취기관(등록 · 역할 · 암호화 키) → 은행 승인 서명 → 트래블룰
(모드 A 필수 항목 / 모드 B 암호문 · digest · fields_assertion) → 증거요소 3건 서명 → 금액 · ref 일치
→ 전문 참조 형식(400) → 트랜잭션(id 재확인 · 전문 중복 판정 · 생성).

| 코드 | 상태 | 어디서 |
|---|---|---|
| `missing_idempotency_key`, `invalid_payment_id`, `missing_field`, `invalid_json` | 400 | 접수 앞단 |
| `quote_not_found` / `quote_expired` | 400 / 409 | 견적 |
| `amount_mismatch`, `evidence_inconsistent` | 400 | 금액 · ref |
| `unknown_beneficiary_institution` / `bfi_has_no_encryption_key` | 400 / 502 | 수취기관 |
| `invalid_signature`, `invalid_evidence_signature`, `missing_evidence_element` | 400 | 서명 |
| `travel_rule_incomplete`, `invalid_fields_assertion` | 400 | 트래블룰 |
| `invalid_source_message` | 400 | 전문 참조 형식 |
| `duplicate_payment`, `idempotency_conflict`, `duplicate_source_message`, `reference_reused` | 409 | 중복 |
| `subscription_required`, `institution_unregistered` | 403 | 구독 · 기관 |
| `payment_not_found` | 404 | 조회 · 취소 · 답변 · 콜백 |
| `not_cancellable`, `wrong_state`, `no_rfi`, `already_resolved` | 409 | 취소 · RFI 답변 |
| `invalid_state`, `invalid_cursor`, `invalid_source_lookup` | 400 | 목록 |
| `invalid_manifest` | 400 | 일별 대사 |
| `unknown_callback_type`, `unknown_signer`, `role_mismatch` | 400 | 콜백 |
| `evidence_not_ready`, `no_chain_tx` | 409 / 404 | 증빙 · 체인 조회 |
| `invalid_transition` | 500 | 상태 전이 위반(프로그래밍 오류로 취급) |

오류 본문은 `{ error, message }`이고, 전문 중복 거절에만 `existing_payment_id`, `ground`가 더 있습니다
(`ServiceError.detail` → `http/routes.ts` 오류 매퍼).

---

## 2. 상태 기계

**상태** (`store.ts` `REMIT_STATES`, 이 순서로만 전진):
`REQUEST_ACCEPTED` → `BANK_AUTHORIZED` → `TRAVEL_RULE_PENDING` → `PAYOUT_PRE_APPROVED` →
`ONCHAIN_SETTLED` → `PAYOUT_IN_PROGRESS` → `BENEFICIARY_CREDIT_CONFIRMED` → `EVIDENCE_ANCHORED`.
종결 예외 상태: `CANCELLED`, `RETURNED`, `EXCEPTION` — 살아 있는 어느 상태에서든 갈 수 있고, 나올 수
없습니다. `EVIDENCE_ANCHORED`도 끝입니다.

| 전이 | 누가 | 무엇이 일어나야 |
|---|---|---|
| (없음) → `BANK_AUTHORIZED` | API `POST /v1/settlements` | 접수 트랜잭션. `REQUEST_ACCEPTED`는 행이 생기는 순간의 값이고 같은 트랜잭션에서 넘어감 |
| → `TRAVEL_RULE_PENDING` | `advance()`의 트래블룰 구간 | `TRAVEL_RULE_SENT` 기록 뒤 전이, 그다음 수취기관 호출 |
| `TRAVEL_RULE_PENDING`에 머묾 | 수취기관 응답 RFI | `TRAVEL_RULE_RFI` 이벤트. 은행의 `rfi-response`를 기다림(기한 없음) |
| → `CANCELLED` | 수취기관 거절(트래블룰 · RFI 답변) | `TRAVEL_RULE_REJECTED` |
| → `CANCELLED` | API `cancel` | `REQUEST_ACCEPTED`·`BANK_AUTHORIZED`·`TRAVEL_RULE_PENDING`에서만. 은행 서명 필요 |
| → `PAYOUT_PRE_APPROVED` | `advance()`의 승인 구간 | `TRAVEL_RULE_RECEIVED`가 있어야 진행. 수취기관의 서명된 승인(`PAYOUT_ACCEPTED`)과 입금 주소 |
| → `ONCHAIN_SETTLED` | `advance()`의 전송 구간 | `SETTLEMENT_INSTRUCTED` 기록 → 지갑 전송 → `USDC_TRANSFER_CONFIRMED` |
| → `PAYOUT_IN_PROGRESS` | 수취기관 콜백 `USDC_RECEIVED` | |
| (상태 그대로) | 콜백 `PAYOUT_SUBMITTED`, `PAYOUT_FAILED` | 이벤트와 웹훅만 |
| → `BENEFICIARY_CREDIT_CONFIRMED` | 콜백 `PAYOUT_COMPLETED`(L2 이상) | 6축 대사가 통과해야 함. 통과 못 하면 `EXCEPTION`. 통과하면 증빙 패키지를 만들어 앵커링에 접수(`EVIDENCE_COMMITTED`) |
| `PAYOUT_IN_PROGRESS`에 머묾 | 콜백 `PAYOUT_COMPLETED`(L1) | `EVIDENCE_INSUFFICIENT`. 서명 없는 완료 통보는 확정으로 치지 않음 |
| → `RETURNED` | 콜백 `USDC_RETURNED` | 현지 지급 실패 뒤 USDC 반환 |
| → `EVIDENCE_ANCHORED` | 워커(`promoteAnchored`, 2초 주기) | 그 송금의 attestation이 `confirmed`가 되면 |
| → `EXCEPTION` | `advance()`의 어느 구간이든 예외 | 파트너 호출 실패 · 서명 검증 실패 등. 저절로 재시도하지 않음 |

**파이프라인의 실행 방식.** 접수와 RFI 답변이 `setImmediate`로 `advance(paymentId)`를 부르고, 그 한 번의
호출이 트래블룰 → 승인 → 전송을 이어서 합니다. 큐도, 재시작 뒤 재개도 없습니다 — `advance()`를 부르는
곳은 그 두 곳뿐입니다. **코어를 재시작하면 그 순간 구간 사이에 있던 송금은 그 상태에 멈춥니다**
(RR-01). 오늘 세 번의 재시작은 매번 진행 중인 송금이 없는 것을 확인하고 했습니다.

**알려진 경합** (고치지 않음 — 소유자 결정: Java 전환에서 고침):

- `transition()`은 상태를 읽고 검사한 뒤 조건 없는 UPDATE를 합니다. 취소와 승인 구간이 겹치면
  `CANCELLED`가 `PAYOUT_PRE_APPROVED`로 덮이고 전송이 나갑니다(RR-03).
- 반대 방향도 있습니다: `cancel()`은 취소 가능 여부를 본 뒤 무조건 `CANCELLED`로 씁니다. 승인·전송이
  먼저 지나가면 "CANCELLED인데 USDC는 전송된" 상태가 됩니다. 취소는 취소 가능 상태에서만 성공하는
  조건부 갱신이어야 하고, 전송 지시는 지급당 한 번만 잡히는 선점이어야 합니다.
- `appendEvent()`는 `MAX(seq)+1` 뒤 INSERT입니다(트랜잭션 없음). 동시 추가는 한쪽이
  `UNIQUE(payment_id, seq)` 위반으로 실패합니다.
- `rfi-response` 두 건이 겹치면 `advance()`가 두 번 예약됩니다. 콜백에는 상태 전제조건과 중복
  제거가 없습니다(RR-15).

**전환 때 "끝나지 않은 송금"의 판단:**

- 비종결 상태: `REQUEST_ACCEPTED`(접수 트랜잭션 덕에 이제 남지 않음), `BANK_AUTHORIZED`,
  `TRAVEL_RULE_PENDING`, `PAYOUT_PRE_APPROVED`, `ONCHAIN_SETTLED`, `PAYOUT_IN_PROGRESS`,
  `BENEFICIARY_CREDIT_CONFIRMED`(앵커 확정 대기).
- 저절로 끝나지 않는 것: `TRAVEL_RULE_PENDING` + 미답변 RFI(은행의 답을 기다림), `PAYOUT_IN_PROGRESS` +
  `EVIDENCE_INSUFFICIENT`(더 나은 확인을 기다림), 재시작으로 멈춘 송금. 운영 DB에는 지금
  `TRAVEL_RULE_PENDING` 2건, `PAYOUT_IN_PROGRESS` 7건이 시험 자료로 그렇게 남아 있습니다
  (2026-11-17~18의 시험). 전환 때 "0건"을 기다리면 끝나지 않습니다 — 이 행들은 그대로 넘기면 됩니다.
- `EXCEPTION`은 종결입니다(4건). 사람이 확인할 대상이고, 전환이 기다릴 대상이 아닙니다.
- 웹훅 대기: `remit_webhook_deliveries.status = 'pending'`. 5회 실패하면 `exhausted`로 끝나므로
  기다리면 0이 됩니다.

---

## 3. 외부와의 약속

**서명 규약** (`sign.ts`, SDK와 같은 벡터 `golden/signing.json`):

- 이벤트 서명: `ES256( 'stonehash:remit:event:v1\n' ‖ JCS(payload) )`, 서명은 P1363(r‖s) base64url.
  `EventSig = { alg: 'ES256', key_id, issuer, sig }`.
- 증거요소: `digest = SHA-256('stonehash:evidence:digest:v1\n' ‖ JCS(요소에서 서명·digest를 뺀 것))`,
  서명은 `attest-rules`의 `signedBytes`(도메인 `stonehash:evidence:sig:v1\n`)에 대한 ES256.
  digest를 먼저 넣고 서명합니다.
- 플랫폼 키는 `GET /v1/remit/meta`의 `platform_signer`로 공개됩니다.

**파트너 호출** (`partners-client.ts`의 `BfiConnector` · `SettlementWallet` — 이 인터페이스가 계약이고,
`TripleAProfileSim`은 그 첫 구현입니다. 호출마다 한 번의 POST, 타임아웃 20초, 재시도 없음):

1. `POST /bfi/travel-rule { payment_id, jwe, ivms101_digest, sender }` → `ACK`(서명된 수신 확인) /
   `RFI`(질문) / `REJECTED`.
2. (RFI일 때) `POST /bfi/travel-rule-response { payment_id, jwe, answers_digest, sender }` → `ACK` / `REJECTED`.
3. `POST /bfi/payout-approval { payment_id, quote_id, usdc_amount, trade, payout, quote, ivms101_digest, sender }`
   → 서명된 승인(입금 주소, 유효기한). 승인이 `payment_id`와 `usdc_amount`를 되풀이하는지 확인합니다.
4. `POST /wallet/transfer { instruction: { payload, sig } }` — 지시는 저장된 승인 이벤트에서만
   만들어집니다(`derived_from_approval_seq`). 결과는 정산주체 키로 검증합니다.
   **타임아웃이면 전송 여부를 알 수 없는데, 멱등키도 TXID 조회 경로도 없습니다(RR-04).**
5. `POST /bfi/settlement-notice { payment_id, tx_hash, sender }`.
6. (취소 때) `POST /bfi/cancel { payment_id, reason, sender }` — 실패해도 취소는 유지, 로그만.

`sender`는 플랫폼 키의 이벤트 서명입니다.

**콜백** (`POST /v1/remit/callbacks { type, payload, sig }`, 인증 없음 — 서명이 인증입니다):
수취기관(`BENEFICIARY_FI`) 키로 검증하고, 종류는 `USDC_RECEIVED`, `PAYOUT_SUBMITTED`,
`PAYOUT_COMPLETED`(`evidence_level` L1·L2·L3), `PAYOUT_FAILED`, `USDC_RETURNED`. 순서 보장도, 중복 제거도
없습니다. `PAYOUT_COMPLETED`는 요청 안에서 대사·패키지 조립·앵커 접수까지 합니다(무거움).

**웹훅** (`webhook.ts`): 조직에 URL이 등록돼 있을 때만. 본문은
`{ event_id, payment_id, sequence, type, state, occurred_at, data, signature }`이고 `signature`는
봉투에 대한 플랫폼 이벤트 서명입니다. 2xx면 완료. 실패하면 2초 · 10초 · 30초 · 2분 · 10분 간격으로
다시 보내고 `REMIT_WEBHOOK_MAX_ATTEMPTS`(기본 5)에서 `exhausted`. 한 번에 20건, 타임아웃 5초. 순서는
보장하지 않습니다 — 받는 쪽은 `sequence`로 정렬하고, 놓친 것은 `GET /v1/settlements/{id}`로 읽습니다.

**트래블룰:**

- 모드 A: 은행이 평문 당사자 정보를 보내고, 플랫폼이 IVMS101을 만들어 수취기관의 공개키로
  암호화합니다(ECDH-ES(P-256) + A256GCM, compact JWE; 키 유도는 concatKDF). 평문은 `request_body.compliance_plaintext`에 잠시
  있다가 전달 뒤 지워집니다 — 남는 것은 digest입니다.
- 모드 B: 은행 SDK가 암호화해서 보냅니다. 플랫폼은 읽지 못하므로, 은행이 서명한 진술
  (`fields_assertion`)이 "제출된 바로 그 암호문과 digest에 관한 것"인지 확인합니다
  (`fieldsAssertionProblem`). 진술이 메시지를 가리키지 않으면 다른 암호문으로 바꿔 끼울 수 있습니다.
- SDK와 플랫폼의 IVMS101 · JWE는 바이트까지 같아야 합니다. TS에서는 SDK 테스트가 플랫폼 코드를 직접
  불러 확인합니다(`client.test.ts`의 mode B 테스트).

**일별 대사** (`POST /v1/manifests/daily`): 은행이 UTC 날짜와 그날의 지급 ID 목록에 서명해 보내면
플랫폼 원장과 비교해 `MATCHED` / `DISCREPANT`(`missing_in_manifest`, 플랫폼이 모르는 id)를 답합니다.

**결제 검색(`q`)의 범위** — `store.ts` `search`의 `JSON_EXTRACT`가 MySQL 전용이라 Java에서 대체가
필요합니다. 의도한 범위: `payment_id`, `quote_id`, `chain_tx`의 부분 일치(대소문자 무시), 그리고 이벤트
본문의 다음 경로 — `PAYOUT_COMPLETED`의 `$.bank_reference`; `BANK_EVIDENCE_SUBMITTED`의
`$.bankInstruction.sourceMessage.{uetr, instructionId, endToEndId, messageId}`와
`$.bankApproval.approvalRef`; `BANK_AUTHORIZATION_VERIFIED`의 `$.bank_authorization.instruction_ref`.
"참조번호만, JSON의 키나 다른 값은 아님"이 요건입니다(인보이스 번호는 찾지 않음). 참조번호를 접수 때
별도 열이나 색인 표에 뽑아 두면 JSON 함수가 필요 없습니다.

---

## 4. 기준 테스트와 실행 방법

| 무엇 | 어디 | 실행 |
|---|---|---|
| 플랫폼 송금 단위 | `apps/core/test/remit.test.ts` (20건; 마지막 5건이 전문 중복 규칙) | `cd attest/apps/core && node --test 'test/*.test.ts'` → 200건 중 198 통과, 2 건너뜀(MySQL · 라이브 인스크립션) |
| MySQL 실엔진 · 동시성 | `apps/core/test/mysql-parity.test.ts` 마지막 소테스트 (연결 8개 동시 요청 4종) | `STONEHASH_TEST_MYSQL_URL=<서버 URL>` 필요. 자기 스키마를 만들고 지움 |
| SDK(TS) | `packages/attest-remit/test/*.test.ts` | `cd attest/packages/attest-remit && node --test 'test/*.test.ts'` → 112 통과 |
| SDK ↔ 플랫폼 규칙 | `test/support/source-ledger.ts` — SDK 테스트의 대역 플랫폼이 플랫폼의 실제 store를 인메모리 SQLite로 돌림 | 위 SDK 테스트에 포함 |
| Java SDK 기준 벡터 | `sdks/attest-remit-java/tools/make-golden.mjs` → `src/test/resources/golden/*.json` | `node tools/make-golden.mjs --check` (`--only=parse,mapping` 등으로 일부만) |
| 실샌드박스 종단 | `deploy/smoke*.sh`, 데모 `:3200` `:3400` `:3500` | |

**테스트가 덮지 못하는 곳:**

- `acceptSettlement` 전체(견적 → 서명 → 트래블룰 → 증거요소 → 전문 판정 → 생성)를 도는 단위 테스트가
  없습니다. 저장소 수준(`createFromMessage`)과 실샌드박스로만 확인했습니다. Java에서는 HTTP 수준
  계약 테스트로 만드는 것이 맞습니다 — 확인할 사례는 `remit.test.ts`의 마지막 다섯 테스트와
  `packages/attest-remit/test/client.test.ts`의 `submitSwift:` 테스트들에 있습니다.
- 파이프라인 구간(트래블룰 · 승인 · 전송)과 콜백은 파트너 시뮬레이터를 띄운 종단 점검으로만 돕니다.
- 경합(취소 대 승인, 콜백 중복)은 테스트가 없습니다 — 결함이 있는 자리입니다(2장).

---

## 5. 알려진 결함과 끝내지 못한 일

**분석 항목(`docs/analysis-2026-11-18/remit-rail.json`)에 대한 의견:**

- RR-01(메모리에서 이어 가는 파이프라인, 재시작 뒤 재개 없음): 동의. 2장 참조.
- RR-03(상태 전이 경합): 동의하고, `cancel()` 방향을 더했습니다(2장). TS에서는 고치지 않습니다.
- RR-04(파트너 호출의 멱등성 · 재시도 없음): 동의. 지금은 재시도가 없어 이중 전송은 없지만, 타임아웃
  뒤의 상태를 알 수 없습니다.
- RR-15(콜백의 전제조건 · 중복 제거 없음): 동의.
- RR-20(멱등 확인이 check-then-act): 부분적으로 해소. 같은 `payment_id`의 동시 요청은 이제 500이 아니라
  `409 duplicate_payment`입니다(트랜잭션 안의 id 확인 + 중복 키 오류 변환). 멱등 키 자체의
  check-then-act와 키 순서에 의존하는 본문 해시는 그대로입니다.

**이번 작업에서 남긴 것:**

- backfill이 시작 때마다 `BANK_EVIDENCE_SUBMITTED` 이벤트를 `LIKE`로 훑습니다. 자체 데이터 송금이
  늘면 시작 시간이 그만큼 늘어납니다. 이행 표시 뒤에 한 번만 돌게 해야 합니다.
- 옛 이중지급(같은 전문의 송금 둘)이 있는 DB에서는 자리를 못 받은 쪽이 정확 조회에 나오지 않습니다.
  운영 DB에는 없습니다.
- MT103의 57B(지점 위치로 적는 수취은행)는 읽지 않습니다. 수취은행은 수신행(블록 2)으로 봅니다 —
  표준상 57B는 수신행의 지점을 가리키므로 틀린 판독은 아니지만, 지점 정보는 버려집니다.
- TS SDK의 `adapter.ts`·`cli.ts`(폴더 어댑터와 CLI)는 저장소 안의 시험 도구로만 남아 있고, 허브와
  내려받기 묶음에는 없습니다(소유자 지시: 은행은 SDK를 자기 소스에서 부릅니다).

---

## 6. 2026-11-18에 바뀐 계약과 릴리스 상태

**플랫폼:**

- 표 `remit_source_refs`, `remit_source_matches` 추가(1.1).
- `POST /v1/settlements`: `409 duplicate_source_message` · `409 reference_reused`(본문에
  `existing_payment_id`, `ground`), `400 invalid_source_message`. 같은 `payment_id` 경합은 항상
  `409 duplicate_payment`. 접수는 송금 행 · 참조 행 · 첫 이벤트 셋 · 첫 상태가 한 트랜잭션.
- `GET /v1/settlements`: `source_uetr`, `source_content`, `source_value_date`, `400 invalid_source_lookup`.
- `ServiceError`에 `detail`(오류 본문에 펼쳐짐).
- `apps/docs/openapi.json`: 위 내용과 `SourceMessage`의 `content` · `valueDate` · `paymentInfoId`,
  `Error`의 `existing_payment_id` · `ground`.

**SDK(TypeScript, `packages/attest-remit`):**

- `submitSwift()`의 중복 인식 경로 전체(1.2), `RemitApiError.existingPaymentId` · `ground`,
  `list()`의 `sourceUetr` · `sourceContent` · `sourceValueDate`, 읽기 전용 클라이언트(`readOnly`),
  `evidence()`, 자체 데이터 id의 해시 10자.
- 리더 · 매핑 · 상태 보고의 보강 약 45건(각각 `test/hardening-*.test.ts`에 테스트):
  XML 인코딩 명시(UTF-8 · BOM 있는 UTF-16 · 선언된 ISO-8859-1 · windows-1252 · US-ASCII), 한
  `Document`에 전문 둘 거절, 쉼표가 든 XML 금액 거절, 알 수 없는 `ChrgBr` 거절, MT103의 빈 필드 ·
  달력에 없는 결제일 · `23B` 코드 · 59F의 줄 번호, 금액의 자릿수 비교, `NOTPROVIDED` 처리 일원화,
  pacs.002의 길이 · 문자 · 시각 처리 등.
- `verifyEvidencePackage()`: 검증기가 직접 확인한 서명만 유효로 셉니다(모르는 이름의 요소는
  `NOT_VERIFIED`, 요소가 없으면 실패). 해석할 수 없는 패키지는 예외 대신 실패한 검사로 보고합니다.

**릴리스 상태:** 이 문서 끝의 "릴리스 기록"에 게시 시각과 해시를 적습니다.

---

## 7. Java SDK의 swift 패키지

`sdks/attest-remit-java/src/main/java/com/stonehash/attest/remit/swift/` — TS의
`packages/attest-remit/src/swift/`를 **같은 답이 나오도록** 옮긴 것입니다. 같은 지급, 그리고 거절할
때는 같은 코드 · 같은 필드 · 같은 문장.

| Java | TS | 하는 일 |
|---|---|---|
| `XmlReader` | `xml.ts` | DTD · 엔터티를 처리하지 않는 최소 XML 리더 |
| `Iso20022Reader` | `iso20022.ts` | pacs.008 · pain.001 |
| `Mt103Reader` | `mt103.ts` | MT103 |
| `SwiftMessages` | `parse.ts` | 디코딩(인코딩 판정), 형식 판별, 파일 안 식별자 중복 표시 |
| `SwiftText` · `SwiftAmount` | `model.ts` | 금액 · 통화 · UETR · BIC 공용 함수 |
| `SwiftMapper` · `SwiftMapping*` · `SwiftInstructionInput` | `mapping.ts` | 전문 → 지급지시, 내용 다이제스트, `ownReference` |
| `SwiftIds` | `client.ts`의 `swiftPaymentId` | 지급 ID |
| `SwiftStatus` · `StatusReport` | `status.ts` | ISO 20022 상태코드, pacs.002 |
| `Js` | — | JavaScript와 Java가 다르게 동작하는 곳의 대응(아래) |
| `Swift` | `index.ts` | 공개 진입점 |

**기준 벡터** (`src/test/resources/golden/`, 만드는 도구는 `tools/`):

- `parse.json` · `mapping.json` · `status.json` · `signing.json` · `scenarios.json` —
  `tools/golden-cases.mjs`(입력)와 `tools/make-golden.mjs`(TS SDK를 돌려 답을 기록).
  `scenarios.json`은 `submitSwift()`가 **플랫폼의 실제 store**를 상대로 내는 답입니다 — Java의
  `StandIn`은 그 파일의 `platform.rules`에 적힌 규칙을 구현해야 합니다.
- `status-views.json`, `anchor.json`, `verdict.json` — a7 세션의 도구.
- `tools/diff-fuzz.mjs <classpath> <count> [seed]` — 같은 입력(표본과 벡터 입력을 변형)을 TS와 Java에
  넣어 답이 갈리는 곳을 찾습니다. 리더를 고친 뒤에는 반드시 돌리십시오. classpath는 SDK 클래스와
  테스트 클래스(`SwiftProbe`가 테스트 쪽에 있음)를 함께 줍니다 — 예: `dist/…jar:build/test-classes`.
  6,000건에 약 3초입니다. 2026-11-18 보강 반영 뒤: 시드 1~5 · 21에 6,000건씩, 시드 11에 4,000건 —
  40,000건에 차이 0 · 중단 0. 비교하는 것은 판독 결과(지급 또는 거절의 코드 · 필드 · 문장), 매핑,
  지급 ID, 내용 다이제스트, ISO 필드 이름입니다. 제출 경로와 상태 보고는 비교하지 않습니다 —
  그쪽은 `scenarios.json`과 `status.json` · `status-views.json`이 맡습니다.
- `tools/reference-tests/` — Java 테스트 안에 "적어 둔" 기대값을 TS 기준 구현에서 다시 만드는 생성기
  (`mt/gen.ts` → `Mt103ReferenceTest.java`, `iso/answers.ts` → `Iso20022Answers.java`,
  `mapping/fingerprints.ts` → `SwiftMappingTest`의 `CASES`). 기대값은 손으로 고치지 말고 다시 만드십시오.
  같은 폴더의 `iso/fuzz*.ts` · `structfuzz.ts`는 XML 쪽 차이 검사(문자열 · 구조 · 바이트)입니다.

**고칠 때 주의할 점:**

- 순서는 언제나 **TS 수정 → 벡터 재생성 → Java 반영 → diff-fuzz**입니다. Java만 고치면 두 SDK가
  갈라지고, 은행 두 곳이 같은 전문에서 다른 지급 ID와 다른 내용 다이제스트를 만들게 됩니다.
- JavaScript와 Java가 다른 곳(`Js.java`에 대응 함수가 있습니다): 정규식의 `\s`(JS는 U+00A0 · U+FEFF ·
  유니코드 공백 포함) · `$`(JS는 입력 끝 — Java에서는 `\z`) · `.`(JS는 `\r` `\n` U+2028 U+2029 제외),
  `trim()`의 공백 집합, `split`의 끝 빈 문자열, `replace`는 첫 일치만, 빈 문자열과 `undefined`의
  참 · 거짓, 길이와 자르기의 UTF-16 단위, `Number`의 문자열 표현, 객체 키의 순서.
- 오류 문장은 답의 일부입니다. 타이포그래피 대시와 따옴표까지 같아야 벡터가 맞습니다.
- 내용 다이제스트와 지급 ID는 **출시 뒤 바꾸면 안 되는 값**입니다(1.1의 한계).
- TS의 결함을 일부러 그대로 둔 자리는 **없습니다.** 2026-11-18의 보강에서 알려진 결함을 TS에서 먼저
  고치고 Java를 맞췄습니다. Java가 TS보다 엄격한 곳도 없어야 합니다 — 있다면 벡터에 없는 입력에서의
  우연입니다.
- 알려진 차이는 하나이고, 리더가 만들 수 없는 입력에서만 납니다: 이미 파싱된 지급을 넘기면서
  `otherDocuments` · `charges` · `regulatoryReporting` 목록에 `null`을 넣으면 TS는 `"value": null`로 적고
  Java는 `value` 키를 뺍니다(`JsonOut.put`이 `null`을 버림). 보강 이전부터의 차이이고 고치지 않았습니다.
- 지급 ID는 실제 End-to-end ID를 **적힌 그대로** 씁니다(앞뒤 공백 포함). 매핑과 내용 다이제스트는
  trim합니다. 리더는 언제나 trim한 값을 내므로 전문에서는 차이가 없고, 손으로 만든 지급에서만 보입니다.
- XML 리더가 기준 구현의 답에 맞추려고 JDK와 다르게 한 두 곳: 이름이 `__proto__`인 속성은 버리고
  (TS의 일반 객체가 그 키를 갖지 않으므로), UTF-16은 자체 디코더로 읽습니다(JDK는 U+FFFE를 거절하지만
  기준 구현은 읽음).
- 전문 리더가 일부러 읽지 않거나 거절하는 것은 허브 가이드의 「읽을 수 있는 전문」에 목록이 있습니다.
  그 목록과 코드가 어긋나면 가이드가 아니라 코드와 벡터를 먼저 의심하십시오.

---

## 겪은 결함 (이 규칙들이 왜 이 모양인지)

1. **짧은 참조번호.** SDK가 원장을 "6자 이상인 참조번호의 부분 일치"로만 검색해, 20번 필드가 2글자인
   MT103을 헤더 블록 있는 채와 없는 채로 보내면 송금이 둘이 됐습니다. → 플랫폼 판정.
2. **식별자 없는 전문.** UETR · InstrId가 없고 EndToEndId가 `NOTPROVIDED`인 pain.001은 플랫폼이 알아볼
   근거가 없어, 재출력본이 두 번째 송금이 됐습니다(SDK의 id 계산이 바뀐 날 실샌드박스에서 재현).
   → 전문번호 근거의 쌍둥이 키.
3. **다대일 쌍둥이.** 같은 내용의 분할 지급 2건 가운데 보내지 않은 건이 "이미 지급됨"이 됐습니다.
   → 인식 기록과 1:1 대응. SDK는 쌍둥이를 고르지 않음.
4. **UETR 둘이 한 송금에.** UETR 없는 송금에 서로 다른 UETR의 지급 둘이 모두 붙었습니다. → UETR 승계.
5. **같은 파일, 다른 다이제스트.** SDK 판이 달라 같은 바이트의 다이제스트가 다르면 `reference_reused`가
   났습니다. → 같은 파일 판정을 맨 앞으로.
6. **표기 차이.** `20261117`과 `2026-11-17`, 뒤 공백, `NOTPROVIDED`가 쌍둥이 키를 갈랐습니다. → 정규화와
   형식 거절.
7. **반쯤 만들어진 송금.** 송금 행을 만든 뒤 증거 이벤트를 따로 써서, 경합에서 진 요청이 이벤트 없는
   송금을 읽고 "다른 전문의 송금"으로 판단했습니다. → 접수를 한 트랜잭션으로.
8. **닮았을 뿐인 대역.** SDK 테스트의 대역 플랫폼이 규칙을 손으로 베낀 것이라, 조회 순서와 쌍둥이
   선택이 실제와 달랐습니다. → 대역이 플랫폼의 실제 store를 돌림.

---

## 릴리스 기록

**2026-11-18 07:29:51Z — 개발자 허브 빌드·게시** (`apps/docs`, 테스트 51/51):

| 묶음 | SHA-256 | 내용 |
|---|---|---|
| `attest-remit.tar.gz` (141 kB) | `c883251cab6906d1dc061ef7c508c8dda744008cf29b68473e96cc823eb66aed` | TypeScript SDK — 이 메모의 SDK 변경 전부 |
| `attest-remit-java.tar.gz` (963 kB) | `501a4924b3d109b8e5df0fb005ef0c111156e79a7506718a1a1238cd919b2180` | Java SDK — `release/`는 a7이 07:21Z에 만든 판 |

Java 릴리스(`sdks/attest-remit-java/release/SHA256SUMS`): jar `ca5484f3f6aedc537df71e50c7e420917ade03643c72cdf06ee35488518e93e8`,
sources `66d35508ff0528c429fbc7aac62abf380e1ca4a13140474ccc74b6aa81beea65`,
pom `b1606deb0d33207f8dde14725e8489700fd84f55696940cfcc658791ee34892c`.

**코어 재시작:** 04:41:39Z(표 `remit_source_refs`, 첫 backfill), 05:59:29Z(다듬은 규칙, `remit_source_matches`),
06:02:18Z(접수를 한 트랜잭션으로). 그 뒤 06:21Z · 06:30Z의 재시작은 3f 세션의 콘솔 변경입니다.

**게시 뒤 확인한 것:**

- 허브에서 내려받은 TS SDK(체크섬 확인)로 실샌드박스 10개 항목 — 헤더 유무 양방향, 두 표현 동시 제출,
  명시 id, 이전 SDK로 만든 식별자 없는 지급의 재출력, 분할 지급 1:1, UETR 승계, 같은 id 동시 제출,
  결제일 없는 쌍둥이 거절, 날짜 형식 거절, 표본 4종 — 모두 통과
  (스크립트: 세션 스크래치의 `dup/live-current.mjs`; 같은 사례가 `packages/attest-remit/test/client.test.ts`에 있음).
- 게시된 가이드(한 · 영)의 첫 예제를 붙여 넣은 그대로 두 번 실행: 첫 번째 접수, 두 번째 `already: true`.
- 허브에서 내려받은 Java SDK를 빈 폴더에 풀어 체크섬 3건 확인, `./run-tests.sh` → 110 passed, 0 failed.
- 고객사 데모(`:3400`, 07:30Z 재시작): 표본 5종 모두 `EVIDENCE_ANCHORED` / ACCC, 같은 표본 재제출은 같은 송금.

**시험 자료(샌드박스 DB에 남아 있음):** `dup-*@bankdev.example` 계정 8개와 검토 에이전트의 계정 2개,
각 12~20건의 시험 송금. 지우지 않았습니다.
