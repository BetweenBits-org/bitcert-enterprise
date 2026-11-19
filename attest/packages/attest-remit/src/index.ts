export {
  EVENT_DOMAIN, DIGEST_DOMAIN, elementDigest, eventSigningBytes, finishElement,
  sha256hex, signEvent, spkiOf, verifyEvent,
} from './signing.ts';
export type { EventSig } from './signing.ts';
export { RemitApiError, RemitClient, isoFieldNames, jwkThumbprint, swiftPaymentId } from './client.ts';
export type {
  Instruction, InstructionOptions, Quote, RemitClientOptions, ReviewAssertions, SettlementView,
  SwiftInstruction, SwiftMessageInput, SwiftOptions, SwiftSubmission, TradeParties, WebhookEnvelope,
} from './client.ts';
export { EVIDENCE_COMMIT_DOMAIN, verifyEvidencePackage } from './verify.ts';
export type { EvidenceCheck, EvidenceReport, EvidenceResponse } from './verify.ts';
export { generateSigningKey, registerIssuerKey } from './keys.ts';
export type { GeneratedSigningKey } from './keys.ts';

// Signing with a key held elsewhere (HSM, KMS, signing service).
export { SignerError, commandSigner, derToRaw, readSignatureBytes, signWith, spkiBase64Of, splitCommand } from './signer.ts';
export type { ExternalSigner } from './signer.ts';

// Travel Rule, bank-side encryption (mode B).
export { buildTravelRuleMessage, encryptToInstitution } from './travelrule.ts';
export type { TravelRuleContext } from './travelrule.ts';

// SWIFT messages in (MT103, pacs.008, pain.001) and status out (pacs.002).
export { parseSwiftMessage, parseSwiftMessages } from './swift/parse.ts';
export { SwiftMessageError } from './swift/model.ts';
export type {
  SwiftAgent, SwiftAmount, SwiftErrorCode, SwiftFormat, SwiftParty, SwiftPayment,
} from './swift/model.ts';
export { SwiftMappingError, mapSwiftPayment, swiftContentDigest } from './swift/mapping.ts';
export type {
  MappedField, MappedParties, MappingBasis, PartySupplement, SourceMessageRef,
  SwiftInstructionInput, SwiftMapping, SwiftMappingIssue, SwiftMappingOptions, SwiftUnmapped,
} from './swift/mapping.ts';
export {
  SWIFT_STATUS_TABLE, buildPacs002, sourceMessageOf, swiftStatusOf,
} from './swift/status.ts';
export type { Pacs002Options, StatusView, SwiftStatus, SwiftStatusCode } from './swift/status.ts';
