package com.stonehash.attest.core.http;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Returned from a handler to control the status or to send something other
 * than JSON. The body is a JSON value, text ({@code String}), bytes
 * ({@code byte[]}), or {@code null} for no body.
 */
public final class HttpResult {
    public final int status;
    public final Object body;
    public final Map<String, String> headers;

    public HttpResult(int status, Object body) {
        this(status, body, new LinkedHashMap<>());
    }

    public HttpResult(int status, Object body, Map<String, String> headers) {
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}
