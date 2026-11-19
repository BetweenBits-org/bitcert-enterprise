package com.stonehash.attest.core;

import java.util.Map;

/**
 * A refusal the service makes on purpose: the HTTP status, the code a program
 * acts on, the sentence a person reads — and, for some, further fields that
 * are answered beside {@code error} and {@code message}
 * ({@code existing_payment_id}, for one).
 */
public final class ServiceError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;
    private final transient Map<String, Object> detail;

    public ServiceError(int status, String code, String message) {
        this(status, code, message, null);
    }

    public ServiceError(int status, String code, String message, Map<String, Object> detail) {
        super(message);
        this.status = status;
        this.code = code;
        this.detail = detail;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    /** Fields answered before {@code error} and {@code message}, in their order; {@code null} when there are none. */
    public Map<String, Object> detail() {
        return detail;
    }
}
