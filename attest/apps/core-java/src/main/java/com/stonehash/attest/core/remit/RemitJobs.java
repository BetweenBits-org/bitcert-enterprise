package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.db.TimeOrderedId;
import com.stonehash.attest.core.json.Js;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

/**
 * What is still to be done for a settlement after its request was answered,
 * kept in the store ({@code remit_jobs}) so that a restart continues it.
 *
 * <p>This is the store's half: the rows, and the three rules they carry.
 * Running a job — the calls, the transitions, the retries — is the
 * executor's.
 *
 * <ul>
 * <li><b>One open job per settlement and lane.</b> The pipeline (travel
 *     rule, approval, transfer) is one lane, the notices to the partner
 *     another, the evidence (reconciliation, package) a third. The table's
 *     unique key refuses a second open job in a lane; a closed job does not
 *     count. So the next job of a lane is inserted only after the current
 *     one was closed, in the same transaction.
 * <li><b>A claim is one statement</b> ({@link #claim}): a job that is queued,
 *     or waiting and due, or running under a lease that ran out, becomes the
 *     claimer's for {@value #LEASE_SECONDS} seconds — and of two claimers one
 *     gets the row. A claim, also the one a job is inserted with
 *     ({@link #insertClaimed}), is named by a token made for that claim
 *     alone, not by the process: a hand-over that went stale and a fresh
 *     claim in the same process must not take each other for themselves.
 * <li><b>The fence.</b> What a job's holder writes to its row before it has
 *     a result — the start, a renewed lease, the mark that the wallet is
 *     about to be called, a failure, a wait — is written only while the job
 *     is still running and still that claim's ({@link Held}). A write that
 *     matches nothing means the job is somebody else's now: the holder
 *     writes nothing more and stops. A transition that records a
 *     <em>result</em> is not fenced ({@link #closeAnyway}): a verified
 *     answer is not thrown away because the lease ran out while it was on
 *     its way.
 * </ul>
 *
 * <p>Every time in this table is the database's clock's, so two instances
 * need not agree on the time for a lease to mean the same to both.
 */
@Component
public class RemitJobs {
    /** How long a claim holds without being renewed. An outbound call is limited to 20 seconds, so a live holder's lease does not run out mid-call. */
    public static final long LEASE_SECONDS = 60;
    /** A job that was started this often and is still not done is not started again. */
    public static final int MAX_ATTEMPTS = 5;

    /** What a job does, and the lane it runs in. */
    public enum Kind {
        TRAVEL_RULE("pipeline"), PAYOUT_APPROVAL("pipeline"), TRANSFER("pipeline"),
        SETTLEMENT_NOTICE("notice"), CANCEL_NOTICE("notice"),
        RECONCILE("evidence"), PACKAGE("evidence");

        public final String lane;

        Kind(String lane) {
            this.lane = lane;
        }
    }

    /** The states a job is closed in. Anything else ({@code queued}, {@code running}, {@code waiting}) is open. */
    public static final String DONE = "done";
    /** The settlement ended first; nothing was left to do. */
    public static final String CANCELLED = "cancelled";
    /** A person has to look. */
    public static final String ATTENTION = "attention";

    /** A job, and the claim it is held under. */
    public static final class Held {
        public final String id;
        /** The token of this one claim. */
        public final String owner;

        Held(String id, String owner) {
            this.id = id;
            this.owner = owner;
        }
    }

    private final RemitMapper mapper;

    public RemitJobs(RemitMapper mapper) {
        this.mapper = mapper;
    }

    private static String newOwner() {
        return UUID.randomUUID().toString();
    }

    private static String text(Object input) {
        return input == null ? null : Js.stringify(input);
    }

    // ── making a job ─────────────────────────────────────────────────────────

    /**
     * A job that is its inserter's from its first moment — {@code running},
     * under a fresh claim. Inserted by the transition that makes the work
     * necessary, in that transition's transaction; once it has committed the
     * inserter hands the job to its executor. No worker can take it in
     * between.
     *
     * @param idempotencyKey the key the job's outbound call carries, or {@code null}
     * @param input what the call needs beyond the settlement's row and events (a JSON value), or {@code null}
     * @throws DuplicateKeyException when the settlement already has an open job in that lane
     */
    public Held insertClaimed(String paymentId, String orgId, Kind kind, String idempotencyKey, Object input) {
        Held held = new Held(TimeOrderedId.next(), newOwner());
        mapper.insertClaimedJob(held.id, paymentId, orgId, kind.name(), kind.lane, idempotencyKey, text(input), held.owner, LEASE_SECONDS);
        return held;
    }

    /**
     * A job nobody holds yet: due at once, for whoever claims it first.
     *
     * @return its id
     * @throws DuplicateKeyException when the settlement already has an open job in that lane
     */
    public String insertQueued(String paymentId, String orgId, Kind kind, String idempotencyKey, Object input) {
        String id = TimeOrderedId.next();
        mapper.insertQueuedJob(id, paymentId, orgId, kind.name(), kind.lane, idempotencyKey, text(input));
        return id;
    }

    // ── claiming ─────────────────────────────────────────────────────────────

    /**
     * Claim a job that nobody holds: queued, waiting and due, or running
     * under a lease that ran out.
     *
     * @return the claim, or {@code null} when the job is not there to be claimed — someone holds it, it is not due, or it is closed
     */
    public Held claim(String id) {
        Held held = new Held(id, newOwner());
        return mapper.claimJob(id, held.owner, LEASE_SECONDS) == 1 ? held : null;
    }

    /** {@code id, payment_id, kind, lane, state, attempts} of jobs nobody holds, oldest first: what a worker picks up after their owner stopped. */
    public List<Map<String, Object>> claimable(int limit) {
        return mapper.claimableJobs(limit);
    }

    // ── what the holder writes: fenced ───────────────────────────────────────

    /**
     * The work starts now: the attempt is counted and the lease counts from
     * this moment (the time a job spent waiting for a thread is not an
     * attempt).
     *
     * @return {@code false} when the job is no longer this claim's — the holder stops
     */
    public boolean start(Held job) {
        return mapper.startJob(job.id, job.owner, LEASE_SECONDS) == 1;
    }

    /** Renew the lease — right before an outbound call, and while a job waits for a thread. {@code false}: no longer this claim's. */
    public boolean renew(Held job) {
        return mapper.renewJobLease(job.id, job.owner, LEASE_SECONDS) == 1;
    }

    /**
     * The wallet is about to be called: from here on the transfer may have
     * gone out. Written in the transaction that records the instruction;
     * only the holder that commits it calls the wallet, once.
     */
    public boolean markCallStarted(Held job) {
        return mapper.markJobCallStarted(job.id, job.owner, LEASE_SECONDS) == 1;
    }

    /** Keep what the call needs — the body as it was first made, so that sending again sends the same bytes. {@code idempotencyKey} null leaves the key as it is. */
    public boolean setInput(Held job, Object input, String idempotencyKey) {
        return mapper.setJobInput(job.id, job.owner, text(input), idempotencyKey) == 1;
    }

    /** To be tried again after a delay; the claim is given up. */
    public boolean waitFor(Held job, long delayMs, String error) {
        return mapper.jobWaits(job.id, job.owner, delayMs, error) == 1;
    }

    /** Back into the queue, unstarted: the holder could not give it a thread. */
    public boolean requeue(Held job) {
        return mapper.requeueHeldJob(job.id, job.owner) == 1;
    }

    /**
     * Close the job as its holder: {@link #DONE}, {@link #CANCELLED} or
     * {@link #ATTENTION}. For what is written before a result exists — a
     * failure, a job that found nothing left to do.
     *
     * @return {@code false} when the job is no longer this claim's: nothing was written, and the transaction this is part of must not commit
     */
    public boolean close(Held job, String state, String error) {
        return mapper.closeHeldJob(job.id, job.owner, state, error) == 1;
    }

    // ── not fenced ───────────────────────────────────────────────────────────

    /**
     * Close the job whoever holds it. For the transition that records a
     * result (a verified answer of a partner, a verdict, a package), whose
     * condition is the settlement's state and events and not the job's
     * ownership — and for a result that arrived after the settlement had
     * moved on, which is recorded and left for a person ({@link #ATTENTION}).
     */
    public void closeAnyway(String id, String state, String error) {
        mapper.closeJob(id, state, error);
    }

    /**
     * An {@link #ATTENTION} job back into the queue, with no attempt counted
     * against it.
     *
     * @return {@code false} when the job is not in {@code attention}, or the settlement has another open job in that lane
     */
    public boolean reopen(String id) {
        try {
            return mapper.reopenJob(id) == 1;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    // ── reading ──────────────────────────────────────────────────────────────

    /** Every column of a job, or {@code null}. Besides the columns: {@code due} and {@code lease_expired}, by the database's clock (1 or 0). */
    public Map<String, Object> get(String id) {
        return mapper.job(id);
    }

    public List<Map<String, Object>> ofPayment(String paymentId) {
        return mapper.jobsOfPayment(paymentId);
    }

    /** The settlement's open job in a lane, or {@code null}. */
    public Map<String, Object> open(String paymentId, String lane) {
        return mapper.openJob(paymentId, lane);
    }

    /** Jobs that are open or wait for a person, oldest first. */
    public List<Map<String, Object>> unfinished() {
        return mapper.unfinishedJobs();
    }
}
