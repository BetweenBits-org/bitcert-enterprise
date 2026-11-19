/**
 * `@stonehash/attest-rules` — deterministic settlement-evidence reconciliation.
 *
 * ## Why this is one shared implementation, unlike the verifier
 *
 * `@stonehash/attest-verify` is deliberately a *second, independent*
 * implementation of the proof format: if the code that issued a proof also
 * checked it, a bug would cancel itself out. The opposite is true here. The
 * Bank Review workflow re-runs these rules in the reviewer's browser and the
 * service runs them when it assembles an evidence bundle — and those two must be
 * the *same* code. A browser engine that disagreed with the server would make
 * the demonstration a lie about what the product does.
 *
 * The guarantee is therefore determinism rather than independence: same evidence
 * plus same policy digest yields the same verdict anywhere, which is what lets a
 * reviewer, an auditor and a supervisor compare results at all.
 *
 * ```ts
 * import { evaluate, loadPolicy, changeAmount } from '@stonehash/attest-rules';
 *
 * const verdict = evaluate(evidence, policy);
 * verdict.axes.matching.state          // 'MATCH' | 'MISMATCH' | 'PENDING'
 * verdict.policyDigest                 // pins exactly which rules ran
 * evaluate(changeAmount(evidence, 'chainTransfer', '48000.00'), policy);
 * ```
 */
export { evaluate } from './engine.ts';
export {
  assertNoPiiInLeaf, auditLeaf, COMMITTED_FIELDS, MIN_SALT_BYTES,
  selectAuditFields, SETTLEMENT_LEAF_DOMAIN, verifyAuditLeaf,
} from './audit-leaf.ts';
export type { AuditFields, AuditLeaf, CommittedField } from './audit-leaf.ts';
export { SCENARIOS, buildScenario, scenario } from './scenarios.ts';
export { SAMPLE_POLICY, SAMPLE_SETTLEMENT } from './samples.ts';
export {
  CORRIDOR_SCENARIOS, SWIFT_MAPPING, buildCorridorScenario, corridorScenario,
} from './corridor.ts';
export type { CorridorScenario, CorridorScenarioId } from './corridor.ts';
export { AUDIT_PROCEDURE, EVIDENCE_LAYERS, NOT_ESTABLISHED } from './layers.ts';
export type { EvidenceLayer } from './layers.ts';
export type { Scenario, ScenarioId } from './scenarios.ts';
export {
  canonicalPolicy, durationToMs, partyEquals, policyDigest, sameUnitOfAccount, trustAtLeast,
  validatePolicy,
} from './policy.ts';
/**
 * Signature verification. `verifyEvidenceSignatures` must run before
 * `evaluate` — the engine treats an unverified signature as unchecked, so
 * skipping it costs you the issuer axis rather than silently passing.
 */
export {
  SIGNATURE_DOMAIN, fromBase64Url, keyring, signedBytes, signedDigest,
  toBase64Url, verifyEvidenceSignatures, verifySignature,
} from './signature.ts';
export type { Keyring, VerificationKey } from './signature.ts';
export { DEMO_ISSUER_KEYS, DEMO_KEYRING } from './demo-keys.ts';
export {
  abs, add, bps, cmp, diffString, formatDecimal, isZero, parseDecimal, sub,
} from './decimal.ts';
export type { Decimal } from './decimal.ts';
export {
  breakDigest, breakSignature, changeAmount, duplicateReceipt, removeDocument, splitPayout,
} from './tamper.ts';
export type { AmountTarget, SignatureTarget } from './tamper.ts';
export type {
  AxisName, AxisResult, BankApproval, BankInstruction, ChainTransfer, CommercialDocs,
  CompletenessState, EvidenceElementBase, FinalityState, Finding, IntegrityState,
  IssuerState, MatchingResult, MatchingState, PayoutReceipt, Policy, RegulatoryState,
  Severity, SettlementEvidence, Signature, SignatureStatus, TravelRuleExchange, TrustLevel,
} from './types.ts';
