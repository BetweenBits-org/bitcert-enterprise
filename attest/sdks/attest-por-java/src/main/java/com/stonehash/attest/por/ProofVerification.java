package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The outcome of checking one inclusion proof against a declared root and
 * declared totals.
 */
public final class ProofVerification {
    private final String computedRoot;
    private final Map<String, BigInteger> computedTotals;
    private final List<String> problems;

    ProofVerification(String computedRoot, Map<String, BigInteger> computedTotals, List<String> problems) {
        this.computedRoot = computedRoot;
        this.computedTotals = Collections.unmodifiableMap(computedTotals);
        this.problems = Collections.unmodifiableList(problems);
    }

    /** True only when the recomputed root is the declared one and every recomputed total is the declared one. */
    public boolean ok() {
        return problems.isEmpty();
    }

    /** The root the proof leads to; empty when the proof could not be followed that far. */
    public String computedRoot() {
        return computedRoot;
    }

    /** The per-asset totals the proof leads to. */
    public Map<String, BigInteger> computedTotals() {
        return computedTotals;
    }

    /** What failed, in words; empty when {@link #ok()}. */
    public List<String> problems() {
        return problems;
    }
}
