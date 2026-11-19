# Public Test Vectors

Eight conformance proof files. **Five must verify and three must fail.** A verifier
that passes all eight is not more permissive — it is broken in the direction
that matters, because it would accept a tampered record.

These are the producer's own published fixtures, and
`attest-verify/test/conformance.test.ts` runs every one of them on each build.
Drift on either side — producer or verifier — turns the build red, which is the
only reason this page can be trusted to describe the current behaviour.

Each directory ships `bundle.json`, an `expected.txt` stating the verdict, a
`README.md` explaining what the case exercises, and whatever original artefact
the case needs.

## Must verify

| # | Case | Exercises |
|---|------|-----------|
| **01** | Attestation by file artifact | Document match (`A`) as `sha256-file`: the verifier hashes the file you supply and confirms it equals the anchored leaf. The simplest end-to-end case. |
| **02** | Daily balance by salted commitment | Document match (`A`) as `sha256-jcs-fields`. The leaf commits to `{asset, balance_minor, user_commitment}` where `user_commitment = SHA-256(salt ‖ account_id)`. **The salt is the customer's private secret and is deliberately absent from the proof file** — publishing it would let anyone de-anonymise accounts. Verifies self-consistently without the secret; binding it to a named account requires the secret. |
| **05** | Daily chain walk-back | A two-day per-exchange chain. Each prior entry must recompute its own `payload_hash`, and today's `prev_entry_hash` must equal yesterday's — the hash linkage that makes the chain tamper-evident rather than merely sequential. |
| **06** | Daily `day_root` (schema v2) | The anchor commits to `day_root`, not the bare balances root, so the reconciliation itself is anchored rather than asserted beside the anchor. |
| **07** | Original document carried in the anchoring transaction | One transaction both anchors the batch root (`output[0]` is the `BC30(merkle_root)` anchor) and carries the audit PDF itself in its BIP-342 tapscript envelope (`witness[1]`). |

## Must fail — and fail on the right check

This is the half of the suite that does the work. In all three cases the anchor
is genuine and most checks still pass; exactly one breaks. A verifier that
reports a blanket failure is nearly as unhelpful as one that passes, because the
reviewer cannot tell *what* went wrong.

| # | Case | Still passes | Fails |
|---|------|--------------|-------|
| **03** | Tampered original | `B`, `C` — the anchor is real | **`A`, document match.** The document no longer hashes to the anchored leaf. The proof file is authentic; the file is not the one it attests. |
| **04** | Tampered per-exchange chain | `A`, `B`, `C` — the day's root really is anchored | **The chain step.** The forged `payload_hash` no longer recomputes from its preimage. |
| **08** | Tampered carried document | Txid binding and the record-to-root binding | **The carried-document step.** One bit of the carried PDF was flipped. The carried bytes are not committed to the txid, so the txid and anchor output are unchanged — only the recovered body stops hashing to `record.leaf_bytes`. |

Case 08 is the subtle one and the reason the suite exists in this shape: three
of four checks pass, the transaction on chain is untouched, and the only thing
that reveals the tamper is recomputing the body hash. A verifier that trusted
the txid alone would call it clean.

## Running them

The fixture files are not downloadable from this hub yet: they ship with the
repository, which is not public, and are available on request. From a working
copy:

```bash
cd attest && pnpm install
pnpm --filter @stonehash/attest-verify test
```

Against your own implementation, the contract is just the directory layout:

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from '@stonehash/attest-verify';

for (const dir of ['01-attestation-file', '03-tampered-original']) {
  const bundle = JSON.parse(readFileSync(`fixtures/conformance/${dir}/bundle.json`, 'utf8'));
  const expected = readFileSync(`fixtures/conformance/${dir}/expected.txt`, 'utf8');
  const report = verifyBundle(bundle, { originalBytes: /* the case's artefact */ undefined });

  // expected.txt begins "VERIFIED (exit 0)" or "FAILED (exit 1)"
  console.log(dir, report.verified, expected.split('\n')[0]);
}
```

## A note on the network these were produced on

The anchors in these fixtures are on a private regtest chain. The arithmetic
checks — document match, batch inclusion, transaction binding — verify there
exactly as they would on mainnet; the chain is irrelevant to them.

**Chain inclusion cannot be confirmed on regtest by anyone but us, because we
mine the blocks.** These vectors are therefore a complete exercise of the
verification logic and *not* publicly verifiable proofs. Every proof file
states its own `bitcoin_network`, so a conforming verifier reports this rather
than letting you discover it later.

## Bank evidence fixtures

The settlement rules engine ships its own fixtures and policies, used by the
`/v1/settlements/*` endpoints and by the SDK's `verifyEvidencePackage()` —
the same engine on both sides, which is why re-running a policy with the SDK
gives the server's answer.

| File | Purpose |
|------|---------|
| `packages/attest-rules/fixtures/a-normal-trade-payment.json` | A clean trade payment |
| `packages/attest-rules/policies/settlement-match-v1.json` | The settlement-match rule set |
| `packages/attest-rules/fixtures/corridor-vn-sg-normal.json` | A VN→SG corridor case |
| `packages/attest-rules/policies/corridor-vn-sg-v1.json` | The corridor rule set |

These fixtures are **really signed**. Each counterparty has its own ECDSA P-256
demonstration key, the signatures cover the canonical bytes of each evidence
element, and the public keys ship with the package — so editing an amount breaks
the signature and the verification fails for a cryptographic reason rather
than because a status field said so. The package's test run
executes `tools/sign-fixtures.mjs --check` first and fails the build if a
fixture was edited without re-signing.

The private keys are published too, in `packages/attest-rules/keys/`. That is
deliberate: anyone can forge these signatures, so a signature from one proves
only that *somebody* signed. Their trust level is pinned to `DEMO`, below
anything a policy can require, which is why the issuer axis reports
`UNKNOWN_ISSUER` even when every signature verifies.

All of this evidence is **synthetic**. It carries `dataMode: "SYNTHETIC"`, and
that is enforced rather than promised: synthetic evidence can never reach
`PRESENT` or `VERIFIED_BY_SOURCE`, a renderer that omits the synthetic banner
fails its test, and `regulatoryDecision` is pinned to `NOT_EVALUATED`. No real
financial institution's data, logo or certification appears anywhere in them.
