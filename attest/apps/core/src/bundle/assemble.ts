/**
 * Proof bundle assembler — the producer side of `bitcert-proof-bundle/v1`.
 *
 * A pure function: no database, no RPC, no clock. The caller gathers the row,
 * the proof and the anchor and passes decoded primitives in, which keeps the
 * schema mapping unit-testable and keeps I/O failures out of the format.
 *
 * The bundle is the entire deliverable. Everything else in this service exists
 * to produce one of these files, and once a customer has it they never need to
 * contact us again: `@stonehash/attest-verify`, the published Python CLI, or
 * anything else written against the schema will check it.
 *
 * `bitcoin_network` is required and is written from the backend's own network.
 * That is what makes a regtest proof self-describing — it cannot be presented as
 * mainnet, because every conforming verifier reads and reports this field.
 */

/**
 * The wire shape, declared here from the spec rather than imported from the
 * verifier.
 *
 * Declaring it twice is the point. `@stonehash/attest-verify` declares its own
 * `ProofBundle` independently, and `test/roundtrip.test.ts` passes a value of
 * this type into a parameter of that one — so TypeScript's structural check
 * becomes a compile-time conformance test between two independently written
 * readings of `bundle-schema.md`. Importing the verifier's types instead would
 * make them agree by construction and prove nothing.
 */
export interface ProofBundleV1 {
  schema: 'bitcert-proof-bundle/v1';
  bitcoin_network: 'regtest' | 'mainnet';
  generated_at: string;
  record: {
    kind: 'attestation';
    leaf_bytes: string;
    /*
     * How `leaf_bytes` was derived, so a recipient can recompute it.
     *
     * `sha256-file` — the leaf is the document's digest. The original is
     * needed to check it, and nothing is claimed about who published it.
     *
     * `sha256-signed-statement/v1` — the leaf is the hash of the `statement`
     * below, which carries the document digest *and* the issuer's signature.
     * The chain therefore timestamps authorship too. The statement is here
     * because only its hash reached the chain; this is the readable copy.
     */
    preimage: {
      scheme: 'sha256-file' | 'sha256-signed-statement/v1';
      content_type?: string;
      statement?: Record<string, unknown>;
    };
    descriptor?: Record<string, unknown>;
  };
  /**
   * Absent for a witness inscription. There is no tree: one document, one
   * transaction, and the anchor output carries `leaf_bytes` directly — the
   * shape `attest-verify` calls "legacy witness", where it checks the payload
   * against the leaf and skips link B rather than hunting for a proof that
   * was never built.
   */
  merkle?: {
    leaf_index: number;
    root: string;
    siblings: string[];
    directions: ('left' | 'right')[];
  };
  anchor: {
    reveal_txid: string;
    reveal_tx_hex: string;
    op_return_payload_hex: string;
    confirmed?: { block_height?: number; block_hash?: string; confirmations?: number };
    /**
     * Present only when the original rides in the witness. `input_index` is
     * what the verifier needs; the other two are descriptive, so a reader can
     * see what was inscribed without parsing the transaction.
     */
    witness_envelope?: { input_index: number; content_type?: string; protocol_tag?: string };
  };
  /** Commit transaction of an inscription. Not needed to verify; useful to look up. */
  commit_txid?: string;
}

export interface AssembleInput {
  /** SHA-256 of the document, 64 lowercase hex. */
  leafBytesHex: string;
  contentType?: string;
  /** Verbatim as the issuer signed it. Re-serialising would void it. */
  statement?: Record<string, unknown>;
  descriptor?: Record<string, unknown>;
  merkle?: { root: string; siblings: string[]; directions: ('left' | 'right')[]; leafIndex: number };
  anchor: {
    txid: string;
    rawTxHex: string;
    payloadHex: string;
    confirmed?: { blockHeight?: number; blockHash?: string; confirmations?: number };
    witnessEnvelope?: { inputIndex: number; contentType?: string; protocolTag?: string };
  };
  commitTxid?: string;
  network: 'regtest' | 'mainnet';
  generatedAt: string;
}

export function assembleBundle(i: AssembleInput): ProofBundleV1 {
  const record: ProofBundleV1['record'] = {
    kind: 'attestation',
    leaf_bytes: i.leafBytesHex,
    // Declaring the preimage rule is what lets a holder prove the anchored
    // digest is *their* file. Omitting it would still produce a verifiable
    // bundle, but link A would be permanently unverified.
    preimage: i.statement
      ? {
          scheme: 'sha256-signed-statement/v1',
          ...(i.contentType ? { content_type: i.contentType } : {}),
          statement: i.statement,
        }
      : { scheme: 'sha256-file', ...(i.contentType ? { content_type: i.contentType } : {}) },
  };
  if (i.descriptor && Object.keys(i.descriptor).length > 0) record.descriptor = i.descriptor;

  const anchor: ProofBundleV1['anchor'] = {
    reveal_txid: i.anchor.txid,
    reveal_tx_hex: i.anchor.rawTxHex,
    op_return_payload_hex: i.anchor.payloadHex,
  };
  if (i.anchor.confirmed) {
    // Emitted as a claim, not as proof. A strict verifier re-fetches this from a
    // Bitcoin source of its own choosing and ignores what we assert here.
    const c: NonNullable<ProofBundleV1['anchor']['confirmed']> = {};
    if (typeof i.anchor.confirmed.blockHeight === 'number') c.block_height = i.anchor.confirmed.blockHeight;
    if (i.anchor.confirmed.blockHash) c.block_hash = i.anchor.confirmed.blockHash;
    if (typeof i.anchor.confirmed.confirmations === 'number') c.confirmations = i.anchor.confirmed.confirmations;
    if (Object.keys(c).length > 0) anchor.confirmed = c;
  }

  if (i.anchor.witnessEnvelope) {
    const w: NonNullable<ProofBundleV1['anchor']['witness_envelope']> = {
      input_index: i.anchor.witnessEnvelope.inputIndex,
    };
    if (i.anchor.witnessEnvelope.contentType) w.content_type = i.anchor.witnessEnvelope.contentType;
    if (i.anchor.witnessEnvelope.protocolTag) w.protocol_tag = i.anchor.witnessEnvelope.protocolTag;
    anchor.witness_envelope = w;
  }

  const bundle: ProofBundleV1 = {
    schema: 'bitcert-proof-bundle/v1',
    bitcoin_network: i.network,
    generated_at: i.generatedAt,
    record,
    anchor,
  };
  if (i.merkle) {
    bundle.merkle = {
      leaf_index: i.merkle.leafIndex,
      root: i.merkle.root,
      siblings: i.merkle.siblings,
      directions: i.merkle.directions,
    };
  }
  if (i.commitTxid) bundle.commit_txid = i.commitTxid;
  return bundle;
}
