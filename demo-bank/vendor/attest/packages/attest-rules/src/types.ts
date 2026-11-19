/**
 * The settlement-evidence data model and verdict shape.
 *
 * ## Six axes, never collapsed
 *
 * A single pass/fail would hide the one thing a reviewer needs: *which* claim
 * failed. A payment whose documents are intact but whose provider signature is
 * invalid is a different situation from one where the amounts disagree, and a
 * different situation again from one where a document was never supplied. Each
 * gets its own axis with its own vocabulary.
 *
 * Two distinctions in particular are load bearing:
 *
 * - **Missing is not contradicted.** `INCOMPLETE` means evidence was not
 *   supplied; it never means the evidence was forged. They call for opposite
 *   actions — request the document, versus escalate.
 * - **Signature validity is not issuer identity.** A demonstration key produces
 *   a perfectly valid signature while proving nothing about who signed. The
 *   `issuer` axis carries `UNKNOWN_ISSUER` for exactly that case.
 */

// ── Axis vocabularies ──────────────────────────────────────────────────────
/** Do the submitted bytes match what was committed? */
export type IntegrityState = 'VALID' | 'INVALID' | 'NOT_CHECKED';
/** Did a key sign this, and do we know whose key it is? */
export type IssuerState = 'VALID' | 'INVALID' | 'UNKNOWN_ISSUER';
/** Do the independent sources agree under the policy? */
export type MatchingState = 'MATCH' | 'MISMATCH' | 'PENDING';
/** Was everything the policy requires actually supplied? */
export type CompletenessState = 'COMPLETE' | 'INCOMPLETE';
/** Are the fields a regulatory form asks for present? Not a compliance verdict. */
export type RegulatoryState = 'PRESENT' | 'MISSING' | 'REVIEW_REQUIRED';
/** Did the paying institution actually confirm the funds moved? */
export type FinalityState = 'VERIFIED_BY_SOURCE' | 'UNVERIFIED' | 'DEMO_ONLY';

export type AxisName =
  | 'integrity' | 'issuer' | 'matching'
  | 'completeness' | 'regulatoryMapping' | 'businessFinality';

// ── Evidence ───────────────────────────────────────────────────────────────
/** How much weight a signature's issuer carries. `DEMO` is not an identity. */
export type TrustLevel = 'DEMO' | 'ATTESTED' | 'ACCREDITED';

export type SignatureStatus =
  /** Verified against a key whose trust level is above `DEMO`. */
  | 'VALID'
  /** Verification ran and failed. */
  | 'INVALID'
  /** No signature was supplied. */
  | 'ABSENT'
  /** Signature verifies, but against a demonstration key. Not an identity. */
  | 'DEMO_VALID'
  /** A signature is present but names a key the verifier does not hold. */
  | 'UNKNOWN_KEY';

export interface Signature {
  /**
   * The verdict. **Only meaningful when `checked` is true** — see below.
   */
  status: SignatureStatus;
  /** Which key signed. Looked up in the verifier's keyring. */
  keyId?: string;
  algorithm?: string;
  /** Who the key claims to be. A claim; identity is a separate axis. */
  issuer?: string;
  trustLevel?: TrustLevel;
  /** The signature itself, base64url, over `signedBytes(element)`. */
  value?: string;
  /**
   * Set **only** by `verifyEvidenceSignatures`, never by a document.
   *
   * Without this the engine cannot tell a computed verdict from one an input
   * file simply asserted, and it used to tell them apart by not trying: a
   * fixture saying `"status": "VALID"` rendered as a verified signature with no
   * cryptography anywhere. An unmarked signature is now treated as unchecked,
   * which is why this field exists rather than being inferable from `status`.
   */
  checked?: boolean;
}

/** Common shape every evidence element shares. */
export interface EvidenceElementBase {
  /** Reference number as the issuing party prints it. */
  ref?: string;
  /** `SHA-256` of the source document, 64 lowercase hex. */
  digest?: string;
  /** `true` when the submitted bytes re-hash to `digest`. `undefined` = not checked. */
  digestVerified?: boolean;
  signature?: Signature;
}

/** ① The movement of funds, read from a public chain. */
export interface ChainTransfer extends EvidenceElementBase {
  chain: string;
  asset: string;
  /** Decimal string. Never a number — see `decimal.ts`. */
  amount: string;
  currency: string;
  fromAddress?: string;
  toAddress?: string;
  txRef?: string;
  /**
   * The settlement id as carried on the chain leg — in a memo field, or as a
   * commitment derived from it. A bare txid proves a transfer happened; it does
   * not say which payment instruction it satisfied.
   */
  settlementIdMemo?: string;
  confirmations?: number;
  /** ISO 8601 instant. Used for the settlement window, which needs no clock. */
  observedAt?: string;
}

/** ② The paying institution's confirmation that it paid out. */
export interface PayoutReceipt extends EvidenceElementBase {
  amount: string;
  currency: string;
  paidAt?: string;
}

/** ③ The instructing bank's authorised instruction. */
export interface BankInstruction extends EvidenceElementBase {
  amount: string;
  currency: string;
  /** Debtor/creditor as the instruction names them. */
  debtor?: string;
  creditor?: string;
  approvedAt?: string;
  /** ISO 20022 fields present in the instruction, by name. */
  iso20022Fields?: string[];
}

/** ④ The commercial basis — contract, invoice, shipping, customs. */
export interface CommercialDocs extends EvidenceElementBase {
  invoiceRef?: string;
  amount?: string;
  currency?: string;
  buyer?: string;
  seller?: string;
  /** Which documents were actually attached, as opposed to merely cited. */
  attached?: string[];
  /** Documents the submitter referenced by number without supplying. */
  citedOnly?: string[];
}

/**
 * ⑤ The Travel Rule exchange between the two VASPs — FATF R.16, MAS PSN02.
 *
 * Replaces what a correspondent bank's MT103 fields 50/59 carried. Note what is
 * modelled and what deliberately is not: the **digest** of the IVMS 101 message
 * is here, never the message. The names, identifiers and addresses inside it are
 * what the two VASPs are obliged to exchange privately; committing them — or
 * anything derived from them — to a public ledger would turn a transmission duty
 * into a permanent disclosure.
 *
 * The approval fields exist to make the pre-flight control *checkable*. "We do
 * not release funds before the receiving VASP approves" is a policy claim; an
 * approval signed by that VASP, timestamped strictly before the on-chain
 * transfer, is arithmetic a regulator can confirm per payment.
 */
export interface TravelRuleExchange extends EvidenceElementBase {
  /** Protocol used, e.g. `IVMS101/TRP`, `Notabene`, `Sygna`, `VerifyVASP`. */
  protocol: string;
  /** `SHA-256` of the canonical IVMS 101 message. Never the message itself. */
  ivms101Digest: string;
  /** Sending VASP — the originating institution in FATF terms. */
  originatingVasp: string;
  /** Receiving VASP — the beneficiary institution. */
  beneficiaryVasp: string;
  /** `APPROVED` is the only state that may precede a treasury release. */
  approvalStatus: 'APPROVED' | 'REJECTED' | 'PENDING' | 'NOT_EXCHANGED';
  /** Digest of the receiving VASP's signed approval callback. */
  approvalDigest?: string;
  /** When approval was received. Must precede the on-chain transfer. */
  approvedAt?: string;
  /** Beneficiary deposit address the receiving VASP whitelisted. */
  approvedBeneficiaryAddress?: string;
  /** On-chain analytics score, where one was obtained. Informational. */
  kytRiskScore?: number;
}

/**
 * ③b The authorising bank's own approval, and the FX quote it was struck under.
 *
 * Separated from `bankInstruction` because these are the fields a *regulator*
 * asks for — the approval reference, the report filed with the central bank, and
 * the rate the customer was actually given — rather than the payment message.
 */
export interface BankApproval extends EvidenceElementBase {
  /** The bank's internal approval number for the foreign-exchange review. */
  approvalRef: string;
  /** Identifier of the report filed with the central bank, where required. */
  regulatorReportRef?: string;
  /** Who approved, by role rather than by name. */
  approvedByRole?: string;
  approvedAt?: string;
  /**
   * The locked quote. Gross settlement means the customer is held to a rate for
   * a stated window, so a transfer landing outside it was priced on a rate the
   * customer never agreed to — which is a reconciliation break, not a detail.
   */
  fxQuote?: {
    pair: string;
    rate: string;
    quotedAt: string;
    validUntil: string;
  };
}

export interface SettlementEvidence {
  /**
   * The single reference tying every layer of one payment together — bank
   * voucher, Travel Rule message, on-chain transaction, fiat credit. This is
   * what replaces the SWIFT UETR, and without it the three layers are separate
   * records that merely look related.
   */
  settlementId?: string;
  /** On a refund: the settlement being returned. */
  relatedSettlementId?: string;
  /**
   * Why funds were returned.
   *
   * A refund is modelled as a **new settlement pointing back**, never as a
   * reversal of the original. Mutating the original would destroy the record of
   * what was first submitted, which is the thing an auditor came to see — and
   * an unexplained inbound transfer is exactly what reads as illicit flow to a
   * foreign-exchange supervisor.
   */
  refundReasonCode?: string;
  schemaVersion: string;
  scenario: string;
  /** `SYNTHETIC` forces `businessFinality` to `DEMO_ONLY`. Not a label — a rule. */
  dataMode: 'SYNTHETIC' | 'LIVE';
  /** Restates in the data what the UI must also say. */
  notRealPayment: boolean;
  jurisdiction?: { from: string; to: string };
  purpose?: string;
  elements: {
    chainTransfer?: ChainTransfer;
    /** More than one receipt is a split payment; the policy decides if that matches. */
    payoutReceipts?: PayoutReceipt[];
    bankInstruction?: BankInstruction;
    commercialDocs?: CommercialDocs;
    travelRule?: TravelRuleExchange;
    bankApproval?: BankApproval;
  };
}

// ── Policy ─────────────────────────────────────────────────────────────────
/**
 * The rule set, as data rather than code.
 *
 * A verdict is only reproducible if the policy that produced it is pinned, so
 * the result carries both `policyVersion` and a digest of the canonicalised
 * policy. Changing a tolerance therefore changes the digest, and an old verdict
 * cannot be silently re-interpreted under new rules.
 */
export interface Policy {
  policyVersion: string;
  /** Currencies this policy is willing to reconcile at all. */
  currencies: string[];
  /**
   * Groups of currency codes the policy treats as **one unit of account**, so
   * amounts within a group compare 1:1 with no conversion.
   *
   * This is deliberately explicit rather than implied by `currencies`. Holding
   * that a USDC amount settles a USD invoice at par is a substantive assumption
   * about redemption and counterparty risk, and a bank reviewer may well reject
   * it. Burying it in list membership would hide exactly the judgement they need
   * to see; naming it means they can disagree with it.
   *
   * Codes in different groups require `fxReference`. A code in no group is its
   * own group.
   */
  unitOfAccountGroups: string[][];
  /** Absolute tolerance, decimal string. `"0.00"` means exact. */
  amountTolerance: string;
  /** Additional relative tolerance in basis points. `0` disables it. */
  amountToleranceBps: number;
  /** FX source name, or `null` when the policy refuses cross-currency matching. */
  fxReference: string | null;
  /** ISO 8601 duration, e.g. `"P3D"`. Measured between evidence timestamps. */
  settlementWindow: string;
  fees: { deductible: boolean; maxBps: number };
  splitPayments: { allowed: boolean; aggregate: boolean };
  partyIDMatch: 'exact' | 'normalized';
  /** Minimum issuer trust the policy will accept as a real identity. */
  sourceTrustLevel: TrustLevel;
  /** Element keys that must be present and attached. */
  requiredElements: string[];
  /**
   * Element keys that must carry a verifiable issuer signature.
   *
   * Deliberately narrower than `requiredElements`. A chain transfer read from a
   * public ledger has **no issuer to sign it** — its authority comes from the
   * chain itself, which the anchor and the proof bundle establish. Demanding a
   * signature there would mean the issuer axis could never reach `VALID` for any
   * real settlement, which would make the axis useless rather than strict.
   */
  signatureRequiredElements: string[];
  /** Fields a regulatory submission asks for, checked for presence only. */
  regulatoryFields: string[];
  /**
   * Enforce that the Travel Rule exchange was approved **before** the funds
   * moved.
   *
   * The control itself lives in the payment system; this makes it auditable per
   * payment rather than per policy document. Switched on for any corridor under
   * FATF R.16, which in practice is all of them above the threshold.
   */
  requireTravelRulePreflight: boolean;
  /** Reject a transfer that settled outside the locked FX quote's validity. */
  enforceFxQuoteWindow: boolean;
  /** Elements that must carry the settlement id, so the layers are tied together. */
  settlementIdRequiredIn: string[];
}

// ── Verdict ────────────────────────────────────────────────────────────────
export type Severity = 'info' | 'warning' | 'blocking';

/**
 * One reason behind an axis state.
 *
 * `expected`, `actual` and `tolerance` are populated wherever a comparison
 * failed, because "amounts do not match" is not actionable and
 * "bank instruction 50000.00 vs chain 48000.00, tolerance 0.00" is.
 */
export interface Finding {
  /** Stable machine code, e.g. `AMOUNT_MISMATCH`. Safe to branch on. */
  code: string;
  axis: AxisName;
  severity: Severity;
  /** Which evidence element the finding concerns. */
  element?: string;
  /** Which field within it. */
  field?: string;
  expected?: string;
  actual?: string;
  tolerance?: string;
  /** One sentence, in English, for a log or a tooltip. */
  detail: string;
}

export interface AxisResult<S extends string> {
  state: S;
  findings: Finding[];
}

export interface MatchingResult {
  policyVersion: string;
  /** `SHA-256` of the canonicalised policy. Pins exactly which rules ran. */
  policyDigest: string;
  scenario: string;
  dataMode: 'SYNTHETIC' | 'LIVE';
  axes: {
    integrity: AxisResult<IntegrityState>;
    issuer: AxisResult<IssuerState>;
    matching: AxisResult<MatchingState>;
    completeness: AxisResult<CompletenessState>;
    regulatoryMapping: AxisResult<RegulatoryState>;
    businessFinality: AxisResult<FinalityState>;
  };
  /** Every finding across every axis, in evaluation order. */
  findings: Finding[];
  /**
   * `true` when a human has to look. Deliberately NOT a pass/fail: this engine
   * reconciles evidence, and whether a payment is acceptable is a judgement it
   * has no standing to make.
   */
  manualReviewRequired: boolean;
  /**
   * Always `NOT_EVALUATED`. Field-coverage mapping is not a compliance
   * decision, and the type makes it impossible for this engine to claim one.
   */
  regulatoryDecision: 'NOT_EVALUATED';
}
