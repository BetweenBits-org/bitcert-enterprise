package com.stonehash.attest.remit;

import java.util.Collections;
import java.util.List;

/**
 * What re-checking an evidence package found, one line per check — reported
 * separately because they fail for different reasons, and because a check
 * that was not run must never read as one that passed.
 */
public final class EvidenceReport {
    /** How one check ended. */
    public enum State {
        PASS,
        FAIL,
        /** Not something this SDK re-runs — a proof file of another form; see the check's detail for where it can be re-run. */
        NOT_RUN
    }

    /** One check: what it was, how it ended, and what was seen. */
    public static final class Check {
        private final String name;
        private final State state;
        private final String detail;

        Check(String name, State state, String detail) {
            this.name = name;
            this.state = state;
            this.detail = detail;
        }

        public String name() {
            return name;
        }

        public State state() {
            return state;
        }

        public String detail() {
            return detail;
        }

        @Override
        public String toString() {
            return name + ": " + state + " — " + detail;
        }
    }

    private final List<Check> checks;

    EvidenceReport(List<Check> checks) {
        this.checks = Collections.unmodifiableList(checks);
    }

    public List<Check> checks() {
        return checks;
    }

    /** True when no check failed. Checks that were not run say nothing either way: see {@link #complete()}. */
    public boolean noneFailed() {
        return checks.stream().noneMatch((c) -> c.state == State.FAIL);
    }

    /** True when every check was run. The one that may not be is the anchor, for a proof file of a form this SDK does not re-verify. */
    public boolean complete() {
        return checks.stream().noneMatch((c) -> c.state == State.NOT_RUN);
    }

    /** True only when every check was run and passed. */
    public boolean verified() {
        return checks.stream().allMatch((c) -> c.state == State.PASS);
    }
}
