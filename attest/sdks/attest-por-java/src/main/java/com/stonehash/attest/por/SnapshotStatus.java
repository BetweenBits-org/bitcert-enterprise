package com.stonehash.attest.por;

import java.util.Map;

/**
 * What the platform holds for a snapshot: its state, the root and totals it
 * recorded, and where the anchor stands.
 */
public final class SnapshotStatus {
    private final Map<String, Object> json;

    SnapshotStatus(Map<String, Object> json) {
        this.json = json;
    }

    public String snapshotId() {
        return text("snapshot_id");
    }

    /** {@code ACCEPTED}, {@code CHALLENGED}, {@code VERIFIED} or {@code REJECTED}. */
    public String status() {
        return text("status");
    }

    public String root() {
        return text("root");
    }

    public String commitment() {
        return text("commitment");
    }

    /** The state of the anchoring record ({@code confirmed} once anchored), or null while there is none. */
    public String attestationStatus() {
        Object attestation = json.get("attestation");
        Object status = attestation instanceof Map ? ((Map<?, ?>) attestation).get("status") : null;
        return status instanceof String ? (String) status : null;
    }

    /** True once the commitment's anchor is confirmed. */
    public boolean anchored() {
        return "confirmed".equals(attestationStatus());
    }

    /** The platform's whole answer, as an unmodifiable JSON value. */
    public Map<String, Object> toMap() {
        return json;
    }

    /** The platform's whole answer as indented JSON text. */
    public String toJson() {
        return Json.pretty(json);
    }

    private String text(String key) {
        Object v = json.get(key);
        return v instanceof String ? (String) v : null;
    }
}
