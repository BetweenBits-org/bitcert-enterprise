package com.stonehash.attest.por;

import java.util.Collections;
import java.util.Map;

/**
 * The platform did not do what was asked: it refused, it could not be
 * reached, or it answered something this client cannot use.
 *
 * <p>For a refusal, {@link #status()} is the HTTP status and {@link #code()}
 * the platform's own error code — {@code invalid_signature},
 * {@code subscription_required}, {@code wrong_state} and so on — with the
 * platform's message. When no usable answer arrived, the code is this
 * client's: {@code unreachable} (status 0), {@code invalid_response},
 * {@code anchor_timeout} (status 0).
 *
 * <p>The API key is never part of the message.
 */
public final class PorApiException extends PorException {
    private static final long serialVersionUID = 1L;

    private final int status;
    private final transient Map<String, Object> body;

    PorApiException(int status, String code, String message, Map<String, Object> body) {
        super(code, message);
        this.status = status;
        this.body = body == null ? Collections.emptyMap() : body;
    }

    PorApiException(int status, String code, String message, Throwable cause) {
        super(code, message, cause);
        this.status = status;
        this.body = Collections.emptyMap();
    }

    /** The HTTP status of the platform's answer, or 0 when there was none. */
    public int status() {
        return status;
    }

    /** The platform's answer as parsed JSON, when it sent one (a rejection lists its {@code problems} here); otherwise empty. */
    public Map<String, Object> body() {
        return body;
    }
}
