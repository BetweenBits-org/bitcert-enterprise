package com.stonehash.attest.por;

import java.util.Collections;
import java.util.List;

/** What came of handing a signed statement to the platform. */
public final class SubmitResult {
    private final String snapshotId;
    private final String attestationId;
    private final String status;
    private final int sampledAccounts;
    private final boolean already;
    private final boolean spotCheck;
    private final List<InclusionProof> openings;

    SubmitResult(String snapshotId, String attestationId, String status, int sampledAccounts, boolean already,
            boolean spotCheck, List<InclusionProof> openings) {
        this.snapshotId = snapshotId;
        this.attestationId = attestationId;
        this.status = status;
        this.sampledAccounts = sampledAccounts;
        this.already = already;
        this.spotCheck = spotCheck;
        this.openings = Collections.unmodifiableList(openings);
    }

    /** The platform's id for this snapshot; what {@link PorClient#status} and the public URL take. */
    public String snapshotId() {
        return snapshotId;
    }

    /** The id of the anchoring record the commitment was issued under. */
    public String attestationId() {
        return attestationId;
    }

    /** {@code ACCEPTED}: taken on the signature alone. {@code VERIFIED}: the spot check passed first. */
    public String status() {
        return status;
    }

    /** Accounts opened to the platform: 0 unless a spot check was asked for. */
    public int sampledAccounts() {
        return sampledAccounts;
    }

    /** The platform already held this exact statement and answered with the earlier record. */
    public boolean already() {
        return already;
    }

    public boolean spotCheck() {
        return spotCheck;
    }

    /**
     * After a spot check: exactly what was sent in answer to the challenge —
     * the only account-level data that left. Empty otherwise.
     */
    public List<InclusionProof> openings() {
        return openings;
    }
}
