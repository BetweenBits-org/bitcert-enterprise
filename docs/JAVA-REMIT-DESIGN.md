# 송금 레일의 Java 설계 — 상태 전이표 · 작업 큐 · 단계별 멱등키

- **상태:** v2 (2026-11-19, 실행 세션 e6). 작업 지시서(`docs/JAVA-BACKEND-MIGRATION.md`) 5단계의 선행 문서입니다. 구현은 이 판을 따릅니다.
- **v1에서 달라진 것:** v1(2026-11-18, a7)을 두 갈래로 독립 검토했습니다(동시성·장애, 외부 호환·롤백. 지적 32건, 그중 막아야 할 것 3건). 지적을 기준 코드로 확인한 뒤 이 판에 반영했습니다. 크게 바뀐 곳: 요청 멱등(6장), 지갑 호출의 독점(4장), 작업 임대의 울타리(3장), RFI 답변과 취소가 요청 안에서 하는 일(2.3절), 콜백의 순서와 중복 판정(5장), 평문을 지우는 시점(T2), 웹훅 본문의 모양(7장), 전환·롤백 절차(14·15장).
- **근거:** `docs/REMIT-HANDOVER.md`(인계 메모), `attest/apps/core/src/remit/`(기준 구현), 작업 지시서 4장(옮기면서 고칠 것 1·2·3번).

## v2 이후 고친 것

구현하는 동안 이 문서를 고치면 여기에 날짜, 장, 내용을 적습니다. 구현하는 쪽은 각 항목을 시작하기 전에 이 목록을 다시 봅니다.

- 2026-11-19 · 10장 · 플랫폼 키 id는 SPKI의 **base64 글자**를 SHA-256한 앞 8자리입니다(바이트가 아닙니다: `sign.ts`의 `loadOrCreatePlatformKey`). "뜰 때"가 무엇인지도 적었습니다: `serve`가 서버를 올릴 때뿐입니다.
- 2026-11-19 · 3.5절 · 12장 · 17장 · `REMIT_STEP_RETRY_MS`에서 "다시 시도하지 않음"은 빈 값이 아니라 `off`입니다. 이 모듈은 빈 값을 "설정 안 함"(기본값)으로 읽습니다.
- 2026-11-19 · 2.3절 · RFI 답변에 수취기관이 한 답을 읽는 규칙을 기준 코드대로 고쳤습니다(서명이 틀린 수신 확인은 취소가 아니라 은행에 400).
- 2026-11-19 · 2.3절 · 6장 · 191자를 넘는 멱등키는 400 `invalid_idempotency_key`. 여러 번 온 `Idempotency-Key` · `X-Admin-Token` 헤더는 기준처럼 `, `로 이어 읽습니다.
- 2026-11-19 · 2.1절(T12b) · 5장 · 대사가 열려 있는 동안 온 또 다른 완료 통보는 409 `wrong_state`.
- 2026-11-19 · 3.3절 · 13장 · 패키지 조립이 실패한 콜백은 기준도 200으로 답합니다(500은 대사가 안에서 던졌을 때뿐).
- 2026-11-19 · 3.5절 · 4.2절 · 2xx인데 JSON이 아닌 응답의 처리(통지 둘은 성공).
- 2026-11-19 · 9장 · 10장 · 앵커 기록의 설명이 들어가는 열(`descriptor`), 키링에서 빼는 키의 판정, `upsert`의 의미.
- 2026-11-19 · 12장 · 시험 서버의 설정 점검(`tools/check-test-env.mjs`)과, 대조용 두 서버가 플랫폼 키 파일 하나를 같이 쓰는 것.
- 2026-11-19(2차: v2를 검토 지적과 기준 코드에 다시 대조한 결과) · **4.2절 · 3.5절 · 지갑 호출은 어떤 실패에도 다시 부르지 않습니다.** 연결이 맺어지지 않은 경우도 곧바로 T19입니다(앞의 1차 수정에서 "다시 시도"라고 적었던 것을 거둡니다: `waiting`이 된 전송 작업은 임대가 없어, 다음에 잡은 쪽이 "나가지 않은 시도"와 "나가 있는 시도"를 가릴 수 없습니다). 지갑의 답 읽기를 넷으로 나눴습니다.
- 2026-11-19(2차) · 3.2절 · 2.1절 · **결과를 쓰는 전이(T3 · T7 · T9 · T13 · T15)는 작업의 소유를 조건으로 삼지 않습니다.** 검증된 결과를 쥔 실행기가 임대를 잃었다고 그 결과를 버리지 않습니다. 울타리는 호출 전의 전이와 실패를 적는 문장에 둡니다.
- 2026-11-19(2차) · 3.1 ~ 3.3절 · 4.1절 · `lease_owner`는 선점마다 새로 만드는 값, 실행기 대기열에 있는 작업의 임대 갱신, `attempts`를 세는 시점, 호출의 20초는 연결부터 본문을 다 읽을 때까지(연결 시한을 따로 두지 않음).
- 2026-11-19(2차) · 2.1절 · 3.2절 · `CANCEL_NOTICE`는 `CANCELLED`인 송금에서 도는 작업입니다(종결된 송금을 만나면 끝낸다는 규칙의 예외). T19의 조건이 맞지 않을 때도 작업은 닫습니다. 같은 갈래의 다음 작업은 지금 작업을 닫은 뒤에 넣습니다.
- 2026-11-19(2차) · 2.1절(T12 · T13) · 9장 · 대사가 열려 있는 동안에는 `L1` 통보도 409입니다. T13은 `evidence_level`을 대사한 통보의 값으로 맞춥니다.
- 2026-11-19(2차) · 2.2절 · 2.3절 · 표에 빠져 있던 기준의 값: RFI의 기본 id와 질문, T13 · T17 웹훅의 기본값, 접수 검사에서 id 중복이 견적보다 먼저라는 것, 송금 행과 `request_body`의 내용, `updated_at`.
- 2026-11-19(2차) · 3.5절 · 4.3절 · 기준이 스스로 던지는 두 오류를 "곧바로 T19"에 더하고, 표에 없는 실패가 끝내 남기는 문장을 정했습니다.
- 2026-11-19(2차) · 8장 · 10장 · 내릴 때 전송 호출은 기다립니다. 운영 저장소에서는 플랫폼 기관 행의 키가 파일과 다르면 덮어쓰지 않고 멈춥니다.
- 2026-11-19(2차) · 13장 · 빠져 있던 차이 여섯 줄, 콜백에 대한 기준의 실제 답. · 14 · 15 · 16장 · "`L1` 대기"를 이벤트로 정의, 롤백은 Java를 내린 뒤 다시 확인하고 닫음, 명령 둘 추가(`remit-job-close`, `register-platform-key`), `remit-job-requeue`의 조건. · 17장 · 503의 자리, 전환 때 `openapi.json`에 더할 답.

## 0. 무엇을 그대로 두고 무엇을 바꾸는가

**그대로:** 경로와 요청·응답 본문, 오류 코드와 문장, 상태 이름 11개, 이벤트의 종류·본문·서명, 웹훅의 본문과 재시도 간격, 파트너에게 보내는 요청 본문, 전문 하나에 송금 하나 규칙, DB에 저장되는 값(멱등 해시, 쌍둥이 키, 시각 문자열, 이벤트·패키지 JSON의 멤버 순서).

**바꾸는 것은 실행 방식뿐입니다.** 기준 구현은 요청이 끝난 뒤의 일을 메모리에서 이어 갑니다(`setImmediate` → `advance()`). 재시작하면 그 자리에서 멈추고, 상태를 읽은 뒤 조건 없이 덮어써서 취소와 승인이 겹치면 한쪽이 지워집니다. Java에서는 아래 세 가지로 다시 짓습니다.

1. 전이 하나는 트랜잭션 하나이고, 기대 상태가 조건입니다(1장).
2. 요청 뒤의 일은 DB에 적재한 작업입니다(3장). 재시작하면 이어서 합니다.
3. 밖으로 나가는 호출은 단계마다 멱등키를 갖고, 결과를 모르면 다시 보내지 않습니다(4장).

**기존 표의 상태 열에는 새 값을 쓰지 않습니다.** 롤백하면 TypeScript 코어가 같은 행을 읽어야 하기 때문입니다(지시서 5장 롤백 규칙). 새로 필요한 상태("실행 중", "사람이 봐야 함")는 새 표 `remit_jobs`에만 둡니다. 새 이벤트 종류와 새 웹훅 종류도 만들지 않습니다.

## 1. 전이 하나 = 트랜잭션 하나

모든 전이는 이 순서입니다.

1. 송금 행을 잠급니다: `SELECT … FROM remit_payments WHERE id = ? FOR UPDATE`. 트랜잭션의 첫 문장입니다(일반 SELECT를 먼저 하면 REPEATABLE READ에서 앞선 커밋을 보지 못합니다).
2. 기대 조건(상태, 그리고 표에 적힌 이벤트의 유무)을 봅니다. 아니면 아무것도 쓰지 않고 끝냅니다 — 다른 쪽이 먼저 지나간 것입니다. 예외는 T1 하나입니다: 전문 중복으로 거절할 때도 인식 기록은 커밋합니다(2.3절).
3. 이벤트를 추가합니다. 순번은 같은 잠금 안에서 `COALESCE(MAX(seq), -1) + 1`입니다(첫 이벤트가 0).
4. 상태를 바꿉니다: `UPDATE … SET state = ?, updated_at = ? WHERE id = ? AND state = ?`. 1행이 아니면 롤백합니다. 상태를 바꾸지 않고 송금 행의 다른 열만 쓰는 문장(입금 주소, `chain_tx`, 증빙 등급, 판정, 패키지 열, 평문을 지운 `request_body`)도 언제나 `updated_at`을 함께 씁니다(기준과 같음: 두 조회 경로가 이 값을 내보냅니다).
5. 웹훅 발송 행, 지금 작업의 마감, 다음 작업을 씁니다. **같은 갈래의 다음 작업은 지금 작업을 닫은 뒤에 넣습니다**: 유일 키(3.1절)는 문장마다 검사되므로 순서가 바뀌면 삽입이 거절됩니다.
6. 커밋합니다. 파트너·지갑 호출은 언제나 트랜잭션 밖에서 합니다. DB 잠금을 쥔 채 밖을 부르지 않습니다.

**잠금 순서는 하나입니다: (조직 행 →) 송금 행 → 작업 행.** 접수만 조직 행을 먼저 잠급니다(전문 충돌 판정이 조직 범위이기 때문: 인계 메모 1.1). 접수는 송금 행을 새로 만들므로 송금 행 잠금이 따로 없습니다. 작업 행만 건드리는 문장(선점, 임대 갱신)은 잠금 없이 조건부 UPDATE 한 문장입니다.

**교착과 잠금 대기 시간 초과**는 그 트랜잭션을 처음부터 다시 합니다(3번까지). 그래도 안 되면 그때 오류입니다.

`remit_jobs`에는 외래 키를 두지 않습니다. 조직 행으로 가는 키가 있으면 작업을 적재할 때마다 조직 행에 공유 잠금이 걸려 접수의 배타 잠금 뒤에서 기다립니다.

## 2. 상태 전이표

상태는 이 순서로만 전진합니다: `REQUEST_ACCEPTED` → `BANK_AUTHORIZED` → `TRAVEL_RULE_PENDING` → `PAYOUT_PRE_APPROVED` → `ONCHAIN_SETTLED` → `PAYOUT_IN_PROGRESS` → `BENEFICIARY_CREDIT_CONFIRMED` → `EVIDENCE_ANCHORED`. 종결 상태는 `EVIDENCE_ANCHORED`, `CANCELLED`, `RETURNED`, `EXCEPTION`이고, 종결된 송금은 어떤 전이로도 다시 움직이지 않습니다.

"응답 이벤트"는 수취기관이 트래블룰에 답한 흔적입니다: `TRAVEL_RULE_RECEIVED`, `TRAVEL_RULE_RFI`, `TRAVEL_RULE_REJECTED`.

### 2.1 전이

| # | 전이 | 일으키는 것 | 기대 조건 | 같은 트랜잭션에서 쓰는 것 | 커밋 뒤 |
|---|---|---|---|---|---|
| T1 | (없음) → `BANK_AUTHORIZED` | API `POST /v1/settlements` | 그 멱등키의 행이 없음, 그 id의 송금이 없음, 그 전문의 송금이 없음(2.3절) | 송금 행(`REQUEST_ACCEPTED`. 경로 · 통화 · 금액 · `usdc_amount`는 요청이 아니라 저장된 견적에서 옮깁니다. `request_body`는 요청에서 `compliance_payload`를 뺀 것 끝에 멤버 하나를 더한 것: 모드 A면 `compliance_plaintext`(그 `compliance_payload` 전체), 모드 B면 `compliance_ciphertext { ciphertext, ivms101_digest }`), 전문 참조 행, 이벤트 `REQUEST_ACCEPTED` · `BANK_EVIDENCE_SUBMITTED` · `BANK_AUTHORIZATION_VERIFIED`, 상태, 웹훅 `BANK_AUTHORIZED`, 작업 `TRAVEL_RULE`, 멱등 행(202와 그 본문) | 202로 답함. 작업은 실행기에서 |
| T2 | `BANK_AUTHORIZED` → `TRAVEL_RULE_PENDING` | 작업 `TRAVEL_RULE` | `BANK_AUTHORIZED` | 트래블룰 행(수취기관, 암호문, digest, `SENT`), **`request_body`에서 평문 삭제**, 이벤트 `TRAVEL_RULE_SENT`, 상태, 웹훅 `TRAVEL_RULE_PENDING`, 작업의 `input`에 보낼 본문 | 수취기관 호출 `travel-rule` |
| T3 | `TRAVEL_RULE_PENDING`에 머묾 (수신 확인) | `travel-rule` 응답 `ACK`(서명 검증됨) | `TRAVEL_RULE_PENDING`, 응답 이벤트가 아직 없음 | 이벤트 `TRAVEL_RULE_RECEIVED`, 작업 `TRAVEL_RULE` 마감, 작업 `PAYOUT_APPROVAL` | 작업을 바로 실행 |
| T4 | `TRAVEL_RULE_PENDING`에 머묾 (질문) | `travel-rule` 응답 `RFI` | 위와 같음 | 이벤트 `TRAVEL_RULE_RFI`, 웹훅 `TRAVEL_RULE_RFI`, 작업 마감 | 은행의 답을 기다림(기한 없음) |
| T5a | → `CANCELLED` | `travel-rule` 응답 `REJECTED` | `TRAVEL_RULE_PENDING`, 응답 이벤트가 아직 없음 | 이벤트 `TRAVEL_RULE_REJECTED`, 상태, 웹훅 `CANCELLED`, 작업 마감 | — |
| T5b | → `CANCELLED` | RFI 답변에 대한 수취기관의 답이 서명된 `ACK`가 아님 | `TRAVEL_RULE_PENDING`, `TRAVEL_RULE_RFI`가 있고 `TRAVEL_RULE_RECEIVED`가 없음 | 이벤트 `TRAVEL_RULE_REJECTED`, 상태, 웹훅 `CANCELLED` | 200 `CANCELLED`로 답함 |
| T6 | `TRAVEL_RULE_PENDING`에 머묾 (답변 수락) | API `rfi-response` → 수취기관의 서명된 `ACK` | T5b와 같음 | 이벤트 `TRAVEL_RULE_RFI_RESOLVED` · `TRAVEL_RULE_RECEIVED`, 웹훅 `TRAVEL_RULE_RFI_RESOLVED`, 작업 `PAYOUT_APPROVAL` | 200 `TRAVEL_RULE_PENDING`으로 답함. 작업은 실행기에서 |
| T7 | → `PAYOUT_PRE_APPROVED` | 작업 `PAYOUT_APPROVAL`의 결과(서명 검증, 송금 id와 금액을 되풀이함) | `TRAVEL_RULE_PENDING`, `TRAVEL_RULE_RECEIVED`가 있고 `PAYOUT_ACCEPTED`가 없음 | 이벤트 `PAYOUT_ACCEPTED`, 입금 주소, 상태, 웹훅 `PAYOUT_PRE_APPROVED`, 작업 마감, 작업 `TRANSFER` | 작업을 바로 실행 |
| T8 | `PAYOUT_PRE_APPROVED`에 머묾 (전송 선점) | 작업 `TRANSFER` | `PAYOUT_PRE_APPROVED`, `PAYOUT_ACCEPTED`와 입금 주소가 있음, `SETTLEMENT_INSTRUCTED`가 없음 | 이벤트 `SETTLEMENT_INSTRUCTED`(지시와 플랫폼 서명), 웹훅 `SETTLEMENT_INSTRUCTED`, 작업에 "호출 시작" 표시와 임대 갱신 | **이 트랜잭션을 커밋한 실행기만**, 한 번, 지갑 호출 `transfer` |
| T9 | → `ONCHAIN_SETTLED` | `transfer`의 검증된 결과 | `PAYOUT_PRE_APPROVED`, 지시가 있고 `USDC_TRANSFER_CONFIRMED`가 없음 | 이벤트 `USDC_TRANSFER_CONFIRMED`, `chain_tx`, 상태, 웹훅 `ONCHAIN_SETTLED`, 작업 마감, 작업 `SETTLEMENT_NOTICE` | 수취기관 통지 |
| T10 | → `PAYOUT_IN_PROGRESS` | 콜백 `USDC_RECEIVED` | `ONCHAIN_SETTLED` | 이벤트, 상태, 웹훅 `PAYOUT_IN_PROGRESS` | — |
| T11 | (상태 그대로) | 콜백 `PAYOUT_SUBMITTED` · `PAYOUT_FAILED` | `ONCHAIN_SETTLED` 또는 `PAYOUT_IN_PROGRESS` | 이벤트, 웹훅(같은 이름) | — |
| T12 | (상태 그대로, 대기) | 콜백 `PAYOUT_COMPLETED`, 등급이 정확히 `L1` | `ONCHAIN_SETTLED` 또는 `PAYOUT_IN_PROGRESS`, `SETTLEMENT_RECONCILED`가 없음, 열린 `evidence` 작업이 없음 | 이벤트 `PAYOUT_COMPLETED`, 증빙 등급, 웹훅 `PAYOUT_COMPLETED`, 이벤트 `EVIDENCE_INSUFFICIENT`, 웹훅 `EVIDENCE_INSUFFICIENT` | 더 나은 확인을 기다림 |
| T12b | (상태 그대로, 대사 접수) | 콜백 `PAYOUT_COMPLETED`, 등급이 `L1`이 아님 | 위와 같음(다른 완료 통보의 대사가 진행 중이면 `L1`이든 아니든 409 `wrong_state`) | 이벤트 `PAYOUT_COMPLETED`, 증빙 등급, 웹훅 `PAYOUT_COMPLETED`, 작업 `RECONCILE`(이 완료 통보의 순번을 `input`에) | 요청 스레드가 대사와 패키지를 이어서 함 |
| T13 | → `BENEFICIARY_CREDIT_CONFIRMED` | 작업 `RECONCILE`: 6축 대사 통과 | 위와 같음 | 이벤트 `SETTLEMENT_RECONCILED`, 판정, 증빙 등급(대사한 통보의 값), 상태, 웹훅 `BENEFICIARY_CREDIT_CONFIRMED`, 작업 마감, 작업 `PACKAGE`(검증한 증빙과 그때의 레지스트리 스냅샷을 `input`에) | 작업을 바로 실행 |
| T14 | → `EXCEPTION` | 작업 `RECONCILE`: 대사가 통과하지 못함 | 위와 같음 | 이벤트 `SETTLEMENT_RECONCILED`, 판정, 상태, 웹훅 `RECONCILIATION_EXCEPTION`, 작업 마감 | — |
| T15 | `BENEFICIARY_CREDIT_CONFIRMED`에 머묾 (증빙 커밋) | 작업 `PACKAGE` | `BENEFICIARY_CREDIT_CONFIRMED`, `attestation_id`가 없음 | 앵커 기록(상품 = remit, 내용 종류 `application/json`, 설명 `{ kind: "remit-evidence", payment_id, schema }`), 패키지 · nonce · 커밋 · 앵커 id, 이벤트 `EVIDENCE_COMMITTED`, 웹훅 `EVIDENCE_COMMITTED`, 작업 마감 | — |
| T16 | → `EVIDENCE_ANCHORED` | 워커(2초 주기) | `BENEFICIARY_CREDIT_CONFIRMED`, 앵커가 `confirmed` | 이벤트 `EVIDENCE_ANCHORED`, 상태, 웹훅 `EVIDENCE_ANCHORED` | — |
| T17 | → `RETURNED` | 콜백 `USDC_RETURNED` | `ONCHAIN_SETTLED` 또는 `PAYOUT_IN_PROGRESS` | 이벤트, 상태, 웹훅 `RETURNED` | — |
| T18 | → `CANCELLED` | API `cancel`(은행 서명) | `REQUEST_ACCEPTED` · `BANK_AUTHORIZED` · `TRAVEL_RULE_PENDING` | 이벤트 `CANCEL_REQUESTED`, 상태, 남은 평문 삭제, 웹훅 `CANCELLED`, 작업 `CANCEL_NOTICE` | 200으로 답함. 통지는 실행기에서(실패해도 취소는 유지) |
| T19 | → `EXCEPTION` | 작업이 끝내 실패(3.5절) | **그 작업의 단계가 아직 그 자리에 있음**(아래)과 "이 작업이 아직 내 것" | 이벤트 `EXCEPTION { payment_id, at_state, error }`, 상태, 남은 평문 삭제, 웹훅 `EXCEPTION`, 작업 마감 | — |

T19의 기대 조건은 "종결이 아님"이 아니라 작업 종류마다 따로입니다. `TRAVEL_RULE`: `BANK_AUTHORIZED`이거나, `TRAVEL_RULE_PENDING`이고 응답 이벤트가 없음. `PAYOUT_APPROVAL`: `TRAVEL_RULE_PENDING`이고 `PAYOUT_ACCEPTED`가 없음. `TRANSFER`: `PAYOUT_PRE_APPROVED`이고 `USDC_TRANSFER_CONFIRMED`가 없음. `SETTLEMENT_NOTICE`: `ONCHAIN_SETTLED`. `RECONCILE`·`PACKAGE`·`CANCEL_NOTICE`는 T19로 가지 않습니다(3.5절). 조건이 맞지 않으면 아무것도 쓰지 않습니다 — 늦게 실패한 작업이, 이미 앞으로 나아간 송금을 `EXCEPTION`으로 덮지 못합니다. 조건이 맞지 않아 쓰지 않을 때도 작업은 닫습니다: 그 단계의 결과가 기록돼 있으면 `done`, 송금이 종결이면 `cancelled`.

**경합이 해소되는 방식.** 취소(T18)와 승인 결과(T7)는 둘 다 송금 행을 잠그고 `TRAVEL_RULE_PENDING`을 기대합니다. 먼저 커밋한 쪽만 성공합니다. 취소가 먼저면 승인 결과는 버려지고 전송 작업은 적재되지 않습니다. 승인이 먼저면 취소는 409 `not_cancellable`입니다. 종결된 송금을 만난 작업은 호출 없이 스스로 `cancelled`로 끝납니다(취소가 작업 행을 건드리지 않으므로 잠금 순서가 뒤집히지 않습니다). `CANCEL_NOTICE`만은 예외입니다: 이 작업은 `CANCELLED`인 송금에서 도는 작업이고, 송금의 상태를 보지 않고 통지를 보냅니다.

**늦게 온 지갑 결과.** 지갑이 서명한 결과를 받았는데 송금이 이미 `PAYOUT_PRE_APPROVED`를 떠나 있으면(예: 임대가 끝난 사이 다른 실행기가 T19를 씀) 결과를 버리지 않습니다: 이벤트 `USDC_TRANSFER_CONFIRMED`와 `chain_tx`를 상태 변경 없이 기록하고 작업을 `attention`으로 둡니다. 돈이 움직였다는 서명된 사실은 원장에 남아야 합니다. 이 기록과 작업을 `attention`으로 두는 문장은 작업의 소유를 묻지 않고 `WHERE id = ?`로 씁니다(1장 2번의 두 번째 예외).

### 2.2 웹훅 — 종류, 순번, 본문

`sequence`는 그 웹훅이 알리는 이벤트의 순번이고, `state`는 그 전이를 마친 상태입니다. `data`는 종류마다 다릅니다(기준 `orchestrator.ts`의 `notify` 호출 그대로).

| 전이 | `type` | `sequence`의 이벤트 | `data` |
|---|---|---|---|
| T1 | `BANK_AUTHORIZED` | `BANK_AUTHORIZATION_VERIFIED` | `{ quote_id }` |
| T2 | `TRAVEL_RULE_PENDING` | `TRAVEL_RULE_SENT` | `{ ivms101_digest, mode }` |
| T4 | `TRAVEL_RULE_RFI` | `TRAVEL_RULE_RFI` | `{ rfi_id, questions }` — 수취기관이 `rfi` 없이 답하면 `rfi_id`는 `RFI-<payment_id>`, `questions`는 사유 하나(`[reason]`, 사유도 없으면 `additional information requested`). 이벤트 본문 `{ payment_id, rfi_id, questions, raised_at }`도 같은 값이고, 이벤트의 서명은 응답에 `ack.sig`가 있을 때만 그것입니다(없으면 서명 없음) |
| T5a | `CANCELLED` | `TRAVEL_RULE_REJECTED` | `{ reason }` — 수취기관이 준 사유, 없으면 `travel rule rejected`(이벤트 본문의 사유는 없으면 `rejected`) |
| T5b | `CANCELLED` | `TRAVEL_RULE_REJECTED` | `{ reason }` — 없으면 `rejected after RFI`(이벤트도 같음) |
| T6 | `TRAVEL_RULE_RFI_RESOLVED` | `TRAVEL_RULE_RFI_RESOLVED`(`RECEIVED`가 아님) | `{ rfi_id }` |
| T7 | `PAYOUT_PRE_APPROVED` | `PAYOUT_ACCEPTED` | `{ deposit_address, valid_until }` |
| T8 | `SETTLEMENT_INSTRUCTED` | `SETTLEMENT_INSTRUCTED` | `{ to_address }` |
| T9 | `ONCHAIN_SETTLED` | `USDC_TRANSFER_CONFIRMED` | `{ tx_hash, block }` |
| T10 | `PAYOUT_IN_PROGRESS` | `USDC_RECEIVED` | `{ tx_hash }`(없으면 `null`) |
| T11 | `PAYOUT_SUBMITTED` | 그 이벤트 | `{ local_rail }`(없으면 `FAST`) |
| T11 | `PAYOUT_FAILED` | 그 이벤트 | `{ reason, will_return: true }`(사유가 없으면 `local payout failed`) |
| T12 · T12b | `PAYOUT_COMPLETED` | `PAYOUT_COMPLETED` | `{ bank_reference, evidence_level }`(참조가 없으면 `null`) |
| T12 | `EVIDENCE_INSUFFICIENT` | `EVIDENCE_INSUFFICIENT` | `{ evidence_level }` |
| T13 | `BENEFICIARY_CREDIT_CONFIRMED` | `SETTLEMENT_RECONCILED` | `{ axes, bank_reference, evidence_level }` — `axes`는 축 이름 → 상태, `bank_reference`는 대사한 통보의 것(없으면 멤버를 빼지 않고 `null`), `evidence_level`은 그 통보의 등급 |
| T14 | `RECONCILIATION_EXCEPTION` | `SETTLEMENT_RECONCILED` | `{ reasons, axes }` |
| T15 | `EVIDENCE_COMMITTED` | `EVIDENCE_COMMITTED` | `{ attestation_id, commitment }` |
| T16 | `EVIDENCE_ANCHORED` | `EVIDENCE_ANCHORED` | `{ attestation_id }` |
| T17 | `RETURNED` | `USDC_RETURNED` | `{ reason, return_tx, note }` — 사유는 첫 `PAYOUT_FAILED` 이벤트의 것, 없으면 `returned`. `note`는 기준의 고정 문장 | `PAYOUT_FAILED` 이벤트는 있는데 거기에 사유가 없으면 `reason` 멤버가 없습니다. `return_tx`는 콜백 본문의 `tx_hash`, 없으면 `null` |
| T18 | `CANCELLED` | `CANCEL_REQUESTED` | `{ reason, by }` — `by`는 은행의 기관 id, 사유가 없으면 `cancelled by instructing bank` |
| T19 | `EXCEPTION` | `EXCEPTION` | `{ error }` |

웹훅 주소는 발송 행을 쓸 때 그 조직의 송금 구독 설정(`webhook_url`)에서 읽습니다. 구독이 꺼져 있어도 읽고, 주소가 없으면 행을 쓰지 않습니다(기준과 같음).

이벤트 본문의 멤버와 순서, 누가 서명하는지(플랫폼 서명 / 파트너가 준 서명 그대로 / 서명 없음), 이벤트의 `issuer`는 기준 구현의 각 자리 그대로입니다. 구현할 때 `orchestrator.ts`의 해당 줄을 옆에 두고 옮기고, 흐름 대조(12장)로 확인합니다.

### 2.3 요청마다: 무엇을 기다리고 무엇을 답하는가

**접수 `POST /v1/settlements`.** 순서는 기준 그대로입니다: 인증과 구독 → `Idempotency-Key` 확인(8자 이상. 191자를 넘으면 400 `invalid_idempotency_key` — 표의 열이 191자이고, 기준은 이때 송금을 받아 놓고 500을 답합니다. 헤더가 여러 번 오면 기준의 런타임처럼 `, `로 이어 붙인 값이 키입니다) → 본문 → 멱등 조회(6장) → `payment_id` 형식 → 그 id의 송금이 이미 있으면 409 `duplicate_payment`(견적보다 먼저 봅니다. 트랜잭션 안에서 한 번 더 봅니다) → 인계 메모 1.4의 검사(견적, 금액, 수취기관, 은행 서명, 트래블룰, 증거요소, 금액·ref 일치, 전문 참조 형식). 여기까지는 아무것도 쓰지 않습니다. 그다음이 T1의 트랜잭션입니다.

1. 조직 행을 잠급니다(전문에서 만든 지급이든 자체 데이터 지급이든 같습니다).
2. 멱등키를 다시 조회합니다. 같은 해시의 행이 있으면 저장된 202를 답하고, 다른 해시면 409 `idempotency_conflict`입니다.
3. 그 id의 송금이 있으면 409 `duplicate_payment`입니다.
4. 전문 참조가 있으면 충돌을 판정합니다(인계 메모 1.1의 네 단계 그대로). **충돌이면 송금을 만들지 않되, 판정이 쓴 인식 기록(`remit_source_matches`)과 UETR 승계는 커밋합니다.** 그 뒤에 409를 답합니다. 이 기록이 롤백되면 같은 내용에 다른 UETR이 온 두 번째 지급이 다시 "이미 있음"으로 답해져 지급이 빠집니다.
5. 충돌이 없으면 T1의 행들을 쓰고, 마지막에 멱등 행을 씁니다.

커밋한 뒤 202 `{ payment_id, state: "BANK_AUTHORIZED", accepted_at }`를 답합니다. 응답은 파트너 호출을 기다리지 않습니다. 멱등키가 아닌 중복 키 오류(다른 조직이 같은 순간에 같은 `payment_id`를 넣은 경우 등)는 기준처럼 409 `duplicate_payment`입니다.

**RFI 답변 `POST /v1/settlements/:id/rfi-response`.** 작업으로 만들지 않습니다. 기준처럼 요청 안에서 수취기관을 한 번 부릅니다.

1. 검사, 기준의 순서대로: 404 `payment_not_found` → 409 `wrong_state` → 409 `no_rfi` → 409 `already_resolved` → 400 `missing_field` → 400 `invalid_signature`. 잠금을 쥐지 않습니다.
2. 답변을 수취기관 키로 암호화해 `travel-rule-response`를 부릅니다(멱등키 `<payment_id>:rfi:<rfi_id>`).
3. 응답은 기준(`respondRfi`)이 읽는 대로 읽습니다. 상태가 `REJECTED`이거나 수신 확인(`ack`)이 없으면 → T5b, 200 `{ payment_id, state: "CANCELLED" }`. 수신 확인이 있으면(상태가 `ACK`가 아니어도) 그 서명을 검증합니다: 틀리면 **은행에 400**(`unknown_signer` · `role_mismatch` · `invalid_signature`, 기준의 문장)이고 아무것도 쓰지 않습니다 — 취소가 아닙니다. 맞으면 → T6, 200 `{ payment_id, state: "TRAVEL_RULE_PENDING" }`. 수취기관에 닿지 못했거나 4xx·5xx이면 **기준과 같이 502**(`partner_unreachable` · `partner_error`)이고 아무것도 쓰지 않습니다. 400과 502 뒤에는 RFI가 열린 채이고 은행이 다시 답할 수 있습니다. 이 경로는 T19로 가지 않습니다.
4. T6·T5b의 조건이 그사이 깨졌으면(겹친 두 답변 가운데 늦은 쪽, 그사이의 취소) 아무것도 쓰지 않고 409 `already_resolved`(취소됐으면 409 `wrong_state`)로 답합니다. 먼저 수락된 답변이 늦은 거절에 지워지지 않습니다.

**취소 `POST /v1/settlements/:id/cancel`.** 검사는 기준의 순서(404 → 409 `not_cancellable` → 400 `invalid_signature`), 그다음 T18입니다. T18의 조건이 깨졌으면(승인이 먼저 커밋) 409 `not_cancellable`입니다. 커밋하면 곧바로 200 `{ payment_id, state: "CANCELLED" }`를 답하고, 수취기관 통지는 작업 `CANCEL_NOTICE`가 뒤에서 합니다. 기준은 통지가 끝나기를(최대 20초) 기다렸다가 답했습니다.

**콜백 `POST /v1/remit/callbacks`.** 5장.

## 3. 작업 큐

### 3.1 표 `remit_jobs` (새 표)

| 열 | 뜻 |
|---|---|
| `id` | 시간순 id |
| `payment_id`, `org_id` | 어느 송금의 일인가 |
| `kind` | `TRAVEL_RULE`, `PAYOUT_APPROVAL`, `TRANSFER`, `SETTLEMENT_NOTICE`, `RECONCILE`, `PACKAGE`, `CANCEL_NOTICE` |
| `lane` | `pipeline`(`TRAVEL_RULE` · `PAYOUT_APPROVAL` · `TRANSFER`), `notice`(`SETTLEMENT_NOTICE` · `CANCEL_NOTICE`), `evidence`(`RECONCILE` · `PACKAGE`) |
| `state` | `queued` → `running` → `done`. 그 밖에 `waiting`(다시 시도할 시각을 기다림), `cancelled`(송금이 먼저 끝남), `attention`(사람이 봐야 함) |
| `open_slot` | 열린 작업(`queued` · `running` · `waiting`)이면 1, 닫히면 NULL |
| `attempts`, `next_attempt_at`, `last_error` | 재시도. `attempts`는 선점할 때마다 1씩 늡니다 |
| `lease_owner`, `lease_expires_at` | 누가 실행 중인가. `lease_owner`는 **선점할 때마다(이미 잡힌 채로 넣을 때도) 새로 만드는 값**입니다. 프로세스의 이름이 아닙니다 — 같은 프로세스 안의 낡은 넘겨받음과 새 선점이 서로를 자기라고 여기지 않게 합니다 |
| `call_started_at` | 지갑 호출이 나갔을 수 있다는 표시(T8이 씀) |
| `idempotency_key` | 이 작업이 밖으로 보내는 호출의 키(4장) |
| `input` | 호출에 필요한 것 가운데 송금 행과 이벤트에 없는 것: 처음 만든 요청 본문(보내는 쪽 서명 포함), 대사할 완료 통보의 순번, 패키지에 넣을 검증된 증빙과 레지스트리 스냅샷. 평문 개인정보는 넣지 않습니다 |
| `created_at`, `updated_at` | 시각 |

- 시각 열은 `datetime(3)`이고 **DB의 시계**(`UTC_TIMESTAMP(3)`)로 쓰고 비교합니다. 재시도 시각은 `UTC_TIMESTAMP(3) + INTERVAL …`입니다. `worker_leases`와 같은 규칙이고, 인스턴스들의 시계가 달라도 임대가 어긋나지 않습니다.
- 유일 키 `(payment_id, lane, open_slot)`: **송금 하나에, 한 갈래에서 열린 작업은 하나**입니다. 파이프라인 작업은 앞 작업의 결과 트랜잭션이 다음 작업을 만들기 때문에 원래 하나씩이고, 이 키는 그것을 DB가 지키게 합니다. 통지와 증빙은 다른 갈래라서 파이프라인이나 서로를 기다리지 않습니다(수취기관은 통지에 답하기 전에 콜백을 보내기 시작할 수 있습니다).
- 인덱스: `(state, next_attempt_at)`, `(payment_id, state)`.

### 3.2 선점과 울타리

- **선점은 조건부 UPDATE 한 문장입니다**: `state`가 `queued`나 `waiting`이고 때가 됐거나, `running`인데 임대가 끝난 작업을 `running`으로, 임대 60초로, `attempts + 1`로. 1행이면 내 것입니다. 한 번에 하나씩 잡고, 일을 시작하는 순간부터 임대를 셉니다.
- **작업이 자기 행에 쓰는 모든 문장은 `WHERE id = ? AND state = 'running' AND lease_owner = ?`를 답니다.** 0행이면 그 작업은 더 이상 내 것이 아니므로 아무것도 더 쓰지 않고 멈춥니다. 전이 트랜잭션 안에서 작업을 마감할 때도 같습니다: 0행이면 그 전이 전체를 롤백합니다. **울타리를 두는 곳은 호출 전의 전이(T2, T8)와 실패를 적는 문장(T19, `waiting` · `attention`으로 두는 것)입니다. 결과를 쓰는 전이(T3 · T7 · T9 · T13 · T15)는 작업의 소유를 조건으로 삼지 않습니다**: 조건은 송금 행의 상태와 이벤트이고, 작업 행은 `WHERE id = ?`로 닫습니다. 검증된 결과를 쥔 실행기가 임대를 잃었다고 그 결과를 버리지 않습니다. 뒤에 잡은 실행기는 시도를 시작하면서 결과가 기록된 것을 보고 끝냅니다.
- **밖을 부르기 직전에 임대를 갱신합니다**(60초). 호출의 제한 시간은 20초이므로 살아 있는 실행기의 임대는 호출 중에 끝나지 않습니다.
- **모든 시도는 상태와 이벤트를 읽는 것으로 시작합니다.** 그 단계의 결과가 이미 기록돼 있으면 호출 없이 끝냅니다. 송금이 종결돼 있으면 `cancelled`로 끝냅니다. (`CANCEL_NOTICE`는 예외: 2.1절.)
- 임대가 끝나 다시 잡힌 것도 시도로 셉니다. 다섯 번 잡히고도 끝나지 않은 작업은 더 돌리지 않습니다: 파이프라인과 `SETTLEMENT_NOTICE`는 T19(오류 문장: `the step did not complete after 5 attempts`), 나머지는 `attention`. `attempts`는 일을 시작할 때 셉니다(대기열에서 기다린 것은 시도가 아닙니다).

### 3.3 바로 실행

전이 트랜잭션은 다음 작업을 **이미 잡힌 채로**(`running`, 내 임대) 넣습니다. 커밋하면 넣은 프로세스가 그 작업을 실행기(스레드 풀)에 넘깁니다 — 기준 구현의 `setImmediate`와 같은 시점입니다. 주기 워커가 커밋과 실행 사이에 그 작업을 가로채는 틈이 없습니다. 실행기에 넘긴 작업이 스레드를 얻으면 먼저 울타리 UPDATE로 임대를 갱신하고, 0행이면 그만둡니다. 프로세스는 자기 실행기 대기열에 있는 작업의 임대를 30초마다 갱신합니다(기다리는 동안 임대가 끝나 다시 잡히지 않도록). 실행기가 받지 못한 작업(대기열이 참)은 `queued`로 되돌립니다. 실행기는 스레드 4개, 대기열 256건입니다.

요청 안에서 끝나던 일은 계속 요청 안에서 끝납니다: `PAYOUT_COMPLETED` 콜백의 요청 스레드가 `RECONCILE`과 `PACKAGE`를 직접 실행하고 나서 답합니다(수취기관은 답을 10초 기다립니다). 다른 점은 작업 행이 먼저 남는다는 것입니다. 요청 도중 프로세스가 죽으면 워커가 이어서 합니다. 대사나 패키지가 안에서 실패해도 콜백 자체는 기록됐으므로 200으로 답합니다(기준은 대사가 안에서 던지면 500, 패키지 조립의 실패는 로그만 남기고 200).

**다시 시도는 프로세스 안의 타이머가 합니다.** 작업을 `waiting`으로 둔 프로세스가 그 시각에 다시 잡아 실행합니다. 주기 워커가 없어도(`WORKER_TICK_MS=0`) 파이프라인과 재시도는 끝까지 갑니다.

### 3.4 주기 워커가 하는 일

임대 표 `worker_leases`의 이름 `remit`을 잡은 인스턴스만 합니다(2초 주기, 배치 워커와 같은 방식).

1. 주인을 잃은 작업을 잡아 실행기에 넘깁니다: 임대가 끝난 `running`, 때가 지난 `queued` · `waiting`(만든 프로세스가 죽은 것).
2. T16(앵커 확정 반영).
3. 웹훅 발송(7장).

`WORKER_TICK_MS=0`이면 주기 워커가 없습니다(기준과 같음: 웹훅 발송과 T16이 없습니다). 그때 프로세스가 죽으면 진행 중이던 작업은 워커를 켠 인스턴스가 뜰 때까지 멈춰 있습니다. **운영 배포에는 워커를 켠 인스턴스가 하나 있어야 합니다.**

### 3.5 실패했을 때

호출의 실패는 셋으로 나눕니다(4장).

| 무엇이 실패했나 | 처리 |
|---|---|
| **닿지 않음** — 연결이 맺어지지 않았음(연결 거부, 연결 시간 초과, 이름 풀이 실패). 요청이 나가지 않은 것이 확실함 | `waiting`으로 두고 같은 키, 같은 본문으로 다시: `REMIT_STEP_RETRY_MS`(기본 2초 · 10초 · 30초, `off`면 다시 하지 않음). 다 쓰면 T19. `CANCEL_NOTICE`는 `attention`. **`transfer`는 예외입니다(4.2절)**: T8을 커밋한 뒤의 `TRANSFER` 작업은 어떤 실패에도 `waiting`이 되지 않습니다 |
| **거절** — 파트너가 4xx로 답함 | 다시 해도 같습니다. 곧바로 T19, 오류 문장은 기준 그대로 `<경로> → HTTP <상태>: <파트너의 문장>`. `CANCEL_NOTICE`는 `attention` |
| **모름** — 요청이 나간 뒤의 시간 초과·끊김, 5xx | 커넥터가 멱등키를 지킨다고 밝혔으면 "닿지 않음"처럼 다시 보냅니다. 아니면(지금의 시뮬레이터) 다시 보내지 않고 곧바로 T19 — 기준이 첫 실패에 하던 것과 같습니다. **`transfer`는 어느 경우에도 다시 보내지 않습니다**(4.2절) |
| 서명이 맞지 않음, 응답이 다른 송금을 가리킴, 승인이 금액을 되풀이하지 않음, 승인 없이 전송하려 함, 예상하지 못한 `travel-rule` 상태, 정산주체가 등록돼 있지 않음(`no SETTLEMENT_ENTITY registered — provision demo-partners first`), 저장된 요청에 트래블룰 자료가 없음(`compliance payload absent from stored request`) | 곧바로 T19, 기준의 문장 그대로. 지갑의 답이 그런 경우는 4.2절 3번 (라)입니다 |
| **2xx인데 JSON이 아닌 응답** — 기준은 빈 객체로 읽습니다 | `settlement-notice` · `cancel`: 성공입니다(답을 읽지 않는 호출). `travel-rule`: T19, 기준의 문장 `unexpected travel-rule response: undefined`. `payout-approval`: T19, 이 서비스의 문장(기준은 런타임의 문장). `transfer`: 결과를 모름(4.2절) |
| 표에 없는 실패(버그, DB 오류 등) | 그 시도를 실패로 세고 `REMIT_STEP_RETRY_MS`로 다시. 다 쓰면 파이프라인·`SETTLEMENT_NOTICE`는 T19, 나머지는 `attention`. 그때 `EXCEPTION`의 `error`는 정해진 문장입니다: `the platform could not complete this step (internal error)`(런타임의 글을 내보내지 않습니다). **지갑의 검증된 결과를 받은 뒤의 실패는 작업을 다시 돌리지 않습니다**: 그 실행기가 T9(또는 "늦게 온 결과"의 기록)만 될 때까지 다시 쓰고, 쓰기 전에 서명된 결과를 로그에 남깁니다 |
| `RECONCILE` · `PACKAGE`가 안에서 실패 | 확정된 지급을 되돌리지 않습니다. 다시 시도하고, 다 쓰면 `attention`. 기준 구현은 로그만 남기고 멈춥니다 |

`SETTLEMENT_NOTICE`가 끝내 실패하면 기준처럼 T19입니다(`at_state: ONCHAIN_SETTLED`). 통지가 가지 않으면 수취기관이 지급을 시작하지 않으므로, 은행이 읽을 수 있는 신호가 있어야 합니다. 다만 그사이 수취기관의 콜백이 하나라도 와 있으면 통지는 닿은 것이므로 작업을 그냥 마칩니다.

`attention`에서 나오는 길은 운영 명령입니다(16장). 닫힌 작업이라 유일 키를 차지하지 않습니다.

## 4. 밖으로 나가는 호출

### 4.1 키, 본문, 제한 시간

파트너와 지갑으로 가는 모든 호출에 `Idempotency-Key` 헤더를 붙입니다. 키는 송금과 단계에서 정해지므로 다시 보내도 같은 키입니다. **본문도 같아야 합니다**: 보내는 쪽 서명(`sender`)은 만들 때마다 값이 달라지므로, 처음 만든 본문을 작업의 `input`에 적어 두고 다시 보낼 때는 그 바이트를 보냅니다. 지금의 파트너 시뮬레이터는 이 헤더를 읽지 않습니다 — 실제 파트너와의 계약에 넣을 항목입니다.

| 호출 | 키 | 결과를 모를 때 |
|---|---|---|
| `POST /bfi/travel-rule` | `<payment_id>:travel-rule` | 3.5절의 "모름" |
| `POST /bfi/travel-rule-response` | `<payment_id>:rfi:<rfi_id>` | 은행에 502(2.3절). 은행이 다시 답함 |
| `POST /bfi/payout-approval` | `<payment_id>:approval` | 3.5절의 "모름" |
| `POST /wallet/transfer` | `<payment_id>:transfer:<승인 이벤트 순번>` | **다시 보내지 않음**(4.2절) |
| `POST /bfi/settlement-notice` | `<payment_id>:notice:<tx_hash>` | 3.5절의 "모름" |
| `POST /bfi/cancel` | `<payment_id>:cancel` | 3.5절의 "모름"(끝은 `attention`) |

호출 하나의 제한 시간은 기준과 같은 20초입니다. 연결부터 본문을 다 읽을 때까지의 시한이고 연결 시한을 따로 두지 않습니다(`java.net.http`의 요청 시한은 응답 헤더까지만 세므로 `por/Reserves`가 하는 방식으로 전체를 묶습니다). 커넥터 인터페이스(`BfiConnector`, `SettlementWallet`)는 그대로 옮기고 두 가지를 더합니다: "이 커넥터는 멱등키를 지키는가"(시뮬레이터: 아니오), 그리고 지갑에 "이 키의 전송이 있었는가"(구현하지 않은 커넥터는 "모름").

`travel-rule-response`만 본문을 적어 두지 않습니다(2.3절: 작업이 아닙니다). 은행이 다시 답하면 같은 키에 다른 본문(새 JWE, 새 서명, 고친 답)이 갑니다. 실제 파트너와의 계약에는 "같은 키의 다른 본문은 오류가 아니다: 앞선 답을 이미 받았으면 그 결과를 돌려주고, 아니면 새 답으로 받는다"를 넣습니다.

**프로세스가 죽었다 살아난 뒤**, 임대가 끝난 작업을 다시 잡았을 때는 앞선 시도가 나갔는지 알 수 없습니다. 그때의 규칙:

- `TRAVEL_RULE`(T2는 됐고 응답 이벤트가 없음): 적어 둔 본문을 다시 보냅니다. 같은 암호문, 같은 digest입니다.
- `PAYOUT_APPROVAL`: 다시 보냅니다. 앞선 시도가 닿았던 것이라면 지금의 시뮬레이터는 409로 거절하고, 그러면 3.5절의 "거절"입니다(받지 못한 승인을 되찾을 길이 없습니다).
- `TRANSFER`: 4.2절.
- `SETTLEMENT_NOTICE`: 수취기관의 콜백이 하나라도 기록돼 있으면 보내지 않고 마칩니다. 없으면 다시 보냅니다.

### 4.2 지갑 호출은 한 실행기가, 한 번

전송 지시는 돈을 움직입니다. `SETTLEMENT_INSTRUCTED` 이벤트는 "어떤 지시인가"를 고정하고, 아래 규칙이 "누가, 몇 번 부르는가"를 고정합니다.

1. T8의 트랜잭션이 지시 이벤트를 쓰면서 작업에 `call_started_at`을 적고 임대를 갱신합니다. **그 트랜잭션을 커밋한 실행기만 지갑을 부르고, 한 번만 부릅니다.**
2. 지시는 있고 결과가 없는 작업을 **다른 누가 만나면**(재시작 뒤, 임대가 끝난 뒤, 전환 때의 인수) **절대 부르지 않습니다.** 커넥터에 조회가 있으면 키로 조회해 결과를 기록하고, 없으면(지금의 시뮬레이터) T19입니다. 앞선 임대가 끝난 뒤에만 그렇게 합니다.
3. 지갑의 답은 넷 가운데 하나로만 읽습니다. (가) 검증된 결과(정산주체의 서명이 맞고 이 송금을 가리킴) → T9. (나) 본문이 있는 거절(4xx이고 본문이 파트너의 JSON) → T19, 기준의 문장(`/wallet/transfer → HTTP <상태>: <문장>`). (다) 연결이 맺어지지 않음(요청이 나가지 않은 것이 확실함) → **다시 부르지 않고** 곧바로 T19, 4.3절의 `not reachable` 문장. 작업을 `attention`으로 두지 않습니다(움직인 돈이 없습니다). (라) 그 밖의 모든 것(시간 초과, 끊김, 5xx, JSON이 아닌 4xx, 읽을 수 없는 응답, 서명이 맞지 않거나 다른 송금을 가리키는 2xx) → 결과를 모름 → 다시 보내지 않고 T19, 작업은 `attention`.
4. 결과를 모를 때의 오류 문장: `the outcome of the wallet transfer is unknown — the instruction may have been sent and no verifiable result is on file (<원인>); it is not sent again, and a person has to confirm whether USDC moved`. `<원인>`에는 기준이 그 자리에 쓰던 문장을 넣습니다(`/wallet/transfer → HTTP 500: …`, `signature by … does not verify`, `wallet result names a different payment`, 시간 초과면 `no answer within 20 s`). 호출을 본 사람이 없는 경우(2번: 다른 실행기가 지시만 발견)는 `the executor stopped before a result was recorded`입니다.

기준 구현도 이 자리에서 `EXCEPTION`으로 끝납니다(전송 여부 모름). 달라지는 것은 재시작 뒤입니다: 기준은 손으로 `advance()`를 부르면 두 번째 지시를 만들어 다시 보내고, Java는 어떤 경로로도 두 번째 호출이 없습니다.

### 4.3 오류 문장

`EXCEPTION` 이벤트의 `error`는 사람만 읽는 글이 아닙니다. 두 SDK가 pacs.002의 `AddtlInf`에 옮겨 적고 콘솔이 사유로 보여 줍니다. 그래서 영어로, 정해진 문장으로 씁니다.

- 파트너의 거절: `<경로> → HTTP <상태>: <파트너의 message, 없으면 error, 없으면 partner error>` (기준 그대로).
- 파트너에 닿지 못함: `<경로>: partner simulator not reachable at <주소> — is demo-partners running? (<원인>)`. 괄호 안의 원인만 런타임이 달라 다릅니다(차이 목록에 적습니다). 재시도했으면 마지막 시도의 원인입니다.
- 그 밖에는 기준 구현이 `throw`하는 문장 그대로입니다(`travel rule rejected: …`는 T5a라서 `EXCEPTION`이 아닙니다). 표에 없는 실패가 끝내 남기는 문장은 3.5절의 정해진 문장입니다.

## 5. 콜백

`POST /v1/remit/callbacks`는 인증이 없고 서명이 인증입니다. 순서도 중복도 보장되지 않으므로 받는 쪽이 지킵니다.

**검사의 순서.**

1. 400 `missing_field`: `type`, `payload`와 `sig`, `payload.payment_id`.
2. 404 `payment_not_found`.
3. 서명: 400 `unknown_signer` → 400 `role_mismatch`(수취기관만) → 400 `invalid_signature`. **트랜잭션을 열기 전에** 검증합니다. 인증 없는 경로가 잠금을 쥐게 하지 않습니다.
4. 400 `unknown_callback_type`.
5. 송금 행을 잠급니다.
6. **중복을 먼저 봅니다**: 같은 종류에, 본문의 정규형(JCS)이 같은 이벤트가 이미 있으면 200 `{ "accepted": true }`로 답하고 아무것도 쓰지 않습니다. 서명 값으로 비교하지 않습니다 — 다시 서명하면 값이 달라집니다.
7. 그다음 기대 조건(2.1절의 T10 ~ T12b, T17)을 봅니다. 아니면 409 `wrong_state`이고 아무것도 쓰지 않습니다.

중복을 먼저 보는 이유: `USDC_RECEIVED`, `USDC_RETURNED`, 대사로 가는 `PAYOUT_COMPLETED`는 적용되는 순간 자기 기대 상태를 벗어납니다. 조건을 먼저 보면 답을 받지 못해 다시 보낸 같은 콜백이 409가 되고, 지금의 시뮬레이터는 400 이상을 받으면 그 송금의 나머지 콜백을 보내지 않습니다.

**완료 통보의 등급.** `evidence_level`이 없으면 `L2`로 읽습니다. 정확히 `L1`인 통보만 대기(T12)이고, 그 밖의 모든 값은 대사로 갑니다(T12b). 등급을 크기로 비교하지 않습니다.

**`L1` 뒤에 온 완료 통보.** 받습니다(T12b). 대사는 **그 통보의 영수증**으로 합니다(9장).

**대사 중에 온 또 다른 완료 통보**(본문이 달라 중복이 아닌 것)는 409 `wrong_state`이고 기록하지 않습니다. 완료 통보 하나의 대사가 끝난 뒤의 상태가 그 통보의 답입니다.

기준 구현은 어느 상태에서든 이벤트를 먼저 추가한 뒤 전이를 시도합니다. 그래서 종결된 송금이나 이미 지나간 단계에 온 콜백은 이벤트가 남은 채 500 `invalid_transition`으로 답해지고, 같은 콜백이 다시 오면 이벤트와 웹훅이 한 번 더 생기며, `PAYOUT_COMPLETED`가 두 번 오면 대사와 패키지가 두 번 돕니다. `USDC_RETURNED`는 확정되고 앵커까지 된 송금도 `RETURNED`로 옮깁니다.

## 6. 요청 멱등 (`Idempotency-Key` 헤더, 표 `remit_idempotency`)

- 요청 해시는 지금처럼 `JSON.stringify(파싱한 본문)`의 SHA-256입니다(`json/Js`). 기존 행과 같은 값이 나와야 합니다.
- 키는 8자 이상 191자 이하입니다. 191자를 넘으면 400 `invalid_idempotency_key`(문장: `the Idempotency-Key header is longer than 191 characters`)이고 아무것도 받지 않습니다.
- **표에는 끝난 202만 들어갑니다.** 거절은 저장하지 않으므로 같은 키로 다시 보내면 다시 판정합니다(기준과 같음). 은행 SDK와 데모가 키를 송금 id에서 만들기 때문에(`swift-<payment_id>` 등), 거절된 뒤 고쳐서 다시 보내는 요청은 같은 키에 다른 본문입니다. 그 요청이 통과해야 합니다.
- 조회는 두 번입니다. 맨 앞의 조회(기준과 같은 자리: 같은 해시면 저장된 응답, 다른 해시면 409 `idempotency_conflict`)와, T1의 트랜잭션 안에서 조직 행을 잠근 뒤의 조회입니다. 멱등 행은 T1의 성공 경로 맨 끝에 202와 그 본문으로 씁니다. "진행 중"을 나타내는 행은 없습니다 — 표의 열(`response_status`, `response_body`가 NOT NULL)로 나타낼 수 없고, 롤백 뒤 TypeScript 코어가 그런 행을 응답으로 내보내려다 실패합니다.

| 두 번째 요청 | 답 |
|---|---|
| 같은 본문, 첫 요청이 아직 처리 중 | 조직 행 잠금에서 기다렸다가 저장된 202 (기준: 409 `duplicate_payment`) |
| 같은 본문, 첫 요청이 202로 끝난 뒤 | 저장된 202 |
| 같은 본문, 첫 요청이 거절된 뒤 | 다시 판정 |
| 다른 본문, 첫 요청이 아직 처리 중 | 기다렸다가 409 `idempotency_conflict`(그때는 송금이 이미 조회됨) |
| 다른 본문, 첫 요청이 202로 끝난 뒤 | 409 `idempotency_conflict` |
| 다른 본문, 첫 요청이 거절된 뒤 | 다시 판정 |

## 7. 웹훅 발송

- **본문은 멤버 둘인 객체입니다**: `{ "envelope": { event_id, payment_id, sequence, type, state, occurred_at, data }, "signature": { alg, key_id, issuer, sig } }`. `signature`는 `envelope`에 대한 플랫폼 이벤트 서명입니다. 계약은 `openapi.json`의 `WebhookDelivery` · `WebhookEnvelope`이고 기준은 `webhook.ts`입니다. (v1과 인계 메모 3장은 이것을 한 층으로 적었는데, 그렇게 보내면 데모 은행이 400으로 거절하고 두 SDK의 `verifyWebhook`이 실패합니다.)
- 발송 행은 전이 트랜잭션 안에서 적재합니다(전이는 일어났는데 웹훅이 없는 경우가 없도록). `body`는 보낼 글자 그대로이고 `next_attempt_at`은 기준처럼 문자열 시각입니다.
- 발송은 기준과 같습니다: 2xx면 `delivered`, 실패하면 2초 · 10초 · 30초 · 2분 · 10분, `REMIT_WEBHOOK_MAX_ATTEMPTS`에서 `exhausted`, 한 주기에 20건, 제한 시간 5초, `created_at` 순.
- 발송은 한 건씩입니다: 보내고, `WHERE id = ? AND status = 'pending' AND attempts = ?`로 결과를 씁니다. HTTP 호출 동안 트랜잭션을 열어 두지 않습니다. 건 사이에 `remit` 임대를 갱신합니다. 임대가 넘어가는 순간 두 인스턴스가 같은 행을 보낼 수 있고, 그것은 "한 번 이상"이라는 약속 안입니다(받는 쪽은 `event_id`로 중복을 거릅니다).

## 8. 워커와 실행기

- 송금 레일은 `REMIT_ENABLED`가 켜진 배포에만 있습니다. 꺼져 있으면 경로도, 실행기도, 워커도 없습니다.
- **실행기**: 프로세스마다 작은 스레드 풀 하나. 바로 실행과 프로세스 안 재시도가 여기서 돕니다. 워커 임대와 무관합니다.
- **주기 워커**: `WORKER_TICK_MS`가 0보다 크면 2초 주기(값과 무관하게 2초: 기준과 같음). `worker_leases`의 `remit`을 잡은 인스턴스만 3.4절의 일을 합니다. 잡은 작업의 실행은 실행기에 넘기고, 주기 스레드에서는 T16과 웹훅 발송만 합니다.
- 내릴 때: 실행기는 새 작업을 받지 않습니다. **T8을 커밋하고 T9를 쓰지 않은 실행기는 그 호출과 T9가 끝날 때까지 기다립니다**(최대 20초와 전이 한 번. 프로세스 관리자의 종료 대기 시간을 그보다 길게 둡니다: 30초). 그 밖의 호출은 기다리지 않고, 임대가 끝나면 워커가 이어받습니다(4.1절).

## 9. 증빙: 대사와 패키지

- **대사(`RECONCILE`)는 자기를 일으킨 완료 통보를 읽습니다.** 은행의 세 요소는 `BANK_EVIDENCE_SUBMITTED`에서, 트래블룰 요소는 `PAYOUT_ACCEPTED`에서, 체인 전송 요소는 `USDC_TRANSFER_CONFIRMED`에서, 지급 영수증은 **작업의 `input`이 가리키는 `PAYOUT_COMPLETED`**에서 꺼냅니다. T13의 웹훅에 싣는 `bank_reference`도 그 통보의 것입니다. 기준은 언제나 첫 `PAYOUT_COMPLETED`를 읽어서, `L1` 뒤에 서명된 통보가 와도 서명 없는 첫 영수증으로 대사해 `EXCEPTION`으로 끝납니다(13장). T13의 웹훅에 싣는 `evidence_level`도 그 통보의 것이고, T13은 `evidence_level` 열을 그 값으로 맞춥니다.
- 요소의 digest를 다시 계산해 `digestVerified`를 붙이고, 레지스트리의 키링(신뢰 수준 `ATTESTED`)으로 서명을 검증하고, `remit-corridor-v1` 정책으로 평가합니다(SDK의 `Rules`). 통과 조건과 샌드박스 허용(`REMIT_ACCEPT_DEMO_FINALITY`)은 `evidence.ts`의 `reconcilePayment` 그대로입니다.
- **패키지는 대사가 쥐고 있던 것으로 만듭니다.** 대사는 레지스트리를 한 번 읽어 키링과 스냅샷을 함께 만들고, 검증한 증빙과 그 스냅샷을 `PACKAGE` 작업의 `input`에 넘깁니다. `PACKAGE`가 나중에 다시 시도되거나 은행이 그사이 서명키를 바꿔도, 패키지 안의 서명 검증 결과 · 판정 · 레지스트리는 같은 순간의 것입니다.
- 패키지 조립은 T15의 트랜잭션 안, 송금 행 잠금 아래입니다. 패키지에 담기는 이벤트 목록은 그 순간까지의 것(`EVIDENCE_COMMITTED`는 그 뒤에 추가되므로 담기지 않음: 기준과 같음), `state`는 `BENEFICIARY_CREDIT_CONFIRMED`입니다. 앵커 발급도 같은 트랜잭션입니다(준비금 증명의 S-17과 같은 방식). 앵커 기록의 설명(`{ kind: "remit-evidence", payment_id, schema }`)은 `attestations.descriptor` 열에 들어갑니다(`metadata`라는 열은 없습니다).
- **`package_json`은 기준의 멤버 순서로 저장합니다**(`schema`부터 `generated_at`까지, 판정의 축은 엔진의 순서). 정규형(JCS)은 커밋을 계산할 때만 씁니다. 저장한 글자가 그대로 `GET /v1/settlements/:id/evidence`로 나가고, 순서를 보는 검증기가 있습니다(데모 은행).
- 커밋: `SHA-256("STONEHASH-EVIDENCE-V1" ‖ nonce 32바이트 ‖ JCS(패키지))`. SDK의 `Conventions.commitment`.

## 10. 레지스트리, 플랫폼 키, 뜰 때 하는 일

- **플랫폼 서명키**는 파일입니다(`REMIT_PLATFORM_KEY_PATH`, 기본 `${STONEHASH_DATA_DIR}/platform-remit-key.pem`, PKCS8 P-256). keyId는 `STONEHASH-SIGN-`에, 공개키 SPKI의 **base64 글자**(바이트가 아니라 그 글자열)를 SHA-256한 hex의 앞 8자리를 붙인 값입니다. 기준이 만든 키 파일을 읽어 같은 keyId가 나오는지 벡터와 대조로 확인합니다. 파일이 없으면: 시험용 저장소에서는 기준처럼 새로 만들고, **운영 저장소(전환 승인 표시로 뜬 서버)나 `STONEHASH_ENV=live`에서는 만들지 않고 기동을 멈춥니다.** 경로가 틀려 새 키가 생기면 keyId가 바뀌고 이전 서명을 플랫폼 키로 확인할 수 없게 됩니다.
- **"뜰 때"는 `serve`가 서버를 올릴 때입니다.** 키 파일을 만드는 일과 아래의 기관 행을 쓰는 일은 그때만 합니다. `routes`를 비롯한 명령, 그리고 테스트가 쓰는 배선은 키 파일을 만들지도 행을 쓰지도 않습니다(키가 필요한 명령은 없는 파일을 오류로 답합니다).
- **플랫폼 자신의 기관 행**(`STONEHASH`): 뜰 때 읽어 보고, 없거나 서명키가 지금의 키와 다르면 기준과 같은 내용으로 씁니다. 뜰 때 저장소에 쓰는 것은 이 한 행뿐입니다. `GET /v1/remit/meta`와 모든 증빙 패키지의 레지스트리 스냅샷이 이 행을 싣습니다. **운영 저장소나 `STONEHASH_ENV=live`에서는 행이 있는데 그 서명키가 파일의 키와 다르면 쓰지 않고 기동을 멈춥니다**(경로가 다른 키 파일을 가리킨 것일 수 있습니다). 키를 정말 바꾸는 일은 명령 `register-platform-key`로 합니다(16장).
- 레지스트리의 나머지(`institution`, `list`, `upsert`, 키링, 스냅샷, `requireRemit`)를 `console/ProductRegistry`가 가진 것에 더합니다. 키링에서 변환되지 않는 키를 가진 기관은 빼고 로그에 id만 남깁니다(기준과 같음). "변환되지 않는다"는 기준의 런타임이 그 SPKI를 JWK로 바꾸지 못한다는 뜻이고, 그 판정을 벡터로 옮깁니다 — SDK의 키링에 그대로 넣으면 그 기관의 서명이 `UNKNOWN_KEY`가 아니라 `INVALID`로 읽혀 패키지에 다른 판정이 남습니다. `upsert`는 기준의 의미를 따릅니다: 조직 id를 주지 않으면 기존 값을 두고, 서명키와 암호화 키는 준 것만 바꾸며, 권한 목록이 없으면 `[]`입니다(지금의 `ProductRegistry.upsert`는 조직을 떼어 냅니다).
- 뜰 때 하지 않는 것: 전문 참조 채우기(`backfillSourceRefs`). 전환 전 점검 쿼리로 대상이 0건임을 확인합니다(인계 메모 1.1).

## 11. 그 밖의 경로

작업 큐와 무관한, 요청 하나로 끝나는 경로입니다. 기준의 동작 그대로 옮깁니다.

- `GET /v1/remit/meta`, `POST /v1/remit/registry/institutions`, `POST /v1/remit/registry/deactivate`(관리 토큰).
- `POST /v1/quotes`: 견적은 고정소수 문자열 연산(`quotes.ts`). `BigDecimal`의 `HALF_UP`, 글자는 `toPlainString()`.
- `GET /v1/settlements`(검색 `q`, 정확 조회 `source_*`, 상태, 기간, 커서), `GET /v1/settlements/:id`. `q`의 이벤트 본문 검색은 지금의 MySQL `JSON_EXTRACT` 문장을 매퍼에 그대로 둡니다(MySQL 분기). 참조번호 색인 표는 다른 DB 제품에 올릴 때 만듭니다.
- `GET /v1/settlements/:id/chain`: 정산 체인 노드에 읽기 네 번(`chain-status.ts`). 오류 글은 절대 그대로 내보내지 않습니다.
- `GET /v1/settlements/:id/evidence`.
- `POST /v1/manifests/daily`, `GET /v1/manifests/daily`: 비교 → 플랫폼 서명 → 커밋을 앵커로 발급(같은 커밋이 이미 있으면 그 기록을 씀) → 조직·날짜당 한 행(다시 내면 바뀜). 발급과 행 쓰기는 한 트랜잭션입니다. 앵커 기록의 설명은 `{ kind: "remit-manifest", date }`입니다.

## 12. 통과해야 하는 것

지시서 5단계의 완료 조건입니다. MySQL에서 돌립니다.

- **벡터**(기준 코드가 낸 답): 견적 산술과 거절, 전문 참조 읽기와 쌍둥이 키, 전문 충돌의 순서열(기준의 실제 저장소를 MySQL에서 돌린 결과와 두 표의 행), 요청 해시, 거절 문장, 필드 진술 검사, 대사·패키지·커밋(기록된 이벤트 로그에 대해), 체인 조회의 답, 웹훅 본문과 간격.
- **시험 서버는 운영의 어느 것에도 닿지 못합니다.** 설정이 비어 있으면 기본값이 운영 주소입니다(`REMIT_PARTNERS_BASE` → 운영 시뮬레이터, `REMIT_CHAIN_RPC` · `POR_CHAIN_RPC` → 운영 체인 노드). `tools/check-test-env.mjs`가 이 키들이 있고 대역을 가리키는지 확인하고, 대조 스크립트와 기준 서버 실행 도구가 시작 전에 부릅니다.
- **응답 대조**: 레일의 모든 경로 — 접수의 모든 거절, 견적, 조회·목록·검색, 증빙, 일별 대사, 취소, RFI 답변, 콜백 — 를 기준 서버와 맞댑니다. 대조용 Java 서버는 `REMIT_STEP_RETRY_MS=off`(재시도 없음)로 띄워 기준과 같은 시점에 `EXCEPTION`이 되게 하고, 파트너 자리에는 서버마다 대역을 둡니다. 두 서버는 플랫폼 키 파일 하나를 같이 씁니다(기준의 코드로 만든 파일): `GET /v1/remit/meta`가 같아야 하고, 한쪽이 서명한 것을 다른 쪽이 검증할 수 있습니다.
- **흐름 대조**: 같은 각본(정상 모드 A·B, RFI와 답변, RFI 뒤 거절, 트래블룰 거절, 취소, `L1`, 지급 실패와 반환, 대사 실패, 호출 자리마다의 4xx·5xx·시간 초과)을 두 서버에 돌려 원장을 맞댑니다: 이벤트의 종류·발행자·본문 모양, 웹훅의 종류·순번·상태·본문, 파트너가 받은 요청.
- **병렬 전이**: 같은 송금에 취소와 승인 결과를 동시에 — 하나만 성공하고, 취소가 이기면 전송이 없음.
- **워커 둘**: 같은 작업을 둘이 실행하지 않음. 임대가 끝난 뒤의 인수에서도 지갑 호출은 한 번.
- **중간 재시작**: 결과 트랜잭션 뒤에서 멈춘 것은 다시 띄우면 끝까지 감. 호출과 그 결과 사이에서 멈춘 것은 4.1절대로(트래블룰: 이어 감. 승인: 지금의 시뮬레이터에서는 `EXCEPTION`. **전송: 다시 보내지 않고 `EXCEPTION`**). 워커를 끈 경우도 봅니다.
- **콜백**: 중복(같은 본문, 다른 서명)은 200이고 다시 쓰지 않음, 순서가 뒤바뀐 것은 409, 5장의 검사 순서.
- **동시 접수**: 연결 8개가 같은 전문을 동시에 — 송금 1건(기준 테스트 `mysql-parity.test.ts`의 마지막 소테스트와 같은 사례), 같은 멱등키의 동시 요청, 거절 뒤 같은 키의 재접수.
- **평문**: T2 뒤에는 어느 흐름에서도 `request_body`에 `compliance_plaintext`가 없음.
- **두 SDK와 데모**: Java가 보낸 웹훅이 두 SDK의 `verifyWebhook`을 통과, Java가 만든 증빙이 두 SDK의 재검증과 데모 은행의 검증(축 순서를 봄)을 통과. `smoke-remit` · `smoke-exceptions`를 두 번째 데모 세트로.

## 13. 밖에서 달라 보이는 것

구현하면서 `docs/JAVA-INTENDED-DIFFERENCES.md`에 번호를 붙여 옮깁니다.

| 상황 | TypeScript | Java |
|---|---|---|
| 취소와 승인이 겹침 | 취소가 승인으로 덮이고 전송이 나갈 수 있음 | 먼저 커밋한 쪽만 성공 |
| 파트너에 연결이 되지 않음 | 첫 실패에 `EXCEPTION` | 같은 키로 세 번까지 다시 시도한 뒤 `EXCEPTION`(문장의 괄호 안 원인이 다름). 지갑 호출은 다시 하지 않습니다: 첫 실패에 `EXCEPTION` |
| 파트너의 4xx · 5xx · 응답 없음 | 첫 실패에 `EXCEPTION` | 같음(멱등키를 지키는 커넥터에서만 5xx · 응답 없음을 다시 시도) |
| 지갑 전송의 응답을 받지 못함 | `EXCEPTION`, 파트너 오류 문장 | `EXCEPTION`, "결과를 모름" 문장. 어떤 경로로도 다시 보내지 않음 |
| 전제 상태가 아닌 콜백 | 전이가 거절되는 경우(종결된 송금, 뒤로 가는 전이)는 이벤트를 추가한 뒤 500 `invalid_transition`. 전이가 없는 종류(`PAYOUT_SUBMITTED`, `PAYOUT_FAILED`, `L1` `PAYOUT_COMPLETED`)와 같은 상태로의 전이(`PAYOUT_IN_PROGRESS`에서 다시 온 `USDC_RECEIVED`, 확정 뒤의 두 번째 완료 통보)는 어느 상태에서든 이벤트와 웹훅을 쓰고 200. 앞으로 가는 전이는 적용 | 409 `wrong_state`, 아무것도 쓰지 않음 |
| 같은 콜백이 다시 옴 | 이벤트와 웹훅이 한 번 더 | 200, 다시 쓰지 않음 |
| `L1` 뒤에 서명된 완료 통보가 옴 | 첫(서명 없는) 영수증으로 대사해 `EXCEPTION` | 그 통보의 영수증으로 대사 |
| 대사가 안에서 실패 | 콜백에 500, 그 상태에 멈춤 | 콜백에 200, 다시 시도, 한도 뒤 사람에게 알림 |
| 패키지 조립이 실패 | 콜백에 200, 로그만 남기고 그 상태에 멈춤 | 콜백에 200, 다시 시도, 한도 뒤 사람에게 알림 |
| 191자를 넘는 멱등키 | 송금을 받은 뒤 500 | 400 `invalid_idempotency_key`, 받지 않음 |
| 대사 중에 온 또 다른 완료 통보 | 이벤트를 추가하고 대사를 한 번 더 | 409 `wrong_state` |
| 취소의 응답 | 수취기관 통지가 끝난 뒤(최대 20초) | 취소를 커밋한 즉시. 통지는 뒤에서, 실패하면 다시 |
| 겹친 RFI 답변, 늦은 쪽이 거절됨 | 먼저 수락된 송금이 취소됨 | 409 `already_resolved`, 송금은 그대로 |
| 같은 멱등키·같은 본문의 동시 요청 | 409 `duplicate_payment` | 저장된 202 |
| 종결될 때 남아 있던 평문 | 그대로 둠(트래블룰 구간에 닿기 전에 끝난 송금) | 지움 |
| 코어 재시작 | 구간 사이의 송금이 멈춤 | 파이프라인 구간은 이어서 진행. 통지 뒤 콜백이 오가는 동안 내려가 있으면 그 콜백은 잃습니다(기준과 같음: 수취기관은 한 번만 보냅니다) |
| 접수를 멈추는 설정 | 없음 | `REMIT_INTAKE_PAUSED=1`이면 견적과 접수가 503 `intake_paused` |
| 지갑이 5xx로 답하거나 검증되지 않는 답을 줌 | `EXCEPTION`, 그 문장(`/wallet/transfer → HTTP 500: …` 등) | `EXCEPTION`, "결과를 모름" 문장(괄호 안에 그 문장) |
| 같은 멱등키 · 다른 본문 · 같은 송금 id의 동시 요청 | 409 `duplicate_payment` | 409 `idempotency_conflict` |
| `EXCEPTION`으로 끝난 뒤 도착한 지갑 결과 | 없음(재시작 뒤의 일) | `EXCEPTION` 뒤에 `USDC_TRANSFER_CONFIRMED` 이벤트와 `chain_tx`가 붙음. 웹훅은 없음 |
| 다섯 번 잡히고도 끝나지 않은 작업 | 없음 | `EXCEPTION`, `the step did not complete after 5 attempts` |
| 기준이 던지지 않는 안쪽 실패(DB 오류 등) | 첫 실패에 `EXCEPTION`, 런타임의 문장 | `REMIT_STEP_RETRY_MS`만큼 다시 시도한 뒤 `EXCEPTION`, 정해진 문장 |
| 파트너가 받는 요청 | 헤더 없음, 호출마다 한 번 | `Idempotency-Key` 헤더. 재시작 뒤에는 `travel-rule` · `payout-approval` · `settlement-notice`가 한 번 더 갈 수 있음 |

## 14. 전환할 때 끝나지 않은 송금

기준 구현이 남긴 비종결 송금에는 작업 행이 없습니다. 전환 절차에서 한 번 실행하는 명령 `adopt-settlements`를 둡니다(부팅 작업이 아닙니다). 기본은 보고만 하고, `--apply`를 주어야 씁니다. 두 번 실행해도 됩니다: 열린 작업이 이미 있는 송금에는 만들지 않습니다.

상태와 이벤트를 함께 보고 정합니다. **로그에 `CANCEL_REQUESTED` · `TRAVEL_RULE_REJECTED` · `EXCEPTION`이 있는데 상태가 그렇지 않은 송금에는 어떤 작업도 만들지 않습니다**(기준의 알려진 덮어쓰기가 만든 행일 수 있습니다).

| 남은 모습 | 하는 일 |
|---|---|
| `BANK_AUTHORIZED`, 트래블룰 행 없음 | 작업 `TRAVEL_RULE` |
| `TRAVEL_RULE_PENDING`, `TRAVEL_RULE_RECEIVED`가 있고 `PAYOUT_ACCEPTED`가 없음 | 작업 `PAYOUT_APPROVAL` |
| `TRAVEL_RULE_PENDING`, 풀리지 않은 RFI | 없음(은행의 답을 기다림) |
| `PAYOUT_PRE_APPROVED`, 지시 없음 | 작업 `TRANSFER` |
| `L1` 대기: `EVIDENCE_INSUFFICIENT`가 있고 `L1`이 아닌 `PAYOUT_COMPLETED`가 하나도 없음(상태는 `PAYOUT_IN_PROGRESS`나 `ONCHAIN_SETTLED`) | 없음(더 나은 확인을 기다림). `L1`이 아닌 완료 통보가 있는데 `SETTLEMENT_RECONCILED`가 없으면 "그 밖의 모습"입니다 |
| `BENEFICIARY_CREDIT_CONFIRMED`, 앵커 있음 | 없음(워커가 T16) |
| **그 밖의 모든 모습** — `BANK_AUTHORIZED`인데 트래블룰 행이 이미 있음, `TRAVEL_RULE_PENDING`인데 응답 이벤트가 없음, 지시는 있고 결과가 없는 `PAYOUT_PRE_APPROVED`, `ONCHAIN_SETTLED`, 대사되지 않은 완료 통보, 앵커 없는 `BENEFICIARY_CREDIT_CONFIRMED` 등 | **작업을 만들지 않고 송금마다 보고합니다.** 기준이 호출 도중 멈춘 자리라서 무엇이 나갔는지 알 수 없습니다. 사람이 보고 정합니다 |

**전환의 전제는 "그 밖의 모습"이 0건인 것입니다.** 2026-11-19 운영 스키마의 비종결 송금은 9건이고(읽기 전용 조회), 모두 그대로 넘겨도 되는 모습입니다: `PAYOUT_IN_PROGRESS` 7건은 전부 `L1` + `EVIDENCE_INSUFFICIENT`, `TRAVEL_RULE_PENDING` 2건은 전부 답하지 않은 RFI. 상태와 로그가 어긋난 행, 평문이 남은 행은 없습니다. 전환 직전에 다시 확인합니다.

`remit_idempotency`는 비우지 않고 그대로 넘깁니다. 해시가 같은 방식으로 계산되므로 전환을 걸친 재시도도 저장된 응답을 받습니다(벡터로 확인).

## 15. 롤백할 때 끝나지 않은 송금

TypeScript 코어는 `remit_jobs`를 읽지 않고, 멈춘 송금을 이어 가는 길이 없습니다. 그래서 롤백은 **Java에서 다 흘려보낸 뒤**에 합니다. 명령 `drain-settlements`가 아래를 보고하고, 5번이 0건일 때만 `--close-jobs`로 남은 작업을 닫습니다.

1. `REMIT_INTAKE_PAUSED=1`로 Java를 다시 띄워 새 견적과 접수를 멈춥니다(조회, 취소, RFI 답변, 콜백은 그대로 받습니다).
2. 열린 작업(`queued` · `running` · `waiting`)이 0건이 될 때까지 기다립니다.
3. `attention` 작업을 Java에서 정리합니다(16장).
4. `ONCHAIN_SETTLED`와 콜백이 오가는 중인 송금이 0건이 될 때까지 기다립니다. 두 코어가 모두 내려가 있는 동안 온 콜백은 사라집니다(수취기관은 한 번만 보냅니다).
5. 상태와 이벤트로 분류해(작업 표가 아니라) 다음이 모두 0건인지 봅니다: `BANK_AUTHORIZED`, 열린 RFI가 없는 `TRAVEL_RULE_PENDING`, `PAYOUT_PRE_APPROVED`, `ONCHAIN_SETTLED`, `L1` 대기가 아닌 `PAYOUT_IN_PROGRESS`, 앵커 없는 `BENEFICIARY_CREDIT_CONFIRMED`.
6. Java를 내립니다(조회 · 취소 · RFI 답변 · 콜백을 받는 동안에는 2번과 5번의 "0건"이 읽은 순간에만 참입니다).
7. 서버 없이 `drain-settlements`를 다시 실행합니다(명령은 저장소만 읽습니다). 5번이 여전히 0건이고 열린 작업이 없으면 `--close-jobs`로 닫고 TypeScript 코어를 띄웁니다. 아니면 Java를 다시 띄워 2번부터 합니다. `--close-jobs`는 임대가 살아 있는 `running` 작업이 있으면 거절합니다.

그대로 넘어가도 되는 것: 열린 RFI, `L1` 대기, 앵커가 있는 `BENEFICIARY_CREDIT_CONFIRMED`, 발송 대기 웹훅(본문이 같은 모양이라 TypeScript 코어가 그대로 보냅니다). **`SETTLEMENT_INSTRUCTED`가 있는 송금에 손으로 `advance()`를 부르지 않습니다** — 두 번째 지시가 나갑니다. 여기서 "`L1` 대기"는 14장의 정의입니다(`L1`이 아닌 완료 통보가 하나도 없음). Java를 띄울 수 없어서 하는 롤백에서는 작업을 닫지 않습니다: 5번의 송금은 TypeScript 아래에서 멈춰 있고, Java가 돌아오면 남아 있던 작업이 3.2절과 4장의 규칙대로 이어집니다.

## 16. 운영 명령

`serve` · `migrate` · `baseline` · `routes` · `backfill-snapshot-keys`에 더합니다. 모두 저장소만 읽고 쓰며 밖을 부르지 않습니다.

| 명령 | 하는 일 |
|---|---|
| `adopt-settlements [--apply]` | 14장 |
| `drain-settlements [--close-jobs]` | 15장 |
| `remit-jobs` | 닫히지 않은 작업과 `attention` 작업의 목록(송금, 종류, 상태, 시도 횟수, 마지막 오류) |
| `remit-job-requeue <id>` | `attention`인 `PACKAGE` · `CANCEL_NOTICE` · `RECONCILE` 작업을 다시 `queued`로: `attempts`를 0으로, `last_error`를 비웁니다. 그 송금의 같은 갈래에 열린 작업이 있으면 거절합니다. 파이프라인 작업에는 쓰지 못합니다(그 송금은 이미 `EXCEPTION`입니다) |
| `remit-job-close <id> <메모>` | 사람이 확인을 마친 `attention` 작업을 `done`으로, 메모를 `last_error`에 남깁니다. 결과를 모르는 `TRANSFER`가 목록에서 빠지는 길입니다 |
| `register-platform-key` | 플랫폼 자신의 기관 행을 지금 키 파일의 키로 씁니다. 운영 저장소에서 키를 바꿀 때만 씁니다(10장) |

결과를 모르는 지갑 전송을 사람이 확인한 뒤 결과를 손으로 기록하는 명령은 만들지 않았습니다. 실제 정산주체의 조회 API가 정해지면 커넥터의 조회로 들어갈 자리입니다.

## 17. 새 표와 새 설정

- 표: `remit_jobs` 하나(마이그레이션 3번). 추가만 합니다. 콜백 중복은 이벤트 표로 판단하므로 표가 필요 없습니다.
- 설정 둘:
  - `REMIT_STEP_RETRY_MS`: 닿지 않은 호출과 안에서 실패한 작업을 다시 시도하는 간격의 목록(밀리초, 쉼표로 구분). 기본 `2000,10000,30000`. `off`면 다시 시도하지 않습니다(첫 실패에 끝: 기준과 같은 시점). 빈 값은 다른 설정처럼 기본값입니다.
  - `REMIT_INTAKE_PAUSED`: `1`이면 `POST /v1/quotes`와 `POST /v1/settlements`가 503 `intake_paused`. 기본 꺼짐. 503은 인증 · 구독 · `Idempotency-Key` 확인 · 멱등 조회 **뒤에** 답합니다: 저장된 202는 멈춘 동안에도 그대로 돌려줍니다(202를 받지 못해 다시 보내는 은행).
- 문서: 전환할 때 `apps/docs/openapi.json`에 새 답을 더하고 문서 대조 테스트를 맞춥니다 — `POST /v1/remit/callbacks`의 409 `wrong_state`, `POST /v1/quotes` · `POST /v1/settlements`의 503 `intake_paused`, `POST /v1/settlements`의 400 `invalid_idempotency_key`. 운영 코어가 TypeScript인 동안에는 게시하지 않습니다.

## 18. 이 문서가 정하지 않은 것

- **송금 id를 조직 범위로.** 지금은 전역 기본 키라 다른 조직의 id와 겹치면 409로 그 존재가 드러납니다. 기본 키를 바꾸는 일이라 롤백 기간 뒤로 미룹니다.
- **실제 파트너의 조회 API와 멱등키 지원.** 계약 사항입니다. 수취기관이 자기 입금 주소를 직접 보다가 `USDC_RECEIVED`를 T9보다 먼저 보내면 409 `wrong_state`를 받습니다 — 다시 보내 달라는 약속도 계약에 넣을 항목입니다(지금의 시뮬레이터는 통지를 받은 뒤에만 콜백을 보냅니다).
- **확정된 뒤의 반환.** `USDC_RETURNED`가 `BENEFICIARY_CREDIT_CONFIRMED` 뒤에 오면 Java는 409로 거절하고 기록하지 않습니다. 서명된 사실을 상태 변경 없이 기록할지는 실제 파트너와의 정산 절차가 정해질 때 다시 봅니다.
- **원장.** 고객 자금의 보관 주체가 정해진 뒤 별도 관문으로 설계합니다(지시서 4장 5번).

## 19. 소유자에게 알릴 선택

이 판에서 실행 세션이 기본값으로 정한 것입니다. 바꾸라고 하면 바꿉니다.

1. **`L1` 뒤에 온 서명된 완료 통보로 송금을 확정합니다**(기준은 `EXCEPTION`). `EVIDENCE_INSUFFICIENT` 이벤트 자신이 "서명된 확인을 다시 받으라"고 안내하므로, 그 확인이 왔을 때 확정되는 쪽이 의도에 맞다고 봤습니다. 운영 스키마의 `L1` 대기 7건이 이 규칙의 대상입니다.
2. **파트너에 연결이 안 될 때만 다시 시도합니다**(2 · 10 · 30초). 지갑 호출은 제외입니다: 무슨 일이 있어도 한 번만 부릅니다. 응답 없음과 5xx는 지금의 시뮬레이터가 같은 요청을 두 번 받으면 거절하거나 지급을 두 번 시작하므로, 기준처럼 첫 실패에 `EXCEPTION`입니다.
3. **취소는 통지를 기다리지 않고 바로 답합니다.**
4. **접수 일시 정지 설정**(`REMIT_INTAKE_PAUSED`)을 더했습니다. 롤백 절차에 필요합니다.
