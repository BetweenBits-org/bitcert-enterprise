package com.stonehash.attest.core.audit;

/**
 * Who a request acted as: an API key, named by the label its owner gave it,
 * or a console session, named by the account's email. The label is copied
 * into the audit row when it is written — an entry must keep saying who
 * acted after the key is renamed or revoked.
 */
public final class AuditActor {
    public final String orgId;
    /** {@code api_key} or {@code session}. */
    public final String actorType;
    /** {@code api_keys.id} or {@code accounts.id}. */
    public final String actorId;
    public final String actorLabel;

    private AuditActor(String orgId, String actorType, String actorId, String actorLabel) {
        this.orgId = orgId;
        this.actorType = actorType;
        this.actorId = actorId;
        this.actorLabel = actorLabel;
    }

    public static AuditActor key(String orgId, String keyId, String label) {
        return new AuditActor(orgId, "api_key", keyId, label);
    }

    public static AuditActor session(String orgId, String accountId, String email) {
        return new AuditActor(orgId, "session", accountId, email);
    }
}
