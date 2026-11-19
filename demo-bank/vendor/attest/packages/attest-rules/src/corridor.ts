/**
 * Corridor scenarios — the failures a supervisor reviewing a replaced
 * correspondent-banking leg actually asks about.
 *
 * The five generic scenarios in `scenarios.ts` exercise reconciliation: amounts,
 * signatures, missing documents. These exercise the controls that are specific
 * to moving a payment leg onto a stablecoin rail, and none of them is an amount
 * comparison. Each is produced from one fixture by a pure transform, for the
 * same reason as the generic set: the delta is then exactly the control under
 * test rather than whatever the author happened to type.
 */
import type { SettlementEvidence } from './types.ts';

export type CorridorScenarioId = 'N' | 'P' | 'Q' | 'W' | 'R';

export interface CorridorScenario {
  id: CorridorScenarioId;
  title: string;
  /** What the control is, in a sentence a banker would use. */
  control: string;
  /** What a reviewer learns by running it. */
  teaches: string;
  derive: (base: SettlementEvidence) => SettlementEvidence;
}

function clone(ev: SettlementEvidence): SettlementEvidence {
  return structuredClone(ev);
}
function tag(ev: SettlementEvidence, what: string): SettlementEvidence {
  ev.scenario = `${ev.scenario} + ${what}`;
  return ev;
}

export const CORRIDOR_SCENARIOS: CorridorScenario[] = [
  {
    id: 'N',
    title: 'Normal corridor payment',
    control: 'All six sources agree and every control was honoured.',
    teaches:
      'One settlement id runs through the bank approval, the payment instruction, the Travel '
      + 'Rule exchange, the on-chain transfer and the fiat credit. That is the function the SWIFT '
      + 'UETR performed, and it is what makes the five records one payment rather than five that '
      + 'look related.',
    derive: (base) => base,
  },
  {
    id: 'P',
    title: 'Funds released before Travel Rule approval',
    control: 'No treasury release before the receiving VASP accepts the originator information.',
    teaches:
      'The most consequential control on the corridor, and the one hardest to evidence with '
      + 'logs alone. Here the transfer is timestamped four minutes before the approval it was '
      + 'supposed to wait for. Note what else holds: the amounts still reconcile and every digest '
      + 'still verifies. A single pass/fail would show a clean payment.',
    derive: (base) => {
      const ev = clone(base);
      const tr = ev.elements.travelRule;
      const ct = ev.elements.chainTransfer;
      if (!tr || !ct) throw new Error('corridor P: fixture lacks travelRule or chainTransfer');
      // Move the transfer earlier rather than the approval later: this is how
      // the failure actually happens — someone releases while waiting.
      ct.observedAt = '2026-11-04T02:10:00Z';
      return tag(ev, 'transfer released before approval');
    },
  },
  {
    id: 'Q',
    title: 'Travel Rule exchange never completed',
    control: 'FATF R.16: originator and beneficiary information must reach the receiving VASP.',
    teaches:
      'The exchange is pending, not approved — the counterparty never accepted the transfer. '
      + 'Reported on the issuer axis rather than matching, because this is a question about who '
      + 'authorised the payment, not about whether the figures agree.',
    derive: (base) => {
      const ev = clone(base);
      const tr = ev.elements.travelRule;
      if (!tr) throw new Error('corridor Q: fixture lacks travelRule');
      tr.approvalStatus = 'PENDING';
      delete tr.approvalDigest;
      delete tr.approvedAt;
      return tag(ev, 'Travel Rule left pending');
    },
  },
  {
    id: 'W',
    title: 'Settled outside the locked FX quote',
    control: 'A gross-settled payment must land inside the window the customer was quoted.',
    teaches:
      'The quote expired at 02:35 and the transfer landed at 03:50, so the customer was charged '
      + 'on a rate they were never given. Invisible to a reconciliation that only compares '
      + 'amounts, because the USD figures match perfectly — the break is in the pricing, not the '
      + 'arithmetic.',
    derive: (base) => {
      const ev = clone(base);
      const ct = ev.elements.chainTransfer;
      if (!ct) throw new Error('corridor W: fixture lacks chainTransfer');
      ct.observedAt = '2026-11-04T03:50:00Z';
      return tag(ev, 'settled after the quote expired');
    },
  },
  {
    id: 'R',
    title: 'Refund with no link to the original',
    control: 'A return of funds must cite the settlement it reverses, and why.',
    teaches:
      'Funds coming back without the original reference is, to a foreign-exchange supervisor, an '
      + 'unexplained inbound transfer. A refund is modelled as a new settlement pointing back at '
      + 'the original, never as a reversal of it — mutating the original would destroy the record '
      + 'of what was first submitted, which is what the auditor came to see.',
    derive: (base) => {
      const ev = clone(base);
      ev.settlementId = 'VN-SG-20261104-0007-REFUND';
      ev.refundReasonCode = 'DOCS_INSUFFICIENT';
      // The omission being demonstrated: no relatedSettlementId.
      delete ev.relatedSettlementId;
      return tag(ev, 'refund without the original settlement id');
    },
  },
];

export function corridorScenario(id: CorridorScenarioId): CorridorScenario {
  const s = CORRIDOR_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown corridor scenario: ${id}`);
  return s;
}

export function buildCorridorScenario(
  id: CorridorScenarioId, base: SettlementEvidence,
): SettlementEvidence {
  return corridorScenario(id).derive(base);
}

/**
 * How each SWIFT artefact maps onto this evidence model.
 *
 * Exported as data because it is the first thing a banker needs in order to
 * read anything else here, and because keeping it beside the model means it
 * cannot drift from what the engine actually checks.
 */
export const SWIFT_MAPPING: {
  swift: string;
  here: string;
  note: string;
}[] = [
  {
    swift: 'UETR (unique end-to-end transaction reference)',
    here: 'settlementId',
    note: 'One id across all five records. Every layer must cite it, or the link is asserted '
      + 'by a mapping table rather than evidenced.',
  },
  {
    swift: 'MT103 :50: ordering customer / pacs.008 Dbtr',
    here: 'bankInstruction.debtor, and the originator inside the IVMS 101 message',
    note: 'The customer never holds a wallet, so the on-chain sender is the treasury. The '
      + 'originator travels in the Travel Rule exchange, not on the chain.',
  },
  {
    swift: 'MT103 :59: beneficiary customer / pacs.008 Cdtr',
    here: 'bankInstruction.creditor, and the beneficiary inside the IVMS 101 message',
    note: 'Likewise. The on-chain recipient is the receiving VASP\'s deposit address.',
  },
  {
    swift: 'Correspondent / intermediary institutions',
    here: 'travelRule.originatingVasp and travelRule.beneficiaryVasp',
    note: 'The two licensed institutions replace the correspondent chain. The Travel Rule '
      + 'exchange is what carries between them what the MT103 header carried.',
  },
  {
    swift: 'Settlement confirmation (MT900/910)',
    here: 'payoutReceipts[].ref, signed by the receiving VASP',
    note: 'Signature validity and issuer identity are reported separately: a signature that '
      + 'verifies against a demonstration key establishes nothing about who signed.',
  },
  {
    swift: 'Nostro/vostro reconciliation statement',
    here: 'chainTransfer, read from the settlement chain',
    note: 'Read from the ledger rather than from a statement about it. This is the one leg '
      + 'neither institution can restate.',
  },
  {
    swift: 'Foreign-exchange approval and central-bank reporting',
    here: 'bankApproval.approvalRef and bankApproval.regulatorReportRef',
    note: 'Stays with the authorising bank, which holds the legal duty. Only the reference '
      + 'is committed.',
  },
  {
    swift: 'SWIFT message archive (the audit trail itself)',
    here: 'the evidence bundle, plus a salted commitment anchored to Bitcoin',
    note: 'The substantive difference. A message archive is held by its operator and can be '
      + 'restated by whoever holds it. The anchor cannot be restated by anyone, including us.',
  },
];
