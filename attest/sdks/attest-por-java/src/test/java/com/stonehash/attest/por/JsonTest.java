package com.stonehash.attest.por;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/** The JSON reader and the three writers. */
final class JsonTest {
    private JsonTest() {
    }

    static void testCanonicalSortsKeysByUtf16CodeUnitNotByCodePoint() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("\ue000", 1L);            // private use, one unit E000
        m.put("\ud83d\ude00", 2L);      // an emoji: units D83D DE00, which sort before E000
        m.put("a", 3L);
        Check.equal("{\"a\":3,\"\ud83d\ude00\":2,\"\ue000\":1}", Json.canonical(m), "an astral key sorts before U+E000");
    }

    static void testCanonicalRefusesWhatTheSpecificationForbids() {
        Check.refuses("not_canonical", () -> Json.canonical(new BigDecimal("1.5")));
        Check.refuses("not_canonical", () -> Json.canonical(Json.MAX_SAFE_INTEGER + 1));
        Check.refuses("not_canonical", () -> Json.canonical(-Json.MAX_SAFE_INTEGER - 1));
        Check.refuses("not_canonical", () -> Json.canonical(1.0d));
        // An amount held as a number is the mistake the string rule exists to prevent.
        Check.refuses("not_canonical", () -> Json.canonical(BigInteger.TEN));
        Check.refuses("not_canonical", () -> Json.canonical("unpaired \ud800 surrogate"));
        Check.equal("9007199254740991", Json.canonical(Json.MAX_SAFE_INTEGER), "the largest integer allowed");
        Check.equal("[7,-7]", Json.canonical(Arrays.asList(7, -7L)), "an Integer is as good as a Long");
    }

    static void testCanonicalEscapesExactlyWhatTheSpecificationLists() {
        Check.equal("\"\\\"\\\\\\b\\t\\n\\f\\r\\u0000\\u001f/\u007f\u2028\u2029\u00e9\"",
                Json.canonical("\"\\\b\t\n\f\r\u0000\u001f/\u007f\u2028\u2029\u00e9"), "escapes");
    }

    static void testNumbersAreReadWithoutRoundingAndOnlyPlainIntegersAreLongs() {
        Check.equal(0L, Json.parse("-0", "t"), "minus zero is zero");
        Check.equal(Json.MAX_SAFE_INTEGER, Json.parse("9007199254740991", "t"), "2^53 - 1 is a Long");
        Check.equal(new BigDecimal("9007199254740992"), Json.parse("9007199254740992", "t"), "2^53 is kept exactly, as a BigDecimal");
        Check.equal(new BigDecimal("1.0"), Json.parse("1.0", "t"), "a fraction part makes it not a plain integer");
        Check.equal(new BigDecimal("1e2"), Json.parse("1e2", "t"), "so does an exponent");
        Check.equal(new BigDecimal("0.1"), Json.parse("0.1", "t"), "0.1 stays 0.1");
        // The specification makes these an error in canonical JSON; the reference, which
        // reads numbers as doubles, cannot tell 1.0 from 1 and lets it through.
        Check.refuses("not_canonical", () -> Json.canonical(Json.parse("{\"decimals\":8.0}", "t")));
        Check.refuses("not_canonical", () -> Json.canonical(Json.parse("{\"n\":1e2}", "t")));
        for (String bad : new String[] { "01", "+1", "1.", ".5", "1e", "-", "0x10", "NaN", "Infinity" }) {
            Check.refuses("t", () -> Json.parse(bad, "t"));
        }
    }

    static void testMalformedDocumentsAreRefused() {
        for (String bad : new String[] { "", "{", "[1,]", "{\"a\":1,}", "{a:1}", "{\"a\" 1}", "\"abc", "\"\\x\"", "\"\\u12g4\"",
                "tru", "nul", "[1] 2", "\"line\nbreak\"", "\ufeff{}" }) {
            Check.refuses("t", () -> Json.parse(bad, "t"));
        }
        // Two members under one key: readers disagree on which counts, so it is not a document to sign.
        PorException e = Check.refuses("t", () -> Json.parse("{\"root\":\"a\",\"root\":\"b\"}", "t"));
        Check.isTrue(e.getMessage().contains("twice"), "the message says why: " + e.getMessage());
        Check.refuses("t", () -> Json.parse("[".repeat(200) + "]".repeat(200), "t"));
        Check.refuses("t", () -> Json.parse(new byte[] { '"', (byte) 0xb0, (byte) 0xa1, '"' }, "t", "bytes"));
    }

    static void testStringsEscapesAndSurrogatePairs() {
        Check.equal("a\"b\\c/d\b\f\n\r\t\u00e9\ud83d\ude00", Json.parse("\"a\\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00\"", "t"),
                "every escape");
        Check.equal("{\"k\":[true,false,null,{}]}", Json.compact(Json.parse(" { \"k\" : [ true , false , null , { } ] } ", "t")),
                "whitespace between tokens");
    }

    static void testFilesAreWrittenAsJavaScriptWritesThem() {
        // Insertion order BTC, 42, 1INCH, 7, 007, 4294967294, 4294967295, 0, -1. JavaScript lists the keys that are
        // array indices first, in numeric order; the expected text is what node prints for this object.
        Map<String, Object> m = new LinkedHashMap<>();
        String[] keys = { "BTC", "42", "1INCH", "7", "007", "4294967294", "4294967295", "0", "-1" };
        for (int i = 0; i < keys.length; i++) {
            m.put(keys[i], String.valueOf(i + 1));
        }
        Check.equal("{\"0\":\"8\",\"7\":\"4\",\"42\":\"2\",\"4294967294\":\"6\",\"BTC\":\"1\",\"1INCH\":\"3\",\"007\":\"5\","
                + "\"4294967295\":\"7\",\"-1\":\"9\"}", Json.compact(m), "JSON.stringify key order");

        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("a", Arrays.asList());
        nested.put("b", new LinkedHashMap<>());
        nested.put("c", Arrays.asList(new LinkedHashMap<>()));
        nested.put("n", 12L);
        Check.equal("{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    {}\n  ],\n  \"n\": 12\n}", Json.pretty(nested),
                "JSON.stringify(value, null, 2)");
        Check.equal("\"\\ud800 x \u2028 \u007f \\u0000 / \u00e9 \ud83d\ude00\"", Json.compact("\ud800 x \u2028 \u007f \u0000 / \u00e9 \ud83d\ude00"),
                "an unpaired surrogate is escaped in a file; everything else is as in canonical text");
        Check.refuses("invalid_json", () -> Json.compact(BigInteger.ONE));
    }

    static void testCanonicalJsonIsPublicUnderItsOwnName() {
        Map<String, Object> totals = new LinkedHashMap<>();
        totals.put("USDT", "1500250000");
        totals.put("BTC", "50000000");
        Check.equal("{\"BTC\":\"50000000\",\"USDT\":\"1500250000\"}", CanonicalJson.of(totals), "CanonicalJson.of");
    }
}
