package com.stonehash.attest.remit;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The client against a stand-in platform: what it sends, what it signs, and
 * what it refuses to take for an answer.
 */
final class ClientTest {
    private static final String BANK = "VN-BANK-0001";

    private ClientTest() {
    }

    private static KeySigner newKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return Signers.fromPkcs8Pem("-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder().encodeToString(g.generateKeyPair().getPrivate().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
    }

    private static RemitClient client(StubPlatform platform, Signer signer) {
        return RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "Sample Bank").signer(signer).build();
    }

    private static Map<String, Object> map(Object... keyValues) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            out.put((String) keyValues[i], keyValues[i + 1]);
        }
        return out;
    }

    private static Map<String, Object> quoteFor(String amount) {
        return map("quote_id", "Q-1", "corridor", map("origin", "VN", "destination", "SG"),
                "trade", map("currency", "USD", "amount", amount),
                "settlement", map("asset", "USDC", "amount", "9990.00", "chain", "sandbox"),
                "collect", map("currency", "VND", "amount", "253000000", "rate", "25300", "rate_pair", "USD/VND"),
                "payout", map("currency", "SGD", "amount", "13400.00", "rate", "1.34", "rate_pair", "USD/SGD"),
                "fees", new ArrayList<>(), "quoted_at", "2026-11-18T00:00:00.000Z", "expires_at", "2026-11-18T00:15:00.000Z",
                "required_travel_rule_fields", new ArrayList<>(Arrays.asList("originator.name", "originator.country", "originator.address",
                        "originator.registration_number", "beneficiary.name", "beneficiary.country", "beneficiary.account", "beneficiary.bank")));
    }

    private static TradeParties parties() {
        return TradeParties.of(
                new TradeParties.Debtor().name("Saigon Import Co., Ltd.").country("VN").address("12 Le Loi, HCMC")
                        .registrationNumber("0312345678").account("VN-ACC-1"),
                new TradeParties.Creditor().name("Lion City Exports Pte. Ltd.").country("SG").account("SG-ACC-9").bank("Demo Payout Bank"));
    }

    private static Map<String, Object> settlement(String id, String state, String... eventTypes) {
        List<Object> events = new ArrayList<>();
        long seq = 1;
        for (String type : eventTypes) {
            events.add(map("seq", seq++, "type", type, "issuer", "platform", "at", "2026-11-18T00:00:00.000Z", "payload", map(), "sig", map()));
        }
        return map("payment_id", id, "state", state, "evidence_level", null, "evidence_available", Boolean.FALSE, "chain_tx", null,
                "attestation", null, "events", events);
    }

    // ── how a client is made ──────────────────────────────────────────────────

    static void testAClientNeedsAKeyUnlessItOnlyReads() throws Exception {
        KeySigner key = newKey();
        Check.fails(IllegalArgumentException.class, () -> RemitClient.builder().core("http://x").apiKey("k").institution(BANK, "B").build());
        Check.fails(IllegalArgumentException.class, () -> RemitClient.builder().core("http://x").apiKey("k").institution(BANK, "B").signer(key).readOnly().build());
        Check.fails(IllegalArgumentException.class, () -> RemitClient.builder().apiKey("k").institution(BANK, "B").signer(key).build());
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-1", "EVIDENCE_ANCHORED")));
            RemitClient reader = RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "B").readOnly().build();
            Check.equal("EVIDENCE_ANCHORED", reader.status("PAY-1").state(), "a read-only client reads");
            Check.fails(IllegalStateException.class, () -> reader.quote("1.00"));
            Check.fails(IllegalStateException.class, reader::publicKey);
            Check.fails(IllegalStateException.class, () -> reader.cancel("PAY-1", "x"));
            Check.fails(IllegalStateException.class, () -> reader.submit(map("payment_id", "PAY-1"), null));
            Check.equal(0, platform.requests("POST").size(), "and sends nothing but reads");
        }
    }

    // ── what counts as the platform's answer ──────────────────────────────────

    static void testOnlyThePlatformsOwnJsonIsAnAnswer() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            // A refusal in the platform's own words keeps its status and code.
            platform.answer((r) -> StubPlatform.Answer.json(409, map("error", "duplicate_payment", "message", "already there")));
            RemitException refused = Check.refuses("duplicate_payment", () -> client.status("PAY-1"));
            Check.equal(409, ((RemitApiException) refused).status(), "the platform's status");

            // An error page, a login wall, a redirect, a 200 that is not JSON: something in between answered.
            for (StubPlatform.Answer notOurs : Arrays.asList(
                    StubPlatform.Answer.text(503, "text/html", "<h1>Service Unavailable</h1>"),
                    StubPlatform.Answer.text(200, "text/html", "<html>please sign in</html>"),
                    StubPlatform.Answer.text(302, "text/plain", "").header("location", "http://127.0.0.1:1/elsewhere"),
                    StubPlatform.Answer.json(200, Arrays.asList(1, 2)),
                    StubPlatform.Answer.json(500, map("oops", "no error code")))) {
                platform.answer((r) -> notOurs);
                RemitException e = Check.refuses("not_a_platform_answer", () -> client.status("PAY-1"));
                Check.equal(502, ((RemitApiException) e).status(), "reported as not reached");
                Check.isTrue(e.getMessage().contains("nothing is taken to have happened"), e.getMessage());
            }
            // A settlement that is not one is not taken for one either.
            platform.answer((r) -> StubPlatform.Answer.json(200, map("ok", Boolean.TRUE)));
            Check.refuses("not_a_platform_answer", () -> client.status("PAY-1"));

            // A payment the organisation does not have is "not found", not an error, for find().
            platform.answer((r) -> StubPlatform.Answer.json(404, map("error", "not_found", "message", "no such settlement")));
            Check.equal(Optional.empty(), client.find("PAY-404"), "find() of an unknown payment");
            Check.isTrue(platform.requests().get(platform.requests().size() - 1).headers.get("authorization").equals("Bearer sk_test_x"), "the key travels as a bearer token");
        }
    }

    static void testNothingIsReachableIsSaidAsSuch() throws Exception {
        RemitClient client = RemitClient.builder().core("http://127.0.0.1:1").apiKey("sk_test_x").institution(BANK, "B").signer(newKey())
                .connectTimeout(Duration.ofSeconds(2)).requestTimeout(Duration.ofSeconds(2)).build();
        RemitException e = Check.refuses("unreachable", () -> client.status("PAY-1"));
        Check.equal(0, ((RemitApiException) e).status(), "no HTTP status when nothing answered");
    }

    // ── the bank's network ────────────────────────────────────────────────────

    static void testThePlatformIsReachedThroughTheBanksProxyWhenOneIsGiven() throws Exception {
        try (StubPlatform proxy = new StubPlatform()) {
            proxy.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-1", "EVIDENCE_ANCHORED")));
            java.net.URI at = java.net.URI.create(proxy.origin());
            // The platform's name does not resolve from here: only the proxy can be reached.
            RemitClient client = RemitClient.builder().core("http://platform.invalid").apiKey("sk_test_x").institution(BANK, "B").signer(newKey())
                    .proxy(at.getHost(), at.getPort()).build();
            Check.equal("EVIDENCE_ANCHORED", client.status("PAY-1").state(), "answered through the proxy");
            StubPlatform.Request seen = proxy.requests().get(0);
            Check.isTrue(seen.path.endsWith("/v1/settlements/PAY-1"), "the request the proxy was handed: " + seen.path);
            Check.equal("platform.invalid", seen.headers.get("host"), "for the platform's host");
            Check.isTrue(seen.headers.get("user-agent").startsWith("stonehash-attest-remit-java/"), "and it says which SDK is calling");

            // A client of the bank's own making is used as it is — unless it would follow a redirect.
            java.net.http.HttpClient own = java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.NEVER)
                    .proxy(java.net.ProxySelector.of(new java.net.InetSocketAddress(at.getHost(), at.getPort()))).build();
            RemitClient withOwn = RemitClient.builder().core("http://platform.invalid").apiKey("sk_test_x").institution(BANK, "B").signer(newKey())
                    .httpClient(own).build();
            Check.equal("EVIDENCE_ANCHORED", withOwn.status("PAY-1").state(), "the bank's own HttpClient");
            Check.fails(IllegalArgumentException.class, () -> RemitClient.builder().core("http://x").apiKey("k").institution(BANK, "B").signer(newKey())
                    .httpClient(java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.NORMAL).build()).build());
            Check.fails(IllegalArgumentException.class, () -> RemitClient.builder().core("http://x").apiKey("k").institution(BANK, "B").signer(newKey())
                    .httpClient(own).proxy("127.0.0.1", 1).build());
        }
    }

    static void testAnAnswerThatNeverFinishesOrNeverEndsDoesNotHoldTheCaller() throws Exception {
        // Something that answers with a first line and half a body, and then nothing more.
        try (java.net.ServerSocket stalled = new java.net.ServerSocket(0, 5, java.net.InetAddress.getLoopbackAddress())) {
            List<java.net.Socket> held = new ArrayList<>();
            AtomicInteger answered = new AtomicInteger();
            Thread server = new Thread(() -> {
                try {
                    for (;;) {
                        java.net.Socket socket = stalled.accept();
                        synchronized (held) {
                            held.add(socket);
                        }
                        // The request's head ends at the first empty line.
                        java.io.InputStream in = socket.getInputStream();
                        StringBuilder head = new StringBuilder();
                        for (int b = in.read(); b >= 0; b = in.read()) {
                            head.append((char) b);
                            if (head.length() >= 4 && head.substring(head.length() - 4).equals("\r\n\r\n")) {
                                break;
                            }
                        }
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n"
                                + "{\"payment_id\":\"PAY-1\",").getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().flush();
                        answered.incrementAndGet();
                    }
                } catch (java.io.IOException closed) {
                    // the test is over
                }
            });
            server.setDaemon(true);
            server.start();
            RemitClient client = RemitClient.builder().core("http://127.0.0.1:" + stalled.getLocalPort()).apiKey("sk_test_x").institution(BANK, "B")
                    .signer(newKey()).requestTimeout(Duration.ofMillis(400)).build();
            long started = System.nanoTime();
            RemitException e = Check.refuses("unreachable", () -> client.submit(map("payment_id", "PAY-1"), null));
            long took = (System.nanoTime() - started) / 1_000_000;
            Check.isTrue(took < 3000, "a write is given up on at the request timeout, not held for good: " + took + " ms");
            Check.isTrue(e.getMessage().contains("no complete answer within 400 ms"), e.getMessage());
            Check.equal(1, answered.get(), "the answer had begun — its first line and half a body were sent — and a write was not sent twice");
            synchronized (held) {
                for (java.net.Socket socket : held) {
                    socket.close();
                }
            }
        }
        // Something that answers without end: given up on, not collected into memory.
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            char[] filler = new char[17 * 1024 * 1024];
            Arrays.fill(filler, ' ');
            String endless = "{\"payment_id\":\"PAY-1\"," + new String(filler) + "\"state\":\"EVIDENCE_ANCHORED\",\"events\":[]}";
            platform.answer((r) -> StubPlatform.Answer.text(200, "application/json", endless));
            RemitException e = Check.refuses("not_a_platform_answer", () -> client.status("PAY-1"));
            Check.isTrue(e.getMessage().contains("more than 16 MiB"), e.getMessage());
            // The same answer at a size the platform's own can have is read as it always was.
            platform.answer((r) -> StubPlatform.Answer.text(200, "application/json", endless.replace(new String(filler), new String(filler, 0, 1024 * 1024))));
            Check.equal("EVIDENCE_ANCHORED", client.status("PAY-1").state(), "a megabyte of answer is read");
        }
    }

    // ── the registry ──────────────────────────────────────────────────────────

    static void testTheKeyIsCheckedAgainstTheRegistryBeforeAnythingIsSigned() throws Exception {
        KeySigner key = newKey();
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, key);
            platform.answer((r) -> StubPlatform.Answer.json(200, map("institutions", Arrays.asList(map("id", BANK, "signing_spki", key.publicKeySpkiBase64())))));
            client.assertRegistered();
            Check.equal(key.publicKeySpkiBase64(), client.publicKey(), "the client's public key is its signer's");

            String other = newKey().publicKeySpkiBase64();
            RemitClient stranger = client(platform, newKey());
            platform.answer((r) -> StubPlatform.Answer.json(200, map("institutions", Arrays.asList(map("id", BANK, "signing_spki", other)))));
            Check.refuses("key_mismatch", stranger::assertRegistered);
            RemitClient unknown = client(platform, newKey());
            platform.answer((r) -> StubPlatform.Answer.json(200, map("institutions", new ArrayList<>())));
            Check.refuses("institution_unregistered", unknown::assertRegistered);
        }
    }

    // ── the quote ─────────────────────────────────────────────────────────────

    static void testAQuoteIsCheckedToBeWhatWasAskedFor() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            platform.answer((r) -> StubPlatform.Answer.json(200, quoteFor("10000.00")));
            Quote quote = client.quote("10000");
            Check.equal("Q-1", quote.quoteId(), "the quote");
            Check.equal("10000.00", quote.tradeAmount(), "the same amount, written with its cents");
            Map<String, Object> asked = platform.requests("POST").get(0).json();
            Check.equal(map("corridor", map("origin", "VN", "destination", "SG"), "trade", map("currency", "USD", "amount", "10000"),
                    "collect", map("currency", "VND"), "payout", map("currency", "SGD")), asked, "what was asked");

            // Another amount, another currency, another route: nothing is signed on it.
            platform.answer((r) -> StubPlatform.Answer.json(200, quoteFor("100000.00")));
            RemitException e = Check.refuses("quote_mismatch", () -> client.quote("10000.00"));
            Check.isTrue(e.getMessage().contains("nothing was signed"), e.getMessage());
            Map<String, Object> rerouted = quoteFor("10000.00");
            rerouted.put("corridor", map("origin", "VN", "destination", "HK"));
            platform.answer((r) -> StubPlatform.Answer.json(200, rerouted));
            Check.refuses("quote_mismatch", () -> client.quote("10000.00"));
            platform.answer((r) -> StubPlatform.Answer.json(200, map("ok", Boolean.TRUE)));
            Check.refuses("not_a_platform_answer", () -> client.quote("10000.00"));

            // The amounts are compared as the decimal text they are — exactly, and only when both are plain decimals.
            for (String[] same : new String[][] { { "10000", "10000.00" }, { "10000.5", "10000.50" }, { "010000.00", "10000" }, { "0.10", "0.1" },
                    { "99999999999999999999.01", "99999999999999999999.010" } }) {
                platform.answer((r) -> StubPlatform.Answer.json(200, quoteFor(same[1])));
                Check.equal(same[1], client.quote(same[0]).tradeAmount(), same[0] + " asked, " + same[1] + " quoted: the same amount");
            }
            for (String[] other : new String[][] { { "10000.00", "10000.01" }, { "99999999999999999999.01", "99999999999999999999.02" },
                    { "10000.00", "1e4" }, { "10000.00", "+10000.00" }, { "10000.00", " 10000.00" }, { "10000.00", "10,000.00" }, { "10000.00", "10000." },
                    { "1e4", "10000.00" }, { " 10000.00", "10000.00" }, { "-1", "-1" } }) {
                platform.answer((r) -> StubPlatform.Answer.json(200, quoteFor(other[1])));
                Check.refuses("quote_mismatch", () -> client.quote(other[0]));
            }
            Check.equal(0, RemitClient.compareDecimal("7000.5", "7000.50"), "equal");
            Check.equal(-1, RemitClient.compareDecimal("999.99", "1000"), "fewer whole digits is less");
            Check.equal(1, RemitClient.compareDecimal("12500.01", "12500.009"), "digit by digit after the point");
            Check.equal(null, RemitClient.compareDecimal("12500.00\n", "12500.00"), "a line break is not part of an amount");
        }
    }

    // ── the instruction ───────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    static void testAnInstructionCarriesFourSignaturesOverExactlyWhatItSays() throws Exception {
        KeySigner key = newKey();
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, key);
            Quote quote = new Quote(quoteFor("10000.00"));
            Instruction instruction = client.buildInstruction(quote, parties(), new InstructionOptions()
                    .invoiceRef("INV-2026-0457").instructionRef("OUT-2026-000123")
                    .review(new InstructionOptions.Review().kybPolicyVersion("2026.3").regulatorReportRef("RPT-0457").approvedByRole("Trade Operations")));
            Check.equal(0, platform.requests().size(), "building an instruction (mode A) contacts nobody");
            Check.isTrue(instruction.paymentId().matches("PAY-\\d{8}-[0-9a-f]{10}"), "the drawn payment id: " + instruction.paymentId());

            Map<String, Object> body = instruction.body();
            String id = instruction.paymentId();
            Check.equal(Arrays.asList("request_id", "payment_id", "quote_id", "corridor", "amount", "commercial_reference", "beneficiary",
                    "bank_authorization", "bank_signature", "compliance_payload", "evidence_elements"), new ArrayList<>(body.keySet()), "the body's fields");
            Check.equal("REQ-" + id, body.get("request_id"), "request id");
            Check.equal(map("collected", map("currency", "VND", "value", "253000000"), "payout", map("currency", "SGD", "value", "13400.00")),
                    body.get("amount"), "the two legs, as the quote states them");
            Check.equal(map("invoice_ref", "INV-2026-0457", "invoice_commitment",
                    Hex.sha256Hex("INV-2026-0457|10000.00 USD|Saigon Import Co., Ltd.")), body.get("commercial_reference"), "the invoice commitment");
            Check.equal(map("institution_id", "SG-BFI-001", "beneficiary_ref", "BEN-" + id), body.get("beneficiary"), "the beneficiary institution");

            Map<String, Object> authorization = (Map<String, Object>) body.get("bank_authorization");
            Check.equal(BANK, authorization.get("bank_id"), "who authorizes");
            Check.equal("OUT-2026-000123", authorization.get("instruction_ref"), "the bank's own reference");
            Check.equal("RCPT-" + id, authorization.get("fiat_received_ref"), "the default receipt reference");
            Check.equal("2026.3", authorization.get("kyb_policy_version"), "the review, as given");
            Check.equal("AUTHORIZED", authorization.get("payment_release"), "the release");
            Check.isTrue(((String) authorization.get("approved_at")).matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z"), "a time with milliseconds, in UTC");
            Check.isTrue(Signing.verifyEvent(authorization, body.get("bank_signature"), key.publicKeySpkiBase64()), "the authorization is signed by the bank");
            Check.equal("Sample Bank", ((Map<String, Object>) body.get("bank_signature")).get("issuer"), "under the bank's name");

            Map<String, Object> elements = (Map<String, Object>) body.get("evidence_elements");
            Check.equal(Arrays.asList("bankInstruction", "bankApproval", "commercialDocs"), new ArrayList<>(elements.keySet()), "the three elements");
            for (Object element : elements.values()) {
                Check.isTrue(Signing.verifyElement((Map<String, Object>) element, key.publicKeySpkiBase64()), "every element's digest and signature hold");
                Check.equal(BANK, ((Map<String, Object>) ((Map<String, Object>) element).get("signature")).get("keyId"), "signed as the institution");
            }
            Map<String, Object> bankInstruction = (Map<String, Object>) elements.get("bankInstruction");
            Check.equal(Arrays.asList("Dbtr", "Cdtr", "InstdAmt", "Ccy", "RmtInf", "INV-2026-0457"), bankInstruction.get("iso20022Fields"), "the fields it declares, then the invoice");
            Check.equal("Saigon Import Co., Ltd.", bankInstruction.get("debtor"), "the debtor, by name");
            Check.isTrue(!bankInstruction.containsKey("sourceMessage"), "no source message when there was none");
            Map<String, Object> approval = (Map<String, Object>) elements.get("bankApproval");
            Check.equal(map("pair", "USD/VND", "rate", "25300", "quotedAt", "2026-11-18T00:00:00.000Z", "validUntil", "2026-11-18T00:15:00.000Z"),
                    approval.get("fxQuote"), "the quote the approval was given on");
            Check.equal(map("format", "IVMS101-2023", "mode", "A", "originator", parties().debtor(), "beneficiary", parties().creditor(),
                    "purpose_code", "GOODS_PAYMENT"), body.get("compliance_payload"), "Travel Rule mode A: the party fields, for the platform to encrypt");

            // Made from a message: its reference is signed into the instruction, and its UETR into the authorization.
            Map<String, Object> source = map("type", "pacs.008.001.08", "sha256", "ab".repeat(32), "uetr", "8a562c67-ca16-48ba-b074-65581be6f001");
            Instruction fromMessage = client.buildInstruction(quote, parties(), new InstructionOptions().paymentId("PAY-8a562c67-0123456789")
                    .source(source).messageFields(Arrays.asList("Dbtr", "UETR")));
            Map<String, Object> el = (Map<String, Object>) ((Map<String, Object>) fromMessage.body().get("evidence_elements")).get("bankInstruction");
            Check.equal(source, el.get("sourceMessage"), "the source message reference");
            Check.equal("8a562c67-ca16-48ba-b074-65581be6f001", ((Map<String, Object>) fromMessage.body().get("bank_authorization")).get("uetr"), "the UETR");
            Check.isTrue(Signing.verifyElement(el, key.publicKeySpkiBase64()), "and the signature covers it");
            Check.equal("PAY-8a562c67-0123456789", fromMessage.paymentId(), "a given payment id is kept");
        }
    }

    static void testPartiesThatLackARequiredFieldAreRefusedBeforeAnythingIsSigned() throws Exception {
        AtomicInteger signed = new AtomicInteger();
        KeySigner key = newKey();
        Signer counting = Signers.external(key.publicKeySpkiBase64(), (message) -> {
            signed.incrementAndGet();
            return key.sign(message);
        });
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, counting);
            Quote quote = new Quote(quoteFor("10000.00"));
            TradeParties lacking = TradeParties.of(
                    new TradeParties.Debtor().name("Saigon Import Co., Ltd.").country("VN").registrationNumber("0312345678"),
                    new TradeParties.Creditor().name("Lion City Exports Pte. Ltd.").country("SG").account("  ").bank("Demo Payout Bank"));
            RemitException e = Check.refuses("travel_rule_incomplete", () -> client.buildInstruction(quote, lacking));
            Check.isTrue(e.getMessage().contains("originator.address, beneficiary.account"), e.getMessage());
            Check.isTrue(e.getMessage().contains("nothing was signed"), e.getMessage());
            Check.equal(0, signed.get(), "the key was not asked for anything");
            Check.equal(0, platform.requests().size(), "and nothing was sent");

            // The fields are written in the instruction's order whatever order they were given in, and the optional one may be absent.
            TradeParties.Debtor debtor = new TradeParties.Debtor().registrationNumber("0312345678").address("12 Le Loi, HCMC").country("VN").name("Saigon Import Co., Ltd.");
            TradeParties whole = TradeParties.of(debtor, new TradeParties.Creditor().bank("Demo Payout Bank").account("SG-ACC-9").country("SG").name("Lion City Exports Pte. Ltd."));
            Check.equal(Arrays.asList("name", "country", "address", "registration_number"), new ArrayList<>(whole.debtor().keySet()), "the debtor's fields, in order");
            Check.equal(Arrays.asList("name", "country", "account", "bank"), new ArrayList<>(whole.creditor().keySet()), "the creditor's fields, in order");
            debtor.name("Changed Afterwards Ltd.");
            Check.equal("Saigon Import Co., Ltd.", whole.debtor().get("name"), "parties do not change after they are made");
            client.buildInstruction(quote, whole);
            Check.equal(4, signed.get(), "complete parties: three elements and the authorization are signed");
        }
    }

    // ── submitting and following ──────────────────────────────────────────────

    static void testSubmittingIsAcceptedOnlyWhenThePlatformNamesThePayment() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            Instruction instruction = client.buildInstruction(new Quote(quoteFor("10000.00")), parties());
            platform.answer((r) -> StubPlatform.Answer.json(201, map("payment_id", instruction.paymentId(), "state", "BANK_AUTHORIZED")));
            Check.equal("BANK_AUTHORIZED", client.submit(instruction).state(), "accepted");
            StubPlatform.Request sent = platform.requests("POST").get(0);
            Check.equal("/v1/settlements", sent.path, "where it goes");
            Check.equal("sdk-" + instruction.paymentId(), sent.headers.get("idempotency-key"), "the default idempotency key");
            Check.equal(instruction.body(), sent.json(), "what was sent is the instruction, whole");
            client.submit(instruction.body(), "swift-" + instruction.paymentId());
            Check.equal("swift-" + instruction.paymentId(), platform.requests("POST").get(1).headers.get("idempotency-key"), "a given idempotency key");

            platform.answer((r) -> StubPlatform.Answer.json(201, map("payment_id", "PAY-OTHER", "state", "BANK_AUTHORIZED")));
            Check.refuses("not_a_platform_answer", () -> client.submit(instruction));
            platform.answer((r) -> StubPlatform.Answer.json(200, map("status", "ok")));
            Check.refuses("not_a_platform_answer", () -> client.submit(instruction));
        }
    }

    static void testTheLedgerIsAskedByExactReferenceAndARefusalNamesTheSettlementThatStands() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            platform.answer((r) -> StubPlatform.Answer.json(200, map("data", new ArrayList<>(), "page", map("total", 0L, "returned", 0L, "next_cursor", null))));
            Map<String, String> filters = new LinkedHashMap<>();
            filters.put("limit", "50");
            filters.put("source_value_date", "2026-11-17");
            filters.put("source_content", "ab".repeat(32));
            filters.put("source_uetr", "3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10");
            filters.put("q", "PO 7781/a&b");
            filters.put("no_such_filter", "x");
            client.list(filters);
            Check.equal("/v1/settlements?q=PO%207781%2Fa%26b&source_uetr=3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10&source_content=" + "ab".repeat(32)
                    + "&source_value_date=2026-11-17&limit=50", platform.requests("GET").get(0).path,
                    "the filters the platform knows, in one order whatever order they were given in; a filter it does not know is not sent");
            client.list(null);
            Check.equal("/v1/settlements", platform.requests("GET").get(1).path, "no filter is no query");

            // A refusal that names the settlement which already stands for the message hands the id over as a value,
            // and the ground the platform took the two for one payment on.
            platform.answer((r) -> StubPlatform.Answer.json(409, map("existing_payment_id", "PAY-3f1c9a52-175c822e37", "ground", "uetr",
                    "error", "duplicate_source_message",
                    "message", "this message's payment is already settlement PAY-3f1c9a52-175c822e37 — the same UETR")));
            RemitApiException duplicate = (RemitApiException) Check.refuses("duplicate_source_message", () -> client.submit(map("payment_id", "PAY-OTHER-1"), null));
            Check.equal("PAY-3f1c9a52-175c822e37", duplicate.existingPaymentId(), "the settlement already there");
            Check.equal("uetr", duplicate.ground(), "and on what ground");
            Check.equal(409, duplicate.status(), "refused, as the platform refuses");
            platform.answer((r) -> StubPlatform.Answer.json(409, map("existing_payment_id", 7L, "ground", 7L, "error", "duplicate_payment", "message", "exists")));
            RemitApiException taken = (RemitApiException) Check.refuses("duplicate_payment", () -> client.submit(map("payment_id", "PAY-OTHER-1"), null));
            Check.equal(null, taken.existingPaymentId(), "an id that is not text is not taken for one");
            Check.equal(null, taken.ground(), "nor a ground that is not text");
            platform.answer((r) -> StubPlatform.Answer.json(409, map("error", "duplicate_payment", "message", "exists")));
            Check.equal(null, ((RemitApiException) Check.refuses("duplicate_payment", () -> client.submit(map("payment_id", "PAY-OTHER-1"), null))).ground(),
                    "a refusal that names no ground has none");
        }
    }

    static void testTrackingStopsWhereThePipelineStops() throws Exception {
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            AtomicInteger asked = new AtomicInteger();
            platform.answer((r) -> {
                int n = asked.incrementAndGet();
                return StubPlatform.Answer.json(200, n < 3 ? settlement("PAY-1", "BANK_AUTHORIZED")
                        : n < 5 ? settlement("PAY-1", "PAYOUT_IN_PROGRESS") : settlement("PAY-1", "EVIDENCE_ANCHORED"));
            });
            List<String> seen = new ArrayList<>();
            Settlement done = client.track("PAY-1", Duration.ofSeconds(10), Duration.ofMillis(5), (state, view) -> seen.add(state));
            Check.equal("EVIDENCE_ANCHORED", done.state(), "followed to the end");
            Check.isTrue(done.isFinal(), "which is final");
            Check.equal(Arrays.asList("BANK_AUTHORIZED", "PAYOUT_IN_PROGRESS", "EVIDENCE_ANCHORED"), seen, "each state reported once, in order");

            // A request for information pauses the pipeline: tracking returns so the bank can answer.
            platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-2", "TRAVEL_RULE_PENDING", "REQUEST_ACCEPTED", "TRAVEL_RULE_RFI")));
            Check.equal("TRAVEL_RULE_PENDING", client.track("PAY-2", Duration.ofSeconds(5), Duration.ofMillis(5), null).state(), "paused on a request for information");
            // The question is open as long as the last one asked has no answer after it: a second question, put after an
            // earlier answer, waits for the bank as much as the first did — and one that was answered, accepted or refused does not.
            platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-2", "TRAVEL_RULE_PENDING",
                    "TRAVEL_RULE_RFI", "TRAVEL_RULE_RFI_RESOLVED", "TRAVEL_RULE_RECEIVED", "TRAVEL_RULE_RFI")));
            Settlement askedAgain = client.track("PAY-2", Duration.ofSeconds(5), Duration.ofMillis(5), null);
            Check.isTrue(askedAgain.travelRuleQuestionOpen(), "a question asked again after an answer is open");
            for (String closing : Arrays.asList("TRAVEL_RULE_RFI_RESOLVED", "TRAVEL_RULE_RECEIVED", "TRAVEL_RULE_REJECTED")) {
                platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-2", "TRAVEL_RULE_PENDING", "TRAVEL_RULE_RFI", closing)));
                Check.refuses("tracking_timeout", () -> client.track("PAY-2", Duration.ofMillis(60), Duration.ofMillis(10), null));
                Check.isTrue(!client.status("PAY-2").travelRuleQuestionOpen(), "after " + closing + " nothing waits for the bank");
            }
            platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-3", "PAYOUT_IN_PROGRESS", "EVIDENCE_INSUFFICIENT")));
            Check.equal("PAYOUT_IN_PROGRESS", client.track("PAY-3", Duration.ofSeconds(5), Duration.ofMillis(5), null).state(), "paused on an evidence hold");
            for (String terminal : Arrays.asList("CANCELLED", "RETURNED", "EXCEPTION")) {
                platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-4", terminal)));
                Check.equal(terminal, client.track("PAY-4", Duration.ofSeconds(5), Duration.ofMillis(5), null).state(), "a terminal state");
            }
            platform.answer((r) -> StubPlatform.Answer.json(200, settlement("PAY-5", "BANK_AUTHORIZED")));
            Check.refuses("tracking_timeout", () -> client.track("PAY-5", Duration.ofMillis(60), Duration.ofMillis(10), null));
        }
    }

    static void testCancellingAnsweringAndTheManifestAreSignedEvents() throws Exception {
        KeySigner key = newKey();
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, key);
            platform.answer((r) -> StubPlatform.Answer.json(200, map("payment_id", "PAY-1", "state", "CANCELLED", "accepted", Boolean.TRUE)));
            client.cancel("PAY-1", "customer request");
            Map<String, Object> cancel = platform.requests("POST").get(0).json();
            Check.equal("/v1/settlements/PAY-1/cancel", platform.requests("POST").get(0).path, "where a cancellation goes");
            Check.isTrue(Signing.verifyEvent(map("payment_id", "PAY-1", "reason", "customer request"), cancel.get("sig"), key.publicKeySpkiBase64()),
                    "the cancellation is signed over the payment and the reason");

            Map<String, String> answers = new LinkedHashMap<>();
            answers.put("originator_address", "12 Le Loi, HCMC");
            client.answerRfi("PAY-1", answers);
            Map<String, Object> rfi = platform.requests("POST").get(1).json();
            Check.isTrue(Signing.verifyEvent(map("payment_id", "PAY-1", "answers", map("originator_address", "12 Le Loi, HCMC")), rfi.get("sig"), key.publicKeySpkiBase64()),
                    "the answers are signed with the payment they answer for");

            client.submitDailyManifest("2026-11-18", Arrays.asList("PAY-1", "PAY-2"));
            Map<String, Object> manifest = platform.requests("POST").get(2).json();
            Check.equal(map("date", "2026-11-18", "institution_id", BANK, "payment_ids", Arrays.asList("PAY-1", "PAY-2"), "count", 2L),
                    manifest.get("manifest"), "the day's manifest");
            Check.isTrue(Signing.verifyEvent(manifest.get("manifest"), manifest.get("sig"), key.publicKeySpkiBase64()), "signed whole");
        }
    }

    static void testAWebhookIsActedOnOnlyWhenThePlatformSignedIt() throws Exception {
        KeySigner platformKey = newKey();
        try (StubPlatform platform = new StubPlatform()) {
            RemitClient client = client(platform, newKey());
            platform.answer((r) -> StubPlatform.Answer.json(200, map("platform_signer", map("key_id", "platform", "spki", platformKey.publicKeySpkiBase64()), "institutions", new ArrayList<>())));
            Map<String, Object> envelope = map("event_id", "evt-1", "payment_id", "PAY-1", "sequence", 4L, "type", "PAYOUT_COMPLETED",
                    "state", "BENEFICIARY_CREDIT_CONFIRMED", "occurred_at", "2026-11-18T00:00:00.000Z", "data", map("bank_ref", "X-1"));
            String delivery = Json.compact(map("envelope", envelope, "signature", Signing.signEvent(platformKey, envelope, "platform", "StoneHash")));
            Check.equal(Optional.of(envelope), client.verifyWebhook(delivery), "a delivery the platform signed");
            Check.equal(Optional.empty(), client.verifyWebhook(delivery.replace("PAYOUT_COMPLETED", "PAYOUT_FAILED")), "a changed delivery");
            Check.equal(Optional.empty(), client.verifyWebhook(Json.compact(map("envelope", envelope, "signature", Signing.signEvent(newKey(), envelope, "platform", "x")))), "another signer");
            Check.equal(Optional.empty(), client.verifyWebhook("{\"envelope\":{}}"), "no signature");
            Check.equal(Optional.empty(), client.verifyWebhook("not json"), "not JSON");
            Check.equal(1, platform.requests("GET").size(), "the registry was asked once for all of these");
        }
    }

    // ── Travel Rule mode B ────────────────────────────────────────────────────

    private static byte[] fixed32(BigInteger n) {
        byte[] raw = n.toByteArray();
        byte[] out = new byte[32];
        int from = Math.max(0, raw.length - 32);
        System.arraycopy(raw, from, out, 32 - (raw.length - from), raw.length - from);
        return out;
    }

    /** Opens a compact JWE (ECDH-ES, A256GCM) with the recipient's key pair, as the beneficiary institution would. */
    private static byte[] open(String jwe, KeyPair recipient) throws Exception {
        String[] parts = jwe.split("\\.", -1);
        Check.equal(5, parts.length, "five parts");
        Check.equal("", parts[1], "no encrypted key: direct key agreement");
        Map<String, Object> header = Json.object(Json.parse(new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8)), "x", "header");
        Check.equal("ECDH-ES", header.get("alg"), "alg");
        Check.equal("A256GCM", header.get("enc"), "enc");
        Map<String, Object> epk = Json.object(header.get("epk"), "x", "epk");
        java.security.PublicKey ephemeral = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(
                new ECPoint(new BigInteger(1, Base64.getUrlDecoder().decode((String) epk.get("x"))),
                        new BigInteger(1, Base64.getUrlDecoder().decode((String) epk.get("y")))),
                ((ECPublicKey) recipient.getPublic()).getParams()));
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(recipient.getPrivate());
        agreement.doPhase(ephemeral, true);
        java.security.MessageDigest sha = java.security.MessageDigest.getInstance("SHA-256");
        sha.update(new byte[] { 0, 0, 0, 1 });
        sha.update(agreement.generateSecret());
        byte[] enc = "A256GCM".getBytes(StandardCharsets.UTF_8);
        sha.update(ByteBuffer.allocate(4 + enc.length).putInt(enc.length).put(enc).array());
        sha.update(new byte[8]);
        sha.update(ByteBuffer.allocate(4).putInt(256).array());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(sha.digest(), "AES"), new GCMParameterSpec(128, Base64.getUrlDecoder().decode(parts[2])));
        cipher.updateAAD(parts[0].getBytes(StandardCharsets.US_ASCII));
        cipher.update(Base64.getUrlDecoder().decode(parts[3]));
        return cipher.doFinal(Base64.getUrlDecoder().decode(parts[4]));
    }

    @SuppressWarnings("unchecked")
    static void testModeBEncryptsThePartyDataToTheBeneficiaryInstitutionAndSignsWhichMessageItWas() throws Exception {
        KeySigner key = newKey();
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair bfi = g.generateKeyPair();
        ECPoint w = ((ECPublicKey) bfi.getPublic()).getW();
        Map<String, Object> jwk = map("kty", "EC", "crv", "P-256",
                "x", Base64.getUrlEncoder().withoutPadding().encodeToString(fixed32(w.getAffineX())),
                "y", Base64.getUrlEncoder().withoutPadding().encodeToString(fixed32(w.getAffineY())));
        Map<String, Object> meta = map("institutions", Arrays.asList(
                map("id", BANK, "role", "COLLECTION_BANK", "name", "Sample Bank Registered", "country", "VN", "signing_spki", key.publicKeySpkiBase64()),
                map("id", "SG-BFI-001", "role", "BENEFICIARY_INSTITUTION", "name", "Lion Payments", "country", "SG", "encryption_jwk", jwk),
                map("id", "SG-SETTLE-001", "role", "SETTLEMENT_ENTITY", "name", "Settle Co")));
        try (StubPlatform platform = new StubPlatform()) {
            platform.answer((r) -> StubPlatform.Answer.json(200, meta));
            RemitClient client = RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "Sample Bank").signer(key)
                    .beneficiaryKey("SG-BFI-001", TravelRule.jwkThumbprint(jwk)).build();
            Quote quote = new Quote(quoteFor("10000.00"));
            Instruction instruction = client.buildInstruction(quote, parties(), new InstructionOptions().paymentId("PAY-20261118-abc123")
                    .travelRule(InstructionOptions.TravelRule.B));
            Map<String, Object> payload = (Map<String, Object>) instruction.body().get("compliance_payload");
            Check.equal(Arrays.asList("format", "mode", "ciphertext", "ivms101_digest", "fields_assertion"), new ArrayList<>(payload.keySet()), "what leaves in mode B");
            Check.equal("B", payload.get("mode"), "mode");
            String sent = Json.compact(instruction.body().get("compliance_payload"));
            Check.isTrue(!sent.contains("0312345678") && !sent.contains("VN-ACC-1") && !sent.contains("12 Le Loi"),
                    "neither the registration number, the account nor the address is in what the platform relays");

            // The beneficiary institution opens it, and finds the message the digest names.
            String ciphertext = (String) payload.get("ciphertext");
            Map<String, Object> message = Json.object(Json.parse(new String(open(ciphertext, bfi), StandardCharsets.UTF_8)), "x", "message");
            Check.equal(payload.get("ivms101_digest"), Hex.sha256Hex(Json.canonicalBytes(message)), "the digest is of the message inside");
            Check.equal("IVMS101-2023", message.get("schema"), "schema");
            Map<String, Object> underlying = (Map<String, Object>) message.get("underlyingPayment");
            Check.equal(map("institutionId", BANK, "name", "Sample Bank Registered", "country", "VN"), underlying.get("originatingInstitution"),
                    "the instructing bank, as the registry names it");
            Check.equal("Demo Payout Bank", underlying.get("beneficiaryLocalBank"), "the creditor's bank");
            Check.equal(map("amount", "10000.00", "currency", "USD", "purposeCode", "GOODS_PAYMENT"), underlying.get("transaction"), "the trade payment");
            Map<String, Object> originator = (Map<String, Object>) ((List<Object>) ((Map<String, Object>) underlying.get("originator")).get("originatorPersons")).get(0);
            Check.equal(Arrays.asList("VN-ACC-1"), originator.get("accountNumber"), "the debtor's account travels inside");
            Map<String, Object> person = (Map<String, Object>) originator.get("legalPerson");
            Check.equal(map("nationalIdentifier", "0312345678", "nationalIdentifierType", "RAID"), person.get("nationalIdentification"), "a registration number is typed RAID");
            Map<String, Object> beneficiary = (Map<String, Object>) ((List<Object>) ((Map<String, Object>) underlying.get("beneficiary")).get("beneficiaryPersons")).get(0);
            Check.isTrue(!Json.compact(beneficiary).contains("\"bank\""), "the creditor's bank is not a field of the person");
            Check.equal(map("originatingVasp", map("institutionId", "SG-SETTLE-001", "name", "Settle Co"),
                    "beneficiaryVasp", map("institutionId", "SG-BFI-001", "name", "Lion Payments", "country", "SG"),
                    "transaction", map("amount", "9990.00", "currency", "USDC")), message.get("settlementLeg"), "the settlement leg");

            // What the bank put its key to: which message, and which ciphertext.
            Map<String, Object> assertion = (Map<String, Object>) payload.get("fields_assertion");
            Check.equal(map("payment_id", "PAY-20261118-abc123", "required_fields_present", Boolean.TRUE, "field_count", 8L, "schema", "IVMS101-2023",
                    "ivms101_digest", payload.get("ivms101_digest"), "ciphertext_sha256", Hex.sha256Hex(ciphertext)), assertion.get("payload"), "the assertion");
            Check.isTrue(Signing.verifyEvent(assertion.get("payload"), assertion.get("sig"), key.publicKeySpkiBase64()), "signed by the bank");

            // A registry key that is not the one the bank expects is refused, and nothing is encrypted to it.
            RemitClient pinnedElsewhere = RemitClient.builder().core(platform.origin()).apiKey("sk_test_x").institution(BANK, "Sample Bank").signer(key)
                    .beneficiaryKey("SG-BFI-001", "not-that-key").build();
            RemitException e = Check.refuses("bfi_key_mismatch", () -> pinnedElsewhere.buildInstruction(quote, parties(),
                    new InstructionOptions().travelRule(InstructionOptions.TravelRule.B)));
            Check.isTrue(e.getMessage().contains("nothing was encrypted"), e.getMessage());
            Check.refuses("bfi_has_no_encryption_key", () -> client.buildInstruction(quote, parties(),
                    new InstructionOptions().beneficiaryInstitution("SG-BFI-999").travelRule(InstructionOptions.TravelRule.B)));
        }
    }

    // ── one client, many threads ──────────────────────────────────────────────

    /** A service keeps one client and calls it from every request thread at once. */
    @SuppressWarnings("unchecked")
    static void testOneClientIsSharedByManyThreads() throws Exception {
        KeySigner key = newKey();
        KeySigner platformKey = newKey();
        try (StubPlatform platform = new StubPlatform()) {
            AtomicInteger registryAsked = new AtomicInteger();
            platform.answer((r) -> {
                if (r.path.equals("/v1/remit/meta")) {
                    registryAsked.incrementAndGet();
                    return StubPlatform.Answer.json(200, map("platform_signer", map("key_id", "platform", "spki", platformKey.publicKeySpkiBase64()),
                            "institutions", Arrays.asList(map("id", BANK, "signing_spki", key.publicKeySpkiBase64()))));
                }
                if (r.path.equals("/v1/quotes")) {
                    Map<String, Object> trade = (Map<String, Object>) r.json().get("trade");
                    return StubPlatform.Answer.json(200, quoteFor((String) trade.get("amount")));
                }
                Map<String, Object> body = r.json();
                return StubPlatform.Answer.json(201, map("payment_id", body.get("payment_id"), "state", "BANK_AUTHORIZED"));
            });
            RemitClient client = client(platform, key);
            Map<String, Object> envelope = map("event_id", "evt-1", "payment_id", "PAY-1", "sequence", 1L, "type", "BANK_AUTHORIZED",
                    "state", "BANK_AUTHORIZED", "occurred_at", "2026-11-18T00:00:00.000Z", "data", map());
            String delivery = Json.compact(map("envelope", envelope, "signature", Signing.signEvent(platformKey, envelope, "platform", "StoneHash")));

            int threads = 12;
            int each = 6;
            java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(threads);
            java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
            List<java.util.concurrent.Future<List<String>>> work = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                final int thread = t;
                work.add(pool.submit(() -> {
                    start.await();
                    List<String> ids = new ArrayList<>();
                    for (int i = 0; i < each; i++) {
                        String amount = (1000 + thread * 100 + i) + ".00";
                        Quote quote = client.quote(amount);
                        Check.equal(amount, quote.tradeAmount(), "each thread gets the quote it asked for");
                        Instruction instruction = client.buildInstruction(quote, parties());
                        Map<String, Object> body = instruction.body();
                        Check.isTrue(Signing.verifyEvent(body.get("bank_authorization"), body.get("bank_signature"), key.publicKeySpkiBase64()),
                                "the authorization verifies");
                        for (Object element : ((Map<String, Object>) body.get("evidence_elements")).values()) {
                            Map<String, Object> el = (Map<String, Object>) element;
                            Check.isTrue(Signing.verifyElement(el, key.publicKeySpkiBase64()), "every element verifies");
                        }
                        Check.equal(amount, ((Map<String, Object>) ((Map<String, Object>) body.get("evidence_elements")).get("bankInstruction")).get("amount"),
                                "and carries this thread's amount, not another's");
                        Check.equal(instruction.paymentId(), client.submit(instruction).paymentId(), "accepted as itself");
                        Check.isTrue(client.verifyWebhook(delivery).isPresent(), "a delivery verifies on any thread");
                        ids.add(instruction.paymentId());
                    }
                    return ids;
                }));
            }
            start.countDown();
            java.util.Set<String> all = new java.util.HashSet<>();
            for (java.util.concurrent.Future<List<String>> f : work) {
                all.addAll(f.get(60, java.util.concurrent.TimeUnit.SECONDS));
            }
            pool.shutdown();
            Check.equal(threads * each, platform.requests("POST").stream().filter((r) -> r.path.equals("/v1/settlements")).mapToInt((r) -> 1).sum(),
                    "every instruction was sent once");
            Check.equal(threads * each, all.size(), "every payment drew its own id");
            Check.equal(1, registryAsked.get(), "and the registry was asked once for all of them");
        }
    }

    static void testAnLeiIsTypedAsOne() {
        Check.isTrue(TravelRule.isLei("5493001KJTIIGC8Y1R12"), "an LEI");
        Check.isTrue(!TravelRule.isLei("0312345678") && !TravelRule.isLei(null) && !TravelRule.isLei("5493001KJTIIGC8Y1R1X"), "not an LEI");
    }
}
