# Cross-border Settlement

A bank-controlled settlement rail: your bank authorises a payment, the
platform relays the Travel Rule message, a licensed settlement entity moves
USDC, the receiving institution pays out locally — and every hop leaves a
signed, independently re-verifiable record.

You integrate by calling the SDK from your own system's source. Hand it the
message your payment system already writes — an MT103, a pacs.008 or a
pain.001 — and it becomes a signed settlement instruction; the outcome comes
back as an ISO 20022 status report (pacs.002). The message's own references,
the UETR first among them, travel with the payment into the signed evidence,
so your operators find it by the number your own system printed. Your
existing message output and status handling stay as they are, which is what
keeps the change to the bank's system small.

This is a conversion of message formats at the edge of your system. It is
not a connection to the Swift network, and it does not check a message
against a network rulebook or say whether a network would accept it.

## What you need

What the code below needs, and where each comes from. The API key, the
institution id and the signing key come from the [console](../console/):

| What (its name in the code below) | Where it comes from |
|---|---|
| Platform address `STONEHASH_CORE` | This deployment: `{{ORIGIN}}` |
| API key `STONEHASH_API_KEY` | Console, **Integrate → API keys** |
| Institution id `STONEHASH_INSTITUTION` | Console, **Subscriptions** — shown once Cross-border Settlement is active |
| Signing key `key` · `signer` | The private half of the public key registered at activation. If the console created the key, the `stonehash-remit-signing-key.pem` it downloaded then; in production, the key inside your HSM |
| SDK | [attest-remit.tar.gz](./download/attest-remit.tar.gz) · [SHA-256](./download/attest-remit.sha256) |
| SDK (Java) | [attest-remit-java.tar.gz](./download/attest-remit-java.tar.gz) · [SHA-256](./download/attest-remit-java.sha256) |

The SDK is not on a package registry. Import
`packages/attest-remit/src/index.ts` by path from where you unpacked it:
there is no install step, no build and no third-party dependency (Node 22.18
or later). Sample messages come with it, under
`packages/attest-remit/samples/`. If your service is checked with `tsc`,
turn on `allowImportingTsExtensions` (with `noEmit`): the SDK is imported by
its `.ts` path.

If your systems are Java, the SDK is one jar — in the extracted archive,
`sdks/attest-remit-java/release/stonehash-attest-remit-0.1.0.jar` (Java 11 or
later, no third-party dependency). It is not on a public repository: put it on
your service's classpath, or publish it to your internal repository with the
`.pom` beside it and declare `com.stonehash:stonehash-attest-remit:0.1.0`. The
examples on this page can be read in TypeScript or in Java, with the switch
above each; where the text names a call in TypeScript, [In Java](#in-java)
gives its Java name.

## Send a payment

**From the message.** Hand over the message your payment system wrote, as it
is. Reading, converting, quoting, signing and submitting are one call:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { RemitClient, type PartySupplement } from './packages/attest-remit/src/index.ts';

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: 'Your Bank',                      // your registered name — it goes into your signatures as written
  key: createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8')),
});

// The message exactly as your system wrote it — here, a sample from the SDK
const message = readFileSync('packages/attest-remit/samples/mt103.sample.txt');
// Your customer master — here, the sample extract (debtor account → what the message lacks)
const customerMaster = new Map<string, PartySupplement>(Object.entries(JSON.parse(
  readFileSync('packages/attest-remit/samples/parties.sample.json', 'utf8'))));

const sent = await client.submitSwift(message, {
  // what the message does not carry, from your customer master
  supplement: (payment) => customerMaster.get(payment.debtor.account ?? ''),
});
console.log(sent.paymentId, sent.state, sent.already);

const status = await client.swiftStatus(sent.paymentId);    // right after acceptance: { code: 'ACTC', final: false, … }
const report = await client.statusReport(sent.paymentId);   // the pacs.002, as XML
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
    // your registered name — it travels with every signature
    .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
    .signer(Signers.fromPkcs8Pem(
        Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
    .build();

// the message as your system wrote it — here, a sample from the SDK
byte[] message = Files.readAllBytes(
    Path.of("packages/attest-remit/samples/mt103.sample.txt"));
// your customer master: here one sample row, debtor account → what the message lacks
Map<String, PartySupplement> customerMaster = new HashMap<>();
customerMaster.put("VN-ACC-000777",
    new PartySupplement().debtorRegistrationNumber("0312345678"));

SwiftSubmission sent = client.submitSwift(message, new SwiftOptions()
    // what the message lacks comes from the customer master
    .supplement(payment -> customerMaster.get(payment.debtor().account())));
System.out.println(sent.paymentId() + " " + sent.state() + " " + sent.already());

SwiftStatus status = client.swiftStatus(sent.paymentId());   // ACTC on acceptance
String report = client.statusReport(sent.paymentId());       // pacs.002 (XML)
System.out.println(status.code() + " " + status.isFinal());
System.out.println(report);
```

The first run prints `PAY-… BANK_AUTHORIZED false`, `ACTC false` and the
pacs.002. The payment proceeds on its own after acceptance, so follow the
outcome with `track()` or a webhook
([Learning the outcome](#learning-the-outcome-states-tracking-and-webhooks)).
Run it again with the same message and no second payment is made:
`sent.already` comes back `true`, with the state the payment has reached.
Replace the two lines that read the samples with your own message and your
customer-master lookup. `inspectSwift()` returns the
conversion table without sending, and `instructionFromSwift()` returns the
signed instruction without submitting it.

**From your own data.** Without a message, build the instruction from an
amount, the two companies and your own reference — four steps: quote, build
and sign, submit, follow:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { RemitClient, verifyEvidencePackage } from './packages/attest-remit/src/index.ts';

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: 'Your Bank',                      // your registered name — it goes into your signatures as written
  key: createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8')),
});
await client.assertRegistered();                    // is this the key the registry knows?

const quote = await client.quote('10000.00');       // the trade amount, in USD
const { paymentId, body } = await client.buildInstructionAsync(quote, {
  debtor:   { name: 'Importer Co', country: 'VN', address: '12 Le Loi, HCMC',
              registration_number: '0312345678', account: 'VN-ACC-1' },
  creditor: { name: 'Exporter Pte', country: 'SG', account: 'SG-ACC-9', bank: 'Demo Payout Bank' },
}, {
  invoiceRef: 'INV-2026-0457',
  instructionRef: 'OUT-2026-000123',                // your own reference for this instruction
  review: { kybPolicyVersion: '2026.3', regulatorReportRef: 'RPT-0457', approvedByRole: 'Trade Operations' },
});
await client.submit(body);                          // everything in it is already signed
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
    // your registered name — it travels with every signature
    .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
    .signer(Signers.fromPkcs8Pem(
        Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
    .build();
client.assertRegistered();                           // is this the registered key?

Quote quote = client.quote("10000.00");              // the trade amount (USD)
TradeParties parties = TradeParties.of(
    new TradeParties.Debtor().name("Importing Co.").country("VN")
        .address("12 Le Loi, HCMC").registrationNumber("0312345678")
        .account("VN-ACC-1"),
    new TradeParties.Creditor().name("Exporting Co.").country("SG")
        .account("SG-ACC-9").bank("Demo Payout Bank"));
Instruction instruction = client.buildInstruction(quote, parties,
    new InstructionOptions()
        .invoiceRef("INV-2026-0457")
        .instructionRef("OUT-2026-000123")           // your own reference for it
        .review(new InstructionOptions.Review()
            .kybPolicyVersion("2026.3")
            .regulatorReportRef("RPT-0457")
            .approvedByRole("Trade Operations")));
client.submit(instruction);                          // already signed, all of it
System.out.println(instruction.paymentId());

Settlement settled = client.track(instruction.paymentId(),
    (state, view) -> System.out.println("state " + state));
if ("EVIDENCE_ANCHORED".equals(settled.state())) {
    // recomputed by the Java SDK: commitment, element signatures, six-axis verdict, Bitcoin proof file
    EvidenceReport report =
        EvidenceVerifier.verify(client.evidence(instruction.paymentId()));
    report.checks().forEach(System.out::println);
}
```

On either path the instruction carries three evidence elements your bank
signs (`bankInstruction`, `bankApproval`, `commercialDocs`) and its
payment-release authorisation, in the exact form the six-axis engine
evaluates. The `review` values are your bank's own conclusions — its KYB
outcome and policy version, its regulatory report reference, the approver's
role — and they are signed with your key, so set them from your approval
system (`submitSwift()` takes the same option); the defaults exist for a
first sandbox run. `institutionName` goes onto your signatures as written,
and the signed events of the evidence keep it that way, so use your
registered name; the verified signer of each evidence element is recorded
under the name the Trust Registry holds for your institution.

## In Java

The Java SDK implements the same corridor under the same conventions. The same
message becomes the same payment id in either SDK, and each recognises a
payment the other has submitted. The text names calls as TypeScript has them;
these are the ones whose name or shape differs in Java:

| In the text (TypeScript) | Java |
|---|---|
| `new RemitClient({ … })` | `RemitClient.builder()` … `.build()` |
| `key` | `.signer(Signers.fromPkcs8Pem(pem))` |
| `signer: { publicKey, sign }` | `.signer(Signers.external(publicKey, sign))` |
| `commandSigner({ publicKey, command })` | None — call your signing tool inside the function given to `Signers.external` |
| `buildInstructionAsync()` | `buildInstruction()` — everything is signed when it returns |
| `new RemitClient({ …, readOnly: true })` | `RemitClient.builder()` … `.readOnly().build()` |
| `travelRule: 'B'` · `beneficiaryKeys` | `.travelRule(InstructionOptions.TravelRule.B)` · `.beneficiaryKey(id, thumbprint)` |
| `submitSwift(message, { index })` · `{ paymentId }` · `supplement` | `submitSwift(message, new SwiftOptions().index(n))` · `.paymentId(id)` · `.supplement(…)` |
| `parseSwiftMessages(message)` | `Swift.parseAll(message)` |
| `track(paymentId, { timeoutMs, onState })` | `track(paymentId, timeout, interval, onState)` |
| `verifyWebhook(body)` → `{ valid, envelope }` | `verifyWebhook(body)` → an `Optional`: the verified envelope, or empty |
| `swiftStatusOf(view)` · `buildPacs002(view)` | `Swift.statusOf(settlement.json())` · `Swift.buildPacs002(settlement.json())` |
| `verifyEvidencePackage()` → `{ verified, checks }` | `EvidenceVerifier.verify()` → an `EvidenceReport`: `verified()`, and `checks()` one by one |
| `RemitApiError` · `SwiftMessageError` · `SwiftMappingError` | `RemitApiException` · `SwiftMessageException` · `SwiftMappingException` — each a `RemitException`, with the code in `code()` |
| `SignerError` | A `RemitException` whose code is `signer_failed` or `signature_unverified` |
| The read-only client's `TypeError` | `IllegalStateException` |

One `RemitClient` is safe to share between threads: keep one per service. In a
Spring service that is one bean — `examples/spring/` in the download has a
configuration that holds the client and the HSM signer as beans, a service
that takes a message and sends it as a payment, and a controller that verifies
and receives webhooks. An instruction that lacks a required party field is
stopped by the Java SDK before anything is signed, as `travel_rule_incomplete`.

## Messages that are read

| Message | What is accepted |
|---|---|
| **MT103** | The full FIN form (blocks 1 to 5) or the text block alone — as `{4:` … `-}` or as the field lines from `:20:` on — CRLF or LF; several messages in one file, one after another or separated by `$` as a batch export writes them (each then needs its header blocks). Ordering customer as `50A`, `50F` or `50K`; beneficiary as `59`, `59A` or `59F`; the UETR from block 3 field `121`. |
| **pacs.008** | Any version (`pacs.008.001.xx`). The bare `Document`, the document inside an envelope beside a Business Application Header, or a wrapper around several documents; default namespace or prefixes. |
| **pain.001** | Any version (`pain.001.001.xx`). The debtor is read from the payment block, the creditor from each transaction. |

A message that carries several payments is never read as "the first payment
in it". `parseSwiftMessages(message)` returns every payment it holds; hand
each one to `submitSwift(payment)` (`submitSwift(message, { index })` does
the same; `index` counts from 0).

The following are refused with the reason, never guessed at:

- **What is not a customer credit transfer.** An MT202, a `pacs.009`, an
  MT102, the cover of an MT103. A text block without its header blocks has
  to *be* an MT103, not resemble one: every mandatory field present, no
  field of another message type, none written twice. A file that holds such
  a message among payments is refused whole rather than read in part.
- **A payment of another route or currency.** The sandbox corridor is VN to
  SG and trades are denominated in USD. A payment whose ordering customer is
  outside VN, or whose beneficiary or beneficiary's bank is outside SG, is
  refused, and so is one with neither its instructed nor its interbank
  amount in USD. A payment is not quoted on this corridor because its
  currency happens to fit.
- **A party identified as a private person.** This corridor carries payments
  between companies, and both parties are sent as legal persons. A message
  that identifies a party as a private person — a private identification, a
  date of birth, a passport or national identity number — is refused.
- **A test message.** One marked `23B` `CRTS`, with a test and training BIC
  in the header, or for a pilot service is taken with a test key
  (`sk_test_`) only.
- **XML with a document type declaration.** No DTD or entity is ever
  processed.
- **An encoding or a structure the reader cannot be sure of.** XML is read
  as UTF-8, as UTF-16 with a byte-order mark, or in the encoding its
  declaration names when that is ISO-8859-1, windows-1252 or US-ASCII; any
  other declared encoding is refused, and so are bytes that are not valid in
  the encoding they claim. So are a `Document` that holds two messages, a
  message standing outside a `Document` beside others that are inside one, a
  charge bearer that is none of `DEBT`, `CRED`, `SHAR` and `SLEV`, and an
  amount written with a comma. In an MT103, a field the payment is read from
  may not be empty, a one-line field may not run on to a second line, `23B`
  is one of `CRED`, `CRTS`, `SPAY`, `SPRI` and `SSTD`, the value date in
  `32A` is a calendar date, and block 3 carries field `121` once.

## From message to instruction

Every value of the instruction comes from a named place in the message.
`inspectSwift(message)` returns, for your own message, where each value came
from (`fields`), what is missing (`issues`) and what is not carried
(`unmapped`) — nothing is signed and nothing is sent. The sources, by
family:

| Instruction | pacs.008 | pain.001 | MT103 |
|---|---|---|---|
| Trade amount (USD) | The smaller of `InstdAmt` and `IntrBkSttlmAmt` when both are in USD; else the one that is | `Amt/InstdAmt`, else `Amt/EqvtAmt/Amt` | The smaller of `33B` and `32A` when both are in USD; else the one that is |
| Debtor name | `Dbtr/Nm` | `PmtInf/Dbtr/Nm` | `50a` name line, `50F` line `1/` |
| Debtor country | `Dbtr/PstlAdr/Ctry`, else `CtryOfRes` | the same | `50F` line `3/`, `77B` `/ORDERRES/` |
| Debtor address | `Dbtr/PstlAdr` | the same | `50a` address lines |
| Debtor registration number | `Dbtr/Id/OrgId`: `LEI`, else `Othr/Id` | the same | `50F` party identifier or line `6/` |
| Debtor account | `DbtrAcct/Id` | `PmtInf/DbtrAcct/Id` | `50a` `/account` line |
| Creditor name | `Cdtr/Nm` | the same | `59a` name line, `59F` line `1/` |
| Creditor country | `Cdtr/PstlAdr/Ctry`, else `CtryOfRes` | the same | `59F` line `3/`, `77B` `/BENEFRES/` |
| Creditor account | `CdtrAcct/Id` | the same | `59a` `/account` line |
| Creditor's bank | `CdtrAgt/FinInstnId`: `Nm`, `BICFI` and the clearing-system member id — each that is given | the same | `57A`, `57D`, else the receiver |
| Invoice reference | `RmtInf/Strd/RfrdDocInf/Nb` of a document typed as an invoice (`CINV` …) or not typed, or `/INV/` in `Ustrd` | the same | `70` `/INV/` |
| Purpose | `Purp` | the same | `26T` |
| Instruction reference | `PmtId/InstrId`, else `GrpHdr/MsgId` | `PmtId/InstrId`, else `PmtInfId` | `20` |
| End-to-end id | `PmtId/EndToEndId` | the same | `70` `/ROC/` |
| UETR | `PmtId/UETR` | `PmtId/UETR` | block 3, field `121` |

- **The amount** is what the beneficiary is owed. Where the message states
  both an instructed and an interbank amount in USD, that is the smaller of
  the two: with the charges on the beneficiary or shared, the interbank
  amount is the instructed one less what was already deducted, and with the
  charges on the debtor it may include charges prepaid for the receiving
  bank.
- **A BIC is not taken for a registration number.** A party identified only
  by a BIC needs its registration number from your customer master.
- **A country** that the message does not state is taken from the party's
  agent's BIC, and the conversion table marks it *inferred*.
- **The invoice reference**, when there is none, is the end-to-end id, then
  the first line of the remittance information. A purchase order or a credit
  note among the referred documents is not taken for the invoice.
- **What is not carried** is listed, never dropped silently: the charge
  bearer and the charges (the platform fee is added to the funding leg and
  the beneficiary is paid the full trade amount), the exchange rate (fixed
  by the quote), the value date (settlement starts when the instruction is
  accepted), intermediary agents, the other of the two amounts, a second
  invoice and referred documents that are not invoices, and regulatory
  reporting.

**What the message does not carry.** A free-format MT103 has no field for
the debtor's registration number, so it comes from your customer master.
`supplement` is the values to fill in, or a lookup (it may be asynchronous)
that receives the parsed payment and returns them. Creditor fields, the
invoice reference and the purpose are filled in the same way:

```json
{ "debtor": { "registration_number": "0312345678" } }
```

A value given this way is used instead of the message's, because a customer
record is firmer than a free-text line; the conversion table marks it
*supplied*. When something required is still missing, nothing is quoted,
signed or sent: the `issues` of the `SwiftMappingError` name each
missing value, the element of the message that would have carried it, in
the message's own vocabulary, and how to supply it (`fix`).

## One message, one payment

The payment id is derived from the message's own identity and from nothing
else — the UETR when it has one; otherwise its message, instruction and
end-to-end ids together with its value date. So the same payment handed over
twice is recognised: a retry, a re-export the next day with a new creation
time, a payment retried alone after going out in a batch, the same MT103
with and without its header blocks. Each finds the settlement that already
exists, and nothing is sent a second time. For a message with a UETR the id
begins with the UETR's own first group — `PAY-3f1c9a52-…` for
`3f1c9a52-7b0e-…` — so the two are matched by eye.

Whether a payment is in the ledger already is decided where it can be
decided for certain. Before anything is sent, the SDK looks up — exactly, not
by a part of a number — the settlement under the payment's id and the
settlement that holds its UETR. The rest is the platform's to decide when the
instruction arrives: one message is one settlement there, whatever the
payment id, also when two of your processes hand the same payment over at the
same moment. It recognises the same transaction of the same file, the same
UETR, and the same payment in another message — the same instruction and
end-to-end identifiers, value date and content — however short the
reference. The one that came second is refused with
`409 duplicate_source_message`, which names the settlement that stands, and
`submitSwift()` returns that settlement with `already: true`.

Two payments that read alike are still two. A file with two instalments —
the same end-to-end id, amount and parties — makes two settlements; written
out again, each of its transactions is matched to one of the two, never both
to the same one, so an instalment that was not sent the first time is paid,
not reported as paid. A payment that carries neither a UETR nor an
instruction or end-to-end id of its own is recognised by its message id and
its position in the message: the same file exported again is the same
payment, and under another message id it is a new one. A message that states
no value date cannot be told from the next one like it: a second such
message is refused (`duplicate_source_message`), not taken for a repeat.

A reference that comes back on a *different* payment — the same UETR with
another amount, other parties, another account or another invoice — is not
taken for a repeat. Nothing is sent, and the SDK reports `reference_reused`,
so a payment is neither duplicated nor lost without a word. Without a UETR a
payment is the same payment only when its instruction and end-to-end
identifiers, its value date and its content are all the same. The UETR is
what makes a payment recognisable beyond doubt; carry it where your system
can. A UETR that is there but is not a UUID refuses the message: a payment
is not given another identity because its UETR could not be read.

A payment id of your own (`{ paymentId }`) is a name and nothing more: it
does not make a second payment out of a message that already has a
settlement. And a settlement that ended without paying — cancelled, returned
— still stands for its message: to pay after all, send the payment as a new
message with a reference of its own — another instruction or end-to-end id.
(A new UETR alone separates it only from a settlement that has a UETR.)

The instruction your bank signs carries a reference to the message it was
made from: its type, its references, the SHA-256 of the file exactly as
your system wrote it, and a digest of the payment's content — the amounts,
both parties' names and accounts, the payment's own identifiers, its invoice
references and its remittance text. That ties the settlement to the message
without the message itself ever leaving your system. For the value to equal the SHA-256
of the file you keep, hand over the bytes your system wrote, not text
decoded from them. In the console, the settlement
ledger's search finds a payment by its UETR, instruction id, end-to-end id
or message id, and a payment's tracking view shows the message type, UETR
and your instruction id.

## Signing and your HSM

Two detached-signature conventions, one curve (ES256, raw `r‖s`,
base64url), both over RFC 8785 (JCS) canonical bytes:

- **Events** — authorisations, cancellations, answers, manifests, and the
  webhooks the platform signs: `"stonehash:remit:event:v1\n" + JCS(payload)`.
- **Evidence elements** — the element minus its unsigned fields, prefixed
  `"stonehash:evidence:sig:v1\n"`. Each element also declares a content
  digest under `"stonehash:evidence:digest:v1\n"`, which the platform
  recomputes.

The SDK implements both. The key itself can stay in your HSM or KMS: give
the client a `signer` instead of a `key`. The signer receives the exact
bytes and returns an ECDSA P-256 signature over SHA-256 — raw or DER, both
are accepted — and the SDK verifies it against the public key before using
it, so a wrong slot or key label fails on your side with a clear message.

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { RemitClient } from './packages/attest-remit/src/index.ts';

// A key in a file stands in for the HSM here — in production, sign() calls your HSM or KMS
const hsmKey = createPrivateKey(readFileSync('stonehash-remit-signing-key.pem', 'utf8'));

const client = new RemitClient({
  core: process.env.STONEHASH_CORE!, apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!, institutionName: 'Your Bank',
  signer: {
    // the public key registered in the console (PEM, or SPKI DER in base64)
    publicKey: createPublicKey(hsmKey).export({ type: 'spki', format: 'pem' }).toString(),
    // an ECDSA P-256 / SHA-256 signature over exactly the bytes received
    sign: (bytes) => sign('sha256', bytes, hsmKey),
  },
});
await client.assertRegistered();                    // is this the key the registry knows?
```
```java
import com.stonehash.attest.remit.*;
import java.nio.file.Files;
import java.nio.file.Path;

// a file key stands in for the HSM — in production the lambda calls your HSM or KMS
KeySigner hsmKey = Signers.fromPkcs8Pem(
    Files.readString(Path.of("stonehash-remit-signing-key.pem")));

RemitClient client = RemitClient.builder()
    .core(System.getenv("STONEHASH_CORE"))
    .apiKey(System.getenv("STONEHASH_API_KEY"))
    .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
    .signer(Signers.external(
        // the public key registered in the console (PEM, or base64 SPKI DER)
        hsmKey.publicKeySpkiBase64(),
        // ECDSA P-256 / SHA-256 over exactly the bytes given
        bytes -> hsmKey.sign(bytes)))
    .build();
client.assertRegistered();                           // is this the registered key?
```

`assertRegistered()` returns nothing when the key is the registered one and
throws `key_mismatch` when it is not. With a signer, build instructions with
`submitSwift()` or
`buildInstructionAsync()`; the synchronous `buildInstruction()` is for a key
held in the process. Where your signing tool is invoked as a command —
OpenSSL, a PKCS#11 tool, a KMS wrapper — `commandSigner({ publicKey,
command })` makes the same signer for you. The bytes go to the command's
standard input and the signature is read from its standard output (raw or
DER; binary, base64 or hex). `command` is an argument list, run without a
shell — for example `['openssl', 'dgst', '-sha256', '-sign', keyPath]`.

A system that only follows payments — monitoring, operations, reconciliation
— needs no signing key at all. `new RemitClient({ …, readOnly: true })`
reads `status()`, `swiftStatus()`, `statusReport()`, `track()` and
`evidence()` without a key and refuses whatever would sign or send.

## Travel Rule: mode A and mode B

The receiving institution requires eight fields before it will accept a
payment: the debtor's name, country, address and registration number, and
the creditor's name, country, account and bank. The quote lists them
(`required_travel_rule_fields`), and an instruction that lacks one is
refused before anything is stored.

- **Mode A** (the default). The party fields go to the platform in
  `compliance_payload`. The platform shapes the message, encrypts it to the
  receiving institution's key, and keeps the ciphertext and its digest; the
  party fields are removed from the stored request once the message is
  encrypted.
- **Mode B** (`travelRule: 'B'`). The SDK shapes the same message and
  encrypts it on your side, to the institution's public key published at
  `GET /v1/remit/meta`. What leaves your system is the ciphertext, its
  digest, and your signed statement that the required fields are present.
  That statement names the message it is about — its digest and the SHA-256
  of the ciphertext — so another ciphertext cannot be put in its place; the
  platform refuses an instruction whose statement and message do not match.
  The platform relays a message it cannot read; the receiving institution
  decrypts it and checks the fields for real. With `beneficiaryKeys` the SDK
  encrypts only to the key your bank expects — a thumbprint you exchange
  with the institution — and not merely to the one the registry names.

In both modes the names of the two companies also appear in the evidence
elements your bank signs, which the platform stores and the evidence
package carries. Address, registration number and account travel only in
the Travel Rule message. That is about what your bank sends: the receiving
institution's signed credit confirmation (`payoutReceipts`) carries the
beneficiary's account.

The receiving institution answers in one of three ways: a signed
acceptance, after which it pre-approves the payout and the settlement
proceeds; a question, which pauses the payment until your bank answers; or a
refusal, which cancels the payment before any funds move.

## Learning the outcome: states, tracking and webhooks

Two rules the state machine enforces:

1. **No funds move before the receiving institution's signed approval.**
   The transfer instruction is derived from the `PAYOUT_ACCEPTED` event or
   it does not exist.
2. **No credit is confirmed before verifiable evidence.**
   `BENEFICIARY_CREDIT_CONFIRMED` requires a signed payout completion *and*
   a passing six-axis reconciliation. An unsigned completion holds the
   payment at `PAYOUT_IN_PROGRESS` — not failed, not confirmed.

States only advance: `REQUEST_ACCEPTED → BANK_AUTHORIZED →
TRAVEL_RULE_PENDING → PAYOUT_PRE_APPROVED → ONCHAIN_SETTLED →
PAYOUT_IN_PROGRESS → BENEFICIARY_CREDIT_CONFIRMED → EVIDENCE_ANCHORED`,
with `CANCELLED`, `RETURNED` and `EXCEPTION` as terminal exits. A correction
is a new signed event, never an edit. HTTP 202 on submission means
accepted, not paid.

**Polling.** `client.track(paymentId)` reads `GET /v1/settlements/{id}`
until the payment finishes or pauses for your bank. After three minutes
(`timeoutMs`) without either it throws `tracking_timeout`; call it again to
keep following. The credit is final at `BENEFICIARY_CREDIT_CONFIRMED`
(`ACCC`); the anchor (`EVIDENCE_ANCHORED`) follows separately. Polling needs
no inbound connection, so it works from behind a firewall.

**Webhooks.** If you gave a webhook URL at activation, the platform POSTs a
JSON body to it at each step:

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

The signature is the platform's, over the envelope with the event
convention above; the platform's public key is at `GET /v1/remit/meta`.
`await client.verifyWebhook(body)` checks it and returns
`{ valid, envelope }`. Act only when `valid` is `true`; `envelope` is `null`
otherwise. Delivery is at least once: dedupe on `event_id`, order by
`sequence` (the sequence number of the event in `GET /v1/settlements/{id}`
that the notification refers to). Any 2xx acknowledges receipt; a delivery
that is not acknowledged within five seconds is retried from 2 s, 10 s,
30 s and 2 min later (the delivery cycle can add a few seconds) — five
attempts in all — and after that polling is the backstop. The `type`
values are `BANK_AUTHORIZED`, `TRAVEL_RULE_PENDING`, `TRAVEL_RULE_RFI`,
`TRAVEL_RULE_RFI_RESOLVED`, `PAYOUT_PRE_APPROVED`, `SETTLEMENT_INSTRUCTED`,
`ONCHAIN_SETTLED`, `PAYOUT_IN_PROGRESS`, `PAYOUT_SUBMITTED`,
`PAYOUT_COMPLETED`, `EVIDENCE_INSUFFICIENT`, `PAYOUT_FAILED`, `RETURNED`,
`RECONCILIATION_EXCEPTION`, `BENEFICIARY_CREDIT_CONFIRMED`,
`EVIDENCE_COMMITTED`, `EVIDENCE_ANCHORED`, `CANCELLED` and `EXCEPTION`.
`type` names the step, and can differ from the name of the event its
`sequence` points at. Treat a payment as credited on
`BENEFICIARY_CREDIT_CONFIRMED` only — `PAYOUT_COMPLETED` is the receiving
institution's report and no more.

## Status in SWIFT terms

`client.swiftStatus(paymentId)` gives the settlement's state as an ISO 20022
transaction status, and `client.statusReport(paymentId)` as the `pacs.002`
report your payment hub already consumes. From a settlement view you
already hold — what `status()` or `track()` returned — `swiftStatusOf(view)`
and `buildPacs002(view)` do the same. A webhook envelope is not a settlement
view: on a webhook, read the status with
`client.swiftStatus(envelope.payment_id)`. The reason is this platform's own event
name, carried as a proprietary reason, because a mapping onto standard
reason codes would claim more than is known.

| Situation | Status | Reason |
|---|---|---|
| Instruction accepted, signatures verified | `ACTC` | |
| Waiting for the receiving institution | `PDNG` | `TRAVEL_RULE_PENDING` |
| The receiving institution asked a question | `PDNG` | `RFI` — the questions are in the report |
| Payout approved by the receiving institution | `ACSP` | `PAYOUT_PRE_APPROVED` |
| Settlement transfer confirmed | `ACSP` | `ONCHAIN_SETTLED` |
| Local payout under way | `ACSP` | `PAYOUT_IN_PROGRESS` |
| Payout reported without signed proof | `PDNG` | `EVIDENCE_INSUFFICIENT` |
| Local payout failed, the funds on their way back | `PDNG` | `PAYOUT_FAILED` |
| Credit to the beneficiary confirmed | `ACCC` | — with the beneficiary bank's reference |
| Cancelled at your request | `RJCT` | `CANCELLED_BY_BANK` |
| Refused by the receiving institution | `RJCT` | `TRAVEL_RULE_REJECTED` |
| Local payout failed, funds returned | `RJCT` | `RETURNED` |
| Stopped for manual follow-up | `PDNG` | `EXCEPTION` |

The codes are the interbank ones, used with their ISO 20022 definitions. A
payment withdrawn at your request is reported `RJCT` with the reason
`CANCELLED_BY_BANK`: the standard keeps `CANC` for API contexts, and a
payment hub reads a `pacs.002` by the interbank codes. A stopped payment
reports `PDNG` with the reason `EXCEPTION` and says in words that no further
status follows automatically — a person resolves it. The result of
`swiftStatus()` also says who has to act (`needs`: `bank_answer` or
`manual_resolution`).

The report is a `pacs.002.001.10` that points at your message by its own
identifiers (a payment built from your own data gets a report without the
`Orgnl…` references — match it by the payment id in `StsId`). `AccptncDtTm` is the time the instruction was accepted,
whatever the status has become; for a credited payment `FctvIntrBkSttlmDt`
carries the time of the credit:

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

## When things deviate

- **A question from the receiving institution.** The payment pauses at
  `TRAVEL_RULE_PENDING` with a `TRAVEL_RULE_RFI` event carrying the
  questions. Answer with `client.answerRfi(paymentId, answers)`: `answers`
  is a map of your own keys to text. It is encrypted to the receiving
  institution and the platform keeps only a digest. The sandbox institution
  accepts any answer that is not empty.
- **Cancel.** `client.cancel(paymentId, reason)` works until the payout is
  pre-approved. In the sandbox a normal payment passes that point within a
  second, so try it on a payment that is paused for a question.
- **Returned.** If the local payout fails after settlement, the USDC comes
  back on-chain and the payment ends `RETURNED`, with the failure and the
  return transfer both signed.
- **Confirmation withheld.** A payout reported without signed proof stays at
  `PAYOUT_IN_PROGRESS` with an `EVIDENCE_INSUFFICIENT` event. Treat it as
  not yet paid; it is neither failed nor confirmed.
- **Stopped.** When a step cannot complete — the receiving side does not
  answer, the settlement entity refuses the transfer — the payment ends at
  `EXCEPTION`, and the `EXCEPTION` event's `error` says why. It needs a
  person; nothing retries it on its own.
- **Sending again.** Do not resend an instruction to find out what happened
  — read it with `client.status(paymentId)`. A rebuilt instruction has a new
  quote and new signatures, so it is a different request: the same
  `Idempotency-Key` answers `409 idempotency_conflict`, the same
  `payment_id` answers `409 duplicate_payment`, and the same message under
  another `payment_id` answers `409 duplicate_source_message`.
  `submitSwift()` handles all three for you and returns the existing payment.

The SDK reports an error by throwing. `RemitApiError` (`status`, `code`) is
a refusal by the platform, or the SDK stopping before it sends;
`SwiftMessageError` (`code`, `field`) is a message that cannot be read;
`SwiftMappingError` (`issues`) is a value the message lacks; `SignerError`
is a failure of the signer. A refusal by a read-only client is a
`TypeError`. Branch on `e.code` for the codes below.

The errors an integration meets, and what to do:

| Code | Meaning | What to do |
|---|---|---|
| `401 unauthorized` | The API key is missing or was revoked | Issue a key in the console under Integrate → API keys |
| `403 subscription_required` | The product is not active for this organisation | Activate it in the console under Subscriptions |
| `400 unsupported_corridor`, `unsupported_trade_currency` (when calling the API directly) | The sandbox quotes VN → SG in USD only | Quote a USD amount on that corridor. Through the SDK a message on another route or in another currency stops before quoting, as a `SwiftMappingError` (`issues[].target` is `corridor` or `trade.amount`) |
| `409 quote_expired` | The quote passed its `expires_at` (ten minutes in the sandbox) | Request a new quote and rebuild |
| `400 amount_mismatch` | The instruction's amounts differ from the quote's | Build the instruction from the quote you cite |
| `400 invalid_signature`, `invalid_evidence_signature` | A signature does not verify with your registered key | Run `assertRegistered()`; check which key the institution uses in the console under Integrate |
| `400 travel_rule_incomplete` | A required party field is missing | Supply every field in `required_travel_rule_fields` |
| `409 duplicate_payment`, `idempotency_conflict` | This payment was already submitted | Read it with `status()`; do not resend |
| `409 key_mismatch`, `404 institution_unregistered` (from `assertRegistered()`) | The client's signing key is not the registered one, or the institution id is wrong | Use the key registered at activation and the institution id shown under Subscriptions in the console |
| `409 not_cancellable` | The payout is already pre-approved, or the payment has already ended | Nothing to cancel; follow the payment |
| `409 wrong_state` | The action does not fit the payment's state — an answer to a payment that was asked nothing, say | Read the state with `status()` |
| `400 invalid_manifest` | The daily manifest's date or list is not well formed | Submit a UTC day (`YYYY-MM-DD`) and a list of payment ids |
| `408 tracking_timeout` (from the SDK) | The payment did not finish while `track()` was waiting | Call it again to keep following; the payment is still under way |
| `409 duplicate_source_message` | The message this instruction was made from already has a settlement — the same transaction of the same file, the same UETR, or the same payment in another message. The answer names it in `existing_payment_id` (`e.existingPaymentId`) and says on what ground in `ground` (`e.ground`) | `submitSwift()` answers `already: true` by itself. The error reaches your code only when you call the API yourself, or when two messages cannot be told apart at all (`ground` is `twin_undated`: the same identifiers and content, and no value date): read the settlement it names, and give a payment that really is another one a reference of its own — another instruction or end-to-end id |
| `409 reference_reused` (from the SDK before anything is sent; from the platform when two processes race) | The message's reference — its UETR, or without one its instruction and end-to-end ids with its value date — is already on a different payment | Give the payment its own UETR. Only without a UETR can a reference your bank means to use again be sent under a `{ paymentId }` of its own; see [One message, one payment](#one-message-one-payment) |
| `multiple_transactions` (from the SDK, nothing was sent) | The message carries several payments and none was chosen | Read it with `parseSwiftMessages()` and hand each payment to `submitSwift()` |
| `not_a_platform_answer` (from the SDK) | Something between your system and the platform answered instead of it: a proxy page, a redirect, a gateway's 502 or 503 error page | It is not taken for an outcome. Check the route to the API, then call again — `submitSwift()` can be called again without making a second payment |
| `quote_mismatch`, `bfi_key_mismatch` (from the SDK, nothing was sent) | The quote is not for what was asked, or the receiving institution's encryption key is not the one your bank expects | Nothing was sent. Check the route to the API; for a rotated key, confirm the new thumbprint with the institution |
| `409 evidence_not_ready` | Evidence exists from `BENEFICIARY_CREDIT_CONFIRMED` on | Wait for that state; a cancelled payment has none |

## Daily manifest

`client.submitDailyManifest(date, paymentIds)` sends your signed list of
every instruction your bank issued on a day. `date` is a UTC day
(`YYYY-MM-DD`); the platform lists every settlement your organisation
created on that UTC day — whatever its state, cancelled ones included — and
compares the two lists both ways. The verdict is `MATCHED`, or `DISCREPANT`
with the ids only one side has. The platform countersigns the manifest and
the verdict together, and anchors
`SHA-256("STONEHASH-MANIFEST-V1\n" + JCS({ manifest, verdict }))`.
Submitting again for the same day replaces the earlier result.

This is the completeness control an inclusion proof cannot give you: a
payment the platform holds but your list omits, and a payment in your list
the platform never saw, both show.

## Sandbox test levers

The outcomes are driven by the data of the payment, so each can be produced
from your own system without a switch on the platform:

| To produce | Send |
|---|---|
| A question from the receiving institution | A trade amount of `20000.00` or more |
| A refusal by the receiving institution | A creditor name that contains `SANCTIONED` |
| A failed local payout and returned funds | An amount ending in `.13` |
| A completion without signed proof (confirmation withheld) | An amount ending in `.01` |
| A signed completion without the local bank's reference | An amount ending in `.02` |
| A transfer the settlement entity refuses (the payment stops at `EXCEPTION`) | An amount above `50000.00`, once its question is answered |

## Re-verifying the evidence

`verifyEvidencePackage()` re-checks four independent claims with no trust
in the platform: the nonce'd commitment over the canonical package, every
element signature against the Trust Registry snapshot carried inside the
package, the six-axis verdict re-computed locally with the same engine, and
the Bitcoin proof file whose leaf must equal the commitment. The Java SDK's
`EvidenceVerifier.verify()` re-checks the same four: the six-axis verdict is
re-computed by the same rules written in Java, held to the reference engine's
answers by shared vectors.

The verdict has six axes. A payment is confirmed only when all six read as
below; the last two are capped in the sandbox, because its data is
synthetic, and those caps do not hold a payment back:

| Axis | Passing value | What it says |
|---|---|---|
| `integrity` | `VALID` | Every element's content digest matches what was signed |
| `issuer` | `VALID` | Every element is signed by the institution entitled to assert it |
| `matching` | `MATCH` | Amounts, parties and references agree across the bank, chain and payout records |
| `completeness` | `COMPLETE` | All six required elements are present |
| `regulatoryMapping` | `PRESENT` (sandbox: `REVIEW_REQUIRED`) | The fields a report needs are all there |
| `businessFinality` | `VERIFIED_BY_SOURCE` (sandbox: `DEMO_ONLY`) | The payout is confirmed by its source institution |

The evidence level of a payout says how strongly its completion is proven:
`L1` is a notice with no signature (confirmation is withheld), `L2` is a
completion signed by the receiving institution, and `L3` adds the local
bank's own reference and signed credit confirmation.

## Scope and limits

- **A reader, not a validator.** Messages are read for the payment they
  carry. They are not checked against the schema or a market-practice
  rulebook.
- **Status goes back as `pacs.002.001.10`** and as JSON. There is no MT199,
  `camt.054`, `pacs.004` or `pain.002` output: a return after settlement is
  reported as `RJCT` with the reason `RETURNED`, and a payment that came
  from a `pain.001` is answered with the same `pacs.002`.
- **A free-format party is read by convention.** In `50K` and `59` the
  first line is taken as the name and the rest as the address. The customer
  master overrides it.
- **XML is read strictly.** Input is limited to 4 MiB, and only the five
  predefined entities and numeric references are decoded. The bytes are read
  in the encoding the message declares (UTF-8 when it declares none) and
  never guessed; an element that may occur once and occurs twice refuses the
  message, and an element from another namespace is not read as the
  message's own.
- **A TypeScript SDK (Node 22.18 or later) and a Java SDK (Java 11 or later).**
  The TypeScript SDK is source that Node runs directly; the Java SDK is a jar
  with no third-party dependency (tested on OpenJDK 11, 17 and 21). The two are
  held to the same reference vectors. The Java SDK does not yet have a signer
  that runs a command. When re-verifying evidence it does not interpret shapes
  the platform does not produce — a timestamp without a zone, a Trust Registry
  holding a key that is not ES256 — and reports that check as failed. There is
  no SDK for .NET yet. A system
  in another language integrates through the request body of
  `POST /v1/settlements` in the [API Reference](#api); reading and converting
  messages exists only in the two SDKs.

The sandbox corridor is synthetic end to end: mock USDC on a private test
chain, simulated counterparties, and anchors on a private chain that are
**not publicly verifiable** — live deployments anchor to Bitcoin. Evidence
from the sandbox says so in its own fields (`dataMode: SYNTHETIC`), which is
why its `businessFinality` axis reads `DEMO_ONLY` rather than pretending.
The simulated receiving institution signs its acceptance, its payout
approval and its completion; a question or a refusal is recorded as the
platform received it.

The Travel Rule message uses IVMS 101 names for its persons and is not yet
checked against every IVMS 101 constraint. An LEI is typed `LEIX`. Any other
registration number is sent as a registration-authority identifier without
naming the authority; a party's one country stands for both its address and
its country of registration — and, where the message does not state it, may
have been taken from its bank's BIC, which the conversion table marks
*inferred*; and the address travels as a single line. A production
counterpart will ask for more than that, and the party data will have to
carry it.
