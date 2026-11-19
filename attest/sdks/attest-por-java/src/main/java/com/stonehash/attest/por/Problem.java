package com.stonehash.attest.por;

/**
 * One thing wrong with a ledger: where, a stable code, and a sentence for the
 * person who has to fix the export.
 */
public final class Problem {
    private final long line;
    private final String code;
    private final String message;

    Problem(long line, String code, String message) {
        this.line = line;
        this.code = code;
        this.message = message;
    }

    /**
     * For a file, its 1-based physical line; for rows given in code, the
     * 1-based ordinal of the call. 0 when the problem is with the ledger as a
     * whole (an empty file, no accounts).
     */
    public long line() {
        return line;
    }

    /** The specification's code, for example {@code amount_precision} or {@code duplicate_row}. */
    public String code() {
        return code;
    }

    public String message() {
        return message;
    }

    @Override
    public String toString() {
        return "line " + line + " " + code + " " + message;
    }
}
