/**
 * The matching engine.
 *
 * ## Determinism is the product
 *
 * `evaluate()` is a pure function of `(evidence, policy)`. It reads no clock,
 * opens no socket, consults no environment and holds no state. The same inputs
 * produce byte-identical verdicts on any machine, today and in five years —
 * which is the only reason a reviewer, an auditor and a supervisor can
 * independently re-run it and compare answers.
 *
 * Two consequences worth stating, because they look like omissions:
 *
 * - **No `Date.now()`.** The settlement window is measured between timestamps
 *   that travel *inside* the evidence. A window evaluated against wall-clock
 *   time would give different answers on different days from the same inputs,
 *   which would make every stored verdict unreproducible.
 * - **No pass/fail.** The engine reconciles evidence across six axes and says
 *   whether a human has to look. Whether a payment is acceptable is a judgement
 *   about AML risk, counterparty and jurisdiction that this code has no standing
 *   to make, so it cannot express it.
 */
import { abs, add, cmp, formatDecimal, isZero, parseDecimal, sub, bps } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import { durationToMs, partyEquals, policyDigest, sameUnitOfAccount, trustAtLeast, validatePolicy } from './policy.ts';
import type {
  AxisName, CompletenessState, Finding, FinalityState, IntegrityState, IssuerState,
  MatchingResult, MatchingState, Policy, RegulatoryState, Severity, SettlementEvidence,
  Signature,
} from './types.ts';

/** Element keys, in the order the six-element model numbers them. */
const ELEMENTS = [
  'chainTransfer', 'payoutReceipts', 'bankInstruction', 'commercialDocs',
  'travelRule', 'bankApproval',
] as const;

class Findings {
  readonly all: Finding[] = [];
  add(f: Finding): void { this.all.push(f); }
  for(axis: AxisName): Finding[] { return this.all.filter((f) => f.axis === axis); }
  has(code: string): boolean { return this.all.some((f) => f.code === code); }
  /** Any finding on this axis that must gate the verdict. */
  blocks(axis: AxisName): boolean {
    return this.all.some((f) => f.axis === axis && f.severity === 'blocking');
  }
  /** Any finding on this axis that leaves it inconclusive. */
  warns(axis: AxisName): boolean {
    return this.all.some((f) => f.axis === axis && f.severity === 'warning');
  }
}

function note(
  axis: AxisName, code: string, severity: Severity, detail: string,
  extra: Partial<Finding> = {},
): Finding {
  return { axis, code, severity, detail, ...extra };
}

/**
 * Evaluate settlement evidence against a policy.
 *
 * Throws only on inputs the engine cannot interpret at all — a malformed policy,
 * or an amount that is not a decimal string. Everything else is a finding, not
 * an exception: a reviewer needs the verdict, not a stack trace.
 */
export function evaluate(evidence: SettlementEvidence, policy: Policy): MatchingResult {
  validatePolicy(policy);
  const f = new Findings();
  const el = evidence.elements ?? {};

  // ── Completeness ─────────────────────────────────────────────────────────
  // Runs first because the other axes have to know what they are missing.
  // Crucially, absent evidence is never reported as contradicted evidence.
  const present = new Set<string>();
  for (const key of ELEMENTS) {
    const v = (el as Record<string, unknown>)[key];
    const there = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
    if (there) present.add(key);
  }
  for (const req of policy.requiredElements) {
    if (!present.has(req)) {
      f.add(note('completeness', 'ELEMENT_MISSING', 'blocking',
        `${req} is required by ${policy.policyVersion} but was not supplied`,
        { element: req }));
    }
  }
  // A document cited by number but not attached is a request-this case, not a
  // forgery case. The distinction drives what the reviewer does next.
  for (const cited of el.commercialDocs?.citedOnly ?? []) {
    f.add(note('completeness', 'DOCUMENT_CITED_NOT_ATTACHED', 'blocking',
      `${cited} was referenced by number but the document itself was not supplied`,
      { element: 'commercialDocs', field: cited }));
  }

  // ── Integrity ────────────────────────────────────────────────────────────
  // `digestVerified === undefined` means nobody checked, which is reported as
  // NOT_CHECKED rather than quietly treated as fine.
  let checked = 0;
  let integrityFailed = false;
  for (const key of ELEMENTS) {
    const items = toArray((el as Record<string, unknown>)[key]);
    for (const item of items) {
      if (item.digestVerified === true) { checked++; continue; }
      if (item.digestVerified === false) {
        integrityFailed = true;
        f.add(note('integrity', 'DIGEST_MISMATCH', 'blocking',
          `${key}: submitted bytes do not hash to the committed digest`,
          { element: key, field: 'digest', expected: item.digest }));
      } else if (item.digest !== undefined) {
        f.add(note('integrity', 'DIGEST_NOT_CHECKED', 'warning',
          `${key}: a digest is declared but the original was not supplied to check it`,
          { element: key, field: 'digest' }));
      }
    }
  }
  // Axis states are derived after every rule has run — see the note below the
  // corridor call. Only the raw observations are collected here.

  // ── Issuer ───────────────────────────────────────────────────────────────
  // Signature validity and issuer identity are evaluated as two things. A
  // demonstration key can produce a cryptographically perfect signature while
  // establishing nothing about who signed, and merging the two is how a review
  // screen misleads without stating anything false.
  let sigInvalid = false;
  let identityUnknown = false;
  let sigValid = 0;
  for (const key of ELEMENTS) {
    for (const item of toArray((el as Record<string, unknown>)[key])) {
      const sig: Signature | undefined = item.signature;
      if (!sig || sig.status === 'ABSENT') {
        // Only elements the policy says must be signed. A public-ledger
        // observation has no issuer, so its lack of a signature is not a gap.
        if (present.has(key) && policy.signatureRequiredElements.includes(key)) {
          identityUnknown = true;
          f.add(note('issuer', 'SIGNATURE_ABSENT', 'warning',
            `${key}: no issuer signature was supplied, so its origin is unestablished`,
            { element: key }));
        }
        continue;
      }
      /*
       * A status nobody computed is not a result.
       *
       * `checked` is set only by `verifyEvidenceSignatures`. Before it existed
       * this branch did not, and a fixture carrying `"status": "VALID"` was
       * counted as a verified signature — the Bank Review screen showed
       * `ISSUER VALID` without any cryptography having run. Treating an
       * unmarked signature as unchecked is the same rule the rest of the
       * product follows for link C2: not checked is not fine.
       */
      if (sig.checked !== true) {
        identityUnknown = true;
        f.add(note('issuer', 'SIGNATURE_NOT_CHECKED', 'warning',
          `${key}: the signature was not verified, so its declared status `
          + `(${sig.status}) carries no weight. Run verifyEvidenceSignatures() first.`,
          { element: key, field: 'signature', actual: sig.status }));
        continue;
      }
      if (sig.status === 'UNKNOWN_KEY') {
        identityUnknown = true;
        f.add(note('issuer', 'SIGNATURE_UNKNOWN_KEY', 'warning',
          `${key}: the signature names key ${sig.keyId ?? '(unnamed)'}, which is not in the `
          + 'keyring, so neither its validity nor its signer could be established',
          { element: key, field: 'keyId', actual: sig.keyId }));
        continue;
      }
      if (sig.status === 'INVALID') {
        sigInvalid = true;
        f.add(note('issuer', 'SIGNATURE_INVALID', 'blocking',
          `${key}: the issuer signature does not verify against the declared key`,
          { element: key, field: 'signature', expected: sig.keyId }));
        continue;
      }
      // VALID or DEMO_VALID: the cryptography passed. Identity is separate.
      sigValid++;
      if (!trustAtLeast(sig.trustLevel, policy.sourceTrustLevel)) {
        identityUnknown = true;
        f.add(note('issuer', 'ISSUER_TRUST_INSUFFICIENT', 'warning',
          `${key}: signature verifies, but the key's trust level `
          + `(${sig.trustLevel ?? 'unset'}) is below the policy's required ${policy.sourceTrustLevel}, `
          + `so the signer's identity is not established`,
          { element: key, field: 'trustLevel', expected: policy.sourceTrustLevel, actual: sig.trustLevel }));
      }
    }
  }
  // ── Matching ─────────────────────────────────────────────────────────────
  const matchingBase = evaluateMatching(evidence, policy, f, present);

  // ── Corridor controls ────────────────────────────────────────────────────
  // What makes a stablecoin leg auditable the way an MT103 was. Each of these
  // turns a control that normally lives in a policy document into something a
  // supervisor can confirm for one specific payment.
  evaluateCorridor(evidence, policy, f);

  // ── Axis states, derived from every finding ──────────────────────────────
  //
  // Derived here rather than where each rule runs, because the corridor checks
  // add findings to `integrity`, `issuer` and `matching` after those axes would
  // otherwise have been settled. Computing a state early and appending findings
  // later produced the worst possible outcome: a blocking finding sitting under
  // an axis that still read VALID. The findings are the single source of truth.
  const integrity: IntegrityState =
    integrityFailed || f.blocks('integrity') ? 'INVALID'
      : checked > 0 ? 'VALID' : 'NOT_CHECKED';

  const issuer: IssuerState =
    sigInvalid || f.blocks('issuer') ? 'INVALID'
      : identityUnknown || f.warns('issuer') || sigValid === 0 ? 'UNKNOWN_ISSUER' : 'VALID';

  // A blocking corridor finding is a positive disagreement, so it outranks the
  // `PENDING` that `evaluateMatching` may have returned for undecidability.
  const matching: MatchingState =
    f.blocks('matching') ? 'MISMATCH' : matchingBase;

  // ── Regulatory mapping ───────────────────────────────────────────────────
  // Presence of fields a form asks for. Never a compliance determination —
  // `regulatoryDecision` below is typed to a single value for that reason.
  const supplied = collectRegulatoryFields(evidence);
  const missingFields = policy.regulatoryFields.filter((k) => !supplied.has(k));
  for (const k of missingFields) {
    f.add(note('regulatoryMapping', 'REGULATORY_FIELD_MISSING', 'info',
      `${k} is on the policy's submission checklist but is not present in this evidence`,
      { field: k }));
  }
  // Synthetic data can never carry a real regulatory submission, so coverage is
  // reported as requiring review regardless of how complete it looks.
  const regulatoryMapping: RegulatoryState =
    evidence.dataMode === 'SYNTHETIC' ? 'REVIEW_REQUIRED'
      : missingFields.length > 0 ? 'MISSING' : 'PRESENT';
  if (evidence.dataMode === 'SYNTHETIC') {
    f.add(note('regulatoryMapping', 'SYNTHETIC_DATA', 'warning',
      'this evidence is synthetic, so field coverage cannot stand in for a real submission',
      {}));
  }

  // ── Business finality ────────────────────────────────────────────────────
  // Did the paying institution actually confirm the funds moved? Synthetic
  // evidence is forced to DEMO_ONLY by the data itself, not by a UI label.
  const receipts = el.payoutReceipts ?? [];
  const confirmedBySource = receipts.length > 0
    // `checked` for the same reason as the issuer axis above: a receipt whose
    // signature nobody verified cannot be the thing that establishes that
    // money moved.
    && receipts.every((r) => r.signature && r.signature.checked === true
      && (r.signature.status === 'VALID')
      && trustAtLeast(r.signature.trustLevel, policy.sourceTrustLevel));
  const businessFinality: FinalityState =
    evidence.dataMode === 'SYNTHETIC' ? 'DEMO_ONLY'
      : confirmedBySource ? 'VERIFIED_BY_SOURCE' : 'UNVERIFIED';
  if (businessFinality === 'DEMO_ONLY') {
    f.add(note('businessFinality', 'DEMO_ONLY', 'warning',
      'no funds moved: this is synthetic evidence for demonstration', {}));
  } else if (businessFinality === 'UNVERIFIED') {
    f.add(note('businessFinality', 'PAYOUT_UNCONFIRMED', 'blocking',
      'no payout confirmation from the paying institution carries sufficient issuer trust', {}));
  }

  const completeness: CompletenessState =
    f.for('completeness').some((x) => x.severity === 'blocking') ? 'INCOMPLETE' : 'COMPLETE';

  // A human looks whenever any axis is anything other than cleanly satisfied.
  // Erring toward review is the correct bias: a missed exception costs more than
  // a redundant look.
  const manualReviewRequired =
    integrity !== 'VALID' || issuer !== 'VALID' || matching !== 'MATCH'
    || completeness !== 'COMPLETE' || regulatoryMapping !== 'PRESENT'
    || businessFinality !== 'VERIFIED_BY_SOURCE';

  return {
    policyVersion: policy.policyVersion,
    policyDigest: policyDigest(policy),
    scenario: evidence.scenario,
    dataMode: evidence.dataMode,
    axes: {
      integrity: { state: integrity, findings: f.for('integrity') },
      issuer: { state: issuer, findings: f.for('issuer') },
      matching: { state: matching, findings: f.for('matching') },
      completeness: { state: completeness, findings: f.for('completeness') },
      regulatoryMapping: { state: regulatoryMapping, findings: f.for('regulatoryMapping') },
      businessFinality: { state: businessFinality, findings: f.for('businessFinality') },
    },
    findings: f.all,
    manualReviewRequired,
    regulatoryDecision: 'NOT_EVALUATED',
  };
}

/**
 * Corridor controls: the settlement id, the Travel Rule pre-flight gate, and
 * the FX quote window.
 *
 * These are what a supervisor reviewing a replaced correspondent-banking leg
 * actually asks about, and none of them is an amount comparison — which is why
 * they sit apart from the matching rules.
 *
 * Findings land on `matching` for the ones that break reconciliation between
 * layers, and on `issuer` for the Travel Rule, because an unapproved or
 * unsigned exchange is a question about who authorised the transfer rather than
 * about whether the figures agree.
 */
function evaluateCorridor(ev: SettlementEvidence, policy: Policy, f: Findings): void {
  const el = ev.elements ?? {};
  const tr = el.travelRule;
  const approval = el.bankApproval;

  // ── One id across every layer ──────────────────────────────────────────
  // Without it the bank voucher, the Travel Rule message and the chain
  // transaction are three records that merely look related. This is the
  // function the SWIFT UETR performed.
  if (policy.settlementIdRequiredIn.length > 0 && !ev.settlementId) {
    f.add(note('matching', 'SETTLEMENT_ID_MISSING', 'blocking',
      'no settlement id: there is nothing tying the bank voucher, the Travel Rule message and '
      + 'the chain transaction to one payment. On SWIFT this is what the UETR carries.',
      { field: 'settlementId' }));
  } else if (ev.settlementId) {
    // Each named element must actually cite it, or the link is asserted rather
    // than evidenced.
    const cites: Record<string, string | undefined> = {
      bankInstruction: el.bankInstruction?.ref,
      bankApproval: approval?.approvalRef,
      chainTransfer: el.chainTransfer?.txRef,
      payoutReceipts: el.payoutReceipts?.[0]?.ref,
      commercialDocs: el.commercialDocs?.invoiceRef,
    };
    for (const key of policy.settlementIdRequiredIn) {
      const sid = ev.settlementId;
      const memo = el.chainTransfer?.settlementIdMemo;
      // The chain leg carries the id in a memo or derived commitment rather
      // than in the txid, so it is checked against that field.
      const carried = key === 'chainTransfer'
        ? memo === sid || cites[key]?.includes(sid)
        : cites[key]?.includes(sid);
      if (!carried) {
        f.add(note('matching', 'SETTLEMENT_ID_NOT_CARRIED', 'warning',
          `${key} does not cite settlement id ${sid}, so this layer cannot be tied to the `
          + 'payment without trusting a mapping held somewhere else',
          { element: key, field: 'settlementId', expected: sid, actual: cites[key] ?? memo }));
      }
    }
  }

  // ── Travel Rule, FATF R.16 ─────────────────────────────────────────────
  if (policy.requireTravelRulePreflight) {
    if (!tr) {
      f.add(note('issuer', 'TRAVEL_RULE_MISSING', 'blocking',
        'no Travel Rule exchange is evidenced. A transfer between VASPs above the threshold '
        + 'requires originator and beneficiary information to have been transmitted to the '
        + 'receiving institution.',
        { element: 'travelRule' }));
    } else {
      if (tr.approvalStatus !== 'APPROVED') {
        f.add(note('issuer', 'TRAVEL_RULE_NOT_APPROVED', 'blocking',
          `the Travel Rule exchange is ${tr.approvalStatus}, not APPROVED, so the receiving `
          + 'VASP had not accepted the transfer when it was made',
          { element: 'travelRule', field: 'approvalStatus',
            expected: 'APPROVED', actual: tr.approvalStatus }));
      }
      if (!tr.approvalDigest) {
        f.add(note('issuer', 'TRAVEL_RULE_APPROVAL_UNSIGNED', 'warning',
          'the approval is asserted but no signed callback from the receiving VASP is evidenced, '
          + 'so the pre-flight gate rests on our own record of it',
          { element: 'travelRule', field: 'approvalDigest' }));
      }

      // The pre-flight check, as arithmetic. "We do not release funds before the
      // receiving VASP approves" is a claim about a procedure; an approval
      // timestamped before the transfer is a fact about this payment.
      const movedAt = el.chainTransfer?.observedAt;
      if (tr.approvedAt && movedAt) {
        const delta = Date.parse(movedAt) - Date.parse(tr.approvedAt);
        if (Number.isNaN(delta)) {
          f.add(note('issuer', 'TRAVEL_RULE_TIMESTAMP_UNPARSEABLE', 'warning',
            'a Travel Rule timestamp is not a parseable instant, so the pre-flight gate was not '
            + 'evaluated', { element: 'travelRule', expected: tr.approvedAt, actual: movedAt }));
        } else if (delta < 0) {
          f.add(note('issuer', 'PREFLIGHT_VIOLATED', 'blocking',
            'the funds moved before the receiving VASP approved the Travel Rule exchange. The '
            + 'transfer was made without the counterparty having accepted the originator and '
            + 'beneficiary information.',
            { element: 'travelRule', field: 'approvedAt',
              expected: `approval before ${movedAt}`, actual: tr.approvedAt }));
        }
      } else if (tr.approvalStatus === 'APPROVED') {
        f.add(note('issuer', 'PREFLIGHT_NOT_EVALUATED', 'warning',
          'the approval and transfer timestamps are not both present, so whether approval '
          + 'preceded the transfer could not be established',
          { element: 'travelRule' }));
      }

      // The address the counterparty whitelisted must be the one that was paid.
      const paidTo = el.chainTransfer?.toAddress;
      if (tr.approvedBeneficiaryAddress && paidTo
        && tr.approvedBeneficiaryAddress !== paidTo) {
        f.add(note('matching', 'BENEFICIARY_ADDRESS_NOT_APPROVED', 'blocking',
          'the funds went to an address other than the one the receiving VASP whitelisted',
          { element: 'chainTransfer', field: 'toAddress',
            expected: tr.approvedBeneficiaryAddress, actual: paidTo }));
      }
    }
  }

  // ── FX quote window ────────────────────────────────────────────────────
  // Gross settlement holds the customer to a rate for a stated window. A
  // transfer landing outside it was priced on a rate they never agreed to.
  if (policy.enforceFxQuoteWindow && approval?.fxQuote) {
    const movedAt = el.chainTransfer?.observedAt;
    const { quotedAt, validUntil, pair, rate } = approval.fxQuote;
    if (movedAt) {
      const t = Date.parse(movedAt);
      if (!Number.isNaN(t) && !Number.isNaN(Date.parse(validUntil)) && t > Date.parse(validUntil)) {
        f.add(note('matching', 'FX_QUOTE_EXPIRED', 'blocking',
          `the transfer settled after the locked ${pair} quote of ${rate} expired, so it was `
          + 'priced on a rate the customer was not quoted',
          { element: 'bankApproval', field: 'fxQuote.validUntil',
            expected: validUntil, actual: movedAt }));
      }
      if (!Number.isNaN(Date.parse(quotedAt)) && t < Date.parse(quotedAt)) {
        f.add(note('matching', 'FX_QUOTE_AFTER_SETTLEMENT', 'blocking',
          'the quote is timestamped after the transfer it supposedly priced',
          { element: 'bankApproval', field: 'fxQuote.quotedAt',
            expected: `before ${movedAt}`, actual: quotedAt }));
      }
    }
  }

  // ── Refunds ────────────────────────────────────────────────────────────
  // A return of funds without the original reference and a reason is, to a
  // foreign-exchange supervisor, an unexplained inbound transfer.
  if (ev.refundReasonCode && !ev.relatedSettlementId) {
    f.add(note('matching', 'REFUND_WITHOUT_ORIGINAL', 'blocking',
      'a refund reason is given but no original settlement id, so the return cannot be matched '
      + 'to the payment it reverses and reads as an unexplained inbound transfer',
      { field: 'relatedSettlementId' }));
  }
  if (ev.relatedSettlementId && !ev.refundReasonCode) {
    f.add(note('matching', 'REFUND_WITHOUT_REASON', 'warning',
      'this settlement points back at another but states no reason code, which a supervisor '
      + 'reviewing the corridor will ask for',
      { field: 'refundReasonCode' }));
  }
}

/**
 * Reconcile amounts, currencies, parties, references and timing.
 *
 * `PENDING` is a distinct outcome from `MISMATCH`: it means the policy cannot
 * decide yet — split payments that do not sum, or evidence the policy needs but
 * has not received — whereas `MISMATCH` means two sources positively disagree.
 */
function evaluateMatching(
  ev: SettlementEvidence, policy: Policy, f: Findings, present: Set<string>,
): MatchingState {
  const el = ev.elements ?? {};
  const instruction = el.bankInstruction;
  const transfer = el.chainTransfer;
  const receipts = el.payoutReceipts ?? [];
  const docs = el.commercialDocs;

  // Without an instruction there is no authoritative amount to reconcile to.
  if (!instruction) {
    f.add(note('matching', 'NO_REFERENCE_AMOUNT', 'warning',
      'no bank instruction was supplied, so there is no authorised amount to reconcile against', {}));
    return 'PENDING';
  }

  const expected = parseDecimal(instruction.amount, 'bankInstruction.amount');
  let pending = false;
  let mismatch = false;

  // Currency. A policy with no FX reference refuses cross-currency matching
  // outright rather than inventing a rate.
  const currencies = new Set<string>([instruction.currency]);
  if (transfer) currencies.add(transfer.currency);
  for (const r of receipts) currencies.add(r.currency);
  for (const c of currencies) {
    if (!policy.currencies.includes(c)) {
      mismatch = true;
      f.add(note('matching', 'CURRENCY_NOT_PERMITTED', 'blocking',
        `${c} is not in the policy's permitted currencies`,
        { field: 'currency', expected: policy.currencies.join(','), actual: c }));
    }
  }
  // Amounts only compare directly when every code is one unit of account under
  // the policy. Codes from different groups need a rate, and a policy with no FX
  // reference refuses rather than inventing one.
  const base = instruction.currency;
  const foreign = [...currencies].filter((c) => !sameUnitOfAccount(c, base, policy));
  if (foreign.length > 0) {
    if (policy.fxReference === null) {
      mismatch = true;
      f.add(note('matching', 'CROSS_CURRENCY_WITHOUT_FX', 'blocking',
        `evidence spans ${base} and ${foreign.join(', ')}, which are different units of account `
        + 'under this policy, and no FX reference is declared — the amounts cannot be compared',
        { field: 'currency', expected: base, actual: foreign.join(',') }));
    } else {
      // Conversion itself is out of scope for this engine: pulling a rate would
      // make the verdict depend on an external, time-varying source and destroy
      // reproducibility. A reviewer converts and re-submits.
      pending = true;
      f.add(note('matching', 'FX_CONVERSION_REQUIRED', 'warning',
        `evidence spans ${base} and ${foreign.join(', ')}; the policy names `
        + `${policy.fxReference} as its FX reference, but conversion is performed outside this `
        + 'engine so the amounts are not reconciled here',
        { field: 'currency', expected: base, actual: foreign.join(',') }));
    }
  }

  const tolerance = toleranceFor(expected, policy);

  // Chain transfer against the instruction.
  if (transfer) {
    compareAmount(f, 'chainTransfer', 'amount', expected, parseDecimal(transfer.amount, 'chainTransfer.amount'),
      tolerance, policy) || (mismatch = true);
  } else if (policy.requiredElements.includes('chainTransfer')) {
    pending = true;
  }

  /*
   * Duplicate submission, checked before the split rules get a chance to
   * explain it away.
   *
   * Two copies of one receipt would otherwise surface as SPLIT_NOT_ALLOWED or
   * as a sum that came to twice the instruction — both true statements about
   * the arithmetic and both the wrong reason. A reviewer told "amounts do not
   * add up" goes looking for a missing payment; a reviewer told "this
   * reference appears twice" goes looking for a double release.
   */
  const refCounts = new Map<string, number>();
  for (const r of receipts) {
    if (r.ref) refCounts.set(r.ref, (refCounts.get(r.ref) ?? 0) + 1);
  }
  let duplicated = false;
  for (const [ref, count] of refCounts) {
    if (count < 2) continue;
    mismatch = true;
    duplicated = true;
    f.add(note('matching', 'DUPLICATE_PAYOUT_REF', 'blocking',
      `payout reference ${ref} is presented ${count} times; one settlement cannot discharge `
      + 'the same obligation more than once',
      { element: 'payoutReceipts', field: 'ref', expected: `${ref} once`, actual: `${ref} x${count}` }));
  }

  // Payout receipts. One is a simple comparison; several is a split payment,
  // and whether that reconciles is the policy's call, not the engine's.
  if (receipts.length === 1) {
    compareAmount(f, 'payoutReceipts', 'amount', expected,
      parseDecimal(receipts[0]!.amount, 'payoutReceipts[0].amount'), tolerance, policy) || (mismatch = true);
  } else if (receipts.length > 1) {
    if (!policy.splitPayments.allowed) {
      mismatch = true;
      f.add(note('matching', 'SPLIT_NOT_ALLOWED', 'blocking',
        `${receipts.length} payout receipts were supplied but the policy does not permit split payments`,
        { element: 'payoutReceipts', actual: String(receipts.length) }));
    } else if (!policy.splitPayments.aggregate) {
      // Allowed but not aggregated: no single receipt is expected to match the
      // whole, and the policy gives no rule for combining them. Undecidable.
      pending = true;
      f.add(note('matching', 'SPLIT_AGGREGATION_DISABLED', 'warning',
        `${receipts.length} payout receipts were supplied; the policy permits splits but does not `
        + 'aggregate them, so no single receipt can be reconciled to the instructed amount',
        { element: 'payoutReceipts', actual: String(receipts.length) }));
    } else if (duplicated) {
      /*
       * No sum is reported for a set that counts one payment twice.
       *
       * The arithmetic would be sound — two 50,000 receipts really do total
       * 100,000 against an instructed 50,000 — and the conclusion would be
       * nonsense: there is no 50,000 overpayment to investigate. A reviewer
       * handed AMOUNT_MISMATCH alongside the duplicate goes looking for a
       * second transfer that was never made. The duplicate has to be resolved
       * before any total means anything.
       */
      f.add(note('matching', 'AGGREGATION_SKIPPED_DUPLICATE', 'info',
        'the payout total was not reconciled: the set repeats a reference, so its sum '
        + 'counts one payment more than once',
        { element: 'payoutReceipts', actual: `${receipts.length} receipts, ${refCounts.size} distinct` }));
    } else {
      let total: Decimal = parseDecimal('0', 'sum');
      for (const [i, r] of receipts.entries()) {
        total = add(total, parseDecimal(r.amount, `payoutReceipts[${i}].amount`));
      }
      if (!compareAmount(f, 'payoutReceipts', 'sum', expected, total, tolerance, policy)) mismatch = true;
    }
  } else if (policy.requiredElements.includes('payoutReceipts')) {
    pending = true;
  }

  // Commercial documents, where an amount was supplied at all.
  if (docs?.amount !== undefined) {
    if (!compareAmount(f, 'commercialDocs', 'amount', expected,
      parseDecimal(docs.amount, 'commercialDocs.amount'), tolerance, policy)) mismatch = true;
  }

  // Reference numbers must tie the instruction to the commercial basis.
  if (docs?.invoiceRef !== undefined && instruction.ref !== undefined) {
    // The instruction cites the invoice; an instruction that references nothing
    // identifiable cannot be matched to a commercial transaction.
    const cited = instruction.ref === docs.invoiceRef
      || (instruction.iso20022Fields ?? []).includes(docs.invoiceRef);
    if (!cited && docs.invoiceRef !== instruction.ref) {
      f.add(note('matching', 'REFERENCE_NOT_LINKED', 'warning',
        `the bank instruction (${instruction.ref}) does not cite the invoice reference `
        + `(${docs.invoiceRef}), so the payment is not tied to this commercial basis`,
        { field: 'ref', expected: docs.invoiceRef, actual: instruction.ref }));
    }
  }

  // Parties.
  if (docs && (instruction.debtor || instruction.creditor)) {
    if (docs.buyer && instruction.debtor
      && !partyEquals(docs.buyer, instruction.debtor, policy.partyIDMatch)) {
      mismatch = true;
      f.add(note('matching', 'PARTY_MISMATCH', 'blocking',
        `the invoice buyer and the instruction debtor are different parties under ${policy.partyIDMatch} matching`,
        { field: 'debtor', expected: docs.buyer, actual: instruction.debtor }));
    }
    if (docs.seller && instruction.creditor
      && !partyEquals(docs.seller, instruction.creditor, policy.partyIDMatch)) {
      mismatch = true;
      f.add(note('matching', 'PARTY_MISMATCH', 'blocking',
        `the invoice seller and the instruction creditor are different parties under ${policy.partyIDMatch} matching`,
        { field: 'creditor', expected: docs.seller, actual: instruction.creditor }));
    }
  }

  // Settlement window, measured between timestamps carried in the evidence.
  // Absent timestamps mean the window was not evaluated, not that it passed.
  const windowMs = durationToMs(policy.settlementWindow);
  const from = instruction.approvedAt;
  const to = transfer?.observedAt ?? receipts[receipts.length - 1]?.paidAt;
  if (from && to) {
    const delta = Date.parse(to) - Date.parse(from);
    if (Number.isNaN(delta)) {
      f.add(note('matching', 'TIMESTAMP_UNPARSEABLE', 'warning',
        'a settlement timestamp is not a parseable instant, so the window was not evaluated',
        { expected: from, actual: to }));
    } else if (delta < 0) {
      mismatch = true;
      f.add(note('matching', 'SETTLEMENT_BEFORE_APPROVAL', 'blocking',
        'the funds moved before the bank instruction was approved',
        { field: 'approvedAt', expected: from, actual: to }));
    } else if (delta > windowMs) {
      mismatch = true;
      f.add(note('matching', 'SETTLEMENT_WINDOW_EXCEEDED', 'blocking',
        `settlement took longer than the policy's ${policy.settlementWindow} window`,
        { field: 'settlementWindow', expected: policy.settlementWindow,
          actual: `${Math.round(delta / 3_600_000)}h` }));
    }
  } else if (present.has('chainTransfer')) {
    f.add(note('matching', 'WINDOW_NOT_EVALUATED', 'info',
      'the settlement window was not evaluated because the evidence carries no comparable timestamps', {}));
  }

  return mismatch ? 'MISMATCH' : pending ? 'PENDING' : 'MATCH';
}

/** Absolute tolerance, widened by the relative and fee allowances. */
function toleranceFor(expected: Decimal, policy: Policy): Decimal {
  let t = parseDecimal(policy.amountTolerance, 'policy.amountTolerance');
  if (policy.amountToleranceBps > 0) t = add(t, bps(expected, policy.amountToleranceBps));
  // A deductible fee means the received amount is legitimately short by up to
  // the fee cap, so the cap widens the band rather than being a separate rule.
  if (policy.fees.deductible && policy.fees.maxBps > 0) t = add(t, bps(expected, policy.fees.maxBps));
  return t;
}

/** Returns `true` when within tolerance; records a finding and returns `false` otherwise. */
function compareAmount(
  f: Findings, element: string, field: string,
  expected: Decimal, actual: Decimal, tolerance: Decimal, policy: Policy,
): boolean {
  const delta = abs(sub(actual, expected));
  if (cmp(delta, tolerance) <= 0) return true;
  f.add(note('matching', 'AMOUNT_MISMATCH', 'blocking',
    `${element}.${field} differs from the instructed amount by ${formatDecimal(delta)}, `
    + `which exceeds the ${isZero(tolerance) ? 'exact-match requirement' : `tolerance of ${formatDecimal(tolerance)}`} `
    + `in ${policy.policyVersion}`,
    {
      element, field,
      expected: formatDecimal(expected),
      actual: formatDecimal(actual),
      tolerance: formatDecimal(tolerance),
    }));
  return false;
}

/** Which checklist fields this evidence actually carries. Presence only. */
function collectRegulatoryFields(ev: SettlementEvidence): Set<string> {
  const el = ev.elements ?? {};
  const out = new Set<string>();
  const mark = (name: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== '') out.add(name);
  };
  mark('originator', el.bankInstruction?.debtor);
  mark('beneficiary', el.bankInstruction?.creditor);
  mark('amount', el.bankInstruction?.amount);
  mark('currency', el.bankInstruction?.currency);
  mark('purpose', ev.purpose);
  mark('jurisdictionFrom', ev.jurisdiction?.from);
  mark('jurisdictionTo', ev.jurisdiction?.to);
  mark('chainTxRef', el.chainTransfer?.txRef);
  mark('originatorAddress', el.chainTransfer?.fromAddress);
  mark('beneficiaryAddress', el.chainTransfer?.toAddress);
  mark('invoiceRef', el.commercialDocs?.invoiceRef);
  mark('payoutRef', el.payoutReceipts?.[0]?.ref);
  if ((el.bankInstruction?.iso20022Fields ?? []).length > 0) out.add('iso20022');
  return out;
}

interface AnyElement {
  digest?: string;
  digestVerified?: boolean;
  signature?: Signature;
}

/** Normalise "one element or a list of them" into a list. */
function toArray(v: unknown): AnyElement[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as AnyElement[];
}
