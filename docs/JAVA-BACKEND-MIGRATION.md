# 백엔드 Java 전환 — 작업 지시서

- **상태:** v2.1 (2026-11-18). a7·c7 세션 의견, 소유자 결정 5건, 독립 검토 3건(실행 가능성, 동작 동등성, 계획과 스택)을 반영했습니다. 이 판으로 착수할 수 있습니다. 착수 전에 실행 세션에서 소유자의 확인을 받습니다.
- **작성:** 아키텍처 분석 세션(`bitcert-attest-3f`). **실행은 `a7` 세션 한 곳이 맡습니다(소유자 결정 2026-11-18).** `c7` 세션은 하던 일을 마치고 송금 인계 메모를 남깁니다(6장).
- **근거가 된 소유자 지시(2026-11-18, 원문):** "백엔드는 전부 자바로 변경해주는데, 이미 다른 세션에서 작업을 진행하고 있어서. 그 세션에서 작업이 가능하도록 일을 시켜줘봐"
- **배경:** 소유자는 향후 스테이블코인 발행 플랫폼과, 은행·고객사 측에 시스템을 구축해 주는 납품 형태를 염두에 두고 Java를 택했습니다.

이 문서는 "무엇을, 어떤 순서로, 무엇을 지키면서" 옮길지를 정합니다. 세부 설계와 일정은 실행 세션이 정합니다. `기본값`이라고 적힌 항목은 분석 세션의 선택이며 소유자가 바꿀 수 있습니다.

---

## 1. 범위

### Java로 옮기는 것

플랫폼 백엔드 `attest/apps/core` 전체입니다. API, 백그라운드 워커, DB 접근, 체인 연동을 모두 포함합니다.
코어가 실행 중에 불러 쓰는 패키지 로직도 서버 쪽 구현이 Java로 필요합니다.

| 패키지 | 코어가 쓰는 것 |
|---|---|
| `attest-verify` | `jcs`, `jcsString`, `statementLeaf`, `verifyStatement`, `verifyPorInclusion`, `porSnapshotCommitment` |
| `attest-rules` | `evaluate`, `verifyEvidenceSignatures`, `validatePolicy`, `keyring`, `DEMO_KEYRING`, `signedBytes`, `toBase64Url`·`fromBase64Url`. 콘솔 샌드박스(`http/sandbox.ts`)는 시나리오 생성기(`SCENARIOS`, `buildScenario`, `breakDigest`, `breakSignature`, `changeAmount`, `duplicateReceipt`, `removeDocument`)와 고정 자료(`DEMO_ISSUER_KEYS`, `SAMPLE_POLICY`, `SAMPLE_SETTLEMENT`)도 씁니다. 같은 키로 같은 바이트가 나와야 합니다 |
| `attest-evidence` | `assembleEvidenceBundle` (증빙 ZIP 조립) |
| `attest-por` | `validateSnapshotStatement` |

### 그대로 두는 것

- 브라우저에서 도는 것: 검증 도구(`apps/playground`), 개발자 허브(`apps/docs`), 콘솔 화면(`apps/console`). 백엔드는 지금처럼 이 정적 파일을 내주기만 합니다.
- 고객에게 배포하는 TypeScript 패키지(`attest-verify`, `attest-sign`, `attest-por`, `attest-remit`)와 Java·Go SDK. 계속 제품입니다.
- 홈페이지 서버(`homepage/`), 데모 서버(`demo-bank`, `demo-customers`, `demo-partners`의 Node 서버), 정산 체인 탐색기용 게이트웨이(`evm-explorer/`). **기본값: 범위 밖.** 공개 API만 쓰는 시연·보조 도구이기 때문입니다. 소유자가 포함하라고 하면 추가합니다.

### 깨면 안 되는 계약

1. **REST 계약.** `attest/apps/docs/openapi.json`의 66개 오퍼레이션: 경로, 필드 이름, 상태 코드, 오류 본문 `{ "error": 코드, "message": 문장 }`. 오류에 따라 추가 필드가 `error`·`message`와 같은 층에 붙습니다(`ServiceError.detail`, 예: `existing_payment_id`).
2. **바이트 단위 형식.** 증명 번들(`fixtures/bundle-schema.md`), BC01(53바이트), Merkle(RFC 6962 태그 + 마지막 리프 복제 + 중복 리프 거부), JCS, 서명 대상 바이트(도메인 접두사 포함), PoR 트리, SWIFT 골든.
3. **기존 데이터.** 조직 기록은 만료가 없습니다(샌드박스도 운영과 같음). 전환으로 한 건도 잃으면 안 됩니다.
   - DB 밖의 상태도 기존 데이터입니다. 플랫폼 서명키는 파일입니다(`REMIT_PLATFORM_KEY_PATH`, 기본 `${STONEHASH_DATA_DIR}/platform-remit-key.pem`, PKCS8 P-256 PEM). keyId는 `STONEHASH-SIGN-`에, 공개키 SPKI의 base64 글자(바이트가 아니라 그 글자열: `remit/sign.ts`의 `loadOrCreatePlatformKey`)를 SHA-256한 hex의 앞 8자리를 붙인 값입니다. 전환 뒤에도 같은 파일을 읽어 같은 keyId가 나와야 합니다.
   - TypeScript 코어는 이 파일이 없으면 새 키를 만듭니다. Java 운영 프로필은 만들지 않고 부팅을 멈춥니다. 개발 서버는 다른 경로의 별도 키를 씁니다.
4. **인증 호환.** API 키(`sk_test_`/`sk_live_`, SHA-256 hex 저장), 세션 쿠키(`stonehash_session`, HttpOnly, SameSite=Lax), 비밀번호 해시(`scrypt$N$r$p$salt$hash`, N=32768·r=8·p=1). 기존 계정이 다시 가입하지 않아도 로그인돼야 합니다.
   - 비밀번호 검증은 저장된 문자열의 N·r·p와 저장된 해시의 길이로 계산합니다. 상수로 가정하지 않습니다. salt(16바이트)와 hash는 표준 Base64입니다(패딩 있음, URL-safe 아님). 파라미터가 비정상이면 500이 아니라 로그인 실패로 답합니다. 해시 한 번에 메모리를 약 32MiB 씁니다. Node는 한 번에 하나씩 계산했지만 Java의 서블릿 스레드는 여럿이 동시에 계산할 수 있으므로, 동시에 도는 해시 수를 제한합니다(기본 2).
   - 키 API의 인증 순서: `Authorization: Bearer` 키를 먼저 봅니다. 키가 없거나 틀리면 `STONEHASH_ENV=test`이고 콘솔이 켜져 있을 때만 세션 쿠키를 받습니다. 둘 다 아니면 401 `unauthorized`입니다. 콘솔 샌드박스가 이 경로로 키 API를 부릅니다. 운영(live)에서는 쿠키로 키 API가 열리면 안 됩니다.
   - 세션은 `sessions` 표를 그대로 씁니다(`token_hash`는 토큰의 SHA-256 hex). 서블릿 `HttpSession`이나 Spring Session을 쓰지 않습니다. 쿠키 속성은 `account.ts`의 `sessionCookie`와 같습니다: `Path=/`, `Expires`, `HttpOnly`, `SameSite=Lax`, 그리고 `Secure`는 설정이 켜진 때만 붙습니다(시험 서버가 HTTP입니다).
5. **정적 화면과 보안 헤더.** `/console/`, `/docs/`, `/playground/` 경로와 `static.ts`가 붙이는 CSP 등 헤더.
   - 무료 티어 경로(`/v1/public/anchors*`)의 CORS도 계약입니다. 홈페이지가 다른 출처에서 이 경로를 부릅니다. 허용 출처는 설정(`publicAnchor.allowedOrigins`)을 따르고, 메서드는 `GET, POST, OPTIONS`, 헤더는 `content-type`, `max-age`는 600이며, OPTIONS에는 204로 답합니다(`http/public.ts`). 전역 CORS 설정으로 바꾸지 않습니다.
6. **독립 검증.** Java 백엔드가 만든 번들을 TypeScript 검증기(`attest-verify`)가 통과시켜야 합니다. 생산자와 검증자가 코드를 공유하지 않는다는 제품 원칙은 오히려 강해집니다.

### 동작 동등성: 코드에만 적혀 있는 규칙

문서에는 없고 TypeScript 코드에만 있는 동작입니다. 고객과 저장된 행이 여기에 기대고 있으므로 그대로 옮깁니다. 지시서 검토에서 나온 항목을 3f가 코드로 확인했습니다. 근거 줄 번호는 `analysis-2026-11-18/work-order-review-parity.json`의 같은 번호에 있습니다.

| 항목 | 지켜야 하는 것 | 근거 |
|---|---|---|
| 시각 문자열 | 기존 표의 시각 열은 모두 문자열 열이고(MySQL에서는 `VARCHAR(40)`) 문자열로 비교·정렬합니다(만료 정리, 사용량 집계, 배치 선택, 웹훅 예약, 목록). JS `toISOString()`과 같은 형식으로만 씁니다: UTC, 밀리초 3자리, `Z`(`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`). `Instant.toString()`과 Jackson의 기본 직렬화는 쓰지 않습니다. 정각에는 소수부가 빠지고 마이크로초 6자리가 나올 수 있어 정렬이 깨집니다. 비교에 넣는 값(만료 기준, 집계 시작, 커서)도 같은 형식으로 만듭니다. 형식을 만드는 함수는 하나만 두고, 계약 테스트에 형식 검사를 넣습니다 | PAR-01, PS-04 |
| DB에 저장된 해시 | 멱등 요청 해시는 `JSON.stringify(파싱한 본문)`의 SHA-256 hex입니다. SWIFT 쌍둥이 키 두 가지(`remit/store.ts`의 `twinKeyOf`)는 `JSON.stringify(배열)`의 SHA-256입니다. JCS도 아니고 원본 바이트도 아닙니다. 기존 행과 같은 값이 나오도록 JS `JSON.stringify`의 출력(키 순서, 숫자 표기, 이스케이프)을 재현하고, TypeScript가 저장한 행으로 만든 벡터로 확인합니다. 값이 달라지면 전환을 걸친 재시도가 409가 되고, 이중 접수 차단이 기존 행을 알아보지 못합니다 | PAR-02 |
| 서명 형식 | ES256 서명은 64바이트 r‖s(IEEE P1363)이고 패딩 없는 base64url입니다. JCA 기본값(DER)과 `Base64.getUrlEncoder()` 기본값(패딩)은 쓰지 않습니다. SDK의 `Signing`을 지나면 맞습니다 | PAR-05 |
| 정규화(JCS) | 정수는 ±(2^53−1)만 받고 소수와 범위 밖 수는 거부합니다. 금액은 10진 문자열입니다. SDK의 `Json.canonical`이 같은 규칙으로 거부하는 것을 확인했습니다. 범용 RFC 8785 라이브러리나 Jackson으로 대신하지 않습니다. 샌드박스 자료의 `canonical()`(`http/sandbox.ts`)은 규칙이 다릅니다(소수 허용, undefined 제외). 따로 옮깁니다 | PAR-06 |
| 도메인 문자열 | 바이트 그대로 옮깁니다. 이름을 통일하거나 개행을 정리하지 않습니다. 끝의 개행은 문자열마다 있기도 하고 없기도 하므로 소스에서 확인합니다. 2026-11-18 검색 결과: `stonehash:attestation:sig:v1`, `stonehash:evidence:sig:v1`, `stonehash:evidence:digest:v1`, `stonehash:remit:event:v1`(PoR statement 서명도 이 문자열을 씁니다), `stonehash:remit:twin:v1`, `stonehash:remit:twin-by-message:v1`, `stonehash:swift:content:v1`, `attest:settlement:v1`, `bitcert:chain:v1`, `STONEHASH-EVIDENCE-V1`, `STONEHASH-MANIFEST-V1`, `STONEHASH-POR-V1`, `STONEHASH-POR-LEAF-V1`, `STONEHASH-POR-NODE-V1`, `STONEHASH-POR-EMPTY-V1`, `STONEHASH-POR-USER-V1` | PAR-07 |
| 배치 봉인 순서 | 가장 오래된 대기 행의 조직 하나를 고릅니다. 그 조직의 대기 행을 `created_at ASC, rowseq ASC`로 최대 `maxLeaves`개 담고, `leaf_index`는 그 순서입니다. `merkle_proofs`의 `siblings`·`directions`는 공백 없는 JSON 배열입니다. `rowseq` 열은 기준선에 두되 응답으로 내보내지 않습니다 | PAR-08 |
| 응답 본문 | JSON은 2칸 들여쓰기입니다(`JSON.stringify(body, null, 2)`). 값이 없는 필드는 `null`로 내지 않고 생략합니다. 오류 본문은 추가 필드, `error`, `message` 순서입니다 | PAR-09 |
| HTTP 경계 | Spring의 기본 오류 응답(405, 415, 본문 없음 400, 기본 오류 페이지)을 쓰지 않습니다. 맞는 경로와 메서드가 없으면 404 `not_found`입니다. 빈 본문은 `{}`로 읽고 Content-Type은 검사하지 않습니다. JSON 오류는 400 `invalid_json`, 1 MiB 초과는 413 `payload_too_large`, 잘못된 %-인코딩은 400 `invalid_path`입니다. `?limit=`는 숫자가 아니거나 1 미만이면 기본값, 소수는 내림, 상한을 넘으면 상한입니다(`pageLimit`). 끝의 `/`와 `//`도 현행 라우터와 같게 처리합니다 | PAR-03 |
| 감사 기록 | 인증을 통과한 요청만 남깁니다. `SILENT_READS`에 든 GET만 빼고 전부 기록합니다. 경로는 512자로 자릅니다. 기록은 응답을 내보내기 전에 끝냅니다. 응답 뒤에 비동기로 쓰면 조작 직후의 감사 조회에 행이 없을 수 있습니다. 기록이 실패해도 응답은 그대로 보냅니다 | PAR-10 |
| 속도 제한 | 고정 창입니다(첫 요청부터 `windowMs`). 무료 티어는 주소별, 전역 순서로 검사하고 429 `rate_limited` 또는 `capacity`와 `retry-after`(남은 초, 올림)를 보냅니다. 주소는 `trustProxy`일 때만 `X-Forwarded-For`에서 읽습니다. 카운터가 프로세스 메모리에 있으므로 API 인스턴스는 하나로 둡니다 | PAR-11 |
| 문자열 비교 | 열이 `utf8mb4_bin`이라 대소문자를 구분합니다. hex, UETR, 내용 해시는 저장하고 조회하기 전에 소문자로 바꾸고, 출력도 소문자입니다. 검색은 `UPPER(col) LIKE ? ESCAPE '!'`와 `likeContains`(`db.ts`)의 규칙을 씁니다. 결제 이벤트 검색의 `JSON_EXTRACT`(`remit/store.ts`)는 MySQL 전용입니다. 2장의 분기 지점에 넣거나 대체 방식을 정합니다 | PAR-12 |
| 금액 계산 | 견적은 10진 문자열의 고정소수점 곱셈과 반올림(half-up)입니다(`mulDecimal`). `BigDecimal`과 `RoundingMode.HALF_UP`으로 같은 자릿수 규칙을 쓰고, 문자열로 바꿀 때는 `toPlainString()`만 씁니다(`toString()`은 지수 표기가 나옵니다). `double`은 쓰지 않습니다. API와 JCS에서 금액은 숫자가 아니라 10진 문자열입니다 | PAR-13 |
| ID와 비밀값의 모양 | 기존 표의 것은 그대로 둡니다. 견적은 `QT-`와 UUID 앞 13자, 증빙은 `EV-`와 대문자 8자, API 키는 접두사와 base64url(24바이트), 세션 토큰은 base64url(32바이트)입니다. base64url은 패딩 없이 씁니다. 시간순 ID는 새 표에만 씁니다 | PAR-15 |

---

## 2. 목표 스택 (기본값)

| 항목 | 기본값 | 이유 |
|---|---|---|
| 언어 수준 | Java 17 (Spring Boot 4.1의 최소 버전. 실행은 17 이상) | 은행 설치 환경과의 호환 폭 |
| 프레임워크 | Spring Boot 4.1.x, 서블릿 방식(Spring MVC). 산출물은 내장 Tomcat으로 뜨는 실행 jar | 은행·SI 인력이 넘겨받아 유지보수 가능. 2026-11-18 확인: 공개 지원 중인 계열은 4.1(2027-07-31까지)과 4.0(2026-12-31 종료)뿐이고 3.5는 2026-06-30에 끝났습니다. 4.1.2는 Java 17 이상, Maven 3.6.3 이상, Servlet 6.1(Tomcat 11)을 요구합니다. 그래서 은행의 기존 WAS에 WAR로 올리는 방식은 범위 밖입니다(7장) |
| 빌드 | Maven (wrapper 포함) | 은행 내부 저장소·오프라인 빌드에 무난 |
| 구조 | 모듈형 모놀리스, 산출물 하나. 역할은 프로필로 분리(`api`, `worker`) | 분석 결론 유지 |
| DB 접근 | 명시적 SQL(MyBatis, Boot 4 대응판. 버전은 착수 때 확인). 돈을 다루는 표에 JPA 사용 금지 | 잠금·격리수준을 눈에 보이게, DB 제품별 SQL 분기 가능 |
| DB | 우리 SaaS는 MySQL 8.4 LTS 목표(현재 서버는 8.0.46). 표준 SQL을 우선하고, 제품마다 다를 수밖에 없는 것은 분기 지점으로 모읍니다: 행 수 제한, 작업 선점(`FOR UPDATE SKIP LOCKED`), 자동 증가(`rowseq`), upsert, 큰 텍스트(`MEDIUMTEXT`), 빈 문자열(Oracle은 NULL로 저장). 매퍼는 MyBatis `databaseId`로, 마이그레이션은 제품별 폴더로 나눕니다. 지금은 MySQL 것만 만듭니다. 표와 연결은 `utf8mb4_bin`으로 고정합니다 | 은행 납품 시 Oracle 계열에도 올라가야 함. 물려받는 스키마와 쿼리가 이미 MySQL 전용 기능을 쓰므로 "전용 기능 없이"는 지킬 수 없는 규칙입니다. MySQL 기본 콜레이션은 대소문자를 구분하지 않아 키와 멱등키가 겹칩니다 |
| 스키마 변경 | Flyway(MySQL에는 `flyway-mysql` 모듈이 따로 필요). 마이그레이션은 한 번 실행하고 끝나는 별도 단계로만 합니다. `api`·`worker`는 `spring.flyway.enabled=false`로 띄우고, 스키마 이력의 최신 버전이 앱이 기대하는 버전과 다르면 기동을 거부합니다 | Spring Boot는 Flyway가 클래스패스에 있으면 기동할 때 `migrate()`를 자동 실행합니다. 그대로 두면 API와 워커가 뜰 때마다 DDL을 실행합니다. 은행 납품 때는 DBA가 같은 스크립트를 적용합니다 |
| 암호 | JCA(P-256, SHA-256, HMAC, AES-GCM, ECDH)에 BouncyCastle을 더합니다. scrypt와 secp256k1 곡선 연산(JDK 16부터 곡선이 빠짐)은 BouncyCastle 것을 씁니다. BIP340 Schnorr 서명기(`BIP340Signer`)도 BouncyCastle에 있습니다(1.87 API 문서에서 확인. 들어온 버전은 착수 때 확인). 탭루트(BIP341: 키 트윅, 스크립트 트리, sighash, control block)는 BouncyCastle에 없으므로 `btc/taproot.ts`(220줄)를 이식합니다 | 기존 벡터(`inscription`, `schnorr`, 기존 계정 해시)와 BIP340 공식 벡터로 검증. BouncyCastle의 Schnorr는 기본이 무작위 서명이고 결정적 모드는 aux=0뿐이므로, 서명 벡터는 aux 값을 고정한 난수원을 넣어 재현합니다 |
| 테스트 | JUnit 5 + 실제 MySQL 임시 스키마. SQLite 없음 | 동시성 결함은 SQLite에서 재현되지 않음 |
| 위치 | `attest/apps/core-java/` | 기존 `apps/core`는 전환 완료까지 그대로 운영 |
| 설정 | 환경 변수 이름을 지금과 동일하게(아래 3장). `STONEHASH_DB_URL`은 `mysql://사용자:비밀번호@호스트:포트/DB` 형식이므로 Java가 파싱해 JDBC 설정으로 바꿉니다. 값이 비면 부팅을 거부합니다(TypeScript는 SQLite로 떨어집니다) | 전환 때 운영 `.env`를 그대로 쓰기 위해서입니다. **개발 서버는 운영 `.env`를 그대로 읽지 않습니다(6장)** |

의존성은 허용 목록으로 관리합니다(Spring Boot 스타터, 요청 검증 스타터, MyBatis, Flyway와 `flyway-mysql`, MySQL 드라이버, BouncyCastle, Jackson). 그 밖의 추가는 사유를 적습니다. API 문서 대조(4장 7번)는 두 방법 중 하나를 0단계에서 정합니다: 문서 생성 라이브러리를 허용 목록에 더하거나, Java가 빌드 때 라우트 목록 파일(메서드와 경로)을 내고 `apps/docs/test/openapi.test.ts`가 그 파일을 읽게 합니다.
SDK(`attest-remit-java`, `attest-por-java`)의 "JDK만, 의존성 0, Java 11" 원칙은 건드리지 않습니다. 백엔드가 SDK를 의존성으로 가져다 쓰는 것은 괜찮습니다.

SDK를 의존성으로 쓰는 방법: SDK는 Maven 프로젝트가 아닙니다(`build.sh`, `javac --release 11`). `sdks/attest-remit-java/release/`에 jar, 소스 jar, pom(`com.stonehash:stonehash-attest-remit:0.1.0`), `SHA256SUMS`가 있습니다. 해시를 확인한 뒤 로컬 Maven 저장소에 설치해 씁니다. `attest-por-java`는 `dist/`에 jar만 있고 pom이 없습니다. SDK 소스를 `core-java`로 복사하지 않습니다. SDK의 새 버전이 나오면 백엔드의 의존 버전을 함께 올리고 변경 기록에 남깁니다.

---

## 3. 현재 백엔드 인벤토리 (2026-11-18 기준)

| 영역 | 위치 (`attest/apps/core/src/`) | 줄 수 | 내용 |
|---|---|---|---|
| 뼈대·서비스 | `main.ts`, `config.ts`, `service.ts`, `worker.ts`, `auth.ts`, `account.ts`, `audit.ts`, `billing.ts`, `db.ts` | 3,057 | 부팅, 설정, 앵커링 상태 전이, 배치 워커, 인증, 감사, DB |
| HTTP | `http/` | 2,646 | 라우터, 콘솔 API, 무료 티어, 샌드박스 자료, 정산 증빙, 정적 서빙, 속도 제한 |
| 송금 | `remit/` | 3,662 | 오케스트레이터, 저장소, 레지스트리, 서명, JWE, IVMS101, 웹훅, 워커 |
| 준비금 증명 | `por/` | 621 | 스냅샷 접수·조회, 준비금 측정 |
| 체인 | `anchor/`, `btc/` | 1,232 | bitcoind 연동, 트랜잭션·탭루트·인스크립션, secp256k1 |
| 형식 | `merkle/`, `bundle/` | 291 | Merkle 트리, 번들 조립 |

- **라우트:** `http/routes.ts` 45개, `remit/routes.ts` 19개, `por/routes.ts` 5개 등록(OPTIONS 3개 포함).
- **표 22개:** `orgs`, `api_keys`, `accounts`, `sessions`, `issuer_keys`, `audit_log`, `subscriptions`, `institutions`, `attestations`, `batches`, `merkle_proofs`, `anchor_txs`, `remit_quotes`, `remit_payments`, `remit_events`, `remit_travel_rule`, `remit_idempotency`, `remit_webhook_deliveries`, `remit_manifests`, `remit_source_refs`, `remit_source_matches`, `por_snapshots`. (`remit_source_matches`는 2026-11-18 05:59Z의 코어 재시작으로 생겼습니다. 이 문서를 쓰는 동안에도 표가 하나 늘었으니, 기준선은 뽑는 시점의 운영 스키마를 봅니다.)
- **백그라운드 작업:** 배치 워커(3초 주기: 봉인 → 앵커 → 확인 갱신 → 무료 티어 정리), 송금 워커(2초 주기: 앵커 확정 반영, 웹훅 발송).
- **외부 연동:** bitcoind JSON-RPC, EVM JSON-RPC(읽기), 파트너 HTTP(`remit/partners-client.ts`), 고객 웹훅 발송.
- **설정 키:** `config.ts`가 읽는 환경 변수 51개. 이름과 기본값을 그대로 유지합니다.
- **박스의 도구:** OpenJDK 11만 설치돼 있고 Maven·Gradle이 없습니다. Spring Boot는 Java 17 이상이 필요합니다. 소유자가 시스템 패키지 설치로 정했습니다(7장). 저장소에 `openjdk-17-jdk-headless` 17.0.21과 `maven` 3.8.7이 있고 `sudo`는 비밀번호 없이 됩니다(3f 확인).
- **기대는 인프라:** bitcoind regtest(Docker `regtest-bitcoind-1`, 지갑 `attest`), anvil(pm2 `stonehash-anvil`, 재시작하면 체인이 사라짐), MySQL(호스트의 mysqld, `127.0.0.1:3306`).
- **regtest의 상태(2026-11-18 3f 확인, 읽기 전용 조회):** 노드 `127.0.0.1:18443`은 높이 10,139이고 블록 보상이 0입니다. 새 지갑은 채굴로 자금을 만들 수 없습니다. `attest` 지갑에는 약 9.99 BTC(쓸 수 있는 출력 166개)가 있습니다. 같은 노드의 `beecert` 지갑은 다른 프로젝트 것입니다. 앵커 백엔드는 `regtest`와 `mainnet`뿐이고 모의 백엔드는 없습니다. regtest 백엔드는 확정을 위해 블록을 직접 만듭니다(`generatetoaddress`).

### 이미 Java로 있는 것 (a7 세션 확인, 2026-11-18)

백엔드가 그대로 가져다 쓸 수 있습니다. 전부 TypeScript 구현에서 뽑은 벡터로 맞춰져 있고 OpenJDK 11·17·21에서 통과합니다.

| 위치 | 내용 |
|---|---|
| `sdks/attest-remit-java` (`com.stonehash.attest.remit`) | `Json`(파서, RFC 8785 JCS 정규화), `Hex`·`Base64Url`, `Signing`(ES256 raw r‖s, 이벤트·증빙 요소 도메인), `Signers`(외부 HSM 서명기, DER↔raw), `EvidenceVerifier`, `AnchorProof`(번들 검증: Merkle, 앵커 페이로드, txid 재계산), `VerdictEngine`(`attest-rules`의 `evaluate`와 `verifyEvidenceSignatures` 전체 이식), `TravelRule`(IVMS101, 기관 공개키 암호화), `RemitClient` |
| 같은 SDK의 `…remit.swift` | MT103·pacs.008·pain.001 판독, 변환표, 지급 ID, pacs.002 (약 5,800줄, c7 세션 작성) |
| `sdks/attest-por-java` | PoR 트리와 증명 (본문 약 6,500줄) |

따라서 JCS·서명·번들 검증은 새로 옮길 필요가 없습니다. 남는 것은 번들 **생성**(Merkle 트리 구축, BC01 인코딩, 번들 조립), 증빙 ZIP 조립, statement 검증, PoR statement 검증, 그리고 서버 자체입니다.

주의할 점 두 가지(a7 세션 확인):

- **규칙 엔진은 넓혀야 합니다.** SDK의 `VerdictEngine`은 축 상태와 `(axis, code, severity)`만 냅니다. 코어는 `findings`의 상세 필드와 `policyDigest`, `manualReviewRequired`까지 든 `MatchingResult` 전체를 증빙 패키지에 넣고, 그 바이트가 커밋 대상입니다. 백엔드용으로 전체를 내도록 확장해야 합니다(a7이 3단계와 5단계 전에).
- **`attest-por-java`는 2026-11-17에 소유자가 중단시킨 작업입니다.** 4단계에서 재사용하려면 소유자가 중단을 풀어야 합니다(7장).

**바이트 규약 구현은 한 벌만 둡니다.** JSON 정규화, 서명, 규칙 엔진 같은 공통 코드는 한 곳에 두고 한 세션(a7)만 수정합니다. SDK와 백엔드가 같은 규약을 따로 구현하지 않습니다. 구체적으로는 이렇게 합니다(a7 세션 제안).

- **의존 방향은 한쪽입니다.** 백엔드가 SDK jar를 버전과 해시로 고정해 의존합니다. SDK는 계속 `javac --release 11`, 의존성 0으로 따로 릴리스합니다. SDK가 백엔드나 Spring·Jackson 타입에 기대는 것은 금지입니다.
- **서명·커밋 바이트는 SDK의 `Json.canonical`을 지나야 합니다.** SDK의 `Json`은 자체 파서입니다(중복 키 거절, 2^53을 넘는 수는 BigDecimal, JS 키 순서 출력). HTTP 응답 직렬화는 Jackson이어도 되지만, 서명 대상 바이트를 만드는 자리에서는 Jackson을 쓰지 않습니다.
- **SDK에 얇은 공개 진입점 둘을 엽니다** (a7 제안, 이름은 가칭). jar는 하나 그대로 두고 같은 패키지에 public 클래스를 더합니다. 내부 구현은 옮기지 않습니다. 값은 JSON 값(Map·List·String·Long·BigDecimal·Boolean·null)으로 주고받습니다.
  - `Conventions`: 정규화(`Json.canonical`), 이벤트·증빙 요소의 서명 대상 바이트와 서명·검증, base64url, 증빙 커밋, 공개키 검사(오류 문장이 API 계약이므로 TypeScript 기준 구현의 문장을 그대로 씀).
  - `Rules`: `evaluate`(TypeScript의 `MatchingResult` 전체를 JSON 값으로), `checkSignatures`(키마다 신뢰 수준을 갖는 keyring), `validatePolicy`, `policyDigest`. 백엔드는 생산자이므로 TypeScript 엔진과 같은 답을 내야 합니다. 은행용 `EvidenceVerifier`의 더 엄격한 검사는 그쪽에만 남깁니다.
- **SDK에 두지 않고 백엔드에 새로 쓰는 것:** 콘솔 샌드박스 자료(`attest-rules`의 `SAMPLE_*`, `SCENARIOS`, 변조 함수)와 증빙 ZIP 조립(`assembleEvidenceBundle`). 규약이 아니라 자료와 조립이기 때문입니다.
- **트래블룰은 범위를 나눕니다** (c7·a7 합의).
  - SDK `TravelRule` 한 벌(공개 진입점으로 백엔드가 사용): 메시지 작성(`buildIvms101`), 필수 항목 검사(`missingTravelRuleFields`), 암호화(`encryptJwe`, `concatKdf`). 은행 SDK와 플랫폼이 바이트까지 같아야 하는 규약이기 때문입니다.
  - 백엔드에 둠: 복호화(`decryptJwe`)는 수취기관이 하는 일이라 SDK에 넣지 않고 시험·시뮬레이터 지원 쪽에 둡니다. 모드 B의 `fields_assertion` 검사는 플랫폼만 하는 판정이라 백엔드 `remit` 패키지에 둡니다.
- **생산과 검증은 Java 안에서도 나눕니다.** 생산 쪽 형식(Merkle 조립, BC01 작성, 번들 조립, `statementLeaf`)은 백엔드에만 새로 쓰고, 검증 쪽(`AnchorProof`)은 SDK에만 둡니다. 규칙 엔진만 의도적으로 공유합니다(TypeScript에서도 코어와 SDK가 `attest-rules`를 같이 씁니다).

분석 자료는 `docs/analysis-2026-11-18/`에 있습니다. 계층별 분석 6개(`*.json`), 결정안 반대 검토 3개(`review-*.json`), 이 지시서의 독립 검토 3개(`work-order-review-*.json`, 이 문서가 인용하는 EX-·PAR-·PS- 번호)입니다. 그 안의 줄 번호는 이후 수정으로 밀렸을 수 있습니다.

---

## 4. 옮기면서 고칠 것 (그대로 옮기면 안 되는 부분)

분석에서 확인된 결함입니다. TypeScript 구현을 한 줄씩 옮기지 말고 아래 규칙으로 새로 짓습니다. 새로 짓는 것은 아래 항목의 처리 방식에 한합니다. 밖에서 보이는 동작과 DB에 저장되는 값은 1장의 "동작 동등성" 표대로 그대로 옮깁니다. 근거는 `analysis-2026-11-18/`의 `remit-rail.json`(RR-), `database.json`(DB-), `chain-and-infra.json`(CH-), `backend-core.json`(BC-) 항목입니다.

**운영 자금이 흐르기 전에 반드시**

1. **원자적 상태 전이.** 상태 변경, 이벤트 추가, 다음 작업 적재를 한 트랜잭션으로 묶고, 기대 상태를 조건으로 겁니다. 이벤트 순번도 같은 잠금 안에서 매깁니다. (RR-03, DB-08)
   - 취소도 같습니다. 지금 `cancel()`은 상태를 읽어 취소 가능 여부를 본 뒤 무조건 `CANCELLED`로 덮어씁니다. 승인·전송이 먼저 지나가면 "취소됐는데 전송된" 상태가 됩니다. 취소는 취소 가능한 상태에서만 성공하는 조건부 갱신으로 만듭니다.
   - 전송 지시는 지급당 한 번만 잡히는 선점으로 만듭니다. (c7 세션 확인. 소유자 결정 2026-11-18: TypeScript에서 따로 고치지 않고 이 전환에서 고칩니다.)
2. **DB에 적재하는 작업 큐.** (이 번호와 3번의 구체적인 모양 — 갈래 셋, 지갑 호출은 한 번, "확인 중" 상태 없음 — 은 `docs/JAVA-REMIT-DESIGN.md` v2가 기준입니다. 아래 문장과 다르면 설계를 따릅니다.) 접수 뒤 처리를 메모리에서 이어 가지 않습니다. 작업 행을 짧은 트랜잭션으로 선점하고, 외부 호출은 트랜잭션 밖에서 하며, 결제당 실행 중 작업은 하나입니다. 재시도와 한도 초과 시 사람에게 알리는 상태, 재시작 후 재개를 포함합니다. (RR-01, RR-02)
3. **외부 호출 멱등성.** 파트너·체인 호출마다 단계별 멱등키를 쓰고, 타임아웃이면 "확인 중" 상태로 두었다가 조회 후에만 재시도합니다. 콜백은 중복 제거와 상태 전제조건을 둡니다. (RR-04, RR-15)
4. **앵커링 재시도.** 앵커 실패로 `sealed`에 남은 배치를 다시 시도합니다. 브로드캐스트 전에 기록을 남깁니다. (CH-01, CH-10)
5. **불변 복식부기 원장.** 계정·분개 표는 추가 전용, 분개 합계 0 검증, 정정은 역분개. 금액은 자산별 자릿수 표를 둔 정수(18자리 토큰은 `DECIMAL(38,0)`).
   - 원장은 TypeScript에 대응하는 구현도 표도 없는 새 기능입니다(표 22개 중 원장·분개 표가 없습니다). 대조할 기준이 없으므로 단계 완료 판정에서는 빼고, 실제 자금이 흐르기 전에 통과해야 하는 별도 관문으로 둡니다. 설계는 자금 보관 주체(7장)가 정해진 뒤에 합니다.
6. **격리수준과 잠금.** READ COMMITTED를 기본으로 하고 잠금은 명시합니다. 부팅 때 설정을 검증합니다.
   - 잠금에 기대는 판정은 격리수준과 무관하게 맞아야 합니다. 그러려면 트랜잭션을 시작한 직후 일반 `SELECT`를 먼저 하지 말고 `SELECT … FOR UPDATE`로 잠근 뒤에 조회합니다. REPEATABLE READ에서는 첫 일반 `SELECT` 시점에 스냅샷이 잡혀, 잠금 뒤의 조회가 앞선 커밋을 보지 못합니다. (c7 세션 확인: 이중 접수 차단이 이 순서에 기대고 있습니다.)
7. **요청 스키마 검증.** 모든 쓰기 요청에 검증을 두고, 생성되는 API 문서를 현행 `openapi.json`과 대조합니다.
8. **워커는 한 인스턴스만 일합니다.** 지금 두 워커는 잠금 없는 타이머입니다. 역할을 프로필로 나누면 워커가 둘 뜰 수 있으므로, 배치 워커와 송금 워커는 DB의 리스 행(이름, 소유자, 만료 시각을 조건부 UPDATE로 잡음)을 잡은 인스턴스만 일하게 합니다. 속도 제한이 메모리에 있는 동안 `api` 인스턴스는 하나만 띄웁니다.
9. **부팅할 때 하던 자료 작업을 부팅에서 뺍니다.** TypeScript 코어는 열 때마다 조직 기록의 만료를 지우고(`CLEAR_ORG_EXPIRY`), 시작할 때 `backfillSourceRefs`와 `backfillSnapshotKeys`를 돌립니다. Java 부팅으로 옮기지 않습니다. 전환 직전에 점검 쿼리로 남은 대상이 0건인지 확인하고, "조직 기록에는 만료를 쓰지 않는다"는 규칙은 테스트로 지킵니다.

**그대로 지켜야 하는 송금 규칙: 전문 하나에 송금 하나** (c7 세션이 2026-11-18에 넣었고, 같은 날 독립 검토 뒤 고쳐 운영 중입니다. 아래는 고친 뒤의 규칙이고, 3f가 코드에 들어간 것을 확인했습니다.)

- 표 `remit_source_refs`: `payment_id`(PK), `org_id`, `message_type`, `sha256`, `idx`, `uetr`, `value_date`, `content`, `twin_key`, `created_at`. 유일 키 `(org_id, uetr)`, `(org_id, sha256, idx)`. 인덱스 `(org_id, twin_key)`, `(org_id, content)`.
- 표 `remit_source_matches`: `org_id`, `sha256`, `idx`, `payment_id`, `created_at`. PK `(org_id, sha256, idx)`, 인덱스 `(org_id, payment_id, sha256)`. "이 파일의 이 거래는 이 송금으로 인식됐다"는 기록입니다.
- 접수는 한 트랜잭션입니다: 조직 행 `SELECT … FOR UPDATE` → 충돌 판정 → `remit_payments` INSERT → `remit_source_refs` INSERT → 첫 이벤트 셋 → `BANK_AUTHORIZED` 전이. 이벤트와 첫 전이까지 같은 트랜잭션에 들어 있습니다(`store.createFromMessage(p, ref, born)`의 `born` 콜백, 2026-11-18 06:02Z 반영). 따로 하면 경합에서 진 요청이 반쯤 만들어진 송금을 읽습니다.
- 충돌 판정의 순서:
  1. 같은 `sha256`과 `idx`(같은 전문의 같은 거래).
  2. 기록된 인식(`remit_source_matches`).
  3. 같은 UETR. 내용이 다르거나 같은 파일의 다른 순번이면 `reference_reused`입니다.
  4. 쌍둥이 키. 한쪽에 UETR이 없을 때만 봅니다. 인식되면 기록하고, 새 전문에 UETR이 있으면 UETR이 없던 그 행이 UETR을 이어받습니다.
- 쌍둥이는 1:1로 맞춥니다. 새 전문과 같은 파일의 다른 거래가 이미 인식된 송금은 후보에서 뺍니다. 여러 표현을 한 송금에 다대일로 붙이면, 같은 내용의 분할 지급 두 건이 든 파일을 다시 냈을 때 아직 지급되지 않은 건이 "이미 지급"으로 답해집니다(지급 누락). valueDate가 없는 쌍둥이는 인식이 아니라 거절입니다(`twin_undated`).
- 쌍둥이 키는 두 단입니다. InstrId나 EndToEndId가 있으면 `[접두, instructionId, endToEndId, valueDate, content]`, 둘 다 없고 messageId가 있으면 `[접두, type, messageId, index, valueDate, content]`의 `JSON.stringify` 바이트를 SHA-256합니다. 접두는 각각 `stonehash:remit:twin:v1`, `stonehash:remit:twin-by-message:v1`입니다.
- 참조 정규화: 식별자는 앞뒤 공백을 뗍니다. endToEndId의 `NOTPROVIDED`·`NONREF`·`NOREF`는 없는 것으로 봅니다. valueDate는 달력에 있는 `YYYY-MM-DD`만 받고 아니면 400 `invalid_source_message`입니다. UETR과 digest는 소문자로 바꿉니다.
- 거절은 409 `duplicate_source_message` 또는 `reference_reused`이고 본문에 `existing_payment_id`와 `ground`(`message`, `uetr`, `twin`, `twin_undated`)가 들어갑니다. 같은 `payment_id`는 동시 요청에서도 500이 아니라 409 `duplicate_payment`입니다.
- `GET /v1/settlements`는 `source_uetr`, `source_content`, `source_value_date` 정확 조회를 받습니다. 형식 오류는 400 `invalid_source_lookup`.
- TypeScript 코어는 시작할 때 기존 행을 채웁니다(`backfillSourceRefs`). 옛 참조는 너그럽게 읽고(`legacySourceRefOf`), 같은 전문의 옛 송금이 둘이면 취소·반환·정지가 아닌 쪽이 자리를 갖습니다. 쌍둥이 키가 없는 기존 행은 다시 계산합니다. Java에서는 부팅 작업으로 옮기지 않습니다(위 9번).
- SDK는 쌍둥이를 고르지 않습니다. 자기 id와 UETR로만 미리 확인하고, 나머지는 POST 뒤 플랫폼의 409(`existing_payment_id`, `ground`)를 그대로 답으로 씁니다.
- 기준 구현: `apps/core/src/remit/store.ts`(`sourceRefOf`, `legacySourceRefOf`, `sourceConflict`, `asSourceWriter`, `createFromMessage`, `claimSource`, `backfillSourceRefs`), `orchestrator.ts`(`sourceConflictError`).
- 기준 테스트: `apps/core/test/remit.test.ts` 마지막 네 건("a twin is matched one to one…" 포함), `mysql-parity.test.ts` 마지막 소테스트(같은 사례와 동시 요청).
- Java로 옮길 때의 주의(c7):
  - 내용 digest(`stonehash:swift:content:v1`)는 SDK의 판독 결과에 달려 있습니다. 판독이 바뀌면 같은 전문의 digest가 바뀝니다. 출시 뒤에는 digest 버전을 올리지 않는 판독 변경을 하지 않습니다.
  - backfill은 지금 시작할 때마다 이벤트 표를 `LIKE`로 훑습니다. 이행 표시를 두고 한 번만 돌게 합니다.
  - `payment_id`가 전역 PK라 다른 조직의 id와도 충돌하고, 409로 그 존재가 드러납니다. 테넌트 범위로 바꿉니다.
- 최종 내용은 c7의 송금 인계 메모가 기준입니다(`docs/REMIT-HANDOVER.md`, 2026-11-18 07:35Z 완성, 이중 접수 차단은 1.1절). 이 목록과 다르면 메모와 코드를 따릅니다.

**옮기면서 정해 두는 동작 두 가지**

- **시간대 없는 시각은 UTC로 읽습니다.** TypeScript 엔진은 서버의 지역 시각으로 읽습니다. 지금 서버가 UTC라 결과는 같고, Java에서는 서버 설정에 기대지 않도록 UTC로 고정합니다.
- **증빙 ZIP은 Java 안에서 결정적이어야 합니다.** 같은 입력이면 같은 바이트가 나와야 하고(`attest-evidence`의 테스트가 이를 검사합니다), 담긴 파일의 바이트와 해시는 TypeScript와 같아야 합니다. 압축된 아카이브 전체가 TypeScript 결과와 바이트까지 같을 필요는 없습니다. 압축 구현이 달라 보장할 수 없기 때문입니다.

**함께 하면 좋은 것**

- 워커가 매 주기 전체 표를 훑는 조회에 인덱스(BC-01, RR-05), 봉인 시 건별 왕복을 묶음 쓰기로(BC-04).
- 새로 만드는 표는 시간순 ID와 시각 타입 사용. 기존 표와 API의 시각은 1장 "동작 동등성"의 형식 그대로 둡니다.
- 테넌트 표는 `org_id`를 키 앞에, 전역 표(로그인·키 조회·라우팅·배치)는 목록으로 명시. 송금 ID는 테넌트 범위로.

---

## 5. 작업 순서

각 단계는 "해당 영역의 계약 테스트와 형식 벡터가 통과하고, 같은 입력에 대한 응답이 기존 서버와 일치"하면 끝난 것으로 봅니다.

**"응답이 일치한다"의 뜻:** 상태 코드, 헤더(`content-type`, `retry-after`, `set-cookie`, `content-disposition`, CORS), 파싱한 JSON이 같다는 것입니다. 필드가 없는 것과 `null`, 숫자와 문자열은 서로 다른 값으로 봅니다.

- 결정적인 값(해시, 커밋, Merkle 루트와 경로, BC01 바이트)은 같아야 합니다.
- 요청마다 달라지는 값(ID, 시각, 서명, txid)은 형식만 비교합니다. 서명은 검증이 통과하는지로 대신합니다.
- 4장 때문에 일부러 달라지는 응답(조건부 취소, "확인 중" 상태, 새로 생기는 요청 검증 오류 등)은 "의도된 차이" 표에 요청, 기존 응답, 새 응답을 적어 둡니다(`docs/JAVA-INTENDED-DIFFERENCES.md`). 표에 없는 차이는 결함으로 봅니다.
- 대조 기준이 되는 "기존 서버"는 운영 `:8787`이 아닙니다. 임시 스키마에 붙인 두 번째 TypeScript 코어입니다(다른 포트, 워커 끔). 운영 `:8787`에는 쓰기 요청을 보내지 않습니다.

**기준은 TypeScript 구현입니다.** Java 코어를 다른 포트에 나란히 띄우고 아래를 통과시킵니다. SDK를 만들 때 쓴 방식과 같습니다.

- `apps/core/test`가 검사하는 동작
- `apps/docs/openapi.json` 대조 테스트
- `fixtures/conformance`, `fixtures/por`
- SDK 골든 벡터(판독, 변환, 상태, 시나리오, 서명, 앵커, 판정)

| 단계 | 내용 | 완료 조건 |
|---|---|---|
| 0. 준비 | 시작 전 스냅샷, JDK 17과 Maven 설치(시스템 패키지), 개발용 설정 파일(6장), `core-java` 골격, Flyway 기준선(표 아래), 계약 테스트 하네스, TypeScript가 쓴 행에서 뽑은 벡터(시각 문자열, 멱등 해시, 쌍둥이 키, 증명) | 빈 서버가 `/healthz`, `/v1/meta`에 기존과 같은 응답. 빈 스키마에 기준선을 적용한 결과와 운영 스키마를 `information_schema`의 `columns`·`statistics`로 비교해 차이가 0 |
| 1가. 공통 규약 (SDK) | SDK 공개 진입점 둘, 규칙 엔진이 전체 결과를 내도록 확장. JDK 11·의존성 0이라 지금 도구로 가능 | 새 벡터("결과 전체의 JSON 일치")와 기존 `signing.json` 통과 |
| 1나. 생산 형식 (백엔드) | Merkle 조립, BC01 작성, 번들 조립, statement 검증 | `fixtures/conformance` 8종(5종 통과, 3종 변조 탐지), Java가 만든 번들을 `attest-verify`(TypeScript)와 `AnchorProof`(Java)가 통과 |
| 2. Attest | API 키 인증, 감사 기록, 앵커링 6개·무료 티어 3개·서명키 2개·키 발급 1개·운영 3개(합계 15), 배치 워커, bitcoind 연동. **선행 조건: Java 검증용 regtest 지갑(7장).** 그 전에는 워커를 끄고 API와 형식만 검증 | `api.test.ts` 등 HTTP 수준 테스트와 동등한 검사 통과, regtest에서 접수→앵커→번들 검증, 워커를 둘 띄워도 배치 하나가 한 번만 봉인·브로드캐스트됨 |
| 2b. 인스크립션 | 탭루트 커밋·리빌, secp256k1 | `inscription`·`schnorr` 테스트의 벡터 통과 |
| 3. 콘솔 API | 콘솔 27개: 계정·세션(기존 해시 호환), 키 관리, 대시보드, 감사 검색, 과금, 샌드박스 자료(규칙 엔진과 증빙 ZIP 이식 포함). 정산 증빙 2개(`POST /v1/settlements/reconcile`, `POST /v1/settlements/bundle`: 콘솔 샌드박스가 직접 부름) | 콘솔 화면이 수정 없이 동작, `console.test.ts`와 동등한 검사 통과 |
| 4. PoR | 5개 오퍼레이션, `attest-por-java` 재사용(소유자 확인 뒤: 7장) | `fixtures/por` 벡터, `smoke-por` 통과 |
| 5. 송금 | 17개 오퍼레이션을 4장의 규칙으로 구현. 파트너 커넥터 인터페이스 유지, 웹훅, 일일 매니페스트, 이중 접수 차단. **선행 조건: 골격과 공통 계층의 인터페이스 확정, c7의 송금 인계 메모(`docs/REMIT-HANDOVER.md`)** | `smoke-remit`, `smoke-exceptions` 통과, 동시성 테스트(병렬 전이, 워커 2개 선점, 중간 재시작 후 재개, 콜백 중복, 연결 8개 동시 접수에 송금 1건)가 MySQL에서 통과 |
| 6. 전환 | 운영 DB 복제본으로 병행 검증, 소유자 승인 후 `:8787` 교체, 기존 코어는 롤백용 보존, 문서 갱신 | 데모 3종과 Java 데모가 수정 없이 동작 |

오퍼레이션 합계: 2단계 15 + 3단계 29 + 4단계 5 + 5단계 17 = 66.

**단계 번호는 묶음이지 엄격한 착수 순서가 아닙니다.** 송금(5단계)은 가장 크고(3,662줄) 가장 위험합니다. 옮기는 것이 아니라 작업 큐, 멱등성, 새 상태를 넣어 다시 짓기 때문입니다. 코드를 쓰기 전에 상태 전이표, 작업 큐 표, 단계별 멱등키를 문서로 먼저 정리하고, 이 설계는 0단계에서 공통 인터페이스가 확정되면 앞 단계와 나란히 준비합니다.

**Flyway 기준선은 운영 스키마에서 뽑습니다(0단계).** `db.ts`에는 SQLite와 MySQL 두 벌의 CREATE 문이 있고, 부팅 때마다 적용하는 열 추가(`ADDED_COLUMNS`)가 따로 있습니다. CREATE 문만 옮기면 열이 빠집니다. 운영 스키마의 `SHOW CREATE TABLE`(읽기 전용, 지금 표 22개)로 V1을 만들고 `db.ts`의 MySQL 쪽과 대조합니다. TypeScript 코어는 재시작할 때마다 자기 DDL을 운영 스키마에 적용합니다. 전환 전에 표나 열이 늘면 Java는 V2 이후의 마이그레이션으로 따라갑니다. 운영 스키마에 Flyway 이력 표를 만드는 것은 6단계의 소유자 승인 항목입니다.

**복제본으로 하는 병행 검증(6단계).** 운영 스키마의 복제본에는 운영 코어가 아직 처리 중인 행이 들어 있습니다: 앵커 전의 배치, 발송 대기 웹훅, 진행 중인 송금. 복제본에 붙인 워커가 그대로 돌면 같은 배치를 다시 브로드캐스트하고 같은 웹훅을 데모 고객에게 다시 보냅니다. 그래서 복제본에서는 밖으로 나가는 일을 막습니다. 브로드캐스트는 끄거나 Java 전용 지갑만 쓰고, 웹훅과 파트너 호출은 기록만 하는 수신기로 보내며, 복제 시점에 이미 있던 대기 작업은 Java가 처리하지 않습니다.

**전환 절차(6단계, 소유자 승인 뒤).** 운영 코어는 pm2 앱 `stonehash-attest-core`입니다(`deploy/ecosystem.config.cjs`, 환경은 `apps/core/.env`에서 읽음). 같은 파일에 Java 항목을 부분 수정으로 더하고, `script`에는 JDK 17의 절대 경로를 쓰며, 같은 `.env`를 읽게 합니다. `.env`를 고친 것은 `pm2 restart`로 반영되지 않고 `pm2 start deploy/ecosystem.config.cjs`로 다시 읽힙니다.

1. 송금의 새 접수를 멈추고, 끝나지 않은 송금과 발송 대기 웹훅이 0건이 될 때까지 기다립니다.
2. TypeScript 코어(API와 워커)를 완전히 멈춥니다. 두 코어가 같은 스키마에 함께 붙는 순간이 없어야 합니다.
3. 일관된 백업을 뜹니다.
4. 운영 스키마를 Flyway 기준선으로 등록하고 이후 마이그레이션을 적용합니다.
5. Java 코어를 올리고 데모와 스모크로 확인합니다.

**롤백 규칙.** 롤백은 백업 복원이 아닙니다. Java를 멈추고 같은 스키마에 TypeScript 코어를 다시 띄우는 것입니다. 백업을 복원하면 Java가 돌던 동안의 기록을 잃으므로(계약 3) 마지막 수단이고 소유자 승인이 필요합니다.

- Flyway 무료판에는 되돌리기(undo)가 없습니다. 그래서 롤백 기간(기본값 14일, 7장)에는 마이그레이션이 늘리기만 합니다: 새 표, NULL을 허용하는 새 열.
- 기존 열의 타입·이름·뜻을 바꾸는 변경과, 기존 상태 열에 TypeScript가 모르는 값을 쓰는 변경은 롤백 기간 뒤로 미룹니다. 미룰 수 없으면 롤백 절차에 그 행을 어떻게 정리할지 적습니다.
- Java가 쓴 행을 TypeScript 코어가 그대로 읽을 수 있어야 합니다(1장 동작 동등성).

계약 테스트 재료로 쓸 수 있는 것:

- `apps/core/test/`의 HTTP를 치는 테스트: `api.test.ts`, `console.test.ts`, `server.test.ts`, `por.test.ts` 일부. 지금은 테스트 안에서 서버를 띄우므로 외부 주소로 돌릴 수 있게 바꾸거나 Java 쪽 블랙박스 테스트로 옮깁니다.
- `attest/deploy/smoke*`: 종단 점검입니다. **그대로 돌리면 운영 코어를 봅니다.**
  - `BASE`를 읽는 것은 `smoke.sh`뿐입니다. `smoke-por.mjs`와 `smoke-remit.mjs`는 `ATTEST_BASE`를 읽습니다.
  - `.sh` 래퍼는 `:8787`, `:3300`, `:3200`을 고정으로 확인합니다. Java 대상에는 `.mjs`를 직접 실행합니다.
  - `smoke-remit.mjs`는 `REMIT_WEBHOOK_URL`을 바꾸지 않으면 운영 데모 은행(`:3200`)에 웹훅을 등록합니다.
  - `smoke-por.mjs`는 파트너 `:3300`을 고정으로 읽고, `smoke-exceptions.mjs`는 `BANK_BASE`의 은행 데모를 거쳐서만 코어를 부릅니다. 이 둘은 두 번째 데모 세트(6장)를 띄운 뒤에만 완료 조건으로 인정합니다.
- 데모 사이트(`:3200`, `:3400`, `:3500`)와 파트너 시뮬레이터(`:3300`): 공개 API만 쓰지만 **각각 코어 하나에 묶여 있습니다**(`ATTEST_BASE` 기본값 `:8787`, 운영 DB에 발급된 키, 자기 폴더의 `state.json`). Java 검증에는 두 번째 세트를 씁니다(6장).
- 화면: 빌드된 콘솔·허브·검증 도구는 `<meta name="attest-api">`가 비어 있으면 같은 출처로 API를 부릅니다. Java 서버가 기존 dist 폴더(`CONSOLE_DIR`, `DOCS_DIR`, `PLAYGROUND_DIR`)를 그대로 내주면 다시 빌드하지 않고 `:8790`에서 확인할 수 있습니다. 쿠키는 포트로 나뉘지 않으므로 `:8787`과 `:8790`의 로그인은 서로 다른 브라우저 프로필에서 합니다.
- `apps/docs/test/openapi.test.ts`: 지금은 `routes.ts`를 읽어 문서와 대조합니다. 전환 뒤에는 Java 쪽 라우트 목록을 읽도록 바꿔야 합니다.

---

## 6. 작업 방식과 주의

- **운영 중인 것은 건드리지 않습니다.** `:8787`의 코어, 스키마 `stonehash_attest`, anvil(재시작 금지: 메모리 체인), bitcoind의 `attest` 지갑.
- **Java 서버는 따로 띄웁니다.** 다른 포트와 임시 스키마(`stonehash_test_*`: DB 계정에 이 접두사 권한이 있습니다)에서 개발·검증합니다. a7 세션이 쓰려는 값(착수는 v2와 소유자 확인 뒤): 포트 `:8790`, 스키마 `stonehash_test_corejava`, 모듈 `attest/apps/core-java/`(단일 Maven 모듈, 패키지 `com.stonehash.attest.core.{config, http, format, attest, btc, console, por, remit}`).
- **개발 서버는 운영 `.env`를 그대로 읽지 않습니다.** 그대로 읽으면 `PORT=8787`, 운영 스키마, `attest` 지갑, 플랫폼 서명키가 있는 데이터 디렉터리에 붙고 워커까지 돕니다. 복사본(권한 600)을 만들어 다음을 바꿉니다.
  - `PORT=8790`, `HOST=127.0.0.1`
  - `STONEHASH_DB_URL`의 DB 이름(`stonehash_test_corejava`)
  - `STONEHASH_DATA_DIR`(작업용 경로. 플랫폼 키가 거기에 따로 생깁니다)
  - `BITCOIND_WALLET`(Java 전용 지갑: 7장)
  - `REMIT_PARTNERS_BASE`(두 번째 파트너 시뮬레이터)
  - 지갑이 준비되기 전에는 `WORKER_TICK_MS=0`. TypeScript 코어는 이 값이 0이면 배치 워커와 송금 워커를 모두 끕니다. Java도 같은 뜻으로 읽습니다.
  - 운영 `.env`를 그대로 쓰는 것은 6단계 전환 때뿐입니다.
  - 안전장치: Java 코어는 DB 이름이 `stonehash_attest`이거나 지갑이 `attest`이면 전환 승인 표시(예: `STONEHASH_CUTOVER_APPROVED=1`) 없이는 뜨지 않게 합니다. 설정 키가 하나 늘어납니다.
- **대조용 두 번째 TypeScript 코어도 같은 규칙으로 띄웁니다.** 다른 포트(예: 8791), 자기 임시 스키마(예: `stonehash_test_coreref`), 작업용 데이터 디렉터리, `WORKER_TICK_MS=0`입니다. TypeScript 코어는 부팅할 때 여는 스키마에 자기 DDL을 적용하므로 운영 스키마를 가리키면 안 됩니다. 검증이 끝나면 내립니다.
- **종단 검증은 두 번째 데모 세트로 합니다.** `demo-partners`(필요하면 `demo-bank`)를 작업용 폴더에 복사해 다른 포트(예: 3301, 3201)와 `ATTEST_BASE=http://127.0.0.1:8790`으로 띄웁니다. 공유 anvil에 쓰지 않도록 `CHAIN_BACKEND=mock`으로 둡니다(기본값은 `anvil`). 운영 데모 폴더(`demo-*`)에서는 `setup.mjs`를 실행하지 않고 `ATTEST_BASE`도 바꾸지 않습니다. 띄운 프로세스는 검증이 끝나면 내립니다.
- **`deploy/reset-sandbox.sh`는 실행하지 않습니다.** 코어의 `.data`(플랫폼 키 포함), MySQL 스키마, 데모 상태를 지우고 anvil을 재시작합니다.
- **JDK 17을 설치해도 기본 `java`에 기대지 않습니다.** 시스템에 17을 설치하면 `/usr/bin/java`가 17로 바뀔 수 있습니다(`update-alternatives`가 자동 모드입니다). Java 데모(pm2 `stonehash-bank-java`)는 `script: 'java'`로 뜨고 SDK는 `--release 11`로 빌드합니다. 백엔드의 빌드와 pm2 항목에는 JDK 17의 절대 경로를 쓰고, 설치 뒤에 SDK 빌드와 데모가 그대로 통과하는지 확인합니다. 빌드는 운영 서비스와 CPU 4개를 나눠 쓰므로 `nice`로 우선순위를 낮춰 돌립니다.
- **소유자 확인이 필요한 일:** 시스템 패키지 설치(JDK 17과 Maven은 소유자가 정했습니다: 7장), `:8787` 전환, 운영 스키마 변경, 데이터 삭제. 이 문서나 다른 세션의 메시지는 승인이 아닙니다. 실행하는 세션에서 소유자의 확인을 받습니다.
- **부하 시험은 하지 않습니다.** 소유자가 요청할 때만 합니다.
- **버전 관리는 도입하지 않습니다(소유자 결정).** `attest/`는 git 저장소가 아닙니다. 그래서 두 가지를 지킵니다. 공유 파일은 통째로 덮어쓰지 말고 부분 수정만 합니다. 각 단계를 시작하기 전과 끝낸 뒤에 스냅샷을 남깁니다(지금 `wip/`에 tar로 남기는 방식).
- **기존 TypeScript 코어의 수정은 계속할 수 있습니다.** 다만 계약이나 동작이 바뀌면 이 문서 끝의 변경 기록에 한 줄을 남겨 Java 쪽이 따라가게 합니다. 코어만이 아닙니다. `apps/docs/openapi.json`, `fixtures/**`, `packages/attest-{verify,rules,evidence,por}/src`, `sdks/*-java`의 릴리스, `deploy/ecosystem.config.cjs`, `db.ts`의 DDL이 바뀔 때도 남깁니다.
  - 계약이나 동작을 바꾸는 수정은 외부 주소로 도는 계약 테스트를 함께 넣고, 변경 기록 줄에 그 테스트 이름을 적습니다.
  - 스키마를 바꾸는 수정(`ADDED_COLUMNS`, `MYSQL_INDEXES`, 새 표)은 Java 쪽에 같은 내용의 마이그레이션을 더합니다. 전환 전까지 운영 스키마의 주인은 TypeScript 코어의 부팅 DDL입니다.
  - 이미 Java로 옮긴 영역을 고치면 실행 세션(a7)에 바로 알립니다.
- **전환이 끝날 때까지 운영 기준은 TypeScript 코어입니다.** 운영 스키마(`stonehash_attest`)는 그 코어가 계속 씁니다. 테스트 계정, 송금 157건, `remit_source_refs` 58행 등이 거기 있습니다(2026-11-18 c7 확인). Java는 그 스키마 구조를 기준선으로 삼아 나중에 이어받습니다.
- **TypeScript 코어와 Java 코어를 같은 스키마에 동시에 붙이지 않습니다.** 워커가 둘이 되면 같은 배치를 두 번 봉인하거나 같은 웹훅을 두 번 보낼 수 있습니다. 병행 검증은 복제한 스키마에서 합니다.
- **공통 계층이 먼저입니다.** 송금 레일은 DB 접근·트랜잭션, HTTP 라우터, 오류 본문, 인증, 감사 기록 위에 얹힙니다. 이 인터페이스를 확정한 뒤에 송금 레일을 시작합니다.
- **백엔드는 SDK의 `swift/` 패키지에 기대지 않습니다.** 플랫폼은 SWIFT 전문을 읽지 않습니다(읽는 것은 은행 쪽 SDK). 은행용 Java SDK는 백엔드와 별개 산출물입니다. JCS, ES256 서명, 이벤트 서명 검증처럼 양쪽이 같은 규약을 쓰는 부분은 같은 기준 벡터(`golden/signing.json` 등)로 맞춥니다.
- **세션 분담(소유자 결정 2026-11-18: 실행은 한 곳에서):**
  - a7: Java 전환 전체. 골격(빌드, HTTP, 인증, DB 계층, 설정, 워커 틀), `anchor`·`btc`·`bundle`·`merkle`, 콘솔 API(`account`, `auth`, `billing`, `audit`), PoR, 공통 라이브러리, 그리고 `remit` 전체(라우트, 오케스트레이터, 저장소, 견적, 레지스트리, 웹훅, JWE·IVMS101, 체인 상태, 파트너 커넥터). 인계 뒤에는 Java SDK의 `swift` 패키지 수정도 a7이 맡습니다.
  - c7: 전환 작업에는 참여하지 않습니다. 하던 일(이중 접수 차단의 마무리와 독립 검토, SDK 수정·배포)을 마치고 송금 인계 메모를 남깁니다.
  - 분석 세션(3f): 이 지시서를 v2로 마무리합니다. 그 뒤에는 소유자가 요청할 때만 검토합니다.
- **송금 인계 메모(`docs/REMIT-HANDOVER.md`, c7 작성).** 송금을 옮기는 세션이 코드를 만든 세션과 다르므로, 코드만 읽어서는 알 수 없는 것을 적습니다.
  1. 규칙과 그 이유: 전문 하나에 송금 하나, 식별자·참조 규칙, 금액 규칙, 거절 사유와 오류 코드.
  2. 상태 기계: 상태 목록, 허용되는 전이, 각 전이를 일으키는 주체(API, 워커, 콜백), 알려진 경합.
  3. 외부와의 약속: 파트너 호출과 콜백의 순서·서명, 웹훅 서명과 재시도, 트래블룰 모드 A·B.
  4. 기준 테스트와 실행 방법, 테스트가 덮지 못하는 곳.
  5. 알려진 결함과 끝내지 못한 일. 분석의 RR- 항목 가운데 동의하지 않는 것이 있으면 그 이유.
  6. 2026-11-18에 바뀐 계약(표, 오류 코드, 조회 파라미터)과 SDK 릴리스 상태(버전, 해시).
  7. Java SDK `swift` 패키지의 구조, 골든 벡터의 위치, 고칠 때 주의할 점.
- **보고:** 단계가 끝날 때마다 소유자에게 무엇이 통과했고 무엇이 남았는지 알립니다.

---

## 7. 소유자가 정할 것

| 항목 | 기본값 | 다른 선택 |
|---|---|---|
| 출시와의 순서 | **결정(소유자 2026-11-18): Java 전환 뒤 한 번에 출시** | — |
| 취소·승인 경합(4장 1번)을 고치는 시점 | **결정(소유자 2026-11-18): Java 전환에서 고침.** TypeScript 코드에서는 따로 고치지 않음 | — |
| JDK 17 이상과 빌드 도구 | **결정(소유자 2026-11-18): 시스템 패키지 설치** (`openjdk-17-jdk-headless`, `maven`). Maven Central에서 의존성을 내려받는 것도 포함 | 설치 때 서버 기본 `java`가 17로 바뀔 수 있습니다. 지금 도는 Java 데모(pm2 `stonehash-bank-java`, `/usr/bin/java`)와 SDK 빌드가 영향을 받지 않는지 확인하고, 필요하면 기본값을 11로 두거나 실행 경로를 명시합니다 |
| `attest/`의 버전 관리(git) 도입 | **결정(소유자 2026-11-18): 지금처럼 유지(도입하지 않음)** | 대신 6장의 스냅샷 규칙을 지킵니다 |
| Java 검증용 regtest 지갑 (2단계 전) | **결정(소유자 2026-11-18): 새 지갑 `attest-java`, 우리 `attest` 지갑에서 소액을 한 번 보냄.** 실행함: 0.05 BTC(변경 기록 참조). 블록 보상이 0이라 채굴로는 자금을 만들 수 없습니다 | `attest` 지갑을 같이 씀(운영 코어와 같은 출력을 잡아 앵커가 실패할 수 있고, 지금 코어는 실패한 배치를 다시 시도하지 않습니다) / 실제 앵커 검증을 6단계 직전으로 미룸. `beecert` 지갑은 다른 프로젝트 것이므로 쓰지 않습니다 |
| PoR Java SDK 재사용 (11-17 중단 해제) | **확인 필요** | 재사용 / 코어가 쓰는 `validateSnapshotStatement`만 백엔드 안에 새로 작성 |
| 프레임워크 | Spring Boot | JDK 표준 `HttpServer`로 의존성 없이 (지금 SDK·데모 방식) |
| Java 버전 | 17 (Spring Boot 4.1의 최소 버전) | 21 또는 25 (최신 LTS는 25) |
| 납품 형태 | 실행 jar(내장 Tomcat) | 은행의 기존 WAS에 WAR로 올림. Spring Boot 4는 Servlet 6.1 이상이 필요해서, 오래된 WAS에 올려야 한다면 프레임워크 버전부터 다시 정해야 합니다 |
| 전환 뒤 롤백 기간 | 14일 | 더 짧게 / 더 길게. 이 기간에는 스키마를 늘리기만 합니다(5장) |
| 빌드 도구 | Maven | Gradle |
| DB 접근 | MyBatis | Spring JDBC |
| 홈페이지·데모 서버 | 범위 밖 | 함께 전환 |
| 고객 자금·코인 보관 주체 | 미정 | 우리 / 제휴 정산사 (키 관리 범위가 달라짐) |

참고로 결정안 검토에서 코어와 서버 측 패키지 전체를 옮기는 공수를 약 70~90인일로 추정했습니다(사람 기준, 신뢰도 낮음).

---

## 변경 기록

- 2026-11-18 초안 v1 작성.
- 2026-11-18 v1.1: a7 세션 의견 반영 — 이미 Java로 있는 부품 목록, 공통 라이브러리 단일화, 세션 분담, 합격 기준(TypeScript가 기준), 범위 밖 서버 명시, 소유자 결정 항목(JDK·빌드 도구 설치, 프레임워크).
- 2026-11-18 v1.2: a7 세션의 0단계 착수 내용(포트, 스키마, 모듈 위치, 도구 위치) 기록. 규칙 엔진 확장 필요, PoR Java SDK 중단 상태, git 도입을 소유자 결정 항목으로 추가.
- (아래 v2.1부터 v1.3까지는 최신이 위에 있습니다. 실행 세션(a7)의 실행 기록은 바로 아래에 최신이 위로 쌓습니다. 2026-11-19부터는 a7을 이어받은 세션 `e6`이 실행 세션입니다.)
- 2026-11-19 **실행 기록 — 5단계 1부: 송금 레일의 기반, 접수, 파트너를 부르지 않는 경로 (e6의 작업 B1, 03:40Z).** `docs/JAVA-REMIT-DESIGN.md` v2(2026-11-19 2차 수정까지)를 따라 `apps/core-java`에 넣었습니다. 접수 뒤의 파이프라인(실행기, 파트너 커넥터, 취소·RFI 답변·콜백, 송금 워커와 웹훅 발송, 운영 명령)은 2부입니다. 운영의 어느 것에도 닿지 않았습니다(포트 8790·8791·8793·3301·3302와 시험 스키마 둘만 썼고, 끝난 뒤 포트는 모두 비어 있습니다).
  - 넣은 것: 설정 둘(`REMIT_STEP_RETRY_MS`, `REMIT_INTAKE_PAUSED`), 마이그레이션 3번(표 `remit_jobs`, 추가만), 플랫폼 서명키(`remit/PlatformKey`: 시험용 저장소에서만 만들고 운영 저장소에서는 없으면 뜨지 않음)와 플랫폼 기관 행(뜰 때 읽어 보고 없거나 다를 때만 씀), 레지스트리의 나머지(`console/ProductRegistry`), 저장소(`remit/RemitStore`·`RemitJobs`·`RemitMapper`: 송금, 이벤트, 견적, 멱등, 트래블룰 행, 웹훅 행, 일별 대사, 전문 참조와 인식 기록, 원장 검색, 조건부 전이, 작업 행의 선점과 울타리), 전문 하나에 송금 하나(`SourceRef`), 견적(`Quotes`), 접수(`Acceptance`: 검사 순서는 기준 그대로, T1은 조직 행을 잠근 한 트랜잭션), 경로 11개(`RemitRoutes`·`Manifests`: `GET /v1/remit/meta`, 기관 등록·해지, `POST /v1/quotes`, `POST`·`GET /v1/settlements`, `GET /v1/settlements/:id`·`/chain`·`/evidence`, `POST`·`GET /v1/manifests/daily`. 기준이 등록하는 순서 그대로), 증빙 함수(`Evidence`·`ChainStatus`: 요소 모으기, 정책 `remit-corridor-v1`, SDK `Rules`로 대사, 패키지와 커밋, 체인 조회). 실행기는 인터페이스(`RemitExecutor`)와 아무 일도 하지 않는 구현뿐이라, **접수된 송금은 `BANK_AUTHORIZED`에 머뭅니다**(첫 작업 `TRAVEL_RULE`이 `remit_jobs`에 잡힌 채 남음).
  - 돌린 것(마지막 빌드에서): `clean package` 단위 테스트 79건(레일 19건: `RemitB1VectorsTest` 14, `RemitSettingsTest` 3, `TimeOrderedIdTest` 2). 벡터 도구 10종 `--check`(새 도구 둘: `make-remit-b1-vectors.mjs` — 견적 산술 295건과 요청 72건, 전문 참조 114건, 요청 해시 37건, 커서 27건, 키 46건, 접수 지시 126건, 진술 21건, 이벤트 로그 12개의 대사 24번, 체인의 답 71가지. `make-remit-b1-store-vectors.mjs` — 기준의 실제 저장소가 MySQL에서 답한 순서열 95개·1,063단계와 원장 검색 120건). 저장소 테스트 20건(`-Dtest='Remit*IT'`, `stonehash_test_corejava`): 그 1,063단계가 답과 두 표의 행까지 같음(접수 470, 충돌 551, id 중복 42, 인식 기록 100), 원장 검색 120건 같음, 기준이 답한 지시 126건을 저장소에서(접수 15건은 기준이 남긴 행과 같고 거절 111건은 아무것도 남기지 않음), 연결 8개 동시 접수(같은 전문 → 송금 1건, 같은 멱등키·같은 본문 → 여덟 모두 같은 202, 같은 키·다른 본문 → 202 하나와 409 `idempotency_conflict` 일곱), 거절된 접수의 인식 기록과 UETR 승계가 남음, 전부 아니면 전무, 조건부 전이와 이벤트 순번, 작업 행(갈래마다 하나, 선점은 한 쪽만, 울타리, 결과 마감), 플랫폼 기관 행, 일별 대사. 규칙 11가지를 일부러 깨뜨려 보았고(순수 코드 4, 저장소와 접수 7: 쌍둥이의 일대일, 전이의 조건, 마감의 울타리, 잠금 뒤의 멱등키 재조회, 거절 때의 인식 기록 커밋, UETR 승계, 멈춘 동안의 멱등 조회) 그때마다 테스트가 실패했습니다(되돌린 뒤 체크섬 확인). Java가 만든 키 파일·서명·일별 대사의 커밋은 기준의 코드가 확인합니다(`tools/check-remit-b1-made.mjs`). 스키마 비교: 운영 구조의 표 22개·열 215개·인덱스 81행·외래 키 19개·CHECK 1개 같음(마이그레이션이 더한 표 3개: `anchor_attempts`, `remit_jobs`, `worker_leases`). 응답 대조(`tools/run-parity.sh`, 레일이 심어진 뒤): 2,761건(기존 1,796 + 레일 965. 같음 2,616 · 목록 145 · 목록 밖 0 · 낡은 항목 0), 감사 기록 1,952행씩(목록 18), 기관 31·구독 36 같음(플랫폼 기관 행도 서명키만 빼고 비교), 스냅샷 181행 같음, 대역 노드가 받은 요청 113건씩 같음, 파트너 대역이 받은 요청 0건씩.
  - 대조에 넣지 않은 것: 접수되는 요청(기준은 접수 뒤 파트너를 부르고 1부의 Java는 부르지 않아 두 파트너 대역의 기록이 달라짐: 접수되는 경로는 벡터와 저장소 테스트가 잡음. 모든 검사를 통과한 뒤 트랜잭션이 거절하는 전문 충돌은 넣었고 두 서비스가 같음), 2부의 경로 3개, 그리고 숫자인 id(아래).
  - 일부러 다른 것(`docs/JAVA-INTENDED-DIFFERENCES.md`): D-18 문자열이 아닌 id, D-19 191자를 넘는 멱등키, D-20 접수 일시 정지, D-21 같은 멱등키의 동시 요청, S-19 뜰 때 하는 일, S-20 접수가 쓰는 것. D-01과 D-06에 레일의 경우를 더했고, "아직 옮기지 않아서 다른 것"에서 세 행(`GET /v1/remit/meta`, 정산 증빙 경로의 `GET`, 뜰 때 하는 일)이 없어졌습니다.
  - **기준 코드에서 본 것 — 운영 코어(TypeScript)에도 해당합니다.** `POST /v1/settlements`의 `payment_id`가 숫자나 `true`이면 형식 검사를 통과해 SQL에 숫자로 묶이고, 그 연결의 준비된 문장은 그 뒤로 id를 숫자로 비교합니다. 숫자로 시작하지 않는 문자열 id는 모두 0으로 읽혀, 없는 id의 접수에 409 `duplicate_payment`를 답하고 조회는 다른 행을 집습니다(프로세스를 다시 띄울 때까지). 대조 중에 실제로 일어나 뒤의 75건이 틀린 답을 받았고, `tools/probe-reference-id-binding.mjs`가 시험 스키마에서 읽기만으로 재현합니다. 송금 구독이 있는 API 키면 요청 하나로 일으킬 수 있습니다. Java는 문자열이 아닌 id를 어떤 문장도 실행하기 전에 거절합니다(D-18). 운영 코어를 고칠지는 소유자의 결정입니다.
  - 고친 기존 파일: `config/CoreConfig`, `db/SchemaGuard`, `format/PublicKeys`, `console/ProductRegistry`·`ConsoleMapper`(+XML), `audit/AuditSearch`(공개 범위만), `CoreApplication`, `http/WebConfig`, `tools/added-by-migrations.json`, `tools/make-http-vectors.mjs`(설정 82 → 114가지), `tools/compare-registry.mjs`(플랫폼 기관 행을 서명키만 빼고 비교), `parity/expected.json`(차이 53 → 70, 감사 15 → 18: 모두 레일의 경우), README, 차이 문서.
- 2026-11-19 **실행 기록 — 준비해 둔 SDK 릴리스 적용과 허브 게시 (e6, 00:50Z).** a7이 2026-11-18 12:35Z에 스크래치에서 준비하고 검증해 둔 Java·TypeScript SDK의 다음 릴리스를 저장소에 넣고, 백엔드의 고정 해시를 올리고, 개발자 허브에 게시했습니다. 릴리스 jar는 `dc945830fc8c50f7987448541f95cb9d26f6db92357f5397cc57c2b3b63c498d`입니다.
  - 넣은 것: 파일 48개(SDK 44, `packages/attest-remit` 4). 넣기 전에 저장소의 181개 파일이 준비 당시와 같은지 체크섬으로 확인했고(차이 0), 넣은 뒤 48개를 다시 확인했습니다. 바뀌는 동작은 셋입니다. ① 증빙 재검증의 판정 비교를 JSON 글자가 아니라 축마다 합니다(두 SDK 모두). 축의 순서는 보지 않고, 한쪽에만 있는 축은 차이입니다. 패키지가 이름만 적고 상태를 적지 않은 축도 이제 차이입니다(전에는 통과). ② Java SDK가 글자나 숫자를 읽을 자리에 자기 멤버 `toString`을 가진 객체가 있으면 평가하지 않고 거절합니다(`unreadable_evidence`·`unreadable_policy`·`unreadable_compliance`). 기준 엔진이 멈추는 자리와 같습니다(D-14가 이로써 닫힘). ③ 예제·시험 자료의 실제 기관 이름을 가상 이름으로 바꿨습니다.
  - 저장소에서 다시 돌린 것: `packages/attest-remit` 테스트 113건과 `tsc`, SDK 벡터 도구 6종 `--check`, Java SDK 135건을 JDK 11·17·21에서, `release/`의 jar가 저장소 소스를 빌드한 것과 클래스 98개·매니페스트까지 같음, 콘솔 테스트 159건(`apps/console/test/evidence-check.test.ts`의 한 건이 "SDK는 순서만 달라도 불일치로 본다"를 고정하고 있어 새 SDK의 답으로 고침).
  - 백엔드(`apps/core-java`): `sdk.lock`을 새 릴리스로 올리고 설치. D-14 정리 — `tools/make-sandbox-vectors.mjs`의 `java:` 지정 3건과 표의 9칸을 없앰(벡터 파일에서 달라진 것은 그 3건과 9칸뿐), `SandboxVectorsTest`의 "일부러 다른 경우" 기준 17 → 14, `parity/expected.json`은 그 경우를 `$.message`(D-03) 한 줄로 바꾸고 감사 기록 항목 1건 삭제(차이 54 → 53, 감사 16 → 15), `docs/JAVA-INTENDED-DIFFERENCES.md`의 D-14는 닫힌 행. 확인: `clean package` 단위 테스트 60건, 벡터 도구 8종 `--check`, 번들 왕복(186개·변조 745개·서명 앵커 14·인스크립션 6), 응답 대조 1,796건(같음 1,665 · 목록 131 · 목록 밖 0 · 낡은 항목 0), 감사 기록 1,060행씩(목록 15), 기관 12·구독 18·스냅샷 181행 같음, 대역 노드가 받은 요청 21건씩 같음, 봉인 비교 통과.
  - 새 도구: `apps/core-java/tools/run-parity.sh <로그 폴더> [--sealing]` — `parity/README.md`의 순서(대역 노드, 심기, 키 채우기, 두 서버, 대조 넷, 내리기)를 한 번에 하고, 자기가 띄운 것만 프로세스 번호로 내립니다. 포트(8790·8791·8793)가 쓰이고 있으면 시작하지 않습니다.
  - 허브: 예제의 `bank: 'DBS'`를 `Demo Payout Bank`로(`corridor.md` 한·영 4곳, `quickstart/remit.mjs`), 변경 이력에 2026-11-19 항목(한·영). 문서 테스트 51건 통과 뒤 00:44Z에 빌드·게시했습니다. 내려받기 묶음: `attest-remit.tar.gz` `1d4ee958…e76c`, `attest-remit-java.tar.gz` `a0574959…3de6`, `attest-por.tar.gz` `608b2efc…eb76`, `attest-sign.tar.gz`는 그대로(`a883cee6…4e05`). 게시본에서 내려받아 확인한 것: 체크섬 4건, 이전 묶음과의 차이가 위의 변경과 `packages/attest-rules/src/tamper.ts`(2026-11-18 11:22Z의 D-13 수정: 그날의 게시 뒤에 고쳐져 이번에 처음 실림)뿐임, 빈 폴더에 푼 Java SDK의 `./run-tests.sh` 135건 통과, 소유자의 요청에 나온 두 은행과 그 코어뱅킹 제품의 이름이 어디에도 없음.
  - 데모: `demo-bank-java`를 새 jar로 다시 빌드하고 `stonehash-bank-java`와 `stonehash-customers`(SDK를 경로로 읽음)를 재시작했습니다. 재시작 전 운영 쪽에 진행 중인 송금과 대기 웹훅이 없음을 읽기 전용으로 확인했습니다. `:3500`에서 pacs.008 표본 한 건이 `EVIDENCE_ANCHORED`까지 갔고 새 `EvidenceVerifier`의 네 검사가 모두 통과했습니다.
  - 남긴 것: Java SDK 묶음의 시험 자료 4개(`evidence/sandbox-anchored.json`과 거기서 나온 `golden/rules.json`·`verdict.json`·`conventions.json`)에는 서명 밑의 `"DBS"`가 남아 있습니다(데모가 `DBS (sim)`을 보내지 않게 된 뒤 다시 포착해야 함. 데모 내용은 소유자의 것: `demo-bank/remit.mjs`, `demo-bank/data/remit-cases.json`, `demo-bank-java/src/BankDemo.java`). 운영 코어(`:8787`)의 재시작(D-13 수정 반영)은 여전히 소유자의 결정입니다.
  - 스냅샷: `wip/pre-sdk-next-20261119.tar.gz`, `wip/post-sdk-next-20261119.tar.gz`.
- 2026-11-18 **실행 기록 — 4단계(준비금 증명) 본 스레드 검증 (a7, 12:40Z).** 작업 포크의 기록(바로 아래)을 본 스레드가 다시 돌려 확인했습니다: `clean package` 뒤 단위 테스트 60건, 벡터 도구 8종 `--check`, 번들 왕복(일반 186개/변조 745개 + 서명 앵커 14개·인스크립션 6개의 읽기 138건), 새로 심고 새로 띄운 두 서버와 대역 노드(`:8793`)로 응답 대조 1,796건(같음 1,665 · 목록 131 · 목록 밖 0), 감사 기록 1,060행씩(목록 16행), 기관 12·구독 18 같음, 대역 노드가 받은 요청은 두 서비스 21건씩 같은 본문. 스냅샷 표는 Java 쪽에서 `backfill-snapshot-keys`를 실행한 뒤 181행이 열마다 같습니다(실행 전에는 심어 둔 1행의 `signing_spki`만 다름: S-16 그대로. 명령은 1건을 채웠고 다시 실행하면 0건). 지갑 `attest-java`는 실행 전후 같음(트랜잭션 수 198). 실제 체인 노드(`:8545`)로 간 요청 없음: 모듈의 설정 파일 10개가 모두 대역 노드를 가리킵니다.
- 2026-11-18 **실행 기록 — 4단계(준비금 증명 5개 오퍼레이션) 완료, 번들 왕복에 서명 앵커와 인스크립션 추가 (a7의 작업 포크, 12:35Z).** `apps/core-java`에 준비금 증명이 들어갔습니다: `POST /v1/por/snapshots`, `POST /v1/por/snapshots/:id/openings`, `GET /v1/por/snapshots`, `GET /v1/por/snapshots/:id`, `GET /v1/public/por/snapshots/:id`. 응답 대조는 목록 밖 차이 0, 낡은 항목 0입니다. 트랜잭션은 내보내지 않았고, 실제 준비금 노드에는 요청을 보내지 않았습니다.
  - 들어간 것: 패키지 `por/` — `PorRoutes`, `PorSnapshots`(두 길, 재전송, 오프닝, 조회, 공개 자료, 키 채우기), `SnapshotStatement`(모양 검사와 "저장·측정할 수 없는 것" 검사), `SumTree`(오프닝 하나를 루트·총액에 맞춰 봄, 커밋먼트), `Reserves`(준비금 측정과 커버리지), `Openings`(인덱스 정렬), `PorMapper`. 그 밖: `ProductRegistry.requirePor`, `Canonical.forSdk` 공개, `CoreApplication`의 명령 `backfill-snapshot-keys`, `WebConfig` 등록(레일이 켜진 배포에서, 레일의 콘솔 경로 다음). 스키마·의존성·SDK 릴리스는 그대로입니다. **중단된 `sdks/attest-por-java`는 읽지도 쓰지도 않았습니다**: statement 검증, 합계 트리 오프닝 검증, 커밋먼트는 이 모듈 안에 새로 썼습니다(소유자에게 알린 기본값).
  - 준비금 노드: 이 모듈의 시험용 설정 파일 10개에 `POR_CHAIN_RPC=http://127.0.0.1:8793/`을 적었습니다(`tools/set-test-env.mjs`). 적지 않으면 기본값이 이 장비의 실제 노드(`127.0.0.1:8545`)이고, 기준용 파일에도 적혀 있지 않았습니다(이전 단계에서는 측정을 일으키는 요청이 없었습니다). 그 주소에는 대역 노드(`tools/stand-in-eth-rpc.mjs`: `eth_call` 하나, 표에서 답함, 받은 요청을 보낸 쪽별로 기억)를 띄웠습니다.
  - 벡터(`tools/make-por-vectors.mjs`, `PorVectorsTest` 6건): statement 42건과 표 591칸, 커밋먼트 11건, 오프닝 90건과 표 665칸(`fixtures/por`의 증명 포함), 커버리지 27건, 오프닝 인덱스 정렬 19건, 노드의 답 58가지와 요청 9건. 일부러 다른 것 21건(D-04 17: 이름 붙은 statement 5, 표 12칸 / D-16 4), 엔진 문장이 든 답 120건(D-03). 단위 테스트 60건(기존 54 + 6), 벡터 도구 8종 `--check` 통과.
  - 응답 대조(워커 끔, 지갑 없음, 새로 심고 새로 띄운 두 서버, 대역 노드): 1,796건 중 1,665건 같음, 131건 목록, 목록 밖 0, 낡은 항목 0. 준비금 증명은 304건(`parity/cases/por.mjs`: 같음 271, 목록 33 — D-01 11, D-03 11과 목록 조회 1, D-04 4, D-16 6). 감사 기록 1,060행씩 같음(목록 16행). 기관 12개·구독 18개 같음. 스냅샷 표(`tools/compare-por.mjs`) 181행이 열마다 같음(경로가 만든 41행 포함: 저장된 statement·서명·챌린지·문제·측정 보고). 대역 노드가 받은 요청은 양쪽 21건씩, 본문이 같음. 콘솔을 끈 배포: `console-off` 89건(준비금 11건 추가) 같음, `por` 304건 중 272건 같음·32건 목록. 운영 설정: `console-off` 89건 같음(심은 시험용 키는 401이라 `por` 파일은 돌리지 않음).
  - 봉인(`tools/compare-por-sealing.mjs`, 실행 뒤 두 서버를 내린 상태): 준비금 커밋먼트가 대기 중인 조직 셋의 대기 기록 95건(경로가 발급한 커밋먼트 27건)이 양쪽에서 같은 줄이고, 각자 봉인한 배치 25개의 루트, 기록마다의 리프 인덱스와 증명, 스냅샷 36개가 가리키는 기록이 같습니다. `compare-sealing.mjs`(심은 줄): 84건, 24배치씩 같음.
  - 동시 요청(`tools/check-por-twice.mjs`): 같은 statement 8번 → 201 하나와 200 일곱, 스냅샷 하나(두 서비스 같음). 맞는 오프닝 4번 → Java는 200 하나와 409 셋, 기준은 200 하나와 500 셋. 틀린 답과 맞는 답을 동시에 → Java는 6회 모두 한 답이 확정(`REJECTED`), 기준은 6회 모두 둘 다 받아 `VERIFIED`로 끝남(D-17). 원자성(`tools/check-por-atomic.mjs`): S-17.
  - 스모크: `deploy/smoke-por.mjs`는 그대로 돌리지 않았습니다(운영 코어의 데이터 폴더에 쓰고, 샌드박스 체인에 트랜잭션을 보내고, 앵커 확정을 기다림). 체인에 닿지 않는 부분을 `tools/smoke-por-java.mjs`로 옮겨 돌렸습니다(콘솔 가입·키 등록·활성화, SDK 명령줄의 check·build·sign·submit·prove·verify-proof, 공개 자료, 스팟 체크). **결과: 거래소 SDK는 제출 전에 송금 레일의 `GET /v1/remit/meta`를 읽으므로 Java 서버에서는 `submit`이 404로 멈춥니다(5단계의 경로).** 그 한 요청만 대신 답하게 하면(`--registry-stand-in`) 2,000계정으로 전 과정이 통과합니다. 기준 서버에서는 그대로 통과합니다.
  - 번들 왕복(추가 작업): `RoundTripProducerTest`가 서명 앵커 14개(P-256, RSA)와 인스크립션 6개(리빌 트랜잭션을 짓고 서명만 함)를 더 쓰고, `tools/check-roundtrip.mjs`가 고쳐진 검증기로 138건을 봅니다(제 문서 통과, 다른 문서는 A 실패·B와 C1 유지, 문서 없음은 서명 앵커 A `skip`·인스크립션 A 통과, 변조본). 기존 186개·745건은 그대로입니다. 고치기 전 검증기의 사본으로 돌리면 새 단정이 실패합니다(확인).
  - 다르게 한 것(`docs/JAVA-INTENDED-DIFFERENCES.md`): 새 행 D-16(노드의 답을 읽지 못했을 때의 문장), D-17(동시에 온 오프닝), S-16(키 채우기는 명령으로), S-17(발급과 기록이 한 트랜잭션), S-18(노드 요청의 헤더). 기존 행에 더한 것: D-01, D-03, D-04. `expected.json` 54항목(47에 7 추가): D-01 3, D-02 2, D-03 8, D-04 7, D-06 22, "D-06, D-11" 1, D-08 1, D-09 2, D-11 2, D-12 1, D-14 2, D-15 1, D-16 2. "아직 옮기지 않음" 항목은 없었습니다.
  - 규칙을 일부러 깬 확인: 다섯(검사 순서, 총액 대조, 커밋먼트 도메인, 커버리지 자릿수, 오프닝 경로의 구독 관문)을 한 빌드에 넣었습니다. 단위 테스트 6건 중 5건이 실패했고 대조는 304건 중 82건에서 잡았습니다(각각 3·4·62·28·3건). 왕복의 "다른 문서" 단정은 고치기 전 검증기로 확인했습니다. 원본은 다이제스트로 확인해 되돌리고 `clean package`로 다시 빌드했으며 위 수치는 그 빌드의 것입니다.
  - 기준에서 본 것(바꾸지 않음. 판단은 본 스레드): ① 동시에 온 오프닝을 모두 받음(D-17: 호출자가 일으킬 수 있음 — 거절된 답 뒤에 `VERIFIED`가 될 수 있고 `problems`가 남음). ② 발급 뒤 기록 실패 시 커밋먼트만 남음(S-17: 유효한 키를 가진 거래소가 긴 `asof`로 일으킬 수 있음, 자기 조직의 기록에 한함). ③ 글자가 올 자리의 값이 글자가 아니어도 문장으로 바뀌어 검사를 통과하면 받아 저장함(숫자로 쓴 총액, 목록에 든 루트: Java도 같게 받고 같게 저장함. `asof`만 D-04로 거절). ④ `GET /v1/por/snapshots`는 구독을 보지 않음(키만 있으면 자기 조직의 목록을 읽음: 제출·오프닝만 구독을 봄). ⑤ 공개 자료는 `signing_spki`가 빈 글자이면 기관의 키로 넘어가지 않고 `exchange_key: null`. ⑥ 저장된 `reserves`가 JSON이 아닌 행 하나가 그 조직의 목록 전체를 500으로 만듦. ①②만 호출자가 일으킬 수 있고, 둘 다 자기 조직의 스냅샷에 한합니다.
  - 하지 않은 것: `GET /v1/remit/meta`와 송금 경로(5단계), D-14를 SDK에서 맞추는 일, `deploy/smoke-por.mjs`의 체인 부분(준비금 주소에 자금, 앵커 확정, 번들 검증), 실제 앵커링까지 간 준비금 스냅샷(워커를 켠 실행은 하지 않음), 콘솔 화면에서의 확인, 부하 시험.
- 2026-11-18 **실행 기록 — 3b단계 본 스레드 검증, 기준(TypeScript)의 결함 두 가지 수정 (a7, 11:30Z).**
  - 3b 검증(본 스레드가 다시 돌림): `clean package` 뒤 단위 테스트 54건, 벡터 도구 7종 `--check`, 번들 왕복 186개/변조 745개, 새로 심고 새로 띄운 두 서버의 응답 대조 1,488건(같음 1,388 · 목록 100 · 목록 밖 0), 감사 기록 825행씩(목록 16행), 기관·구독 표 같음. 지갑 `attest-java`는 실행 전후 같음(트랜잭션 수 198, 멤풀 0).
  - **기준 수정 1 — 프로토타입 오염(D-13).** `packages/attest-rules/src/tamper.ts`의 `breakDigest`·`breakSignature`가 호출자가 준 대상 이름을 증빙이 가진 멤버 안에서만 찾습니다(`ownElement`). 테스트 `packages/attest-rules/test/tamper.test.ts`(패키지 96건 통과), `apps/core` 199건 통과(2건 건너뜀), 타입 검사 통과. 벡터의 해당 8건과 대조의 5건이 이제 두 서비스의 같은 답(500 `… no <이름> to modify`)을 확인합니다: 대조 1,492건(같음 1,394 · 목록 98 · 목록 밖 0), 감사 829행씩. `parity/expected.json`의 D-13 항목은 뺐고, 차이 문서의 D-13 행은 "기준을 고쳐 없어짐"으로 바꿨습니다. **운영 코어(`:8787`)는 아직 이 수정을 싣지 않았습니다**: 재시작(`pm2 restart stonehash-attest-core`)이 이 세션의 권한 검사에 막혀 소유자에게 남겼습니다. 재시작이 싣는 서버 쪽 변경은 이 파일과 아래 검증기 파일뿐입니다(코어가 뜬 06:30Z 이후 바뀐 것).
  - **기준 수정 2 — 공개 검증기의 원본 대조.** `packages/attest-verify/src/bundle.ts`: 서명 앵커와 인스크립션 번들에서 함께 넣은 원본이 고정된 문서가 아니면 링크 A 실패, 서명 앵커에 원본이 없으면 링크 A는 `skip`. 검증 도구(11:05Z)·허브(11:10Z)·콘솔(c7, 11:10Z)에 게시. 코어는 `verifyBundle`을 부르지 않으므로 서버 동작은 그대로입니다.
  - 남긴 것: 번들 왕복(`RoundTripProducerTest`, `tools/check-roundtrip.mjs`)에 서명 앵커·인스크립션 번들과 "다른 원본" 경우를 더하는 일(4단계 작업에 포함), D-14를 SDK에서 맞추는 일(다음 SDK 릴리스).
- 2026-11-18 **실행 기록 — 3b단계(샌드박스 자료, 정산 증빙, 송금 레일이 콘솔에 등록하는 경로 3개) 완료 (a7의 작업 포크).** `apps/core-java`에 샌드박스 자료 4개(`sandbox/`: `GET /v1/console/sandbox`, `POST /v1/console/sandbox/evidence`·`/package`·`/package/verify`), 저장 없는 정산 증빙 2개(`evidence/`: `POST /v1/settlements/reconcile`·`/bundle`), 제품 화면의 나머지 3개(`console/ProductRoutes`: `POST /v1/console/products/:product/deactivate`, `/v1/console/institutions/:id/signing-key`, `/console-key`)를 넣었습니다. 등록 순서는 기준과 같습니다(`http/WebConfig`: 무료 티어 → 정산 증빙 → 콘솔 → 샌드박스 자료 → 샌드박스 키. 레일의 경로는 `/healthz` 다음). 스키마와 의존성은 바꾸지 않았고, SDK는 고정된 릴리스(`5f05b912…`)를 그대로 썼습니다(SDK 트리와 `tools/install-sdk.sh`는 건드리지 않음). 이 단계에서 나간 트랜잭션은 없습니다.
  - 옮긴 기준 파일과 수정 시각(10:10Z에 읽고 11:06Z에 다시 확인: 바뀌지 않음. 11:14Z에 벡터 도구 7종의 `--check`도 그대로): `apps/core/src/http/sandbox.ts` 11-11 06:11:26, `http/evidence.ts` 11-05 02:08:07, `http/routes.ts` 11-18 04:32:41, `http/server.ts` 11-12 08:19:29, `remit/routes.ts` 11-18 04:24:46(콘솔 경로 3개만), `remit/registry.ts` 11-17 07:59:43(`unsubscribe`·`setSigningKey`·`setConsoleKey`), `packages/attest-rules/src`의 `samples.ts` 11-05 08:00:57·`scenarios.ts` 11-05 07:57:33·`tamper.ts` 11-05 07:57:20·`demo-keys.ts` 11-05 02:11:41, `packages/attest-evidence/src`의 `bundle.ts` 11-04 08:41:30·`zip.ts` 08:41:54·`pdf.ts` 08:44:09·`report.ts` 08:40:37. 규칙 엔진(`engine.ts`, `policy.ts`, `signature.ts`)은 옮기지 않았고 SDK의 `Rules`를 부릅니다.
  - 지시와 다르게 된 것 하나: **샌드박스는 서명하지 않습니다.** 기준의 샌드박스는 서명이 들어 있는 샘플 한 건을 변환할 뿐이고 개인키를 갖지 않습니다(`tamper.ts`: "the library holds no private keys"). 그래서 `Conventions`로 데모 키 서명을 만드는 코드는 없고, 샘플과 데모 공개키는 데이터로 들어갔습니다(`sandbox/material.json`, `evidence/demo-issuer-keys.json`: 벡터 도구가 기준의 상수에서 쓰고 `--check`가 어긋남을 잡음). 요청마다 달라지는 것은 패키지의 `generatedAt`과, id·시각을 주지 않은 아카이브뿐입니다.
  - 판정: 서명 검증과 규칙은 SDK의 `Rules.checkSignatures`·`evaluate`·`validatePolicy`·`canonicalPolicy`이고, 이 모듈은 데모 키링과 거절의 구분만 더합니다(`evidence/Reconciler`: 규칙이 스스로 하는 거절은 그 문장 그대로, 기준이 런타임 안에서 멈추던 자리는 따로). 올린 증빙의 모양을 믿지 않는 부분(글자 자리에 목록·숫자·객체)은 기준이 하던 답을 그대로 옮겼습니다(`json/JsValues`: 멤버 읽기, 문장에 넣기, 참·거짓, 복사).
  - 증빙 아카이브(`evidence/EvidenceArchive`·`ZipWriter`·`Pdf`·`Report`): 구성 파일 7개(`manifest.json`, `evidence.json`, `policy.json`, `matching-results.json`, `source-hashes.json`, `issuer-signatures.json`, `verification-report.pdf`)가 기준과 바이트까지 같고 매니페스트의 다이제스트도 같습니다. ZIP의 필드(이름, 순서, 시각, CRC, 크기, 속성)도 같고, **압축된 바이트만 다릅니다**(D-15: Node와 JDK의 DEFLATE가 달라 시나리오 6개의 구성 파일 42개가 모두 다르게 압축됨. 그래서 `x-evidence-sha256`도 다름). 압축하지 않은 ZIP은 두 구현이 바이트까지 같습니다. 시계와 난수를 읽지 않고, 같은 요청은 같은 서버에서 같은 아카이브입니다. 기준의 어셈블러에 있는 증명 번들 구성 파일(`proof-bundle.json` 등)은 코어의 어느 경로도 넘기지 않아 옮기지 않았습니다.
  - 벡터(`tools/make-sandbox-vectors.mjs`, `SandboxVectorsTest` 8건): 기준의 핸들러를 라우터가 부르듯 불러 받은 답입니다. 이름 붙은 경우 336건(증빙 100, 패키지 30, 재검증 39, 판정 90, 아카이브 77. 200이 150건, 기준의 문장으로 된 4xx 거절이 133건, 기준이 문장을 정한 500이 19건, 엔진이 멈춘 500이 24건, 엔진의 문장으로 된 400이 10건), 표 6,300칸(샘플 증빙의 자리 38곳과 패키지의 자리 16곳을 값 30가지 — 없음, `null`, 숫자, 빈 글자, 목록, 객체, `toString` 멤버를 가진 객체, 반쪽 서러게이트 등 — 로 바꿔 경로마다, 증빙 경로는 변조 11가지와 함께), ZIP 28건(CRC 6, 압축하지 않은 아카이브 10, 압축한 것 5, 거절 7), PDF 41건(`toLatin1` 25, 문서 16: 줄바꿈, 긴 토큰, 쪽 넘김, 세 글꼴), 헤더 값 15건. 일부러 다른 것은 벡터가 표시합니다: 이름 붙은 25건(D-04 6, D-06 3, D-12 5, D-13 8, D-14 3)과 표 9칸(D-14). 첫 실행에서 잡힌 내 실수 하나: PDF 글자 폭 표에서 공백의 폭(278을 78로 읽음). 벡터 파일은 673 KB입니다.
  - 응답 대조(워커 끔, 새로 심고 새로 띄운 두 서버): **1,488건 중 1,388건 같음, 100건은 목록에 있는 차이, 목록 밖 0, 낡은 항목 0.** 파일별: attest 235, console 648(3a의 592에서 자리표시 9건을 빼고 65건 더함), evidence 254(새 파일 `parity/cases/evidence.mjs`), keys 28, operations 65, public 90, static 168. 샌드박스 → 판정 → 아카이브를 이어서 보내고(시나리오 6개의 증빙을 받아 그대로 판정·아카이브·패키지), **한쪽이 봉인한 패키지를 다른 쪽이 검증**합니다(`digestOk`·`policyUnchanged`·`reproduced`가 양쪽 모두 참이어야 함). 감사 기록은 825행씩 같고 목록 16건입니다. 제품 경로가 쓴 표는 `tools/compare-registry.mjs`로 맞댔습니다: 기관 8개(콘솔 서명키가 있는 것 2개)와 구독 14개(꺼진 것 1개)가 같습니다(기준 스키마에만 있는 플랫폼 자신의 기관 행은 레일이 뜰 때 쓰는 것이라 비교하지 않음).
  - 콘솔이 없는 배포: `CONSOLE_ENABLED=0`으로 띄운 대조 78건 같음, `STONEHASH_ENV=live`로 띄운 대조 78건 같음(3a의 57건에 새 경로 9개의 세션 유무와 키 3건을 더함. 세션은 샌드박스 자료와 정산 증빙을 열지 못하고 키는 엽니다).
  - 대조 도구에 넣은 것(`parity/run.mjs`): ZIP을 담긴 것으로 비교(구성 파일을 풀어 바이트로, 필드를 하나씩. 압축 바이트의 차이는 `archive: packed bytes` 하나로), 객체 꺼내 넣기(`'$.evidence'`, `'$'`), 상대 서버의 값 보내기(`swap`), 답이 무엇이어야 하는지 적기(`expect`), 헤더의 id 지우기(`blurHeaders`), 서버가 id·시각을 정한 아카이브(`looseArchive`).
  - 저장되는 문자열(지시 5번): `db/StoredText`(MyBatis의 문자열 타입 핸들러 하나)가 모든 매퍼의 문자열 파라미터에서 짝 없는 서러게이트를 U+FFFD로 바꿉니다(저장하는 값과 찾는 값 모두. 테스트 `StoredTextTest` 2건). 3a 기록의 "하지 않은 것"에 있던 틈(기준의 드라이버는 U+FFFD, Java의 드라이버는 `?`: 콘솔 키 라벨만 맞춰 둠)이 닫혔고, 대조에 그 경우를 넣었습니다(키 API의 서명키 라벨, 제품 활성화의 기관 이름과 키 id).
  - 위험 제거(지시 6번): 인스크립션 경로의 경우가 거절 하나에만 기대지 않게 했습니다. 문이 대상이면 문서 없음, 한도가 대상이면 그 조직이 이미 가진 작은 문서, 그 밖(중복, `Content-Type`)에는 인스크립션 한도보다 긴 문서(`parity/documents.mjs`. 크기가 지갑 앞의 마지막 검사이고 중복·`Content-Type` 검사가 그보다 먼저라 답은 그대로). 심는 인스크립션 문서도 그 길이로 바꿨습니다. 크기 검사 자체가 대상인 경우는 그 뒤에 지갑뿐이라 경우로는 막을 수 없어서, **대조용 Java 서버를 노드에 없는 지갑 이름으로 띄우게 했습니다**(`.env.parity`, `tools/make-parity-env.mjs`가 노드에 그 이름이 없는지 확인. `.env.dev-console-off`·`.env.dev-live`도 같게 바꿈). 기준 서버는 원래 그랬습니다. `tools/check-console-tx.mjs`(실제 인스크립션 한 건)만 `.env.dev`로 따로 띄워야 합니다(`parity/README.md`에 적음).
  - 규칙을 일부러 깬 확인 8가지(한 빌드에 모두): 변조된 서명의 글자, 패키지 다이제스트의 이름순 정렬, ZIP 시각의 초, PDF 굵은 글꼴의 폭, 아카이브 거절의 순서(시각이 증빙보다 먼저), 헤더에 실을 수 있는 글자, 폐기된 키로 기관 서명키 교체, 저장 문자열의 서러게이트. 단위 테스트가 7건 실패했고(54건 중. 폐기된 키는 단위 테스트에 없음), 대조가 30개 경우에서 잡았으며 감사 기록 8행과 기관 표 2행도 어긋났습니다. 그 대조에서 잡히지 않은 것 둘: 서명의 글자(단위 테스트만. 대조에 "두 번 변조" 경우를 더했지만 깨진 빌드로 다시 돌려 보지는 않았습니다)와 굵은 글꼴의 폭(요청으로는 긴 굵은 줄을 만들 수 없어 단위 벡터만). 같은 대조에서, 양쪽이 같게 틀리면 서로의 패키지 검증이 같은 답이 되는 것을 보고 `expect`를 넣었습니다. 원본을 다이제스트로 확인해 되돌린 뒤 **`clean` 빌드**로 위의 수치를 다시 냈습니다(되돌린 파일의 수정 시각이 깨진 클래스보다 오래돼, `clean` 없이는 깨진 클래스가 jar에 남는 것을 보았습니다. `parity/README.md`에 적음).
  - 기존 확인은 그대로: 단위 테스트 54건(44 + 8 + 2), 벡터 `--check` 7종, 왕복 186개·변조 745개(`check-roundtrip.mjs`), `compare-sealing.mjs`(대기 82건 → 양쪽 23배치, 기록 106건과 증명이 같음, 배치 없는 인스크립션 4건은 D-08대로).
  - 다르게 한 것(`docs/JAVA-INTENDED-DIFFERENCES.md`): 새 행 D-12(엔진만 읽는 시각 표기는 판정에서 읽지 않음: SDK가 정한 것. 축의 상태가 달라질 수 있음), D-13(변조 대상이 `__proto__` 같은 이름일 때), D-14(`toString` 멤버를 가진 객체가 규칙이 글자로 쓰는 자리에 있을 때: SDK와 기준의 차이), D-15(ZIP의 압축 바이트). 기존 행에 더한 것: D-01(샌드박스·아카이브에서 기준이 런타임 안에서 멈추던 요청), D-03(판정·패키지의 엔진 문장 400), D-04(아카이브의 `generatedAt`), D-06(샌드박스 3개와 기관 서명키의 `null` 본문). S- 행은 더하지 않았습니다. `expected.json`은 48항목입니다: "아직 옮기지 않음" 4항목을 빼고 16항목을 더했습니다(이유별: D-06 22, D-03 6, D-04 5, D-01 2, D-02 2, D-09 2, D-11 2, D-14 2, D-08·D-12·D-13·D-15와 "D-06, D-11" 각 1). 감사 16행(D-06 9, D-04 4, D-02·D-11·D-14 각 1).
  - 기준 구현에서 본 것(바꾸지 않음. 판단은 본 스레드): ① **프로토타입 오염.** `POST /v1/console/sandbox/evidence`에 `{"tampers":[{"id":"digest","target":"__proto__"}]}`를 보내면 `breakDigest`가 `Object.prototype`에 `digestVerified = false`를 씁니다. 인증된 요청 하나로, 재시작할 때까지 그 프로세스에서 `digestVerified`를 적지 않은 요소의 판정이 바뀔 수 있습니다(`constructor`면 `Object` 함수에 씀). 따로 띄운 프로세스에서 확인했고 대조용 기준 서버와 운영 코어에는 보내지 않았습니다. **운영 코어(`:8787`)가 지금 이 코드입니다.** ② PDF의 스트림 `/Length`가 UTF-8 길이인데 파일은 글자당 1바이트로 씁니다: U+0080~U+00FF 글자가 든 줄이 있으면 길이가 실제보다 큽니다(`é`가 든 증빙. 그대로 옮김). ③ `scenario`나 `dataMode`가 없는 증빙은 판정은 되는데 아카이브가 500입니다(`s is not iterable`). ④ 헤더에 실을 수 없는 `bundleId`(한글 등)의 아카이브는 응답이 500인데 감사 기록은 200입니다(Java도 같게 옮김). ⑤ `generatedAt: true`는 1970년 1 ms로 읽혀 500(`ZIP cannot represent a date before 1980`)입니다. ⑥ 금액 변조의 대상이 목록에 없는 이름이면 아무것도 바꾸지 않고 `scenario`에만 적습니다. ⑦ 패키지 재검증은 정책을 400으로 걸러내지 않아, 잘못된 정책이 든 패키지에 500(`policy: …`)으로 답합니다. ⑧ 콘솔 서명키는 검사만 하고 받은 글자 그대로(앞뒤 공백, 줄바꿈 포함) `console_spki`에 넣습니다(PoR 단계에서 그 열을 읽는 쪽 확인 필요). ⑨ `sourceTrustLevel`이 `toString`·`constructor`여도 정책 검증을 통과합니다(`in` 연산자. SDK도 같게 옮겨져 있음).
  - 하지 않은 것: PoR와 송금 경로(4~5단계. `GET /v1/settlements/reconcile`처럼 레일의 경로가 받는 요청, 레일이 뜰 때 쓰는 플랫폼 기관 행 포함), D-14를 SDK에서 맞추는 일, 콘솔 화면에서의 확인(화면은 건드리지 않았고 띄워 보지 않았습니다), 부하 시험, 깨진 빌드로 "두 번 변조" 경우를 다시 돌려 보는 일.
  - 지갑 `attest-java`: 시작할 때 4,974,562 + 미성숙 24,209 = 4,998,771 sat, 끝날 때 4,979,490 + 19,281 = 4,998,771 sat(다른 세션이 블록을 만들어 미성숙분이 성숙한 것뿐), 트랜잭션 수 198 그대로, 멤풀에 이 지갑의 것 0. 추가 입금과 블록 생성은 하지 않았습니다. 서버는 모두 내렸고 8790~8792 포트는 비어 있습니다.
- 2026-11-18 **콘솔 화면 변경 (c7, 10:51Z 게시, 11:10Z에 a7의 수정된 검증기를 들여와 재게시) — 서버 계약 변경 없음.** 검증을 한 화면(`#/verify`)으로 모으고 준비금 증명 화면은 앵커링만 하게 줄였습니다. 서버 코드는 건드리지 않았고, 콘솔이 부르는 경로만 달라졌습니다.
  - `GET /v1/por/snapshots`(목록): 콘솔은 더 이상 부르지 않습니다. 경로 자체는 그대로입니다.
  - `GET /v1/por/snapshots/:id`: 준비금 증명 화면에 더해 앵커링 기록의 스냅샷 패널에서도 부릅니다.
  - `GET /v1/console/attestations`: `?product=`와 함께 `?limit=50|200|500`을 보냅니다(기준 구현의 `pageLimit(…, 50, 500)` 그대로이며 새 규칙은 없습니다).
  - 검증 화면은 서버를 부르지 않습니다. 번들·송금 증빙·준비금 증명 파일을 브라우저 안에서 확인하며, 이를 위해 콘솔 빌드(`build.mjs sync`)가 `packages/attest-rules/src/{engine,policy,decimal,types,signature}.ts`를 `src/vendor/attest-rules/`로 복사합니다. 규칙 엔진을 고치면 콘솔을 다시 빌드해야 화면의 판정 재계산이 따라옵니다.
  - a7에 전한 것: SDK의 판정 비교가 축의 순서에 민감함(`packages/attest-remit/src/verify.ts`. 콘솔은 축별로 비교), 증빙 서명은 패키지에 실린 등록부 사본으로 검증됨(콘솔은 결과마다 "확인하지 않은 것"으로 적음).
- 2026-11-18 **실행 기록 — 3a단계(콘솔 API. 샌드박스 자료와 정산 증빙은 3b) 완료 (a7).** `apps/core-java`에 콘솔 경로 21개(`console/ConsoleRoutes`: 가입·로그인·로그아웃·`me`, 대시보드(`console/Dashboard`), 감사 검색(`audit/AuditSearch`), 기록 목록·접수·서명·인스크립션·번들·트랜잭션 조회, 콘솔 서명키 3개, 키 5개, 다른 세션 끊기)와 제품 화면 2개(`console/ProductRoutes`: `GET`·`POST /v1/console/products`. 기준과 같이 송금 레일이 켜진 배포에만 등록)를 넣었습니다. 계정·세션·쿠키는 `auth/Accounts`, 비밀번호는 `auth/Passwords`(BouncyCastle `SCrypt`), 과금은 `console/Billing`, 제품 활성화가 읽고 쓰는 레지스트리 부분은 `console/ProductRegistry`입니다. 등록 순서는 기준과 같습니다(`http/WebConfig`). 스키마와 의존성은 바꾸지 않았습니다.
  - 옮긴 기준 파일과 그 수정 시각(08:59Z에 읽고 마지막 대조 직전 09:54Z에 다시 확인: 바뀌지 않음): `http/console.ts` 06:27:54, `account.ts` 06:01:49, `billing.ts` 05:46:28, `audit.ts` 08:15:49, `http/routes.ts` 04:32:41, `remit/routes.ts` 04:24:46, `remit/registry.ts` 07:59:43, `por/routes.ts` 07:59:43(`spotChecked`만), `service.ts` 06:14:16. 오늘의 계약 변경 둘(`GET /v1/console/attestations?product=`, 대시보드 `avg_confirm_seconds`는 `product = 'attest'`만)이 들어 있습니다.
  - 계약 4(인증 호환): 저장된 `scrypt$N$r$p$salt$hash`를 적힌 파라미터와 해시 길이로 검증하고, 읽을 수 없거나 계산할 수 없는 값은 500이 아니라 로그인 실패입니다. 동시 계산은 2개까지입니다(S-15). 세션은 `sessions` 표 그대로이고 쿠키 속성은 `sessionCookie`와 글자까지 같습니다. 키 API의 인증 순서는 2단계 그대로입니다.
  - 벡터(`tools/make-console-vectors.mjs`, `ConsoleVectorsTest` 8건): 기준의 `verifyPassword`가 답한 저장 비밀번호 83건(기준의 `hashPassword`가 만든 것, 다른 파라미터, 숫자 표기, 0은 런타임 기본값, Base64 변형, 잘린 해시, 깨진 문자열), `normaliseEmail` 41건과 `passwordProblem` 15건, 쿠키 쓰기·지우기·읽기 60건, `searchAudit`가 저장소에 묻는 것 128건(페이지 크기 19, 시각 경계 42, LIKE 패턴 15, 커서 읽기 38, 커서 쓰기 7, 페이지 7), 달 13건, `monthlyCharges` 120건.
  - 응답 대조(워커 끔, 새로 띄운 두 서버): 1,177건 중 1,121건 같음, 56건은 목록에 있는 차이, 목록 밖 0, 낡은 항목 0. 콘솔 경우는 592건입니다(`parity/cases/console.mjs`). 감사 기록은 551행씩 같습니다(목록 7건). 심는 도구에 콘솔용 기록을 더했습니다: 세 상품의 기록을 두 달에 걸쳐 가진 조직, 월 한도보다 한 건 적은 조직, 기준이 만든 해시와 다른 파라미터·깨진 해시의 계정 12개, 세션 12개(유효, 만료, 비활성 계정, 다른 계정), 상태별 키, 활성화가 남기는 모양의 구독·기관, 송금 26건과 이벤트·웹훅·매니페스트, 준비금 스냅샷 13개, 감사 기록 71행. 대조 도구에는 서버별 쿠키 꺼내기(`cookie:<이름>`), 쿠키 속성의 글자 단위 비교, 순서 없는 목록(`unordered`), 파일 하나만 돌리기(`--file`)를 넣었습니다. 두 설정 파일에 `CONSOLE_AUTH_MAX=6`, `CONSOLE_MONTHLY_QUOTA=40`을 같이 넣었습니다.
  - 콘솔이 없는 배포: 두 서버를 `CONSOLE_ENABLED=0`으로 띄운 대조 57건 같음(503 `console_disabled`, 제품 화면은 403), `STONEHASH_ENV=live`로 띄운 대조 57건 같음(403 `not_available`, 키 API는 세션 쿠키를 받지 않음). 둘 다 설정으로 닿았습니다.
  - 실제 트랜잭션(`tools/check-console-tx.mjs`): Java 서버의 콘솔 경로로 58바이트 문서 한 건을 인스크립션했습니다(커밋 `a43aef84…` 154 vB 310 sat, 리빌 `17597937…` 191 vB 382 sat). 응답은 저장된 행 그대로에 월 한도를 붙인 모양이고 D-08대로 `submitted`, 배치 없음이었습니다. 멤풀에 있는 두 트랜잭션의 조회 결과는 노드의 `getmempoolentry`와 같았고, 그 기록을 기준 스키마에 복사한 뒤 기준 서버가 한 답과 필드까지 같았습니다. 블록에 들어간 트랜잭션의 조회(지갑 경로)는 Java 쪽만, 지갑의 `gettransaction`과 대조했습니다(대조용 기준 서버는 없는 지갑 이름을 씁니다).
  - 규칙을 일부러 깬 확인 7가지(비밀번호 비교, 세션 만료, 월 한도, 커서의 동률 처리, 상품 필터, 쿠키의 `SameSite`, 확정 평균의 상품 조건): 한 빌드에 모두 넣고 대조해 각각 그 규칙의 경우에서 잡혔고(목록 밖 47건), 비밀번호와 쿠키는 단위 테스트에서도 잡혔습니다. 되돌린 뒤 새로 빌드해 위의 수치를 다시 냈습니다. **이 빌드로 대조하는 동안 인스크립션 한 건이 실제로 나갔습니다**: 월 한도 검사를 깬 탓에 "한도를 넘은 문서" 경우의 29바이트 문서가 통과했습니다(커밋 `ed8661d3…` 424 sat, 리빌 `1f67e01d…` 368 sat). 그 경우와 같은 종류의 경우들은 이제 문서를 싣지 않거나 그 조직이 이미 가진 문서를 싣습니다.
  - 다르게 한 것(`docs/JAVA-INTENDED-DIFFERENCES.md`): D-10(해시 자리가 빈 저장 비밀번호는 아무것과도 일치하지 않음. 지금 값의 4배 시간·2배 메모리를 넘는 파라미터는 계산하지 않음), D-11(제품 활성화에서 문자열이 아닌 `institution.country`는 400), S-15(해시 동시 계산 2개). 기존 행에 더한 것: D-04(감사 검색의 `from`·`to`), D-05(동시에 같은 주소로 가입), D-06(콘솔의 두 경로). `expected.json`에 차이 13건과 감사 3건을 더했습니다(D-04 2, D-06 5, D-11 2, 아직 옮기지 않음 4).
  - 이 단계에서 고친 기존 코드: `time/IsoTime`이 0000~9999년 밖의 해를 `toISOString()`처럼 부호와 6자리로 쓰게 했습니다(전에는 `+10000`, `-0001`). 그 밖에는 공개 범위와 덧붙임입니다(`PublicKeys.base64`, `Auth.cookieHeader`, `IsoDate.epochMilli`, `BitcoindRpc`의 호출별 제한 시간, `AttestService.list`의 상품 조건·`revokeIssuerKey`·`storable`, `Body.truthy`).
  - 기존 확인은 그대로: 단위 테스트 44건(36 + 8), 벡터 `--check` 6종, 왕복 186개·변조 745개, `compare-sealing.mjs`(심은 기록이 늘어 대기 82건 → 양쪽 23배치, 기록 106건과 증명이 같음, 배치 없는 인스크립션 4건은 D-08대로).
  - 지갑 `attest-java`: 트랜잭션 4개(인스크립션 2건의 커밋·리빌), 수수료 합계 1,484 sat. 합계 5,000,255 → 4,998,771 sat(쓸 수 있는 잔액 0.04974562 BTC, 미성숙 24,209 sat), 멤풀 0. 추가 입금과 블록 생성은 하지 않았습니다.
  - 기준 구현에서 본 것(바꾸지 않음. 판단은 본 스레드): ① 해시 자리가 빈 저장 비밀번호는 어떤 비밀번호로도 로그인됩니다(D-10에서 Java만 막음). 잘린 해시도 그 길이만 비교해 통과합니다(1바이트면 256분의 1). 둘 다 DB에 직접 써야 생기는 값입니다. ② 등록되지 않은 주소의 로그인은 해시를 계산하지 않고 바로 답해서, 응답 시간으로 가입 여부가 드러납니다(Java도 같게 옮겼습니다). ③ 한도를 1바이트 넘은 인스크립션 문서의 답이 500입니다(키 API와 같음). ④ `GET /v1/console/me`의 `issuer_keys`는 `ORDER BY`가 없어 순서가 저장소에 달려 있습니다. ⑤ 제품 활성화에서 문자열이 올 자리의 다른 타입은 드라이버가 넘기는 대로 처리됩니다(숫자 `issuer_key_id`는 숫자 비교가 되어 앞자리가 같은 id와 맞을 수 있음. 그 조직의 키 안에서만). ⑥ id 없이 다시 활성화하면서 `country`를 빼면 기관의 국가가 `NULL`로 덮입니다. ⑦ 키 교체(`rotate`)는 가장 최근 키 하나만 끊습니다. 문장은 "The previous key stopped working"입니다.
  - 하지 않은 것: 샌드박스 자료 4개와 정산 증빙 2개(3b), 송금 레일이 등록하는 콘솔 경로 3개(`products/:product/deactivate`, `institutions/:id/signing-key`, `console-key`: 지시서의 셈으로는 5단계. 대조에는 "아직 옮기지 않음"으로 한 건씩 있습니다), 문자열에 짝 없는 서러게이트가 든 값의 저장(기준의 드라이버는 U+FFFD, Java의 드라이버는 `?`로 저장합니다. 콘솔 키 라벨만 맞췄고 이름·주소 등 나머지와 2단계 경로는 그대로입니다), 가입 경합의 실제 재현(D-05는 코드로만), `console.test.ts`의 화면 수준 확인(화면은 건드리지 않았고 띄워 보지 않았습니다), 부하 시험.
- 2026-11-18 **실행 기록 — 2b단계(인스크립션) 완료 (a7).** `apps/core-java`에 secp256k1과 BIP340(`btc/Secp256k1`: BouncyCastle의 곡선 연산 위에 서명·검증을 그대로 적음), 탭루트(`btc/Taproot`: 키 트윅, 리프 해시, 컨트롤 블록, 스크립트 경로 sighash, 증인 직렬화), 인스크립션 봉투(`btc/Inscription`), 커밋·리빌(`anchor/Inscriber`), `AttestService.inscribe`, `POST /v1/attestations/inscribe`를 넣었습니다. `/v1/meta`의 `inscription.enabled`는 `true`입니다. 스키마와 의존성은 바꾸지 않았습니다. 지갑은 `attest-java`만 썼습니다.
  - 그대로 옮긴 것: 전송이 먼저이고 기록이 나중(리빌 트랜잭션이 문서를 담으므로 전송 전에 적지 않음), 거절과 그 문장(`inscription_unavailable`, `empty_body`, `duplicate_digest`, 크기와 `Content-Type`의 문장, 노드의 거절 `bitcoind rpc <코드>: <문장>`), 업로드 한도(`INSCRIPTION_MAX_BYTES` + 64 KiB, 그 너머는 응답 없이 연결을 끊음), 수수료 2 sat/vB와 리빌 출력 1,000 sat, 내부 키는 NUMS 점, 기록은 `submitted`로 시작.
  - 벡터(`tools/make-btc-vectors.mjs`, `BtcVectorsTest` 15건): 곡선 연산 65건, `lift_x` 42건, 태그 해시 40건, BIP340 공식 서명 벡터 4건과 서명 24건(바이트까지 같음), 검증 19건, 탭루트 출력 29개(두 패리티 모두), sighash 5건, 봉투 68개(푸시 경계 0·1·75·76·255·256·519·520·521·1039·1040·1041과 그 위), 인스크립션 23건, 리빌 트랜잭션 5개(바이트, txid, wtxid). 적합성 픽스처 `07-witness-unified`의 리빌에서 문서를 읽으면 원본과 같고, 그 스크립트를 Java가 바이트까지 같게 씁니다(읽는 코드는 테스트에만 둠). `08-tampered-witness`는 TypeScript 검증기가 전과 같이 A 고리에서 거절합니다.
  - 동작 변경 D-08(본 스레드가 정해 내려준 것): 인스크립션 기록은 배치에 들어가지 않습니다. 대기 건수와 봉인이 `kind = 'inscription'`을 빼고, 상태는 `submitted` → `confirmed`로만 가고, `batch_id`·`leaf_index`는 `null`, `bundle_available`은 첫 응답부터 `true`입니다. `tools/compare-sealing.mjs`는 다이제스트 31건이 전과 같이 같은 배치 10개가 되는 것과, 배치 없는 인스크립션 2건을 기준만 가져가고(`confirmed`였던 것도 `batched`로) Java는 그대로 두는 것을 함께 확인합니다.
  - D-08에 딸린 것(S-12): TypeScript에서는 인스크립션이 들어간 배치의 앵커가 regtest 블록을 가져왔습니다. 배치에 넣지 않으면 블록을 가져올 것이 없어서, regtest에서는 확정 전 인스크립션의 리빌이 멤풀에 있는 주기에 워커가 블록을 하나 만듭니다. 본 스레드의 지시에는 없던 것이고, 없으면 샌드박스에서 인스크립션이 `submitted`에 머뭅니다.
  - 실제 체인(regtest, `tools/check-inscription.mjs`): Java 서버(워커 켬)로 문서 3개(텍스트 104바이트, 바이너리 300바이트, PDF 600바이트로 푸시 둘) → 각각 `submitted` → `confirmed`, 배치 0개, `bundle_available`은 처음부터 `true`. 번들 3개를 블록 전과 후에 `packages/attest-verify`가 통과시켰고(증인 모드: A·C1 통과, 트리가 없어 B는 건너뜀), 블록의 증인에서 읽은 문서 3개가 보낸 것과 같았습니다. 지갑의 코인을 모두 잠근 채 보낸 요청은 500 `bitcoind rpc -4: Insufficient funds`였고 기록도 트랜잭션도 남지 않았습니다. 같은 일을 기준 코어(워커 켬)로 한 뒤 비교(`tools/compare-inscription.mjs`): 첫 응답, 블록 전후의 번들, 검증기의 고리, 리빌의 크기와 수수료, 노드 거절의 답이 같고, 다른 것은 D-08뿐이었습니다(기준은 3건 모두 배치로 가져가 트랜잭션 3개와 585 sat를 더 썼고, 상태가 `submitted` → `batched` → `submitted` → `confirmed`, `bundle_available`은 그때까지 `false`).
  - 응답 대조(워커 끔): 585건 중 546건 같음, 39건은 목록에 있는 차이, 목록 밖 0, 낡은 항목 0. 감사 기록 206행씩 같음(목록 4건). 인스크립션 경로의 경우 23건을 넣었습니다. 모두 Java 쪽에서는 지갑에 묻기 전에 끝납니다(키 없음, 빈 본문, 이미 있는 다이제스트, 한도 초과, 업로드 한도 초과는 두 서버 모두 응답 없이 끊음, `Content-Type` 길이와 헤더 바이트를 읽는 방식, 다른 메서드). 대조 전후로 지갑 잔액과 멤풀이 같았습니다. `expected.json`에서 "아직 옮기지 않음" 3건을 지웠고 D-08과 D-09를 넣었습니다. `WorkerRecoveryIT`에 2건을 더해 7건입니다(배치에 들어가지 않고 자기 트랜잭션으로 확정, 노드가 거절하면 기록 없음).
  - 그 밖에 다르게 한 것(`docs/JAVA-INTENDED-DIFFERENCES.md`): D-09(`Content-Type`을 글자 수가 아니라 UTF-8 바이트로 520까지: 기준은 글자 수로 재서 통과시키고, 그러면 커밋이 나간 뒤 리빌이 거절됩니다. 실제로 해 보지는 않았습니다), S-13(연결을 끊는 방식: Tomcat은 최대 1초 뒤에 소켓을 닫음), S-14(전송 직후 로그 한 줄). "인스크립션의 한계" 절에 고치지 않은 것을 적었습니다(전송과 기록 사이의 멈춤, 리빌이 거절된 커밋, 동시에 온 같은 문서).
  - 기존 확인은 그대로: 단위 테스트 36건, 벡터 `--check` 5종, 왕복 186개, 규칙을 일부러 깨뜨린 확인 6가지(sighash, 트윅된 키의 패리티, 컨트롤 블록, 520바이트 분할, BIP340의 키 부호, 봉인 제외)가 각각 잡혔고 되돌렸습니다.
  - 지갑: 트랜잭션 48개(인스크립션 12건의 커밋·리빌 24개, 배치 앵커 24개: 검증 도구 두 번과 기준 한 번, `WorkerRecoveryIT` 세 번), 수수료 합계 14,478 sat, 블록 33개. 쓸 수 있는 잔액 0.04992382 → 0.04977904 BTC(수수료는 우리 블록의 보상으로 돌아와 미성숙 잔액 7,873 → 22,351 sat). 추가 입금은 하지 않았습니다.
  - 기준 구현에서 본 것(바꾸지 않음): ① 배치로 쓸려 들어간 인스크립션은 배치를 통해 확정되어 자기 블록이 기록되지 않습니다. 기록의 `block_height`·`block_hash`가 비고 번들의 `anchor.confirmed`가 `{"confirmations": 0}`입니다(실측 3건 중 3건). 운영 스키마의 기존 인스크립션 기록도 그럴 수 있습니다(운영 스키마는 보지 않았습니다. 전환 때 확인할 것). ② 커밋이 나간 뒤 리빌이 거절되면 커밋의 코인을 회수할 수 없습니다. 커밋과 리빌을 묶어 `testmempoolaccept`로 미리 물어보면 막을 수 있지만 넣지 않았습니다. ③ 커밋 자금을 댈 때 코인을 잠그지 않아, 동시에 온 요청(또는 배치 앵커)이 같은 코인을 고르면 늦은 쪽이 노드에서 거절됩니다(코드로만 확인). ④ 픽스처 07은 앵커 출력이 `BC30(merkle_root)`인 예전 배치 방식이고 내부 키가 곡선 위의 점이 아닙니다. 지금 서비스가 만드는 것은 앵커 출력이 문서의 다이제스트인 방식입니다. 픽스처는 봉투 형식의 기준으로만 썼습니다.
  - 하지 않은 것: 콘솔의 인스크립션 경로(3단계), `check-anchoring.mjs`와 `check-two-workers.mjs`의 재실행(봉인은 `compare-sealing.mjs`와 `WorkerRecoveryIT`로 확인), 노드에 연결하지 못할 때의 문장 대조(노드를 내릴 수 없음), 한도에 가까운 큰 문서의 실제 인스크립션(벡터로만), mainnet.
- 2026-11-18 **실행 기록 — 2단계의 배치 워커와 실제 앵커링 완료, 인스크립션(2b)은 남음 (a7).** `apps/core-java`에 배치 워커(`attest/BatchWorker`·`BatchService`·`WorkerLease`), bitcoind 지갑 연동(`anchor/BitcoindAnchorBackend`·`BitcoindRpc`), 마이그레이션 2번(`worker_leases`, `anchor_attempts`: 새 표만)을 넣었습니다. 지갑은 `attest-java`만 썼습니다.
  - 그대로 옮긴 것(1장 PAR-08): 주기마다 배치 하나, 가장 오래 기다린 기록의 조직, `created_at ASC, rowseq ASC`로 최대 `BATCH_MAX_LEAVES`개, 그 순서가 `leaf_index`, 증명은 공백 없는 JSON, "due" 규칙, 표에 쓰는 값, 로그 문장. 같은 대기 기록 33건(같은 밀리초의 여러 조직, 배치보다 많은 기록, 나중에 들어온 더 이른 시각 포함)을 TypeScript의 `sealBatch`와 Java가 각각 봉인해 배치 10개의 루트·순서와 기록 44건의 증명 문자열이 같았습니다(`tools/compare-sealing.mjs`).
  - 새로 지은 것(4장 1·4·8번): 전이마다 한 트랜잭션과 기대 상태 조건, 리스를 잡은 인스턴스만 일함, 서명한 트랜잭션을 전송 전에 기록하고 `sealed`로 남은 배치를 다시 시도, 확정 조회 실패의 건별 격리. `docs/JAVA-INTENDED-DIFFERENCES.md`의 S-08 ~ S-11입니다.
  - 실제 체인(regtest): Java 워커로 기록 12건(두 조직, 서명·무서명, 무료 티어) → 배치 4개 → 모두 확정, 번들 12개를 `packages/attest-verify`가 통과(A·B·C1), 번들의 블록 정보가 노드의 답과 같음(`tools/check-anchoring.mjs`). 같은 일을 기준 코어(워커 켬)로 하고 두 결과의 행 모양 8가지와 번들 모양 4가지를 비교해 같았습니다(`tools/compare-anchoring.mjs`).
  - 두 인스턴스를 같은 스키마에 띄우고 양쪽으로 기록을 넣음: 기록 36건, 배치 11개, 앵커 트랜잭션 11개, 기록된 시도 11개, 지갑에서 배치마다 트랜잭션 하나. 한 인스턴스만 일했고, 그 인스턴스를 내리자 다른 쪽이 리스를 이어받았습니다(`tools/check-two-workers.mjs`).
  - 멈춤과 복구(`WorkerRecoveryIT`, 5건, 실제 저장소와 체인): 전송과 기록 사이의 멈춤 뒤 두 번째 트랜잭션이 나가지 않음, 기록만 되고 전송되지 않은 트랜잭션은 그 트랜잭션이 전송됨, 입력이 다른 곳에 쓰인 시도는 버려지고 새 시도가 확정됨, 리스가 없으면 아무것도 하지 않음, 같은 전이 두 번은 한 번. 규칙 4개를 일부러 깨뜨려 각각 잡히는 것을 확인했습니다.
  - 2a에서 남았던 것: 공개키의 점을 압축해 적은 P-256 키로 서명한 statement를 TypeScript(WebCrypto)는 받는데 Java(JCA)는 받지 못했습니다. BouncyCastle로 점을 풀어 같게 했고 벡터 6건을 더했습니다(statement 156건).
  - 기존 확인은 그대로: 단위 테스트 20건, 벡터 `--check` 4종, 응답 대조 562건 중 목록 밖 차이 0, 감사 기록 일치, 왕복 186개, 기준선은 운영 스키마와 같음(더한 표 둘은 "마이그레이션이 더한 표"로 따로 표시: `tools/added-by-migrations.json`).
  - 지갑: 앵커 트랜잭션 33개(수수료 합계 5,858 sat), 블록 32개. 잔액 0.05 → 0.04994142 BTC. 추가 입금은 하지 않았습니다.
  - 기준 구현에서 본 것(바꾸지 않음, 2b에서 소유자에게 올릴 것): `sealBatch`와 `pendingCount`의 조건이 `batch_id IS NULL`뿐이라 인스크립션 기록(배치가 없음)도 다음 배치에 들어갑니다. 상태가 `submitted`/`confirmed`에서 `batched`로 되돌아가고 앵커 트랜잭션이 하나 더 나갑니다. Java도 지금은 같게 동작합니다.
- 2026-11-18 **인계 완료 (c7 → a7), 3f 기록.** 송금 인계 메모 `docs/REMIT-HANDOVER.md`가 07:35Z에 나왔습니다(규칙과 이유, 상태 기계, 외부와의 약속, 기준 테스트, 알려진 결함, 11-18에 바뀐 계약과 릴리스 상태, SDK `swift` 패키지, 겪은 결함 8건). 5단계의 선행 조건 하나가 채워졌습니다. 4장의 접수 트랜잭션 항목을 메모 1.1절에 맞췄습니다(첫 이벤트 셋과 `BANK_AUTHORIZED` 전이까지 한 트랜잭션). c7은 Java 송금 이식을 시작하지 않았고 여기서 멈춥니다.
- 2026-11-18 **실행 기록 — 송금 설계 초안과 SDK 릴리스 (a7).**
  - `docs/JAVA-REMIT-DESIGN.md` 초안 v1: 5단계 코드 전에 정리하라고 한 상태 전이표(T1~T19, 전이마다 기대 상태와 같은 트랜잭션에서 쓰는 것), 작업 큐 표(`remit_jobs`: 잡는 법, 송금 하나에 실행 중 작업 하나, 바로 실행과 주기 워커, 실패 처리), 단계별 멱등키(지갑 전송은 결과를 모르면 다시 보내지 않음), 콜백의 전제 상태와 중복, 전환 때 끝나지 않은 송금의 처리. 근거는 c7의 인계 메모(`docs/REMIT-HANDOVER.md`)와 `apps/core/src/remit/`입니다.
  - c7이 인계를 마치고 멈췄습니다(07:30Z). 송금 레일과 Java SDK의 `swift/` 패키지는 a7이 맡습니다. Java SDK를 다시 릴리스했습니다: jar `ca5484f3f6aedc537df71e50c7e420917ade03643c72cdf06ee35488518e93e8`(07:21Z, 테스트 110건, Java 11·17·21). 백엔드의 `sdk.lock`도 이 릴리스입니다.
- 2026-11-18 **실행 기록 — Java 검증용 지갑 (a7).** 소유자가 a7 창에서 7장의 기본값대로 하라고 했습니다("새 지갑 attest-java를 만들고, 우리 attest 지갑에서 소액을 한 번 보냅니다. 이렇게 진행해주세요").
  - 지갑 `attest-java`를 만들었습니다(디스크립터 지갑, 암호 없음, 자동 로드 설정은 건드리지 않음: 노드를 재시작하면 `attest`처럼 `loadwallet attest-java`가 필요합니다).
  - `attest`에서 0.05 BTC를 한 번 보냈습니다: 트랜잭션 `c419dbd350973394549f8a05b6d3cfd023429fe90771bf913a907ef44c59582d`, 0.01 BTC 출력 5개, 수수료 255 sat, 높이 10150에서 확정. 수수료율 1 sat/vB로 앵커 한 건이 약 200 sat이므로 검증에는 넉넉합니다.
  - 운영 코어의 앵커와 부딪히지 않게 했습니다. 운영 코어는 fund → sign → send 사이에 고른 출력을 잠그지 않으므로, 지갑이 알아서 고르게 두지 않고 쓸 출력 하나를 먼저 잠근 뒤 3초 동안 아무도 쓰지 않는 것을 확인하고 그 출력만 지정해 보냈습니다. 보내기 전후로 운영 스키마의 대기 건수는 0이었고(`attestations` 392건·`batches` 210건 모두 confirmed 그대로), 잠금은 남지 않았습니다.
  - `beecert`와 `regtest` 지갑은 건드리지 않았습니다.
- 2026-11-18 **실행 기록 — 2단계 가운데 API 부분(2a) 완료, 워커와 인스크립션은 남음 (a7).** `apps/core-java`에 API 키 인증(`auth/`), 감사 기록(`audit/`), 속도 제한(`http/RateLimiter`), 공개키 검사(`format/PublicKeys`), 앵커링 서비스와 경로(`attest/`), 노드 상태 확인(`anchor/BitcoindHealth`)을 옮겼습니다. 답하는 경로: `GET /readyz`, `POST /v1/attestations`, `POST /v1/attestations/signed`, `GET /v1/attestations`, `GET /v1/attestations/:id`, `GET /v1/attestations/:id/bundle`, `GET`·`POST /v1/issuer-keys`, `POST /v1/sandbox/keys`, 무료 티어 `POST /v1/public/anchors`, `GET /v1/public/anchors/:id`, `GET /v1/public/anchors/:id/bundle`와 OPTIONS 3개.
  - 대조: 두 임시 스키마에 같은 기록을 넣고(`tools/seed-reference.mjs`: TypeScript 코어의 코드로 만들어 그대로 복사. 운영 스키마는 읽지 않음) 같은 요청 562건을 두 서버에 보냅니다(`parity/run.mjs`: 서버별 변수와 순서 있는 시나리오). 목록에 없는 차이 0건. 감사 기록 186행도 두 스키마에서 같습니다(`tools/compare-audit.mjs`). 공개키 검사 57건, 감사 분류·세션 쿠키·호출자 주소·속도 제한은 TypeScript 코드가 낸 벡터와 일치합니다.
  - 일부러 다른 것 셋을 `docs/JAVA-INTENDED-DIFFERENCES.md`에 더했습니다: D-05(동시에 들어온 같은 다이제스트는 500이 아니라 409), D-06(본문이 JSON `null`이면 500이 아니라 그 경로의 400), D-07(`/readyz`에서 노드에 닿지 못했을 때의 문장), S-07(무료 티어 조직은 뜰 때가 아니라 처음 쓸 때 만듦).
  - 대조하면서 본 기준 코드의 동작(고치지 않음, 옮길 때 정함): `sealBatch`는 `batch_id IS NULL`인 행을 모두 묶으므로 인스크립션 기록(배치가 없음)도 다음 배치에 들어갑니다. `/v1/sandbox/keys`는 빈 문자열 slug로도 조직을 만듭니다. `POST /v1/issuer-keys`는 `algorithm: "RS256"`이면 EC 키도 받습니다. 목록은 `created_at`만으로 정렬해 같은 밀리초의 기록은 순서가 정해져 있지 않습니다.
  - 남은 것: 배치 워커와 bitcoind 지갑 연동(지갑 결정 필요), `POST /v1/attestations/inscribe`(2b), 압축 표기 EC 공개키로 서명된 statement의 검증(기준은 받음, Java의 JCA는 못 읽음: 벡터에 없는 경우).
- 2026-11-18 **실행 기록 — 1나 단계 완료 (a7).** 생산 쪽 형식을 `apps/core-java`의 `format/`·`btc/`에 옮겼습니다: Merkle 트리와 포함 증명, BC01, 레거시 트랜잭션 직렬화와 txid, 번들 조립(키 순서 포함), 정규화(SDK `Json.canonical`을 지남. 숫자 거절 문장은 TypeScript와 같음), 서명 statement의 리프·서명 입력·검증(ES256, RS256).
  - 대조: TypeScript 코드가 낸 벡터(트리 17개와 증명 200여 건, 번들 15개, 정규화 32건, statement 150건)와 전부 일치. Java가 만든 번들 186개를 `packages/attest-verify`가 통과시키고 변조본 745개를 걸러냄. 규칙 4개를 일부러 깨뜨려 테스트가 잡는 것을 확인.
  - SDK 의존: `com.stonehash:stonehash-attest-remit:0.1.0`을 로컬 Maven 저장소에 설치해 씁니다(`tools/install-sdk.sh`). 지금 고정한 릴리스는 `ebd97542…`(`sdk.lock`)이고, 새 릴리스가 나오면 이 줄을 바꿉니다.
  - 일부러 다른 것 둘을 `docs/JAVA-INTENDED-DIFFERENCES.md`에 적었습니다: D-03(JavaScript 엔진의 문장으로 나가던 거절을 우리 문장으로), D-04(`issued_at`은 ISO 8601과 그에 가까운 표기만).
  - 남은 것: Java 검증기(`AnchorProof`)로의 왕복은 SDK에 공개 진입점이 생긴 뒤(1가)에 붙입니다. 실제 체인 앵커를 거친 왕복은 2단계의 워커와 함께 합니다(지갑 결정 필요).
- 2026-11-18 **실행 기록 — 0단계 완료 (a7).** 소유자가 a7 창에서 직접 확인("sdk만 자바가 아니고, 플랫폼 백엔드 전체가 자바로 바꾸어야하는거야")하고 JDK 17·Maven 설치를 승인했습니다. 결과와, 지시서와 다르게 정한 것을 적습니다. 자세한 것은 `attest/apps/core-java/README.md`와 `docs/JAVA-INTENDED-DIFFERENCES.md`에 있습니다.
  - 도구: `openjdk-17-jdk-headless` 17.0.21, `maven` 3.8.7(시스템 패키지). 기본 `java`·`javac`는 11로 고정했고(`update-alternatives --set`), 백엔드는 `/usr/lib/jvm/java-17-openjdk-amd64`를 명시합니다. 빌드는 Maven wrapper(3.9.16)로 합니다. `~/.m2`는 133 MB입니다.
  - 버전: Spring Boot 4.1.2(Spring 7.0.10, Tomcat 11.0.27), MyBatis 스타터 4.1.0(MyBatis 3.5.19), Flyway 12.4.0, MySQL 드라이버 9.7.0, BouncyCastle 1.87. 테스트는 Boot가 관리하는 JUnit Jupiter 6.0.3입니다(2장의 "JUnit 5").
  - **2장과 다른 점: Spring MVC를 쓰지 않습니다.** 내장 Tomcat에 서블릿 하나를 두고 이 모듈의 경로 표(`http/Router`)가 처리합니다. 1장 "HTTP 경계"(404만 있고 405 없음, 빈 본문은 `{}`, Content-Type 무시, 경로 해석, 2칸 JSON)는 MVC의 기본 동작을 하나씩 꺼야 맞출 수 있어서, 기존 라우터를 그대로 옮기는 편이 계약을 지키기 쉽습니다. Tomcat이 경로를 먼저 해석해 400을 내는 것도 요청 대상을 원문 그대로 넘겨받아 없앴습니다(`http/RawTargetAdapter`). Jackson도 쓰지 않습니다(JSON은 `json/Js`: `JSON.parse`·`JSON.stringify`와 같은 결과). `spring-web`은 서블릿 컨텍스트 때문에 허용 목록에 더했습니다.
  - 기준선: 운영 스키마의 `SHOW CREATE TABLE`로 `V1__baseline.sql`(표 22개)을 만들었고, 빈 스키마에 적용한 결과가 운영 스키마와 카탈로그(표 22, 열 215, 인덱스 행 81, 외래 키 행 19, CHECK 1)에서 차이 0입니다. TypeScript 코어가 빈 스키마에 직접 만든 표는 운영과 열 순서가 7곳 다릅니다(`institutions.console_spki`, `por_snapshots.signing_spki`가 운영에서는 맨 뒤). 그래서 대조용 TypeScript 코어도 기준선으로 만든 스키마 위에 띄웁니다.
  - 대조: 벡터 테스트 11건(JSON 134건, 숫자 21,216개, 시각, 요청 주소 120건, 설정 82가지와 오류 문장) 통과. 두 서버에 같은 요청 230건을 보내 223건 동일, 7건은 한 항목(`/v1/meta`의 `inscription.enabled`: 2b 단계 전까지 `false`)만 다릅니다.
  - 개발 서버: `:8790`, 스키마 `stonehash_test_corejava`, 지갑 이름 `attest-java`(아직 만들지 않음), 워커 끔. 대조용 TypeScript 코어: `:8791`, `stonehash_test_coreref`. 둘 다 필요할 때만 띄우고 내립니다.
  - 따라가야 할 계약 변경(3f 알림, 3단계에서 반영): `GET /v1/console/attestations?product=`, `GET /v1/console/dashboard`의 `attest.avg_confirm_seconds`는 `product = 'attest'`만.
- 2026-11-18 동작 수정(TypeScript 코어, 3f — 같은 작업의 독립 검토 지적): `GET /v1/console/dashboard`의 `attest.avg_confirm_seconds`를 `product = 'attest'`인 기록만으로 계산합니다. 전에는 모든 상품의 확정 기록 100건으로 계산했습니다(같은 블록의 `funnel`·`recent`는 이미 걸러집니다). 응답 모양은 그대로입니다. 고친 곳은 `http/console.ts`의 `confirmPairs`. 테스트: `console.test.ts`의 "the dashboard's time to confirm is document anchoring's own".
- 2026-11-18 계약 변경(TypeScript 코어, 3f — 소유자의 콘솔 메뉴 수정 지시): `GET /v1/console/attestations`에 선택 쿼리 `product=attest|remit|por` 추가. 그 상품의 앵커만 최신순으로 답합니다. 상품 이름이 아닌 값은 400 `unknown_product`, 빈 값은 없는 것으로 봅니다. 응답 모양과 스키마는 그대로입니다. 고친 곳은 `service.ts`의 `list`와 `http/console.ts`의 `list`. 테스트: `apps/core/test/console.test.ts`의 "the record list holds every product's anchors and narrows to one on request". `openapi.json`에 파라미터를 넣었습니다(오퍼레이션 수는 66 그대로).
- 2026-11-18 v2.1: c7 세션의 독립 검토 결과 반영 — 이중 접수 차단 규칙이 바뀜(표 `remit_source_matches` 추가로 표 22개, 판정 순서, 쌍둥이는 1:1, 쌍둥이 키 두 단, 참조 정규화, 409 본문의 `ground`, 409 `duplicate_payment`, backfill 규칙)과 Java로 옮길 때의 주의 세 가지. 3f가 `db.ts`, `store.ts`, `orchestrator.ts`, 테스트에서 확인함.
- 2026-11-18 **v2**: 세 번째 독립 검토(계획과 스택 PS-) 반영. 외부 사실은 3f가 공식 문서로 다시 확인함.
  - 2장: Spring Boot 4.1.x로 고정(3.5는 공개 지원 종료), 실행 jar, DB 분기 지점, Flyway는 별도 단계로만 실행, BouncyCastle의 범위(탭루트는 이식), 허용 목록 보강.
  - 4장: 원장은 단계 완료 판정에서 빼고 별도 관문으로, 워커는 한 인스턴스만(8번), 부팅 때의 자료 작업을 부팅에서 뺌(9번).
  - 5장: 결정적인 값과 달라지는 값의 비교 규칙, "의도된 차이" 표, 대조 기준은 두 번째 TypeScript 코어, 복제본 검증에서 밖으로 나가는 일 차단, 전환 순서와 롤백 규칙, 송금 설계를 먼저 문서로.
  - 6장: 운영 스키마·지갑에 승인 없이 뜨지 않는 안전장치, 전환 중 TypeScript 수정 규칙.
  - 7장: Java 버전의 다른 선택 정정(최신 LTS는 25), 납품 형태, 롤백 기간.
  - 반영하지 않은 것: "현 스택으로 먼저 출시하면 경합을 TypeScript에서도 막을 것"(PS-06 ④). 소유자가 전환 뒤 출시로 정했습니다.
- 2026-11-18 v1.8: 독립 검토 2건(실행 가능성 EX-, 동작 동등성 PAR-) 반영. 지적 30건을 3f가 코드와 대조해 확인함.
  - 1장: "동작 동등성" 표 신설(시각 문자열, 저장된 해시, 서명 형식, JCS, 도메인 문자열, 봉인 순서, 응답 본문, HTTP 경계, 감사, 속도 제한, 문자열 비교, 금액, ID 모양). 계약 3·4·5 보강(플랫폼 서명키 파일, 비밀번호·세션·키 API 인증 순서, 무료 티어 CORS).
  - 2장·3장: DB URL 파싱, SDK를 의존성으로 쓰는 방법, regtest의 상태(블록 보상 0, `attest` 지갑 잔액).
  - 5장: "응답 일치"의 뜻, Flyway 기준선을 운영 스키마에서 뽑기, 전환 절차, 스모크와 데모가 운영 코어에 묶여 있다는 정정, 단계별 오퍼레이션 합계.
  - 6장: 개발용 설정 파일에서 바꿀 키, 두 번째 데모 세트, `reset-sandbox.sh` 금지, 기본 `java`에 기대지 않기, 변경 기록 대상 확대.
  - 7장: Java 검증용 regtest 지갑을 소유자 결정 항목으로 추가.
  - 검토가 틀린 곳 하나: JCS는 `attest-por-java`가 아니라 지금 정한 대로 `attest-remit-java`의 `Json.canonical`을 씁니다(같은 규칙으로 거부하는 것을 확인).
- 2026-11-18 v1.7: 소유자 결정 반영 — 실행을 a7 세션 한 곳으로 모음(송금 포함). c7은 하던 일을 마치고 송금 인계 메모(`docs/REMIT-HANDOVER.md`)를 남김. 3f는 v2까지만.
- 2026-11-18 v1.6: 소유자 결정 4건 반영 — JDK 17·Maven은 시스템 패키지로 설치, git은 도입하지 않음(스냅샷 규칙으로 대신), 출시는 Java 전환 뒤 한 번에, 취소·승인 경합은 Java 전환에서 고침.
- 2026-11-18 v1.5: a7 세션의 SDK 공개 진입점 제안 반영 — 1단계를 1가(SDK 규약)와 1나(백엔드 생산 형식)로 나눔, 백엔드에 새로 쓰는 것, 시간대 없는 시각은 UTC, 증빙 ZIP의 결정성 기준, 트래블룰 위치는 미정.
- 2026-11-18 v1.4: a7 세션 정정 반영 — 도구·의존성 내려받기는 소유자 확인 전까지 하지 않음(0단계 미착수). SDK 재사용 방식(의존 방향, `Json.canonical`, 공개 진입점, 생산과 검증 분리), JDK에 없는 암호 기능.
- 2026-11-18 v1.3: c7 세션 의견 반영 — "전문 하나에 송금 하나" 규칙과 기준 구현·테스트, 취소와 전송 지시의 조건부 갱신, 공통 계층 인터페이스 확정을 송금 착수의 선행 조건으로, 백엔드가 SDK `swift/`에 기대지 않음, 전환 중 운영 기준은 TypeScript 코어.
