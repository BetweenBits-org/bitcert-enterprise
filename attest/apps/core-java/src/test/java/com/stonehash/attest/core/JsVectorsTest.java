package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@link Js} and {@link IsoTime} held to JavaScript itself: every answer in
 * {@code vectors/js-json.json} was given by Node.
 */
class JsVectorsTest {
    private static final Map<String, Object> V = Vectors.load("js-json.json");

    private static void none(List<String> failures, String what, int ran, int atLeast) {
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " " + what + " differ from Node:\n  "
                + String.join("\n  ", failures.subList(0, Math.min(20, failures.size()))));
        assertTrue(ran >= atLeast, "the vectors were read: " + ran + " " + what);
    }

    @Test
    void parsesAndWritesJsonAsJavaScriptDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "parse")) {
            ran++;
            String text = Vectors.text(c.get("text"));
            Object value;
            try {
                value = Js.parse(text);
            } catch (Js.SyntaxException e) {
                if (Boolean.TRUE.equals(c.get("ok"))) {
                    failures.add(Vectors.show(text) + ": refused (" + e.getMessage() + "), JavaScript reads it");
                }
                continue;
            }
            if (!Boolean.TRUE.equals(c.get("ok"))) {
                failures.add(Vectors.show(text) + ": read, JavaScript refuses it");
                continue;
            }
            String compact = Js.stringify(value);
            if (!Vectors.text(c.get("compact")).equals(compact)) {
                failures.add(Vectors.show(text) + ": written " + compact + ", expected " + Vectors.text(c.get("compact")));
            }
            String pretty = Js.stringify(value, 2);
            if (!Vectors.text(c.get("pretty")).equals(pretty)) {
                failures.add(Vectors.show(text) + ": with two spaces written\n" + pretty + "\nexpected\n" + Vectors.text(c.get("pretty")));
            }
        }
        none(failures, "texts", ran, 130);
    }

    @Test
    void printsANumberAsJavaScriptDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "numbers")) {
            ran++;
            double d = Double.longBitsToDouble(Long.parseUnsignedLong((String) c.get("bits"), 16));
            String got = Js.numberToString(d);
            if (!got.equals(c.get("text"))) {
                failures.add(c.get("bits") + ": " + got + ", expected " + c.get("text"));
            }
        }
        none(failures, "numbers", ran, 20_000);
    }

    @Test
    void readsANumberOutOfTextAsJavaScriptDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "toNumber")) {
            ran++;
            String text = Vectors.text(c.get("text"));
            double d = Js.toNumber(text);
            String bits = Double.isNaN(d) ? "7ff8000000000000" : String.format("%016x", Double.doubleToRawLongBits(d));
            if (!bits.equals(c.get("bits"))) {
                failures.add(Vectors.show(text) + ": " + d + " (" + bits + "), expected bits " + c.get("bits"));
            }
        }
        none(failures, "texts read as numbers", ran, 90);
    }

    @Test
    void trimsAndOrdersKeysAsJavaScriptDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "trim")) {
            ran++;
            String text = Vectors.text(c.get("text"));
            if (!Js.trim(text).equals(Vectors.text(c.get("trimmed")))) {
                failures.add("trim " + Vectors.show(text) + ": " + Vectors.show(Js.trim(text)));
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "arrayIndex")) {
            ran++;
            String key = Vectors.text(c.get("key"));
            if (Js.isArrayIndex(key) != Boolean.TRUE.equals(c.get("index"))) {
                failures.add("array index " + Vectors.show(key) + ": " + Js.isArrayIndex(key));
            }
        }
        none(failures, "trims and keys", ran, 30);
    }

    @Test
    void writesATimeAsToISOStringDoes() {
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "times")) {
            ran++;
            long ms = ((Double) c.get("ms")).longValue();
            assertEquals(c.get("text"), IsoTime.ofEpochMilli(ms), "epoch millisecond " + ms);
        }
        assertTrue(ran >= 15);
        String now = IsoTime.now();
        assertTrue(now.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"), now);
    }

    @Test
    void aValueThatIsNotThereIsLeftOutOfAnObjectAndNullInAList() {
        Map<String, Object> o = new java.util.LinkedHashMap<>();
        o.put("a", 1);
        o.put("gone", Js.UNDEFINED);
        o.put("list", java.util.Arrays.asList(1L, Js.UNDEFINED, null, 2.5, "x"));
        o.put("none", null);
        assertEquals("{\"a\":1,\"list\":[1,null,null,2.5,\"x\"],\"none\":null}", Js.stringify(o));
        assertEquals(null, Js.stringify(Js.UNDEFINED));
        assertEquals("{}", Js.stringify(java.util.Map.of("gone", Js.UNDEFINED), 2));
    }

    @Test
    void refusesWhatIsNestedBeyondTheLimit() {
        String deep = "[".repeat(Js.MAX_DEPTH + 1) + "]".repeat(Js.MAX_DEPTH + 1);
        org.junit.jupiter.api.Assertions.assertThrows(Js.SyntaxException.class, () -> Js.parse(deep));
        String ok = "[".repeat(Js.MAX_DEPTH) + "]".repeat(Js.MAX_DEPTH);
        assertEquals(ok, Js.stringify(Js.parse(ok)));
    }
}
