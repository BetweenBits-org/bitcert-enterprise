package com.stonehash.attest.remit;

/**
 * The one exception family of this SDK. Unchecked, so it passes through a
 * service layer without being declared at every level, and always carrying a
 * stable {@link #code()} — the thing to branch on. The message is for a person
 * reading a log; it never quotes a key or a signature.
 */
public class RemitException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final String code;

    public RemitException(String code, String message) {
        super(message);
        this.code = code;
    }

    public RemitException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    /** A short, stable identifier of what went wrong, e.g. {@code key_mismatch}, {@code reference_reused}. */
    public String code() {
        return code;
    }
}
