package com.stonehash.attest.core.http;

import com.stonehash.attest.core.json.Js;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** One matched request, as a handler sees it. */
public final class Ctx {
    /** 1 MiB: requests carry digests, never documents. */
    public static final int MAX_BODY = 1 << 20;

    public final HttpServletRequest req;
    public final HttpServletResponse res;
    public final String method;
    /** The request path without the query, runs of {@code /} collapsed — what a log line names. */
    public final String path;
    public final Map<String, String> params;
    public final Query query;
    /** The Bearer token, if the request carried one; otherwise {@code null}. */
    public final String token;
    /**
     * Who this request acts as, once an auth helper has admitted it. Left
     * unset for anonymous requests, which is how the audit hook tells a call
     * worth recording from a probe that never reached a tenant.
     */
    public Object audit;

    Ctx(HttpServletRequest req, HttpServletResponse res, String method, String path, Map<String, String> params, Query query, String token) {
        this.req = req;
        this.res = res;
        this.method = method;
        this.path = path;
        this.params = params;
        this.query = query;
        this.token = token;
    }

    /** A request header, or {@code null}. Where a header was sent more than once, the first. */
    public String header(String name) {
        return req.getHeader(name);
    }

    /**
     * The request body as JSON. No body at all is an empty object; the
     * Content-Type is not consulted; more than 1 MiB is refused.
     */
    public Object body() throws IOException {
        byte[] bytes = read(MAX_BODY, "request body exceeds 1 MiB");
        if (bytes.length == 0) {
            return new LinkedHashMap<String, Object>();
        }
        try {
            return Js.parse(new String(bytes, StandardCharsets.UTF_8));
        } catch (Js.SyntaxException e) {
            throw new HttpError(400, "invalid_json", "request body is not valid JSON");
        }
    }

    /**
     * The request body as bytes, for the one route that receives a document.
     * Separate from {@link #body()} so that the 1 MiB cap on JSON stays where
     * it is; the caller passes the ceiling it is willing to accept. In memory
     * and nowhere else: the document is hashed, inscribed and dropped.
     */
    public byte[] raw(long maxBytes) throws IOException {
        try {
            return read(maxBytes, "request body exceeds " + maxBytes + " bytes");
        } catch (HttpError tooLarge) {
            // Past the ceiling the sender is not going to get an answer worth the bandwidth:
            // the upload is not read to its end and the connection is cut, as it always was.
            // The refusal still reaches the audit trail as the 413 it is.
            req.setAttribute(CUT, Boolean.TRUE);
            throw tooLarge;
        }
    }

    /** Request attribute: the connection is to be cut instead of answered. */
    static final String CUT = "stonehash.cutConnection";

    private byte[] read(long maxBytes, String tooLarge) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        long size = 0;
        try (InputStream in = req.getInputStream()) {
            for (int n = in.read(chunk); n >= 0; n = in.read(chunk)) {
                size += n;
                if (size > maxBytes) {
                    throw new HttpError(413, "payload_too_large", tooLarge);
                }
                out.write(chunk, 0, n);
            }
        }
        return out.toByteArray();
    }
}
