package com.stonehash.attest.remit;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * A stand-in for the platform: it answers what a test tells it to, and
 * remembers every request — because half of what is tested is what was sent,
 * and what was not.
 */
public final class StubPlatform implements AutoCloseable {
    /** One request as it arrived. */
    public static final class Request {
        public final String method;
        public final String path;
        public final Map<String, String> headers;
        public final String body;

        Request(String method, String path, Map<String, String> headers, String body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        /** The body as JSON. */
        public Map<String, Object> json() {
            return Json.object(Json.parse(body), "invalid_json", "the request body");
        }
    }

    /** What to answer with. */
    public static final class Answer {
        final int status;
        final String contentType;
        final String body;
        final Map<String, String> headers = new LinkedHashMap<>();

        private Answer(int status, String contentType, String body) {
            this.status = status;
            this.contentType = contentType;
            this.body = body;
        }

        public static Answer json(int status, Object value) {
            return new Answer(status, "application/json", Json.compact(value));
        }

        public static Answer text(int status, String contentType, String body) {
            return new Answer(status, contentType, body);
        }

        public Answer header(String name, String value) {
            headers.put(name, value);
            return this;
        }
    }

    private final HttpServer server;
    private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    private volatile Function<Request, Answer> handler = (r) -> Answer.json(404, Map.of("error", "not_found", "message", r.path));

    public StubPlatform() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
    }

    private void handle(HttpExchange exchange) throws IOException {
        Map<String, String> headers = new LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((k, v) -> headers.put(k.toLowerCase(java.util.Locale.ROOT), String.join(",", v)));
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String path = exchange.getRequestURI().getRawPath()
                + (exchange.getRequestURI().getRawQuery() == null ? "" : "?" + exchange.getRequestURI().getRawQuery());
        Request request = new Request(exchange.getRequestMethod(), path, headers, body);
        requests.add(request);
        Answer answer;
        try {
            answer = handler.apply(request);
        } catch (RuntimeException e) {
            answer = Answer.json(500, Map.of("error", "stub_failed", "message", String.valueOf(e)));
        }
        byte[] out = answer.body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", answer.contentType);
        answer.headers.forEach((k, v) -> exchange.getResponseHeaders().add(k, v));
        exchange.sendResponseHeaders(answer.status, out.length == 0 ? -1 : out.length);
        if (out.length > 0) {
            exchange.getResponseBody().write(out);
        }
        exchange.close();
    }

    /** What every request from now on is answered with. */
    public void answer(Function<Request, Answer> handler) {
        this.handler = handler;
    }

    public String origin() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Every request so far, oldest first. */
    public List<Request> requests() {
        synchronized (requests) {
            return new ArrayList<>(requests);
        }
    }

    /** The requests so far with the given method. */
    public List<Request> requests(String method) {
        List<Request> out = new ArrayList<>();
        for (Request r : requests()) {
            if (r.method.equals(method)) {
                out.add(r);
            }
        }
        return out;
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
