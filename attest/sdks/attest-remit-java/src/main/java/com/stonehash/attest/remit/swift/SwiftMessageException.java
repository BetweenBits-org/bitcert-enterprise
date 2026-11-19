package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.RemitException;

/**
 * A message that could not be read, with the place it went wrong.
 *
 * <p>The code is one of {@code not_a_swift_message}, {@code unsupported_message},
 * {@code malformed_message}, {@code multiple_transactions}, {@code missing_field},
 * {@code invalid_field} — the same words the TypeScript SDK uses.
 */
public final class SwiftMessageException extends RemitException {
    private static final long serialVersionUID = 1L;

    private final String field;

    public SwiftMessageException(String code, String message) {
        this(code, message, null);
    }

    public SwiftMessageException(String code, String message, String field) {
        super(code, message);
        this.field = field;
    }

    /** Element path or field tag at fault, or null when there is none. */
    public String field() {
        return field;
    }
}
