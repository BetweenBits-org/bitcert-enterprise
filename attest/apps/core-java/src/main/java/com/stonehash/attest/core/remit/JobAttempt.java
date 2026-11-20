package com.stonehash.attest.core.remit;

import java.util.Map;

/**
 * One attempt at a job: the claim it runs under, and the job's row as it was when the attempt started.
 *
 * <p>What an attempt is <em>not</em> told is how the attempt before it ended. The row does not keep it: a job whose
 * holder said "try again" and a job whose holder was lost half-way (its lease ran out and somebody claimed it again)
 * look the same once they are claimed. So a handler never assumes that an earlier attempt ended in order — in
 * particular not that its outbound call did not leave. It decides from what is on record: the settlement's state and
 * events, {@link #input} (the body was made, so it may have been sent) and {@link #callStarted}.
 */
public final class JobAttempt {
    /** The claim. Every fenced write of this attempt carries it. */
    public final RemitJobs.Held job;
    public final String paymentId;
    public final String orgId;
    public final RemitJobs.Kind kind;
    /** How many attempts have been started, this one included: 1 for the first — counted by the fenced start, so 1 means that no attempt was ever begun before this one. */
    public final int attempts;
    /** What the job carries beyond the settlement's row and events (JSON text), or {@code null}. */
    public final String input;
    /** The key the job's outbound call carries, or {@code null}. */
    public final String idempotencyKey;
    /** The wallet may have been called under this job before this attempt ({@code call_started_at} is set). */
    public final boolean callStarted;

    public JobAttempt(RemitJobs.Held job, Map<String, Object> row) {
        this.job = job;
        this.paymentId = (String) row.get("payment_id");
        this.orgId = (String) row.get("org_id");
        this.kind = RemitJobs.Kind.valueOf((String) row.get("kind"));
        this.attempts = ((Number) row.get("attempts")).intValue();
        this.input = (String) row.get("input");
        this.idempotencyKey = (String) row.get("idempotency_key");
        this.callStarted = row.get("call_started_at") != null;
    }
}
