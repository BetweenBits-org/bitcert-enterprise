# 국경간 송금

은행이 통제하는 정산 레일입니다. 귀행이 지급을 승인하면 플랫폼이 트래블룰
메시지를 중계하고, 인가된 정산주체가 USDC를 이동하며, 수취측 인가기관이
현지 지급을 실행합니다 — 그리고 모든 구간이 서명된, 독립 재검증 가능한
기록으로 남습니다.

연동은 귀행 시스템의 소스에서 SDK를 호출하는 것입니다. 지급 시스템이 이미
만드는 전문 — MT103, pacs.008, pain.001 — 을 SDK에 그대로 넘기면 서명된
지급지시가 되고, 결과는 ISO 20022 상태 보고(pacs.002)로 돌아옵니다. 전문에
적힌 참조번호, 그중에서도 UETR이 지급과 함께 서명된 증빙까지 따라가므로,
귀행 운영자는 자기 시스템이 찍은 번호 그대로 지급을 찾습니다. 기존 전문
출력과 상태 처리를 그대로 쓰므로 은행 시스템에서 바뀌는 곳이 가장 적습니다.

이것은 귀행 시스템 경계에서 이루어지는 전문 형식의 변환입니다. Swift
네트워크 연결이 아니며, 전문을 네트워크 규칙집에 비추어 검사하거나
네트워크가 받아 줄지를 말해 주지 않습니다.

## 준비

아래 코드에 넣을 것과 그 출처입니다. API 키와 기관 ID, 서명키는
[콘솔](../console/)에서 나옵니다:

| 필요한 것 (아래 코드에서의 이름) | 어디서 |
|---|---|
| 플랫폼 주소 `STONEHASH_CORE` | 이 배포: `{{ORIGIN}}` |
| API 키 `STONEHASH_API_KEY` | 콘솔 **연동 → API 키** |
| 기관 ID `STONEHASH_INSTITUTION` | 콘솔 **구독** — 국경간 송금을 활성화하면 표시됩니다 |
| 서명키 `key` · `signer` | 활성화 때 등록한 공개키의 개인키. 콘솔이 만들어 준 키라면 그때 내려받은 `stonehash-remit-signing-key.pem`, 운영에서는 귀행 HSM 안의 키 |
| SDK | [attest-remit.tar.gz](./download/attest-remit.tar.gz) · [SHA-256](./download/attest-remit.sha256) |
| SDK (Java) | [attest-remit-java.tar.gz](./download/attest-remit-java.tar.gz) · [SHA-256](./download/attest-remit-java.sha256) |

SDK는 패키지 저장소에 올라 있지 않습니다. 압축을 푼 자리의
`packages/attest-remit/src/index.ts`를 경로로 import 하며, 설치·빌드 단계와
외부 의존성이 없습니다(Node 22.18 이상). 표본 전문이
`packages/attest-remit/samples/`에 함께 들어 있습니다. 귀행 서비스를 `tsc`로
검사한다면 `allowImportingTsExtensions`(와 `noEmit`)를 켜십시오 — SDK를 `.ts`
경로로 import 하기 때문입니다.

귀행 시스템이 Java라면 SDK는 jar 하나입니다 — 압축을 푼 자리의
`sdks/attest-remit-java/release/stonehash-attest-remit-0.1.0.jar`(Java 11 이상,
외부 의존성 없음). 공개 저장소에는 올라 있지 않으므로 귀행 서비스의
classpath에 두거나, 같은 폴더의 `.pom`과 함께 사내 저장소에 올려
`com.stonehash:stonehash-attest-remit:0.1.0`으로 선언하십시오. 이 페이지의
예제는 위쪽 전환으로 TypeScript와 Java 가운데 골라 볼 수 있고, 본문이
TypeScript 이름으로 부르는 호출의 Java 이름은 [Java에서](#java에서)에 있습니다.

## 지급 보내기

**전문으로.** 지급 시스템이 쓴 전문을 그대로 넘깁니다. 판독, 변환, 견적,
서명, 제출이 호출 한 번입니다:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { RemitClient, type PartySupplement } from './packages/attest-remit/src/index.ts';

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: '귀행 이름',                       // 등록한 기관명 — 서명에 그대로 실립니다
  key: createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8')),
});

// 귀행 시스템이 쓴 전문 그대로 — 여기서는 SDK에 든 표본
const message = readFileSync('packages/attest-remit/samples/mt103.sample.txt');
// 귀행의 고객원장 — 여기서는 표본 발췌(송금인 계좌 → 전문에 없는 값)
const customerMaster = new Map<string, PartySupplement>(Object.entries(JSON.parse(
  readFileSync('packages/attest-remit/samples/parties.sample.json', 'utf8'))));

const sent = await client.submitSwift(message, {
  // 전문에 없는 값은 고객원장에서
  supplement: (payment) => customerMaster.get(payment.debtor.account ?? ''),
});
console.log(sent.paymentId, sent.state, sent.already);

const status = await client.swiftStatus(sent.paymentId);    // 접수 직후에는 { code: 'ACTC', final: false, … }
const report = await client.statusReport(sent.paymentId);   // pacs.002 (XML)
console.log(status.code, status.final);
console.log(report);
```
```java
import com.stonehash.attest.remit.*;
import com.stonehash.attest.remit.swift.SwiftStatus;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

RemitClient client = RemitClient.builder()
    .core(System.getenv("STONEHASH_CORE"))
    .apiKey(System.getenv("STONEHASH_API_KEY"))
    // 등록한 기관명 — 서명에 그대로 실립니다
    .institution(System.getenv("STONEHASH_INSTITUTION"), "귀행 이름")
    .signer(Signers.fromPkcs8Pem(
        Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
    .build();

// 귀행 시스템이 쓴 전문 그대로 — 여기서는 SDK에 든 표본
byte[] message = Files.readAllBytes(
    Path.of("packages/attest-remit/samples/mt103.sample.txt"));
// 귀행의 고객원장 — 여기서는 표본 한 줄(송금인 계좌 → 전문에 없는 값)
Map<String, PartySupplement> customerMaster = new HashMap<>();
customerMaster.put("VN-ACC-000777",
    new PartySupplement().debtorRegistrationNumber("0312345678"));

SwiftSubmission sent = client.submitSwift(message, new SwiftOptions()
    // 전문에 없는 값은 고객원장에서
    .supplement(payment -> customerMaster.get(payment.debtor().account())));
System.out.println(sent.paymentId() + " " + sent.state() + " " + sent.already());

SwiftStatus status = client.swiftStatus(sent.paymentId());   // 접수 직후에는 ACTC
String report = client.statusReport(sent.paymentId());       // pacs.002 (XML)
System.out.println(status.code() + " " + status.isFinal());
System.out.println(report);
```

처음 실행하면 `PAY-… BANK_AUTHORIZED false`와 `ACTC false`, 그리고 pacs.002를
출력합니다. 지급은 접수 뒤 스스로 진행되므로 결과는 `track()`이나 Webhook으로
따라갑니다([결과 받기](#결과-받기-상태-추적-webhook)). 같은 전문으로 다시 실행하면
새 지급을 만들지 않고 `sent.already`가 `true`로, 그때의 상태와 함께 돌아옵니다.
표본을 읽는 두 줄을 귀행의 전문과 고객원장 조회로 바꾸면 됩니다.
`inspectSwift()`는 보내지 않고 변환 내역만 돌려주고, `instructionFromSwift()`는
제출하지 않고 서명된 지급지시만 돌려줍니다.

**자체 데이터로.** 전문 없이 금액과 두 기업, 귀행 참조번호로 지급지시를 만들
수도 있습니다 — 견적, 작성과 서명, 제출, 추적의 네 단계입니다:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { RemitClient, verifyEvidencePackage } from './packages/attest-remit/src/index.ts';

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: '귀행 이름',                       // 등록한 기관명 — 서명에 그대로 실립니다
  key: createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8')),
});
await client.assertRegistered();                    // 등록된 키와 같은 키인가

const quote = await client.quote('10000.00');       // 무역금액 (USD)
const { paymentId, body } = await client.buildInstructionAsync(quote, {
  debtor:   { name: '수입기업', country: 'VN', address: '12 Le Loi, HCMC',
              registration_number: '0312345678', account: 'VN-ACC-1' },
  creditor: { name: '수출기업', country: 'SG', account: 'SG-ACC-9', bank: 'Demo Payout Bank' },
}, {
  invoiceRef: 'INV-2026-0457',
  instructionRef: 'OUT-2026-000123',                // 이 지시에 대한 귀행 참조번호
  review: { kybPolicyVersion: '2026.3', regulatorReportRef: 'RPT-0457', approvedByRole: 'Trade Operations' },
});
await client.submit(body);                          // 이미 전부 서명된 상태
console.log(paymentId);

const view = await client.track(paymentId, { onState: (s) => console.log('state', s) });
if (view.state === 'EVIDENCE_ANCHORED') {
  const report = await verifyEvidencePackage(await client.evidence(paymentId));
  console.log(report.verified, report.checks);
}
```
```java
import com.stonehash.attest.remit.*;
import java.nio.file.Files;
import java.nio.file.Path;

RemitClient client = RemitClient.builder()
    .core(System.getenv("STONEHASH_CORE"))
    .apiKey(System.getenv("STONEHASH_API_KEY"))
    // 등록한 기관명 — 서명에 그대로 실립니다
    .institution(System.getenv("STONEHASH_INSTITUTION"), "귀행 이름")
    .signer(Signers.fromPkcs8Pem(
        Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
    .build();
client.assertRegistered();                           // 등록된 키와 같은 키인가

Quote quote = client.quote("10000.00");              // 무역금액 (USD)
TradeParties parties = TradeParties.of(
    new TradeParties.Debtor().name("수입기업").country("VN")
        .address("12 Le Loi, HCMC").registrationNumber("0312345678")
        .account("VN-ACC-1"),
    new TradeParties.Creditor().name("수출기업").country("SG")
        .account("SG-ACC-9").bank("Demo Payout Bank"));
Instruction instruction = client.buildInstruction(quote, parties,
    new InstructionOptions()
        .invoiceRef("INV-2026-0457")
        .instructionRef("OUT-2026-000123")           // 이 지시에 대한 귀행 참조번호
        .review(new InstructionOptions.Review()
            .kybPolicyVersion("2026.3")
            .regulatorReportRef("RPT-0457")
            .approvedByRole("Trade Operations")));
client.submit(instruction);                          // 이미 전부 서명된 상태
System.out.println(instruction.paymentId());

Settlement settled = client.track(instruction.paymentId(),
    (state, view) -> System.out.println("state " + state));
if ("EVIDENCE_ANCHORED".equals(settled.state())) {
    // Java SDK가 다시 계산하는 것: 커밋 · 증거요소 서명 · 6축 판정 · 비트코인 증명 파일
    EvidenceReport report =
        EvidenceVerifier.verify(client.evidence(instruction.paymentId()));
    report.checks().forEach(System.out::println);
}
```

어느 경로든 지급지시에는 귀행이 서명하는 증거요소 3건(`bankInstruction` ·
`bankApproval` · `commercialDocs`)과 지급승인이, 6축 엔진이 평가하는 바로 그
형식으로 실립니다. `review` 값은 귀행 자신의 결론 — KYB 결과와 정책 버전,
규제 보고 참조번호, 승인자의 직책 — 이고 귀행 키로 서명되므로, 귀행 승인
시스템의 값으로 설정하십시오(`submitSwift()`에도 같은 옵션입니다). 기본값은
샌드박스 첫 실행을 위한 것입니다. `institutionName`은 귀행 서명에 그대로 붙는
이름입니다. 증빙의 서명 이벤트에 적은 그대로 남으므로 등록한 기관명을
쓰십시오 — 증거요소의 검증된 서명자 이름은 Trust Registry에 등록된 기관명으로
기록됩니다.

## Java에서

Java SDK는 같은 송금 경로를 같은 규약으로 구현합니다. 같은 전문은 두 SDK에서
같은 지급 ID가 되고, 한쪽이 보낸 지급을 다른 쪽이 이미 보낸 것으로
알아봅니다. 본문은 호출을 TypeScript 이름으로 부릅니다. Java에서 이름이나
모양이 다른 것은 다음과 같습니다:

| 본문 (TypeScript) | Java |
|---|---|
| `new RemitClient({ … })` | `RemitClient.builder()` … `.build()` |
| `key` | `.signer(Signers.fromPkcs8Pem(pem))` |
| `signer: { publicKey, sign }` | `.signer(Signers.external(publicKey, sign))` |
| `commandSigner({ publicKey, command })` | 없습니다 — 서명 도구는 `Signers.external`에 넘기는 함수 안에서 부릅니다 |
| `buildInstructionAsync()` | `buildInstruction()` — 돌아왔을 때 서명이 끝나 있습니다 |
| `new RemitClient({ …, readOnly: true })` | `RemitClient.builder()` … `.readOnly().build()` |
| `travelRule: 'B'` · `beneficiaryKeys` | `.travelRule(InstructionOptions.TravelRule.B)` · `.beneficiaryKey(id, thumbprint)` |
| `submitSwift(message, { index })` · `{ paymentId }` · `supplement` | `submitSwift(message, new SwiftOptions().index(n))` · `.paymentId(id)` · `.supplement(…)` |
| `parseSwiftMessages(message)` | `Swift.parseAll(message)` |
| `track(paymentId, { timeoutMs, onState })` | `track(paymentId, timeout, interval, onState)` |
| `verifyWebhook(body)` → `{ valid, envelope }` | `verifyWebhook(body)` → `Optional`: 검증된 envelope, 아니면 빈 값 |
| `swiftStatusOf(view)` · `buildPacs002(view)` | `Swift.statusOf(settlement.json())` · `Swift.buildPacs002(settlement.json())` |
| `verifyEvidencePackage()` → `{ verified, checks }` | `EvidenceVerifier.verify()` → `EvidenceReport`: `verified()`와 검사별 `checks()` |
| `RemitApiError` · `SwiftMessageError` · `SwiftMappingError` | `RemitApiException` · `SwiftMessageException` · `SwiftMappingException` — 모두 `RemitException`이고 코드는 `code()` |
| `SignerError` | 코드가 `signer_failed` 또는 `signature_unverified`인 `RemitException` |
| 읽기 전용 클라이언트의 `TypeError` | `IllegalStateException` |

`RemitClient` 하나는 여러 스레드가 함께 써도 안전합니다. 서비스에 하나만
두십시오. Spring 서비스라면 빈 하나입니다 — 내려받은 SDK의
`examples/spring/`에 클라이언트와 HSM 서명기를 빈으로 두는 설정, 전문을 받아
지급으로 보내는 서비스, Webhook을 검증해 받는 컨트롤러가 있습니다. 필수
당사자 항목이 빠진 지급지시는 Java SDK가 서명하기 전에
`travel_rule_incomplete`로 멈춥니다.

## 읽을 수 있는 전문

| 전문 | 받는 형태 |
|---|---|
| **MT103** | FIN 전체 형태(블록 1~5) 또는 본문 블록만 — `{4:` … `-}`째로든 `:20:`부터의 필드 줄만이든 — 줄바꿈은 CRLF·LF 모두. 한 파일에 전문 여러 건 — 연달아 있거나, 일괄 출력처럼 `$`로 구분된 형태(이때는 전문마다 헤더 블록이 있어야 합니다). 송금인은 `50A`·`50F`·`50K`, 수취인은 `59`·`59A`·`59F`, UETR은 블록 3의 `121` 필드. |
| **pacs.008** | 모든 버전(`pacs.008.001.xx`). `Document` 단독, Business Application Header와 함께 봉투에 담긴 형태, 또는 문서 여러 건을 감싼 형태. 기본 네임스페이스·접두사 모두. |
| **pain.001** | 모든 버전(`pain.001.001.xx`). 송금인은 지급 블록에서, 수취인은 각 거래에서 읽습니다. |

지급이 여러 건 담긴 전문에서 한 건을 임의로 고르는 일은 없습니다.
`parseSwiftMessages(message)`가 그 안의 지급을 모두 돌려주므로, 돌려받은 지급을
하나씩 `submitSwift(payment)`에 넘깁니다(`submitSwift(message, { index })`도
같은 결과이며, `index`는 0부터 셉니다).

다음은 추측하지 않고 사유와 함께 거절합니다:

- **고객 송금이 아닌 전문.** MT202, `pacs.009`, MT102, MT103의 커버 전문.
  헤더 블록이 없는 본문 블록은 MT103처럼 보이는 것으로는 부족하고
  MT103*이어야* 합니다 — 필수 필드가 모두 있고, 다른 전문 종류의 필드가 없고,
  같은 필드가 두 번 나오지 않아야 합니다. 그런 전문이 섞인 파일은 일부만
  읽지 않고 통째로 거절합니다.
- **다른 경로·다른 통화의 지급.** 샌드박스 송금 경로는 VN→SG이고 무역금액은
  USD 기준입니다. 송금인이 VN 밖에 있거나 수취인 또는 수취인 은행이 SG 밖에
  있는 지급, 지시금액과 은행간 결제금액 어느 쪽도 USD가 아닌 지급은
  거절합니다. 통화가 맞는다는 이유로 이 경로에서 견적을 내지 않습니다.
- **개인으로 식별된 당사자.** 이 경로는 기업 간 지급을 싣고, 두 당사자는
  법인으로 전달됩니다. 전문이 당사자를 개인으로 식별하면 — 개인 식별정보,
  생년월일, 여권번호나 주민번호류 — 거절합니다.
- **시험 전문.** `23B` `CRTS`, 헤더의 시험·교육용 BIC, 파일럿 서비스로 표시된
  전문은 시험용 키(`sk_test_`)에서만 받습니다.
- **문서형식 선언(DTD)이 든 XML.** DTD와 엔터티는 일절 처리하지 않습니다.
- **확신할 수 없는 인코딩이나 구조.** XML은 UTF-8, 바이트 순서 표시(BOM)가
  있는 UTF-16, 또는 선언문에 적힌 ISO-8859-1·windows-1252·US-ASCII로 읽습니다.
  그 밖의 인코딩 선언과, 선언한 인코딩에 맞지 않는 바이트는 거절합니다. 전문
  두 건이 든 `Document`, 다른 전문들은 `Document` 안에 있는데 혼자 밖에 있는
  전문, `DEBT`·`CRED`·`SHAR`·`SLEV`가 아닌 수수료 부담 구분, 쉼표가 든 금액도
  거절합니다. MT103에서는 지급을 읽어 내는 필드가 비어 있거나, 한 줄짜리 필드가
  둘째 줄로 이어지거나, `23B`가 `CRED`·`CRTS`·`SPAY`·`SPRI`·`SSTD`가 아니거나,
  `32A`의 결제일이 달력에 없는 날짜이거나, 블록 3에 `121` 필드가 두 번 있으면
  거절합니다.

## 전문에서 지급지시로

지급지시의 모든 값은 전문의 정해진 자리에서 옵니다. `inspectSwift(message)`가
귀행 전문에 대해 값마다의 출처(`fields`), 빠진 값(`issues`), 싣지 않는
내용(`unmapped`)을 돌려줍니다 — 아무것도 서명하거나 보내지 않습니다. 전문
종류별 출처는 다음과 같습니다:

| 지급지시 | pacs.008 | pain.001 | MT103 |
|---|---|---|---|
| 무역금액 (USD) | `InstdAmt`와 `IntrBkSttlmAmt`가 모두 USD이면 둘 중 작은 쪽, 아니면 USD인 쪽 | `Amt/InstdAmt`, 없으면 `Amt/EqvtAmt/Amt` | `33B`와 `32A`가 모두 USD이면 둘 중 작은 쪽, 아니면 USD인 쪽 |
| 송금인 이름 | `Dbtr/Nm` | `PmtInf/Dbtr/Nm` | `50a` 이름 줄, `50F`의 `1/` 줄 |
| 송금인 국가 | `Dbtr/PstlAdr/Ctry`, 없으면 `CtryOfRes` | 같음 | `50F`의 `3/` 줄, `77B`의 `/ORDERRES/` |
| 송금인 주소 | `Dbtr/PstlAdr` | 같음 | `50a` 주소 줄 |
| 송금인 등록번호 | `Dbtr/Id/OrgId`: `LEI`, 없으면 `Othr/Id` | 같음 | `50F` 당사자 식별자 또는 `6/` 줄 |
| 송금인 계좌 | `DbtrAcct/Id` | `PmtInf/DbtrAcct/Id` | `50a`의 `/account` 줄 |
| 수취인 이름 | `Cdtr/Nm` | 같음 | `59a` 이름 줄, `59F`의 `1/` 줄 |
| 수취인 국가 | `Cdtr/PstlAdr/Ctry`, 없으면 `CtryOfRes` | 같음 | `59F`의 `3/` 줄, `77B`의 `/BENEFRES/` |
| 수취인 계좌 | `CdtrAcct/Id` | 같음 | `59a`의 `/account` 줄 |
| 수취인 은행 | `CdtrAgt/FinInstnId`: `Nm`, `BICFI`, 청산시스템 회원번호 — 적힌 것 모두 | 같음 | `57A`, `57D`, 없으면 수신 은행 |
| 인보이스 참조 | 인보이스로 표시되었거나(`CINV` 등) 종류 표시가 없는 문서의 `RmtInf/Strd/RfrdDocInf/Nb`, 또는 `Ustrd` 안의 `/INV/` | 같음 | `70`의 `/INV/` |
| 지급 목적 | `Purp` | 같음 | `26T` |
| 지시번호 | `PmtId/InstrId`, 없으면 `GrpHdr/MsgId` | `PmtId/InstrId`, 없으면 `PmtInfId` | `20` |
| End-to-end ID | `PmtId/EndToEndId` | 같음 | `70`의 `/ROC/` |
| UETR | `PmtId/UETR` | `PmtId/UETR` | 블록 3, `121` 필드 |

- **금액**은 수취인이 받아야 할 금액입니다. 지시금액과 은행간 결제금액이 모두
  USD이면 둘 중 작은 쪽입니다. 수수료를 수취인이 부담하거나 나누어 부담하면
  은행간 결제금액은 이미 공제된 뒤의 금액이고, 송금인이 부담하면 수취은행
  몫으로 선납한 수수료가 들어 있을 수 있기 때문입니다.
- **등록번호**에 BIC는 쓰지 않습니다. BIC로만 식별된 당사자의 등록번호는
  귀행의 고객원장에서 가져와야 합니다.
- **국가**가 전문에 없으면 그 당사자 거래은행의 BIC에서 가져오고, 변환 내역에
  *추정*(`inferred`)으로 표시합니다.
- **인보이스 참조**가 없으면 End-to-end ID를, 그것도 없으면 송금 정보의 첫
  줄을 씁니다. 참조 문서 가운데 구매주문서나 대변표는 인보이스로 보지
  않습니다.
- **싣지 않는 내용**은 조용히 버리지 않고 나열합니다: 수수료 부담과 수수료
  금액(플랫폼 수수료는 수납 구간에 더해지고 수취인은 무역금액 전액을
  받습니다), 환율(견적이 고정합니다), 결제일(지급지시가 접수되면 정산이
  시작됩니다), 중개은행, 쓰지 않은 다른 금액, 두 번째 인보이스와 인보이스가
  아닌 참조 문서, 규제 보고.

**전문에 없는 값.** 자유형식 MT103에는 송금인 등록번호를 담을 필드가 없으므로
귀행의 고객원장에서 가져옵니다. `supplement`는 채울 값 자체이거나, 판독된
지급을 받아 그 값을 돌려주는 조회 함수입니다(비동기도 됩니다). 수취인 항목과
인보이스 참조, 지급 목적도 같은 방식으로 채웁니다:

```json
{ "debtor": { "registration_number": "0312345678" } }
```

이렇게 준 값은 전문의 값 대신 쓰입니다. 고객 기록이 자유 서술 한 줄보다
확실하기 때문이며, 변환 내역에 *보충*(`supplied`)으로 표시됩니다. 그래도 필요한
값이 빠져 있으면 견적·서명·전송 어느 것도 하지 않습니다. `SwiftMappingError`의
`issues`가 빠진 값마다, 전문의 어느 요소에 실렸어야 하는지를 전문의 용어로,
그리고 채우는 방법(`fix`)을 알려 줍니다.

## 같은 전문은 같은 지급

지급 ID는 전문 자체의 신원에서만 만들어집니다 — UETR이 있으면 UETR, 없으면
전문번호·지시번호·End-to-end ID와 결제일. 그래서 같은 지급을 두 번 넘겨도
알아봅니다. 재시도, 작성시각이 바뀐 다음 날의 재출력, 일괄 파일로 나갔다가
한 건만 다시 보낸 지급, 헤더 블록이 있는 MT103과 없는 같은 MT103 — 모두 이미
있는 송금을 찾아내며, 두 번째로 보내는 것은 없습니다. UETR이 있는 전문의 지급
ID는 그 UETR의 첫 묶음으로 시작하므로 — `3f1c9a52-7b0e-…`이면
`PAY-3f1c9a52-…` — 눈으로 맞춰 볼 수 있습니다.

지급이 이미 원장에 있는지는, 확실히 판단할 수 있는 곳에서 판단합니다. 보내기
전에 SDK는 그 지급의 ID로 된 송금과 그 UETR을 가진 송금을 조회합니다 — 번호의
일부로 검색하지 않고 정확히. 나머지는 지급지시가 도착했을 때 플랫폼이
판단합니다: 플랫폼에서 전문 하나는 송금 하나이며, 지급 ID가 무엇이든, 귀행의
두 프로세스가 같은 지급을 같은 순간에 넘겨도 그렇습니다. 플랫폼은 같은 파일의
같은 거래, 같은 UETR, 그리고 다른 전문에 담긴 같은 지급 — 지시번호·End-to-end
ID와 결제일, 내용이 같은 것 — 을 알아봅니다. 참조번호가 아무리 짧아도
그렇습니다. 나중에 온 쪽은 이미 있는 송금을 알려 주는
`409 duplicate_source_message`로 거절되고, `submitSwift()`는 그 송금을
`already: true`로 돌려줍니다.

같아 보이는 두 지급은 여전히 두 지급입니다. End-to-end ID와 금액, 당사자가
같은 분할 지급 두 건이 든 파일은 송금 둘을 만듭니다. 그 파일을 다시 출력하면
각 거래는 두 송금 가운데 하나씩에 맞춰지고, 둘 다 같은 송금에 맞춰지는 일은
없습니다 — 처음에 보내지 못한 분할 지급은 지급된 것으로 보고되지 않고
지급됩니다. UETR도, 자체 지시번호나 End-to-end ID도 없는 지급은 전문번호와
전문 안의 순번으로 알아봅니다: 같은 파일을 다시 출력한 것은 같은 지급이고,
전문번호가 다르면 새 지급입니다. 결제일이 없는 전문은 똑같이 생긴 다음
전문과 구분할 수 없습니다: 그런 두 번째 전문은 반복으로 보지 않고
거절합니다(`duplicate_source_message`).

같은 참조번호가 *다른* 지급에 다시 쓰인 경우 — 같은 UETR인데 금액, 당사자,
계좌, 인보이스 가운데 무엇이든 다른 경우 — 는 반복으로 보지 않습니다.
아무것도 보내지 않고 SDK가 `reference_reused`를 알립니다. 지급이 중복되지도,
말없이 사라지지도 않습니다. UETR이 없는 지급은 지시번호·End-to-end ID가 같고
결제일과 내용이 같을 때에만 같은 지급으로 봅니다. 같은 지급임을 의심 없이
알아보게 해 주는 것은 UETR이므로, 귀행 시스템이 실을 수 있다면 실으십시오.
UETR 자리에 값이 있는데 UUID가 아니면 전문을 거절합니다 — 읽지 못한 UETR
대신 다른 신원으로 지급을 만들지 않습니다.

귀행이 직접 정한 지급 ID(`{ paymentId }`)는 이름일 뿐입니다. 이미 송금이 있는
전문에서 두 번째 지급을 만들어 주지 않습니다. 그리고 지급 없이 끝난 송금 —
취소, 반환 — 도 그 전문의 자리를 계속 지킵니다. 그래도 지급하려면 고유한
참조번호 — 다른 지시번호나 End-to-end ID — 를 가진 새 전문으로 보내십시오.
(새 UETR만으로는 UETR이 있는 송금과만 구분됩니다.)

귀행이 서명하는 지급지시에는 그 지시의 바탕이 된 전문에 대한 참조가 실립니다:
전문 종류, 참조번호, 귀행 시스템이 쓴 그대로의 파일에 대한 SHA-256, 그리고
지급 내용의 다이제스트 — 금액, 양 당사자의 이름과 계좌, 지급 자체의 식별자,
인보이스 참조와 송금 정보 문구.
전문 자체는 귀행 시스템을 떠나지 않은 채 송금이 그 전문에 묶입니다. 이 값이
보관한 파일의 SHA-256과 같으려면 전문을 디코딩한 문자열이 아니라 시스템이 쓴
바이트 그대로 넘기십시오. 콘솔의
송금 원장 검색은 UETR·지시번호·End-to-end ID·전문번호로 지급을 찾고, 추적
화면에 전문 종류와 UETR, 귀행 지시번호가 표시됩니다.

## 서명과 HSM

분리 서명 2종, 곡선은 하나(ES256, raw `r‖s`, base64url), 입력은 모두
RFC 8785(JCS) 정규화 바이트입니다:

- **이벤트** — 지급승인·취소·답변·일별 대사, 그리고 플랫폼이 서명하는
  Webhook: `"stonehash:remit:event:v1\n" + JCS(payload)`.
- **증거요소** — unsigned 필드를 제외한 요소에
  `"stonehash:evidence:sig:v1\n"` 접두. 각 요소는
  `"stonehash:evidence:digest:v1\n"` 도메인의 내용 digest도 선언하며,
  플랫폼이 재계산합니다.

SDK가 두 규약을 모두 구현합니다. 키 자체는 귀행의 HSM이나 KMS에 그대로 둘 수
있습니다: 클라이언트에 `key` 대신 `signer`를 주면 됩니다. 서명기는 서명할
바이트를 그대로 받아 SHA-256 기반 ECDSA P-256 서명을 돌려주며 — raw와 DER
모두 받습니다 — SDK는 그 서명을 쓰기 전에 공개키로 검증합니다. 슬롯이나 키
라벨이 틀리면 귀행 쪽에서 분명한 메시지와 함께 멈춥니다.

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { RemitClient } from './packages/attest-remit/src/index.ts';

// 여기서는 파일의 키가 HSM을 대신합니다 — 운영에서는 sign()이 귀행의 HSM·KMS를 호출합니다
const hsmKey = createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8'));

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!, apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!, institutionName: '귀행 이름',
  signer: {
    // 콘솔에 등록한 공개키 (PEM, 또는 SPKI DER의 base64)
    publicKey: createPublicKey(hsmKey).export({ type: 'spki', format: 'pem' }).toString(),
    // 받은 바이트 그대로에 대한 ECDSA P-256 / SHA-256 서명
    sign: (bytes) => sign('sha256', bytes, hsmKey),
  },
});
await client.assertRegistered();                    // 등록된 키와 같은 키인가
```
```java
import com.stonehash.attest.remit.*;
import java.nio.file.Files;
import java.nio.file.Path;

// 여기서는 파일의 키가 HSM을 대신합니다 — 운영에서는 아래 람다가 귀행의 HSM·KMS를 호출합니다
KeySigner hsmKey = Signers.fromPkcs8Pem(
    Files.readString(Path.of("stonehash-remit-signing-key.pem")));

RemitClient client = RemitClient.builder()
    .core(System.getenv("STONEHASH_CORE"))
    .apiKey(System.getenv("STONEHASH_API_KEY"))
    .institution(System.getenv("STONEHASH_INSTITUTION"), "귀행 이름")
    .signer(Signers.external(
        // 콘솔에 등록한 공개키 (PEM, 또는 SPKI DER의 base64)
        hsmKey.publicKeySpkiBase64(),
        // 받은 바이트 그대로에 대한 ECDSA P-256 / SHA-256 서명
        bytes -> hsmKey.sign(bytes)))
    .build();
client.assertRegistered();                           // 등록된 키와 같은 키인가
```

`assertRegistered()`는 등록된 키와 같으면 아무것도 돌려주지 않고, 다르면
`key_mismatch`를 던집니다. 서명기를 쓸 때는 `submitSwift()`나
`buildInstructionAsync()`로 지급지시를
만듭니다. 동기 방식의 `buildInstruction()`은 프로세스 안에 있는 키를 위한
것입니다. 서명 도구가 명령으로 호출되는 형태 — OpenSSL, PKCS#11 도구, KMS
래퍼 — 라면 `commandSigner({ publicKey, command })`가 같은 서명기를 만들어
줍니다. 서명할 바이트는 그 명령의 표준입력으로 가고, 서명은 표준출력에서
읽습니다(raw 또는 DER, 바이너리·base64·16진수 모두). `command`는 셸 없이
실행되는 인자 목록입니다 — 예: `['openssl', 'dgst', '-sha256', '-sign', keyPath]`.

지급을 따라가기만 하는 시스템 — 모니터링, 운영, 대사 — 에는 서명키가 아예
필요 없습니다. `new RemitClient({ …, readOnly: true })`는 키 없이 `status()` ·
`swiftStatus()` · `statusReport()` · `track()` · `evidence()`를 읽으며,
서명하거나 보내는 호출은 거절합니다.

## 트래블룰: 모드 A와 모드 B

수취기관은 지급을 받아들이기 전에 여덟 항목을 요구합니다: 송금인의
이름·국가·주소·등록번호와 수취인의 이름·국가·계좌·은행. 견적이 이 목록을
알려 주며(`required_travel_rule_fields`), 하나라도 빠진 지급지시는 아무것도
저장되기 전에 거절됩니다.

- **모드 A**(기본). 당사자 항목이 `compliance_payload`에 담겨 플랫폼으로
  갑니다. 플랫폼이 메시지를 구성해 수취기관의 키로 암호화하고, 암호문과 그
  digest를 보관합니다. 메시지가 암호화되면 저장된 요청에서 당사자 항목은
  지워집니다.
- **모드 B**(`travelRule: 'B'`). SDK가 같은 메시지를 귀행 쪽에서 구성해,
  `GET /v1/remit/meta`에 공개된 수취기관 공개키로 암호화합니다. 귀행
  시스템을 떠나는 것은 암호문, 그 digest, 그리고 필수 항목이 들어 있다는
  귀행의 서명된 확인뿐입니다. 이 확인은 어느 메시지에 대한 것인지를 함께
  담습니다 — 메시지의 digest와 암호문의 SHA-256 — 그래서 다른 암호문으로
  바꿔 넣을 수 없고, 확인과 메시지가 맞지 않는 지급지시는 플랫폼이
  거절합니다. 플랫폼은 읽을 수 없는 메시지를 중계하고, 수취기관이 복호화해
  항목을 실제로 검사합니다. `beneficiaryKeys`를 주면 SDK는 레지스트리가
  알려 주는 키가 아니라 귀행이 기대하는 키 — 수취기관과 따로 주고받은
  thumbprint — 로만 암호화합니다.

어느 모드에서든 두 기업의 이름은 귀행이 서명하는 증거요소에도 들어가며,
플랫폼이 이를 저장하고 증빙 패키지에 실립니다. 주소·등록번호·계좌는
트래블룰 메시지로만 전달됩니다. 이것은 귀행이 보내는 것에 대한 설명입니다 —
수취기관이 서명한 입금 확인(`payoutReceipts`)에는 수취인 계좌가 실립니다.

수취기관의 응답은 셋 중 하나입니다: 서명된 수락 — 이후 지급을 사전승인하고
정산이 진행됩니다. 질문 — 귀행이 답할 때까지 지급이 멈춥니다. 거절 — 자금이
움직이기 전에 지급이 취소됩니다.

## 결과 받기: 상태, 추적, Webhook

상태머신이 강제하는 두 규칙:

1. **수취기관의 서명된 사전승인 전에는 자금이 움직이지 않습니다.**
   전송 지시는 `PAYOUT_ACCEPTED` 이벤트에서 파생되거나, 존재하지 않습니다.
2. **검증 가능한 증거 전에는 입금을 확정하지 않습니다.**
   `BENEFICIARY_CREDIT_CONFIRMED`는 서명된 지급완료와 6축 대사 통과를
   **동시에** 요구합니다. 무서명 완료 통보는 지급을 `PAYOUT_IN_PROGRESS`에
   머물게 합니다 — 실패도, 확정도 아닙니다.

상태는 전진만 합니다: `REQUEST_ACCEPTED → BANK_AUTHORIZED →
TRAVEL_RULE_PENDING → PAYOUT_PRE_APPROVED → ONCHAIN_SETTLED →
PAYOUT_IN_PROGRESS → BENEFICIARY_CREDIT_CONFIRMED → EVIDENCE_ANCHORED`,
종료 상태는 `CANCELLED`, `RETURNED`, `EXCEPTION`. 정정은 언제나 새 서명
이벤트이지, 수정이 아닙니다. 제출에 대한 HTTP 202는 접수일 뿐, 지급 완료가
아닙니다.

**폴링.** `client.track(paymentId)`는 지급이 끝나거나 귀행의 조치를 기다리며
멈출 때까지 `GET /v1/settlements/{id}`를 읽습니다. 3분(`timeoutMs`)이 지나도
그대로면 `tracking_timeout`을 던지므로, 다시 호출해 이어서 따라가십시오.
입금은 `BENEFICIARY_CREDIT_CONFIRMED`(`ACCC`)에서 확정이고, 앵커
(`EVIDENCE_ANCHORED`)는 그 뒤에 따로 옵니다.
폴링은 안으로 들어오는 연결이 필요 없으므로 방화벽 뒤에서도 동작합니다.

**Webhook.** 활성화 때 Webhook URL을 주었다면, 플랫폼이 단계마다 JSON 본문을
POST 합니다:

```json
{
  "envelope": {
    "event_id": "5f0c…", "payment_id": "PAY-3f1c9a52-6b0d8e41c7", "sequence": 7,
    "type": "ONCHAIN_SETTLED", "state": "ONCHAIN_SETTLED",
    "occurred_at": "2026-11-17T08:24:32.330Z", "data": { }
  },
  "signature": { "alg": "ES256", "key_id": "STONEHASH-SIGN-…", "issuer": "STONEHASH", "sig": "…" }
}
```

서명은 플랫폼의 것으로, 위 이벤트 규약에 따라 envelope 전체에 대한 것이며,
플랫폼 공개키는 `GET /v1/remit/meta`에 있습니다.
`await client.verifyWebhook(body)`가 이를 검증해 `{ valid, envelope }`를
돌려줍니다. `valid`가 `true`일 때에만 처리하십시오 — 아니면 `envelope`는
`null`입니다. 전달은 최소 한 번입니다: `event_id`로 중복을 걸러 내고
`sequence`(이 알림이 가리키는, `GET /v1/settlements/{id}` 이벤트의
순번)로 순서를 맞추십시오. 2xx 응답이면 수신 확인이며, 5초 안에 확인되지
않은 전달은 2초, 10초, 30초, 2분 뒤부터 다시 시도합니다(전달 주기에 따라 몇
초 늦을 수 있습니다) — 모두 다섯 번 — 그
뒤로는 폴링이 보완합니다. `type` 값은 `BANK_AUTHORIZED`,
`TRAVEL_RULE_PENDING`, `TRAVEL_RULE_RFI`, `TRAVEL_RULE_RFI_RESOLVED`,
`PAYOUT_PRE_APPROVED`, `SETTLEMENT_INSTRUCTED`, `ONCHAIN_SETTLED`,
`PAYOUT_IN_PROGRESS`, `PAYOUT_SUBMITTED`, `PAYOUT_COMPLETED`,
`EVIDENCE_INSUFFICIENT`, `PAYOUT_FAILED`, `RETURNED`,
`RECONCILIATION_EXCEPTION`, `BENEFICIARY_CREDIT_CONFIRMED`,
`EVIDENCE_COMMITTED`, `EVIDENCE_ANCHORED`, `CANCELLED`, `EXCEPTION`입니다.
`type`은 단계의 이름이어서, 그 `sequence`가 가리키는 이벤트의 이름과 다를 수
있습니다. 입금으로 다뤄도 되는 것은 `BENEFICIARY_CREDIT_CONFIRMED`뿐입니다 —
`PAYOUT_COMPLETED`는 수취기관의 통보일 뿐입니다.

## 상태를 SWIFT 형식으로

`client.swiftStatus(paymentId)`는 송금의 상태를 ISO 20022 거래 상태코드로,
`client.statusReport(paymentId)`는 지급 허브가 이미 처리하는 `pacs.002` 보고로
돌려줍니다. 이미 받아 둔 조회 결과(`status()`나 `track()`이 돌려준 값)에서는
`swiftStatusOf(view)`와 `buildPacs002(view)`가 같은 일을 합니다. Webhook의
envelope는 조회 결과가 아니므로, Webhook을 받았을 때는
`client.swiftStatus(envelope.payment_id)`로 읽으십시오. 사유는 이 플랫폼의 이벤트 이름을
독자(proprietary) 사유로 싣습니다. 표준 사유코드에 억지로 맞추면 아는 것보다
많은 것을 주장하게 되기 때문입니다.

| 상황 | 상태 | 사유 |
|---|---|---|
| 지급지시 접수, 서명 검증 완료 | `ACTC` | |
| 수취기관 응답 대기 | `PDNG` | `TRAVEL_RULE_PENDING` |
| 수취기관이 추가정보를 요청 | `PDNG` | `RFI` — 질문이 보고에 실립니다 |
| 수취기관이 지급을 사전승인 | `ACSP` | `PAYOUT_PRE_APPROVED` |
| 정산 이체 확정 | `ACSP` | `ONCHAIN_SETTLED` |
| 현지 지급 진행 중 | `ACSP` | `PAYOUT_IN_PROGRESS` |
| 서명된 증거 없이 지급 완료 통보 | `PDNG` | `EVIDENCE_INSUFFICIENT` |
| 현지 지급 실패, 자금 반환 중 | `PDNG` | `PAYOUT_FAILED` |
| 수취인 계좌 입금 확정 | `ACCC` | — 수취은행 참조번호 포함 |
| 귀행 요청으로 취소 | `RJCT` | `CANCELLED_BY_BANK` |
| 수취기관이 거절 | `RJCT` | `TRAVEL_RULE_REJECTED` |
| 현지 지급 실패, 자금 반환 | `RJCT` | `RETURNED` |
| 수동 확인이 필요해 정지 | `PDNG` | `EXCEPTION` |

상태코드는 은행간 코드를 ISO 20022 정의 그대로 씁니다. 귀행 요청으로 철회된
지급은 사유 `CANCELLED_BY_BANK`의 `RJCT`로 보고합니다 — 표준은 `CANC`를 API
환경용으로 두고 있고, 지급 허브는 `pacs.002`를 은행간 코드로 읽기 때문입니다.
정지된 지급은 사유 `EXCEPTION`의 `PDNG`로 보고하며, 이후 상태가 자동으로
오지 않는다는 것을 문장으로 밝힙니다 — 사람이 처리합니다. `swiftStatus()`의
결과에는 누가 조치해야 하는지도 실립니다(`needs`: `bank_answer` 또는
`manual_resolution`).

보고는 귀행 전문을 그 전문의 식별자로 가리키는 `pacs.002.001.10`입니다
(자체 데이터로 만든 지급의 보고에는 `Orgnl…` 참조가 없으므로 `StsId`의 지급
ID로 맞추십시오).
`AccptncDtTm`은 상태가 무엇이 되었든 지급지시가 접수된 시각이고, 입금이 끝난
지급에서는 `FctvIntrBkSttlmDt`가 입금 시각을 담습니다:

```
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">
  <FIToFIPmtStsRpt>
    <GrpHdr>
      <MsgId>PAY-3f1c9a52-6b0d8e41c7-12</MsgId>
      <CreDtTm>2026-11-17T08:24:34.001Z</CreDtTm>
    </GrpHdr>
    <TxInfAndSts>
      <StsId>PAY-3f1c9a52-6b0d8e41c7</StsId>
      <OrgnlGrpInf>
        <OrgnlMsgId>DEMOVNVX20261117000123</OrgnlMsgId>
        <OrgnlMsgNmId>pacs.008.001.08</OrgnlMsgNmId>
      </OrgnlGrpInf>
      <OrgnlInstrId>OUT-2026-000123</OrgnlInstrId>
      <OrgnlEndToEndId>PO-7781</OrgnlEndToEndId>
      <OrgnlUETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</OrgnlUETR>
      <TxSts>ACCC</TxSts>
      <AccptncDtTm>2026-11-17T08:24:29.412Z</AccptncDtTm>
      <FctvIntrBkSttlmDt>
        <DtTm>2026-11-17T08:24:32.619Z</DtTm>
      </FctvIntrBkSttlmDt>
      <AcctSvcrRef>FAST-20261117-0059</AcctSvcrRef>
    </TxInfAndSts>
  </FIToFIPmtStsRpt>
</Document>
```

## 흐름이 어긋날 때

- **수취기관의 질문.** 지급이 `TRAVEL_RULE_PENDING`에서 멈추고, 질문이 담긴
  `TRAVEL_RULE_RFI` 이벤트가 생깁니다. `client.answerRfi(paymentId, answers)`로
  답하십시오. `answers`는 귀행이 정한 키와 답변 문자열의 맵입니다. 수취기관만
  복호할 수 있게 암호화되며, 플랫폼은 digest만 보관합니다. 샌드박스
  수취기관은 비어 있지 않은 답이면 받아들입니다.
- **취소.** `client.cancel(paymentId, reason)`은 지급 사전승인 전까지
  가능합니다. 샌드박스에서 정상 지급은 1초 안에 그 지점을 지나므로, 질문으로
  멈춰 있는 지급에 시험해 보십시오.
- **반환.** 정산 후 현지 지급이 실패하면 USDC가 온체인으로 되돌아오고 지급은
  `RETURNED`로 끝납니다. 실패와 반환 전송 모두 서명 기록입니다.
- **확정 보류.** 서명된 증거 없이 통보된 지급완료는 `EVIDENCE_INSUFFICIENT`
  이벤트와 함께 `PAYOUT_IN_PROGRESS`에 머뭅니다. 아직 지급되지 않은 것으로
  다루십시오. 실패도, 확정도 아닙니다.
- **정지.** 어떤 단계가 끝날 수 없을 때 — 수취 측이 응답하지 않거나,
  정산주체가 이체를 거부하거나 — 지급은 `EXCEPTION`으로 끝나고, `EXCEPTION`
  이벤트의 `error`가 사유를 알려 줍니다. 사람의 확인이 필요하며, 저절로
  재시도되지 않습니다.
- **다시 보내기.** 결과를 알아보려고 지급지시를 다시 보내지 마십시오 —
  `client.status(paymentId)`로 읽으십시오. 다시 만든 지급지시는 견적과 서명이
  새것이므로 다른 요청입니다. 같은 `Idempotency-Key`에는
  `409 idempotency_conflict`가, 같은 `payment_id`에는
  `409 duplicate_payment`가, 같은 전문을 다른 `payment_id`로 보내면
  `409 duplicate_source_message`가 돌아옵니다. `submitSwift()`는 세 경우 모두
  대신 처리해 기존 지급을 돌려줍니다.

SDK는 오류를 예외로 던집니다. `RemitApiError`(`status`, `code`)는 플랫폼의
거절과 SDK가 보내기 전에 멈춘 경우, `SwiftMessageError`(`code`, `field`)는 읽을
수 없는 전문, `SwiftMappingError`(`issues`)는 전문에 빠진 값, `SignerError`는
서명기의 실패입니다. 읽기 전용 클라이언트의 거절은 `TypeError`입니다. 아래
표의 코드는 `e.code`로 가릅니다.

연동 중에 만나는 오류와 조치:

| 코드 | 의미 | 조치 |
|---|---|---|
| `401 unauthorized` | API 키가 없거나 폐기됨 | 콘솔 연동 → API 키에서 발급 |
| `403 subscription_required` | 이 조직에 상품이 활성화되지 않음 | 콘솔 구독에서 활성화 |
| `400 unsupported_corridor`, `unsupported_trade_currency` (API를 직접 호출할 때) | 샌드박스는 VN → SG, USD만 견적 | 그 경로의 USD 금액으로 견적. SDK에서는 다른 경로·통화의 전문이 견적 전에 `SwiftMappingError`로 멈춥니다(`issues[].target`이 `corridor` 또는 `trade.amount`) |
| `409 quote_expired` | 견적이 `expires_at`을 지남(샌드박스 10분) | 새 견적을 받아 다시 작성 |
| `400 amount_mismatch` | 지급지시의 금액이 견적과 다름 | 인용한 견적으로 지급지시를 작성 |
| `400 invalid_signature`, `invalid_evidence_signature` | 서명이 등록된 키로 검증되지 않음 | `assertRegistered()` 실행, 콘솔 연동에서 기관의 검증 키 확인 |
| `400 travel_rule_incomplete` | 필수 당사자 항목 누락 | `required_travel_rule_fields`의 모든 항목을 제공 |
| `409 duplicate_payment`, `idempotency_conflict` | 이미 제출된 지급 | `status()`로 읽고, 다시 보내지 않음 |
| `409 key_mismatch`, `404 institution_unregistered` (`assertRegistered()`) | 클라이언트의 서명키가 등록된 키가 아니거나, 기관 ID가 틀림 | 활성화 때 등록한 키와 콘솔 구독 화면의 기관 ID를 사용 |
| `409 not_cancellable` | 이미 지급 사전승인되었거나 이미 끝난 지급 | 취소할 수 없음 — 지급을 추적 |
| `409 wrong_state` | 그 상태에서는 할 수 없는 조치(예: 질문이 없는 지급에 답변) | `status()`로 상태를 확인 |
| `400 invalid_manifest` | 일별 대사의 날짜나 목록이 형식에 맞지 않음 | UTC 날짜(`YYYY-MM-DD`)와 지급 ID 목록으로 제출 |
| `408 tracking_timeout` (SDK가 알림) | `track()`이 기다리는 동안 지급이 끝나지 않음 | 다시 호출해 이어서 따라감 — 지급은 계속 진행 중 |
| `409 duplicate_source_message` | 이 지급지시의 바탕이 된 전문에 이미 송금이 있음 — 같은 파일의 같은 거래이거나, UETR이 같거나, 다른 전문에 담긴 같은 지급. 응답의 `existing_payment_id`(`e.existingPaymentId`)가 그 송금을, `ground`(`e.ground`)가 근거를 알려 줌 | `submitSwift()`는 스스로 `already: true`로 답합니다. 이 오류가 귀행 코드까지 오는 것은 API를 직접 호출할 때, 또는 두 전문을 전혀 구분할 수 없을 때(`ground`가 `twin_undated`: 식별자와 내용이 같고 결제일이 없음)뿐입니다: 알려 준 송금을 읽고, 정말 다른 지급이라면 고유한 참조번호 — 다른 지시번호나 End-to-end ID — 를 주십시오 |
| `409 reference_reused` (보내기 전에는 SDK가, 두 프로세스가 겹치면 플랫폼이 알림) | 전문의 참조번호 — UETR, 없으면 지시번호·End-to-end ID와 결제일 — 가 이미 다른 지급에 쓰임 | 지급마다 고유한 UETR 사용. UETR이 없는 전문에 한해, 귀행이 다시 쓰려는 참조번호는 별도의 `{ paymentId }`로 보낼 수 있습니다 — [같은 전문은 같은 지급](#같은-전문은-같은-지급) 참조 |
| `multiple_transactions` (SDK가 알림, 전송 없음) | 전문에 지급이 여러 건인데 어느 건인지 주지 않음 | `parseSwiftMessages()`로 읽어 한 건씩 `submitSwift()`에 넘김 |
| `not_a_platform_answer` (SDK가 알림) | 귀행 시스템과 플랫폼 사이의 무언가가 대신 응답함 — 프록시 페이지, 리다이렉트, 게이트웨이의 502·503 오류 페이지 | 결과로 보지 않습니다. API까지의 경로를 확인한 뒤 다시 호출하십시오 — `submitSwift()`는 다시 불러도 지급이 둘이 되지 않습니다 |
| `quote_mismatch`, `bfi_key_mismatch` (SDK가 알림, 전송 없음) | 견적이 요청한 내용과 다르거나, 수취기관 암호화 키가 귀행이 기대한 키가 아님 | 아무것도 보내지 않음. API까지의 경로를 확인하고, 키가 교체되었다면 수취기관과 새 키의 thumbprint를 확인 |
| `409 evidence_not_ready` | 증빙은 `BENEFICIARY_CREDIT_CONFIRMED`부터 존재 | 그 상태를 기다림 — 취소된 지급에는 증빙이 없음 |

## 일별 대사

`client.submitDailyManifest(date, paymentIds)`는 귀행이 하루 동안 낸 모든
지급지시의 목록을 서명해 보냅니다. `date`는 UTC 기준 하루(`YYYY-MM-DD`)이며,
플랫폼은 귀 조직이 그 UTC 날짜에 만든 모든 송금 — 취소된 것을 포함해 상태와
무관하게 — 을 나열해 두 목록을 양방향으로 대조합니다. 판정은 `MATCHED`, 또는
한쪽에만 있는 ID를 담은 `DISCREPANT`입니다. 플랫폼은 Manifest와 판정을 함께
역서명하고,
`SHA-256("STONEHASH-MANIFEST-V1\n" + JCS({ manifest, verdict }))`를
앵커합니다. 같은 날짜로 다시 제출하면 이전 결과를 대체합니다.

포함증명이 줄 수 없는 완전성 통제입니다: 플랫폼에는 있는데 귀행 목록에서
빠진 지급도, 귀행 목록에는 있는데 플랫폼이 본 적 없는 지급도 모두 드러납니다.

## 샌드박스 시험 레버

결과는 지급의 데이터가 결정하므로, 플랫폼의 스위치 없이 귀행 시스템에서
각 경우를 만들어 볼 수 있습니다:

| 만들 상황 | 보낼 것 |
|---|---|
| 수취기관의 질문 | `20000.00` 이상의 무역금액 |
| 수취기관의 거절 | 이름에 `SANCTIONED`가 든 수취인 |
| 현지 지급 실패와 자금 반환 | `.13`으로 끝나는 금액 |
| 서명된 증거 없는 완료(확정 보류) | `.01`로 끝나는 금액 |
| 현지은행 참조번호 없는 서명 완료 | `.02`로 끝나는 금액 |
| 정산주체가 거부하는 이체(지급이 `EXCEPTION`에서 정지) | `50000.00`을 넘는 금액 — 그 지급의 질문에 답한 뒤 |

## 증빙 재검증

`verifyEvidencePackage()`는 플랫폼을 신뢰하지 않고 네 가지 독립 주장을
재검사합니다: 정준 패키지에 대한 논스 커밋, 패키지에 동봉된 Trust
Registry 스냅샷 기준의 요소 서명 전건, 같은 엔진으로 로컬 재계산한 6축
판정, 그리고 리프가 커밋과 일치해야 하는 비트코인 증명 파일. Java SDK의
`EvidenceVerifier.verify()`도 같은 네 가지를 재검사합니다 — 6축 판정은 같은
규칙을 Java로 옮긴 엔진이 다시 계산하며, 기준 엔진이 내는 답과 같은 벡터로
맞춰져 있습니다.

판정에는 여섯 축이 있습니다. 여섯 축이 모두 아래 값일 때에만 지급이
확정됩니다. 마지막 두 축은 샌드박스에서 상한이 걸려 있는데 — 데이터가
합성이기 때문이며 — 이 상한이 지급을 막지는 않습니다:

| 축 | 통과 값 | 뜻 |
|---|---|---|
| `integrity` | `VALID` | 모든 요소의 내용 digest가 서명된 것과 일치 |
| `issuer` | `VALID` | 모든 요소가 그것을 확인할 자격이 있는 기관의 서명 |
| `matching` | `MATCH` | 금액·당사자·참조번호가 은행·체인·지급 기록 사이에서 일치 |
| `completeness` | `COMPLETE` | 필수 요소 여섯 건이 모두 있음 |
| `regulatoryMapping` | `PRESENT` (샌드박스: `REVIEW_REQUIRED`) | 보고에 필요한 항목이 모두 있음 |
| `businessFinality` | `VERIFIED_BY_SOURCE` (샌드박스: `DEMO_ONLY`) | 지급이 원천 기관에 의해 확인됨 |

지급의 증거 등급은 완료가 얼마나 강하게 증명되었는지를 말합니다. `L1`은
서명 없는 통보(확정 보류), `L2`는 수취기관이 서명한 완료, `L3`는 여기에
현지은행 자신의 참조번호와 서명된 입금 확인이 더해진 것입니다.

## 지원 범위와 한계

- **판독기이지 검사기가 아닙니다.** 전문에서 지급 내용을 읽을 뿐, 스키마나
  시장 관행 규칙집에 비추어 검사하지 않습니다.
- **상태는 `pacs.002.001.10`과 JSON으로 돌려줍니다.** MT199, `camt.054`,
  `pacs.004`, `pain.002` 출력은 없습니다. 정산 후 반환은 사유 `RETURNED`의
  `RJCT`로 보고되고, `pain.001`에서 온 지급도 같은 `pacs.002`로 응답합니다.
- **자유형식 당사자는 관례대로 읽습니다.** `50K`와 `59`에서는 첫 줄을 이름,
  나머지를 주소로 봅니다. 고객원장 값이 이를 대체합니다.
- **XML은 엄격하게 읽습니다.** 입력은 4 MiB로 제한하고, 미리 정의된 다섯
  엔터티와 숫자 참조만 해석합니다. 바이트는 전문이 선언한 인코딩(선언이
  없으면 UTF-8)으로 읽고 추측하지 않습니다. 한 번만 나올 수 있는 요소가 두 번
  나오면 전문을 거절하며, 다른 네임스페이스의 요소를 전문의 요소로 읽지
  않습니다.
- **TypeScript SDK(Node 22.18 이상)와 Java SDK(Java 11 이상).** TypeScript
  SDK는 Node가 직접 실행하는 소스이고, Java SDK는 외부 의존성이 없는 jar입니다
  (OpenJDK 11 · 17 · 21에서 시험). 두 SDK는 같은 기준 벡터로 맞춰져 있습니다.
  Java SDK에는 명령으로 부르는 서명기가 아직 없습니다. 증빙 재검증에서 Java
  SDK는 플랫폼이 만들지 않는 형태 — 시간대 없는 시각, ES256이 아닌 키가 든
  Trust Registry — 를 해석하지 않고 그 검사를 실패로 보고합니다. .NET용 SDK는
  아직 없습니다. 그
  밖의 언어로 된 시스템은 [API 레퍼런스](#api)의 `POST /v1/settlements` 요청
  본문으로 직접 연동하며, 전문 판독과 변환은 두 SDK에만 있습니다.

샌드박스 송금 경로는 끝까지 합성입니다: 모의 USDC, 사설 테스트 체인, 모의
상대기관 — 사설 체인의 앵커는 **공개 검증이 불가**하며, 라이브 배포는
비트코인에 앵커합니다. 샌드박스 증거는 스스로 그렇게 말합니다
(`dataMode: SYNTHETIC`). `businessFinality` 축이 `DEMO_ONLY`로 읽히는
이유이기도 합니다 — 숨기는 대신 말합니다. 모의 수취기관은 수락과 지급
사전승인, 지급완료에 서명하며, 질문과 거절은 플랫폼이 받은 그대로
기록됩니다.

트래블룰 메시지는 당사자 표기에 IVMS 101 이름을 쓰지만, IVMS 101의 모든 제약에
대해 검사하지는 않습니다. LEI는 `LEIX`로 표기합니다. 그 밖의 등록번호는
등록기관을 밝히지 않은 채 등록기관 식별자로 전달되고, 당사자의 국가 하나가
주소 국가와 등록 국가를 겸하며 — 전문에 국가가 없으면 거래은행의 BIC에서
가져온 값일 수 있고, 변환 내역에 *추정*(`inferred`)으로 표시됩니다 — 주소는 한 줄로
전달됩니다. 운영 환경의 상대 기관은 그보다 많은 것을 요구할 것이고, 그때는
당사자 데이터가 이를 실어야 합니다.
