# 응답 대조 (parity)

같은 요청을 두 서버 — 기준(TypeScript 코어)과 Java 코어 — 에 보내 응답을 맞댑니다. 운영 `:8787`과 운영 스키마는 쓰지 않습니다. 두 서버는 각자의 임시 스키마(`stonehash_test_coreref`, `stonehash_test_corejava`)에 붙고 워커는 꺼 둡니다.

**대조용 서버는 둘 다 지갑이 없습니다.** 기준 서버는 처음부터 노드에 없는 지갑 이름(`attest-ref`)을 썼고, Java 서버도 그렇게 띄웁니다(`.env.parity`: `.env.dev`와 같고 `BITCOIND_WALLET`만 노드에 없는 이름. `tools/make-parity-env.mjs`가 노드에 그 이름의 지갑이 없는지 확인하고 씁니다). 인스크립션 경로의 경우는 모두 거절이어야 하지만, 규칙을 일부러 깬 빌드로 대조하면 그 거절이 사라질 수 있습니다. 돈을 낼 수 있는 지갑을 쥔 서버라면 그때 문서가 실제로 체인에 올라갑니다(한 번 그랬습니다). 지갑이 없으면 서비스의 검사를 무엇이 빠져나가든 노드에서 끝납니다.

**대조용 서버는 둘 다 준비금 체인의 실제 노드를 읽지 않습니다.** 준비금 측정(`eth_call`)이 가는 곳은 설정 `POR_CHAIN_RPC`이고, 적지 않으면 이 장비의 실제 노드(`127.0.0.1:8545`)가 기본값입니다. 이 모듈의 시험용 설정 파일(`.env.*`)에는 모두 `POR_CHAIN_RPC=http://127.0.0.1:8793/`을 적어 두었습니다(`tools/set-test-env.mjs`: 이 모듈의 설정 파일에서 키 하나를 바꾸는 도구). 그 주소에는 대역 노드(`tools/stand-in-eth-rpc.mjs`)를 띄웁니다: `eth_call` 하나만 받아 표에서 답하고(토큰 컨트랙트 주소가 답의 종류를 정하고, 잔고는 주소에서 계산), 받은 요청을 보낸 쪽별로 기억합니다. 띄우지 않으면 두 서버 모두 `fetch failed`로 같게 답하므로 대조는 통과하지만 확인하는 것이 줄어듭니다.

## 순서

두 서버가 모두 내려가 있는 상태에서 시작합니다. 매번 처음부터 다시 합니다: 속도 제한의 횟수와 무료 티어 조직의 id를 서버가 메모리에 들고 있어서, 떠 있는 서버를 두고 다시 심거나 다시 대조하면 두 서버의 상태가 어긋납니다.

**한 번에 돌리기.** 아래 0-1번부터 4-1번까지를 `tools/run-parity.sh`가 순서대로 합니다(jar는 먼저 빌드해 둡니다). 포트 8790·8791·8793과 파트너 대역의 3301·3302 가운데 하나라도 쓰이고 있으면 시작하지 않고, 어느 단계에서 실패하든 자기가 띄운 프로세스만 프로세스 번호로 내립니다. 로그는 준 폴더에 남습니다. `--` 뒤의 인자는 `run.mjs`로 갑니다(그때는 감사·기관·스냅샷 비교를 건너뜁니다).

```
apps/core-java/tools/run-parity.sh /tmp/parity-logs --sealing
apps/core-java/tools/run-parity.sh /tmp/parity-logs -- --only "por:"
```

```
cd attest

# 0. (한 번) 대조용 Java 서버의 설정 파일: .env.dev에서 지갑 이름만 노드에 없는 것으로.
node apps/core-java/tools/make-parity-env.mjs apps/core-java/.env.dev apps/core-java/.env.parity

# 0-1. 준비금 체인의 대역 노드를 띄웁니다 (:8793, 루프백만). 대조가 끝날 때까지 둡니다.
node apps/core-java/tools/stand-in-eth-rpc.mjs

# 0-2. 송금 레일의 파트너 대역을 띄웁니다: 서버마다 리스너 하나 (3301 → Java, 3302 → 기준). 아래 「송금 레일」 절.
node apps/core-java/tools/stand-in-partner.mjs --listen 3301=http://127.0.0.1:8790 --listen 3302=http://127.0.0.1:8791

# 1. 두 스키마에 같은 기록을 넣습니다 (기준 코어의 코드로 만들어 그대로 복사).
node apps/core-java/tools/seed-reference.mjs apps/core-java/.env.ref apps/core-java/.env.parity

# 1-1. Java 쪽: 서명키 열이 생기기 전의 스냅샷에 키를 채웁니다. 기준은 뜰 때 스스로 합니다 (S-16). 심은 4행 중 1행.
(cd apps/core-java && /usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar target/stonehash-attest-core-0.1.0.jar --env-file=.env.parity backfill-snapshot-keys)

# 2. 두 서버를 띄웁니다.
node apps/core-java/tools/run-reference-core.mjs apps/core-java/.env.ref                 # :8791
(cd apps/core-java && /usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar target/stonehash-attest-core-0.1.0.jar --env-file=.env.parity serve)   # :8790

# 3. 대조합니다.
node apps/core-java/parity/run.mjs                      # 응답
node apps/core-java/tools/compare-audit.mjs apps/core-java/.env.ref apps/core-java/.env.parity      # 감사 기록
node apps/core-java/tools/compare-registry.mjs apps/core-java/.env.ref apps/core-java/.env.parity   # 기관·구독 표 (제품 경로가 쓴 것)
node apps/core-java/tools/compare-por.mjs apps/core-java/.env.ref apps/core-java/.env.parity        # 준비금 스냅샷 표 (열마다: 저장된 statement·서명·챌린지·문제·측정 보고)
curl -s http://127.0.0.1:8793/log/summary               # 대역 노드가 받은 요청: 두 서비스가 같은 본문을 같은 횟수로 보냈는가 ("same": true)
curl -s 'http://127.0.0.1:3301/log/compare?with=3302'   # 파트너 대역이 받은 요청: 송금마다 같은 요청을 같은 순서로 받았는가 ("same": true)

# 4. 두 서버를 내립니다.

# 4-1. 내린 뒤: 실행이 남긴 준비금 커밋먼트를 각자 봉인하게 하고 비교합니다. 대기 줄(같은 다이제스트, 같은 순서),
#      배치의 루트, 기록마다의 리프 인덱스와 증명, 스냅샷이 가리키는 기록. 배치 크기는 둘째 파일의 것(4).
#      두 스키마가 봉인된 채 남으므로 다음 대조 전에 다시 심습니다.
node apps/core-java/tools/compare-por-sealing.mjs apps/core-java/.env.ref-worker apps/core-java/.env.dev-worker

# 5. (필요할 때, 따로) 콘솔의 트랜잭션 조회를 실제 트랜잭션으로 확인합니다. 이 확인만 지갑이 있는 Java 서버가
#    필요합니다: 다시 심고, 기준 서버와 `--env-file=.env.dev`(지갑 attest-java)로 띄운 Java 서버에서 돌립니다.
#    Java 서버의 콘솔 경로로 작은 문서 한 건을 실제로 인스크립션합니다(커밋·리빌). 규칙을 깬 빌드로는 하지 않습니다.
node apps/core-java/tools/check-console-tx.mjs --java http://127.0.0.1:8790 --ref http://127.0.0.1:8791 \
     --java-env apps/core-java/.env.dev --ref-env apps/core-java/.env.ref
```

`compare-registry.mjs`는 기준 스키마에만 있는 행 하나(플랫폼 자신의 기관. 송금 레일이 뜰 때 등록하고, Java 코어에는 레일이 아직 없습니다)를 비교하지 않고 건수만 말합니다.

**규칙을 일부러 깨 보는 확인**(대조가 그 규칙을 정말 보고 있는지)을 한 뒤에는 원본을 되돌리고 `./mvnw clean package`로 빌드합니다. 되돌린 파일의 수정 시각이 깨진 빌드의 클래스보다 오래되면 `clean` 없는 빌드는 다시 컴파일하지 않고, 깨진 클래스가 jar에 남습니다.

`run.mjs`에는 `--only <글자>`(이름에 그 글자가 든 경우만. 변수를 만드는 경우는 항상 실행), `--file <이름>`(그 파일의 경우만), `--show`(같은 경우도 출력)가 있습니다.

### 콘솔이 없는 배포

콘솔을 끈 배포(`CONSOLE_ENABLED=0`)와 운영 배포(`STONEHASH_ENV=live`)의 답은 두 서버를 그 설정으로 띄워야 볼 수 있습니다. 이 두 Java 설정 파일도 지갑 이름은 노드에 없는 것입니다(`make-parity-env.mjs <파일> <같은 파일>`). 설정 파일은 `.env.dev`·`.env.ref`에서 그 키만 바꾼 `.env.dev-console-off`·`.env.ref-console-off`, `.env.dev-live`·`.env.ref-live`(`ALLOW_REGTEST_IN_LIVE=1` 포함)입니다. 스키마, 포트, 지갑은 그대로이고 워커는 꺼져 있습니다.

```
node apps/core-java/tools/seed-reference.mjs apps/core-java/.env.ref apps/core-java/.env.dev
node apps/core-java/tools/run-reference-core.mjs apps/core-java/.env.ref-console-off
(cd apps/core-java && /usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar target/stonehash-attest-core-0.1.0.jar --env-file=.env.dev-console-off serve)
node apps/core-java/parity/run.mjs --file console-off        # 89건(준비금 증명 11건 포함). 평소의 두 서버에서는 이 파일에 경우가 없습니다
node apps/core-java/parity/run.mjs --file por                # 콘솔을 끈 배포에서만: 304건, 준비금 증명 전체 (대역 노드를 띄운 채, 새로 심은 뒤 한 번만)
```

`-live` 파일로 같은 일을 한 번 더 합니다(`--file console-off`만). 운영 설정은 심어 둔 시험용 키를 받지 않으므로(401) `por` 파일은 거기서 돌리지 않습니다: 키가 필요한 준비금 경로는 두 서버 모두 401이고, 공개 자료 경로는 그대로 답합니다(둘 다 `console-off` 파일의 경우에 있음). 이 두 실행에서는 `compare-audit.mjs`의 목록(평소 실행에서 생기는 차이)이 맞지 않으므로 행 수만 봅니다.

## 두 설정 파일

`.env.ref`와 `.env.dev`는 `tools/make-dev-env.mjs`로 운영 `.env`에서 만들고(소유자만 읽음), 포트·스키마·데이터 디렉터리·지갑 이름 말고는 같아야 합니다. 대조가 한도에 닿도록 두 파일에 같은 값을 둡니다.

| 키 | 값 | 이유 |
|---|---|---|
| `TRUST_PROXY` | `1` | 경우마다 `X-Forwarded-For`로 주소를 달리해, 한 묶음이 다른 묶음의 한도를 쓰지 않게 합니다 |
| `SIGNUP_RATE_MAX` | `8` | 샌드박스 가입의 주소별 한도 |
| `PUBLIC_ANCHOR_MAX` / `PUBLIC_ANCHOR_GLOBAL_MAX` | `12` / `40` | 무료 티어의 주소별·전체 한도. 전체 한도에 닿으면 그 실행에서는 더 받지 않으므로 그 경우들이 맨 뒤에 있습니다 |
| `PUBLIC_ANCHOR_ORIGINS` | `https://playground.example,https://other.example` | 허용 출처와 그 밖의 출처를 모두 대조합니다 |
| `CONSOLE_AUTH_MAX` | `6` | 콘솔 가입·로그인의 주소별 한도. 경우마다 주소를 다섯 번씩 씁니다 |
| `CONSOLE_MONTHLY_QUOTA` | `40` | 콘솔의 월 한도. 심는 도구가 한 조직을 한도보다 한 건 적게 채웁니다(60을 넘으면 심지 않습니다) |

## 송금 레일: 파트너 대역, 심는 자료

**대조용 서버는 둘 다 운영 파트너 시뮬레이터(`:3300`)와 정산 체인의 실제 노드(`:8545`)에 닿지 않습니다.** 설정 파일의 `REMIT_PARTNERS_BASE`는 그 서버의 파트너 대역 리스너(Java `http://127.0.0.1:3301`, 기준 `http://127.0.0.1:3302`), `REMIT_CHAIN_RPC`는 대역 노드(`:8793`)입니다. 비어 있거나 없으면 기본값이 운영 주소이므로 `tools/check-test-env.mjs`가 막습니다(심는 도구도 두 설정 파일을 같은 검사에 넣고, 안전하지 않으면 레일을 심지 않습니다).

### 파트너 대역 (`tools/stand-in-partner.mjs`)

수취기관(BFI) · 지급은행 · 정산 지갑을 한 프로세스가 대신합니다. 리스너 하나가 서버 하나의 파트너입니다: 상태, 로그, 웹훅 수신기가 리스너마다 따로이고 콜백은 자기 서버에만 보냅니다. 루프백에서만 듣고, 체인도 파일도 쓰지 않습니다(키 파일 하나만 만듭니다). 제어와 웹훅 수신기는 포트가 따로 없고 각 리스너의 경로입니다(`/control/…`, `/hooks/…`).

- **각본이 없으면 시뮬레이터(`demo-partners/server.mjs`)와 같게 답합니다.** 같은 경로, 같은 모양, 같은 서명(기준의 `sign.ts`로 서명), 같은 문장의 거절, 같은 트리거: 수취인 이름에 `SANCTIONED` → 거절, USD 20,000 이상 → RFI(`RFI-<payment id>`, 질문 둘), 답변이 모두 비면 거절, 금액 끝자리 `.13` → 지급 실패와 반환, `.01` → L1, `.02` → L2, 그 밖에는 L3. 보내는 쪽 서명(`sender`)이 플랫폼 키로 검증되지 않으면 시뮬레이터처럼 400으로 거절합니다(`--sender record`면 기록만).
- **시뮬레이터와 다른 점.** 입금 주소 · 트랜잭션 해시와 블록 · 은행 참조번호는 송금 id에서 정해집니다(두 서버가 같은 송금에 같은 값을 받습니다. 해시는 대역 노드가 아는 해시입니다). 체인을 보지 않으므로 콜백은 정산 통지에 답한 직후에 갑니다. 처음 보는 송금은 심은 파일(`seed.json`의 `remit.partner.ledger`)에서 찾습니다 — 심어 둔 송금을 대조 중에 이어 갈 수 있게, 심을 때 파트너가 기억한 것을 적어 둔 것입니다.
- **키**는 `parity/partner-keys.json`입니다(소유자만 읽음, 없으면 만듦, 출력하지 않음). 기관은 시뮬레이터의 id 그대로 `SG-BFI-001` · `SG-PAYBANK-001` · `SETTLE-ENTITY-001`, 그리고 두 번째 수취기관 `SG-BFI-002`, 아무도 등록하지 않는 키 `SG-BFI-UNREGISTERED`입니다. 심는 도구가 같은 공개키로 기관을 등록합니다. 이 파일을 지우면 다시 심어야 합니다.

**각본** — `POST /control/plan`, 송금 id 하나(`payment_id`) 또는 id의 앞부분(`prefix`), 또는 전부(`all: true`)에 대해:

```
{ "payment_id": "PAY-1",
  "steps": { "travel-rule": "normal", "payout-approval": { "do": "hold" }, "transfer": [{ "do": "fail-after", "status": 500 }, "normal"] },
  "callbacks": "manual" }
```

| 단계 (`steps`의 키) | `travel-rule`, `travel-rule-response`, `payout-approval`, `transfer`, `settlement-notice`, `cancel` |
|---|---|
| 평소대로 | `"normal"` (위의 규칙). 배열을 주면 요청 하나에 하나씩 쓰고(송금마다 따로 셉니다), 다 쓰면 평소대로입니다 |
| 트래블룰 답 | `ack`, `rfi {id, questions}`, `rfi-bare {reason, remember}`(id 없는 질문. `remember`가 없으면 시뮬레이터처럼 아무것도 기억하지 않아 답변이 검증되지 않습니다), `reject {reason}` |
| 거절 · 실패 | `refuse {status, message \| body \| raw}`(4xx, 아무 일도 하지 않음), `fail {status}`(5xx, 하지 않음), `fail-after {status}`(일을 하고 나서 5xx) |
| 붙잡기 | `hold {ms, then}`: `POST /control/release`까지(또는 `ms` 동안) 답하지 않고, 풀리면 그때 요청을 처리합니다. `hold-after {ms}`: 일은 바로 하고 답만 붙잡습니다(승인이 난 뒤에 취소가 끼어드는 경우) |
| 끊기 · JSON이 아닌 답 | `drop`, `drop-after`, `html`, `raw {status, contentType, body}` |
| 답을 바꾸기 | `signedBy`(`bfi`, `bfi2`, `sgbank`, `wallet`, `stranger`), `breakSignature`, `with {…}`(서명되는 본문의 멤버: `payment_id`, `usdc_amount`, `tx_hash` …), `top {…}` · `omit […]`(그 바깥: `status`, `ack` …), `element {with, omit, after, signedBy, unsigned, breakSignature, breakDigest}`(안에 든 증거요소), `tx`(전송의 해시 종류: 아래 대역 노드), `delay`, `thenClose`(답한 뒤 그 ms 동안 연결을 받지 않음) |
| 콜백 (`callbacks`) | `"auto"`(시뮬레이터의 순서), `"manual"`(시키기 전에는 보내지 않음), `{ level: "L1"\|"L2"\|"L3"\|"none", fail, sequence: […], delay, gap }` |

- `POST /control/callback {payment_id, type, level, with, element, signedBy, breakSignature, again: "bytes"|"resign", payload}` — 콜백 하나를 지금 보내고, 보낸 것과 서버의 답을 돌려줍니다. 같은 바이트를 다시(`bytes`), 같은 본문에 새 서명으로(`resign`), 순서를 바꿔서, 모르는 종류로, 다른 역할이나 등록되지 않은 키로, 없는 송금에 대해 보낼 수 있습니다.
- `GET /control/wait?payment_id=&step=&n=` — 그 요청이 **도착하면** 답합니다(답했든 붙잡았든). 서버가 그 호출 앞의 일을 다 끝냈다는 표시입니다. `dir=out&type=`이면 보낸 콜백, `answered=1`이면 답까지 끝난 것. `GET /control/idle?payment_id=` — 자동 콜백이 진행 중이 아니면 답합니다. `GET /control/held`, `POST /control/release {id | payment_id, step, answer}`, `POST /control/close {ms}`(연결 거부), `POST /control/remember`, `GET /control/ledger`, `POST /control/reset`.
- **로그**: `GET /log[?payment_id=]`(받은 요청과 보낸 콜백 전부: 경로, `Idempotency-Key`, 본문, 한 답 / 받은 답), `GET /log/summary`(시각 · 서명 · 암호문을 종류로 줄인 모양. 트래블룰 암호문은 열어서 평문의 SHA-256을 적습니다), `GET /log/compare?with=<다른 리스너>`(두 리스너가 송금마다 같은 요청을 같은 순서로 받고 같은 콜백을 보냈는가. 요청 헤더와, 콜백에 서버가 한 답은 따로 알립니다), `POST /log/clear`.
- **웹훅 수신기**: `POST /hooks/<이름>`은 받은 본문을 그대로 적고 200으로 답합니다. `POST /control/hook {name, answers: [{status: 500}, {hold: ms}, …]}`로 답을 정하고, `GET /hooks/<이름>[?summary=1]`로 받은 것을 봅니다.

### 심는 자료 (`tools/seed-remit.mjs`, `tools/seed-reference.mjs`가 부름)

레일의 행은 **기준 코드가 실제로 쓰는 행**입니다: 기준의 경로 처리기(`registerRemitRoutes`)를 라우터가 부르듯 부르고, 기준의 오케스트레이터가 파이프라인을 돌리고, 기준의 파트너 커넥터가 같은 프로세스 안의 파트너 대역을 부릅니다(그동안만 `fetch`를 바꿉니다. 포트도 서버도 쓰지 않습니다). 은행 쪽은 배포된 SDK입니다. "어느 단계에서 기다리는 송금"은 그 자리에서 멈춘 흐름입니다. 기존에 심던 것은 그대로이고, 레일은 자기 조직(`parity-remit…`)만 씁니다.

- **조직** (`seed.json`의 `remit.orgs`, 각각 API 키): `rail`(경우가 쓰는 조직, 웹훅 있음), `read`(경우가 쓰지 않는 조직: 모든 상태의 송금), `b`(다른 조직), `nohook`(웹훅 없음), `off`(구독 꺼짐: 켜져 있을 때 만든 송금 하나가 체인에 올라가 콜백을 기다립니다. 웹훅 주소는 구독이 꺼져 있어도 읽힙니다), `nosub`(구독 없음), `nobank`(기관 없음), `nokey`(키 없는 기관), `deact`(계정과 세 상품, 웹훅, 진행 중인 송금 둘: 운영자의 해지 경로용). 은행 서명키의 개인키가 `bank.pem`에 있습니다.
- **기관**: 플랫폼 자신(`STONEHASH`, 두 스키마에 같은 행), 파트너 대역의 넷, 암호화 키가 없는 수취기관 `SG-BFI-NOENC`. 플랫폼 키 파일은 기준의 `loadOrCreatePlatformKey`로 만들거나 있던 것을 둡니다(`REMIT_PLATFORM_KEY_PATH`: 절대 경로, 두 설정 파일에서 같아야 합니다).
- **견적**: 경우가 쓸 새 견적(`remit.quotes.fresh`, 10년짜리), 만료된 것, 저장된 글이 JSON이 아닌 것.
- **송금** 194건(`remit.settlements.<조직>.<이름>`, `remit.groups`): 앵커까지 끝난 것, 입금 확정(앵커 기록이 accepted · batched · submitted · confirmed인 것, 패키지가 없는 것), 취소된 것 9건(수취기관의 거절, RFI 뒤의 거절, 은행의 취소를 취소할 수 있는 상태마다), 반환, `EXCEPTION` 13건(대사 실패와 파트너 호출 자리마다의 실패), 단계마다 기다리는 것, 체인 조회의 답 종류마다 하나(`remit.chain`), L1 대기, 모드 A · B, SWIFT 전문에서 만든 것(쌍둥이로 인식된 것과 이어받은 UETR: `remit.source`), 페이지를 넘길 44건(같은 밀리초 6건: `remit.paging`), 참조번호 검색거리(`remit.search`). `rail` 조직에는 경우가 이어 갈 것들이 있습니다: 열린 RFI, 취소할 수 있는 것, 체인에 올라가 콜백을 기다리는 것, L1 대기 등.
- **일별 대사**(`remit.manifests`): 맞는 날, 어긋난 날, 앵커 기록이 없는 날.
- **기준의 손을 거치지 않은 것**은 `remit.hand_made`에 적혀 있습니다(이벤트 없는 `REQUEST_ACCEPTED` 행 등).

**두 스키마가 다른 것은 하나입니다**: 웹훅 주소. 각 스키마의 `subscriptions.config`와 심은 `remit_webhook_deliveries.url`은 **그 서버의** 대역을 가리킵니다(`<REMIT_PARTNERS_BASE>/hooks/<이름>`: 기준 3302, Java 3301). `tools/compare-registry.mjs`와 `tools/check-remit-seed.mjs`는 그 앞부분만 "자기 대역"으로 읽고 나머지를 비교합니다.

**시각.** 심는 동안은 도구의 시계입니다. 끝난 송금은 고정된 날(2026-10-05 ~ 10-10)에, 경우가 이어 갈 것은 심는 시각의 3시간 전에 만들어집니다. 열린 RFI는 심은 뒤 약 44시간 안에만 끝까지 갈 수 있습니다(`remit.carry_on_before`): 은행의 승인에서 전송까지 이틀을 넘으면 정책이 대사를 실패시킵니다. 관리 토큰은 `seed.json`에 넣지 않습니다: 경우가 설정 파일의 `REMIT_ADMIN_TOKEN`을 읽습니다.

```
node apps/core-java/tools/check-remit-seed.mjs apps/core-java/.env.ref apps/core-java/.env.parity   # 심은 직후: 두 스키마가 같은가(웹훅 주소 말고), 서명 · 패키지 · 웹훅 본문이 성립하는가
```

### 정산 체인의 대역 노드

`GET /v1/settlements/:id/chain`의 네 읽기(`eth_getTransactionByHash` · `eth_getTransactionReceipt` · `eth_blockNumber` · `eth_getBlockByNumber`)를 `tools/stand-in-eth-rpc.mjs`가 **해시만 보고** 답합니다. 해시의 첫 바이트가 노드가 아는 것(`TX`: `confirmed`, `failed`, `pool`, `noReceipt`, `unknown` …), 둘째 바이트가 어느 읽기가 어떻게 틀어지는가(`TX_FAULT_AT` × `TX_FAULT`: 오류, 500, HTML, 5.6초, 끊김, 빈 답)입니다. `txHash(kind, seed, fault)`가 그런 해시를 만들고 파트너 대역이 전송 결과에 그 해시를 씁니다. `eth_blockNumber`는 해시가 없으므로, 바로 앞에 물은 트랜잭션의 결함이 "head"일 때만 틀어집니다.

### 기준만으로 확인하기 (대조 쌍의 포트와 스키마를 쓰지 않고)

```
# 자기 스키마 둘에 심기 (seed.json을 건드리지 않게 다른 파일로)
PARITY_SEED_OUT=apps/core-java/parity/seed.rref.json node apps/core-java/tools/seed-reference.mjs apps/core-java/.env.rref-a apps/core-java/.env.rref-b
node apps/core-java/tools/seed-remit.mjs apps/core-java/.env.rref-a apps/core-java/.env.rref-b      # 레일의 행만 (stonehash_test_remit… 스키마에서만)

# 파트너 대역의 각본마다 기준이 어떻게 끝나는가: 대역 노드, 파트너 대역, 기준 서버를 띄우고 내립니다 (--slow: 20초 한도를 기다리는 두 경우, --workers: 워커를 켠 설정 파일로 T16과 웹훅 발송)
node apps/core-java/tools/prove-stand-in-partner.mjs --env apps/core-java/.env.rref-a --seed apps/core-java/parity/seed.rref.json
```

## 워커를 켠 검증

위의 대조는 워커를 끈 두 서버로 합니다. 워커와 실제 앵커링은 따로 확인합니다. 지갑은 `attest-java` 하나이고, **두 서비스의 워커를 같은 지갑에 동시에 붙이지 않습니다**(하나씩 띄웠다 내립니다). 설정 파일은 `.env.dev-worker`(Java, `:8790`), `.env.dev-worker2`(같은 스키마의 두 번째 Java 인스턴스, `:8792`), `.env.ref-worker`(기준, `:8791`)이고 모두 `WORKER_TICK_MS=500`, `BATCH_FLUSH_INTERVAL_MS=1500`, `BATCH_MAX_LEAVES=4`입니다.

```
cd attest
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

# 같은 대기 기록 → 같은 배치·순서·증명 (체인 없음, 두 서버 모두 내린 상태에서).
# 배치가 없는 인스크립션은 기준만 가져가고 Java는 그대로 두어야 합니다 (D-08)
node apps/core-java/tools/compare-sealing.mjs apps/core-java/.env.ref apps/core-java/.env.dev-worker

# 실제 앵커링: 워커를 켠 서버 하나를 띄운 뒤. 기록 → 봉인 → 앵커 → 확정 → 번들을 독립 검증기로
node apps/core-java/tools/clear-test-schema.mjs apps/core-java/.env.dev-worker
node apps/core-java/tools/check-anchoring.mjs --base http://127.0.0.1:8790 --env apps/core-java/.env.dev-worker --out /tmp/java.json
#   기준 서버로 같은 일을 한 뒤(.env.ref-worker, --out /tmp/ref.json) 두 결과의 모양을 비교
node apps/core-java/tools/compare-anchoring.mjs /tmp/ref.json /tmp/java.json

# 실제 인스크립션: 워커를 켠 Java 서버 하나를 띄운 뒤. 문서 3개 → 커밋·리빌 → 확정 → 번들을 독립 검증기로,
# 블록의 증인에서 문서를 다시 읽어 보낸 것과 비교, 노드가 거절한 경우(지갑의 코인을 모두 잠근 채) 한 건
node apps/core-java/tools/clear-test-schema.mjs apps/core-java/.env.dev-worker
node apps/core-java/tools/check-inscription.mjs --base http://127.0.0.1:8790 --env apps/core-java/.env.dev-worker --out /tmp/insc-java.json
#   Java 서버를 내린 뒤 기준 서버로 같은 일(.env.ref-worker, --reference --out /tmp/insc-ref.json). 차이가 D-08뿐인지 비교
node apps/core-java/tools/compare-inscription.mjs /tmp/insc-ref.json /tmp/insc-java.json

# 두 Java 인스턴스를 같은 스키마에 띄우고 양쪽으로 check-anchoring을 돌린 뒤: 배치마다 봉인 한 번, 전송 한 번
node apps/core-java/tools/check-two-workers.mjs --env apps/core-java/.env.dev-worker --logs <인스턴스 1 로그> <인스턴스 2 로그>

# 멈춤과 복구 (전송과 기록 사이의 멈춤, 입력이 없어진 시도, 리스, 같은 전이 두 번),
# 그리고 인스크립션(배치에 들어가지 않음, 자기 트랜잭션으로 확정, 노드가 거절하면 기록 없음): 저장소와 체인을 실제로 씀
(cd apps/core-java && ./mvnw -B -q -o test -Dtest=WorkerRecoveryIT -Dstonehash.env=.env.dev-worker)
```

`*IT` 테스트는 `./mvnw test`에 들어 있지 않습니다. 이름을 주어 돌릴 때만 실행되고, 시작할 때 스키마에 기다리는 기록과 `sealed` 배치가 없어야 합니다(`tools/clear-test-schema.mjs`). 실제 앵커 트랜잭션을 만드는 검증은 필요한 만큼만 돌립니다(한 번에 몇 건, 블록도 그만큼). 인스크립션은 앵커보다 비쌉니다: 문서 3개(104·300·600바이트)에 트랜잭션 6개, 수수료 약 2,500 sat이고, 기준 서버는 배치 앵커 3개가 더 나가 약 3,100 sat입니다. `WorkerRecoveryIT`도 돌 때마다 인스크립션을 하나 만듭니다.

## 경우를 쓰는 법

`cases/*.mjs`는 파일 이름 순서로, 그 안에서는 적힌 순서로 실행됩니다. 한 경우는 `{ name, method, target, headers, body }`입니다. 본문은 객체(JSON으로 보냄), 문자열이나 `Buffer`(그대로 보냄), `null`(없음)입니다.

- **심은 값**은 두 스키마에서 같습니다. 파일이 함수를 내보내면 `seed`(`parity/seed.json`: 키, id, 세션, 서명된 statement)를 받습니다.
- **서버가 만든 값**은 서버마다 다릅니다. `capture: { made: '$.id' }`로 각 서버의 응답에서 꺼내 두고, 뒤의 경우에서 `{made}`로 씁니다(경로, 헤더 값, 본문 어디든). 각 서버에는 자기 값이 갑니다.
- **요청마다 달라지는 값**(id, 시각, 비밀값)은 `volatile: ['$.id', /^\$\.data\[\d+\]\.id$/]`로 적어 종류만 비교합니다. 그런 값을 인용하는 문장은 `blur: [[/attested as [0-9a-f-]{36}/, 'attested as <id>']]`로 그 부분만 가리고 비교합니다. 남은 초를 담은 헤더는 `volatileHeaders: ['retry-after']`.
- **알려진 차이**는 `expected.json`에 경우 이름, 다른 곳(`status`, `$.message`, 본문 전체는 `$.*`), 이유를 적습니다. 이유는 아직 옮기지 않은 단계이거나 `docs/JAVA-INTENDED-DIFFERENCES.md`의 번호입니다. 목록에 없는 차이도, 더 이상 나타나지 않는 목록 항목도 실패입니다. 응답 전체를 `volatile`로 가려 차이를 덮지 않습니다. 목록의 한 행에만 있는 차이는 좁혀서 적습니다: `pathMatches`(경로의 패턴, 예: 목록의 몇 번째 행이든 그 필드), `ofSeed`(차이가 난 객체의 `id`가 심은 id 중 하나일 때만, 예: `ids.inscription.confirmed`), `ref`·`java`(두 값이 정확히 이것일 때만).
- **응답 없이 끊기는 연결**(한도를 넘은 업로드)은 `noAnswer: true`로 적습니다. 두 서버 모두 응답 없이 끊어야 같은 것이고, 어느 쪽이든 응답을 하면 차이입니다.
- **쿠키**는 이름, 속성, 순서까지 그대로 비교합니다. 값은 종류(비었는지, 길이, 글자 집합)만, `Expires`의 날짜는 두 서버가 10초 안인지만 봅니다. 서버가 준 쿠키는 `capture: { s: 'cookie:stonehash_session' }`로 꺼내 `headers: { Cookie: 'stonehash_session={s}' }`로 돌려보냅니다. 각 서버에는 자기 세션이 갑니다.
- **순서가 정해지지 않은 목록**(SQL에 `ORDER BY`가 없는 것: 콘솔 개요의 `issuer_keys`)은 `unordered: { '$.issuer_keys': 'label' }`로 적어 그 필드로 정렬한 뒤 비교합니다.
- **콘솔의 가입·로그인**은 주소별 한도(`CONSOLE_AUTH_MAX`)를 쓰므로 경우마다 `X-Forwarded-For`를 붙입니다(`cases/console.mjs`의 `door()`: 주소 하나에 다섯 번).
- **증빙 아카이브**(`application/zip`)는 담긴 것으로 비교합니다: 구성 파일을 순서대로 풀어 바이트로, ZIP의 필드(이름, 시각, CRC, 크기, 속성)를 하나씩. 두 런타임의 DEFLATE가 달라 압축 바이트만 다르며, 그것은 `archive: packed bytes` 하나로 보고됩니다(`expected.json`의 D-15). 각 서버의 `x-evidence-sha256`은 그 서버가 보낸 바이트의 다이제스트여야 합니다. id와 시각을 서버가 정하는 요청은 `looseArchive: true`(구성 파일의 이름만)와 `blurHeaders`(헤더에서 id를 지움)로 적습니다.
- **객체를 꺼내 다음 요청에 넣기.** `capture: { ev: '$.evidence' }`(본문 전체는 `'$'`)로 객체를 꺼내고, 뒤의 본문에서 값이 정확히 `'{ev}'`인 자리에 그 객체가 들어갑니다. `swap: true`인 경우에는 각 서버에 **상대 서버가** 답한 값이 갑니다(한쪽이 봉인한 패키지를 다른 쪽이 검증).
- **두 서버가 같게 틀릴 수 있는 경우**에는 답이 무엇이어야 하는지도 적습니다: `expect: { '$.digestOk': true }`. 두 서버 모두 그 값이 아니면 차이입니다.
- **변조 대상에 `__proto__`, `constructor` 같은 이름을 준 경우도 보냅니다.** 2026-11-18 전의 기준은 다이제스트 변조에서 자기 엔진의 객체에 값을 썼고, 그 뒤 그 프로세스의 답이 달라졌습니다(D-13). 기준을 고친 뒤로는 두 서버 모두 "그 이름의 요소가 없다"고 답합니다. 이 경우들 바로 뒤에 시나리오 A를 한 번 더 보내, 아무것도 쓰이지 않았음을 확인합니다. 벡터 도구는 지금도 그 경우마다 프로세스를 따로 띄워 묻습니다.
- **문서 인스크립션 경로(`/v1/attestations/inscribe`)에는 거절되는 요청만 넣고, 한 가지 거절에만 기대지 않습니다.** 문이 시험 대상이면 문서를 싣지 않고, 한도가 대상이면 그 조직이 이미 가진 작은 문서를, 그 밖에는 이 배포가 인스크립션하는 크기보다 긴 문서(`documents.mjs`의 `overLimit`: 크기는 지갑에 묻기 전 마지막 검사)를 싣습니다. 심어 둔 인스크립션 기록의 문서도 그 길이입니다. 서버가 읽지 않고 답하는 요청(문, 한도)에 큰 본문을 실으면 기준 서버가 보내는 쪽의 연결을 끊으므로 그런 경우의 문서는 작게 둡니다. 콘솔의 인스크립션 경로도 같습니다. 대조용 서버는 둘 다 지갑이 없지만(위), 경우 자체도 그렇게 씁니다: 지갑이 있는 서버로 돌리더라도, 그 규칙이 깨진 빌드가 다른 답을 하더라도 인스크립션은 일어나지 않아야 합니다(월 한도 검사를 일부러 깬 빌드를 지갑이 있는 서버로 대조했을 때 실제로 한 건이 나갔습니다). 대조 뒤에는 멤풀과 지갑 잔액이 그대로인지 봅니다. 실제 인스크립션은 `tools/check-inscription.mjs`가 합니다.
