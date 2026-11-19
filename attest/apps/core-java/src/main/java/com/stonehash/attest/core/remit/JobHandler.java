package com.stonehash.attest.core.remit;

/**
 * What one kind of job does. One handler per {@link RemitJobs.Kind}; the
 * executor finds it by kind.
 *
 * <p>The division of labour with the executor ({@link RemitExecutor}):
 * <ul>
 * <li>The <b>executor</b> owns the job's row while the attempt runs: it has
 *     started the job (fenced: the attempt is counted, the lease counts from
 *     now) before {@link #run} is called, schedules the next attempt when the
 *     handler asks for one, and calls {@link #giveUp} when there will be no
 *     further attempt.
 * <li>The <b>handler</b> owns the settlement: it reads the settlement's
 *     state and events first (a step whose result is already recorded ends
 *     without a call; a settlement that has ended ends the job), does its
 *     transitions — each one transaction, the settlement's row locked first —
 *     and its outbound call outside any transaction. A transition that
 *     records a result closes the job in that same transaction
 *     ({@link RemitJobs#closeAnyway}: a result is not fenced) and, where a
 *     next job of the same lane follows, inserts it claimed after closing
 *     this one. A transition before the call is fenced
 *     ({@link RemitJobs#renew}, {@link RemitJobs#setInput},
 *     {@link RemitJobs#markCallStarted}: zero rows means the job is somebody
 *     else's now — stop, write nothing more).
 * </ul>
 */
public interface JobHandler {
    /** The kind of job this handler runs. */
    RemitJobs.Kind kind();

    /**
     * One attempt.
     *
     * @return what the attempt came to; never {@code null}
     * @throws Exception a failure the handler does not name: the executor treats it as {@link JobResult#retry} with a
     *         fixed sentence (nothing of the exception reaches a caller or an event)
     */
    JobResult run(JobAttempt attempt) throws Exception;

    /**
     * There will be no further attempt: the job failed for good
     * ({@link JobResult#failed}), its retries are spent, or it was started
     * {@link RemitJobs#MAX_ATTEMPTS} times without ending. The handler ends
     * what it owns: a job of the pipeline (and the settlement notice) moves
     * the settlement to {@code EXCEPTION} under its own condition and closes
     * the job; any other job is closed as {@link RemitJobs#ATTENTION}. Both
     * are fenced by the job's claim, and both close the job also when the
     * settlement's condition no longer holds (the step's result is on file:
     * {@code done}; the settlement has ended: {@code cancelled}).
     *
     * @param error the sentence that says why — it is stored (an {@code EXCEPTION} event's {@code error}, the job's
     *        {@code last_error}) and read by programs, so it is one of the sentences the design names
     */
    void giveUp(JobAttempt attempt, String error);
}
