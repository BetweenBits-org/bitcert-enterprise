package com.stonehash.attest.core.http;

/** A request the HTTP layer itself refuses: the status, a code, a sentence. */
public final class HttpError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;

    public HttpError(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }
}
