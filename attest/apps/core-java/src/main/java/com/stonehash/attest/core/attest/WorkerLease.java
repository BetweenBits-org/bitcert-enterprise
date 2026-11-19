package com.stonehash.attest.core.attest;

import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Who may work.
 *
 * <p>The batch worker is a timer in every instance that is started with it
 * on. Two of them sealing the same records, or broadcasting the same batch,
 * is what must not happen — so before each cycle an instance takes the
 * worker's lease, a row it owns for a minute by the database's own clock,
 * and renews it while it works. An instance that does not hold it does
 * nothing that cycle. When the holder stops or dies, the lease runs out and
 * another takes it.
 *
 * <p>The lease keeps two workers from working side by side; it is not what
 * makes a single transition safe. Each transition carries its own condition
 * (a record without a batch, a batch still sealed), so even two holders — a
 * lease that ran out mid-step — could not seal a record twice or record two
 * anchors for one batch.
 */
@Component
public class WorkerLease {
    /** How long a lease is good for without being renewed. */
    static final long TTL_SECONDS = 60;

    private final BatchMapper mapper;
    private final String owner;

    public WorkerLease(BatchMapper mapper) {
        this.mapper = mapper;
        String host;
        try {
            host = InetAddress.getLocalHost().getHostName();
        } catch (java.io.IOException e) {
            host = "host";
        }
        this.owner = host + ":" + ManagementFactory.getRuntimeMXBean().getPid() + ":" + UUID.randomUUID().toString().substring(0, 8);
    }

    public String owner() {
        return owner;
    }

    /** Take the lease, or keep it. {@code false} when another instance holds it. */
    public boolean take(String name) {
        return mapper.takeLease(name, owner, TTL_SECONDS) == 1 || mapper.createLease(name, owner, TTL_SECONDS) == 1;
    }

    /** Is the lease still this instance's? Renews it if so. Asked again right before anything irreversible. */
    public boolean stillHeld(String name) {
        return mapper.renewLease(name, owner, TTL_SECONDS) == 1;
    }

    /** Give the lease up, so that another instance need not wait for it to run out. */
    public void release(String name) {
        mapper.releaseLease(name, owner);
    }
}
