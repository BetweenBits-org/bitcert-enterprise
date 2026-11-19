package com.stonehash.attest.core.http;

/**
 * A failure this service states in its own words, without a status of its
 * own: it is answered 500 {@code internal} with this message. (Any other
 * exception is answered 500 with a fixed sentence — what went wrong inside is
 * for the log, not for the caller.)
 */
public final class PlainError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public PlainError(String message) {
        super(message);
    }
}
