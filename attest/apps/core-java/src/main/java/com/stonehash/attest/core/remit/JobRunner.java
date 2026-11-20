package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.db.TxRetry;
import com.stonehash.attest.core.log.Log;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The executor of the rail's jobs: a few threads in each process that run a
 * job the moment the transaction that made it has committed, and run it
 * again, after a pause, when an attempt did not get through.
 *
 * <p><b>Taking a job.</b> A job handed over ({@link #runNow}) waits in a
 * queue of {@value #QUEUE} for one of {@value #THREADS} threads. It is held
 * under its claim all the while, so the lease of every job in the queue is
 * renewed every {@value #RENEW_QUEUED_MS} ms: a job that waits for a thread
 * is not taken for one whose holder is gone. A job that finds the queue full
 * goes back into the store as {@code queued}, unstarted, for whoever claims
 * it next.
 *
 * <p><b>An attempt.</b> When the job gets a thread it is started
 * ({@link RemitJobs#start}) — fenced: the attempt is counted and the lease
 * counts from that moment, and a start that matches nothing means the job is
 * somebody else's by now, so nothing more is done with it. A job that was
 * started more than {@link RemitJobs#MAX_ATTEMPTS} times is not run again
 * but given up. Otherwise the handler of its kind runs the attempt, and what
 * it answers is acted on:
 * <ul>
 * <li>closed — nothing is left to do;
 * <li>a next job — that one is run next, on the same thread, the same way:
 *     a settlement goes down its pipeline without waiting for anybody;
 * <li>to be tried again — the job is put to {@code waiting} for the next of
 *     the delays of {@code REMIT_STEP_RETRY_MS}, and a timer <em>in this
 *     process</em> claims it again when that time has come and hands it
 *     over like any other job. The delays are counted by the attempts the
 *     store has seen, so a job that changed hands does not start them over.
 *     When they are spent — or there are none: {@code off} — the job is
 *     given up with the sentence of its last attempt;
 * <li>failed for good — given up at once;
 * <li>an exception, or no answer at all — as "to be tried again", with a
 *     fixed sentence. What the exception said goes to the log and nowhere
 *     else.
 * </ul>
 * Giving up is the handler's ({@link JobHandler#giveUp}): it knows what ends
 * with the job.
 *
 * <p><b>What this class writes</b> is the job's own row, and every such
 * write carries the fence of the claim. A write that matches nothing ends
 * the runner's part: no timer, no further write. It never touches a
 * settlement.
 *
 * <p><b>It picks nothing up by itself</b> except what it put to
 * {@code waiting} itself. A job whose holder is gone — a lease that ran out,
 * a job left queued or waiting by a process that stopped — is claimed by the
 * periodic worker and handed over here.
 *
 * <p><b>A stop</b> takes no new work: what is handed over from then on, and
 * what still waits in the queue, goes back into the store as {@code queued}.
 * Attempts that are running are waited for, {@value #STOP_WAIT_MS} ms at the
 * most — an outbound call is limited to 20 seconds, and what it came to has
 * to be written. Jobs that wait for their next attempt stay in the store
 * with their time; whoever claims them when it has come runs them.
 */
@Component
public class JobRunner implements RemitExecutor, DisposableBean {
    /** What an attempt that threw leaves behind: nothing of the exception reaches an event or a caller. */
    public static final String INTERNAL_ERROR = "the platform could not complete this step (internal error)";
    /** What a job that was started too often leaves behind. */
    public static final String TOO_MANY_ATTEMPTS = "the step did not complete after " + RemitJobs.MAX_ATTEMPTS + " attempts";

    static final int THREADS = 4;
    static final int QUEUE = 256;
    /** Half a lease: a job in the queue is renewed at least once before its claim would run out. */
    static final long RENEW_QUEUED_MS = 30_000;
    static final long STOP_WAIT_MS = 30_000;
    /**
     * A timer measures its delay by this process's clock, a job is due by the
     * database's. Where the database says "not yet" the timer looks again
     * after this long, then twice as long, up to {@link #LOOK_AGAIN_MAX_MS}.
     */
    static final long LOOK_AGAIN_MS = 50;
    static final long LOOK_AGAIN_MAX_MS = 5_000;

    private final RemitJobs jobs;
    private final TransactionTemplate tx;
    private final List<Long> retryMs;
    private final Supplier<List<JobHandler>> handlerBeans;
    private final long renewQueuedMs;
    private final long stopWaitMs;

    private final ThreadPoolExecutor pool;
    private final ScheduledThreadPoolExecutor timer;
    /** The jobs that wait for a thread, by their claims. */
    private final Set<RemitJobs.Held> queued = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean renewing = new AtomicBoolean();

    private final Object handlerLock = new Object();
    private Map<RemitJobs.Kind, JobHandler> handlers;

    /** Guards {@link #inFlight} and the step into {@link #stopping}: an attempt either began before the stop, and is waited for, or does not begin. */
    private final Object flight = new Object();
    private int inFlight;
    private volatile boolean stopping;

    private final AtomicLong saidFullAt = new AtomicLong(Long.MIN_VALUE);
    private final AtomicInteger putBackSince = new AtomicInteger();

    @Autowired
    public JobRunner(RemitJobs jobs, CoreConfig cfg, TransactionTemplate tx, ObjectProvider<List<JobHandler>> handlerBeans) {
        // The handlers are looked up when first needed: they need this executor to be there before they are.
        this(jobs, tx, cfg.remit.stepRetryMs, handlerBeans::getIfAvailable, THREADS, QUEUE, RENEW_QUEUED_MS, STOP_WAIT_MS);
    }

    /** As the service makes it, with every number given: for a test that cannot wait half a minute. */
    JobRunner(RemitJobs jobs, TransactionTemplate tx, List<Long> retryMs, Supplier<List<JobHandler>> handlerBeans, int threads, int queue,
            long renewQueuedMs, long stopWaitMs) {
        this.jobs = jobs;
        this.tx = tx;
        this.retryMs = List.copyOf(retryMs);
        this.handlerBeans = handlerBeans;
        this.renewQueuedMs = renewQueuedMs;
        this.stopWaitMs = stopWaitMs;
        // Neither makes a thread before it is given something to do: a deployment without the rail has none.
        this.pool = new ThreadPoolExecutor(threads, threads, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(queue), threads("remit-job"));
        this.pool.allowCoreThreadTimeOut(true);
        this.timer = new ScheduledThreadPoolExecutor(1, threads("remit-job-timer"));
        // A stop drops the timers that have not fired; one that is at work finishes what it does.
        this.timer.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        this.timer.setContinueExistingPeriodicTasksAfterShutdownPolicy(false);
    }

    private static ThreadFactory threads(String name) {
        AtomicInteger made = new AtomicInteger();
        return (r) -> {
            Thread t = new Thread(r, name + "-" + made.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    private JobHandler handlerOf(RemitJobs.Kind kind) {
        synchronized (handlerLock) {
            if (handlers == null) {
                Map<RemitJobs.Kind, JobHandler> found = new EnumMap<>(RemitJobs.Kind.class);
                List<JobHandler> beans = handlerBeans.get();
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
    }

    // ── taking a job ─────────────────────────────────────────────────────────

    @Override
    public void runNow(RemitJobs.Held job) {
        if (job == null) {
            return;
        }
        try {
            hand(job);
        } catch (Throwable e) {
            trouble(job.id, "taking the job", e);
        }
    }

    @Override
    public void runInline(RemitJobs.Held job) {
        if (job == null) {
            return;
        }
        chain(job);
    }

    /** Into the queue for a thread — or, when there is no room or the runner is stopping, back into the store. */
    private void hand(RemitJobs.Held job) {
        if (stopping) {
            giveBack(job);
            return;
        }
        keepQueuedLeases();
        queued.add(job);
        try {
            pool.execute(new Queued(job));
        } catch (RejectedExecutionException e) {
            queued.remove(job);
            giveBack(job);
            if (!stopping) {
                sayFull(job);
            }
        }
    }

    /** A job that waits for a thread. */
    private final class Queued implements Runnable {
        final RemitJobs.Held job;

        Queued(RemitJobs.Held job) {
            this.job = job;
        }

        @Override
        public void run() {
            queued.remove(job);
            chain(job);
        }
    }

    /** Back into the store as {@code queued}, unstarted, for whoever claims it next. */
    private void giveBack(RemitJobs.Held job) {
        try {
            write(() -> jobs.requeue(job));
        } catch (Throwable e) {
            // The claim runs out by itself, and the job is there to be claimed then.
            trouble(job.id, "putting the job back into the queue", e);
        }
    }

    /** Under a load that fills the queue every job that comes is put back: one line now and then says so, not one per job. */
    private void sayFull(RemitJobs.Held job) {
        putBackSince.incrementAndGet();
        long now = System.nanoTime();
        long last = saidFullAt.get();
        if ((last == Long.MIN_VALUE || now - last > TimeUnit.SECONDS.toNanos(10)) && saidFullAt.compareAndSet(last, now)) {
            Log.line("remit job runner is full: jobs go back into the queue", Log.fields("job", job.id, "put_back", putBackSince.getAndSet(0)));
        }
    }

    private void keepQueuedLeases() {
        if (renewing.compareAndSet(false, true)) {
            try {
                timer.scheduleWithFixedDelay(this::renewQueued, renewQueuedMs, renewQueuedMs, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException e) {
                // Stopping.
            }
        }
    }

    private void renewQueued() {
        for (RemitJobs.Held job : queued) {
            if (stopping) {
                return;
            }
            try {
                if (!write(() -> jobs.renew(job))) {
                    // Somebody else's by now. Its start will say so when it gets a thread; until then there is nothing to keep.
                    queued.remove(job);
                }
            } catch (Throwable e) {
                trouble(job.id, "renewing the lease of a job in the queue", e);
            }
        }
    }

    // ── running it ───────────────────────────────────────────────────────────

    /** A job, and after it the jobs it leads to, on the calling thread. Throws nothing. */
    private void chain(RemitJobs.Held job) {
        RemitJobs.Held current = job;
        while (current != null) {
            if (!enter()) {
                // Stopping: what has not begun does not begin.
                giveBack(current);
                return;
            }
            try {
                current = attempt(current);
            } catch (Throwable e) {
                // The job stays as it is: held, until its claim runs out and somebody claims it again.
                trouble(current.id, "running the job", e);
                current = null;
            } finally {
                leave();
            }
        }
    }

    private boolean enter() {
        synchronized (flight) {
            if (stopping) {
                return false;
            }
            inFlight++;
            return true;
        }
    }

    private void leave() {
        synchronized (flight) {
            inFlight--;
            flight.notifyAll();
        }
    }

    /** One attempt at one job. Returns the claim of the job that follows, or {@code null} when the chain ends here. */
    private RemitJobs.Held attempt(RemitJobs.Held job) {
        Map<String, Object> before = jobs.get(job.id);
        if (before == null) {
            return null;
        }
        JobHandler handler = handlerOf(RemitJobs.Kind.valueOf((String) before.get("kind")));
        if (handler == null) {
            // No part of this build runs that kind: the job stays in the store, held until its claim runs out.
            return null;
        }
        if (!write(() -> jobs.start(job))) {
            return null; // somebody else's now
        }
        Map<String, Object> row = jobs.get(job.id);
        if (row == null || !"running".equals(row.get("state")) || !job.owner.equals(row.get("lease_owner"))) {
            // Closed between the two statements, by a transition that recorded its result: nothing is left to do.
            return null;
        }
        JobAttempt attempt = new JobAttempt(job, row);
        if (attempt.attempts > RemitJobs.MAX_ATTEMPTS) {
            giveUp(handler, attempt, TOO_MANY_ATTEMPTS);
            return null;
        }
        JobResult result;
        try {
            result = handler.run(attempt);
            if (result == null) {
                throw new IllegalStateException("the handler of " + attempt.kind + " answered nothing");
            }
        } catch (Throwable e) {
            Log.line("remit job failed inside", Log.fields("job", job.id, "kind", attempt.kind.name(), "payment", attempt.paymentId,
                    "attempt", attempt.attempts, "error", String.valueOf(e), "at", where(e)));
            again(handler, attempt, INTERNAL_ERROR);
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return null;
        }
        switch (result.status) {
            case NEXT:
                return result.next;
            case RETRY:
                again(handler, attempt, result.error);
                return null;
            case FAILED:
                giveUp(handler, attempt, result.error == null ? INTERNAL_ERROR : result.error);
                return null;
            default:
                return null;
        }
    }

    /** The attempt did not get through and may be made again: wait for the next delay — or give up when there is none left. */
    private void again(JobHandler handler, JobAttempt attempt, String sentence) {
        String error = sentence == null ? INTERNAL_ERROR : sentence;
        // One delay per further attempt, and the store's count is the one that survives a change of hands.
        int spent = attempt.attempts - 1;
        if (spent >= retryMs.size()) {
            giveUp(handler, attempt, error);
            return;
        }
        long delayMs = retryMs.get(spent);
        if (!write(() -> jobs.waitFor(attempt.job, delayMs, error))) {
            return; // somebody else's now: nothing more is written, and no timer is set
        }
        Log.line("remit job waits to be tried again", Log.fields("job", attempt.job.id, "kind", attempt.kind.name(), "payment", attempt.paymentId,
                "attempt", attempt.attempts, "wait_ms", delayMs, "error", error));
        later(() -> due(attempt.job.id, 0), delayMs);
    }

    private void giveUp(JobHandler handler, JobAttempt attempt, String error) {
        Log.line("remit job given up", Log.fields("job", attempt.job.id, "kind", attempt.kind.name(), "payment", attempt.paymentId,
                "attempts", attempt.attempts, "error", error));
        try {
            handler.giveUp(attempt, error);
        } catch (Throwable e) {
            // The job stays held until its claim runs out; whoever claims it then comes to the same end.
            trouble(attempt.job.id, "giving the job up", e);
        }
    }

    // ── the timer ────────────────────────────────────────────────────────────

    private void later(Runnable what, long delayMs) {
        try {
            timer.schedule(what, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            // Stopping: the job waits in the store with its time, for whoever claims it when that has come.
        }
    }

    /** The time a job waited for has come by this process's clock: claim it again and hand it over. */
    private void due(String id, int looked) {
        if (stopping) {
            return;
        }
        boolean lookAgain;
        try {
            RemitJobs.Held held = write(() -> jobs.claim(id));
            if (held != null) {
                hand(held);
                return;
            }
            // Not claimed. Still waiting: the database's clock, which is the one that counts, says "not yet". Anything
            // else: somebody claimed it first, or it is closed — not this timer's any more.
            Map<String, Object> row = jobs.get(id);
            lookAgain = row != null && "waiting".equals(row.get("state"));
        } catch (Throwable e) {
            trouble(id, "claiming the job when its time had come", e);
            lookAgain = true;
        }
        if (lookAgain) {
            later(() -> due(id, looked + 1), Math.min(LOOK_AGAIN_MAX_MS, LOOK_AGAIN_MS << Math.min(looked, 10)));
        }
    }

    // ── a stop ───────────────────────────────────────────────────────────────

    @Override
    public void destroy() {
        synchronized (flight) {
            if (stopping) {
                return;
            }
            stopping = true;
        }
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(stopWaitMs);
        timer.shutdown();
        pool.shutdown();
        // What still waits for a thread goes back; a job a thread takes out of the queue at this moment puts itself back.
        List<Runnable> waiting = new ArrayList<>();
        pool.getQueue().drainTo(waiting);
        for (Runnable r : waiting) {
            RemitJobs.Held job = ((Queued) r).job;
            queued.remove(job);
            giveBack(job);
        }
        boolean interrupted = false;
        int left;
        synchronized (flight) {
            while (inFlight > 0 && !interrupted) {
                long ms = TimeUnit.NANOSECONDS.toMillis(until - System.nanoTime());
                if (ms <= 0) {
                    break;
                }
                try {
                    flight.wait(ms);
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            left = inFlight;
        }
        try {
            // A timer that was claiming a job when the stop came puts it back; that takes a statement.
            if (!interrupted) {
                timer.awaitTermination(Math.max(1, TimeUnit.NANOSECONDS.toMillis(until - System.nanoTime())), TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException e) {
            interrupted = true;
        }
        if (left > 0) {
            // Their claims run out, and what they were doing is found by whoever claims the jobs then.
            Log.line("remit job runner stopped while attempts were running", Log.fields("attempts", left, "waited_ms", stopWaitMs));
        }
        if (interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    // ── small things ─────────────────────────────────────────────────────────

    /**
     * One statement on a job's row, as a transaction of its own — so that one
     * the database gave up on for a lock (a deadlock, a wait that took too
     * long) is made again, as every transaction of the rail is.
     */
    private <T> T write(Supplier<T> statement) {
        return TxRetry.execute(tx, (status) -> statement.get());
    }

    private static void trouble(String jobId, String doing, Throwable e) {
        Log.line("remit job runner failed", Log.fields("job", jobId, "doing", doing, "error", String.valueOf(e), "at", where(e)));
    }

    private static String where(Throwable e) {
        StackTraceElement[] trace = e.getStackTrace();
        return trace == null || trace.length == 0 ? null : trace[0].toString();
    }
}
