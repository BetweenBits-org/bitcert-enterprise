package com.stonehash.attest.core.http;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.json.Js;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The route table and what happens around a route — a port of the router the
 * service has always had ({@code apps/core/src/http/server.ts}), because its
 * behaviour at the edges is what clients and stored audit rows rely on:
 *
 * <ul>
 * <li>a route is a method and a path; a segment starting with {@code :} is a
 *     parameter. Empty segments are skipped, so {@code /v1//anchors/} is
 *     {@code /v1/anchors}. Literal segments are compared as sent; only a
 *     parameter is percent-decoded, and a malformed escape there is a 400
 *     {@code invalid_path};
 * <li>no route for this method and path is a 404 {@code not_found} — there is
 *     no 405 — after the static mounts had their look;
 * <li>what a handler returns is the JSON body of a 200, written with two
 *     spaces of indentation; an {@link HttpResult} sets the status, headers,
 *     and may carry text or bytes;
 * <li>an error is answered {@code { …detail, "error": code, "message": text }};
 * <li>the hook that writes the audit row runs after the outcome is known and
 *     before anything is sent, and a hook that fails never fails the call.
 * </ul>
 */
public final class Router {
    /** Runs once per matched request with the status about to be sent. */
    @FunctionalInterface
    public interface DoneHook {
        void done(Ctx ctx, int status, double durationMs) throws Exception;
    }

    /** Consulted only when no route matches — the static mounts. Returns {@code true} if it answered. */
    @FunctionalInterface
    public interface Fallback {
        boolean handle(String method, RequestTarget target, HttpServletResponse res) throws IOException;
    }

    /** A route as registered: for the list the API description is checked against. */
    public static final class Route {
        public final String method;
        public final String path;
        final String[] segments;
        final Handler handler;

        Route(String method, String path, Handler handler) {
            this.method = method;
            this.path = path;
            List<String> parts = new ArrayList<>();
            for (String part : path.split("/", -1)) {
                if (!part.isEmpty()) {
                    parts.add(part);
                }
            }
            this.segments = parts.toArray(new String[0]);
            this.handler = handler;
        }
    }

    private static final class Reply {
        final int status;
        final Object body;
        final Map<String, String> headers;

        Reply(int status, Object body, Map<String, String> headers) {
            this.status = status;
            this.body = body;
            this.headers = headers;
        }
    }

    private final List<Route> routes = new ArrayList<>();
    private Fallback onMiss;
    private DoneHook onDone;

    public Router add(String method, String path, Handler handler) {
        routes.add(new Route(method, path, handler));
        return this;
    }

    public Router get(String path, Handler handler) {
        return add("GET", path, handler);
    }

    public Router post(String path, Handler handler) {
        return add("POST", path, handler);
    }

    public Router fallback(Fallback fn) {
        this.onMiss = fn;
        return this;
    }

    public Router onDone(DoneHook fn) {
        this.onDone = fn;
        return this;
    }

    public List<Route> routes() {
        return Collections.unmodifiableList(routes);
    }

    // ── matching ──────────────────────────────────────────────────────────────

    private static final class Match {
        final Route route;
        final Map<String, String> params;

        Match(Route route, Map<String, String> params) {
            this.route = route;
            this.params = params;
        }
    }

    private static List<String> parts(String pathname) {
        List<String> out = new ArrayList<>();
        for (String part : pathname.split("/", -1)) {
            if (!part.isEmpty()) {
                out.add(part);
            }
        }
        return out;
    }

    /**
     * The first route whose shape fits, with its parameters decoded. Literals
     * are compared before anything is decoded, so only a route that actually
     * matched can refuse a malformed escape; a path no route claims still
     * falls through to the static mounts, which answer it themselves.
     */
    private Match match(String method, String pathname) {
        List<String> parts = parts(pathname);
        next:
        for (Route route : routes) {
            if (!route.method.equals(method) || route.segments.length != parts.size()) {
                continue;
            }
            for (int i = 0; i < route.segments.length; i++) {
                if (!route.segments[i].startsWith(":") && !route.segments[i].equals(parts.get(i))) {
                    continue next;
                }
            }
            Map<String, String> params = new LinkedHashMap<>();
            for (int i = 0; i < route.segments.length; i++) {
                if (route.segments[i].startsWith(":")) {
                    params.put(route.segments[i].substring(1), decodeSegment(parts.get(i)));
                }
            }
            return new Match(route, params);
        }
        return null;
    }

    /** One path parameter, percent-decoded as {@code decodeURIComponent} decodes, or a 400 when the escape is malformed. */
    static String decodeSegment(String segment) {
        String decoded = decodeUriComponent(segment);
        if (decoded == null) {
            throw new HttpError(400, "invalid_path", "malformed percent-encoding in path");
        }
        return decoded;
    }

    /**
     * {@code decodeURIComponent}: every {@code %XX} is a byte, the bytes are
     * UTF-8, and anything that is not — a {@code %} without two hex digits,
     * bytes that are not well-formed UTF-8 — is an error ({@code null} here),
     * not a replacement character. A {@code +} stays a plus.
     */
    public static String decodeUriComponent(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        StringBuilder out = new StringBuilder(s.length());
        byte[] run = new byte[s.length() / 3 + 1];
        for (int i = 0; i < s.length();) {
            char c = s.charAt(i);
            if (c != '%') {
                out.append(c);
                i++;
                continue;
            }
            int n = 0;
            while (i < s.length() && s.charAt(i) == '%') {
                if (i + 2 >= s.length() || Query.hex(s.charAt(i + 1)) < 0 || Query.hex(s.charAt(i + 2)) < 0) {
                    return null;
                }
                run[n++] = (byte) (Query.hex(s.charAt(i + 1)) * 16 + Query.hex(s.charAt(i + 2)));
                i += 3;
            }
            try {
                out.append(StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(run, 0, n)));
            } catch (java.nio.charset.CharacterCodingException e) {
                return null;
            }
        }
        return out.toString();
    }

    // ── one request ───────────────────────────────────────────────────────────

    /**
     * What a thrown error is answered with. A refusal the service made on
     * purpose carries its own status, code and sentence. Anything else is a
     * 500: with the sentence our own code gave it ({@link PlainError}), or —
     * for a failure nobody wrote a sentence for — a fixed one, so that what
     * went wrong inside reaches the log and not the caller.
     */
    private static Reply errorReply(Throwable e) {
        if (e instanceof ServiceError) {
            ServiceError s = (ServiceError) e;
            Map<String, Object> body = new LinkedHashMap<>();
            if (s.detail() != null) {
                body.putAll(s.detail());
            }
            body.put("error", s.code());
            body.put("message", String.valueOf(s.getMessage()));
            return new Reply(s.status(), body, Collections.emptyMap());
        }
        if (e instanceof HttpError) {
            HttpError h = (HttpError) e;
            return new Reply(h.status(), error(h.code(), h.getMessage()), Collections.emptyMap());
        }
        if (e instanceof PlainError) {
            return new Reply(500, error("internal", e.getMessage()), Collections.emptyMap());
        }
        System.err.println("request failed: " + e);
        return new Reply(500, error("internal", "internal error"), Collections.emptyMap());
    }

    static Map<String, Object> error(String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message);
        return body;
    }

    public void handle(HttpServletRequest req, HttpServletResponse res) throws IOException {
        try {
            dispatch(req, res);
        } catch (IOException | RuntimeException e) {
            // The last line, for a failure that escaped: logged, and answered while that is still possible.
            System.err.println("request failed: " + e);
            if (res.isCommitted()) {
                throw e;
            }
            res.reset();
            if (e instanceof HttpError) {
                send(res, ((HttpError) e).status(), error(((HttpError) e).code(), e.getMessage()), Collections.emptyMap());
            } else {
                send(res, 500, error("internal", "internal error"), Collections.emptyMap());
            }
        }
    }

    private void dispatch(HttpServletRequest req, HttpServletResponse res) throws IOException {
        String method = req.getMethod();
        // The target can be refused before any route owns the request: it does not parse, or a
        // parameter does not decode. Nobody has been admitted yet, so there is nothing to audit.
        RequestTarget target;
        Match m;
        try {
            // The path as it was sent: the server keeps it aside (RawTargetAdapter) before decoding anything.
            Object raw = req.getAttribute(RawTargetAdapter.RAW_TARGET);
            target = RequestTarget.parse(raw instanceof String ? (String) raw : req.getRequestURI(), req.getQueryString());
            m = match(method, target.pathname);
        } catch (HttpError e) {
            Reply refused = errorReply(e);
            send(res, refused.status, refused.body, refused.headers);
            return;
        }
        if (m == null) {
            if (onMiss != null && onMiss.handle(method, target, res)) {
                return;
            }
            send(res, 404, error("not_found", "no route for " + method + " " + target.pathname), Collections.emptyMap());
            return;
        }
        String auth = req.getHeader("authorization");
        long started = System.nanoTime();
        Ctx ctx = new Ctx(req, res, method,
                // Runs of `/` collapsed: the matcher skips empty segments, so the audit has to
                // file `/v1//settlements` under the product that answered it.
                target.pathname.replaceAll("/{2,}", "/"),
                m.params, target.query,
                auth != null && auth.startsWith("Bearer ") ? auth.substring(7) : null);
        // The outcome is settled before anything is written, so the hook sees the status that
        // will go out and runs before the client can act on it. `null` means the handler wrote
        // its own response and there is nothing left to send.
        Reply reply;
        try {
            Object out = m.route.handler.handle(ctx);
            if (res.isCommitted()) {
                reply = null;
            } else if (out instanceof HttpResult) {
                HttpResult r = (HttpResult) out;
                reply = new Reply(r.status, r.body, r.headers);
            } else {
                reply = new Reply(200, out, Collections.emptyMap());
            }
        } catch (UncheckedIOException e) {
            throw e.getCause();
        } catch (Exception e) {
            reply = errorReply(e);
        }
        if (onDone != null) {
            try {
                onDone.done(ctx, reply != null ? reply.status : res.getStatus(), (System.nanoTime() - started) / 1e6);
            } catch (Exception e) {
                System.err.println("request hook failed for " + method + " " + target.pathname + ": " + e.getMessage());
            }
        }
        if (reply != null) {
            if (Boolean.TRUE.equals(req.getAttribute(Ctx.CUT)) && ResponseHeaders.cutConnection()) {
                return;
            }
            send(res, reply.status, reply.body, reply.headers);
        }
    }

    // ── writing ───────────────────────────────────────────────────────────────

    static void send(HttpServletResponse res, int status, Object body, Map<String, String> headers) throws IOException {
        // A header a handler built from what the client sent (the archive's file name carries its id) may hold what
        // no header can. Nothing has been written yet: this fails the request (a 500), as it always did.
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (!validHeaderValue(h.getValue())) {
                throw new IllegalStateException("Invalid character in header content [\"" + h.getKey() + "\"]");
            }
        }
        res.setStatus(status);
        if (body == null || body == Js.UNDEFINED) {
            for (Map.Entry<String, String> h : headers.entrySet()) {
                ResponseHeaders.set(res, h.getKey(), h.getValue());
            }
            res.setContentLength(0);
            return;
        }
        // Bytes (the evidence archive) are sent as they are. A content type the handler gave
        // wins, since only the handler knows what the bytes are.
        byte[] bytes;
        Map<String, String> all = new LinkedHashMap<>();
        if (body instanceof byte[]) {
            bytes = (byte[]) body;
            all.put("content-type", "application/octet-stream");
        } else if (body instanceof String) {
            bytes = ((String) body).getBytes(StandardCharsets.UTF_8);
            all.put("content-type", "text/plain; charset=utf-8");
        } else {
            bytes = Js.stringify(body, 2).getBytes(StandardCharsets.UTF_8);
            all.put("content-type", "application/json; charset=utf-8");
        }
        for (Map.Entry<String, String> h : headers.entrySet()) {
            all.put(h.getKey().toLowerCase(java.util.Locale.ROOT), h.getValue());
        }
        for (Map.Entry<String, String> h : all.entrySet()) {
            ResponseHeaders.set(res, h.getKey(), h.getValue());
        }
        res.setContentLength(bytes.length);
        res.getOutputStream().write(bytes);
    }

    /** Can this be a header's value: a tab, printable ASCII and the upper half of Latin-1 — nothing else, and no control character. */
    public static boolean validHeaderValue(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!(c == '\t' || (c >= 0x20 && c <= 0x7e) || (c >= 0x80 && c <= 0xff))) {
                return false;
            }
        }
        return true;
    }

    /**
     * {@code ?limit=} as a page size: a whole number from 1 to {@code max},
     * or the default. Not a number, below 1, or absent is the default; a
     * fraction is cut down to a whole number; above the maximum is the maximum.
     */
    public static long pageLimit(String raw, long dflt, long max) {
        double n = Math.floor(raw == null ? dflt : Js.toNumber(raw));
        return !Double.isNaN(n) && !Double.isInfinite(n) && n >= 1 ? (long) Math.min(n, max) : dflt;
    }

    /** For callers that hold a decoded value and need it in a URL again. */
    static String urlDecodeLenient(String s) {
        return URLDecoder.decode(s, StandardCharsets.UTF_8);
    }
}
