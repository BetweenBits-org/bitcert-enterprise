package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Views nobody would send on purpose: any JSON at all as a settlement view.
 *
 * <p>{@code golden/status-views.json} holds what the TypeScript SDK answers
 * for the views its own hardening test puts to it — values of the wrong kind
 * in every place, half surrogate pairs, times in every wrong form, sequence
 * numbers that are no numbers — and for the views that test generates from a
 * fixed seed. Each is put to this port: the status, the reference to the
 * bank's message and the report have to be the same, and none of them may
 * end in an exception.
 */
final class StatusHostileTest {
    private StatusHostileTest() {
    }

    private static final Pattern CREATED = Pattern.compile("<CreDtTm>([^<]*)</CreDtTm>");
    /** Half of a surrogate pair: a high one without its low one, or a low one without its high one. */
    private static final Pattern HALF = Pattern.compile("[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]");
    private static final Pattern EMPTY_ELEMENT = Pattern.compile("<(\\w+)></\\1>");
    private static final Pattern FORBIDDEN = Pattern.compile("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uFFFE\\uFFFF]");

    static void testAnyJsonGivesTheStatusAndTheReportTheReferenceGives() throws Exception {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int now = 0;
        int withSource = 0;
        Set<String> codes = new HashSet<>();
        for (Map<String, Object> c : Golden.cases("status-views.json")) {
            ran++;
            String name = (String) c.get("name");
            Object view = c.get("view");
            Map<String, Object> options = Golden.map(c.get("options"));
            Map<String, Object> expect = Golden.map(c.get("expect"));
            try {
                SwiftStatus status = StatusReport.statusOf(view);
                String d = Golden.difference(expect.get("status"), status.toJson());
                if (d != null) {
                    failures.add(name + " (status): " + d);
                }
                codes.add(status.code());
                Map<String, Object> source = StatusReport.sourceMessageOf(view);
                d = Golden.difference(expect.get("sourceMessage"), source);
                if (d != null) {
                    failures.add(name + " (sourceMessage): " + d);
                }
                withSource += source == null ? 0 : 1;
                // The Java API takes the two options as text; a value of another kind is one that was not given.
                String messageId = options.get("messageId") instanceof String ? (String) options.get("messageId") : null;
                String createdAt = options.get("createdAt") instanceof String ? (String) options.get("createdAt") : null;
                String report = StatusReport.buildPacs002(view, messageId, createdAt);
                String expected = (String) expect.get("pacs002");
                if (expected.contains("<CreDtTm><now></CreDtTm>")) {
                    // The creation time given was not one: the report says when it was made.
                    now++;
                    Matcher m = CREATED.matcher(report);
                    String created = m.find() ? m.group(1) : null;
                    if (created == null || StatusReport.isoTime(created) == null
                            || Duration.between(Instant.parse(created), Instant.now()).abs().getSeconds() > 60) {
                        failures.add(name + " (pacs002): the creation time is not now — " + created);
                    }
                    report = CREATED.matcher(report).replaceFirst("<CreDtTm><now></CreDtTm>");
                }
                d = StatusGoldenTest.textDifference(expected, report);
                if (d != null) {
                    failures.add(name + " (pacs002): " + d);
                }
                if (HALF.matcher(report).find() || EMPTY_ELEMENT.matcher(report).find() || FORBIDDEN.matcher(report).find()) {
                    failures.add(name + " (pacs002): half a surrogate pair, an empty element or a character XML forbids");
                }
            } catch (RuntimeException e) {
                failures.add(name + ": " + e + " — any view gives a status and a report, and none ends in an exception");
            }
        }
        Golden.none(failures, "status-views.json");
        Check.isTrue(ran >= 450 && now >= 50 && withSource >= 150, "the vectors were read: " + ran + " views, " + now + " reports stating now, "
                + withSource + " with a reference to the bank's message");
        Check.equal(new HashSet<>(java.util.Arrays.asList("ACTC", "ACSP", "ACCC", "PDNG", "RJCT")), codes, "every code was given");
    }

    /** The public entry points take a view as a JSON object; one that is not there at all still gives an answer. */
    static void testAViewThatIsNotThereIsAnUnknownStateNotAnException() {
        SwiftStatus none = Swift.statusOf(null);
        Check.equal("PDNG/UNKNOWN/UNKNOWN", none.code() + "/" + none.state() + "/" + none.reason(), "no view: a state the table does not know");
        Check.equal(null, Swift.sourceMessageOf(null), "and no reference");
        String report = Swift.buildPacs002(null, null, "2026-11-17T00:00:00.000Z");
        Check.isTrue(report.contains("<MsgId>STATUS-0</MsgId>") && report.contains("<TxSts>PDNG</TxSts>") && !report.contains("<StsId>"),
                "and a report that names no payment:\n" + report);
        Check.equal("{\"code\":\"PDNG\",\"meaning\":\"Pending — further checks or information are outstanding\",\"state\":\"UNKNOWN\","
                + "\"reason\":\"UNKNOWN\",\"detail\":[],\"final\":false}", Json.compact(none.toJson()), "as JSON");
    }

    /** A question of half a million characters is cut in one pass over it, not one pass per line. */
    static void testLongTextIsCutInOnePassAndNeverThroughAPair() {
        StringBuilder smiles = new StringBuilder();
        for (int i = 0; i < 500_000; i++) {
            smiles.appendCodePoint(0x1F600);
        }
        StringBuilder words = new StringBuilder();
        for (int i = 0; i < 100_000; i++) {
            words.append("word ");
        }
        Map<String, Object> view = StatusTest.obj("payment_id", "PAY-1", "state", "TRAVEL_RULE_PENDING", "events", java.util.Arrays.asList(
                StatusTest.obj("seq", 0, "type", "REQUEST_ACCEPTED", "at", "2026-11-17T00:00:00.000Z", "payload", StatusTest.obj()),
                StatusTest.obj("seq", 1, "type", "TRAVEL_RULE_RFI", "at", "2026-11-17T00:00:01.000Z",
                        "payload", StatusTest.obj("questions", java.util.Arrays.asList(smiles.toString(), words.toString())))));
        long started = System.nanoTime();
        String report = Swift.buildPacs002(view, null, "2026-11-17T00:00:00.000Z");
        long ms = (System.nanoTime() - started) / 1_000_000;
        Check.isTrue(ms < 8_000, "two long questions took " + ms + " ms");
        Check.isTrue(!HALF.matcher(report).find(), "no half of a pair");
        int lines = 0;
        Matcher m = Pattern.compile("<AddtlInf>([^<]*)</AddtlInf>").matcher(report);
        while (m.find()) {
            int length = m.group(1).codePointCount(0, m.group(1).length());
            Check.isTrue(length >= 1 && length <= 105, "AddtlInf is Max105Text, counted by character: " + length);
            lines++;
        }
        Check.isTrue(lines > 9_000, lines + " lines");
    }
}
