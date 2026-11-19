package com.stonehash.attest.core.remit;

/**
 * One of the things the rail's periodic worker does on each of its passes
 * (design 3.4). The worker — the instance that holds the lease {@code remit}
 * — calls every one of these, in the order of {@link #order}: 10 jobs whose
 * holder is gone, 20 anchored evidence (T16), 30 webhook delivery.
 *
 * <p>The seam between the worker and the parts of the rail that have
 * something to do periodically: such a part is a bean of this type and
 * knows nothing about leases or timing.
 */
public interface RemitPeriodic {
    /** Where in a pass this comes; lower first. */
    int order();

    /** One pass. What it throws ends this step for this pass only; the worker logs it and goes on. */
    void pass() throws Exception;
}
