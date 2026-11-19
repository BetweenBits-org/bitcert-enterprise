# TypeScript SDK

**Not published to npm yet.** `npm i @stonehash/attest-verify` would fail,
so it is not offered: a registry name that 404s is worse than no name.

Take it from the downloads instead — three tarballs, one per integration,
each checksummed and each carrying its dependencies as the same
zero-dependency sources:

| Tarball | For | Contains |
|---|---|---|
| `download/attest-sign.tar.gz` | signed anchors | attest-sign + attest-verify |
| `download/attest-remit.tar.gz` | banks (settlement) | attest-remit (the SDK, sample SWIFT messages) + attest-rules + attest-verify |
| `download/attest-remit-java.tar.gz` | banks (settlement, Java) | the Java SDK's jar, sources jar and pom, its sources and test vectors, examples (Spring among them), sample SWIFT messages |
| `download/attest-por.tar.gz` | exchanges (PoR) | attest-por (the SDK, example balance files) + attest-rules + attest-verify |

`$BASE` below is this deployment's origin — the address you are reading this
page on, filled in for you:

```bash
BASE={{ORIGIN}}
curl -O $BASE/docs/download/attest-sign.tar.gz
curl -O $BASE/docs/download/attest-sign.sha256
sha256sum -c attest-sign.sha256 && tar xzf attest-sign.tar.gz
ls packages/attest-sign/src
```

Zero runtime dependencies and no build step: Node ≥ 22.18 runs the `.ts`
sources as they are (older 22.x: add `--experimental-strip-types`), and
compiled once they run in a browser — the Playground imports them directly, so
the code a visitor watches run is the code you would take from here. Import by
path from the directory you extracted into; the `@stonehash/…` names below are
what the imports become once the packages are on npm.

## Why this half is published and the other is not

`@stonehash/attest-verify` is the **checker**, and it is deliberately a second,
independent implementation of the [Evidence Specification](#spec) — not a
library shared with the producer. If the same code both issued and checked a
proof, a bug would cancel itself out and "independently verifiable" would mean
nothing. Two implementations written separately against a published spec,
agreeing on real bytes, is evidence. One implementation agreeing with itself is
not.

`apps/core` depends on this package only as a devDependency, so nothing that
ships can import the checker.

The anchoring engine is not published. That is a patent position, not a
transparency gap: everything required to *verify* a proof is here, which is the
half that has to be auditable.

## Verifying a proof file

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from './packages/attest-verify/src/index.ts';   // '@stonehash/attest-verify' once it is on npm

const proof = JSON.parse(readFileSync('proof.json', 'utf8'));
const report = verifyBundle(proof, { originalBytes: readFileSync('contract.pdf') });

report.verified   // conjunction of the gating checks
report.links      // { A, B, C1, C2 } — document match · batch inclusion · transaction binding · chain inclusion, reported separately
report.checks     // ordered detail, for rendering
```

Omit `originalBytes` and `A` (document match) reports `skip` rather than
failing: without the original there is nothing to hash, and saying
"unverified" is the honest answer.

### Reading `links`

| Value | Meaning |
|-------|---------|
| `pass` | the arithmetic holds |
| `fail` | the arithmetic does not hold — this proof file does not say what it claims |
| `skip` | **not checked.** Not "fine" |

`verifyBundle` never performs `C2`, chain inclusion. It cannot: it means "this
txid is in a public block", and the entire point is that you establish that
through a Bitcoin source *you* choose — your own `bitcoind`, a public explorer,
a self-hosted one. A verifier that fetched the block for you would reintroduce
exactly the trusted third party the design removes.

So `C2` arrives as `skip` and you merge your own result in.

## In the browser

```html
<script type="module">
  import { verifyBundle } from './vendor/attest-verify/index.js';

  const report = verifyBundle(bundle, { originalBytes: new Uint8Array(buf) });
</script>
```

No bundler is required. The package has no dependencies and imports only
relative siblings by explicit path, which `test/portability.test.ts` enforces —
it asserts `src/` contains no `node:` import, no `require`, no `process` and no
`Buffer`, so the browser build cannot rot unnoticed.

## The primitives, if you are writing your own verifier

You do not need these to check a proof file, and if your goal is to implement the
specification independently you should not use them — write your own. They are
exported because partial re-derivation is often what an auditor actually wants.

| Export | Purpose |
|--------|---------|
| `sha256`, `sha256d` | The hash, and Bitcoin's double-SHA-256 |
| `jcs`, `jcsString` | RFC 8785 canonical JSON — how a record becomes bytes |
| `leafHash`, `nodeHash`, `verifyInclusion` | The RFC 6962 Merkle construction (`B`, batch inclusion) |
| `parseEnvelope`, `extractWitnessItems` | Transaction parsing, including data carried in the transaction |
| `verifyPreimage` | `A`, document match, on its own |
| `verifyChainLinks`, `payloadHash` | Per-exchange chain walk-back |
| `dayRoot`, `assetsHash`, `deriveUserCommitment`, `reconCommitment` | Daily reconciliation commitments |
| `SUPPORTED_SCHEMAS` | Which proof file schema versions this build accepts |

`sha256` is checked against the NIST vectors, against the specification's frozen
vector, and differentially against `node:crypto` — a hand-written hash in a
verification library is only trustworthy if it is pinned that hard.

## Conformance

Run your implementation against the published vectors before you trust it, and
before we ask anyone to trust ours. Five proof files must verify and
**three tampered ones must fail**; a verifier that passes all eight is broken in
the more dangerous direction.

See [Test Vectors](#vectors) for the fixtures and what each one exercises.

## The bank SDK, call by call

`download/attest-remit.tar.gz` is the bank's side of
[Cross-border Settlement](#corridor). Everything is exported from
`packages/attest-remit/src/index.ts`:

| Call | What it does |
|---|---|
| `new RemitClient({ core, apiKey, institutionId, institutionName, key })` | A client that signs with a key in the process — or pass `signer` instead of `key` for an HSM or a KMS |
| `new RemitClient({ core, apiKey, institutionId, institutionName, readOnly: true })` | A client with no signing key that only reads — the status, the status report, the ledger, the evidence. Whatever would sign or send is refused |
| `client.assertRegistered()` | Checks the key is the one the Trust Registry holds for the institution |
| `client.quote(amount)` | A quote for a USD trade amount |
| `client.buildInstructionAsync(quote, parties, options)` | The signed settlement instruction; `buildInstruction()` is the synchronous form for a key in the process |
| `client.submit(body)` · `client.status(id)` · `client.track(id)` | Send it, read it, follow it to its end |
| `client.submitSwift(message, options)` | The whole path from an MT103, a pacs.008 or a pain.001 — read, convert, quote, sign, submit |
| `client.inspectSwift(message)` · `client.instructionFromSwift(message)` | The conversion table only; the signed instruction without sending |
| `client.swiftStatus(id)` · `client.statusReport(id)` | The state as an ISO 20022 status code; as a `pacs.002` report |
| `client.answerRfi(id, answers)` · `client.cancel(id, reason)` | The two decisions that are the bank's |
| `client.submitDailyManifest(date, ids)` | The day's signed list of instructions |
| `client.evidence(id)` · `verifyEvidencePackage(evidence)` | The evidence package, and its four independent re-checks |
| `client.verifyWebhook(body)` | Checks a webhook delivery's signature |
| `parseSwiftMessages(message)` · `mapSwiftPayment(payment)` | The message readers and the conversion, without a client |
| `swiftStatusOf(view)` · `buildPacs002(view)` | Status from a settlement view, without a client |
| `commandSigner({ publicKey, command })` | A signer that runs a command — OpenSSL, a PKCS#11 tool, a KMS wrapper |
