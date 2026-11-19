/**
 * The six Bank Review scenarios, defined as transforms of one fixture.
 *
 * Separate hand-written files per scenario would differ in whatever the author
 * happened to type, so a verdict difference could come from an unintended data
 * difference rather than from the rule under test. One source plus an explicit
 * transform makes the delta exactly the one being demonstrated — and it is the
 * same mechanism the reviewer drives from the UI, so what they see is what the
 * tests pin.
 */
import { breakSignature, changeAmount, duplicateReceipt, removeDocument, splitPayout } from './tamper.ts';
import type { SettlementEvidence } from './types.ts';

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface Scenario {
  id: ScenarioId;
  /** Short label for the tab or list. */
  title: string;
  /** What a reviewer is meant to learn from running it. */
  teaches: string;
  /** Derive this scenario's evidence from the base fixture. */
  derive: (base: SettlementEvidence) => SettlementEvidence;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    title: 'Normal trade payment',
    teaches:
      'All six sources agree under the policy. Note that the verdict still asks for '
      + 'manual review: the data is synthetic and the keys are demonstration keys, so '
      + 'issuer identity and business finality cannot be satisfied.',
    derive: (base) => base,
  },
  {
    id: 'B',
    title: 'Amount mismatch',
    teaches:
      'The chain transfer is 2,000 short of the instructed amount against a zero '
      + 'tolerance. The finding names the field, the expected value, the actual value '
      + 'and the tolerance it exceeded — "amounts do not match" would not be actionable.',
    derive: (base) => changeAmount(base, 'chainTransfer', '48000.00'),
  },
  {
    id: 'C',
    title: 'Payout signature broken',
    teaches:
      'The digest and the chain data still verify; only the provider signature fails. '
      + 'Integrity passing while the issuer fails is precisely the combination a single '
      + 'green tick would hide.',
    derive: (base) => breakSignature(base, 'payoutReceipt'),
  },
  {
    id: 'D',
    title: 'Invoice missing',
    teaches:
      'The invoice is cited by number but not supplied. The result is INCOMPLETE, not '
      + 'INVALID — missing evidence calls for a request, forged evidence calls for '
      + 'escalation, and conflating them sends the reviewer down the wrong path.',
    derive: (base) => removeDocument(base, 'invoice'),
  },
  {
    id: 'E',
    title: 'Split payment',
    teaches:
      'Forty per cent then sixty per cent. Whether this reconciles depends entirely on '
      + 'whether the policy permits aggregation — the engine does not decide that, the '
      + 'policy does, and the policy version is recorded in the result either way.',
    derive: (base) => splitPayout(base, '20000.00', '30000.00'),
  },
  {
    id: 'F',
    title: 'Duplicate submission',
    teaches:
      'The same payout receipt, submitted twice. Nothing about the document is wrong — '
      + 'the digest matches and the signature verifies, because it is the receipt the '
      + 'provider signed. Integrity and issuer both pass and the payment still must not '
      + 'be released. This is the case that proves "the document is genuine" and "the '
      + 'transaction is approved" are two different questions.',
    derive: (base) => duplicateReceipt(base),
  },
];

export function scenario(id: ScenarioId): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}

/** Build one scenario's evidence from the base fixture. */
export function buildScenario(id: ScenarioId, base: SettlementEvidence): SettlementEvidence {
  return scenario(id).derive(base);
}
