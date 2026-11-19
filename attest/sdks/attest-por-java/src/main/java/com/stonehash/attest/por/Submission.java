package com.stonehash.attest.por;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * The file that is sent: a statement and the exchange's signature over it,
 * and nothing else ({@code submission.json}, specification §6).
 *
 * <p>Signing is its own step, apart from sending, for two reasons that come
 * from how an exchange runs. The machine that holds the signing key is often
 * not the machine allowed to open a connection to the internet, so signing
 * has to end in something that can be carried from one to the other. And
 * before anything leaves the building somebody will want to read it: what
 * this object holds is byte for byte what {@link PorClient#submit} sends.
 */
public final class Submission {
    public static final String SCHEMA = "stonehash.por-submission.v1";
    private static final String CODE = "invalid_submission";

    private final String schema;
    private final Statement statement;
    private final SignatureEnvelope signature;

    private Submission(String schema, Statement statement, SignatureEnvelope signature) {
        this.schema = schema;
        this.statement = statement;
        this.signature = signature;
    }

    /**
     * Checks the statement and signs it.
     *
     * @throws PorException {@code invalid_statement} when the statement is not one the platform would accept —
     *                      refused here, before a signature exists over it
     */
    public static Submission sign(Statement statement, Signer signer) {
        Objects.requireNonNull(statement, "statement").requireValid();
        return new Submission(SCHEMA, statement, SignatureEnvelope.sign(statement, signer));
    }

    /** A submission from a statement and a signature made elsewhere. */
    public static Submission of(Statement statement, SignatureEnvelope signature) {
        return new Submission(SCHEMA, Objects.requireNonNull(statement, "statement"),
                Objects.requireNonNull(signature, "signature"));
    }

    /**
     * Reads {@code submission.json}. The result may still be unusable;
     * {@link #validate()} says.
     *
     * @throws PorException {@code invalid_submission} when the text is not a JSON object holding a statement and a signature
     */
    public static Submission parse(String json) {
        Map<String, Object> m = Json.object(Json.parse(Objects.requireNonNull(json, "json"), CODE), CODE, "the submission");
        if (!(m.get("statement") instanceof Map) || !(m.get("sig") instanceof Map)) {
            throw new PorException(CODE, "a submission holds a statement and a sig");
        }
        Object schema = m.get("schema");
        try {
            return new Submission(schema instanceof String ? (String) schema : null,
                    Statement.fromMap(Json.object(m.get("statement"), CODE, "statement")),
                    SignatureEnvelope.fromJson(m.get("sig")));
        } catch (PorException e) {
            throw new PorException(CODE, e.getMessage());
        }
    }

    /** Everything that makes this submission unusable; empty when it can be sent. The signature itself is not checked here. */
    public List<String> validate() {
        List<String> problems = new ArrayList<>();
        if (!SCHEMA.equals(schema)) {
            problems.add("schema must be " + SCHEMA);
        }
        problems.addAll(statement.validate());
        if (!signature.wellFormed()) {
            problems.add("sig must be an ES256 signature of 64 bytes, base64url");
        }
        return problems;
    }

    /** Whether the signature is the given registered key's signature over the statement. */
    public boolean verifies(String spkiBase64) {
        return signature.verifies(statement, spkiBase64);
    }

    public Statement statement() {
        return statement;
    }

    public SignatureEnvelope signature() {
        return signature;
    }

    public Map<String, Object> toMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", schema);
        out.put("statement", statement.toMap());
        out.put("sig", signature.toMap());
        return out;
    }

    /** The submission as indented JSON text, the form in which {@code submission.json} holds it. */
    public String toJson() {
        return Json.pretty(toMap());
    }
}
