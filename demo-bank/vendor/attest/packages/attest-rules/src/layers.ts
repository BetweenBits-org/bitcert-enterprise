/**
 * The three evidence layers, and who can rewrite each one.
 *
 * ## Why this table exists
 *
 * The first question a bank officer asks about anchoring is the right one: *we
 * already keep logs of all of this — what does this add?* Feature lists do not
 * answer it. The answer is specifically about **who holds each record and who
 * could therefore restate it**, and it is the only argument for putting anything
 * on a public chain at all.
 *
 * Layer 1 sits in the bank's core system. The bank can restate it — not that it
 * would, but a supervisor cannot rule it out from the record alone, which is why
 * they ask for independent corroboration. Layer 2 is held in two copies by two
 * VASPs, so either can restate its own copy and a dispute becomes one party's
 * word against the other's. Layer 3 cannot be restated by anybody, including us.
 *
 * That is the whole value, and it is narrow: anchoring does not make the data
 * true, and it does not make the payment compliant. It makes **later alteration
 * detectable**, which is a different and much smaller claim than vendors in this
 * space usually make.
 *
 * Exported as data so the sandbox renders it from the same source the
 * documentation uses, and so it cannot drift from what the engine checks.
 */

export interface EvidenceLayer {
  id: 1 | 2 | 3;
  name: string;
  /** Where the data physically lives. */
  heldBy: string;
  /** What a supervisor examines it for. */
  examinedFor: string;
  /** Representative contents. References and digests, never content, at layer 3. */
  contents: string[];
  /** Who is technically able to restate this record after the fact. */
  couldRestate: string;
  /** What independent corroboration exists for it. */
  corroboration: string;
}

export const EVIDENCE_LAYERS: EvidenceLayer[] = [
  {
    id: 1,
    name: 'Bank and institutional ledger',
    heldBy: 'The authorising bank\'s core system, and the receiving institution\'s',
    examinedFor: 'Foreign-exchange law, tax, source of funds, dispute resolution',
    contents: [
      'Contract, invoice, customs declaration — the originals',
      'Beneficial ownership, KYB and sanctions screening logs',
      'Local-currency debit and credit vouchers',
    ],
    couldRestate:
      'The institution that holds it. Not an allegation — a property of any single-party '
      + 'record, and the reason a supervisor asks for corroboration rather than taking it as given.',
    corroboration:
      'A digest of the commercial documents is committed at layer 3, so a later edit to the '
      + 'originals becomes detectable. The originals themselves never leave the institution.',
  },
  {
    id: 2,
    name: 'Travel Rule and VASP exchange',
    heldBy: 'The two licensed VASPs, over an encrypted channel between them',
    examinedFor: 'FATF R.16, MAS PSN02, and the record of what each party was told',
    contents: [
      'The IVMS 101 message — originator and beneficiary identification',
      'Counterparty wallet whitelist and the signed approval callback',
      'On-chain analytics risk scoring',
    ],
    couldRestate:
      'Either VASP, for its own copy. A dispute over what was transmitted becomes one '
      + 'party\'s record against the other\'s, with no third account to consult.',
    corroboration:
      'A digest of the IVMS 101 message and of the approval callback is committed at layer 3 — '
      + 'and only the digest. The identification data is what FATF obliges the two institutions '
      + 'to exchange privately; publishing it, even hashed without a salt, would convert a '
      + 'transmission duty into a permanent disclosure.',
  },
  {
    id: 3,
    name: 'Immutable commitment',
    heldBy: 'The settlement chain, and Bitcoin',
    examinedFor: 'That nothing above was altered after the fact',
    contents: [
      'Stablecoin transaction reference, amount, timestamp',
      'The settlement id that replaces the SWIFT UETR',
      'One salted 32-byte commitment per payment, aggregated into a daily Merkle root',
    ],
    couldRestate:
      'Nobody, including StoneHash. Rewriting it would require rewriting Bitcoin.',
    corroboration:
      'Self-corroborating, and that is the only reason it is here. It establishes that the '
      + 'layer 1 and layer 2 records existed in a particular state at a particular time — not '
      + 'that their contents are true, and not that the payment was lawful.',
  },
];

/**
 * What a supervisor does with all this, step by step.
 *
 * Written as a procedure rather than a capability claim, because the test of
 * this design is whether an auditor who has never heard of us can complete it
 * without our help.
 */
export const AUDIT_PROCEDURE: { step: number; who: string; action: string; needs: string }[] = [
  {
    step: 1,
    who: 'Supervisor',
    action: 'Names a payment — by settlement id, date or counterparty — and requests the file.',
    needs: 'Nothing from StoneHash.',
  },
  {
    step: 2,
    who: 'Bank',
    action: 'Produces the layer 1 originals it already holds, as it would for any enquiry.',
    needs: 'Its own records.',
  },
  {
    step: 3,
    who: 'Bank',
    action: 'Produces the evidence bundle for that settlement id, including the salt.',
    needs: 'The archive, downloaded when the payment settled. No live call to us.',
  },
  {
    step: 4,
    who: 'Supervisor',
    action: 'Recomputes the commitment from the bundle fields and the salt, and confirms it '
      + 'matches the leaf in the Merkle proof.',
    needs: 'SHA-256. Any implementation — ours, their own, or a published one.',
  },
  {
    step: 5,
    who: 'Supervisor',
    action: 'Folds the leaf through the Merkle proof to the root, and confirms the root is the '
      + 'value committed in the anchor transaction.',
    needs: 'The published verifier, or forty lines of their own code against the spec.',
  },
  {
    step: 6,
    who: 'Supervisor',
    action: 'Confirms the anchor transaction is in a block, through a Bitcoin source of their '
      + 'own choosing.',
    needs: 'Their own node, or any public explorer. Never ours — the point is that it '
      + 'does not have to be.',
  },
  {
    step: 7,
    who: 'Supervisor',
    action: 'Re-runs the stated policy version over the bundle and reproduces the same verdict, '
      + 'including which controls passed and which exceptions were raised.',
    needs: 'The policy file, which travels inside the bundle, and the published rules engine.',
  },
];

/**
 * What this does not establish — stated at the same prominence as the rest.
 *
 * The audience is a compliance function that will be held responsible for the
 * judgement. Overstating the scope here would not win the sale; it would lose
 * it at the second meeting, with the reviewer who checks.
 */
export const NOT_ESTABLISHED: { claim: string; reality: string }[] = [
  {
    claim: 'That the payment was lawful, or AML-suitable',
    reality:
      'Field coverage shows whether the data a form asks for is present. The judgement is the '
      + 'bank\'s and its supervisor\'s, and the engine is typed so it cannot express one.',
  },
  {
    claim: 'The legal identity of the originator or beneficiary',
    reality:
      'A verified signature proves a key signed specific bytes. Binding that key to an '
      + 'incorporated entity needs a certificate authority or an identity check, and is '
      + 'reported as a separate axis for exactly that reason.',
  },
  {
    claim: 'That the commercial documents are genuine',
    reality:
      'A digest commits what a document said. Whether the invoice describes a real shipment is '
      + 'a question for the parties and the inspection regime, not for arithmetic.',
  },
  {
    claim: 'A legally certified time',
    reality:
      'A Bitcoin block bounds when a commitment existed. It is not an RFC 3161 timestamp from '
      + 'an accredited authority, and where statutory time matters that service is combined '
      + 'with this one rather than replaced by it.',
  },
  {
    claim: 'That no payment was concealed',
    reality:
      'Anchoring makes alteration of submitted records evident. A payment never submitted '
      + 'leaves no trace to alter — proving a negative is outside what any commitment scheme '
      + 'offers.',
  },
  {
    claim: 'Any endorsement by a regulator or a named counterparty',
    reality:
      'No supervisor has reviewed or approved this design, and the counterparty institutions in '
      + 'the sandbox are placeholders. Using a real partner\'s name requires their written '
      + 'agreement.',
  },
];
