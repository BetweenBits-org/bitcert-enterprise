package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.Swift;
import com.stonehash.attest.remit.swift.SwiftMapping;
import com.stonehash.attest.remit.swift.SwiftMappingException;
import com.stonehash.attest.remit.swift.SwiftPayment;
import com.stonehash.attest.remit.swift.SwiftStatus;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The SWIFT path as a bank's code calls it — the parts of it that
 * {@link SwiftScenarioTest} (what {@code submitSwift} decides) does not reach:
 * looking without sending, signing without submitting, a file of many, what
 * the bank knows beyond the message, the outcome as a status and a
 * {@code pacs.002}, and a client that only reads.
 *
 * <p>The messages are the SDK's samples, as {@code golden/parse.json} holds
 * them; the platform is the scenarios' stand-in.
 */
final class SwiftClientTest {
    private static final String BANK = "VN-BANK-T1";

    private SwiftClientTest() {
    }

    private static Object message(String parseCase) throws Exception {
        for (Object c : SwiftScenarioTest.list(SwiftScenarioTest.golden("parse.json").get("cases"))) {
            if (parseCase.equals(SwiftScenarioTest.object(c).get("name"))) {
                return SwiftScenarioTest.input(SwiftScenarioTest.object(SwiftScenarioTest.object(c).get("input")));
            }
        }
        throw new AssertionError("no case of parse.json is named " + parseCase);
    }

    private static byte[] bytes(String parseCase) throws Exception {
        return (byte[]) message(parseCase);
    }

    private static KeySigner key() throws Exception {
        return Signers.fromPkcs8Pem((String) SwiftScenarioTest.object(SwiftScenarioTest.golden("signing.json").get("testKey")).get("pkcs8Pem"));
    }

    private static SwiftScenarioTest.StandIn standIn() throws Exception {
        Map<String, Object> platform = SwiftScenarioTest.object(SwiftScenarioTest.golden("scenarios.json").get("platform"));
        return new SwiftScenarioTest.StandIn(SwiftScenarioTest.object(platform.get("quote")), new ArrayList<>());
    }

    private static RemitClient client(StubPlatform platform) throws Exception {
        return RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "Test Bank").signer(key()).build();
    }

    private static Map<String, Object> bankInstruction(Map<String, Object> body) {
        return SwiftScenarioTest.object(SwiftScenarioTest.object(body.get("evidence_elements")).get("bankInstruction"));
    }

    // ── looking without sending ───────────────────────────────────────────────

    static void testInspectingAMessageSignsNothingAndSendsNothing() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform);
            SwiftMapping mapping = client.inspectSwift(bytes("sample/pacs008"));
            Check.isTrue(mapping.issues().isEmpty() && mapping.input() != null, "the sample states everything the corridor needs: " + mapping.issues());
            Check.equal("pacs.008", mapping.payment().format(), "what was read");
            Check.equal("12500.00", mapping.input().tradeAmount(), "the trade amount, as the message states it");
            Check.equal("PAY-3f1c9a52-175c822e37", Swift.paymentId(BANK, mapping.payment()), "the payment the message names, for this bank");
            boolean debtorName = false;
            for (SwiftMapping.Field f : mapping.fields()) {
                debtorName |= f.target().equals("debtor.name") && f.value().equals("Vina Trading Co., Ltd.") && f.basis().equals("stated");
            }
            Check.isTrue(debtorName, "every value says where it came from: " + mapping.fields());

            // The same message as text, and as a payment already read out of it.
            Check.equal(Json.compact(mapping.toJson()),
                    Json.compact(client.inspectSwift(Swift.parse(bytes("sample/pacs008"), null)).toJson()), "a payment already parsed maps the same");
            Check.equal(mapping.input().tradeAmount(), client.inspectSwift(new String(bytes("sample/pacs008"), StandardCharsets.UTF_8)).input().tradeAmount(),
                    "and so does the message as text");

            // A message that lacks something is reported, not refused: inspecting is for finding that out.
            SwiftMapping incomplete = client.inspectSwift(bytes("sample/mt103-free-format"));
            Check.isTrue(incomplete.input() == null, "nothing to build an instruction from");
            Check.equal(1, incomplete.issues().size(), "one thing missing");
            Check.equal("debtor.registration_number", incomplete.issues().get(0).target(), "and which");

            Check.fails(NullPointerException.class, () -> client.inspectSwift((byte[]) null));
            Check.fails(NullPointerException.class, () -> client.inspectSwift(bytes("sample/pacs008"), null));
            Check.equal(0, platform.requests().size(), "nothing left the machine");
        }
    }

    // ── signing without submitting ────────────────────────────────────────────

    static void testAnInstructionFromAMessageIsQuotedAndSignedAndNotSubmitted() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            KeySigner key = key();
            RemitClient client = client(platform);
            SwiftInstruction built = client.instructionFromSwift(bytes("sample/pacs008"));
            Check.equal("PAY-3f1c9a52-175c822e37", built.paymentId(), "the id derived from the message's own reference");
            Check.equal("12500.00", built.quote().tradeAmount(), "quoted for the message's amount");
            Check.equal(1L, SwiftScenarioTest.count(platform.requests(), "POST", "/v1/quotes"), "one quote");
            Check.equal(1, platform.requests().size(), "and nothing else: the ledger is not asked, nothing is submitted");

            Map<String, Object> body = built.instruction().body();
            Map<String, Object> instruction = bankInstruction(body);
            Map<String, Object> source = SwiftScenarioTest.object(instruction.get("sourceMessage"));
            Check.equal(built.mapping().payment().digest(), source.get("sha256"), "the instruction names the bank's message by its digest");
            Check.equal("3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10", source.get("uetr"), "and by its UETR");
            List<Object> names = new ArrayList<>(Swift.isoFieldNames(built.mapping().payment()));
            names.add(built.mapping().input().invoiceRef());
            Check.equal(names, instruction.get("iso20022Fields"), "with the ISO 20022 names of what the message carries, and the invoice");
            Check.equal("OUT-2026-000123", SwiftScenarioTest.object(body.get("bank_authorization")).get("instruction_ref"), "the bank's own instruction reference");
            Check.isTrue(Signing.verifyEvent(body.get("bank_authorization"), body.get("bank_signature"), key.publicKeySpkiBase64()), "signed by the bank");
            Check.isTrue(Signing.verifyElement(instruction, key.publicKeySpkiBase64()), "the message reference is under the element's signature");

            // Submitting it is a step of its own.
            Settlement accepted = client.submit(built.instruction());
            Check.equal("BANK_AUTHORIZED", accepted.state(), "accepted");
            // …and the whole path then recognises the payment instead of sending it twice.
            SwiftSubmission again = client.submitSwift(bytes("sample/pacs008"));
            Check.isTrue(again.already() && again.quote() == null, "the same message, handed to submitSwift afterwards, is recognised");
            Check.equal(1L, SwiftScenarioTest.count(platform.requests(), "POST", "/v1/settlements"), "one settlement");

            // A message that lacks something is refused here, with every reason, before a quote is asked for.
            int before = platform.requests().size();
            SwiftMappingException refused = (SwiftMappingException) Check.refuses("mapping_incomplete",
                    () -> client.instructionFromSwift(bytes("sample/mt103-free-format")));
            Check.equal("debtor.registration_number", refused.issues().get(0).target(), "what is missing, by name");
            Check.isTrue(refused.mapping().payment() != null, "with the whole mapping table");
            Check.equal(before, platform.requests().size(), "nothing was asked of the platform");
        }
    }

    // ── a file of many ────────────────────────────────────────────────────────

    static void testAFileOfManyIsReadOnceAndHandedOverOnePaymentAtATime() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            RemitClient client = client(platform);
            byte[] file = bytes("xml/two-transactions");

            // Without saying which, a file of several is refused: a payment is never picked by accident.
            Check.refuses("multiple_transactions", () -> client.submitSwift(file));
            Check.equal(0, platform.requests().size(), "and nothing is asked of the platform");

            List<SwiftPayment> payments = Swift.parseAll(file);
            Check.equal(2, payments.size(), "two transactions");
            List<String> ids = new ArrayList<>();
            for (SwiftPayment payment : payments) {
                SwiftSubmission sent = client.submitSwift(payment);
                Check.isTrue(!sent.already(), "each is a payment of its own");
                ids.add(sent.paymentId());
            }
            Check.isTrue(!ids.get(0).equals(ids.get(1)), "under its own id: " + ids);
            Check.equal(2L, SwiftScenarioTest.count(platform.requests(), "POST", "/v1/settlements"), "two settlements");

            // The same file again, this time by position: the same two payments, recognised.
            for (int i = 0; i < 2; i++) {
                SwiftSubmission again = client.submitSwift(file, new SwiftOptions().index(i));
                Check.isTrue(again.already(), "transaction " + i + " is recognised");
                Check.equal(ids.get(i), again.paymentId(), "as the payment it was sent as");
            }
            Check.equal(2L, SwiftScenarioTest.count(platform.requests(), "POST", "/v1/settlements"), "and nothing more was sent");
            // A position the file does not have is refused as such — it is never read as "the last one".
            Check.refuses("invalid_field", () -> client.submitSwift(file, new SwiftOptions().index(2)));
        }
    }

    // ── what the bank knows beyond the message ────────────────────────────────

    static void testWhatTheBankKnowsBeyondTheMessageIsLookedUpForThePaymentThatWasRead() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            RemitClient client = client(platform);
            byte[] freeFormat = bytes("sample/mt103-free-format");
            AtomicInteger asked = new AtomicInteger();
            List<String> accounts = new ArrayList<>();
            SwiftOptions fromCustomerMaster = new SwiftOptions().supplement((SwiftPayment payment) -> {
                asked.incrementAndGet();
                accounts.add(payment.debtor().account());
                return "VN-ACC-000777".equals(payment.debtor().account()) ? new PartySupplement().debtorRegistrationNumber("0312345678") : null;
            });

            SwiftMapping mapping = client.inspectSwift(freeFormat, fromCustomerMaster);
            Check.isTrue(mapping.issues().isEmpty(), "with the registration number from the bank's records nothing is missing: " + mapping.issues());
            SwiftMapping.Field supplied = null;
            for (SwiftMapping.Field f : mapping.fields()) {
                supplied = f.target().equals("debtor.registration_number") ? f : supplied;
            }
            Check.isTrue(supplied != null && "0312345678".equals(supplied.value()) && "supplied".equals(supplied.basis()),
                    "and the mapping says the value was supplied, not read: " + supplied);
            Check.equal(Arrays.asList("VN-ACC-000777"), accounts, "the lookup was handed the payment that was read");

            SwiftSubmission sent = client.submitSwift(freeFormat, fromCustomerMaster);
            Check.isTrue(!sent.already(), "sent");
            Check.equal(2, asked.get(), "the records are asked once per call");
            StubPlatform.Request post = platform.requests("POST").get(platform.requests("POST").size() - 1);
            Map<String, Object> compliance = SwiftScenarioTest.object(post.json().get("compliance_payload"));
            Check.isTrue(Json.compact(compliance).contains("0312345678"), "the supplied value travels in the Travel Rule data");

            // One value for one call, and the same held as JSON (the shape of the sample customer-master extract).
            Check.isTrue(client.inspectSwift(freeFormat, new SwiftOptions().supplement(new PartySupplement().debtorRegistrationNumber("0312345678")))
                    .issues().isEmpty(), "a supplement given as a value");
            Object json = Json.parse("{\"debtor\":{\"registration_number\":\"0312345678\"},\"invoiceRef\":\"INV-9\"}");
            SwiftMapping fromJson = client.inspectSwift(freeFormat, new SwiftOptions().supplement(PartySupplement.fromJson(json)));
            Check.equal("INV-9", fromJson.input().invoiceRef(), "a supplement read from JSON, and its value wins over the message's");
            Check.isTrue(PartySupplement.fromJson(null) == null, "no record is no supplement");
            Check.refuses("invalid_supplement", () -> PartySupplement.fromJson(Json.parse("{\"debtor\":{\"registration_number\":312345678}}")));
            Check.refuses("invalid_supplement", () -> PartySupplement.fromJson(Json.parse("[\"0312345678\"]")));

            // Records that hold nothing for the payment leave the message as it is.
            Check.refuses("mapping_incomplete", () -> client.submitSwift(freeFormat, new SwiftOptions().supplement((SwiftPayment p) -> null)));
        }
    }

    // ── the bank's own review, and who pays out ───────────────────────────────

    static void testTheBanksReviewAndThePayingInstitutionTravelWithAMessage() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            RemitClient client = client(platform);
            SwiftOptions options = new SwiftOptions().beneficiaryInstitution("SG-BFI-777")
                    .review(new InstructionOptions.Review().regulatorReportRef("SBV-2026-0001").approvedByRole("Head of Trade Finance"));
            client.submitSwift(bytes("sample/pacs008"), options);
            StubPlatform.Request post = platform.requests("POST").get(platform.requests("POST").size() - 1);
            Check.equal("swift-PAY-3f1c9a52-175c822e37", post.headers.get("idempotency-key"), "the idempotency key is made from the payment id");
            String body = Json.compact(post.json());
            Check.isTrue(body.contains("SG-BFI-777"), "the paying institution the bank named");
            Check.isTrue(body.contains("SBV-2026-0001") && body.contains("Head of Trade Finance"), "what the bank's own review concluded");
            Check.isTrue(!body.contains("SDK-DEMO"), "and not the first-run default in its place");
        }
    }

    // ── the outcome, in the bank's own format ─────────────────────────────────

    static void testTheOutcomeComesBackAsAStatusCodeAndAPacs002() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            RemitClient client = client(platform);
            SwiftSubmission sent = client.submitSwift(bytes("sample/pacs008"));

            SwiftStatus status = client.swiftStatus(sent.paymentId());
            Check.equal("ACTC", status.code(), "accepted, as an ISO 20022 transaction status");
            Check.equal("BANK_AUTHORIZED", status.state(), "from the platform's state");
            Check.isTrue(!status.isFinal(), "not final yet");

            String report = client.statusReport(sent.paymentId());
            Check.isTrue(report.startsWith("<?xml") && report.contains("pacs.002.001.10"), "a pacs.002 status report");
            Check.isTrue(report.contains("<TxSts>ACTC</TxSts>"), "carrying the same status");
            Check.isTrue(report.contains("<OrgnlMsgId>DEMOVNVX20261117000123</OrgnlMsgId>") && report.contains("<OrgnlInstrId>OUT-2026-000123</OrgnlInstrId>")
                    && report.contains("<OrgnlEndToEndId>PO-7781</OrgnlEndToEndId>") && report.contains("<OrgnlUETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</OrgnlUETR>"),
                    "pointing at the bank's own message by its identifiers:\n" + report);

            // For a settlement already read, the same without another request.
            Settlement view = client.status(sent.paymentId());
            int before = platform.requests().size();
            Check.equal(status.code(), Swift.statusOf(view.json()).code(), "the status of a settlement in hand");
            Check.equal(report.replaceAll("<CreDtTm>[^<]*</CreDtTm>", ""), Swift.buildPacs002(view.json()).replaceAll("<CreDtTm>[^<]*</CreDtTm>", ""),
                    "and its report (but for the time it was made)");
            Check.equal(before, platform.requests().size(), "without asking the platform again");

            // Withdrawn at the bank's request: reported as rejected, with the reason — and final.
            client.cancel(sent.paymentId(), "customer request");
            SwiftStatus cancelled = client.swiftStatus(sent.paymentId());
            Check.equal("RJCT", cancelled.code(), "a cancelled payment is reported RJCT");
            Check.equal("CANCELLED_BY_BANK", cancelled.reason(), "with the reason");
            Check.isTrue(cancelled.isFinal(), "and is final");

            RemitException unknown = Check.refuses("not_found", () -> client.statusReport("PAY-00000000-0000000000"));
            Check.equal(404, ((RemitApiException) unknown).status(), "a payment the ledger does not hold has no report");
        }
    }

    // ── a client that only reads ──────────────────────────────────────────────

    static void testAReadOnlyClientInspectsAndReportsButSubmitsNoMessage() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            SwiftSubmission sent = client(platform).submitSwift(bytes("sample/pacs008"));
            int posts = platform.requests("POST").size();

            RemitClient reader = RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "Test Bank").readOnly().build();
            Check.isTrue(reader.inspectSwift(bytes("sample/pacs008")).issues().isEmpty(), "a read-only client reads a message");
            Check.equal("ACTC", reader.swiftStatus(sent.paymentId()).code(), "and a payment's status");
            Check.isTrue(reader.statusReport(sent.paymentId()).contains("<TxSts>ACTC</TxSts>"), "and writes its pacs.002");
            Check.fails(IllegalStateException.class, () -> reader.submitSwift(bytes("sample/pacs008")));
            Check.fails(IllegalStateException.class, () -> reader.submitSwift(new String(bytes("sample/pacs008"), StandardCharsets.UTF_8)));
            Check.fails(IllegalStateException.class, () -> reader.submitSwift(Swift.parse(bytes("sample/pacs008"), null)));
            Check.fails(IllegalStateException.class, () -> reader.instructionFromSwift(bytes("sample/pacs008")));
            Check.equal(posts, platform.requests("POST").size(), "it signed nothing and posted nothing");
        }
    }

    // ── bytes and text ────────────────────────────────────────────────────────

    static void testTheSameMessageAsBytesAndAsTextIsOnePayment() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer(standIn());
            RemitClient client = client(platform);
            for (String sample : Arrays.asList("sample/pacs008", "sample/pain001", "sample/mt103-structured")) {
                byte[] raw = bytes(sample);
                SwiftSubmission first = client.submitSwift(raw);
                SwiftSubmission second = client.submitSwift(new String(raw, StandardCharsets.UTF_8));
                Check.isTrue(!first.already() && second.already(), sample + ": sent once");
                Check.equal(first.paymentId(), second.paymentId(), sample + ": one payment, however the message is held");
            }
            Check.equal(3L, SwiftScenarioTest.count(platform.requests(), "POST", "/v1/settlements"), "three messages, three settlements");
            Map<String, Object> seen = new LinkedHashMap<>();
            for (StubPlatform.Request r : platform.requests("POST")) {
                if (SwiftScenarioTest.pathOf(r).equals("/v1/settlements")) {
                    seen.put((String) r.json().get("payment_id"), SwiftScenarioTest.object(bankInstruction(r.json()).get("sourceMessage")).get("type"));
                }
            }
            Check.equal(Arrays.asList("pacs.008.001.08", "pain.001.001.09", "MT103"), new ArrayList<>(seen.values()), "each instruction says what kind of message it came from");
        }
    }
}
