package com.stonehash.attest.core.attest;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.anchor.Inscriber;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.Merkle;
import com.stonehash.attest.core.format.ProofBundle;
import com.stonehash.attest.core.format.Statement;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * The service — the state transitions an attestation goes through at the
 * API: accepted when its digest arrives, and exported as a proof bundle once
 * its batch is on the chain. (Sealing, anchoring and confirming are the batch
 * worker's.)
 *
 * <h2>Status is never collapsed</h2>
 *
 * <pre>accepted → batched → submitted → confirmed</pre>
 *
 * Each step is recorded and reported separately. "Anchored" is not a synonym
 * for "submitted": a transaction in the mempool is not yet in a block, and a
 * caller that cannot tell those apart will eventually claim proof it does
 * not have.
 */
@Service
public class AttestService {
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    private final AttestMapper mapper;
    private final CoreConfig cfg;
    /**
     * Puts a document on the chain and reports where it landed. Handed in
     * rather than reached for: a deployment with no inscription support
     * simply has none — the absence is a missing capability, not a flag.
     */
    private final Inscriber inscriber;

    public AttestService(AttestMapper mapper, CoreConfig cfg, ObjectProvider<Inscriber> inscriber) {
        this.mapper = mapper;
        this.cfg = cfg;
        this.inscriber = inscriber.getIfAvailable();
    }

    /** Whether this deployment can inscribe originals, for {@code /v1/meta} and the console. */
    public boolean canInscribe() {
        return inscriber != null;
    }

    /** The organisation a slug names, if any — so a caller can refuse to reuse it. */
    public String orgBySlug(String slug) {
        return mapper.orgIdBySlug(slug);
    }

    public String ensureOrg(String slug, String name) {
        String found = mapper.orgIdBySlug(slug);
        if (found != null) {
            return found;
        }
        String id = UUID.randomUUID().toString();
        mapper.insertOrg(id, slug, name, IsoTime.now());
        return id;
    }

    /** What {@link #issue} is told beyond the digest. A field left {@code null} is not given. */
    public static final class Issue {
        public String contentType;
        /** Any JSON value; absent and {@code null} are both the empty object. */
        public Object descriptor;
        /** {@code api} unless the free tier issued it. */
        public String source = "api";
        /** Only with {@code source = "public"}: only the anonymous free tier expires. */
        public String expiresAt;
        public Map<String, Object> statement;
        /** Billing dimension: which product issued this. */
        public String product = "attest";
    }

    /**
     * Accept a document digest. The document itself never arrives — the
     * caller hashes it locally, so file contents never cross the network and
     * this service cannot leak what it was never sent.
     */
    public Map<String, Object> issue(String orgId, String leafBytesHex, Issue opts) {
        // Only the anonymous free tier expires. An organisation's records are kept until it
        // asks for them to be deleted, so an expiry on one is a bug to stop here.
        if (opts.expiresAt != null && !"public".equals(opts.source)) {
            throw new IllegalStateException("only free-tier records expire; an organisation's records are kept until it asks for deletion");
        }
        String leaf = leafBytesHex.toLowerCase(Locale.ROOT);
        if (!HEX64.matcher(leaf).matches()) {
            throw new ServiceError(400, "invalid_digest", "leaf_bytes must be 64 lowercase hex characters (SHA-256)");
        }
        String dup = mapper.attestationIdByDigest(orgId, leaf);
        if (dup != null) {
            throw duplicate(dup);
        }
        String trust = opts.statement == null ? null : issuerTrust(orgId, opts.statement);
        String id = UUID.randomUUID().toString();
        try {
            mapper.insertAttestation(id, orgId, leaf, opts.contentType, Js.stringify(opts.descriptor == null ? new LinkedHashMap<String, Object>() : opts.descriptor),
                    IsoTime.now(), opts.source, opts.expiresAt,
                    // Verbatim. Re-serialising it any other way would change the canonical bytes the signature was made over.
                    opts.statement == null ? null : Js.stringify(opts.statement), trust, opts.product);
        } catch (DuplicateKeyException e) {
            // Two requests for one digest arrived together and the other was stored first.
            String winner = mapper.attestationIdByDigest(orgId, leaf);
            if (winner != null) {
                throw duplicate(winner);
            }
            throw e;
        }
        return get(orgId, id);
    }

    private static ServiceError duplicate(String id) {
        return new ServiceError(409, "duplicate_digest",
                "this digest is already attested as " + id + "; a duplicate leaf would make its inclusion proof ambiguous");
    }

    /**
     * Accept a document digest together with the issuer's signature over it.
     *
     * <p>The leaf is not the document's digest here — it is the hash of the
     * statement, which already contains both the digest and the signature.
     * One block height therefore timestamps the document and its authorship
     * together. The signature is checked here, before anything is stored: a
     * record carrying a signature that does not verify would read as
     * provenance while establishing none.
     *
     * <p>What this does not check is who the key belongs to. That is a
     * separate question with a separate answer ({@code issuer_trust}).
     */
    public Map<String, Object> issueSigned(String orgId, Map<String, Object> statement, Object descriptor) {
        String leaf;
        try {
            leaf = Statement.leaf(statement);
        } catch (Statement.Malformed e) {
            throw new ServiceError(400, "invalid_statement", e.getMessage());
        }
        Statement.Verdict verdict = Statement.verify(statement, leaf);
        if (!verdict.signatureOk) {
            throw new ServiceError(400, "invalid_signature", verdict.error != null && !verdict.error.isEmpty()
                    ? "the signature could not be checked: " + verdict.error
                    : "the signature does not verify against the public key in the statement");
        }
        Issue opts = new Issue();
        opts.contentType = storable(statement.get("document") instanceof Map ? ((Map<?, ?>) statement.get("document")).get("content_type") : null);
        opts.descriptor = descriptor;
        opts.statement = statement;
        return issue(orgId, leaf, opts);
    }

    /** A value given where text was expected, as the store keeps it: text as it is; a value of another kind as the previous driver wrote it. */
    public static String storable(Object v) {
        if (v == null || v == Js.UNDEFINED) {
            return null;
        }
        if (v instanceof String) {
            return (String) v;
        }
        if (v instanceof Boolean) {
            return (Boolean) v ? "1" : "0";
        }
        return v instanceof Double ? Js.numberToString((Double) v) : Js.stringify(v);
    }

    /**
     * Inscribe a document: the bytes go onto the chain, and nowhere else.
     *
     * <p>The caller hands over the document because that is the whole point
     * of this path — the original has to reach Bitcoin, and it cannot do
     * that without passing through here. What it does not do is rest
     * anywhere: the bytes are hashed, folded into a tapscript, broadcast and
     * left to the garbage collector. Nothing is written to disk, and the row
     * this creates holds the reveal transaction — which is public — rather
     * than a document that is not.
     *
     * <p>Broadcast first, then the row. A row written before the chain
     * accepted the transaction would claim an anchor that does not exist, and
     * the failures here (not enough funds, too large) are exactly the ones
     * worth not recording. Unlike a digest, this both records and anchors —
     * one document, one transaction, no batch to wait for — so the record
     * starts at {@code submitted}, and it never joins a batch.
     */
    public Map<String, Object> inscribe(String orgId, byte[] body, String contentType, Object descriptor, String source) {
        if (inscriber == null) {
            throw new ServiceError(501, "inscription_unavailable", "this deployment has no inscription backend; only digest anchoring is available");
        }
        String leaf = Hex.encode(Hex.sha256(body));
        String dup = mapper.attestationIdByDigest(orgId, leaf);
        if (dup != null) {
            throw new ServiceError(409, "duplicate_digest", "this document is already attested as " + dup);
        }
        Inscriber.Result r = inscriber.inscribe(body, contentType);
        String id = UUID.randomUUID().toString();
        try {
            mapper.insertInscription(id, orgId, leaf, contentType, Js.stringify(descriptor == null ? new LinkedHashMap<String, Object>() : descriptor),
                    IsoTime.now(), source == null ? "api" : source, r.commitTxid, r.revealTxid, r.revealTxHex, r.bodyLength, r.protocolTag);
        } catch (DuplicateKeyException e) {
            // Two requests for one document arrived together; the other's record stands.
            String winner = mapper.attestationIdByDigest(orgId, leaf);
            if (winner != null) {
                throw new ServiceError(409, "duplicate_digest", "this document is already attested as " + winner);
            }
            throw e;
        }
        return get(orgId, id);
    }

    /**
     * Was this key registered to this organisation when the record was made?
     * Matched on the key material, not on {@code key_id}: the id is derived
     * from the key and carries no authority, so trusting it would let a
     * caller claim a registered id with a different key.
     */
    private String issuerTrust(String orgId, Map<String, Object> statement) {
        Object issuer = statement.get("issuer");
        Object publicKey = issuer instanceof Map ? ((Map<?, ?>) issuer).get("public_key") : null;
        return publicKey instanceof String && mapper.activeIssuerKeyId(orgId, (String) publicKey) != null ? "registered" : "unregistered";
    }

    /** Register a public key so that future signatures from it count as provenance. {@code id} and whether it was there {@code already}. */
    public Map<String, Object> registerIssuerKey(String orgId, String publicKeySpkiBase64, String label, String algorithm) {
        Map<String, Object> out = new LinkedHashMap<>();
        String existing = mapper.activeIssuerKeyId(orgId, publicKeySpkiBase64);
        if (existing != null) {
            out.put("id", existing);
            out.put("already", true);
            return out;
        }
        String id = UUID.randomUUID().toString();
        mapper.insertIssuerKey(id, orgId, label, publicKeySpkiBase64, algorithm, IsoTime.now());
        out.put("id", id);
        out.put("already", false);
        return out;
    }

    public List<Map<String, Object>> listIssuerKeys(String orgId) {
        return mapper.issuerKeys(orgId);
    }

    /**
     * Revoke one of the organisation's keys. Records already signed with it
     * keep what was established when they were made; from here on a
     * signature from it counts for nothing — and an institution of the
     * organisation that signed with it is left without a key rather than
     * with one its owner has withdrawn.
     *
     * @return {@code false} when the organisation has no active key with that id
     */
    public boolean revokeIssuerKey(String orgId, String id) {
        String publicKey = mapper.activeIssuerKeyMaterial(id, orgId);
        if (publicKey == null) {
            return false;
        }
        mapper.revokeIssuerKey(IsoTime.now(), id, orgId);
        mapper.withdrawInstitutionKey(orgId, publicKey);
        return true;
    }

    public Map<String, Object> get(String orgId, String id) {
        return mapper.attestation(id, orgId);
    }

    public List<Map<String, Object>> list(String orgId, long limit) {
        return list(orgId, limit, null);
    }

    /** The organisation's newest records; with a product ({@code attest}, {@code remit}, {@code por}), the anchors that product made. */
    public List<Map<String, Object>> list(String orgId, long limit, String product) {
        return mapper.attestations(orgId, product, Math.min(limit, 500));
    }

    public Map<String, Object> getPublic(String id) {
        return mapper.publicAttestation(id);
    }

    /** A free-tier record by its digest, for the already-anchored case. */
    public Map<String, Object> findPublicByDigest(String leafBytesHex) {
        return mapper.publicAttestationByDigest(leafBytesHex.toLowerCase(Locale.ROOT));
    }

    // ── the bundle ────────────────────────────────────────────────────────────

    /**
     * Export the proof bundle — the whole product in one file. Refused before
     * the batch is anchored rather than emitting a bundle with an empty anchor
     * section: a caller who received one would have something that looks like
     * a proof and is not.
     */
    public Map<String, Object> exportBundle(String orgId, String attestationId) {
        Map<String, Object> att = get(orgId, attestationId);
        if (att == null) {
            throw new ServiceError(404, "not_found", "no attestation " + attestationId);
        }
        return bundleFor(att);
    }

    /** Free-tier export. Authenticated by possession of the id. */
    public Map<String, Object> exportPublicBundle(String attestationId) {
        Map<String, Object> att = getPublic(attestationId);
        if (att == null) {
            throw new ServiceError(404, "not_found", "no free-tier anchor " + attestationId + ". Free anchors are retrievable for a limited window; "
                    + "a downloaded bundle stays verifiable indefinitely without us.");
        }
        return bundleFor(att);
    }

    private static boolean has(Object text) {
        return text instanceof String && !((String) text).isEmpty();
    }

    private static Long number(Object v) {
        return v instanceof Number ? ((Number) v).longValue() : null;
    }

    /** {@code { ...into, ...value }}: what a stored descriptor adds to the bundle's, whatever JSON it is. */
    @SuppressWarnings("unchecked")
    private static void spread(Map<String, Object> into, Object value) {
        if (value instanceof Map) {
            into.putAll((Map<String, Object>) value);
        } else if (value instanceof List) {
            List<Object> list = (List<Object>) value;
            for (int i = 0; i < list.size(); i++) {
                into.put(Integer.toString(i), list.get(i));
            }
        } else if (value instanceof String) {
            String s = (String) value;
            for (int i = 0; i < s.length(); i++) {
                into.put(Integer.toString(i), String.valueOf(s.charAt(i)));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private ProofBundle.Input common(Map<String, Object> att, Map<String, Object> descriptor) {
        ProofBundle.Input in = new ProofBundle.Input();
        in.leafBytesHex = (String) att.get("leaf_bytes");
        in.contentType = has(att.get("content_type")) ? (String) att.get("content_type") : null;
        if (has(att.get("statement"))) {
            Object statement = Js.parse((String) att.get("statement"));
            // A statement is stored as the object it arrived as; anything else is carried as the bundle would have carried it.
            in.statement = statement instanceof Map ? (Map<String, Object>) statement : null;
        }
        spread(descriptor, Js.parse((String) att.get("descriptor")));
        in.descriptor = descriptor;
        in.network = cfg.bitcoinNetwork;
        in.generatedAt = IsoTime.now();
        return in;
    }

    /**
     * Bundle for an inscription — no tree, and the original is already
     * inside. The reveal transaction is the whole proof: its output commits
     * the digest, its witness carries the bytes.
     */
    private Map<String, Object> witnessBundleFor(Map<String, Object> att) {
        if (!has(att.get("reveal_txid")) || !has(att.get("reveal_tx_hex"))) {
            throw new ServiceError(500, "inscription_incomplete", "this inscription has no reveal transaction recorded");
        }
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("attestation_id", att.get("id"));
        ProofBundle.Input in = common(att, descriptor);
        in.anchorTxid = (String) att.get("reveal_txid");
        in.anchorRawTxHex = (String) att.get("reveal_tx_hex");
        // In this mode the anchor output is the leaf, which is what makes the bundle self-contained without a Merkle section.
        in.anchorPayloadHex = (String) att.get("leaf_bytes");
        in.witnessInputIndex = 0L;
        in.witnessContentType = has(att.get("content_type")) ? (String) att.get("content_type") : null;
        in.witnessProtocolTag = has(att.get("protocol_tag")) ? (String) att.get("protocol_tag") : null;
        if ("confirmed".equals(att.get("status"))) {
            in.confirmed = true;
            in.blockHeight = number(att.get("block_height"));
            in.blockHash = (String) att.get("block_hash");
            in.confirmations = number(att.get("confirmations"));
        }
        in.commitTxid = has(att.get("commit_txid")) ? (String) att.get("commit_txid") : null;
        return ProofBundle.assemble(in);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> bundleFor(Map<String, Object> att) {
        if ("inscription".equals(att.get("kind"))) {
            return witnessBundleFor(att);
        }
        String batchId = (String) att.get("batch_id");
        if (!has(batchId)) {
            throw new ServiceError(409, "not_batched", "this attestation is accepted but not yet in a batch, so no proof exists yet");
        }
        Map<String, Object> proof = mapper.proof((String) att.get("id"));
        Map<String, Object> batch = mapper.batch(batchId);
        Map<String, Object> anchor = mapper.anchor(batchId);
        if (proof == null || batch == null) {
            throw new ServiceError(500, "proof_missing", "batch is sealed but its proof is absent");
        }
        if (anchor == null) {
            throw new ServiceError(409, "not_anchored", "this batch is sealed but not yet submitted to the chain, so there is nothing to anchor against");
        }
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("attestation_id", att.get("id"));
        descriptor.put("batch_id", batchId);
        ProofBundle.Input in = common(att, descriptor);
        List<String> siblings = new ArrayList<>();
        for (Object s : (List<Object>) Js.parse((String) proof.get("siblings"))) {
            siblings.add((String) s);
        }
        List<String> directions = new ArrayList<>();
        for (Object d : (List<Object>) Js.parse((String) proof.get("directions"))) {
            directions.add((String) d);
        }
        in.merkle = new Merkle.Proof(((Number) proof.get("leaf_index")).intValue(), (String) batch.get("merkle_root"), siblings, directions);
        in.anchorTxid = (String) anchor.get("txid");
        in.anchorRawTxHex = (String) anchor.get("raw_tx_hex");
        in.anchorPayloadHex = (String) anchor.get("payload_hex");
        if ("confirmed".equals(anchor.get("status"))) {
            in.confirmed = true;
            in.blockHeight = number(anchor.get("block_height"));
            in.blockHash = (String) anchor.get("block_hash");
            in.confirmations = number(anchor.get("confirmations"));
        }
        return ProofBundle.assemble(in);
    }
}
