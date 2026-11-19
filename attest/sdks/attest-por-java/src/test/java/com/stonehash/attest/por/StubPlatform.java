package com.stonehash.attest.por;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A platform that follows the published contract and remembers every request
 * it was sent, on a port of its own inside the test process.
 *
 * <p>Written on a bare socket rather than a ready-made HTTP server because
 * the tests are about connections: this one can close a connection that has
 * been idle, the way the real platform does after five seconds, and can drop
 * a request that arrives on a connection it had already answered on — what a
 * client sees when it reuses a pooled connection at the moment the server
 * closes it.
 */
final class StubPlatform implements AutoCloseable {
    /** One request as it arrived. */
    static final class Request {
        final int connection;
        final String method;
        final String path;
        final Map<String, String> headers;
        final String body;

        Request(int connection, String method, String path, Map<String, String> headers, String body) {
            this.connection = connection;
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> json() {
            return (Map<String, Object>) Json.parse(body, "test");
        }
    }

    /** What to answer with. */
    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }

        static Reply json(int status, Map<String, Object> value) {
            return new Reply(status, Json.compact(value));
        }
    }

    interface Handler {
        /** Null for "not handled here": the stub's own contract answers. */
        Reply handle(Request request);
    }

    final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    final AtomicInteger connections = new AtomicInteger();

    /** Close a connection that has carried no request for this long; 0 keeps it open. */
    volatile int idleCloseMillis;
    /** Close, unanswered, any request that is not the first on its connection. */
    volatile boolean dropReusedConnections;
    /** Close, unanswered, this many requests from now on. */
    final AtomicInteger dropNext = new AtomicInteger();
    /** Break off this many answers from now on after their first bytes: a connection lost in mid-answer. */
    final AtomicInteger truncateNext = new AtomicInteger();
    /** Consulted before the contract; lets a test stage a refusal. */
    volatile Handler override;
    /** Polls of a snapshot's status before its anchor reads as confirmed. */
    volatile int confirmAfterPolls;
    /** The challenge sent when a spot check is asked for. */
    volatile List<Object> challenge = new ArrayList<>(java.util.Arrays.asList(0L, 3L, 7L));

    private final String exchangeId;
    private final String spki;
    private final ServerSocket server;
    private final Map<String, Statement> statements = Collections.synchronizedMap(new LinkedHashMap<>());
    private final AtomicInteger polls = new AtomicInteger();

    StubPlatform(String exchangeId, String spki) throws IOException {
        this.exchangeId = exchangeId;
        this.spki = spki;
        this.server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Thread acceptor = new Thread(this::accept, "stub-platform");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    String base() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    List<Request> posts() {
        List<Request> out = new ArrayList<>();
        synchronized (requests) {
            for (Request r : requests) {
                if (r.method.equals("POST")) {
                    out.add(r);
                }
            }
        }
        return out;
    }

    @Override
    public void close() throws IOException {
        server.close();
    }

    private void accept() {
        while (true) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException closed) {
                return;
            }
            int id = connections.incrementAndGet();
            Thread t = new Thread(() -> serve(socket, id), "stub-platform-connection-" + id);
            t.setDaemon(true);
            t.start();
        }
    }

    private void serve(Socket socket, int id) {
        try (Socket s = socket) {
            s.setSoTimeout(idleCloseMillis);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            for (int n = 1;; n++) {
                Request request = read(in, id);
                if (request == null) {
                    return;
                }
                requests.add(request);
                if ((dropReusedConnections && n > 1) || dropNext.getAndUpdate(v -> Math.max(0, v - 1)) > 0) {
                    return;
                }
                Reply reply = override == null ? null : override.handle(request);
                if (reply == null) {
                    reply = contract(request);
                }
                byte[] body = reply.body.getBytes(StandardCharsets.UTF_8);
                // No "Connection: close": like the real platform, the stub leaves the connection open for reuse.
                out.write(("HTTP/1.1 " + reply.status + " Stub\r\nContent-Type: application/json\r\nContent-Length: "
                        + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if (truncateNext.getAndUpdate(v -> Math.max(0, v - 1)) > 0) {
                    out.write(body, 0, 1);
                    out.flush();
                    return;
                }
                out.write(body);
                out.flush();
            }
        } catch (SocketTimeoutException idle) {
            // Closing here is the behaviour under test.
        } catch (IOException e) {
            // The client went away; nothing to answer.
        }
    }

    private static Request read(InputStream in, int connection) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int c = in.read();
            if (c < 0) {
                return null;
            }
            head.write(c);
            matched = c == "\r\n\r\n".charAt(matched) ? matched + 1 : c == '\r' ? 1 : 0;
        }
        String[] lines = head.toString("ISO-8859-1").split("\r\n");
        String[] start = lines[0].split(" ");
        Map<String, String> headers = new LinkedHashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            headers.put(lines[i].substring(0, colon).toLowerCase(java.util.Locale.ROOT), lines[i].substring(colon + 1).trim());
        }
        int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
        byte[] body = in.readNBytes(length);
        return new Request(connection, start[0], start[1], headers, new String(body, StandardCharsets.UTF_8));
    }

    /** The published API, as far as the SDK uses it. */
    private Reply contract(Request r) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (r.method.equals("GET") && r.path.equals("/v1/remit/meta")) {
            Map<String, Object> institution = new LinkedHashMap<>();
            institution.put("id", exchangeId);
            institution.put("signing_spki", spki);
            out.put("institutions", java.util.Arrays.asList(institution));
            return Reply.json(200, out);
        }
        if (r.method.equals("POST") && r.path.equals("/v1/por/snapshots")) {
            Map<String, Object> body = r.json();
            Statement statement = Statement.fromMap(Json.object(body.get("statement"), "test", "statement"));
            if (!SignatureEnvelope.fromJson(body.get("sig")).verifies(statement, spki)) {
                return refusal(400, "invalid_signature", "sig does not verify over the statement with the registered EXCHANGE key");
            }
            String id = "snap-" + (statements.size() + 1);
            statements.put(id, statement);
            out.put("snapshot_id", id);
            if (Boolean.TRUE.equals(body.get("spot_check"))) {
                Map<String, Object> ch = new LinkedHashMap<>();
                ch.put("indices", challenge);
                out.put("status", "CHALLENGED");
                out.put("spot_check", true);
                out.put("challenge", ch);
            } else {
                out.put("status", "ACCEPTED");
                out.put("spot_check", false);
                out.put("attestation_id", "att-" + id);
            }
            return Reply.json(201, out);
        }
        if (r.method.equals("POST") && r.path.matches("/v1/por/snapshots/[^/]+/openings")) {
            String id = r.path.split("/")[4];
            Statement statement = statements.get(id);
            List<Object> problems = new ArrayList<>();
            List<Object> openings = Json.array(r.json().get("openings"), "test", "openings");
            for (Object opening : openings) {
                try {
                    ProofVerification v = InclusionProof.fromJson(opening).verify(statement.root(), statement.totals());
                    problems.addAll(v.problems());
                } catch (PorException e) {
                    problems.add(e.getMessage());
                }
            }
            out.put("snapshot_id", id);
            out.put("status", problems.isEmpty() ? "VERIFIED" : "REJECTED");
            if (problems.isEmpty()) {
                out.put("attestation_id", "att-" + id);
                out.put("sampled_leaves", (long) openings.size());
            } else {
                out.put("problems", problems);
            }
            return Reply.json(problems.isEmpty() ? 200 : 422, out);
        }
        if (r.method.equals("GET") && r.path.matches("/v1/por/snapshots/[^/]+") && statements.containsKey(r.path.split("/")[4])) {
            String id = r.path.split("/")[4];
            Statement statement = statements.get(id);
            Map<String, Object> attestation = new LinkedHashMap<>();
            attestation.put("id", "att-" + id);
            attestation.put("status", polls.incrementAndGet() > confirmAfterPolls ? "confirmed" : "pending");
            out.put("snapshot_id", id);
            out.put("status", "ACCEPTED");
            out.put("root", statement.root());
            out.put("totals", statement.toMap().get("totals"));
            out.put("leaf_count", (long) statement.leafCount());
            out.put("commitment", statement.commitment());
            out.put("attestation", attestation);
            return Reply.json(200, out);
        }
        return refusal(404, "not_found", "no route for " + r.method + " " + r.path);
    }

    static Reply refusal(int status, String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", code);
        out.put("message", message);
        return Reply.json(status, out);
    }
}
