package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.evidence.Pdf;
import com.stonehash.attest.core.evidence.Reconciler;
import com.stonehash.attest.core.evidence.SettlementEvidence;
import com.stonehash.attest.core.evidence.ZipWriter;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.sandbox.Sandbox;
import com.stonehash.attest.core.sandbox.SandboxMaterial;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.Inflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.Test;

/**
 * The evaluation sandbox and the stateless settlement evidence held to the
 * reference: every answer in {@code vectors/sandbox.json} was given by the
 * reference's own handlers ({@code apps/core/src/http/sandbox.ts},
 * {@code evidence.ts}) and by {@code packages/attest-evidence}
 * ({@code tools/make-sandbox-vectors.mjs}).
 *
 * <p>Where this service answers differently on purpose the vector says so,
 * with the row of docs/JAVA-INTENDED-DIFFERENCES.md that says why — and then
 * the two answers have to differ, or the row is out of date.
 */
class SandboxVectorsTest {
    private static final Map<String, Object> V = Vectors.load("sandbox.json");
    private static final long CLOCK = ((Number) V.get("clock")).longValue();
    private static final String UUID = (String) V.get("uuid");
    private static final Sandbox SANDBOX = new Sandbox(SandboxMaterial.load(), Reconciler.demo());
    private static final SettlementEvidence EVIDENCE = new SettlementEvidence(Reconciler.demo());

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    private static void none(List<String> failures, String what) {
        assertTrue(failures.isEmpty(), failures.size() + " " + what + " differ from the reference:\n  "
                + String.join("\n  ", failures.subList(0, Math.min(40, failures.size()))));
    }

    private static String sha256(byte[] bytes) {
        return Hex.encode(Hex.sha256(bytes));
    }

    /** A body as the vector file keeps it, with the sample documents put back where their names stand. */
    private static String expand(String body) {
        String out = body;
        for (Map.Entry<String, Object> part : map(V.get("parts")).entrySet()) {
            out = out.replace(part.getKey(), (String) part.getValue());
        }
        return out;
    }

    // ── a route's answer, in the form the vector file gives the reference's ──

    private static int u16(byte[] b, int at) {
        return (b[at] & 0xff) | ((b[at + 1] & 0xff) << 8);
    }

    private static long u32(byte[] b, int at) {
        return ByteBuffer.wrap(b, at, 4).order(ByteOrder.LITTLE_ENDIAN).getInt() & 0xffffffffL;
    }

    private static byte[] inflate(byte[] packed, int size) throws Exception {
        Inflater in = new Inflater(true);
        in.setInput(packed);
        byte[] out = new byte[size];
        int n = 0;
        while (n < size && !in.finished()) {
            int got = in.inflate(out, n, size - n);
            if (got == 0 && (in.needsInput() || in.needsDictionary())) {
                break;
            }
            n += got;
        }
        // Nothing may be left over: one more byte asked for has to come back empty.
        boolean exact = n == size && in.inflate(new byte[1]) == 0;
        in.end();
        if (!exact) {
            throw new IllegalStateException("a member does not inflate to the size its header states");
        }
        return out;
    }

    /** An archive read back out of its ZIP: every member unpacked and checked against its own header. */
    private static Map<String, Object> archiveOf(HttpResult result) throws Exception {
        byte[] zip = (byte[]) result.body;
        List<Object> members = new ArrayList<>();
        int off = 0;
        int dosTime = 0;
        int dosDate = 0;
        while (u32(zip, off) == 0x04034b50L) {
            int method = u16(zip, off + 8);
            dosTime = u16(zip, off + 10);
            dosDate = u16(zip, off + 12);
            long crc = u32(zip, off + 14);
            int packed = (int) u32(zip, off + 18);
            int size = (int) u32(zip, off + 22);
            int nameLength = u16(zip, off + 26);
            String name = new String(zip, off + 30, nameLength, StandardCharsets.UTF_8);
            byte[] data = Arrays.copyOfRange(zip, off + 30 + nameLength, off + 30 + nameLength + packed);
            byte[] bytes = method == 8 ? inflate(data, size) : data;
            CRC32 sum = new CRC32();
            sum.update(bytes);
            assertEquals(size, bytes.length, name + ": the size in the header");
            assertEquals(crc, sum.getValue(), name + ": the CRC in the header");
            Map<String, Object> member = new LinkedHashMap<>();
            member.put("path", name);
            member.put("bytes", size);
            member.put("sha256", sha256(bytes));
            member.put("crc32", crc);
            members.add(member);
            off += 30 + nameLength + packed;
        }
        assertEquals(sha256(zip), result.headers.get("x-evidence-sha256"), "x-evidence-sha256 is the digest of the archive");
        // And an ordinary reader opens it: the same members, in the same order.
        List<String> read = new ArrayList<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
            for (ZipEntry e = in.getNextEntry(); e != null; e = in.getNextEntry()) {
                read.add(e.getName() + ":" + sha256(in.readAllBytes()));
            }
        }
        List<String> written = new ArrayList<>();
        for (Object m : members) {
            written.add(map(m).get("path") + ":" + map(m).get("sha256"));
        }
        assertEquals(written, read, "what java.util.zip reads out of the archive");

        Map<String, Object> archive = new LinkedHashMap<>();
        archive.put("members", members);
        archive.put("dosTime", dosTime);
        archive.put("dosDate", dosDate);
        archive.put("contentType", result.headers.get("content-type"));
        archive.put("disposition", result.headers.get("content-disposition"));
        archive.put("bundleId", result.headers.get("x-evidence-bundle-id"));
        return archive;
    }

    private static Map<String, Object> answer(String route, Object body) throws Exception {
        Map<String, Object> a = new LinkedHashMap<>();
        try {
            Object out;
            switch (route) {
                case "evidence":
                    out = SANDBOX.evidence(body);
                    break;
                case "package":
                    out = SANDBOX.pack(body, CLOCK);
                    break;
                case "verify":
                    out = SANDBOX.verifyPackage(body);
                    break;
                case "reconcile":
                    out = EVIDENCE.reconcile(body);
                    break;
                case "bundle": {
                    HttpResult r = EVIDENCE.bundle(body, CLOCK, () -> UUID);
                    a.put("status", r.status);
                    a.put("archive", archiveOf(r));
                    return a;
                }
                default:
                    throw new IllegalArgumentException(route);
            }
            a.put("status", 200);
            a.put("sha256", sha256(Js.stringify(out, 2).getBytes(StandardCharsets.UTF_8)));
            a.put("json", out);
        } catch (HttpError e) {
            a.put("status", e.status());
            a.put("error", e.code());
            a.put("message", e.getMessage());
        } catch (PlainError e) {
            a.put("status", 500);
            a.put("plain", e.getMessage());
        } catch (JsValues.EngineError e) {
            a.put("status", 500);
            a.put("engine", e.getMessage());
        }
        return a;
    }

    private static int status(Map<String, Object> a) {
        return ((Number) a.get("status")).intValue();
    }

    /** Is this answer of ours the one the vector states? {@code null} when it is, otherwise what differs. */
    private static String differs(Map<String, Object> expected, Map<String, Object> actual) {
        if (status(expected) != status(actual)) {
            return "status " + status(expected) + " there, " + brief(actual) + " here";
        }
        if (expected.containsKey("sha256")) {
            return expected.get("sha256").equals(actual.get("sha256")) ? null : "another answer (" + actual.get("sha256") + "): " + brief(actual);
        }
        if (expected.containsKey("archive")) {
            String there = Js.stringify(integers(expected.get("archive")), 1);
            String here = Js.stringify(actual.get("archive"), 1);
            return there.equals(here) ? null : "another archive:\n" + firstDifference(there, here);
        }
        if (expected.containsKey("plain")) {
            return expected.get("plain").equals(actual.get("plain")) ? null : "\"" + expected.get("plain") + "\" there, " + brief(actual) + " here";
        }
        if (expected.containsKey("engine")) {
            return actual.containsKey("engine") ? null : "the engine gave up there, " + brief(actual) + " here";
        }
        if (!expected.get("error").equals(actual.get("error"))) {
            return expected.get("error") + " there, " + brief(actual) + " here";
        }
        // A refusal the reference worded with the engine's complaint is worded here in a sentence of this service's (D-03).
        if (Boolean.TRUE.equals(expected.get("engineWorded"))) {
            return actual.get("message") instanceof String && !((String) actual.get("message")).isEmpty() ? null : "a refusal with no sentence";
        }
        return expected.get("message").equals(actual.get("message")) ? null : "\"" + expected.get("message") + "\" there, \"" + actual.get("message") + "\" here";
    }

    private static String brief(Map<String, Object> a) {
        Map<String, Object> shown = new LinkedHashMap<>(a);
        if (shown.containsKey("json")) {
            String json = Js.stringify(shown.remove("json"));
            shown.put("json", json.length() > 600 ? json.substring(0, 600) + "…" : json);
        }
        return Js.stringify(shown);
    }

    private static String firstDifference(String there, String here) {
        String[] a = there.split("\n");
        String[] b = here.split("\n");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            String x = i < a.length ? a[i] : "<nothing>";
            String y = i < b.length ? b[i] : "<nothing>";
            if (!x.equals(y)) {
                return "      there " + x.trim() + "\n      here  " + y.trim();
            }
        }
        return "      (the same)";
    }

    /** Numbers of a vector as whole numbers, where they are: what this side's own archive description holds. */
    private static Object integers(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : map(v).entrySet()) {
                out.put(e.getKey(), integers(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : list(v)) {
                out.add(integers(item));
            }
            return out;
        }
        return v instanceof Double && ((Double) v) == Math.rint((Double) v) ? (Object) Long.valueOf(((Double) v).longValue()) : v;
    }

    // ── the catalogue ────────────────────────────────────────────────────────

    @Test
    void theCatalogueIsTheReferences() {
        assertEquals(Js.stringify(V.get("catalogue"), 2), Js.stringify(SANDBOX.catalogue(), 2));
    }

    // ── named cases ──────────────────────────────────────────────────────────

    @Test
    void everyNamedCaseIsAnsweredAsTheReferenceAnswersIt() throws Exception {
        List<String> failures = new ArrayList<>();
        Map<String, Integer> ran = new LinkedHashMap<>();
        int onPurpose = 0;
        for (Map<String, Object> c : Vectors.cases(V, "cases")) {
            String route = (String) c.get("route");
            ran.merge(route, 1, Integer::sum);
            Map<String, Object> reference = map(c.get("answer"));
            Map<String, Object> actual = answer(route, Js.parse(expand((String) c.get("body"))));
            if (!c.containsKey("java")) {
                String d = differs(reference, actual);
                if (d != null) {
                    failures.add(c.get("name") + ": " + d);
                }
                continue;
            }
            // Different on purpose: our answer is the one the row states, and it is not the reference's.
            onPurpose++;
            Map<String, Object> java = map(c.get("java"));
            String d;
            if (java.containsKey("verdict")) {
                // An answer where the reference refused: a verdict, whatever it says.
                d = status(actual) == 200 && actual.containsKey("sha256") ? null : "no verdict: " + brief(actual);
            } else if (java.containsKey("timeFindings")) {
                d = status(actual) != 200 ? "no verdict: " + brief(actual) : Js.stringify(java.get("timeFindings")).equals(Js.stringify(timeFindings(actual.get("json")))) ? null
                        : "findings about time " + Js.stringify(timeFindings(actual.get("json"))) + ", the row says " + Js.stringify(java.get("timeFindings"));
            } else {
                d = differs(java, actual);
            }
            if (d != null) {
                failures.add(c.get("name") + " (" + c.get("why") + "): " + d);
            } else if (differs(reference, actual) == null) {
                failures.add(c.get("name") + ": listed as different on purpose (" + c.get("why") + "), and the two answers are the same — the row is out of date");
            }
        }
        none(failures, "named cases");
        assertTrue(ran.getOrDefault("evidence", 0) >= 100 && ran.getOrDefault("package", 0) >= 30 && ran.getOrDefault("verify", 0) >= 39
                && ran.getOrDefault("reconcile", 0) >= 89 && ran.getOrDefault("bundle", 0) >= 77, "fewer cases than there were: " + ran);
        assertTrue(onPurpose >= 14, "fewer cases different on purpose than there were: " + onPurpose);
    }

    /** The codes of a verdict's findings about time, in the order the rules ran. */
    private static List<Object> timeFindings(Object verdict) {
        List<Object> codes = new ArrayList<>();
        for (Object f : list(map(verdict).get("findings"))) {
            String code = (String) map(f).get("code");
            if (code.contains("TIMESTAMP") || code.equals("SETTLEMENT_BEFORE_APPROVAL") || code.equals("SETTLEMENT_WINDOW_EXCEEDED")) {
                codes.add(code);
            }
        }
        return codes;
    }

    // ── the table: each place in the evidence, each odd value, each route ─────

    private static String shortForm(Map<String, Object> a) {
        if (a.containsKey("sha256")) {
            return "=" + ((String) a.get("sha256")).substring(0, 16);
        }
        if (a.containsKey("archive")) {
            return "=" + sha256(Js.stringify(a.get("archive")).getBytes(StandardCharsets.UTF_8)).substring(0, 16);
        }
        if (a.containsKey("plain")) {
            return "P:" + a.get("plain");
        }
        if (a.containsKey("engine")) {
            return "E";
        }
        return status(a) + ":" + a.get("error") + ":" + a.get("message");
    }

    /** The body of one cell: the base body with one place replaced by a value, or — for no value — removed. */
    private static Object cell(String base, List<Object> where, String value) {
        Object body = Js.parse(base);
        Object at = body;
        for (Object step : where.subList(0, where.size() - 1)) {
            at = step instanceof Number ? list(at).get(((Number) step).intValue()) : map(at).get(step);
        }
        Object last = where.get(where.size() - 1);
        if (value == null) {
            if (last instanceof Number) {
                list(at).remove(((Number) last).intValue());
            } else {
                map(at).remove(last);
            }
        } else if (last instanceof Number) {
            list(at).set(((Number) last).intValue(), Js.parse(value));
        } else {
            map(at).put((String) last, Js.parse(value));
        }
        return body;
    }

    @Test
    void everyCellOfTheTableIsAnsweredAsTheReferenceAnswersIt() throws Exception {
        Map<String, Object> table = map(V.get("table"));
        List<Object> values = list(table.get("values"));
        List<Object> nodes = list(table.get("nodes"));
        List<Object> packageNodes = list(table.get("packageNodes"));
        Map<String, Object> bases = map(table.get("bases"));
        List<String> failures = new ArrayList<>();
        // The cells answered differently on purpose: route/node/value → the kind of answer, and the row that says why.
        Map<String, Map<String, Object>> onPurpose = new LinkedHashMap<>();
        for (Object each : list(table.get("onPurpose"))) {
            onPurpose.put(map(each).get("route") + "/" + ((Number) map(each).get("node")).intValue() + "/" + ((Number) map(each).get("value")).intValue(), map(each));
        }
        int different = 0;
        int cells = 0;
        for (Object each : list(table.get("rows"))) {
            Map<String, Object> row = map(each);
            String route = (String) row.get("route");
            List<Object> where = new ArrayList<>();
            where.add(route.equals("verify") ? "package" : "evidence");
            where.addAll(list(route.equals("verify") ? packageNodes.get(((Number) row.get("packageNode")).intValue()) : nodes.get(((Number) row.get("node")).intValue())));
            List<Object> steps = row.containsKey("steps") ? list(row.get("steps")) : new ArrayList<>();
            List<Object> answers = list(row.get("answers"));
            for (int i = 0; i < values.size(); i++) {
                cells++;
                Object body = cell(expand((String) bases.get(route)), where, (String) values.get(i));
                if (!steps.isEmpty()) {
                    map(body).put("tampers", steps);
                }
                // As a request carries it: written out and read again.
                String sent = Js.stringify(body);
                String expected = (String) answers.get(i);
                String actual = shortForm(answer(route, Js.parse(sent)));
                boolean same = expected.endsWith(":~") ? actual.startsWith(expected.substring(0, expected.length() - 1)) && !actual.endsWith(":") : expected.equals(actual);
                Map<String, Object> listed = row.containsKey("node") ? onPurpose.get(route + "/" + ((Number) row.get("node")).intValue() + "/" + i) : null;
                if (listed != null) {
                    different++;
                    if (same) {
                        failures.add(route + " " + Js.stringify(where) + " = " + values.get(i) + ": listed as different on purpose (" + listed.get("why") + "), and the two answers are the same — the row is out of date");
                    } else if (!actual.startsWith((String) listed.get("java"))) {
                        failures.add(route + " " + Js.stringify(where) + " = " + values.get(i) + " (" + listed.get("why") + "): " + actual + " here, the row says " + listed.get("java"));
                    }
                } else if (!same) {
                    failures.add(route + (steps.isEmpty() ? "" : " " + Js.stringify(steps)) + " " + Js.stringify(where) + " = " + values.get(i) + ": " + expected + " there, " + actual + " here");
                }
            }
        }
        none(failures, "cells of the table");
        assertTrue(cells >= 6000, "fewer cells than there were: " + cells);
        assertEquals(onPurpose.size(), different, "every cell listed as different on purpose was met");
    }

    // ── the ZIP ──────────────────────────────────────────────────────────────

    private static List<ZipWriter.Entry> entries(Object given) {
        List<ZipWriter.Entry> out = new ArrayList<>();
        for (Object e : list(given)) {
            out.add(new ZipWriter.Entry((String) map(e).get("path"), Hex.decode((String) map(e).get("hex"))));
        }
        return out;
    }

    @Test
    void aStoredArchiveIsTheReferencesByteForByte() {
        List<String> failures = new ArrayList<>();
        Map<String, Object> zip = map(V.get("zip"));
        for (Object each : list(zip.get("crc32"))) {
            CRC32 sum = new CRC32();
            sum.update(Hex.decode((String) map(each).get("hex")));
            if (sum.getValue() != ((Number) map(each).get("crc32")).longValue()) {
                failures.add("crc32 of " + map(each).get("hex"));
            }
        }
        int archives = 0;
        for (Object each : list(zip.get("stored"))) {
            Map<String, Object> c = map(each);
            archives++;
            byte[] bytes = ZipWriter.write(entries(c.get("entries")), ((Number) c.get("modifiedAt")).longValue(), false);
            if (bytes.length != ((Number) c.get("bytes")).intValue() || !sha256(bytes).equals(c.get("sha256"))) {
                failures.add(c.get("name") + ": " + bytes.length + " bytes " + Hex.encode(bytes).substring(0, Math.min(400, bytes.length * 2)) + (c.get("hex") != null ? "\n      there " + c.get("hex") : ""));
            }
        }
        for (Object each : list(zip.get("refused"))) {
            Map<String, Object> c = map(each);
            String said = null;
            try {
                ZipWriter.write(entries(c.get("entries")), ((Number) c.get("modifiedAt")).longValue(), false);
            } catch (PlainError e) {
                said = e.getMessage();
            }
            if (c.get("message") == null ? said != null : !c.get("message").equals(said)) {
                failures.add(c.get("name") + ": \"" + c.get("message") + "\" there, \"" + said + "\" here");
            }
        }
        none(failures, "archives");
        assertTrue(archives >= 10, "fewer stored archives than there were: " + archives);
    }

    /** Compressed, the stream is this runtime's; everything around it is the reference's, and it unpacks to what went in. */
    @Test
    void aCompressedArchiveUnpacksToWhatWentIn() throws Exception {
        for (Object each : list(map(V.get("zip")).get("deflated"))) {
            Map<String, Object> c = map(each);
            List<ZipWriter.Entry> entries = entries(c.get("entries"));
            long at = ((Number) c.get("modifiedAt")).longValue();
            byte[] zip = ZipWriter.write(entries, at, true);
            assertEquals(Hex.encode(zip), Hex.encode(ZipWriter.write(entries, at, true)), c.get("name") + ": the same archive twice");
            List<Object> methods = new ArrayList<>();
            int off = 0;
            for (Object e : list(c.get("entries"))) {
                assertEquals(0x04034b50L, u32(zip, off), c.get("name") + ": a local header where one belongs");
                int method = u16(zip, off + 8);
                int packed = (int) u32(zip, off + 18);
                int size = (int) u32(zip, off + 22);
                int nameLength = u16(zip, off + 26);
                byte[] data = Arrays.copyOfRange(zip, off + 30 + nameLength, off + 30 + nameLength + packed);
                assertEquals(map(e).get("hex"), Hex.encode(method == 8 ? inflate(data, size) : data), c.get("name") + ": " + map(e).get("path"));
                assertTrue(method == 0 || packed < size, c.get("name") + ": a member is compressed only when that makes it smaller");
                methods.add((double) method);
                off += 30 + nameLength + packed;
            }
            assertEquals(Js.stringify(c.get("methods")), Js.stringify(methods), c.get("name") + ": which members are compressed");
            // The stored form of the same members differs from this one in the compressed members only.
            ByteArrayOutputStream names = new ByteArrayOutputStream();
            try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
                for (ZipEntry e = in.getNextEntry(); e != null; e = in.getNextEntry()) {
                    names.write((e.getName() + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
            StringBuilder expected = new StringBuilder();
            for (Object e : list(c.get("entries"))) {
                expected.append(map(e).get("path")).append('\n');
            }
            assertEquals(expected.toString(), names.toString(StandardCharsets.UTF_8), c.get("name") + ": the names java.util.zip reads");
        }
    }

    // ── the PDF ──────────────────────────────────────────────────────────────

    @Test
    void textIsReducedToLatin1AsTheReferenceReducesIt() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Object each : list(map(V.get("pdf")).get("latin1"))) {
            Map<String, Object> c = map(each);
            ran++;
            String actual;
            try {
                actual = Pdf.toLatin1(Js.parse((String) c.get("value")));
            } catch (JsValues.EngineError e) {
                actual = null;
            }
            String expected = c.containsKey("text") ? Vectors.text(c.get("text")) : null;
            if (expected == null ? actual != null : !expected.equals(actual)) {
                failures.add(c.get("value") + ": " + (expected == null ? "the engine gave up" : Vectors.show(expected)) + " there, " + (actual == null ? "gave up" : Vectors.show(actual)) + " here");
            }
        }
        none(failures, "texts");
        assertTrue(ran >= 20, "fewer texts than there were: " + ran);
    }

    private static double number(Map<String, Object> run, String name, double otherwise) {
        return run.containsKey(name) ? ((Number) run.get(name)).doubleValue() : otherwise;
    }

    @Test
    void aDocumentIsTheReferencesByteForByte() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Object each : list(map(V.get("pdf")).get("documents"))) {
            Map<String, Object> c = map(each);
            ran++;
            List<Pdf.Run> runs = new ArrayList<>();
            for (Object r : list(c.get("runs"))) {
                Map<String, Object> run = map(r);
                runs.add(new Pdf.Run(run.get("text"), run.containsKey("font") ? (String) run.get("font") : Pdf.HELVETICA, number(run, "size", 10), number(run, "spaceBefore", 0),
                        Boolean.TRUE.equals(run.get("rule")), number(run, "indent", 0)));
            }
            byte[] pdf = Pdf.render(runs, (String) c.get("title"), ((Number) c.get("createdAt")).longValue(), (String) c.get("footer"));
            if (pdf.length != ((Number) c.get("bytes")).intValue() || !sha256(pdf).equals(c.get("sha256"))) {
                String here = new String(pdf, StandardCharsets.ISO_8859_1);
                failures.add(c.get("name") + ": " + pdf.length + " bytes here, " + c.get("bytes") + " there"
                        + (c.get("latin1") != null ? "\n" + firstDifference((String) c.get("latin1"), here) : ""));
            }
        }
        none(failures, "documents");
        assertTrue(ran >= 15, "fewer documents than there were: " + ran);
    }

    // ── what a header can hold ───────────────────────────────────────────────

    @Test
    void aHeaderValueIsValidWhenTheReferencesServerWouldWriteIt() {
        for (Object each : list(V.get("headers"))) {
            String value = Vectors.text(map(each).get("value"));
            assertEquals(map(each).get("valid"), Router.validHeaderValue(value), Vectors.show(value));
        }
    }
}
