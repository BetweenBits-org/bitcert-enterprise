# stonehash-attest-remit — Java bank SDK for cross-border settlement

The bank's side of the corridor, for a bank whose systems are Java: one jar,
Java 11 or later, no third-party dependency. It is called from your own
service's source:

    RemitClient client = RemitClient.builder()
        .core(core).apiKey(apiKey)
        .institution(institutionId, "Your bank")
        .signer(Signers.external(publicKeyPem, hsm::sign))    // the key stays in your HSM
        .build();

    // the MT103, pacs.008 or pain.001 your payment system already writes
    SwiftSubmission sent = client.submitSwift(message);
    String pacs002 = client.statusReport(sent.paymentId());

| | |
|---|---|
| `release/stonehash-attest-remit-0.1.0.jar` | The library. Put it on your service's classpath, or publish it to your internal repository with the `.pom` beside it (`com.stonehash:stonehash-attest-remit:0.1.0`). It is not on a public repository. `SHA256SUMS` lists the three files |
| `release/…-sources.jar` | The sources, for your IDE |
| `src/main/java` | The same sources as a tree. `RemitClient` is where to start reading; `swift/` holds the message readers, the conversion table and the `pacs.002` report |
| `examples/` | `SwiftMessagePayment`, `OwnDataPayment`, `HsmSignerPayment` — each a complete program. `examples/spring/` — the client as a Spring bean, a service that sends a message, a webhook controller |
| `src/test` | The tests, and the reference vectors they are held to (`src/test/resources/golden`) |
| `build.sh`, `run-tests.sh` | Rebuild the jar from the sources and run every test — a JDK 11 or later, and nothing else |
| `packages/attest-remit/samples/` | Sample messages (pacs.008, pain.001, MT103) and a customer-master extract — synthetic: fictional companies, fictional institution codes |

The guide is on the developer hub of the deployment this was downloaded
from, under **Cross-border Settlement**; choose **Java** on any example.

## What it does

- **From a SWIFT message** — `submitSwift(message)`: read, convert, quote,
  sign, submit in one call, and safe to repeat: the same payment handed over
  twice is recognised and not sent again, whatever payment id is passed with
  it. The platform holds the same line when it accepts — one message, one
  settlement — so a second instruction for a message is refused
  (`duplicate_source_message`), and the refusal names the settlement that
  stands for it (`RemitApiException.existingPaymentId()`). `inspectSwift`
  shows the conversion without sending; `swiftStatus` and `statusReport` give
  the outcome as an ISO 20022 status code and a `pacs.002`.
- **From your own data** — `quote` → `buildInstruction` → `submit` → `track`.
- **Signing with a key that stays in an HSM or KMS** — `Signers.external`.
  Every signature the signer returns is verified against its public key
  before it is used, so a wrong slot or key label fails on your side, with a
  message that says so.
- **Travel Rule mode B** — the party data encrypted on your side to the
  beneficiary institution's key; the platform relays a ciphertext it cannot
  read.
- **Reading only** — `RemitClient.builder()….readOnly()` holds no key; it
  follows payments and cannot authorise one.
- **Webhooks** — `verifyWebhook(body)` returns the envelope only when the
  platform's signature on it verifies.
- **Re-verifying the evidence** — `EvidenceVerifier.verify(client.evidence(id))`
  runs the reference verifier's four checks on your own machine, with no
  trust in the platform: the commitment over the package, every element
  signature against the Trust Registry snapshot inside it, the six-axis
  verdict re-computed by the same rules, and the Bitcoin proof file.
- **Your network's way out** — `proxy(host, port)` for an outbound proxy, or
  `httpClient(yours)` for a `java.net.http.HttpClient` of your own: a proxy
  that wants credentials, a private certificate authority, a client
  certificate. An answer that is not the platform's own — a proxy's error
  page, a login wall, a redirect — is never taken for an outcome
  (`not_a_platform_answer`).

One `RemitClient` is safe to share between threads; make one and keep it.

## What is in the jar that a bank does not call

Three classes are public for the platform's own back end, not for a bank's
integration. Nothing in the sections above needs them:

- `Rules` — the six-axis rules as the side that *produces* verdicts runs
  them: the reference engine's whole answer, every finding with its sentence
  and its fields, also for evidence of a shape `EvidenceVerifier` declines to
  read. To re-check a verdict, use `EvidenceVerifier`: it is stricter on
  purpose.
- `Conventions` — the byte conventions on their own: canonical JSON, what is
  signed and what is hashed for an event and for an evidence element, the
  evidence-package commitment, an ES256 signature as it travels.
- `TravelRule` — Travel Rule mode A, in which the platform shapes and
  encrypts the party data a bank submitted: the required-field check, the
  IVMS 101 message, the encryption and its key derivation. (Mode B, above,
  is done for you by `RemitClient`.)

They are in this jar so that each convention has one implementation, used by
both sides of the wire.

## How it is held to the TypeScript SDK

The platform's reference SDK is the TypeScript one. This SDK is held to it by
vectors generated from that code (`src/test/resources/golden`): canonical
JSON, the bytes that are signed and their digests, signatures made there and
verified here, the reading of every sample message, the conversion table, the
status codes and the `pacs.002`, the verdict on proof files sound and
tampered with, the six-axis rules — every axis and every finding, for evidence
sound, changed and malformed — and what `submitSwift` decides — sent, recognised as sent
already, or refused — step by step through the recorded situations, down to
what the ledger is asked for and what is posted. The same message handed to
either SDK names the same payment, and each recognises a payment the other
submitted: several of those situations start from a ledger the other SDK
wrote, and the two were run against one sandbox ledger in turn.

The three platform-side classes are held the same way to the platform's own
TypeScript code — the whole verdict for each of several hundred documents,
the signature pass, every policy check and digest, the reading of a
timestamp, the bytes signed and the commitments, the Travel Rule message —
and in the direction no stored vector can hold: what this SDK signs and
encrypts is verified and opened by that code (`tools/check-java-made.mjs`),
and `Rules` is run side by side with the reference engine on settlements
changed at random (`tools/diff-fuzz-rules.mjs`).

The tests run on OpenJDK 11, 17 and 21.

## What this version does not do

- **Evidence of a shape the platform does not produce is not interpreted.**
  A timestamp without a time zone, a Trust Registry snapshot that holds a key
  other than ECDSA P-256 or the same institution twice, text where a list
  belongs: the check that would have to read it fails, with the reason,
  rather than reading it the way one runtime happens to. A proof file of
  another form than a settlement's — a daily row, an original inscribed in
  the witness — is reported as `NOT_RUN`, never as passed. Neither SDK
  confirms that the anchor transaction is in a block of a public chain.
- **No command signer.** Where the TypeScript SDK can run a signing tool as a
  command, call your tool from inside `Signers.external`.
- **An XML message is read in UTF-8, UTF-16 or a Latin-1 family encoding.**
  Another encoding named in the XML declaration is refused rather than
  guessed at.

---

은행 시스템이 Java인 은행을 위한 은행 측 SDK입니다. jar 하나, Java 11 이상,
외부 의존성 없음 — 귀행 서비스의 소스에서 호출합니다. `release/`의 jar를
classpath에 두거나, 같은 폴더의 `.pom`과 함께 사내 저장소에 올려 의존성으로
선언하십시오(공개 저장소에는 올라 있지 않습니다). 안내서는 이 파일을 내려받은
배포의 개발자 허브 — **국경간 송금** — 에 있으며, 예제마다 **Java**를 고를 수
있습니다. `examples/spring/`에 Spring 서비스에 넣는 예가 있습니다.

같은 전문은 어떤 지급 ID를 주더라도 한 지급입니다 — SDK가 원장을 정확 조회로
먼저 확인하고, 플랫폼도 접수 때 같은 전문의 두 번째 지급지시를
`duplicate_source_message`로 거절합니다(기존 지급은 `existingPaymentId()`).
증빙 재검증(`EvidenceVerifier.verify()`)은 기준 검증기의 네 검사 — 논스 커밋,
증거요소 서명, 6축 판정, 비트코인 증명 파일 — 를 Java에서 다시 수행합니다.
플랫폼이 만들지 않는 형태(시간대 없는 시각, ES256이 아닌 키가 든 Trust
Registry)는 해석하지 않고 그 검사를 실패로 보고합니다. 표본 전문은 모두 합성
데이터입니다.

`Rules`, `Conventions`, 그리고 `TravelRule`의 공개 메서드는 은행 연동용이
아닙니다. 플랫폼 백엔드가 쓰는 것으로 — 6축 판정의 생산, 서명·해시·
커밋 규약, Travel Rule A 모드(플랫폼이 당사자 정보를 정형화·암호화) — 규약마다
구현을 하나만 두려고 이 jar에 함께 들어 있습니다. 은행 연동에는 필요하지
않으며, 판정을 다시 확인할 때는 일부러 더 엄격하게 만든 `EvidenceVerifier`를
쓰십시오.
