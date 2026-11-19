package com.stonehash.attest.por;

/**
 * The one failure type of this library.
 *
 * <p>Unchecked, so a call site in Java, Kotlin or Scala chooses where to
 * handle it instead of declaring it everywhere. Every instance carries a
 * stable {@link #code()}: the message is for a person and may be reworded
 * between versions, the code is what a program should branch on.
 *
 * <p>Codes come from three places. Amount and ledger problems use the codes of
 * the specification ({@code amount_precision}, {@code duplicate_row}, ...).
 * Answers from the platform use the platform's own error code and arrive as
 * the subclass {@link PorApiException}. Everything else is this library's:
 * {@code invalid_statement}, {@code leaves_checksum}, {@code invalid_key} and
 * so on, each named where it is thrown.
 */
public class PorException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final String code;

    public PorException(String code, String message) {
        super(message);
        this.code = code;
    }

    public PorException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    /** Stable, machine-readable name of what went wrong. */
    public String code() {
        return code;
    }
}
