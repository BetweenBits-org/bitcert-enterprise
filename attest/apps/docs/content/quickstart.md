# Quick Start

Anchor your first record and verify it yourself. No account for the first step,
and the document never leaves your machine.

The commands below use `$BASE` for this deployment's origin — the address you
are reading this page on, filled in for you:

```bash
BASE={{ORIGIN}}
```

## 0. Find out what you are connected to

Read this before anything else. It tells you which Bitcoin network this
deployment anchors to and, in words, what can and cannot be proved here.

```bash
curl -s $BASE/v1/meta
```

```jsonc
{
  "service": "stonehash-attest-core",
  "bitcoin_network": "regtest",
  "bundle_schema": "bitcert-proof-bundle/v1",
  "free_tier": { "endpoint": "/v1/public/anchors", "signup_required": false },
  "key_prefix": "sk_test_",
  "public_verifiability": "anchors are on a private regtest chain: links A, B and C1 verify offline, but public-chain inclusion (C2) cannot be confirmed by a third party"
}
```

`bitcoin_network` is reproduced verbatim into every proof file, so a regtest
proof cannot be presented as a mainnet one — every conforming verifier reads
that field and reports it.

## 1. Hash your document

Locally. **The file is never uploaded**, so there is no step here that sends it
anywhere, and nothing we could later disclose.

```bash
sha256sum contract.pdf | cut -d' ' -f1
# 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

```bash
# macOS
shasum -a 256 contract.pdf | cut -d' ' -f1
```

## 2. Anchor it — no account

```bash
curl -s -X POST $BASE/v1/public/anchors \
  -H 'content-type: application/json' \
  -d '{"sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}'
```

```jsonc
{
  "id": "4f1e…",
  "sha256": "9f86d081…",
  "status": "accepted",
  "bundle_available": false,
  "bundle_url": null,
  "retrievable_until": "2026-12-05T00:00:00Z",
  "bitcoin_network": "regtest",
  "note": "accepted; it joins the next shared batch rather than its own transaction"
}
```

Your digest joins the next shared batch. That is the economics of batching, not
a restriction on the free tier: one caller cannot make us spend a transaction
fee on demand.

Submitting the same digest twice returns **200** with the existing record rather
than an error.

## 3. Watch it reach the chain

```bash
ID=<the "id" from step 2>
curl -s $BASE/v1/public/anchors/$ID
```

`status` moves `accepted → batched → submitted → confirmed`. It is reported as
the stage actually reached and is never collapsed into a boolean — a single flag
would hide which stage is missing.

## 4. Take the proof file and go

Once step 3 reports `bundle_available: true` — before that the route answers
`409 not_batched`, and `-f` makes curl say so instead of saving the error:

```bash
curl -sf -OJ $BASE/v1/public/anchors/$ID/bundle
```

This is the point of the whole exercise. The proof file is self-contained:
given it and any public view of Bitcoin, anyone can confirm the record
**without contacting StoneHash**. Your record here expires after the retention
window in `/v1/meta`; the file you just downloaded does not.

## 5. Verify it without us

The verifier is not on npm yet. Take it from any of the tarballs on the
[TypeScript SDK](#sdk) page — no dependencies, no build step — and import it by
path from the directory you extracted into. Node ≥ 22.18 runs the `.ts`
sources as they are (older 22.x: add `--experimental-strip-types`):

```bash
curl -O $BASE/docs/download/attest-sign.tar.gz
curl -O $BASE/docs/download/attest-sign.sha256
sha256sum -c attest-sign.sha256 && tar xzf attest-sign.tar.gz
```

Save this as `verify.ts` next to the extracted `packages/` and run
`node verify.ts`:

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from './packages/attest-verify/src/index.ts';   // '@stonehash/attest-verify' once it is on npm

const proof = JSON.parse(readFileSync('proof-4f1e.json', 'utf8'));
const report = verifyBundle(proof, { originalBytes: readFileSync('contract.pdf') });

console.log(report.links);
// { A: 'pass', B: 'pass', C1: 'pass', C2: 'skip' }
```

Zero runtime dependencies, and the same module runs in a browser unchanged. See
[TypeScript SDK](#sdk) for the full surface.

### The four checks, and why they are reported separately

```
 original ──(document match)──▶ digest ──(batch inclusion)──▶ batch root ──(transaction binding)──▶ Bitcoin
```

The report names them `A`, `B`, `C1` and `C2`:

| `links` | Question | Needs |
|------|-------|-------|
| **A** — document match | is this digest *your* document? | the original file |
| **B** — batch inclusion | is the digest in this batch root? | the proof file alone |
| **C1** — transaction binding | do the anchor bytes belong to this txid? | the proof file alone |
| **C2** — chain inclusion | is that txid in a public block? | a Bitcoin source **you** choose |

The first three are pure arithmetic and prove out offline, with no network and
no trust in StoneHash. Chain inclusion is the one chain-dependent step, and the
verifier never performs it for you: you consult your own node or an explorer
and merge the result.

Until you do, **`C2` reads `skip`, which means unverified — not fine.**

On this deployment's private regtest chain, chain inclusion cannot be confirmed
by anyone but us, because we mine the blocks. A regtest proof is a faithful
exercise of the entire pipeline and *not* a publicly verifiable proof.

## 6. Raise the limits — a sandbox account

The free tier is capped per address. A sandbox account lifts that, and it is
self-serve: no approval queue and no sales call.

**In a browser**, open the [Sandbox Console](../console/) and sign up. One
screen later you have an API key, a monthly allowance of 1,000 attestations, and
a worked record already under Records, so your first proof export has something
to export.

**From a terminal**, if you would rather not have an account at all:

```bash
curl -s -X POST $BASE/v1/sandbox/keys \
  -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Corp","label":"ci"}'
```

```jsonc
{
  "org": { "id": "…", "slug": "acme" },
  "api_key": "sk_test_…",
  "note": "Store this now — it is not recoverable. Sandbox anchors land on a private regtest chain."
}
```

The key is shown once; only its hash is stored. The `sk_test_` / `sk_live_`
prefix is part of the key, so a sandbox key cannot be mistaken for a production
one in a log or a config file.

Then use the keyed API, which adds listing, your own descriptors and org
isolation:

```bash
KEY=<the api_key from the response>
curl -s -X POST $BASE/v1/attestations \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"leaf_bytes":"9f86d081…","content_type":"application/pdf","descriptor":{"ref":"invoice-2026-0041"}}'
```

See the [API Reference](#api) for every endpoint, every error shape and what
each one does when it fails.

## What this deployment does not do

Sandbox and production run the **same code**. They differ in which database file
is opened, which anchor backend is constructed, and which key prefix
authenticates — nothing branches on the environment, because a sandbox running
different code would tell you nothing about production.

Moving to mainnet is a backend setting against a funded node. Batching, proof
assembly and verification are untouched.
