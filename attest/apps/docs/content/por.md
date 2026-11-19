# Proof of Reserves

Publish a liability commitment your users can check against Bitcoin —
without your balance ledger ever leaving your machines. The exchange builds
a Merkle **sum** tree locally with the SDK and submits only the signed
statement (root, per-asset totals, parameters); the platform checks the
signature and the statement's commitment anchors through the ordinary
pipeline. A random spot check of the tree is there when the exchange asks
for one.

You integrate by calling the SDK from your own system's source. Hand it the
balance file your ledger exports and the snapshot is anchored, leaving **one
proof file** behind. What you keep is that proof file and the balance file —
two files — and with the two, a customer's proof can be issued at any time.

## What leaves your machines, and what never does

Leaves, by default: the statement and its signature — root, totals, the
number of accounts, and nothing about any one of them. Leaves only when you
ask for a spot check: openings for the eight leaves the platform names
(pseudonymous: hashed reference, salt and balances, with the neighbouring
leaf's balances beside them; no account reference). Never leaves: the balance
file, the leaves, the salt seed. That boundary is the product.

## The tree

Every node carries a hash **and** a per-asset sum vector, and the hash
covers the child sums — so one 32-byte root commits to the set of leaves
and to the arithmetic totals at once. Understating liabilities breaks the
root, not a footnote. Balances are non-negative integer strings in base
units; negative balances are rejected at build and at verification. A leaf
and a sum write only what is not zero — exchanges list different assets,
some of them hundreds, but the tree grows with what accounts actually hold,
and an asset nobody holds can be listed or not without changing the root. An
empty place is filled with an empty node that carries no sums — duplication
padding would double-count a balance.

```
leaf  = SHA256("STONEHASH-POR-LEAF-V1\n" ‖ salt ‖ user_ref_hash ‖ JCS(balances))
node  = SHA256("STONEHASH-POR-NODE-V1\n" ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums))
user_ref_hash = SHA256("STONEHASH-POR-USER-V1\n" + exchange_id + "\n" + user_ref)
commitment    = SHA256("STONEHASH-POR-V1\n" ‖ JCS(statement))
```

The specification lives in `@stonehash/attest-verify` (`merkle-sum.ts`) —
the builder imports the verifier's functions, so the two sides cannot
drift, and anyone can re-implement from the constants above. `tree.algo` in
the statement names the format: snapshots built now are
`merkle-sum-sha256-v2`, and a snapshot in the earlier
`merkle-sum-sha256-v1`, which wrote every asset out with its zeros, goes on
being accepted and verified. The two use the same formulas and differ only
in what is written.

## What you need

What the code below takes, and where each comes from. The API key, the
institution id and the signing key come from the [console](../console/):

| What is needed (its name in the code below) | Where it comes from |
|---|---|
| Platform address `STONEHASH_CORE` | This deployment: `{{ORIGIN}}` |
| API key `STONEHASH_API_KEY` | Console **Integrate → API keys** |
| Institution id `STONEHASH_INSTITUTION` | Console **Subscriptions** — shown once Proof of Reserves is activated |
| Signing key `key` | The private half of the public key registered at activation. If the console made the key, the `stonehash-por-signing-key.pem` downloaded then; in production, the key on your key-holding server |
| Balance file | Exported from your ledger — [Preparing the Balance File](#por-data) |
| SDK | [attest-por.tar.gz](./download/attest-por.tar.gz) · [SHA-256](./download/attest-por.sha256) |

The SDK is not on a package registry. Import
`packages/attest-por/src/index.ts` by path from where the archive was
extracted; there is no install or build step and no outside dependency (Node
22.18 or later). An example balance file is in
`packages/attest-por/samples/`.

## Anchoring a snapshot

Hand over the balance file. Checking the file, building the tree, signing,
submitting and writing the proof file are one call:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { PorClient, PorLedgerError, anchorBalanceFile } from './packages/attest-por/src/index.ts';

const client = new PorClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: 'Your exchange',
  key: createPrivateKey(readFileSync('stonehash-por-signing-key.pem', 'utf8')),
});
await client.assertRegistered();                   // is this the registered key?

try {
  // the balance file exported from your ledger — here, the example in the SDK
  const anchored = await anchorBalanceFile(client, 'packages/attest-por/samples/balances.wide.csv', {
    assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }],
    amounts: 'decimal',                            // 0.5 in the file is 0.5 BTC
    asof: '2026-11-18T00:00:00Z',                  // the moment the balances stand for
    proofFile: 'por-proof-2026-11-18.json',        // what is left behind — this one file
  });
  console.log(anchored.snapshotId, anchored.root, anchored.totals, anchored.publicUrl);
} catch (e) {
  // one problem in the file and nothing is built, written or sent
  if (e instanceof PorLedgerError) console.error(e.message, e.report?.problems);
  else throw e;
}
```

Put your balance file in place of the example path, and your own asset list
and as-of time. What goes to the platform is the statement (root, per-asset
totals, number of accounts) and its signature. Compare `anchored.totals` with
your ledger's totals — these are the figures that are signed and published.

- **The proof file is written first.** `proofFile` is written before the
  statement is sent, and the snapshot id is filled in when the platform
  accepts. If the connection drops before the answer, make the same call
  again — it sends the same statement and finishes, and no second snapshot is
  made (`anchored.already`).
- **A proof file is never overwritten.** If `proofFile` already holds another
  snapshot's proof file the call is refused. Give each snapshot its own path.
- **Spot check (optional).** With `spotCheck: true` in the options, the
  openings of eight accounts the platform picks at random are sent too (the
  hashed identifier, the salt and the balances, with the balances of the
  account next to each — never the account identifier itself). By default
  they are not sent.
- **Waiting for the anchor.** With `waitAnchoredMs: 600_000` the call
  returns once the anchor is confirmed. Without it, it returns on acceptance,
  and `client.status(anchored.snapshotId)` reads where the anchor stands.

## Issuing a customer's proof

The platform is not given the accounts, so only you can issue a customer's
proof. The proof file and the balance file open the snapshot again:

```ts
import { writeFileSync } from 'node:fs';
import { openSnapshot } from './packages/attest-por/src/index.ts';

const snapshot = await openSnapshot('por-proof-2026-11-18.json', 'packages/attest-por/samples/balances.wide.csv');

const proof = snapshot.proofFor('U-100008');       // null for an account that is not in the snapshot
if (proof) writeFileSync('proof-U-100008.json', JSON.stringify(proof, null, 2));

// everyone: filed as <first two characters of the hash>/<hashed identifier>.json
const count = await snapshot.writeAllProofs('proofs');
console.log(count, snapshot.snapshotId);
```

`openSnapshot` recomputes the tree from the balance file and returns the
snapshot only when the root, the totals and the number of accounts are the
anchored ones. A balance file that differs by a single character issues
nothing: the error (`SnapshotRestoreError`) says what differed and whether
the file is the one the proof file records. Give the customer `proof` (as
JSON) and the snapshot id.

## What your users get

A user verifies the proof they were given offline — `verifyPorInclusion`
checks the path against the root **and the declared totals together**, so a
root that matches with different totals fails. The proof holds that user's
balances, the balances of the account next to it in the tree (with no
identifier) and the subtotals along the path — the values the totals check
needs. The [public verification page](../playground/por.html) runs five
checks in a browser — the exchange's signature, inclusion against root and
totals, the reference against its hash, the commitment, and the anchor — with
nothing uploaded, and shows whether the snapshot was spot-checked.


## Reserves and the stated boundary

Declared reserve addresses are **measured** on chain by the platform when it
accepts the snapshot — the solvency report distinguishes `MEASURED` from
`DECLARED_ONLY` and never silently counts what it could not read. A spot
check, when one is asked for, is a sample: it makes a malformed tree likely
to be caught, it does not prove every leaf is a real customer. Without one,
the platform has checked the exchange's signature and the statement's shape
and nothing about the tree. Either way the tree is checked by the exchange's
own users, one inclusion proof at a time. The page and the API say which it
was rather than rounding it up to certainty.

## Sandbox honesty

Sandbox snapshots anchor to a private test chain and are **not publicly
verifiable**; live deployments anchor to Bitcoin. Synthetic liabilities are
labelled as such throughout.
