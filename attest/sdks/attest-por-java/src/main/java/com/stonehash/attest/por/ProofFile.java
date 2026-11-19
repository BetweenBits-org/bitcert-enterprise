package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * A customer's proof file: their inclusion proof together with what it is to
 * be checked against — the exchange, the as-of time, the root and the totals
 * of the statement (specification §8).
 *
 * <p>It carries the customer's own account reference, so it is handed to that
 * customer and to nobody else. They, or anyone they show it to, check it
 * against the published statement with no account at the platform and no
 * network.
 */
public final class ProofFile {
    public static final String SCHEMA = "stonehash.por-proof.v1";
    private static final String CODE = "invalid_proof";

    private final Map<String, Object> json;
    private final InclusionProof proof;

    private ProofFile(Map<String, Object> json, InclusionProof proof) {
        this.json = json;
        this.proof = proof;
    }

    /**
     * Issues the proof file for one account.
     *
     * @throws PorException {@code statement_mismatch} when the statement is not this tree's — a proof issued
     *                      under another root would fail in the customer's hands; {@code unknown_account}
     *                      when the ledger had no such account
     */
    public static ProofFile issue(Statement statement, PorTree tree, String userRef) {
        Objects.requireNonNull(statement, "statement").requireValid();
        Objects.requireNonNull(tree, "tree");
        if (!tree.root().equals(statement.root()) || tree.leafCount() != statement.leafCount()
                || !tree.totals().equals(statement.totals())) {
            throw new PorException("statement_mismatch",
                    "the statement does not declare this tree's root, totals and account count; no proof was issued");
        }
        InclusionProof proof = tree.proveAccount(userRef);
        Map<String, Object> st = statement.toMap();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", SCHEMA);
        out.put("exchange", st.get("exchange"));
        out.put("asof", st.get("asof"));
        out.put("root", statement.root());
        out.put("totals", st.get("totals"));
        out.put("leaf_count", (long) statement.leafCount());
        out.put("user_ref", proof.leaf().userRef());
        out.put("proof", proof.toMap());
        return new ProofFile(Collections.unmodifiableMap(out), proof);
    }

    /**
     * Reads a proof file.
     *
     * @throws PorException {@code invalid_proof} when the text is not JSON or the proof inside is not of the
     *                      specification's shape
     */
    @SuppressWarnings("unchecked")
    public static ProofFile parse(String json) {
        Map<String, Object> m = Json.object(Json.parse(Objects.requireNonNull(json, "json"), CODE), CODE, "the proof file");
        Object userRef = m.get("user_ref");
        if (userRef != null && !(userRef instanceof String)) {
            throw new PorException(CODE, "user_ref must be a string");
        }
        return new ProofFile((Map<String, Object>) Json.freeze(m), InclusionProof.fromJson(m.get("proof")));
    }

    /** The account reference the file names as its owner's, or null when it names none. */
    public String userRef() {
        return (String) json.get("user_ref");
    }

    public InclusionProof proof() {
        return proof;
    }

    /**
     * Checks the proof against a statement's root and totals — the published
     * statement, not the copies of those values inside this file.
     */
    public ProofVerification verify(Statement statement) {
        Map<String, BigInteger> totals = Objects.requireNonNull(statement, "statement").totals();
        return proof.verify(statement.root(), totals);
    }

    /**
     * Whether the account reference the file names is the one its leaf was
     * hashed from, under the given exchange id. True when the file names no
     * reference: there is then nothing to contradict.
     */
    public boolean referenceMatches(String exchangeId) {
        String userRef = userRef();
        if (userRef == null) {
            return true;
        }
        return Text.isWellFormed(userRef) && Leaves.userRefHash(exchangeId, userRef).equals(proof.leaf().userRefHash());
    }

    public Map<String, Object> toMap() {
        return json;
    }

    /** The file's contents: indented JSON, without the final line break. */
    public String toJson() {
        return Json.pretty(json);
    }
}
