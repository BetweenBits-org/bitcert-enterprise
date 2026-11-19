package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Hex;
import com.stonehash.attest.remit.Json;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * The MT103 reader on inputs too large to keep as literals, and its entry
 * point. Every expected value here is what the TypeScript SDK answered for the
 * same input (probe/large-inputs.ts, probe/bytes.ts).
 */
final class Mt103ReaderTest {
    private Mt103ReaderTest() {
    }

    private static final String MESSAGE = "{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n"
            + ":20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n-}";
    private static final String BARE = ":20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n";

    private static final String AFTER_END = "there is text after the end-of-text marker (\"-}\") — a file of several messages needs each one's "
            + "header blocks ({1:…}{2:…}), so that it is clear where one ends and what each is";

    static void testWhatLooksLikeAFinMessage() {
        List<String> yes = Arrays.asList("{1:", " \n{1:", "﻿{1:", "﻿﻿ :20:", ":20:", "{4:\n:20:", "{4: \t\r\n :20:", "{4::20:",
                " {4:\n\n:20:", "　 {1:");
        List<String> no = Arrays.asList("{2:", ":21:", "{4:\n:21:", "\u0085:20:", "​{1:", "x{1:", "{5:");
        for (String t : yes) {
            Check.isTrue(Mt103Reader.looksLikeMt(t), "looks like a FIN message: " + Json.compact(t));
        }
        for (String t : no) {
            Check.isTrue(!Mt103Reader.looksLikeMt(t), "does not look like a FIN message: " + Json.compact(t));
        }
    }

    /**
     * Megabytes of whitespace, of trailer blocks, of "$" after the end. The
     * reference reads all of them; a regular expression in Java would overflow
     * the stack on the first few thousand.
     */
    static void testMegabytesOfPaddingAfterTheEnd() {
        one(MESSAGE + " ".repeat(4_000_000), "R");
        one(MESSAGE + "\r\n".repeat(2_000_000), "R");
        one(MESSAGE + "{5:" + "x".repeat(4_000_000) + "}", "R");
        one(MESSAGE + "{5:{CHK:1}}".repeat(300_000), "R");
        one(BARE + "-}" + " ".repeat(4_000_000) + "{5:{CHK:1}}", "REF1");
        one(BARE + "-}" + " $".repeat(2_000_000), "REF1");
        one(BARE + "-}{S:" + "{A:1}".repeat(500_000) + "}", "REF1");
        refused(MESSAGE + "{5:" + "x".repeat(1_000_000) + "}" + "tail", "malformed_message", "block 4",
                "after message 1 there is text that is not another message: \"tail\" — a message starts with {1:");
        refused(BARE + "-}{5:" + "x".repeat(1_000_000) + "}tail", "malformed_message", "block 4", AFTER_END);
    }

    static void testThousandsOfMessagesInOneFile() {
        List<String> distinct = new ArrayList<>();
        for (int i = 0; i < 3000; i++) {
            distinct.add(MESSAGE.replace(":20:R\n", ":20:R" + i + "\n"));
        }
        long t0 = System.nanoTime();
        List<SwiftPayment> all = Swift.parseAll(String.join("$\r\n", distinct));
        long ms = (System.nanoTime() - t0) / 1_000_000;
        Check.equal(3000, all.size(), "every message of the file");
        Check.equal("R0", all.get(0).instructionId(), "the first");
        SwiftPayment last = all.get(2999);
        Check.equal(Arrays.asList(2999, 3000, "R2999", true), Arrays.asList(last.index(), last.transactionCount(), last.instructionId(), last.distinctIds()),
                "the last: index, count, reference, and its identifiers tell it apart");
        Check.isTrue(ms < 4000, "3,000 messages took " + ms + " ms");

        List<SwiftPayment> same = Swift.parseAll(MESSAGE.repeat(3000));
        Check.equal(Arrays.asList(3000, false), Arrays.asList(same.size(), same.get(2999).distinctIds()), "the same identifiers 3,000 times");

        refused(MESSAGE.repeat(2999) + MESSAGE.replace(":71A:SHA", ":71A:XYZ"), "invalid_field", "71A",
                "message 3000 of 3000: field 71A: \"XYZ\" is not OUR, SHA or BEN");
    }

    static void testLongFields() {
        // Under the 4 MiB bound, which the reference counts in UTF-8 bytes (five a pair here):
        // 3,000,000 bytes, 1,800,000 UTF-16 units.
        String mixed = "a😀".repeat(600_000);
        SwiftPayment p = one(MESSAGE.replace(":71A:SHA", ":70:/INV/" + mixed + "\n:71A:SHA"), "R");
        Check.equal(Arrays.asList("/INV/" + mixed), p.remittanceInformation(), "a long line of field 70, astral characters in it");
        Check.equal(Arrays.asList(mixed), p.invoiceReferences(), "and the invoice it names");

        String name = "N".repeat(3_000_000);
        Check.equal(name, one(MESSAGE.replace("\nB\n", "\n" + name + "\n"), "R").creditor().name(), "a name of three million characters");

        SwiftPayment lines = one(MESSAGE.replace("\nB\n", "\nB\n" + "ADDRESS LINE\n".repeat(250_000)), "R");
        Check.equal(250_000, lines.creditor().addressLines().size(), "a quarter of a million address lines");

        SwiftPayment fields = one(MESSAGE.replace(":71A:SHA", ":71A:SHA" + "\n:23E:SDVA".repeat(300_000)), "R");
        Check.equal(Arrays.asList("20", "23B", "32A", "50K", "59", "71A", "23E"), fields.present(), "a field that may repeat, 300,000 times");
    }

    /**
     * The checks a field's value now meets, on inputs too large to keep as
     * literals: each runs in one pass, as the reference's do (probe/large-inputs.ts).
     */
    static void testTheFieldChecksOnLargeInputs() {
        long t0 = System.nanoTime();
        // Field 70: 400,000 empty /ROC/ code words, then one that says something.
        SwiftPayment roc = one(MESSAGE.replace(":71A:SHA", ":70:" + "/ROC/".repeat(400_000) + "X\n:71A:SHA"), "R");
        Check.equal(Arrays.asList("X", 2_000_001, 0), Arrays.asList(roc.endToEndId(), roc.remittanceInformation().get(0).length(), roc.invoiceReferences().size()),
                "400,000 empty code words, then the reference");
        SwiftPayment lines = one(MESSAGE.replace(":71A:SHA", ":70:" + "/ROC/\n".repeat(300_000) + "/ROC/X\n:71A:SHA"), "R");
        Check.equal(Arrays.asList("X", 300_001), Arrays.asList(lines.endToEndId(), lines.remittanceInformation().size()), "300,000 lines of an empty code word");
        SwiftPayment slashes = one(MESSAGE.replace(":71A:SHA", ":70:/ROC/" + "/".repeat(2_000_000) + "\n:71A:SHA"), "R");
        Check.equal(Arrays.asList(null, 0), Arrays.asList(slashes.endToEndId(), slashes.invoiceReferences().size()), "a code word followed by two million slashes says nothing");

        // Block 3: field 121 half a million times is refused as twice.
        refused(MESSAGE.replace("{4:", "{3:" + "{121:x}".repeat(500_000) + "}{4:"), "malformed_message", "block 3 field 121",
                "block 3 carries field 121 (the UETR) more than once — a payment has one UETR, and the two could not both be meant");
        // A second line a million blank lines below a one-line field, and a field of a million blank lines.
        refused(MESSAGE.replace(":32A:261117USD5,", ":32A:261117USD5," + "\n".repeat(1_000_000) + "9999"), "malformed_message", "32A",
                "field 32A takes one line, but \"9999\" follows it — a value cut in two, or a field whose tag was lost; correct the message");
        refused(MESSAGE.replace(":71A:SHA", ":70:" + "\n".repeat(1_000_000) + ":71A:SHA"), "invalid_field", "70",
                "field 70 is present but empty — write its value; an empty field is not read as one left out");
        // 59F: half a million empty name lines add nothing.
        SwiftParty creditor = one(MESSAGE.replace(":59:/ACC1\nB\n", ":59F:/ACC1\n" + "1/\n".repeat(500_000) + "1/B\n3/SG\n"), "R").creditor();
        Check.equal(Arrays.asList("B", "SG", "ACC1", 0), Arrays.asList(creditor.name(), creditor.country(), creditor.account(), creditor.addressLines().size()),
                "500,000 empty 1/ lines");
        long ms = (System.nanoTime() - t0) / 1_000_000;
        Check.isTrue(ms < 8000, "the large inputs took " + ms + " ms");
    }

    /** The bytes of the file as the bank's system wrote them: a legacy code page, a byte-order mark. */
    static void testBytesAsTheBanksSystemWroteThem() {
        byte[] sample = null;
        for (Map<String, Object> c : Golden.cases("parse.json")) {
            if ("sample/mt103-free-format".equals(c.get("name"))) {
                sample = (byte[]) Golden.input(c);
            }
        }
        Check.isTrue(sample != null, "the free-format sample is among the golden vectors");
        String text = new String(sample, StandardCharsets.ISO_8859_1);
        List<String> address = Arrays.asList("12 LE LOI BLVD DISTRICT 1", "HÔ CHI MINH CITY");

        // Not UTF-8: read as a single-byte code page, as the reference does.
        byte[] latin = text.replace("HO CHI MINH CITY", "HÔ CHI MINH CITY").getBytes(StandardCharsets.ISO_8859_1);
        SwiftPayment p = Swift.parseAll(latin).get(0);
        Check.equal(address, p.debtor().addressLines(), "a legacy code page still reads");
        Check.equal(Hex.sha256Hex(latin), p.digest(), "the digest is over the bytes as given");
        byte[] utf8 = text.replace("HO CHI MINH CITY", "HÔ CHI MINH CITY").getBytes(StandardCharsets.UTF_8);
        Check.equal(address, Swift.parseAll(utf8).get(0).debtor().addressLines(), "and so does UTF-8");
        byte[] nel = text.replace("HO CHI MINH CITY", "HO CHI MINH CITY\u0085ÿ").getBytes(StandardCharsets.ISO_8859_1);
        Check.equal(Arrays.asList("12 LE LOI BLVD DISTRICT 1", "HO CHI MINH CITY\u0085ÿ"), Swift.parseAll(nel).get(0).debtor().addressLines(),
                "U+0085 at the end of a line is text, not whitespace");

        byte[] bom = concat(new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf}, sample);
        SwiftPayment b = Swift.parseAll(bom).get(0);
        Check.equal(Arrays.asList("OUT2026000125", "b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57", Hex.sha256Hex(bom)), Arrays.asList(b.instructionId(), b.uetr(), b.digest()),
                "a UTF-8 byte-order mark before the blocks");
        byte[] bomBare = concat(new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf}, BARE.getBytes(StandardCharsets.UTF_8));
        Check.equal("REF1", Swift.parseAll(bomBare).get(0).instructionId(), "and before a text block alone");
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static SwiftPayment one(String input, String reference) {
        List<SwiftPayment> all = Swift.parseAll(input);
        Check.equal(1, all.size(), "one payment");
        SwiftPayment p = all.get(0);
        Check.equal(Arrays.asList(0, 1, reference, true), Arrays.asList(p.index(), p.transactionCount(), p.instructionId(), p.distinctIds()),
                "index, count, reference, distinct identifiers");
        return p;
    }

    private static void refused(String input, String code, String field, String message) {
        SwiftMessageException e = (SwiftMessageException) Check.refuses(code, () -> Swift.parseAll(input));
        Check.equal(field, e.field(), "the field at fault");
        Check.equal(message, e.getMessage(), "the words");
    }
}
