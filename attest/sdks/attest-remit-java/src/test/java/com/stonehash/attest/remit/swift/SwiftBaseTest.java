package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/** What is decided before any reader is asked: the shared field checks, and how bytes become text. */
final class SwiftBaseTest {
    private SwiftBaseTest() {
    }

    static void testAmountsAreNormalisedOrRefused() {
        Check.equal("1000.5", SwiftText.normaliseAmount("1000,5", "32A", true), "a comma is the decimal mark of an MT amount");
        Check.equal("6150", SwiftText.normaliseAmount("6150,", "32A", true), "a trailing comma means no decimals");
        Check.equal("0.50", SwiftText.normaliseAmount(" 000.50 ", "InstdAmt", false), "leading zeros go, the last one stays");
        Check.equal("12500.00", SwiftText.normaliseAmount("12500.00", "InstdAmt", false), "decimals are kept as written");
        Check.equal("12.5", SwiftText.normaliseAmount("12.5\n", "InstdAmt", false), "whitespace around an amount is not part of it");
        for (String bad : Arrays.asList("", "1,2,3", "-5", "1e3", "12.345678", "1234567890123456")) {
            SwiftMessageException e = (SwiftMessageException) Check.refuses("invalid_field", () -> SwiftText.normaliseAmount(bad, "32A", true));
            Check.equal("32A", e.field(), "the field at fault");
        }
        // An ISO 20022 amount is an xs:decimal: a comma is no part of it, whichever side of it the digits stand.
        for (String bad : Arrays.asList("12,500", "12500,00", "1,5")) {
            SwiftMessageException e = (SwiftMessageException) Check.refuses("invalid_field", () -> SwiftText.normaliseAmount(bad, "InstdAmt", false));
            Check.equal("InstdAmt: \"" + bad + "\" is not an amount", e.getMessage(), "the words");
        }
    }

    static void testReferencesAndCodes() {
        Check.equal("3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10", SwiftText.uetrOf(" 3F1C9A52-7B0E-4D6A-9C1F-2E8B5A7D4C10 ", "PmtId/UETR"), "a UETR is lower-cased");
        Check.equal(null, SwiftText.uetrOf("  ", "PmtId/UETR"), "stating none is not an error");
        Check.equal(null, SwiftText.uetrOf(null, "PmtId/UETR"), "nor is its absence");
        Check.refuses("invalid_field", () -> SwiftText.uetrOf("3f1c9a52-7b0e-4d6a-9c1f", "PmtId/UETR"));
        Check.equal("SG", SwiftText.bicCountry("demosgsg"), "the country letters of a BIC");
        Check.equal("VN", SwiftText.bicCountry("DEMOVNVXAXX"), "an eleven-character BIC");
        Check.equal(null, SwiftText.bicCountry("DEMOSG"), "not a BIC");
        Check.isTrue(SwiftText.isLei("5493001KJTIIGC8Y1R12"), "an LEI");
        Check.isTrue(!SwiftText.isLei("0312345678"), "a registration number is not an LEI");
        Check.equal("USD", SwiftText.assertCurrency("USD", "32A"), "a currency code");
        Check.refuses("invalid_field", () -> SwiftText.assertCurrency("usd", "32A"));
    }

    static void testTextOperationsMeanWhatTheyMeanInTheReference() {
        Check.equal(Arrays.asList("a", "", "b", ""), Js.split("a,,b,", ","), "a split keeps the empty pieces, the last one too");
        Check.equal("cd", Js.slice("abcd", -2), "a negative start counts from the end");
        Check.equal("", Js.slice("abcd", 3, 1), "an empty range is empty, not an error");
        Check.equal("x", Js.trim("﻿  x "), "trim takes the reference's whitespace, the byte-order mark included");
        Check.equal("a b", Js.collapse("a  \n b"), "runs of whitespace become one space");
        Check.equal("007", Js.padStart("7", 3, '0'), "padding");
    }

    /** The cases a reader never sees: nothing to read, too much to read, bytes that are not what they claim. */
    static void testInputsRefusedBeforeAnyReader() {
        List<String> names = Arrays.asList("other/empty", "other/whitespace", "other/plain-text", "other/json", "other/too-large",
                "xml/utf16-cut-off", "xml/latin1-undeclared", "xml/unknown-encoding",
                // A string is held to the bound by its UTF-8 bytes (P2) …
                "other/text-under-the-bound-in-units", "xml/over-the-bound-in-utf8-bytes-as-text", "xml/over-the-bound-in-utf8-bytes-as-bytes",
                // … XML is never read in a guessed code page (P1) …
                "xml/latin1-bytes-after-a-no-break-space", "xml/latin1-bytes-after-space-no-break-space-line-feed", "xml/utf8-bytes-after-a-no-break-space",
                // … and a declared label is matched whole, or refused (P3).
                "xml/declared-utf-space-8-not-known", "xml/declared-empty-label-not-known", "xml/declared-US-ASCII-byte-e9");
        Golden.none(Golden.parseFailures(names::contains), "inputs refused before any reader");
    }

    /** What a probe of {@link Iso20022Answers} records: the payments, or the error with its code, field and words. */
    private static Map<String, Object> answerOf(Supplier<List<SwiftPayment>> parse) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            List<Object> payments = new ArrayList<>();
            for (SwiftPayment p : parse.get()) {
                payments.add(p.toJson());
            }
            out.put("payments", payments);
        } catch (SwiftMessageException e) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("name", "SwiftMessageError");
            err.put("code", e.code());
            if (e.field() != null) {
                err.put("field", e.field());
            }
            err.put("message", e.getMessage());
            out.clear();
            out.put("error", err);
        }
        return out;
    }

    /**
     * Bytes become text as the reference makes them (P1, P3): every probe of
     * {@link Iso20022Answers#BYTES} — the declaration's label taken whole and
     * matched by the reader's own table, the single-byte code pages decoded by
     * its own rules, and XML behind a character that hid it never read in a
     * guessed code page.
     */
    static void testBytesBecomeTextAsTheReferenceMakesThem() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.BYTES) {
            byte[] bytes = Base64.getDecoder().decode(row[1]);
            String d = Golden.difference(Json.parse(row[2]), answerOf(() -> Swift.parseAll(bytes)));
            if (d != null) {
                failures.add(row[0] + ": " + d);
            }
        }
        Golden.none(failures, "byte probes");
    }

    /**
     * A string is measured in the UTF-8 bytes it is hashed as (P2): every probe
     * of {@link Iso20022Answers#REPEATED} — a half surrogate counts three
     * bytes, as the reference's encoder writes it, a pair four.
     */
    static void testAStringIsBoundByItsUtf8Bytes() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.REPEATED) {
            StringBuilder text = new StringBuilder(row[1]);
            for (int i = Integer.parseInt(row[3]); i > 0; i--) {
                text.append(row[2]);
            }
            String message = text.toString();
            String d = Golden.difference(Json.parse(row[4]), answerOf(() -> Swift.parseAll(message)));
            if (d != null) {
                failures.add(row[0] + ": " + d);
            }
        }
        Golden.none(failures, "string-length probes");
    }
}
