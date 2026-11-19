package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code status.json}: for each settlement view, the status, the reference to
 * the bank's message and the {@code pacs.002} the TypeScript SDK makes of it —
 * the report compared as text, character for character — and the published
 * status table.
 */
final class StatusGoldenTest {
    private StatusGoldenTest() {
    }

    static void testEveryStatusCaseAnswersAsTheReference() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Golden.cases("status.json")) {
            ran++;
            String name = (String) c.get("name");
            Map<String, Object> view = Golden.map(c.get("view"));
            Map<String, Object> options = Golden.map(c.get("options"));
            Map<String, Object> expect = Golden.map(c.get("expect"));
            try {
                String d = Golden.difference(expect.get("status"), Swift.statusOf(view).toJson());
                if (d != null) {
                    failures.add(name + " (status): " + d);
                }
                d = Golden.difference(expect.get("sourceMessage"), Swift.sourceMessageOf(view));
                if (d != null) {
                    failures.add(name + " (sourceMessage): " + d);
                }
                String report = Swift.buildPacs002(view, (String) options.get("messageId"), (String) options.get("createdAt"));
                d = textDifference((String) expect.get("pacs002"), report);
                if (d != null) {
                    failures.add(name + " (pacs002): " + d);
                }
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
            }
        }
        if (ran == 0) {
            failures.add("status.json holds no case");
        }
        Golden.none(failures, "status.json");
    }

    static void testTheStatusTableIsTheReferenceTable() {
        String d = Golden.difference(Golden.file("status.json").get("table"), Swift.statusTable());
        if (d != null) {
            throw new AssertionError("the status table differs from the reference's: " + d);
        }
    }

    /** The first line where two texts differ, or null when they are the same text. */
    static String textDifference(String expected, String actual) {
        if (expected.equals(actual)) {
            return null;
        }
        List<String> e = Js.split(expected, "\n");
        List<String> a = Js.split(actual, "\n");
        for (int i = 0; i < Math.min(e.size(), a.size()); i++) {
            if (!e.get(i).equals(a.get(i))) {
                return "line " + (i + 1) + ": expected " + Json.compact(e.get(i))
                        + ", got " + Json.compact(a.get(i));
            }
        }
        return "expected " + e.size() + " lines, got " + a.size();
    }
}
