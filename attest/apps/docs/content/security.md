# Security & Privacy

## The document is not uploaded — with one stated exception

Anchoring takes a SHA-256 digest and nothing else: `POST /v1/attestations`, the
free tier, the settlement rail and Proof of Reserves have no field in which a
caller could place content.

This is a design property, not a policy commitment, and the difference matters:
a policy can be changed, breached or subpoenaed. **We cannot disclose a document
we were never sent**, cannot be compelled to produce it, and have nothing to
moderate. The free tier accepts a 32-byte digest, which is why it can be open to
the internet without an account.

The exception is the full-document route, `POST /v1/attestations/inscribe` (and
its console twin), which you choose explicitly: the document is sent, written
into a public Bitcoin transaction, and that transaction — bytes included — is
kept in the record so the proof can be exported. A document anchored this way
is public by design, and the console says so before it sends anything.

A digest is not reversible, but it is checkable: anyone holding a candidate file
can confirm whether it produced a given digest. That is the entire mechanism —
it is what makes a proof useful, and it means a digest should be treated as
identifying the document to anyone who already has a copy.

## What is stored

| Data | Where | For how long |
|------|-------|--------------|
| Your digest, status, batch position | The service's database on its host | Your organisation's records (API key or console): no expiry, until deleted. Free-tier records: the retention window in `/v1/meta` |
| Your `descriptor`, if you send one | Same | Same. **This is yours and is echoed back verbatim — do not put document contents in it** |
| API key **hashes**, each with its label | Same | Until revoked |
| Evidence and policies sent to `/v1/settlements/reconcile` and `/v1/settlements/bundle` | **Nowhere** | Not stored at all |
| Inscribed documents — inside the reveal transaction kept for the record | Same | Until deleted |
| Signed anchors: the statement (digest, your public key, signature) | Same | Same as the record |
| Settlement instructions, signed events, evidence packages and daily manifests (Cross-border Settlement) | Same | Until deleted |
| Travel-rule messages, encrypted to the receiving institution's key: the ciphertext and its digest | Same | Until deleted |
| Quotes, idempotent replies, webhook deliveries (URL and payload) | Same | Until deleted |
| Proof-of-Reserves: the signed snapshot statement (root, totals, leaf count, as-of time, declared reserve addresses), your signature over it and the on-chain reserve readings — nothing about any account. Only when you ask for a spot check: the challenge, too; the leaves you open for it are checked and not kept, and no other leaf is ever sent | Same | Until deleted |
| Registered signing **public** keys, institutions, subscriptions | Same | Keys: until revoked. The rest: until deleted |
| Console account email and password **hash** | Same | Until the account is deleted |
| Session token **hash** | Same | 14 days, or until you sign out |
| Audit log: for each authenticated call made with your API keys or console accounts — the time, who (the key's label or the account's email), the service, the method and path, the result code and the duration. No request or response bodies | Same | Until deleted |

`/v1/settlements/reconcile` and `/v1/settlements/bundle` are stateless: the
evidence and the policy arrive in the request, the verdict and the archive are
computed and returned, and nothing is written. A reviewer's case data never
rests on our disk, so there is nothing to leak later and nothing to serve stale.

Nothing in the table above expires except a free-tier record: whatever your
organisation stores here is kept until you ask for it to be deleted, and the
sandbox and production follow the same rule. **The proof file you downloaded
never expires** — that is the point of handing over a self-contained file rather
than a dashboard login.

## Accounts and sessions

The keyed API has no accounts — a bearer key is the whole credential, and the
free tier does not need even that. The Sandbox Console has them for the one
thing a key cannot do: let a person close the tab and come back. The narrow
reason it requires one is quota attribution, key rotation and abuse control,
each of which needs a durable identity. Not marketing consent.

Passwords are hashed with scrypt from `node:crypto` — per-account salt, cost
parameters stored alongside the digest so they can be raised later without
locking anyone out. There is no auth library: the only third-party package in
the service is the MySQL driver, and an auth library would be the second — in
the one place where code nobody here has read is least welcome.

Sessions are **stored, not stateless**. A signed self-contained cookie cannot be
revoked before it expires, which would make "sign out" a word the product used
without meaning. The cookie carries a random token and the database holds only
its hash, so a copy of the database cannot be replayed as a logged-in browser.
The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` behind TLS.

Sign-up and sign-in are rate-limited per address. A wrong password and an
unknown address return the same code and message — the distinction is useful
only to someone enumerating addresses.

**There is no password reset on this deployment**, because nothing here sends
mail. The sign-up screen says so rather than offering a link that would fail.

## Keys

Issued as `sk_test_…` in sandbox and `sk_live_…` in production. The prefix is
part of the key, so a sandbox key cannot be mistaken for a production one in a
log, a config file or a screenshot.

A key is shown **once**. Only its hash is stored, so it cannot be recovered — if
it is lost, mint another. Each key carries a label so a leak can be traced to
its holder.

Keyed records are isolated per org: another org's attestations are neither
readable nor enumerable, which `core/test/api.test.ts` asserts against a real
server rather than a mock.

## No wallet key enters this service

`bitcoind` holds the anchoring wallet and does the funding and the signing of
anchor transactions, so compromising this service does not compromise a
wallet. There is no mainnet hot wallet.

What the service does hold is its own ES256 key, with which it signs the
platform's settlement events, manifest verdicts and reserve-proof material;
the public half is published at `GET /v1/remit/meta`. The full-document route
also creates a one-shot key in the process to sign its reveal transaction; it
controls a dust output and is dropped after broadcast. Neither is a customer's
key, and neither can move funds.

## Rate limits

The free tier is capped **per address and service-wide**, so a botnet cannot
accomplish what a single caller cannot. A free anchor joins the ordinary shared
batch rather than triggering its own transaction, which means no caller can make
us spend a transaction fee on demand.

Sandbox key minting is capped per address.

Both return **429** with a `retry-after` header. A rate limit is reported as a
rate limit, not as a generic failure.

## Verifying contacts nothing

Verifying a proof file in the Playground happens entirely in the browser: no
document is uploaded, no digest is transmitted, and no StoneHash endpoint is
contacted — disconnect, and verification keeps working. The exceptions are
stated rather than hidden: the Playground's anchor panel talks to the free tier
(submit a digest, poll its status, download the proof), because that is what
anchoring is; the page reads `/v1/meta` once on load to show which chain this
is; and the public Proof-of-Reserves page fetches the snapshot it is asked to
verify.

This Developer Hub is the same: it ships under
`default-src 'none'; script-src 'self'`, loads no remote script, font or
stylesheet, and sends no analytics. There is nothing here that reports your
reading back to us.

## What we do not claim

Stated plainly, because the useful version of this page is the one that marks
its own boundaries.

- **We do not verify identity.** Issuer signatures *are* cryptographically
  verified — ECDSA P-256 over the canonical bytes of each evidence element — but
  a signature that verifies only means some key signed it. It does not mean the
  key belongs to who it says. Signature validity and issuer identity are
  reported as separate rows and are never merged, and the demonstration keys
  used by the sample evidence are pinned to the bottom of the trust ladder, so
  they report `DEMO_VALID` on the first row and `UNKNOWN_ISSUER` on the second
  however sound the arithmetic was. Their private halves are published, which
  is the clearest possible statement of what they prove.
- **We make no regulatory determination.** The settlement rules engine
  reconciles evidence against a policy you supply. `regulatoryDecision` is
  pinned to `NOT_EVALUATED`, and a test fails the build if it ever carries
  another value. Nothing here constitutes a compliance, AML or sanctions
  judgement.
- **We are not a certificate authority or a timestamping authority.** No
  accredited CA or TSA is involved.
- **"Not checked" is not "fine".** An unperformed check renders grey and says
  so. Chain inclusion reads `skip` until you confirm the transaction through a
  Bitcoin source you chose. A signature nobody verified reports `NOT CHECKED` rather
  than whatever status the document claimed for itself. Green for a check that
  never ran is how a verification UI tells its first lie, and the status colours
  are asserted by test.
- **A regtest proof is not a public proof.** On a private chain we mine the
  blocks, so no third party can confirm inclusion. Every proof file we issue
  carries `bitcoin_network`, and the verifier reports it, precisely so this
  cannot be quietly forgotten.

## Transport

Run behind TLS. The service speaks plain HTTP and expects a reverse proxy to
terminate TLS — there is no certificate handling in this process, and no
in-process TLS configuration to get wrong.

CORS is enabled only on the free-tier paths, because the Playground is served
from a different host in production. The keyed API is called from servers and
has no reason to be reachable from an arbitrary page.

## Dependencies

`@stonehash/attest-verify` has **zero** runtime dependencies, asserted by test:
no `node:` import, no `require`, no `process`, no `Buffer` in `src/`. A verifier
a regulator has to audit is only auditable if there is nothing underneath it.

The service itself runs on `node:http` and `node:crypto`; storage is
`node:sqlite`, or MySQL through the `mysql2` driver — the only third-party
package in the service, there because that is the engine banks run, and it
brings a handful of small transitive packages with it. The rest is Node and
our own workspace packages, so there is little to patch for a CVE in code we
do not call.

## Reporting something

If you find a flaw in the verification logic or the specification, the most
useful report is a proof file that verifies when it should not. The conformance
fixtures are the template — five that pass, three that must fail.

Contact: the address on [stonehash.com](https://stonehash.com).
