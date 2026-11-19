package com.stonehash.attest.core.format;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Proof bundle assembler — the producer side of {@code bitcert-proof-bundle/v1}.
 *
 * <p>No database, no RPC, no clock: the caller gathers the row, the proof and
 * the anchor and passes them in, which keeps the schema mapping testable and
 * keeps I/O failures out of the format.
 *
 * <p>The bundle is the entire deliverable. Everything else in this service
 * exists to produce one of these files, and once a customer has it they never
 * need to contact us again: any verifier written against the schema checks it.
 *
 * <p>{@code bitcoin_network} is required and is written from the backend's
 * own network. That is what makes a regtest proof self-describing — it cannot
 * be presented as mainnet, because every conforming verifier reads and
 * reports this field.
 */
public final class ProofBundle {
    private ProofBundle() {
    }

    /** What a bundle is assembled from. A field left {@code null} is a part the record does not have. */
    public static final class Input {
        /** SHA-256 of the document — or, for a signed anchor, of the statement — 64 lower-case hex. */
        public String leafBytesHex;
        public String contentType;
        /** Verbatim as the issuer signed it. Re-serialising would void it. */
        public Map<String, Object> statement;
        public Map<String, Object> descriptor;
        /** Absent for a witness inscription: one document, one transaction, no tree. */
        public Merkle.Proof merkle;
        public String anchorTxid;
        public String anchorRawTxHex;
        public String anchorPayloadHex;
        /** {@code blockHeight}, {@code blockHash}, {@code confirmations}: a claim, not proof — a strict verifier re-fetches it. */
        public Long blockHeight;
        public String blockHash;
        public Long confirmations;
        public boolean confirmed;
        /** Present only when the original rides in the witness. */
        public Long witnessInputIndex;
        public String witnessContentType;
        public String witnessProtocolTag;
        /** Commit transaction of an inscription. Not needed to verify; useful to look up. */
        public String commitTxid;
        public String network;
        public String generatedAt;
    }

    private static boolean has(String s) {
        return s != null && !s.isEmpty();
    }

    /** The bundle, its keys in the order the schema's reference producer writes them. */
    public static Map<String, Object> assemble(Input i) {
        Map<String, Object> preimage = new LinkedHashMap<>();
        // Declaring the preimage rule is what lets a holder prove the anchored digest is their
        // file. Without it link A would be permanently unverified.
        preimage.put("scheme", i.statement != null ? "sha256-signed-statement/v1" : "sha256-file");
        if (has(i.contentType)) {
            preimage.put("content_type", i.contentType);
        }
        if (i.statement != null) {
            preimage.put("statement", i.statement);
        }
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("kind", "attestation");
        record.put("leaf_bytes", i.leafBytesHex);
        record.put("preimage", preimage);
        if (i.descriptor != null && !i.descriptor.isEmpty()) {
            record.put("descriptor", i.descriptor);
        }

        Map<String, Object> anchor = new LinkedHashMap<>();
        anchor.put("reveal_txid", i.anchorTxid);
        anchor.put("reveal_tx_hex", i.anchorRawTxHex);
        anchor.put("op_return_payload_hex", i.anchorPayloadHex);
        if (i.confirmed) {
            Map<String, Object> c = new LinkedHashMap<>();
            if (i.blockHeight != null) {
                c.put("block_height", i.blockHeight);
            }
            if (has(i.blockHash)) {
                c.put("block_hash", i.blockHash);
            }
            if (i.confirmations != null) {
                c.put("confirmations", i.confirmations);
            }
            if (!c.isEmpty()) {
                anchor.put("confirmed", c);
            }
        }
        if (i.witnessInputIndex != null) {
            Map<String, Object> w = new LinkedHashMap<>();
            w.put("input_index", i.witnessInputIndex);
            if (has(i.witnessContentType)) {
                w.put("content_type", i.witnessContentType);
            }
            if (has(i.witnessProtocolTag)) {
                w.put("protocol_tag", i.witnessProtocolTag);
            }
            anchor.put("witness_envelope", w);
        }

        Map<String, Object> bundle = new LinkedHashMap<>();
        bundle.put("schema", "bitcert-proof-bundle/v1");
        bundle.put("bitcoin_network", i.network);
        bundle.put("generated_at", i.generatedAt);
        bundle.put("record", record);
        bundle.put("anchor", anchor);
        if (i.merkle != null) {
            Map<String, Object> merkle = new LinkedHashMap<>();
            merkle.put("leaf_index", (long) i.merkle.leafIndex);
            merkle.put("root", i.merkle.root);
            merkle.put("siblings", List.copyOf(i.merkle.siblings));
            merkle.put("directions", List.copyOf(i.merkle.directions));
            bundle.put("merkle", merkle);
        }
        if (has(i.commitTxid)) {
            bundle.put("commit_txid", i.commitTxid);
        }
        return bundle;
    }
}
