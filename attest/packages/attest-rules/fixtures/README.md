# Scenario fixtures

`a-normal-trade-payment.json` is the only hand-written fixture. The other four
scenarios are produced from it by the **pure transforms** in `src/tamper.ts`:

| Scenario | Produced by | Expected verdict |
|---|---|---|
| A · normal | the fixture as-is | `matching: MATCH` |
| B · amount mismatch | `changeAmount(a, 'chainTransfer', '48000.00')` | `matching: MISMATCH`, naming field, expected, actual, tolerance |
| C · payout signature broken | `breakSignature(a, 'payoutReceipt')` | `issuer: INVALID` while `integrity: VALID` |
| D · invoice missing | `removeDocument(a, 'invoice')` | `completeness: INCOMPLETE` — distinct from forged |
| E · split payment | `splitPayout(a, '20000.00', '30000.00')` | `MATCH` when the policy aggregates, `PENDING` when it does not |

## Why derived rather than written out

If "normal" and "mismatch" were separate hand-authored files, they would differ
in whatever the author happened to type — and a verdict difference could come
from an unintended data difference rather than from the rule under test. One
source plus an explicit transform means the delta is exactly the one being
demonstrated, which is also the property the Bank Review workflow relies on: the
reviewer breaks the data and re-runs **the same policy version**.

## All data here is fabricated

No financial institution has certified any of it, no regulator has approved it,
and no funds moved. Signing keys are demonstration keys, which is why the issuer
axis reports `UNKNOWN_ISSUER` under a policy requiring `ATTESTED` trust even
when a signature verifies — signature validity and issuer identity are two
different results and the engine keeps them apart.
