package com.stonehash.attest.core.remit;

/** What one attempt at a job came to — the handler's answer to the executor. */
public final class JobResult {
    public enum Status {
        /** The handler closed the job itself, in the transaction of its last transition. Nothing is left to do. */
        CLOSED,
        /** As {@link #CLOSED}, and that transaction inserted the next job, claimed: the executor runs it next, the same way it ran this one. */
        NEXT,
        /**
         * Not done, and trying again is safe: the outbound call certainly did
         * not leave, or something failed inside. The executor waits as
         * {@code REMIT_STEP_RETRY_MS} says and starts another attempt; when
         * the delays are spent it calls {@link JobHandler#giveUp} with the
         * error.
         */
        RETRY,
        /** Not done, and it never will be: the executor calls {@link JobHandler#giveUp} with the error now. */
        FAILED
    }

    public final Status status;
    /** {@link Status#NEXT}: the claim of the job that follows. */
    public final RemitJobs.Held next;
    /** {@link Status#RETRY}, {@link Status#FAILED}: the sentence that says why (see {@link JobHandler#giveUp}). */
    public final String error;

    private JobResult(Status status, RemitJobs.Held next, String error) {
        this.status = status;
        this.next = next;
        this.error = error;
    }

    public static JobResult closed() {
        return new JobResult(Status.CLOSED, null, null);
    }

    public static JobResult next(RemitJobs.Held next) {
        return next == null ? closed() : new JobResult(Status.NEXT, next, null);
    }

    public static JobResult retry(String error) {
        return new JobResult(Status.RETRY, null, error);
    }

    public static JobResult failed(String error) {
        return new JobResult(Status.FAILED, null, error);
    }
}
