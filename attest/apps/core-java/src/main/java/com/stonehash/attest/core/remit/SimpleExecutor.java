package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.log.Log;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * The plainest executor that honours the seam: one thread, one attempt, no
 * waiting.
 *
 * <p>A job handed over is started and given to the handler of its kind. What
 * the attempt comes to is acted on at once: a next job is run next; a job
 * that asks to be tried again, fails for good, or throws is given up
 * ({@link JobHandler#giveUp}) — there are no retries here, no timers, no
 * renewal of leases of jobs that wait for the thread, and a stop does not
 * wait for a call in flight. A kind without a handler is left as it is: the
 * job stays in the store, held until its lease runs out.
 *
 * <p>It exists so that every part of the rail can be run end to end before
 * the full job runner is there, and it behaves as a deployment with
 * {@code REMIT_STEP_RETRY_MS=off} is meant to: the first failure ends the
 * step. To be replaced by the job runner (design 3.2–3.5, 8), not extended.
 */
@Component
public class SimpleExecutor implements RemitExecutor, DisposableBean {
    /** What an attempt that threw leaves behind: nothing of the exception reaches an event or a caller. */
    public static final String INTERNAL_ERROR = "the platform could not complete this step (internal error)";
    /** What a job that was started too often leaves behind. */
    public static final String TOO_MANY_ATTEMPTS = "the step did not complete after " + RemitJobs.MAX_ATTEMPTS + " attempts";

    private final RemitJobs jobs;
    private final ObjectProvider<List<JobHandler>> handlerBeans;
    private Map<RemitJobs.Kind, JobHandler> handlers;
    private final ExecutorService thread = Executors.newSingleThreadExecutor((r) -> {
        Thread t = new Thread(r, "remit-executor");
        t.setDaemon(true);
        return t;
    });

    public SimpleExecutor(RemitJobs jobs, ObjectProvider<List<JobHandler>> handlerBeans) {
        this.jobs = jobs;
        // Looked up when first needed: the handlers need this executor to be there before they are.
        this.handlerBeans = handlerBeans;
    }

    private synchronized JobHandler handlerOf(RemitJobs.Kind kind) {
        if (handlers == null) {
            Map<RemitJobs.Kind, JobHandler> found = new EnumMap<>(RemitJobs.Kind.class);
            List<JobHandler> beans = handlerBeans.getIfAvailable();
            if (beans != null) {
                for (JobHandler h : beans) {
                    if (found.put(h.kind(), h) != null) {
                        throw new IllegalStateException("two handlers for the job kind " + h.kind());
                    }
                }
            }
            handlers = found;
        }
        return handlers.get(kind);
    }

    @Override
    public void runNow(RemitJobs.Held job) {
        try {
            thread.execute(() -> chain(job));
        } catch (RejectedExecutionException e) {
            // Stopping: back into the queue, for whoever claims it next.
            try {
                jobs.requeue(job);
            } catch (RuntimeException ignored) {
                // The lease runs out by itself.
            }
        }
    }

    @Override
    public void runInline(RemitJobs.Held job) {
        chain(job);
    }

    private void chain(RemitJobs.Held job) {
        RemitJobs.Held current = job;
        while (current != null) {
            current = attempt(current);
        }
    }

    /** One attempt at one job. Returns the claim of the job that follows, or {@code null} when the chain ends here. */
    private RemitJobs.Held attempt(RemitJobs.Held job) {
        try {
            Map<String, Object> before = jobs.get(job.id);
            if (before == null) {
                return null;
            }
            JobHandler handler = handlerOf(RemitJobs.Kind.valueOf((String) before.get("kind")));
            if (handler == null) {
                // No part of this build runs that kind: the job stays in the store.
                return null;
            }
            if (!jobs.start(job)) {
                return null; // somebody else's now
            }
            JobAttempt attempt = new JobAttempt(job, jobs.get(job.id), false);
            if (attempt.attempts > RemitJobs.MAX_ATTEMPTS) {
                handler.giveUp(attempt, TOO_MANY_ATTEMPTS);
                return null;
            }
            JobResult result;
            try {
                result = handler.run(attempt);
            } catch (Exception e) {
                Log.line("remit job failed inside", Log.fields("job", job.id, "kind", attempt.kind.name(), "payment", attempt.paymentId,
                        "error", String.valueOf(e)));
                handler.giveUp(attempt, INTERNAL_ERROR);
                return null;
            }
            switch (result.status) {
                case NEXT:
                    return result.next;
                case RETRY:
                case FAILED:
                    handler.giveUp(attempt, result.error);
                    return null;
                default:
                    return null;
            }
        } catch (Throwable e) {
            Log.line("remit executor failed", Log.fields("job", job.id, "error", String.valueOf(e)));
            return null;
        }
    }

    @Override
    public void destroy() {
        thread.shutdown();
        try {
            thread.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
