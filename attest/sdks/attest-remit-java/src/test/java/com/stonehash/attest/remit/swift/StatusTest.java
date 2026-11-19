package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;

/**
 * The status going back, in the terms the TypeScript SDK's own tests state it
 * ({@code test/swift.test.ts}, "Status going back"), and what the Java API adds
 * around it. Expected values that are not in those tests were taken from the
 * TypeScript SDK for the same input.
 */
final class StatusTest {
    private StatusTest() {
    }

    private static final String PACS_002 = "urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10";

    // ── views, built the way the reference's tests build them ───────────────

    static Map<String, Object> obj(Object... keysAndValues) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            out.put((String) keysAndValues[i], keysAndValues[i + 1]);
        }
        return out;
    }

    /** An event after the bank's evidence: its type and payload. */
    private static Object[] ev(String type, Map<String, Object> payload) {
        return new Object[] {type, payload};
    }

    private static Object[] ev(String type) {
        return ev(type, obj());
    }

    /** {@code view(state, events, source)} of the reference's tests: the bank's evidence first, one second apart. */
    private static Map<String, Object> view(String state, boolean source, Object[]... events) {
        List<Object[]> all = new ArrayList<>();
        Map<String, Object> ref = obj("type", "pacs.008.001.08", "sha256", repeat('a', 64), "messageId", "M-1", "instructionId", "I-1",
                "endToEndId", "E-1", "uetr", "3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10");
        all.add(ev("BANK_EVIDENCE_SUBMITTED", obj("bankInstruction", source ? obj("sourceMessage", ref) : obj())));
        all.addAll(Arrays.asList(events));
        List<Object> list = new ArrayList<>();
        for (int seq = 0; seq < all.size(); seq++) {
            // Integers, as a Java caller builds them: read as the numbers they are.
            list.add(obj("seq", seq, "type", all.get(seq)[0], "issuer", "X",
                    "at", "2026-11-17T00:00:" + (seq < 10 ? "0" : "") + seq + ".000Z", "payload", all.get(seq)[1]));
        }
        return obj("payment_id", "PAY-20261117-abcdef0123", "state", state, "events", list);
    }

    private static Map<String, Object> view(String state, Object[]... events) {
        return view(state, true, events);
    }

    private static String repeat(char c, int n) {
        char[] out = new char[n];
        Arrays.fill(out, c);
        return new String(out);
    }

    private static String s(Map<String, Object> v) {
        SwiftStatus r = Swift.statusOf(v);
        return r.code() + "/" + (r.reason() == null ? "" : r.reason()) + "/" + r.isFinal();
    }

    static void testEachSituationMapsToOneCode() {
        Check.equal("ACTC//false", s(view("BANK_AUTHORIZED")), "accepted");
        Check.equal("PDNG/TRAVEL_RULE_PENDING/false", s(view("TRAVEL_RULE_PENDING", ev("TRAVEL_RULE_SENT"))), "waiting");
        Check.equal("PDNG/RFI/false", s(view("TRAVEL_RULE_PENDING", ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Why?"))))), "asked");
        Check.equal("PDNG/TRAVEL_RULE_PENDING/false", s(view("TRAVEL_RULE_PENDING",
                ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Why?"))), ev("TRAVEL_RULE_RECEIVED"))), "answered");
        // A question asked after an earlier answer is as open as the first; each of the three events closes the one before it.
        Check.equal("PDNG/RFI/false", s(view("TRAVEL_RULE_PENDING", ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("First?"))),
                ev("TRAVEL_RULE_RFI_RESOLVED"), ev("TRAVEL_RULE_RECEIVED"), ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Again?"))))), "asked again");
        Check.equal(Arrays.asList("Again?"), Swift.statusOf(view("TRAVEL_RULE_PENDING", ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("First?"))),
                ev("TRAVEL_RULE_RFI_RESOLVED"), ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Again?"))))).detail(), "the question that is waiting");
        for (String closing : Arrays.asList("TRAVEL_RULE_RFI_RESOLVED", "TRAVEL_RULE_RECEIVED", "TRAVEL_RULE_REJECTED")) {
            Check.equal("PDNG/TRAVEL_RULE_PENDING/false", s(view("TRAVEL_RULE_PENDING",
                    ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Why?"))), ev(closing))), "closed by " + closing);
        }
        Check.equal("ACSP/PAYOUT_PRE_APPROVED/false", s(view("PAYOUT_PRE_APPROVED")), "approved");
        Check.equal("ACSP/ONCHAIN_SETTLED/false", s(view("ONCHAIN_SETTLED")), "settled on chain");
        Check.equal("ACSP/PAYOUT_IN_PROGRESS/false", s(view("PAYOUT_IN_PROGRESS")), "paying out");
        Check.equal("PDNG/EVIDENCE_INSUFFICIENT/false", s(view("PAYOUT_IN_PROGRESS", ev("EVIDENCE_INSUFFICIENT"))), "no proof");
        Check.equal("ACCC//true", s(view("BENEFICIARY_CREDIT_CONFIRMED", ev("PAYOUT_COMPLETED", obj("bank_reference", "FAST-1")))), "credited");
        Check.equal("ACCC//true", s(view("EVIDENCE_ANCHORED", ev("PAYOUT_COMPLETED", obj("bank_reference", "FAST-1")))), "anchored");
        // Withdrawn at the bank's request: an interbank report says RJCT, with the reason — CANC is kept for API contexts.
        Check.equal("RJCT/CANCELLED_BY_BANK/true", s(view("CANCELLED", ev("CANCEL_REQUESTED", obj("reason", "customer")))), "cancelled");
        // A payout that failed and has not come back yet is no longer "in process".
        Check.equal("PDNG/PAYOUT_FAILED/false", s(view("PAYOUT_IN_PROGRESS", ev("PAYOUT_FAILED", obj("reason", "closed account")))), "failed");
        Check.equal("RJCT/TRAVEL_RULE_REJECTED/true", s(view("CANCELLED", ev("TRAVEL_RULE_REJECTED", obj("reason", "screening")))), "refused");
        Check.equal("RJCT/RETURNED/true", s(view("RETURNED", ev("PAYOUT_FAILED", obj("reason", "closed account")),
                ev("USDC_RETURNED", obj("tx_hash", "0xabc")))), "returned");
        Check.equal("PDNG/EXCEPTION/false", s(view("EXCEPTION", ev("EXCEPTION", obj("error", "boom")))), "exception");
        // Who has to act, where the payment will not move by itself.
        SwiftStatus stopped = Swift.statusOf(view("EXCEPTION", ev("EXCEPTION", obj("error", "boom"))));
        Check.equal("manual_resolution", stopped.needs(), "an exception needs a person");
        Check.isTrue(stopped.detail().get(0).contains("No further status follows automatically"), "and says so in words");
        Check.equal(Arrays.asList("Processing stopped. No further status follows automatically; the payment is resolved by a person.", "boom"),
                stopped.detail(), "the words, then the error");
        Check.equal("bank_answer", Swift.statusOf(view("TRAVEL_RULE_PENDING", ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList("Why?"))))).needs(),
                "a question needs the bank's answer");
        Check.equal(null, Swift.statusOf(view("ONCHAIN_SETTLED")).needs(), "a moving payment needs nobody");
        Check.equal("FAST-1", Swift.statusOf(view("EVIDENCE_ANCHORED", ev("PAYOUT_COMPLETED", obj("bank_reference", "FAST-1")))).creditReference(),
                "the beneficiary bank's reference");
        // The published table and the function agree on every state it lists.
        for (Map<String, Object> row : Swift.statusTable()) {
            Check.isTrue(Pattern.matches("ACTC|ACSP|ACCC|PDNG|RJCT", (String) row.get("code")), "an ISO 20022 code: " + row);
        }
    }

    static void testTheReportIsWellFormedInSchemaOrderAndPointsAtTheBanksIdentifiers() throws Exception {
        String longQuestion = "Please describe the purpose of the payment and the nature of the underlying trade in full, "
                + "and give the reference of the shipping documents that correspond to the invoice.";
        String xml = Swift.buildPacs002(view("TRAVEL_RULE_PENDING",
                ev("TRAVEL_RULE_RFI", obj("questions", Arrays.asList(longQuestion, "B/L number <required> & date")))), null, "2026-11-17T00:00:00.000Z");
        Element doc = parse(xml);
        Check.equal(PACS_002, doc.getNamespaceURI(), "the pacs.002 namespace");
        Element tx = first(doc, "TxInfAndSts");
        Check.equal(Arrays.asList("StsId", "OrgnlGrpInf", "OrgnlInstrId", "OrgnlEndToEndId", "OrgnlUETR", "TxSts", "StsRsnInf", "AccptncDtTm"),
                names(tx), "the schema's order");
        Check.equal("M-1", text(first(first(tx, "OrgnlGrpInf"), "OrgnlMsgId")), "the bank's message id");
        Check.equal("pacs.008.001.08", text(first(first(tx, "OrgnlGrpInf"), "OrgnlMsgNmId")), "its message type");
        Check.equal("3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10", text(first(tx, "OrgnlUETR")), "its UETR");
        Check.equal("PDNG", text(first(tx, "TxSts")), "the status");
        Check.equal("RFI", text(first(first(first(tx, "StsRsnInf"), "Rsn"), "Prtry")), "the reason");
        List<String> info = new ArrayList<>();
        for (Element e : children(first(tx, "StsRsnInf"))) {
            if (e.getLocalName().equals("AddtlInf")) {
                info.add(e.getTextContent());
            }
        }
        Check.isTrue(info.size() >= 3, "the long question takes more than one AddtlInf");
        for (String t : info) {
            Check.isTrue(t.length() <= 105, "AddtlInf is Max105Text: " + t);
        }
        Check.equal(longQuestion + " B/L number <required> & date", String.join(" ", info), "the words, whole");
        Check.isTrue(text(first(first(doc, "GrpHdr"), "MsgId")).length() <= 35, "MsgId is Max35Text");
        // The acceptance time is the time the instruction was accepted, whatever the status has become.
        Check.equal("2026-11-17T00:00:00.000Z", text(first(tx, "AccptncDtTm")), "the acceptance time");

        // A settlement that did not come from a SWIFT message still gets a report…
        Element plain = first(parse(Swift.buildPacs002(view("EVIDENCE_ANCHORED", false,
                ev("PAYOUT_COMPLETED", obj("bank_reference", "FAST-9"))))), "TxInfAndSts");
        Check.equal(Arrays.asList("StsId", "TxSts", "AccptncDtTm", "FctvIntrBkSttlmDt", "AcctSvcrRef"), names(plain), "a report without references");
        // …with the time of the credit where the schema puts it, apart from the acceptance time.
        Check.equal(Arrays.asList("2026-11-17T00:00:00.000Z", "2026-11-17T00:00:01.000Z"),
                Arrays.asList(text(first(plain, "AccptncDtTm")), text(first(first(plain, "FctvIntrBkSttlmDt"), "DtTm"))), "two times");
        Check.equal(null, Swift.sourceMessageOf(view("BANK_AUTHORIZED", false)), "no reference without a message");
        // A reference too long for its element is given in words, not cut short.
        String longRef = "FAST-20261117-0000000000000000000099999";
        Element lx = first(parse(Swift.buildPacs002(view("EVIDENCE_ANCHORED", ev("PAYOUT_COMPLETED", obj("bank_reference", longRef))))), "TxInfAndSts");
        Check.equal(null, first(lx, "AcctSvcrRef"), "no AcctSvcrRef");
        Check.equal("Credit reference " + longRef, text(first(first(lx, "StsRsnInf"), "AddtlInf")), "the reference in words");
    }

    static void testTextFromAnotherSystemCannotBreakTheReport() throws Exception {
        StringBuilder hostile = new StringBuilder("<x> & \"q\" \u0001\u000B ]]> ");
        for (int i = 0; i < 60; i++) {
            hostile.append("long ");
        }
        String h = hostile.toString();
        Map<String, Object> src = obj("type", "pacs.008.001.08", "sha256", repeat('a', 64), "messageId", h, "instructionId", h, "endToEndId", h,
                "uetr", "not-a-uuid");
        String xml = Swift.buildPacs002(obj("payment_id", "PAY-<&>-an-identifier-that-is-far-too-long-for-a-35-character-field",
                "state", "TRAVEL_RULE_PENDING", "events", Arrays.asList(
                        obj("seq", 0, "type", "BANK_EVIDENCE_SUBMITTED", "issuer", "x", "at", "2026-11-17T00:00:00Z",
                                "payload", obj("bankInstruction", obj("sourceMessage", src))),
                        obj("seq", 1, "type", "TRAVEL_RULE_RFI", "issuer", "x", "at", "2026-11-17T00:00:01Z",
                                "payload", obj("questions", Arrays.asList(h, "", 3, null))))));
        Check.isTrue(!Pattern.compile("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]").matcher(xml).find(), "no character XML 1.0 forbids");
        Element tx = first(parse(xml), "TxInfAndSts");
        for (String name : Arrays.asList("StsId", "OrgnlInstrId", "OrgnlEndToEndId")) {
            int n = text(first(tx, name)).length();
            Check.isTrue(n >= 1 && n <= 35, name + " is Max35Text");
        }
        Check.equal(null, first(tx, "OrgnlUETR"), "a reference that is not a UUID is not written where the schema would refuse it");
        List<Element> info = new ArrayList<>();
        for (Element e : children(first(tx, "StsRsnInf"))) {
            if (e.getLocalName().equals("AddtlInf")) {
                info.add(e);
            }
        }
        Check.isTrue(!info.isEmpty(), "the questions are there");
        Check.equal("UETR not-a-uuid", info.get(info.size() - 1).getTextContent(), "and the reference is given in words, never dropped");
        Check.isTrue(info.get(info.size() - 2).getTextContent().equals("3"), "a question that is a number is written as one; one that is null is not a question: "
                + info.get(info.size() - 2).getTextContent());
        for (Element e : info) {
            int n = e.getTextContent().length();
            Check.isTrue(n >= 1 && n <= 105, "AddtlInf is Max105Text and not empty");
        }

        // A value made only of characters XML forbids is left out — never written as an empty element.
        String blank = Swift.buildPacs002(obj("payment_id", "PAY-1", "state", "TRAVEL_RULE_PENDING", "events", Arrays.asList(
                obj("seq", 0, "type", "BANK_EVIDENCE_SUBMITTED", "issuer", "x", "at", "2026-11-17T00:00:00Z", "payload",
                        obj("bankInstruction", obj("sourceMessage", obj("type", "pacs.008.001.08", "sha256", repeat('a', 64),
                                "messageId", "\u0001\u0002\u0003", "instructionId", "\u0001", "endToEndId", "E-1")))),
                obj("seq", 1, "type", "TRAVEL_RULE_RFI", "issuer", "x", "at", "2026-11-17T00:00:01Z", "payload",
                        obj("questions", Arrays.asList("\u0001\u0002"))))));
        Check.isTrue(!Pattern.compile("<(\\w+)></\\1>").matcher(blank).find(), "no empty element");
        Element btx = first(parse(blank), "TxInfAndSts");
        Check.equal(Arrays.asList("StsId", "OrgnlEndToEndId", "TxSts", "StsRsnInf", "AccptncDtTm"), names(btx), "what is left");
        Check.equal(Arrays.asList("Rsn"), names(first(btx, "StsRsnInf")), "the reason alone");
    }

    // ── what the Java API adds ──────────────────────────────────────────────

    static void testAValueOfTheWrongKindReadsAsAbsentAndAStatusIsStillGiven() {
        Map<String, Object> odd = obj("payment_id", "P", "state", Arrays.asList("A", 1L), "events",
                Arrays.asList(obj("type", "REQUEST_ACCEPTED", "at", 5L)));
        SwiftStatus st = Swift.statusOf(odd);
        Check.equal("PDNG", st.code(), "an unknown state is pending");
        Check.equal("UNKNOWN", st.state(), "a state that is not text is a state the table does not know");
        Check.equal("UNKNOWN", st.reason(), "and that is the reason given");
        Check.equal(null, st.at(), "a time that is not text is no time");
        Check.equal(null, st.acceptedAt(), "nor is the acceptance time");
        Check.equal("{\"code\":\"PDNG\",\"meaning\":\"Pending — further checks or information are outstanding\",\"state\":\"UNKNOWN\","
                + "\"reason\":\"UNKNOWN\",\"detail\":[],\"final\":false}", Json.compact(st.toJson()), "as JSON: what is not there is absent");
        Check.fails(UnsupportedOperationException.class, () -> st.detail().add("x"));
        // A time is one only in the form the platform writes; a status never borrows another event's.
        SwiftStatus untimed = Swift.statusOf(view("BENEFICIARY_CREDIT_CONFIRMED", ev("SOMETHING_ELSE")));
        Check.equal(null, untimed.at(), "credited without a payout event: no time of credit");
        Check.equal("2026-11-17T00:00:00.000Z", untimed.acceptedAt(), "though the acceptance time is known");

        SwiftStatus credited = Swift.statusOf(view("EVIDENCE_ANCHORED", ev("PAYOUT_COMPLETED", obj("bank_reference", "FAST-1"))));
        Check.equal("EVIDENCE_ANCHORED", credited.state(), "the state");
        Check.equal(null, credited.reason(), "a credit carries no reason");
        Check.equal("2026-11-17T00:00:01.000Z", credited.at(), "the time of the payout");
        Check.equal("2026-11-17T00:00:00.000Z", credited.acceptedAt(), "the time of the acceptance");
        Check.isTrue(credited.isFinal(), "settled");
        Check.equal("AcceptedCreditSettlementCompleted — the creditor's account has been credited", credited.meaning(), "the standard's words");
        Check.equal(Arrays.asList("code", "meaning", "state", "detail", "final", "at", "acceptedAt", "creditReference"),
                new ArrayList<>(credited.toJson().keySet()), "the reference's keys, in its order");
        Check.equal(Arrays.asList("code", "meaning", "state", "reason", "detail", "final", "at", "acceptedAt", "needs"),
                new ArrayList<>(Swift.statusOf(view("EXCEPTION", ev("EXCEPTION"))).toJson().keySet()), "with a reason and a need");
    }

    static void testTheStatusTableCannotBeChanged() {
        List<Map<String, Object>> table = Swift.statusTable();
        Check.equal(14, table.size(), "one row per situation");
        Check.equal(Arrays.asList("state", "when", "code", "reason"), new ArrayList<>(table.get(0).keySet()), "the row's keys");
        Check.fails(UnsupportedOperationException.class, () -> table.add(Collections.<String, Object>emptyMap()));
        Check.fails(UnsupportedOperationException.class, () -> table.get(0).put("code", "CANC"));
        Check.equal("ACTC", Swift.statusTable().get(0).get("code"), "still the reference's table");
    }

    static void testTheDefaultCreationTimeIsNowToTheMillisecond() {
        Instant before = Instant.now().minus(Duration.ofSeconds(1));
        String xml = Swift.buildPacs002(view("BANK_AUTHORIZED"));
        Instant after = Instant.now().plus(Duration.ofSeconds(1));
        java.util.regex.Matcher m = Pattern.compile("<CreDtTm>(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)</CreDtTm>").matcher(xml);
        Check.isTrue(m.find(), "an ISO time in UTC with milliseconds, as Date.toISOString() writes it: " + xml);
        Instant at = Instant.parse(m.group(1));
        Check.isTrue(!at.isBefore(before) && !at.isAfter(after), "now: " + at);
        Check.isTrue(xml.contains("<MsgId>PAY-20261117-abcdef0123-0</MsgId>"), "the message id from the payment id and the last event");
        String fixed = "2026-11-17T09:30:00+07:00";
        Check.equal(Swift.buildPacs002(view("BANK_AUTHORIZED"), null, fixed),
                Swift.buildPacs002(view("BANK_AUTHORIZED")).replaceFirst("<CreDtTm>[^<]*</CreDtTm>", "<CreDtTm>" + fixed + "</CreDtTm>"), "nothing else differs");
        // A creation time that is not one is not written: the report states when it was made.
        for (String notATime : Arrays.asList("T", "", "2026-11-17", "2026-11-17T25:00:00Z", " <T>&\u0001 ")) {
            java.util.regex.Matcher made = Pattern.compile("<CreDtTm>([^<]*)</CreDtTm>").matcher(Swift.buildPacs002(view("BANK_AUTHORIZED"), null, notATime));
            Check.isTrue(made.find() && !Instant.parse(made.group(1)).isBefore(before), Json.compact(notATime) + " was not used: " + made.group(1));
        }
    }

    /** What JavaScript's {@code String(x)} writes — the reference writes questions and sequence numbers that way. */
    static void testNumbersArePrintedAsJavaScriptPrintsThem() {
        Object[][] cases = {
                {"0", 0.0, "0"},
                {"-0.0", -0.0, "0"},
                {"1", 1.0, "1"},
                {"-1", -1.0, "-1"},
                {"1.5", 1.5, "1.5"},
                {"0.1", 0.1, "0.1"},
                {"0.1 + 0.2", 0.30000000000000004, "0.30000000000000004"},
                {"1 / 3", 0.3333333333333333, "0.3333333333333333"},
                {"100", 100.0, "100"},
                {"1e21", 1e21, "1e+21"},
                {"999999999999999900000", 999999999999999900000.0, "999999999999999900000"},
                {"123456789012345680000", 123456789012345680000.0, "123456789012345680000"},
                {"1e-6", 0.000001, "0.000001"},
                {"1e-7", 1e-7, "1e-7"},
                {"1.5e-7", 1.5e-7, "1.5e-7"},
                {"0.000001234", 0.000001234, "0.000001234"},
                {"123e-20", 1.23e-18, "1.23e-18"},
                {"5e-324", 5e-324, "5e-324"},
                {"2.2250738585072014e-308", 2.2250738585072014e-308, "2.2250738585072014e-308"},
                {"1.7976931348623157e308", 1.7976931348623157e308, "1.7976931348623157e+308"},
                {"9007199254740993", 9007199254740992.0, "9007199254740992"},
                {"2^53 + 2", 9007199254740994.0, "9007199254740994"},
                {"2^60", 1152921504606847000.0, "1152921504606847000"},
                {"2^-1074 * 3", 1.5e-323, "1.5e-323"},
                {"4.35", 4.35, "4.35"},
                {"1.005", 1.005, "1.005"},
                {"-12.5e-3", -0.0125, "-0.0125"},
                {"1e300 * 10", 1e301, "1e+301"},
                {"-1e300 * 1e10", Double.NEGATIVE_INFINITY, "-Infinity"},
                {"2^1023", 8.98846567431158e307, "8.98846567431158e+307"},
                {"2^-1022", 2.2250738585072014e-308, "2.2250738585072014e-308"},
                {"9.999999999999999e22", 1e23, "1e+23"},
                {"1e23", 1e23, "1e+23"},
        };
        for (Object[] c : cases) {
            Check.equal(c[2], StatusReport.numberToString((Double) c[1]), "String(" + c[0] + ")");
        }
    }

    /** A Java caller's own map holds Integer, Double, BigInteger: each is read as the JavaScript number it is. */
    static void testAViewBuiltInJavaIsReadAsTheSameJson() {
        Map<String, Object> v = obj("payment_id", "PAY-1", "state", "TRAVEL_RULE_PENDING", "events", Arrays.asList(
                obj("seq", 0, "type", "BANK_EVIDENCE_SUBMITTED", "at", "A", "payload", obj("bankInstruction", obj("sourceMessage",
                        obj("type", "MT103", "sha256", "b", "index", 2)))),
                obj("seq", new BigInteger("12345678901234567890"), "type", "TRAVEL_RULE_RFI", "payload",
                        obj("questions", Arrays.asList(1.5, 0.1 + 0.2, 7, new BigDecimal("1.0"), 1e21f, Long.MAX_VALUE)))));
        Check.equal(Arrays.asList("1.5", "0.30000000000000004", "7", "1", "1.0000000200408773e+21", "9223372036854776000"),
                Swift.statusOf(v).detail(), "questions written as JavaScript writes the numbers");
        Check.equal(2L, Swift.sourceMessageOf(v).get("index"), "an Integer index is the integer");
        Check.isTrue(Swift.buildPacs002(v, null, "2026-11-17T00:00:00Z").contains("<MsgId>PAY-1-0</MsgId>"),
                "a sequence number that is not a whole number within the safe range counts as 0");
    }

    // ── reading the report back ─────────────────────────────────────────────

    private static Element parse(String xml) throws Exception {
        DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
        f.setNamespaceAware(true);
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        DocumentBuilder b = f.newDocumentBuilder();
        Document d = b.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
        return d.getDocumentElement();
    }

    private static List<Element> children(Element e) {
        List<Element> out = new ArrayList<>();
        for (Node n = e.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element) {
                out.add((Element) n);
            }
        }
        return out;
    }

    private static List<String> names(Element e) {
        List<String> out = new ArrayList<>();
        for (Element c : children(e)) {
            Check.equal(PACS_002, c.getNamespaceURI(), "every element in the pacs.002 namespace");
            out.add(c.getLocalName());
        }
        return out;
    }

    /** The first element of that name, depth first, the element itself included; null when there is none. */
    private static Element first(Element e, String name) {
        if (e.getLocalName().equals(name)) {
            return e;
        }
        for (Element c : children(e)) {
            Element hit = first(c, name);
            if (hit != null) {
                return hit;
            }
        }
        return null;
    }

    private static String text(Element e) {
        return e == null ? null : Js.trim(e.getTextContent());
    }
}
