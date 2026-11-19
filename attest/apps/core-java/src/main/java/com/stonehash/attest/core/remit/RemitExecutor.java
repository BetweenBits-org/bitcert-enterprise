package com.stonehash.attest.core.remit;

/**
 * Where a settlement's work goes once the transaction that made it necessary
 * has committed.
 *
 * <p>A transition inserts its next job already claimed
 * ({@link RemitJobs#insertClaimed}) and, after the commit, hands the claim
 * over here: the moment the service this one replaces went on in memory.
 * The job is in the store before this is called, so nothing is lost when the
 * hand-over fails or the process stops right after it: a job whose lease
 * runs out is there for whoever claims it next.
 *
 * <p>An executor runs a job by giving it to the {@link JobHandler} of its
 * kind, one attempt at a time, and acts on what the attempt came to
 * ({@link JobResult}). It knows nothing about what a kind of job does.
 *
 * <p>This is the seam between the parts of the rail: whoever makes a job
 * (acceptance, a leg of the pipeline, a callback, a cancellation, the
 * periodic worker picking up an orphaned job) calls one of the two methods
 * and needs to know no more.
 */
public interface RemitExecutor {
    /**
     * Run this job now, off the caller's thread. Called after the inserting
     * transaction committed (or after a claim), with the claim the job is
     * held under. Must not block the caller and must not throw. When the job
     * cannot be taken (the executor is full or stopping) it is put back into
     * the queue for whoever claims it next.
     */
    void runNow(RemitJobs.Held job);

    /**
     * Run this job on the calling thread, and after it the jobs it leads to
     * ({@link JobResult#next}), and return when that chain has ended — done,
     * waiting to be tried again, or given up. For the requests that finish
     * their work before they answer (a completion callback reconciles and
     * packages inside the request). Must not throw: whatever happened is in
     * the store, and the caller answers from the store.
     */
    void runInline(RemitJobs.Held job);
}
