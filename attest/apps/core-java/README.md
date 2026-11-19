# StoneHash Attest Core (Java)

플랫폼 백엔드의 Java 구현입니다. 지금 운영 중인 TypeScript 코어(`apps/core`)를 단계별로 옮기는 중이며, 전환이 끝날 때까지 운영 기준은 TypeScript 코어입니다. 무엇을 어떤 순서로 옮기는지는 `docs/JAVA-BACKEND-MIGRATION.md`(작업 지시서)에 있습니다.

## 지금 들어 있는 것

| 단계 | 내용 | 상태 |
|---|---|---|
| 0. 준비 | 빌드, 설정, HTTP 계층, DB 계층, 스키마 기준선, 대조 도구 | 완료 |
| 1나. 생산 형식 | Merkle 트리, BC01, 트랜잭션 바이트, 번들 조립, 정규화, 서명 statement (`format/`, `btc/`) | 완료 |
| 2a. Attest API | API 키 인증, 감사 기록, 속도 제한, 앵커링·서명키·무료 티어·샌드박스 키 경로, `/readyz` (`auth/`, `audit/`, `attest/`, `anchor/`) | 완료 |
| 2. 배치 워커 | 봉인 → 앵커 → 확인 갱신 → 무료 티어 정리, bitcoind 지갑 연동, 리스, 전송 전 기록 (`attest/Batch*`, `attest/WorkerLease`, `anchor/`) | 완료 |
| 2b. 인스크립션 | 문서 원문을 체인에: secp256k1·BIP340, 탭루트, 봉투, 커밋·리빌, `POST /v1/attestations/inscribe` (`btc/`, `anchor/Inscriber`) | 완료 |
| 3a. 콘솔 API | 계정·세션(기존 scrypt 해시 호환, 세션 표 그대로), 키 관리, 콘솔 서명키, 콘솔의 기록(목록·접수·서명·인스크립션·번들·트랜잭션 조회), 대시보드, 감사 검색, 과금, 제품 화면 2개 (`console/`, `auth/Accounts`·`Passwords`, `audit/AuditSearch`) | 완료 |
| 1가. 공통 규약 (SDK) | 서명·규칙 엔진의 공개 진입점 `Rules`·`Conventions`·`TravelRule` (`sdks/attest-remit-java`, 이 모듈은 `sdk.lock`의 릴리스만 씁니다) | 완료 |
| 3b. 콘솔 샌드박스 | 샌드박스 자료 4개(`/v1/console/sandbox*`: 시나리오, 변조, 패키지와 그 재검증), 정산 증빙 2개(`/v1/settlements/reconcile`, `/bundle`: 판정과 증빙 아카이브), 송금 레일이 콘솔에 등록하는 경로 3개(제품 끄기, 기관의 서명키, 콘솔 서명키) (`sandbox/`, `evidence/`, `console/ProductRoutes`) | 완료 |
| 4. 준비금 증명 | 스냅샷 제출(루트 전용, 스팟 체크)·오프닝·조회·공개 자료 5개(`/v1/por/snapshots*`, `/v1/public/por/snapshots/:id`), statement 모양·합계 트리 오프닝 검증·커밋먼트(이 모듈 안에 새로 씀), 준비금 측정(`por/`) | 완료 |
| 5-1. 송금 레일 1부 | 기반과 접수: 설정, 표 `remit_jobs`(마이그레이션 3), 플랫폼 서명키, 레지스트리, 저장소(송금·이벤트·견적·멱등·전문 참조·작업), 전문 하나에 송금 하나, 견적, 접수(`POST /v1/settlements`), 파트너를 부르지 않는 경로 11개, 증빙 함수(대사·패키지·커밋) (`remit/`, `console/ProductRegistry`) | 완료 |
| 5-2 ~ 6 | 송금 레일 2부(접수 뒤의 파이프라인, 파트너 커넥터, 취소·RFI 답변·콜백, 송금 워커와 웹훅 발송, 운영 명령), 전환 | 아직 |

### 배치 워커

`WORKER_TICK_MS`가 0보다 크면 서버 안에서 타이머 하나가 돕니다(0이면 워커가 없습니다). 한 주기에 배치 하나를 봉인하고(가장 오래 기다린 기록의 조직, 그 조직의 기록을 들어온 순서대로 최대 `BATCH_MAX_LEAVES`개) 앵커하고, `sealed`로 남은 배치를 다시 시도하고, 확정을 갱신합니다. regtest에서는 앵커 뒤에 블록을 하나 만듭니다. 만들어지는 배치와 표의 행은 TypeScript 코어와 같고, 안쪽 세 가지가 새로 지은 것입니다(`docs/JAVA-INTENDED-DIFFERENCES.md` S-08 ~ S-11).

- **전이마다 조건.** 기록은 배치가 없을 때만 배치에 들어가고, 배치는 `sealed`일 때만 `submitted`가 됩니다.
- **리스** (`worker_leases`). 워커를 켠 인스턴스가 여럿이어도 리스를 잡은 하나만 일합니다.
- **전송 전 기록** (`anchor_attempts`). 서명한 트랜잭션을 적어 두고 보냅니다. 전송과 기록 사이에 멈춰도 다음 주기가 같은 트랜잭션을 다시 보내 마무리하고, 두 번째 트랜잭션은 만들지 않습니다.

두 표는 마이그레이션 2번이 만듭니다(`V2__worker_leases_and_anchor_attempts.sql`). 기존 표와 값은 바꾸지 않습니다. 지갑은 설정의 `BITCOIND_WALLET`이고, 개발·검증에는 `attest-java`만 씁니다.

### 인스크립션

`POST /v1/attestations/inscribe`는 다이제스트가 아니라 문서 자체를 받습니다(본문이 곧 파일이고, 종류는 `Content-Type` 헤더, 없으면 `application/octet-stream`). 문서는 메모리에서 해시하고 탭스크립트에 넣어 전송한 뒤 버립니다. 디스크에도 표에도 남지 않고, 표에는 공개된 리빌 트랜잭션이 남습니다.

- **트랜잭션 둘.** 커밋은 지갑이 자금을 대고 서명합니다(노드가 함). 리빌은 그 출력을 스크립트 경로로 쓰면서 문서를 증인(witness)에 싣습니다. 리빌의 서명만 이 프로세스가 합니다: 그 인스크립션에만 쓰는 키를 뽑아 서명하고 버립니다(`btc/Secp256k1`: BouncyCastle의 곡선 연산 위에 BIP340을 그대로 적었고, 공식 벡터와 바이트까지 같습니다). 탭루트 내부 키는 항상 NUMS 점이어서 커밋 출력은 스크립트 경로로만, 곧 문서를 공개하면서만 쓸 수 있습니다.
- **한도.** 문서는 `INSCRIPTION_MAX_BYTES`(기본 100,000)까지입니다. 그보다 64 KiB 더 읽어서, 한도를 넘은 문서에는 한도를 말해 주는 답을 하고 그 너머는 응답 없이 연결을 끊습니다. 빈 문서, 한 푸시(520바이트)에 들어가지 않는 `Content-Type`, 이미 있는 다이제스트는 지갑에 묻기 전에 거절합니다.
- **전송이 먼저, 기록이 나중.** 기록은 `kind`가 `inscription`이고 `submitted`로 시작합니다. 배치에 들어가지 않습니다(`docs/JAVA-INTENDED-DIFFERENCES.md` D-08): 번들은 처음부터 있고(`bundle_available: true`), 워커가 리빌의 확정을 조회해 `confirmed`로 올립니다. regtest에서는 리빌이 멤풀에 있는 동안 워커가 블록을 하나 만듭니다(S-12).
- 고치지 않은 한계(전송과 기록 사이의 멈춤, 리빌이 거절된 커밋, 동시에 온 같은 문서)는 같은 문서의 "인스크립션의 한계"에 있습니다.

### 콘솔

`/v1/console/*`는 샌드박스 콘솔 화면의 API입니다. 세션 쿠키로만 들어옵니다(API 키로는 열리지 않습니다). 기록, 키, 서명키는 키 API와 같은 서비스와 같은 표를 씁니다.

- **계정과 세션.** 비밀번호는 `scrypt$N$r$p$salt$hash`로 저장하고(새 계정은 N=32768·r=8·p=1), 검증은 저장된 문자열에 적힌 파라미터와 해시 길이로 합니다(`auth/Passwords`, BouncyCastle `SCrypt`). TypeScript 코어가 만든 계정이 그대로 로그인됩니다. 계산은 동시에 2개까지입니다(S-15). 세션은 `sessions` 표(토큰의 SHA-256)이고 서블릿 세션은 쓰지 않습니다. 쿠키는 `stonehash_session`, `Path=/`, `Expires`(14일 뒤), `HttpOnly`, `SameSite=Lax`이고 `Secure`는 `COOKIE_SECURE=1`일 때만 붙습니다.
- **한도.** 가입과 로그인은 주소별로 셉니다(`CONSOLE_AUTH_MAX`, `CONSOLE_AUTH_WINDOW_MS`). 월 한도(`CONSOLE_MONTHLY_QUOTA`)는 그 달(UTC)에 문서 앵커링이 만든 기록(`product = 'attest'`)만 셉니다. 키 API에는 월 한도가 없습니다.
- **대시보드, 감사 검색, 과금**은 읽기만 합니다. 감사 검색의 커서는 TypeScript 코어가 내던 것과 같은 글자입니다(`{"c":시각,"i":id}`의 base64url). 한쪽이 낸 커서를 다른 쪽이 읽습니다.
- **제품 화면**(`GET`·`POST /v1/console/products`)과 그 화면이 하는 일 3개(`POST /v1/console/products/:product/deactivate`, `/v1/console/institutions/:id/signing-key`, `/console-key`)는 송금 레일이 켜진 배포에만 있습니다(`REMIT_ENABLED`). 이 경로들이 읽고 쓰는 표(`subscriptions`, `institutions`)만 `console/ProductRegistry`로 옮겼습니다. 레지스트리의 나머지(키링, 스냅샷, 제품 게이트, 레일이 뜰 때 등록하는 플랫폼 자신의 기관)는 송금 단계에 옵니다.
- **트랜잭션 조회**(`GET /v1/console/tx/:txid`)는 그 조직의 앵커가 쓴 트랜잭션만 노드에 읽기 전용으로 묻습니다(멤풀, 그다음 지갑. 5초까지 기다림).
- **콘솔이 없는 배포.** `CONSOLE_ENABLED=0`이면 503 `console_disabled`, 운영(`STONEHASH_ENV=live`)이면 403 `not_available`로 답하고, 그때는 키 API도 세션 쿠키를 받지 않습니다.

### 샌드박스 자료와 정산 증빙

평가 샌드박스(`sandbox/`)와 저장 없는 정산 증빙 두 경로(`evidence/`)입니다. API 키로 들어오고, 샌드박스(`STONEHASH_ENV=test`, 콘솔 켬)에서는 콘솔 세션으로도 들어옵니다. 아무것도 저장하지 않고 체인이나 지갑을 쓰지 않습니다.

- **판정은 SDK가 합니다.** 서명 검증(`Rules.checkSignatures`)과 규칙(`Rules.evaluate`, `validatePolicy`, `canonicalPolicy`)은 SDK의 것이고, 이 모듈은 키링과 거절의 구분만 더합니다(`evidence/Reconciler`). 키링은 데모 발급자 키 5개입니다(`evidence/demo-issuer-keys.json`, 공개 절반뿐. 신뢰 수준 `DEMO`).
- **샌드박스 자료**(`sandbox/Sandbox`, `Tamper`, `SandboxMaterial`): 시나리오 A~F와 변조 5종은 샘플 정산 한 건의 변환입니다. 샘플은 데이터로 둡니다(`sandbox/material.json`). 서명은 샘플에 들어 있는 것이고 이 서비스는 서명하지 않습니다. 변조는 올린 증빙에도 그대로 적용됩니다. 패키지의 `digest`는 나머지 전체의 정규형(이름순, 공백 없음)의 SHA-256입니다.
- **증빙 아카이브**(`evidence/EvidenceArchive`, `ZipWriter`, `Pdf`, `Report`): `manifest.json`, `evidence.json`, `policy.json`, `matching-results.json`, `source-hashes.json`, `issuer-signatures.json`, `verification-report.pdf`. 구성 파일은 TypeScript 코어가 만든 것과 바이트까지 같고, 매니페스트의 다이제스트도 같습니다. ZIP의 압축 바이트만 런타임의 DEFLATE라서 다릅니다(D-15). 시계와 난수를 읽지 않습니다: 같은 요청(`bundleId`, `generatedAt` 지정)은 같은 아카이브입니다.
- **문서의 모양을 믿지 않습니다.** 올린 증빙에서 글자가 올 자리에 목록이나 숫자가 와도 TypeScript 코어가 하던 대로 답합니다(`json/JsValues`). 기준이 런타임 안에서 멈추던 자리는 여기서 500 `internal error`입니다(D-01).
- **데이터 파일은 생성물입니다.** `sandbox/material.json`과 `evidence/demo-issuer-keys.json`은 `tools/make-sandbox-vectors.mjs`가 기준의 상수에서 쓰고, `--check`가 어긋남을 잡습니다. 손으로 고치지 않습니다.

지금 서버가 답하는 경로: `GET /healthz`, `GET /readyz`, `GET /v1/meta`, 앵커링(`POST /v1/attestations`, `POST /v1/attestations/signed`, `POST /v1/attestations/inscribe`, `GET /v1/attestations`, `GET /v1/attestations/:id`, `GET /v1/attestations/:id/bundle`), 서명키(`GET`·`POST /v1/issuer-keys`), 무료 티어(`POST /v1/public/anchors`, `GET /v1/public/anchors/:id`, `GET /v1/public/anchors/:id/bundle`, OPTIONS), 샌드박스 키(`POST /v1/sandbox/keys`), 콘솔 21개(가입·로그인·로그아웃·`me`, 대시보드, 감사 검색, 기록 6개, 콘솔 서명키 3개, 키 5개, 다른 세션 끊기)와 제품 화면 5개(조회, 활성화, 끄기, 기관의 서명키, 콘솔 서명키), 샌드박스 자료 4개(`GET /v1/console/sandbox`, `POST /v1/console/sandbox/evidence`, `/package`, `/package/verify`), 정산 증빙 2개(`POST /v1/settlements/reconcile`, `/bundle`), 그리고 정적 화면(`/console/`, `/docs/`, `/playground/`). 워커가 도는 인스턴스가 하나도 없으면(`WORKER_TICK_MS=0`) 받은 기록은 `accepted`에, 인스크립션은 `submitted`에 머뭅니다.

### 준비금 증명

거래소가 서명한 스냅샷 statement를 받아 그 커밋먼트를 앵커링 파이프라인에 넣고, 읽어 볼 자료를 내줍니다(`por/`). 트리는 거래소가 만들고 플랫폼은 보지 않습니다. 경로는 다섯입니다: `POST /v1/por/snapshots`, `POST /v1/por/snapshots/:id/openings`, `GET /v1/por/snapshots`, `GET /v1/por/snapshots/:id`(이상 API 키), `GET /v1/public/por/snapshots/:id`(키 없음). 송금 레일이 켜진 배포(`REMIT_ENABLED`)에만 등록됩니다.

- **두 길.** 루트 전용(기본): 거래소 서명과 statement의 모양을 확인하고 곧바로 커밋먼트를 발급합니다(`ACCEPTED`). 스팟 체크(`spot_check: true`): 챌린지(리프 8개까지, 무작위)를 돌려주고, 그 리프들의 오프닝이 선언한 루트와 총액에 맞을 때만 발급합니다(`VERIFIED`). 하나라도 틀리면 `REJECTED`로 끝납니다. 어느 길로 왔는지는 상태가 기록이고, 공개 자료가 그대로 말합니다.
- **읽는 쪽만 여기에 있습니다.** statement의 모양(`SnapshotStatement`), 오프닝 하나를 루트·총액에 맞춰 보는 일과 커밋먼트(`SumTree`)는 이 모듈 안에 새로 썼습니다. 트리를 짓는 일은 거래소 SDK의 것이고, 중단된 `sdks/attest-por-java`는 쓰지 않습니다. 잔고는 끝까지 글자이거나 정확한 정수입니다(`BigInteger`).
- **서명.** 기관의 서명키 또는 콘솔이 등록한 키(`console_spki`)로 검증하고(SDK의 `Conventions.verifyEvent`), 어느 키였는지를 스냅샷과 함께 저장합니다. 저장된 키 글자는 등록된 그대로입니다(콘솔 키는 앞뒤 공백까지). 기관이 나중에 키를 바꿔도 공개 자료는 그 스냅샷을 서명한 키를 말합니다.
- **준비금 측정**(`Reserves`): statement가 선언한 주소 가운데 이 배포가 읽는 체인(`REMIT_CHAIN_LABEL`)의 토큰 잔고를 `POR_CHAIN_RPC`에 `eth_call`로 묻습니다. 주소 하나에 5초, 하나씩 차례로. 읽지 않는 체인은 `DECLARED_ONLY`, 읽다가 실패하면 `UNREACHABLE`과 그 이유입니다. 커버리지는 자산별로 측정된 잔고를 부채로 나눈 값(소수 둘째 자리까지, 버림)입니다.
- **한 번만.** 같은 statement의 루트 전용 제출은 스냅샷 하나입니다(다시 보내면 저장된 것으로 답함). 발급과 스냅샷 기록은 한 트랜잭션이고, 챌린지는 한 번만 확정됩니다(S-17, D-17).
- **뜰 때 쓰지 않습니다.** 서명키 열이 생기기 전의 스냅샷에 키를 채우는 일은 `backfill-snapshot-keys` 명령입니다(S-16).
- **거래소 SDK와의 관계.** SDK의 클라이언트는 제출 전에 송금 레일의 `GET /v1/remit/meta`를 읽습니다. 그 경로는 5단계 1부에 들어왔고 기준과 같게 답합니다(응답 대조). `tools/smoke-por-java.mjs`는 그 경로가 없던 때의 도구입니다(`--registry-stand-in`: 그 한 요청만 대신 답하게 함). SDK로 이 서버에 처음부터 끝까지 제출해 보는 일은 아직 다시 하지 않았습니다.

### 송금 레일 (1부)

베트남 → 싱가포르 정산 레일의 기반과 접수입니다(`remit/`). 설계는 `docs/JAVA-REMIT-DESIGN.md`(v2)이고, 송금 레일이 켜진 배포(`REMIT_ENABLED`)에만 등록됩니다. **1부는 송금을 접수하는 데까지입니다.** 접수 뒤의 일(트래블룰, 지급 승인, 전송, 콜백, 대사와 패키지)은 2부입니다.

| 경로 | 인증 | 하는 일 |
|---|---|---|
| `GET /v1/remit/meta` | 없음 | 플랫폼 서명키(`key_id`, `spki`)와 레지스트리의 기관 목록 |
| `POST /v1/remit/registry/institutions` | 관리 토큰 | 파트너 기관 등록·갱신(준 키만 바꿈) |
| `POST /v1/remit/registry/deactivate` | 관리 토큰 | 계정 e-mail로 그 조직의 상품 끄기 |
| `POST /v1/quotes` | API 키 + 구독 | 견적(고정소수 문자열 연산) |
| `POST /v1/settlements` | API 키 + 구독, `Idempotency-Key` | 송금 접수 → 202 `BANK_AUTHORIZED` |
| `GET /v1/settlements` | API 키 | 원장: `q`, `source_uetr`·`source_content`·`source_value_date`, `state`, `from`·`to`, `cursor`, `limit` |
| `GET /v1/settlements/:id` | API 키 | 송금 하나와 그 이벤트 |
| `GET /v1/settlements/:id/chain` | API 키 | 정산 체인 노드가 그 전송에 대해 지금 말하는 것(읽기 넷) |
| `GET /v1/settlements/:id/evidence` | API 키 | 증빙 패키지, 커밋, 앵커 |
| `POST /v1/manifests/daily` | API 키 + 구독 | 은행이 서명한 일별 목록을 플랫폼의 목록과 비교, 서명, 커밋을 앵커로 발급 |
| `GET /v1/manifests/daily` | API 키 | 저장된 일별 대사 |

경로는 기준이 등록하는 자리에 있습니다(`http/WebConfig`): `meta`와 기관 등록은 콘솔의 제품 화면 앞, 나머지는 그 뒤와 준비금 증명 앞. 정산 증빙의 두 낱말(`reconcile`, `bundle`)을 `GET`으로 부르면 `GET /v1/settlements/:id`가 받아 "그런 송금 없음"으로 답합니다(기준과 같음). 키로 부르는 경로는 감사 기록에 남고, 키 없는 `meta`와 관리 토큰의 두 경로는 남지 않습니다.

- **접수는 한 트랜잭션입니다**(`Acceptance`). 검사 순서는 기준 그대로이고(멱등 조회 → 송금 id → 그 id의 송금 → 견적 → 금액 → 수취기관 → 은행 서명 → 트래블룰 → 증거요소 셋 → 금액·ref 일치 → 전문 참조), 여기까지는 읽기만 합니다. 그다음 조직 행을 잠그고 멱등키와 송금 id를 다시 본 뒤 송금 행, 전문 참조, 이벤트 셋, 상태, 웹훅 행, 첫 작업, 멱등 행을 한꺼번에 씁니다. 전문이 이미 다른 송금의 것이면 아무것도 만들지 않되 인식 기록과 UETR 승계는 커밋합니다(S-20).
- **전문 하나에 송금 하나**(`SourceRef`, `RemitStore.sourceConflict`): 같은 파일의 같은 거래 → 기록된 인식 → 같은 UETR(내용이 다르면 `reference_reused`) → 쌍둥이 키. 쌍둥이는 일대일로 맞춥니다. 저장되는 쌍둥이 키와 멱등 해시는 기준이 쓴 행과 같은 값입니다.
- **접수 뒤의 일은 표 `remit_jobs`의 작업입니다**(`RemitJobs`, 마이그레이션 3). 송금 하나에 한 갈래에서 열린 작업은 하나(유일 키), 선점은 조건부 UPDATE 한 문장, 작업을 쥔 쪽이 결과 전에 쓰는 문장에는 울타리(`state = 'running' AND lease_owner = ?`), 결과를 쓰는 마감은 울타리 없이. 시각은 DB의 시계입니다. **1부에는 실행기가 없습니다**: `RemitExecutor`의 구현이 아무 일도 하지 않는 `IdleExecutor`라서 접수된 송금은 `BANK_AUTHORIZED`에 머물고 첫 작업(`TRAVEL_RULE`)이 잡힌 채 남습니다. 웹훅 행은 쌓이되 보내지 않습니다. 2부가 실행기, 워커, 발송을 넣습니다.
- **플랫폼 서명키**(`PlatformKey`)는 파일입니다(`REMIT_PLATFORM_KEY_PATH`). keyId는 `STONEHASH-SIGN-`에 SPKI의 base64 글자를 SHA-256한 앞 8자리입니다. 파일을 만드는 것은 `serve`가 시험용 저장소에서 뜰 때뿐이고, 운영 저장소에서는 없으면 뜨지 않습니다. 플랫폼 자신의 기관 행(`STONEHASH`)은 뜰 때 읽어 보고 없거나 다를 때만 씁니다(S-19).
- **레지스트리**(`console/ProductRegistry`): `institution`, `list`, `upsert`(조직을 주지 않으면 그대로, 키는 준 것만), 키링(기준의 런타임이 JWK로 바꾸지 못하는 키를 가진 기관은 빼고 로그에 id만), 스냅샷, `requireRemit`.
- **증빙 함수**(`Evidence`): 이벤트 로그에서 증거요소 모으기, 다이제스트, 정산 증빙 문서, 정책 `remit-corridor-v1`(`src/main/resources/remit/corridor-policy.json`: 기준의 정책에서 도구가 써 넣고, 뜰 때 SDK의 `Rules.validatePolicy`로 확인), SDK의 `Rules`로 대사, 패키지 조립(기준의 멤버 순서), 커밋. 조회 경로와 2부가 씁니다.
- **새 설정 둘**(설계 17장): `REMIT_STEP_RETRY_MS`(기본 `2000,10000,30000`, `off`면 다시 시도하지 않음: 2부가 씀), `REMIT_INTAKE_PAUSED`(`1`이면 견적과 접수가 503 `intake_paused`. 저장된 202는 그대로 돌려줌: D-20).
- **기준과 일부러 다른 것**: 문자열이 아닌 id(D-18), 191자를 넘는 멱등키(D-19), 접수 일시 정지(D-20), 같은 멱등키의 동시 요청(D-21), 뜰 때 하는 일(S-19), 접수가 쓰는 것(S-20).

## 구조

- **Spring Boot 4.1 + 내장 Tomcat, 실행 jar 하나.** Java 17 이상에서 돕니다.
- **경로 표는 이 모듈의 것입니다.** Spring MVC를 쓰지 않습니다. 어떤 요청이 404인지, 경로를 어떻게 읽는지, 빈 본문이 무엇인지, JSON이 어떤 모양인지는 고객과의 계약이고(작업 지시서 1장 "HTTP 경계"), 프레임워크의 기본 동작이 그 계약과 다르기 때문입니다. 요청은 모두 서블릿 하나(`http/CoreServlet`)로 들어와 `http/Router`가 처리합니다. 경로는 `http/WebConfig`에 순서대로 등록합니다(먼저 맞는 경로가 답하므로 순서가 동작입니다).
- **JSON은 `json/Js` 하나로 읽고 씁니다.** JavaScript의 `JSON.parse`·`JSON.stringify`·숫자 표기와 같은 결과를 냅니다(저장된 멱등 해시와 응답 형식이 여기에 기대고 있습니다). Jackson은 쓰지 않습니다. 서명과 커밋의 대상 바이트는 여기가 아니라 SDK의 `Json.canonical`을 지납니다.
- **시각은 `time/IsoTime` 하나로만 문자열이 됩니다.** UTC, 밀리초 3자리, `Z`. 표의 시각 열은 문자열이고 문자열로 비교·정렬합니다.
- **SQL은 MyBatis XML 매퍼(`src/main/resources/mapper/`)에 있습니다.** 연결은 `utf8mb4_bin`, READ COMMITTED, 엄격 모드로 고정합니다(`db/DbConfig`).
- **스키마는 서버가 뜰 때 바꾸지 않습니다.** 마이그레이션(`src/main/resources/db/migration/mysql/`)은 `migrate` 명령으로만 적용하고, 서버는 스키마 버전이 기대와 다르면 뜨지 않습니다(`db/SchemaGuard`).
- **설정은 환경 변수입니다.** 이름·기본값·오류 문장이 TypeScript 코어와 같습니다(`config/CoreConfig`). 다른 점 둘: `STONEHASH_DB_URL`은 필수이고, 운영 스키마(`stonehash_attest`)나 운영 지갑(`attest`)을 가리키면 `STONEHASH_CUTOVER_APPROVED=1` 없이는 뜨지 않습니다.

의존성은 `pom.xml`의 허용 목록뿐입니다: Spring Boot(스타터, Tomcat, JDBC), spring-web(서블릿 컨텍스트), MyBatis, Flyway(+MySQL), MySQL 드라이버, BouncyCastle, JUnit.

## 빌드와 실행

JDK 17의 경로를 명시합니다(서버의 기본 `java`는 11이고, SDK와 Java 데모가 그 기본값을 씁니다).

```
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
./mvnw -B -q test                       # 단위 테스트 (Node가 낸 벡터와 대조)
./mvnw -B -q -DskipTests package        # target/stonehash-attest-core-0.1.0.jar

$JAVA_HOME/bin/java -jar target/stonehash-attest-core-0.1.0.jar --env-file=.env.dev migrate   # 스키마를 이 빌드의 버전으로
$JAVA_HOME/bin/java -jar target/stonehash-attest-core-0.1.0.jar --env-file=.env.dev serve     # 서버 (:8790)
```

명령은 `serve`(기본), `migrate`, `baseline`(운영 스키마를 버전 1로 등록: 승인된 전환 때 한 번), `routes`(경로 표 출력), `backfill-snapshot-keys`(서명키 열이 생기기 전에 저장된 준비금 스냅샷에 키를 채움: 전환 때 한 번, 다시 해도 0건)입니다.

### 개발용 설정 파일

개발 서버는 운영 `.env`를 그대로 읽지 않습니다. 복사본을 만들고 포트·스키마·데이터 디렉터리·지갑을 바꿉니다. 파일은 소유자만 읽을 수 있게 만들어지고, 값은 출력되지 않습니다.

```
node apps/core-java/tools/make-dev-env.mjs apps/core/.env apps/core-java/.env.dev \
  PORT=8790 HOST=127.0.0.1 DB=stonehash_test_corejava STONEHASH_DATA_DIR=$PWD/apps/core-java/.data \
  BITCOIND_WALLET=attest-java REMIT_PARTNERS_BASE=http://127.0.0.1:3301 WORKER_TICK_MS=0
node apps/core-java/tools/create-schema.mjs apps/core-java/.env.dev      # stonehash_test_ 로 시작하는 스키마만 만듭니다
```

## 기준과의 대조

기준은 TypeScript 구현입니다. 세 가지로 맞춥니다.

1. **벡터** (`src/test/resources/vectors/`, `./mvnw test`): Node와 TypeScript 코어의 코드가 낸 답입니다. `tools/make-js-vectors.mjs`(JSON 134건, 숫자 21,216개, 시각 형식), `tools/make-http-vectors.mjs`(요청 주소 120건, 경로 파라미터, 페이지 크기, 설정 114가지와 오류 문장: 송금 레일의 키 포함), `tools/make-format-vectors.mjs`(트리 17개와 증명, BC01, 트랜잭션, 번들 15개, 정규화 32건, 서명 statement 156건), `tools/make-btc-vectors.mjs`(곡선 연산 65건, `lift_x` 42건, 태그 해시 40건, BIP340 공식 서명 벡터 4건과 서명 24건·검증 19건, 탭루트 출력 29개, sighash 5건, 봉투 68개, 인스크립션 23건, 리빌 트랜잭션 5개, 적합성 픽스처 07·08), `tools/make-key-vectors.mjs`(내놓은 키의 판정), `tools/make-console-vectors.mjs`(저장된 비밀번호 83건, 주소와 비밀번호 규칙 56건, 쿠키 60건, 감사 검색이 저장소에 묻는 것 128건, 달 13건, 청구 120건), `tools/make-sandbox-vectors.mjs`(기준의 핸들러가 답한 이름 붙은 경우 336건, 샘플 증빙의 자리 38곳과 패키지의 자리 16곳을 값 30가지로 바꿔 경로마다 물은 표 6,300칸, ZIP 28건, PDF 41건, 헤더 값 15건). 모두 `--check`로 파일이 지금의 기준과 같은지 확인합니다. 비밀번호 벡터 가운데 5건은 Java가 일부러 더 엄격하고(D-10), 샌드박스 벡터 가운데 14건은 일부러 다르며(D-04 6, D-06 3, D-12 5), 벡터 파일이 그 건을 표시합니다. D-13의 8건과 D-14의 3건·표 9칸은 차이가 없어져(TypeScript 수정, SDK 릴리스) 지금은 기준의 답 그대로 확인합니다.
   - **독립 검증기와의 왕복** (`RoundTripProducerTest` → `node apps/core-java/tools/check-roundtrip.mjs`): Java가 만든 번들 186개를 TypeScript 검증기(`packages/attest-verify`)가 통과시키고(A·B·C1 통과, C2는 체인이 없어 건너뜀), 변조본 745개를 변조한 고리에서 걸러내야 합니다. 생산자와 검증자는 코드를 나누지 않습니다. 나머지 두 종류도 씁니다: 서명 앵커 14개(P-256 키와 RSA 키)와 인스크립션 6개(리빌 트랜잭션을 여기서 짓고 서명만 함: 전송 없음). 검증기는 함께 넣은 파일을 대조해야 합니다: 제 문서면 통과, 다른 문서면 링크 A 실패(앵커는 그대로 통과), 서명 앵커에 문서를 안 넣으면 링크 A는 `skip`(138건).
   - **준비금 증명** (`tools/make-por-vectors.mjs`, `PorVectorsTest` 6건): statement의 모양 42건과 표 591칸, 커밋먼트 11건, 오프닝 90건과 표 665칸(저장소의 `fixtures/por` 증명 포함), 커버리지 27건, 오프닝 인덱스의 정렬 19건, 노드의 답 58가지와 요청 9건(도구와 테스트가 각자 띄우는 한 메서드짜리 노드에 대해: 실제 노드는 읽지 않음).
   - **송금 레일 1부** (`tools/make-remit-b1-vectors.mjs`, `RemitB1VectorsTest` 14건): 기준의 코드가 낸 답입니다. 견적 산술 295건과 견적 요청 72건, 전문 참조 114건과 쌍둥이 키, 요청 해시 37건, 원장 커서 27건, 키링에 드는 키 46건과 키의 표기 16가지, 플랫폼 키 파일과 keyId, 레지스트리 3개, 접수 지시 126건(기준의 경로 처리기가 자기 저장소에서 답함: 접수 15, 거절 111. D-18의 3건은 벡터가 표시), 전문 충돌의 거절 문장 5건, 모드 B의 진술 21건, 기록된 이벤트 로그 12개의 대사 24번과 패키지·커밋, 체인 노드의 답 71가지. 새 설정 둘과 키 파일의 규칙은 `RemitSettingsTest`, 새 표의 id는 `TimeOrderedIdTest`.
   - **송금 레일의 저장소 테스트** (`RemitStoreIT`, `RemitAcceptanceIT`: 이름으로만 돕니다. `./mvnw -o test -Dtest='Remit*IT' -Dstonehash.env=.env.dev`, 시험 스키마에서): 기준의 실제 저장소가 MySQL에서 답한 순서열 95개·1,063단계(`tools/make-remit-b1-store-vectors.mjs`가 기준의 시험 스키마에서 돌려 `remit-b1-store.json`으로 남김)를 접수 트랜잭션에 한 단계씩 넣어 답과 두 표의 행을 맞추고, 같은 도구가 남긴 원장 검색 120건을 같은 행에 묻습니다. 기준의 MySQL 테스트(`mysql-parity.test.ts`)의 연결 8개 경우, 같은 멱등키(같은 본문·다른 본문·거절 뒤, 차례로와 동시에), 거절된 접수가 남기는 인식 기록, 전부 아니면 전무, 조건부 전이와 이벤트 순번, 작업 행(갈래마다 하나, 선점은 한 쪽만, 울타리), 플랫폼 기관 행, 일별 대사. Java가 만든 것을 기준의 코드가 확인합니다(`tools/check-remit-b1-made.mjs`: 키 파일과 keyId, 접수가 남긴 플랫폼 서명, 웹훅 본문의 서명, 일별 대사의 서명과 커밋).
   - **SDK 고정** (`sdk.lock`, `tools/install-sdk.sh`, `SdkPinTest`): 정규화 바이트는 SDK의 `Json.canonical` 하나가 만듭니다. 빌드에 들어온 SDK jar가 고정한 릴리스인지 테스트가 확인합니다.
2. **스키마** (`tools/dump-schema.mjs`, `tools/make-baseline.mjs`, `tools/compare-schema.mjs`): 버전 1은 운영 스키마의 `SHOW CREATE TABLE`(읽기 전용)에서 뽑았습니다. 빈 스키마에 적용한 결과와 운영 스키마를 카탈로그(표, 열, 인덱스, 외래 키, CHECK)로 비교해 차이가 0이어야 합니다.
3. **응답** (`parity/run.mjs`, 자세한 것은 `parity/README.md`): 두 임시 스키마에 같은 기록을 넣고(`tools/seed-reference.mjs`) 같은 요청을 두 서버에 보내 상태 코드, 헤더, 본문을 비교합니다. 감사 기록도 두 스키마를 맞댑니다(`tools/compare-audit.mjs`). 제품 경로가 쓰는 기관·구독 표도 맞댑니다(`tools/compare-registry.mjs`). 증빙 아카이브는 구성 파일을 풀어 바이트로, ZIP의 필드는 하나씩 비교합니다. 대조용 Java 서버는 노드에 없는 지갑 이름으로 띄웁니다(`.env.parity`, `tools/make-parity-env.mjs`): 어떤 규칙이 깨진 빌드로 대조해도 인스크립션이 나가지 않습니다. 대조 대상은 운영 `:8787`이 아니라 임시 스키마에 띄운 두 번째 TypeScript 코어입니다(`tools/run-reference-core.mjs`, `:8791`, 워커 끔). 알려진 차이는 `parity/expected.json`에 이유와 함께 적고, 목록에 없는 차이나 더 이상 나타나지 않는 항목이 있으면 실패합니다. 일부러 다르게 한 동작은 `docs/JAVA-INTENDED-DIFFERENCES.md`에 있습니다. 콘솔이 꺼진 배포와 운영(live) 배포의 답은 두 서버를 그 설정으로 띄워 따로 대조하고(`--file console-off`), 콘솔의 트랜잭션 조회는 실제 인스크립션 한 건으로 확인합니다(`tools/check-console-tx.mjs`). 송금 레일은 심어 둔 원장(`tools/seed-remit.mjs`: 송금 191건, 조직 9개)에 대해 1부의 경로 11개를 묻습니다(`parity/cases/remit-b1-routes.mjs` 965건: 플랫폼 메타, 기관 등록과 해지, 문, 견적, 거절되는 접수 — 검사마다, 그리고 모든 검사를 통과한 뒤 트랜잭션이 거절하는 전문 충돌까지 — 원장의 검색·정확 조회·페이지, 송금마다의 조회·체인(노드의 답 27가지)·증빙, 일별 대사). 접수되는 요청은 넣지 않았습니다: 기준은 접수 뒤 파트너를 부르고 1부의 Java는 부르지 않으므로 두 파트너 대역이 받은 요청이 달라집니다(`tools/run-parity.sh`가 그것도 비교합니다). 문자열이 아닌 id도 한 건만 넣었습니다(D-18: 숫자 id는 기준 서버의 연결을 그 뒤로 틀어지게 합니다. `tools/probe-reference-id-binding.mjs`).

```
node apps/core-java/tools/run-reference-core.mjs apps/core-java/.env.ref     # 기준 서버 (:8791)
node apps/core-java/parity/run.mjs --ref http://127.0.0.1:8791 --java http://127.0.0.1:8790
```

## 하지 않는 것

- 운영 중인 `:8787`, 스키마 `stonehash_attest`, 지갑 `attest`, anvil에는 붙지 않습니다. 두 코어가 같은 스키마에 동시에 붙으면 같은 배치를 두 번 봉인하고 같은 웹훅을 두 번 보냅니다.
- `deploy/reset-sandbox.sh`를 실행하지 않습니다.
- 부하 시험은 요청이 있을 때만 합니다.
