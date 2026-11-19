/**
 * `@stonehash/attest-verify` — independent verifier for StoneHash Attest proof
 * bundles. Zero runtime dependencies; identical in Node and the browser.
 *
 * This package is deliberately a **second, independent implementation** of the
 * published wire contract (`fixtures/bundle-schema.md`), not a library shared
 * with the producer. If the same code both issued and checked a proof, a bug
 * would cancel itself out and "independently verifiable" would mean nothing.
 * `test/conformance.test.ts` runs the producer's own published fixtures —
 * five that must pass and three tampered ones that must fail — so neither side
 * can drift without the build going red.
 *
 * ```ts
 * import { verifyBundle } from '@stonehash/attest-verify';
 *
 * const report = verifyBundle(bundle, { originalBytes });
 * report.verified   // conjunction of gating checks
 * report.links      // { A, B, C1, C2 } — per-link verdicts, reported separately
 * report.checks     // ordered detail for rendering
 * ```
 */
export { verifyBundle, SUPPORTED_SCHEMAS } from './bundle.ts';
export type {
  Check, CheckState, LinkVerdicts, ProofBundle, VerifyReport,
} from './bundle.ts';

export { sha256, sha256d } from './sha256.ts';
export {
  bytesToHex, concat, hexEq, hexToBytes, latin1, reversed, utf8, ZERO_HASH_HEX,
} from './bytes.ts';
export { jcs, jcsString } from './jcs.ts';
export type { JcsValue } from './jcs.ts';
export { leafHash, nodeHash, verifyInclusion } from './merkle.ts';
export type { Direction, MerkleResult, MerkleSection } from './merkle.ts';
export {
  decodeAnchorPayload, extractAnchorOutput, parseTx, txidFromRaw,
} from './anchor.ts';
export type { DecodedAnchor, ParsedTx, TxBinding } from './anchor.ts';
export { extractWitnessItems, parseEnvelope } from './witness.ts';
export type { Envelope } from './witness.ts';
export { payloadHash, verifyChainLinks } from './chain.ts';
export type { ChainEntry, ChainWalkResult } from './chain.ts';
export { assetsHash, dayRoot, deriveUserCommitment, reconCommitment } from './recon.ts';
export type { ReconAsset, ReconciliationSection } from './recon.ts';
export { verifyPreimage } from './preimage.ts';
export {
  addBalances, assertBalances, porEmptyNode, porLeafHash, porNodeHash,
  porSnapshotCommitment, porUserRefHash, POR_SNAPSHOT_DOMAIN,
  verifyPorInclusion, zeroBalances,
} from './merkle-sum.ts';
export type {
  PorBalances, PorDirection, PorInclusionProof, PorLeafOpening, PorSibling,
  PorSumNode, PorVerifyExpectation, PorVerifyResult,
} from './merkle-sum.ts';

export type { PreimageInput, PreimageResult, PreimageSection } from './preimage.ts';

/*
 * The attestation statement — what an issuer signs and what the chain
 * commits to when the optional issuer signature is used. Exported from the
 * verifier package because the signing SDK, the service and this verifier
 * must agree on the bytes exactly, and this is the module all three already
 * depend on.
 */
export {
  STATEMENT_DOMAIN, STATEMENT_SCHEMA,
  assertStatementCore, buildStatement, statementSigningInput, statementLeaf, verifyStatement,
} from './statement.ts';
/* Pure-JS P-256 verification, for pages without WebCrypto. */
export { verifyP256, pointFromSpki, p256KeypairFromSeed } from './p256.ts';
export type {
  StatementAlgorithm, StatementCore, StatementIssuer, SignedStatement, StatementVerdict,
} from './statement.ts';
