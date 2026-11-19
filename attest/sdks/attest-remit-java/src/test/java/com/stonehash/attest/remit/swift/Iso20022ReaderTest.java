package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.RemitException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The ISO 20022 reader beyond the golden cases, held to the reference's
 * answers: every probe of {@link Iso20022Answers#MESSAGES} is read here and
 * compared with what the TypeScript {@code parseSwiftMessages} gave for it —
 * the same payments field for field, or the same refusal with the same code,
 * field and words. The probes are chosen for what the golden cases do not
 * reach: every address part, agents (an {@code Othr}-only one among them),
 * charges and the charge bearer, regulatory reporting, invoice typing,
 * pain.001 blocks, what a Document may hold and where a message may stand,
 * the test marker and its path, and which of two faults is reported first.
 */
final class Iso20022ReaderTest {
    private Iso20022ReaderTest() {
    }

    /** What the probe records for an error: the reference's error name, and code, field and words. */
    private static Map<String, Object> error(String name, RuntimeException e) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("name", name);
        if (e instanceof RemitException) {
            err.put("code", ((RemitException) e).code());
        }
        if (e instanceof SwiftMessageException && ((SwiftMessageException) e).field() != null) {
            err.put("field", ((SwiftMessageException) e).field());
        }
        err.put("message", e.getMessage());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", err);
        return out;
    }

    static void testEveryProbeReadsAsTheReferenceReadsIt() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.MESSAGES) {
            Map<String, Object> actual = new LinkedHashMap<>();
            try {
                List<Object> payments = new ArrayList<>();
                for (SwiftPayment p : Swift.parseAll(row[1])) {
                    payments.add(p.toJson());
                }
                actual.put("payments", payments);
            } catch (SwiftMessageException e) {
                // The reference ends every probe in a payment or a SwiftMessageError: an
                // element named after an Object.prototype member is no longer a TypeError.
                actual = error("SwiftMessageError", e);
            }
            String d = Golden.difference(Json.parse(row[2]), actual);
            if (d != null) {
                failures.add(row[0] + ": " + d);
            }
        }
        Golden.none(failures, "ISO 20022 probes");
    }

    static void testInvoiceWordsAsTheReferenceFindsThem() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.TOKENS) {
            Map<String, Object> actual = new LinkedHashMap<>();
            actual.put("tokens", new ArrayList<Object>(Iso20022Reader.invoiceTokens(row[1])));
            String d = Golden.difference(Json.parse(row[2]), actual);
            if (d != null) {
                failures.add(Json.compact(row[0]) + ": " + d);
            }
        }
        Golden.none(failures, "invoiceTokens probes");
    }

    static void testWhatLooksLikeXml() {
        Check.isTrue(Iso20022Reader.looksLikeXml("<a/>"), "a tag");
        Check.isTrue(Iso20022Reader.looksLikeXml("﻿   \n<a/>"), "a byte-order mark and JavaScript whitespace first");
        Check.isTrue(!Iso20022Reader.looksLikeXml("x<a/>"), "text first");
        Check.isTrue(!Iso20022Reader.looksLikeXml("\u0085<a/>"), "U+0085 is not whitespace in the reference");
    }

    /** The reference's timing test: 3,000 transactions under one payment block. */
    static void testThousandsOfTransactionsUnderOneBlockAreReadInLinearTime() {
        StringBuilder big = new StringBuilder("<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:pain.001.001.09\"><CstmrCdtTrfInitn><GrpHdr><MsgId>M</MsgId></GrpHdr>"
                + "<PmtInf><PmtInfId>P</PmtInfId><Dbtr><Nm>A</Nm></Dbtr>");
        for (int i = 0; i < 3000; i++) {
            big.append("<CdtTrfTxInf><PmtId><InstrId>I-").append(i).append("</InstrId><EndToEndId>E-").append(i).append("</EndToEndId></PmtId>")
                    .append("<Amt><InstdAmt Ccy=\"USD\">10.00</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr><CdtrAcct><Id><Othr><Id>ACC</Id></Othr></Id></CdtrAcct></CdtTrfTxInf>");
        }
        big.append("</PmtInf></CstmrCdtTrfInitn></Document>");
        long t0 = System.nanoTime();
        List<SwiftPayment> all = Swift.parseAll(big.toString());
        long ms = (System.nanoTime() - t0) / 1_000_000;
        Check.equal(3000, all.size(), "every transaction");
        Check.equal("I-2999", all.get(2999).instructionId(), "the last one");
        Check.equal(2999, all.get(2999).index(), "its index");
        Check.isTrue(all.get(0).debtor() != all.get(1).debtor(), "each payment has its own debtor object");
        Check.isTrue(all.get(0).debtor().addressLines() != all.get(1).debtor().addressLines(), "and its own address lines");
        Check.isTrue(ms < 4_000, "3,000 transactions took " + ms + " ms");
    }

    /**
     * One remittance line with far more /INV/ words than any message carries
     * (I2). The reference once spread the words into a call and overflowed the
     * stack beyond about 125,000 of them; it now takes them one at a time, and
     * so is held to the same: every word, in order, in well under a second.
     */
    static void testManyInvoiceWordsInOneLine() {
        StringBuilder u = new StringBuilder("/INV/a");
        for (int i = 0; i < 200_000; i++) {
            u.append("//x");
        }
        Check.equal(200_001, Iso20022Reader.invoiceTokens(u.toString()).size(), "every word is taken");
        String doc = "<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08\"><FIToFICstmrCdtTrf><CdtTrfTxInf>"
                + "<IntrBkSttlmAmt Ccy=\"USD\">1</IntrBkSttlmAmt><Dbtr><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr><RmtInf><Ustrd>" + u
                + "</Ustrd></RmtInf></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>";
        Check.equal(Arrays.asList("a", "x"), Swift.parseAll(doc).get(0).invoiceReferences(), "each reference once");

        // The reference's own case: 200,000 distinct /INV/ words, each its own reference.
        StringBuilder words = new StringBuilder();
        for (int i = 0; i < 200_000; i++) {
            words.append("/INV/").append(i);
        }
        long t0 = System.nanoTime();
        List<String> refs = Swift.parseAll(doc.replace(u.toString(), words.toString())).get(0).invoiceReferences();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        Check.equal(200_000, refs.size(), "200,000 references, read in full");
        Check.equal(Arrays.asList("0", "199999"), Arrays.asList(refs.get(0), refs.get(199_999)), "the first and the last");
        Check.isTrue(ms < 4_000, "200,000 references took " + ms + " ms");
    }

    /**
     * The test marker of a message body that stands without a Document (I6):
     * still a test, reported by the path the BIC stands at — and a header's
     * BIC is still the header's.
     */
    static void testATestBicOutsideAHeaderIsReportedByItsPath() {
        String body = "<FIToFICstmrCdtTrf><CdtTrfTxInf><IntrBkSttlmAmt Ccy=\"USD\">1</IntrBkSttlmAmt><Dbtr><Nm>A</Nm></Dbtr>"
                + "<CdtrAgt><FinInstnId><BICFI>DEMOSGS0</BICFI></FinInstnId></CdtrAgt><Cdtr><Nm>B</Nm></Cdtr></CdtTrfTxInf></FIToFICstmrCdtTrf>";
        String where = "FIToFICstmrCdtTrf/CdtTrfTxInf/CdtrAgt/FinInstnId/BICFI";
        SwiftPayment bare = Swift.parse(body, null);
        Check.equal(Arrays.asList(where, "test and training BIC DEMOSGS0"), Arrays.asList(bare.test().where(), bare.test().what()), "a bare body");
        Check.equal("Batch/" + where, Swift.parse("<Batch>" + body + "</Batch>", null).test().where(), "inside a wrapper, from the root");
        Check.equal("Business Application Header", Swift.parse("<Env><AppHdr>" + body + "</AppHdr></Env>", null).test().where(), "inside AppHdr");
    }
}
