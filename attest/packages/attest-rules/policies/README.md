# Policies

A policy is **data**, not code. The engine reads one and produces a verdict; the
verdict carries the policy's version *and* a digest of its canonicalised bytes.
Editing a tolerance therefore changes the digest even if nobody remembers to
bump the version, so an old verdict can never be silently re-interpreted under
new rules.

## `settlement-match-v1.json`

The default used by the Bank Review scenarios.

| Field | Value | Why |
|---|---|---|
| `currencies` | `USD`, `USDC` | Which codes this policy will reconcile at all. |
| `unitOfAccountGroups` | `[["USD","USDC"]]` | **The substantive assumption.** Holding that a USDC amount settles a USD invoice at par is a claim about redemption and counterparty risk, not a fact. It gets its own field so a reviewer can see it and reject it — remove the group and the same evidence returns `MISMATCH` with `CROSS_CURRENCY_WITHOUT_FX`. |
| `amountTolerance` | `"0.00"` | Exact match. Trade finance reconciles to the cent; a tolerance here would hide the error class the workflow exists to surface. |
| `amountToleranceBps` | `0` | No relative band. |
| `fxReference` | `null` | With no FX source named, amounts from different units of account are refused rather than converted at an invented rate. Naming a source yields `PENDING` instead: conversion happens outside this engine, because pulling a time-varying rate would destroy reproducibility. |
| `settlementWindow` | `P3D` | Measured between timestamps **inside the evidence**, never against wall-clock time — see the engine's note on determinism. |
| `fees.deductible` | `false` | A short receipt is a mismatch, not an absorbed fee. Set `true` with a `maxBps` cap where the corridor deducts. |
| `splitPayments` | allowed, aggregated | Partial payments are normal in trade finance; the receipts must sum to the instructed amount. |
| `partyIDMatch` | `normalized` | "ACME Corp." and "Acme Corporation" are the same counterparty. `exact` is available where a corridor requires it. |
| `sourceTrustLevel` | `ATTESTED` | A `DEMO` key can produce a cryptographically valid signature while establishing nothing about who signed, so demo keys land on `UNKNOWN_ISSUER` rather than `VALID`. |
| `signatureRequiredElements` | payout, instruction, docs | **Not** the chain transfer. A public-ledger observation has no issuer to sign it — its authority is the chain, which the proof bundle establishes. Requiring a signature there would mean the issuer axis could never reach `VALID` for any real settlement. |
| `regulatoryFields` | 13 names | Checked for **presence only**. This is not a compliance determination — `regulatoryDecision` is typed to a single value, `NOT_EVALUATED`, so the engine cannot express one. |

## Adding a policy

Copy the file, change what you need, and keep the version string distinct. The
engine validates strictly and refuses anything it cannot evaluate
deterministically — an unsupported duration, a non-decimal tolerance, an unknown
trust level — rather than defaulting a field and changing verdicts invisibly.

## `corridor-vn-sg-v1.json`

The stricter policy for a cross-border corridor where a correspondent-banking
leg has been replaced by a stablecoin transfer between two licensed VASPs.

Differences from `settlement-match-v1`, and why each one:

| Field | Value | Why |
|---|---|---|
| `requireTravelRulePreflight` | `true` | FATF R.16 obliges the sending institution to transmit originator and beneficiary information to the receiving one. The policy turns that from a procedure into a per-payment check: approval must exist, be signed by the receiving VASP, and be timestamped **before** the funds moved. |
| `enforceFxQuoteWindow` | `true` | Gross settlement holds the customer to a locked rate for a stated window. A transfer landing outside it was priced on a rate they were never quoted — a reconciliation break, not a rounding detail. |
| `settlementIdRequiredIn` | 4 elements | The id that replaces the SWIFT UETR. Requiring each layer to *cite* it means the link between voucher, Travel Rule message and chain transaction is evidenced rather than asserted by a mapping table held elsewhere. |
| `splitPayments.allowed` | `false` | A partial transfer against a single authorised instruction is an exception on this corridor, not a normal case. |
| `settlementWindow` | `P2D` | Tighter than the generic policy: the point of the rail is that it settles in minutes. |
| `fxReference` | `bank-locked-quote` | The rate comes from the authorising bank's own quote, not a market feed. The engine does not convert — see the note on reproducibility below. |
| `currencies` | adds `VND`, `SGD` | The fiat legs appear in the evidence even though the on-chain leg is `USDC`. |

### What this policy does not do

It does not convert currencies. Pulling a rate would make the verdict depend on
an external, time-varying source, and two auditors running the same evidence a
month apart would get different answers. Where legs are in different units of
account the result is `PENDING` with `FX_CONVERSION_REQUIRED`, and the reviewer
converts and resubmits.

## Corridor fields are required, not optional

`requireTravelRulePreflight`, `enforceFxQuoteWindow` and
`settlementIdRequiredIn` must be present in **every** policy, including ones
that switch the controls off. A policy that merely omitted
`requireTravelRulePreflight` would evaluate exactly as if the control were
disabled — and a payment released before the receiving VASP approved it would
pass review because of a missing line in a configuration file. Validation
therefore rejects the omission rather than inferring an answer.

``settlement-match-v1`` sets all three to off/empty, because the generic policy is
for file and document evidence, where there is no corridor to control.
