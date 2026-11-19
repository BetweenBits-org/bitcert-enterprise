package com.stonehash.attest.core.attest;

import com.stonehash.attest.core.anchor.AnchorBackend;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.log.Log;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

/**
 * The batcher — a timer in this process, not a separate deployment.
 *
 * <p>Each cycle: seal waiting records if the batch is full or the window has
 * elapsed, anchor what was sealed, try again the oldest batch whose anchoring
 * did not go through, then refresh confirmations. One timer, no queue, no
 * broker. If the process stops mid-cycle the next cycle — of this instance or
 * another — picks up from the database: every transition is committed before
 * it is acted on, and what was about to be broadcast is written down first.
 *
 * <p>Errors are logged and the loop continues. An unreachable node must not
 * take the API down with it: issuing attestations still works, they simply
 * stay {@code accepted} until the chain is reachable again.
 *
 * <p>Only the instance that holds the worker's lease works
 * ({@link WorkerLease}). {@code WORKER_TICK_MS=0} means no worker at all.
 */
@Component
public class BatchWorker implements DisposableBean {
    private final BatchService svc;
    private final AnchorBackend backend;
    private final WorkerLease lease;
    private final long tickMs;
    private final long flushIntervalMs;
    private final long maxLeaves;
    private final long retentionDays;
    private ScheduledExecutorService timer;
    private long lastFlush = System.currentTimeMillis();
    private long lastSweep = 0;
    /** Whether the last cycle held the lease; nothing yet before the first. */
    private Boolean holding;

    public BatchWorker(BatchService svc, AnchorBackend backend, WorkerLease lease, CoreConfig cfg) {
        this.svc = svc;
        this.backend = backend;
        this.lease = lease;
        this.tickMs = cfg.workerTickMs;
        this.flushIntervalMs = cfg.batch.flushIntervalMs;
        this.maxLeaves = cfg.batch.maxLeaves;
        this.retentionDays = cfg.publicAnchor.retentionDays;
    }

    /** Start the timer. Called once the service is listening; never for a command that only reads the configuration. */
    public synchronized void start() {
        if (tickMs <= 0) {
            Log.line("worker disabled (WORKER_TICK_MS=0)");
            return;
        }
        timer = Executors.newSingleThreadScheduledExecutor((r) -> {
            Thread t = new Thread(r, "batch-worker");
            // A stop must not have to wait for a cycle.
            t.setDaemon(true);
            return t;
        });
        // One cycle after another: a slow chain cannot make two overlap.
        timer.scheduleWithFixedDelay(this::tick, tickMs, tickMs, TimeUnit.MILLISECONDS);
        Log.line("worker started", Log.fields("tickMs", tickMs, "flushIntervalMs", flushIntervalMs));
    }

    @Override
    public synchronized void destroy() {
        if (timer == null) {
            return;
        }
        timer.shutdown();
        try {
            timer.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        timer = null;
        try {
            lease.release(BatchService.LEASE);
        } catch (RuntimeException e) {
            // The lease runs out by itself.
        }
    }

    private static String message(Throwable e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    /** One cycle. Public so that a test can drive it deterministically. */
    public void tick() {
        try {
            boolean held = lease.take(BatchService.LEASE);
            if (holding == null || held != holding) {
                holding = held;
                Log.line(held ? "worker holds the lease" : "worker is standing by: another instance holds the lease", Log.fields("instance", lease.owner()));
            }
            if (!held) {
                return;
            }
            long pending = svc.pendingCount();
            boolean due = System.currentTimeMillis() - lastFlush >= flushIntervalMs;
            String sealed = null;
            if (pending > 0 && (pending >= maxLeaves || due)) {
                // One batch per cycle, and a batch is one organisation's records — so with
                // several tenants waiting, the rest are picked up on the following cycles.
                sealed = svc.sealBatch();
                lastFlush = System.currentTimeMillis();
                if (sealed != null) {
                    Log.line("batch sealed", Log.fields("batchId", sealed, "leaves", pending));
                    anchor(sealed);
                }
            }
            // A batch whose anchoring did not go through stays sealed; it is tried again here,
            // one per cycle, oldest first.
            String waiting = svc.oldestSealedBatch(sealed);
            if (waiting != null) {
                anchor(waiting);
            }
            // An inscription has no batch, so no anchor brings its transaction a block. On a
            // private chain one is made for it here — after the anchors of this cycle, whose
            // block would have carried it too.
            if (backend.network().equals("regtest") && svc.inscriptionWaitsForABlock()) {
                try {
                    backend.generate(1);
                } catch (Exception e) {
                    Log.line("post-inscription step failed", Log.fields("error", message(e)));
                }
            }
            long promoted = svc.refreshConfirmations();
            if (promoted > 0) {
                Log.line("anchors confirmed", Log.fields("count", promoted));
            }
            // Retention sweep, at most hourly: a delete over an indexed column, not something
            // to do every cycle.
            if (retentionDays > 0 && System.currentTimeMillis() - lastSweep >= 3_600_000) {
                lastSweep = System.currentTimeMillis();
                long purged = svc.purgeExpiredPublic();
                if (purged > 0) {
                    Log.line("expired free-tier records purged", Log.fields("count", purged));
                }
            }
        } catch (Throwable e) {
            Log.line("worker tick failed", Log.fields("error", message(e)));
        }
    }

    private void anchor(String batchId) {
        try {
            String txid = svc.anchorBatch(batchId);
            Log.line("batch anchored", Log.fields("batchId", batchId, "txid", txid));
            // On a private chain nothing mines on its own, so an anchor would sit unconfirmed
            // for ever. Generating a block after submitting is what regtest is for.
            if (backend.network().equals("regtest")) {
                try {
                    backend.generate(1);
                } catch (Exception e) {
                    // The anchor is already broadcast; failing to confirm it is a separate, recoverable problem.
                    Log.line("post-anchor step failed", Log.fields("batchId", batchId, "error", message(e)));
                }
            }
        } catch (Exception e) {
            // The batch stays sealed and a later cycle tries it again.
            Log.line("anchor failed, will retry", Log.fields("batchId", batchId, "error", message(e)));
        }
    }
}
