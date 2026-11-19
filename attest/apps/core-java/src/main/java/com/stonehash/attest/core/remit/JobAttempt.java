package com.stonehash.attest.core.remit;

import java.util.Map;

/** One attempt at a job: the claim it runs under, and the job's row as it was when the attempt started. */
public final class JobAttempt {
    /** The claim. Every fenced write of this attempt carries it. */
    public final RemitJobs.Held job;
    public final String paymentId;
    public final String orgId;
    public final RemitJobs.Kind kind;
    /** How many attempts have been started, this one included: 1 for the first. */
    public final int attempts;
    /** What the job carries beyond the settlement's row and events (JSON text), or {@code null}. */
    public final String input;
    /** The key the job's outbound call carries, or {@code null}. */
    public final String idempotencyKey;
    /** The wallet may have been called under this job before this attempt ({@code call_started_at} is set). */
    public final boolean callStarted;
    /**
     * This attempt follows a claim of a job whose holder's lease had run
     * out: nobody knows how far the attempt before it came — in particular
     * whether its outbound call left.
     */
    public final boolean afterLostLease;

    public JobAttempt(RemitJobs.Held job, Map<String, Object> row, boolean afterLostLease) {
        this.job = job;
        this.paymentId = (String) row.get("payment_id");
        this.orgId = (String) row.get("org_id");
        this.kind = RemitJobs.Kind.valueOf((String) row.get("kind"));
        this.attempts = ((Number) row.get("attempts")).intValue();
        this.input = (String) row.get("input");
        this.idempotencyKey = (String) row.get("idempotency_key");
        this.callStarted = row.get("call_started_at") != null;
        this.afterLostLease = afterLostLease;
    }
}
