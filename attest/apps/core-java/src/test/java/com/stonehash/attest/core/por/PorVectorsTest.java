package com.stonehash.attest.core.por;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.Vectors;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

/**
 * The reserve proofs held to the reference by vectors
 * (src/test/resources/vectors/por.json, written by
 * tools/make-por-vectors.mjs from the reference's own code): the shape of a
 * statement, its commitment, one opening against a root and totals, the
 * solvency lines, the order openings are put in, and what a read of the
 * reserve chain comes to for every kind of answer a node can give.
 *
 * <p>Every answer in the file is the reference's. Where this service answers
 * differently on purpose the vector says so and says why; where the
 * reference passed on a sentence of its runtime, this service has one of its
 * own, and the test asks only that there is one.
 */
class PorVectorsTest {
    private static final Map<String, Object> V = Vectors.load("por.json");

    // ── reading an answer ─────────────────────────────────────────────────────

    /** What this service did, in the shape the vectors keep an answer in. */
    private static Map<String, Object> answer(Supplier<Object> fn) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            out.put("value", fn.get());
        } catch (PlainError e) {
            out.put("plain", e.getMessage());
        } catch (JsValues.EngineError e) {
            out.put("engine", "(engine)");
        }
        return out;
    }

    /** Why two answers differ, or {@code null}. A fault inside the reference's runtime is matched by one here, whatever each says. */
    private static String differs(Map<String, Object> reference, Map<String, Object> actual) {
        if (reference.containsKey("engine")) {
            return actual.containsKey("engine") ? null : "the reference failed inside its runtime (" + reference.get("engine") + "), here: " + Js.stringify(actual);
        }
        if (reference.containsKey("plain")) {
            return reference.get("plain").equals(actual.get("plain")) ? null : "refused with " + Js.stringify(reference.get("plain")) + ", here: " + Js.stringify(actual);
        }
        if (!actual.containsKey("value")) {
            return "answered " + brief(reference.get("value")) + ", here: " + Js.stringify(actual);
        }
        String a = Js.stringify(reference.get("value"));
        String b = Js.stringify(actual.get("value"));
        return a.equals(b) ? null : "answered " + brief(a) + ", here " + brief(b);
    }

    private static String brief(Object v) {
        String s = v instanceof String ? (String) v : Js.stringify(v);
        return s.length() > 260 ? s.substring(0, 260) + "…" : s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object v) {
        return (Map<String, Object>) v;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object v) {
        return (List<Object>) v;
    }

    private static void none(List<String> failures, String what) {
        assertTrue(failures.isEmpty(), failures.size() + " of the " + what + " differ:\n  " + String.join("\n  ", failures.subList(0, Math.min(25, failures.size()))));
    }

    /** A JSON text with one place replaced ({@code absent} removes the member), as the tool that wrote the vectors made its tables. */
    private static Object at(String baseJson, String where, String valueJson) {
        if (where.equals("$")) {
            return Js.parse(valueJson);
        }
        Object root = Js.parse(baseJson);
        String[] steps = where.split("\\.");
        Object o = root;
        for (int i = 0; i < steps.length - 1; i++) {
            o = o instanceof List ? list(o).get(Integer.parseInt(steps[i])) : map(o).get(steps[i]);
        }
        String last = steps[steps.length - 1];
        if (valueJson.equals("absent")) {
            if (o instanceof List) {
                list(o).remove(Integer.parseInt(last));
            } else {
                map(o).remove(last);
            }
        } else if (o instanceof List) {
            list(o).set(Integer.parseInt(last), Js.parse(valueJson));
        } else {
            map(o).put(last, Js.parse(valueJson));
        }
        // Through text and back, as the tool did: the members come out in the order a document keeps them.
        return Js.parse(Js.stringify(root));
    }

    // ── statements ────────────────────────────────────────────────────────────

    @Test
    void theShapeOfAStatementIsJudgedAsTheReferenceJudgesIt() {
        Map<String, Object> section = map(V.get("statements"));
        List<String> failures = new ArrayList<>();
        int onPurpose = 0;
        List<Map<String, Object>> cases = Vectors.cases(section, "cases");
        for (Map<String, Object> c : cases) {
            Object statement = Js.parse((String) c.get("statementJson"));
            Map<String, Object> actual = answer(() -> SnapshotStatement.problems(statement));
            onPurpose += judged(c, map(c.get("answer")), actual, (String) c.get("name"), failures);
        }
        none(failures, "named statements");
        assertTrue(cases.size() >= 42, "fewer statements than there were: " + cases.size());

        List<Object> values = list(V.get("values"));
        List<Object> places = list(section.get("places"));
        List<Object> table = list(section.get("table"));
        int cells = 0;
        for (int p = 0; p < places.size(); p++) {
            for (int v = 0; v < values.size(); v++) {
                Map<String, Object> cell = map(list(table.get(p)).get(v));
                if (cell.containsKey("skip")) {
                    continue;
                }
                cells++;
                Object statement = at((String) section.get("base"), (String) places.get(p), (String) values.get(v));
                Map<String, Object> actual = answer(() -> SnapshotStatement.problems(statement));
                onPurpose += judged(cell, cell, actual, "statement with " + places.get(p) + " = " + values.get(v), failures);
            }
        }
        none(failures, "cells of the statement table");
        assertTrue(cells >= 590, "fewer cells than there were: " + cells);
        assertTrue(onPurpose >= 15, "fewer answers different on purpose than there were: " + onPurpose);
    }

    /** Compare with the reference's answer, or — where the vector says this service answers differently on purpose — with that. Returns 1 for the latter. */
    private static int judged(Map<String, Object> c, Map<String, Object> reference, Map<String, Object> actual, String name, List<String> failures) {
        if (!c.containsKey("java")) {
            String d = differs(reference, actual);
            if (d != null) {
                failures.add(name + ": " + d);
            }
            return 0;
        }
        String d = differs(map(c.get("java")), actual);
        if (d != null) {
            failures.add(name + " (different on purpose): " + d);
        } else if (differs(reference, actual) == null) {
            failures.add(name + ": listed as different on purpose, and the two answers are the same — the vector is out of date");
        }
        return 1;
    }

    // ── commitments ───────────────────────────────────────────────────────────

    @Test
    void aStatementCommitsToTheSameDigest() {
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> cases = Vectors.cases(V, "commitments");
        for (Map<String, Object> c : cases) {
            Object statement = Js.parse((String) c.get("statementJson"));
            String d = differs(map(c.get("answer")), answer(() -> SumTree.commitment(statement)));
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "commitments");
        assertTrue(cases.size() >= 11, "fewer commitments than there were");
    }

    // ── inclusion ─────────────────────────────────────────────────────────────

    private static Map<String, Object> verified(Object proof, Object against) {
        return answer(() -> {
            SumTree.Result r = SumTree.verify(proof, JsValues.member(against, "root"), JsValues.member(against, "totals"));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", r.ok);
            out.put("computedRoot", r.computedRoot);
            out.put("computedTotals", r.computedTotals);
            out.put("problems", r.problems);
            return out;
        });
    }

    /** As {@link #differs}, but a problem the reference worded with its runtime's sentence only has to be a problem here too. */
    private static String openingDiffers(Map<String, Object> reference, Map<String, Object> actual) {
        if (!reference.containsKey("engineWorded")) {
            return differs(reference, actual);
        }
        if (!actual.containsKey("value")) {
            return "answered " + brief(reference.get("value")) + ", here: " + Js.stringify(actual);
        }
        Map<String, Object> want = map(reference.get("value"));
        Map<String, Object> got = map(actual.get("value"));
        List<Object> wanted = list(want.get("problems"));
        List<Object> found = list(got.get("problems"));
        if (!want.get("ok").equals(got.get("ok")) || wanted.size() != found.size() || !want.get("computedRoot").equals(got.get("computedRoot"))) {
            return "answered " + brief(want) + ", here " + brief(got);
        }
        List<Object> worded = list(reference.get("engineWorded"));
        for (int i = 0; i < wanted.size(); i++) {
            String ours = (String) found.get(i);
            if (worded.contains((double) i)) {
                if (ours.isEmpty() || ours.contains("Cannot ") || ours.contains("undefined") || ours.equals(wanted.get(i))) {
                    return "problem " + i + " should be a sentence of this service's about the opening, here: " + ours;
                }
            } else if (!wanted.get(i).equals(ours)) {
                return "problem " + i + ": " + wanted.get(i) + ", here: " + ours;
            }
        }
        return null;
    }

    @Test
    void anOpeningIsCheckedAgainstARootAndTotalsAsTheReferenceChecksIt() {
        Map<String, Object> section = map(V.get("inclusion"));
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> cases = Vectors.cases(section, "cases");
        int ok = 0;
        for (Map<String, Object> c : cases) {
            Map<String, Object> reference = map(c.get("answer"));
            Map<String, Object> actual = verified(Js.parse((String) c.get("proofJson")), Js.parse((String) c.get("againstJson")));
            String d = openingDiffers(reference, actual);
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
            if (reference.containsKey("value") && Boolean.TRUE.equals(map(reference.get("value")).get("ok"))) {
                ok++;
            }
        }
        none(failures, "named openings");
        assertTrue(cases.size() >= 90 && ok >= 40, "fewer openings than there were: " + cases.size() + ", " + ok + " of them sound");

        List<Object> values = list(V.get("values"));
        String base = (String) section.get("base");
        String against = (String) section.get("against");
        int cells = 0;
        int worded = 0;
        for (String which : new String[] { "table", "againstTable" }) {
            List<Object> places = list(section.get(which.equals("table") ? "places" : "againstPlaces"));
            List<Object> table = list(section.get(which));
            for (int p = 0; p < places.size(); p++) {
                for (int v = 0; v < values.size(); v++) {
                    Map<String, Object> cell = map(list(table.get(p)).get(v));
                    if (cell.containsKey("skip")) {
                        continue;
                    }
                    cells++;
                    worded += cell.containsKey("engineWorded") ? 1 : 0;
                    String place = (String) places.get(p);
                    String value = (String) values.get(v);
                    Map<String, Object> actual = which.equals("table") ? verified(at(base, place, value), Js.parse(against))
                            : verified(Js.parse(base), at(against, place, value));
                    String d = openingDiffers(cell, actual);
                    if (d != null) {
                        failures.add((which.equals("table") ? "opening with " : "checked against ") + place + " = " + value + ": " + d);
                    }
                }
            }
        }
        none(failures, "cells of the opening tables");
        assertTrue(cells >= 660 && worded >= 60, "fewer cells than there were: " + cells + ", " + worded + " with a sentence of the runtime's");
    }

    // ── solvency, and the order of openings ───────────────────────────────────

    @Test
    void coverageIsWorkedOutAsTheReferenceWorksItOut() {
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> cases = Vectors.cases(V, "solvency");
        for (Map<String, Object> c : cases) {
            List<Map<String, Object>> measurements = new ArrayList<>();
            for (Object m : list(c.get("measurements"))) {
                measurements.add(map(m));
            }
            Object totals = Js.parse((String) c.get("totalsJson"));
            String d = differs(map(c.get("answer")), answer(() -> Reserves.solvency(totals, measurements)));
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "solvency reports");
        assertTrue(cases.size() >= 27, "fewer solvency reports than there were");
    }

    @Test
    void theIndicesOfASetOfOpeningsArePutInOrderAsTheReferencePutsThem() {
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> cases = Vectors.cases(V, "orders");
        for (Map<String, Object> c : cases) {
            Object openings = Js.parse((String) c.get("openingsJson"));
            Map<String, Object> actual = answer(() -> {
                List<Object> provided = new ArrayList<>();
                for (Object o : list(openings)) {
                    provided.add(JsValues.member(o, "leaf_index"));
                }
                List<Object> sorted = Openings.sorted(provided);
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("stringified", Js.stringify(sorted));
                out.put("joined", Openings.joined(sorted));
                return out;
            });
            String d = differs(map(c.get("answer")), actual);
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "orderings");
        assertTrue(cases.size() >= 19, "fewer orderings than there were");
    }

    // ── the reserve chain ─────────────────────────────────────────────────────

    /** A node of one method: it answers each request with the next reply it was given, and keeps what it was sent. */
    private static final class Node implements AutoCloseable {
        final ServerSocket socket;
        final ConcurrentLinkedDeque<Map<String, Object>> replies = new ConcurrentLinkedDeque<>();
        final List<Map<String, Object>> sent = Collections.synchronizedList(new ArrayList<>());
        /** A slow answer comes this late; the read is given less. */
        static final long SLOW_MS = 1_500;

        Node() throws IOException {
            socket = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            Thread accept = new Thread(() -> {
                while (!socket.isClosed()) {
                    try {
                        Socket s = socket.accept();
                        Thread t = new Thread(() -> serve(s));
                        t.setDaemon(true);
                        t.start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            accept.setDaemon(true);
            accept.start();
        }

        String url() {
            return "http://127.0.0.1:" + socket.getLocalPort() + "/";
        }

        private void serve(Socket s) {
            try (Socket c = s) {
                InputStream in = c.getInputStream();
                ByteArrayOutputStream head = new ByteArrayOutputStream();
                int state = 0;
                while (state < 4) {
                    int b = in.read();
                    if (b < 0) {
                        return;
                    }
                    head.write(b);
                    state = (b == '\r' && (state == 0 || state == 2)) || (b == '\n' && (state == 1 || state == 3)) ? state + 1 : b == '\r' ? 1 : 0;
                }
                String[] lines = head.toString(StandardCharsets.ISO_8859_1).split("\r\n");
                String[] request = lines[0].split(" ");
                int length = 0;
                String contentType = null;
                for (String line : lines) {
                    String lower = line.toLowerCase(Locale.ROOT);
                    if (lower.startsWith("content-length:")) {
                        length = Integer.parseInt(line.substring(15).trim());
                    } else if (lower.startsWith("content-type:")) {
                        contentType = line.substring(13).trim();
                    }
                }
                byte[] body = in.readNBytes(length);
                Map<String, Object> got = new LinkedHashMap<>();
                got.put("method", request[0]);
                got.put("target", request[1]);
                got.put("contentType", contentType);
                got.put("body", new String(body, StandardCharsets.UTF_8));
                sent.add(got);
                Map<String, Object> reply = replies.poll();
                if (reply == null || Boolean.TRUE.equals(reply.get("close"))) {
                    return;
                }
                if (reply.containsKey("delayMs")) {
                    Thread.sleep(SLOW_MS);
                }
                byte[] payload = ((String) reply.get("body")).getBytes(StandardCharsets.UTF_8);
                StringBuilder out = new StringBuilder("HTTP/1.1 " + (reply.containsKey("status") ? (int) (double) (Double) reply.get("status") : 200) + " X\r\n");
                Map<String, Object> headers = new LinkedHashMap<>();
                headers.put("content-type", "application/json");
                if (reply.get("headers") != null) {
                    headers.putAll(map(reply.get("headers")));
                }
                for (Map.Entry<String, Object> h : headers.entrySet()) {
                    out.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
                }
                out.append("content-length: ").append(payload.length).append("\r\nconnection: close\r\n\r\n");
                OutputStream o = c.getOutputStream();
                o.write(out.toString().getBytes(StandardCharsets.ISO_8859_1));
                o.write(payload);
                o.flush();
            } catch (IOException | InterruptedException e) {
                // The client went away, which is what some of these cases are about.
            }
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }

    private static Map<String, Object> timeless(Map<String, Object> measurement) {
        Map<String, Object> out = new LinkedHashMap<>(measurement);
        if (out.containsKey("measured_at")) {
            assertTrue(((String) out.get("measured_at")).matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z"), "measured_at is an instant");
            out.put("measured_at", "<time>");
        }
        return out;
    }

    @Test
    void aReadOfTheReserveChainComesToWhatTheReferenceMakesOfEveryAnswer() throws IOException {
        Map<String, Object> section = map(V.get("rpc"));
        String chain = (String) section.get("chain");
        List<String> failures = new ArrayList<>();
        int onPurpose = 0;
        Object usual = map(list(section.get("requests")).get(0)).get("entry");
        String url;
        try (Node node = new Node()) {
            url = node.url();
            List<Map<String, Object>> cases = Vectors.cases(section, "cases");
            for (Map<String, Object> c : cases) {
                Map<String, Object> reply = map(c.get("reply"));
                node.replies.clear();
                node.sent.clear();
                node.replies.add(reply);
                if (reply.containsKey("then")) {
                    node.replies.add(map(reply.get("then")));
                }
                Duration timeout = reply.containsKey("delayMs") ? Duration.ofMillis(300) : Reserves.TIMEOUT;
                Map<String, Object> got = timeless(Reserves.measure(List.of(usual), chain, url, timeout).get(0));
                Map<String, Object> want = map(c.containsKey("java") ? c.get("java") : c.get("measurement"));
                if (!Js.stringify(want).equals(Js.stringify(got))) {
                    failures.add(c.get("name") + ": " + Js.stringify(want) + ", here " + Js.stringify(got));
                } else if (c.containsKey("java") && Js.stringify(c.get("measurement")).equals(Js.stringify(got))) {
                    failures.add(c.get("name") + ": listed as different on purpose, and the two reports are the same");
                }
                onPurpose += c.containsKey("java") ? 1 : 0;
                // What was sent: the same requests in the same order — the method, the path, and the body byte for byte.
                List<Object> wanted = list(c.get("requests"));
                List<Map<String, Object>> sent = new ArrayList<>(node.sent);
                if (wanted.size() != sent.size()) {
                    failures.add(c.get("name") + ": " + wanted.size() + " requests, here " + sent.size());
                    continue;
                }
                for (int i = 0; i < wanted.size(); i++) {
                    Map<String, Object> w = map(wanted.get(i));
                    Map<String, Object> s = sent.get(i);
                    if (!w.get("method").equals(s.get("method")) || !w.get("target").equals(s.get("target")) || !w.get("body").equals(s.get("body"))
                            || (i == 0 && !String.valueOf(w.get("contentType")).equals(String.valueOf(s.get("contentType"))))) {
                        failures.add(c.get("name") + ": request " + i + " was " + Js.stringify(w) + ", here " + Js.stringify(s));
                    }
                }
            }
            assertTrue(cases.size() >= 58, "fewer answers than there were");

            // The entries: what is sent for each, and which are never read at all.
            for (Object r : list(section.get("requests"))) {
                Map<String, Object> c = map(r);
                node.replies.clear();
                node.sent.clear();
                Map<String, Object> first = new LinkedHashMap<>();
                first.put("body", "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}");
                node.replies.add(first);
                Map<String, Object> got = timeless(Reserves.measure(List.of(c.get("entry")), chain, url).get(0));
                if (!Js.stringify(c.get("measurement")).equals(Js.stringify(got))) {
                    failures.add("entry " + c.get("name") + ": " + Js.stringify(c.get("measurement")) + ", here " + Js.stringify(got));
                }
                Object sent = node.sent.isEmpty() ? null : node.sent.get(0).get("body");
                if (!String.valueOf(c.get("request")).equals(String.valueOf(sent))) {
                    failures.add("entry " + c.get("name") + ": sent " + c.get("request") + ", here " + sent);
                }
            }

            // Several entries, one after the other, each to its own outcome; and the coverage they come to.
            Map<String, Object> together = map(section.get("together"));
            node.replies.clear();
            node.sent.clear();
            for (Object reply : list(together.get("replies"))) {
                node.replies.add(map(reply));
            }
            List<Map<String, Object>> measured = Reserves.measure(list(together.get("entries")), chain, url);
            List<Object> timelessAll = new ArrayList<>();
            for (Map<String, Object> m : measured) {
                timelessAll.add(timeless(m));
            }
            assertEquals(Js.stringify(together.get("measurements")), Js.stringify(timelessAll), "several entries");
            assertEquals(Js.stringify(together.get("solvency")), Js.stringify(Reserves.solvency(together.get("totals"), measured)), "the coverage of several entries");
        }
        // Nothing listens there any more; and an address that is no address.
        assertEquals(Js.stringify(section.get("refused")), Js.stringify(timeless(Reserves.measure(List.of(usual), chain, url).get(0))), "a node that is not there");
        assertEquals(Js.stringify(section.get("unparsable")), Js.stringify(timeless(Reserves.measure(List.of(usual), chain, "").get(0))), "no address at all");
        none(failures, "reads of the reserve chain");
        assertTrue(onPurpose >= 4, "fewer reports different on purpose than there were: " + onPurpose);
    }
}
