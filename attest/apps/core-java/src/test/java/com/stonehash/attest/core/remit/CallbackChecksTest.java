package com.stonehash.attest.core.remit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.remit.Conventions;
import com.stonehash.attest.remit.Signer;
import com.stonehash.attest.remit.Signers;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Everything about a callback that is judged before the settlement's row is
 * locked ({@link Callbacks#check}), without a store: which refusal a
 * callback gets, in which order when it has two faults, and what was asked
 * of the ledger and of the registry on the way — a value that is no id is
 * never handed to either.
 *
 * <p>The sentences are the ones {@code handleCallback} and
 * {@code verifyPartnerSig} of the service this one replaces give
 * ({@code attest/apps/core/src/remit/orchestrator.ts}); where that service
 * handed a value that is not text to its store, the refusals are the ones
 * agreed for both services ("an id is text").
 *
 * <p>Besides: what the notices to the bank carry for each kind of callback,
 * as the text that is sent.
 */
class CallbackChecksTest {
    private static final String PAYMENT = "PAY-CHECKS-1";
    private static final String BFI = "SG-BFI-CHECKS";
    private static final String BANK = "VN-BANK-CHECKS";

    private static Signer bfiKey;
    private static Signer bankKey;
    private static Signer strangerKey;

    /** A ledger of one settlement and a registry of five institutions, which write down what they are asked. */
    private static final class World implements Callbacks.Lookups {
        final List<String> asked = new ArrayList<>();
        final Map<String, Map<String, Object>> institutions = new LinkedHashMap<>();

        World() {
            institutions.put(BFI, Rail.map("id", BFI, "role", "BENEFICIARY_FI", "signing_spki", bfiKey.publicKeySpkiBase64()));
            institutions.put(BANK, Rail.map("id", BANK, "role", "COLLECTION_BANK", "signing_spki", bankKey.publicKeySpkiBase64()));
            institutions.put("SG-BFI-NOKEY", Rail.map("id", "SG-BFI-NOKEY", "role", "BENEFICIARY_FI", "signing_spki", null));
            institutions.put("SG-BFI-EMPTYKEY", Rail.map("id", "SG-BFI-EMPTYKEY", "role", "BENEFICIARY_FI", "signing_spki", ""));
            institutions.put("SG-BFI-BADKEY", Rail.map("id", "SG-BFI-BADKEY", "role", "BENEFICIARY_FI", "signing_spki", "bm90IGEga2V5"));
        }

        @Override
        public boolean settlement(String paymentId) {
            asked.add("settlement " + paymentId);
            return PAYMENT.equals(paymentId);
        }

        @Override
        public Map<String, Object> institution(String id) {
            asked.add("institution " + id);
            return institutions.get(id);
        }
    }

    static Signer newKey() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return Signers.fromPkcs8Pem("-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, new byte[] { '\n' }).encodeToString(generator.generateKeyPair().getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n");
    }

    @BeforeAll
    static void keys() throws Exception {
        bfiKey = newKey();
        bankKey = newKey();
        strangerKey = newKey();
    }

    /** A value as a request brings it: through the text, so numbers are what the parser makes of them. */
    private static Object arrived(Object value) {
        return Js.parse(Js.stringify(value));
    }

    private static Map<String, Object> payload(Object... more) {
        Map<String, Object> p = Rail.map("payment_id", PAYMENT, "reported_at", "2026-11-20T01:00:00.000Z");
        for (int i = 0; i < more.length; i += 2) {
            p.put((String) more[i], more[i + 1]);
        }
        return p;
    }

    /** The envelope a signer puts beside a payload ({@code alg, key_id, issuer, sig}), as a map the test may then spoil. */
    private static Map<String, Object> sig(Object payload, Signer key, String keyId) {
        return new LinkedHashMap<>(Conventions.signEvent(Canonical.forSdk(arrived(payload)), key, keyId, "the signer's name"));
    }

    private static Object body(Object type, Object payload, Object sig) {
        Map<String, Object> b = new LinkedHashMap<>();
        if (type != Js.UNDEFINED) {
            b.put("type", type);
        }
        if (payload != Js.UNDEFINED) {
            b.put("payload", payload);
        }
        if (sig != Js.UNDEFINED) {
            b.put("sig", sig);
        }
        return arrived(b);
    }

    /** A callback of that type whose payload the receiving institution signed. */
    private static Object signed(Object type, Map<String, Object> payload) {
        return body(type, payload, sig(payload, bfiKey, BFI));
    }

    /** What checking came to: {@code passed}, or the refusal as {@code status code: sentence}. */
    private static String judged(Object body, World world) {
        try {
            Callbacks.check(body, world);
            return "passed";
        } catch (ServiceError e) {
            assertNull(e.detail(), "a callback's refusal carries nothing beside its code and its sentence");
            return e.status() + " " + e.code() + ": " + e.getMessage();
        }
    }

    private static String judged(Object body) {
        return judged(body, new World());
    }

    // ── 1. the fields ────────────────────────────────────────────────────────

    @Test
    void theTypeThePayloadTheSignatureAndThePaymentIdMustBeThere() {
        Map<String, Object> p = payload();
        Object s = sig(p, bfiKey, BFI);
        // A body that is not an object has no fields.
        for (Object notAnObject : new Object[] { null, Arrays.asList(1d, 2d), "text", 5d, true }) {
            assertEquals("400 missing_field: type is required", judged(notAnObject), "a body that is " + Js.stringify(notAnObject));
        }
        for (Object noType : new Object[] { Js.UNDEFINED, null, "" }) {
            assertEquals("400 missing_field: type is required", judged(body(noType, p, s)));
        }
        // The type is asked for first: a callback with nothing at all is told about the type.
        assertEquals("400 missing_field: type is required", judged(body(Js.UNDEFINED, Js.UNDEFINED, Js.UNDEFINED)));

        for (Object nothing : new Object[] { Js.UNDEFINED, null, false, 0d, "" }) {
            assertEquals("400 missing_field: payload and sig are required", judged(body("USDC_RECEIVED", nothing, s)), "payload " + JsValues.string(nothing));
            assertEquals("400 missing_field: payload and sig are required", judged(body("USDC_RECEIVED", p, nothing)), "sig " + JsValues.string(nothing));
        }
        // A type that is there but is no type passes this check (it is refused later, after the signature).
        assertEquals("400 missing_field: payload and sig are required", judged(body(0d, null, s)));
        assertEquals("400 missing_field: payload and sig are required", judged(body(false, p, null)));

        for (Object noId : new Object[] { Js.UNDEFINED, null, "" }) {
            Map<String, Object> without = payload();
            if (noId == Js.UNDEFINED) {
                without.remove("payment_id");
            } else {
                without.put("payment_id", noId);
            }
            assertEquals("400 missing_field: payload.payment_id is required", judged(body("USDC_RECEIVED", without, s)));
        }
        // A payload that is something, but not an object, has no payment id.
        for (Object notAnObject : new Object[] { "text", 5d, true, Arrays.asList(PAYMENT), Arrays.asList(Rail.map("payment_id", PAYMENT)) }) {
            assertEquals("400 missing_field: payload.payment_id is required", judged(body("USDC_RECEIVED", notAnObject, s)), "a payload that is " + Js.stringify(notAnObject));
        }
    }

    @Test
    void aPaymentIdThatIsNotTextIsNoPaymentIdAndIsNeverHandedToTheStore() {
        for (Object notText : new Object[] { 12345d, 0d, true, false, Arrays.asList(PAYMENT), Rail.map("id", PAYMENT), Arrays.asList() }) {
            World world = new World();
            Map<String, Object> p = payload("payment_id", notText);
            assertEquals("400 missing_field: payload.payment_id is required", judged(body("USDC_RECEIVED", p, sig(p, bfiKey, BFI)), world),
                    "payment_id " + Js.stringify(notText));
            assertEquals(List.of(), world.asked, "neither the ledger nor the registry was asked about " + Js.stringify(notText));
        }
    }

    // ── 2. the settlement ────────────────────────────────────────────────────

    @Test
    void anUnknownSettlementIsSaidBeforeTheSignatureIsLookedAt() {
        World world = new World();
        Map<String, Object> p = payload("payment_id", "PAY-NOBODY-HAS");
        // The signature is by a stranger: it is not what is answered, and the registry is not asked.
        assertEquals("404 payment_not_found: no payment PAY-NOBODY-HAS", judged(body("USDC_RECEIVED", p, sig(p, strangerKey, "NOBODY")), world));
        assertEquals(List.of("settlement PAY-NOBODY-HAS"), world.asked);
        // And it is said before the type is looked at.
        assertEquals("404 payment_not_found: no payment PAY-NOBODY-HAS", judged(body("NO_SUCH_TYPE", p, sig(p, bfiKey, BFI))));
    }

    // ── 3. the signature ─────────────────────────────────────────────────────

    @Test
    void theSignerMustBeARegisteredInstitutionWithAKey() {
        Map<String, Object> p = payload();
        assertEquals("400 unknown_signer: signature names unregistered key NOBODY", judged(body("USDC_RECEIVED", p, sig(p, bfiKey, "NOBODY"))));
        assertEquals("400 unknown_signer: signature names unregistered key SG-BFI-NOKEY", judged(body("USDC_RECEIVED", p, sig(p, bfiKey, "SG-BFI-NOKEY"))));
        assertEquals("400 unknown_signer: signature names unregistered key SG-BFI-EMPTYKEY", judged(body("USDC_RECEIVED", p, sig(p, bfiKey, "SG-BFI-EMPTYKEY"))));

        // A signature that names no key at all: no key id, or a signature that is not an object.
        Map<String, Object> unnamed = sig(p, bfiKey, BFI);
        unnamed.remove("key_id");
        assertEquals("400 unknown_signer: signature names unregistered key undefined", judged(body("USDC_RECEIVED", p, unnamed)));
        for (Object notAnObject : new Object[] { "text", 5d, true, Arrays.asList(sig(p, bfiKey, BFI)), Arrays.asList() }) {
            World world = new World();
            assertEquals("400 unknown_signer: signature names unregistered key undefined", judged(body("USDC_RECEIVED", p, notAnObject), world),
                    "a signature that is " + Js.stringify(notAnObject));
            assertEquals(List.of("settlement " + PAYMENT), world.asked, "the registry was not asked");
        }
    }

    @Test
    void aKeyIdThatIsNotTextNamesNoKeyAndIsNeverHandedToTheStore() {
        Map<String, Object> p = payload();
        Object[][] cases = {
                { 12345d, "12345" }, { 0d, "0" }, { 1.5d, "1.5" }, { true, "true" }, { false, "false" }, { null, "null" },
                { Arrays.asList("a", "b"), "a,b" }, { Arrays.asList(), "" }, { Arrays.asList(BFI), BFI }, { Rail.map("id", BFI), "[object Object]" },
        };
        for (Object[] c : cases) {
            World world = new World();
            Map<String, Object> s = sig(p, bfiKey, BFI);
            s.put("key_id", c[0]);
            assertEquals("400 unknown_signer: signature names unregistered key " + c[1], judged(body("USDC_RECEIVED", p, s), world), "key_id " + Js.stringify(c[0]));
            assertEquals(List.of("settlement " + PAYMENT), world.asked, "the registry was not asked for " + Js.stringify(c[0]));
        }
    }

    @Test
    void onlyAReceivingInstitutionMayReport() {
        Map<String, Object> p = payload();
        // The bank's signature verifies — and a bank is not who reports a payout.
        assertEquals("400 role_mismatch: " + BANK + " holds role COLLECTION_BANK, which may not assert BENEFICIARY_FI facts",
                judged(body("USDC_RECEIVED", p, sig(p, bankKey, BANK))));
        // The role is judged before the signature: a bank's key id under anybody's signature is still a bank's.
        assertEquals("400 role_mismatch: " + BANK + " holds role COLLECTION_BANK, which may not assert BENEFICIARY_FI facts",
                judged(body("USDC_RECEIVED", p, sig(p, strangerKey, BANK))));
    }

    @Test
    void theSignatureMustBeThatInstitutionsOverThatPayload() {
        Map<String, Object> p = payload("tx_hash", "0xabc");
        String refused = "400 invalid_signature: signature by " + BFI + " does not verify";
        assertEquals("passed", judged(signed("USDC_RECEIVED", p)));

        // Somebody else's key under the institution's name; the institution's key over another payload.
        assertEquals(refused, judged(body("USDC_RECEIVED", p, sig(p, strangerKey, BFI))));
        assertEquals(refused, judged(body("USDC_RECEIVED", p, sig(payload("tx_hash", "0xabd"), bfiKey, BFI))));

        // An envelope that is not what an envelope is.
        Object[] noAlg = { Js.UNDEFINED, null, "ES384", "es256", 256d, true, Arrays.asList("ES256") };
        for (Object alg : noAlg) {
            Map<String, Object> s = sig(p, bfiKey, BFI);
            if (alg == Js.UNDEFINED) {
                s.remove("alg");
            } else {
                s.put("alg", alg);
            }
            assertEquals(refused, judged(body("USDC_RECEIVED", p, s)), "alg " + JsValues.string(alg));
        }
        Object[] noValue = { Js.UNDEFINED, null, "", 0d, false, 12345d, true, Arrays.asList("x"), Rail.map("r", "x"), "not base64url !", "AAAA" };
        for (Object value : noValue) {
            Map<String, Object> s = sig(p, bfiKey, BFI);
            if (value == Js.UNDEFINED) {
                s.remove("sig");
            } else {
                s.put("sig", value);
            }
            assertEquals(refused, judged(body("USDC_RECEIVED", p, s)), "sig.sig " + Js.stringify(value == Js.UNDEFINED ? "(absent)" : value));
        }

        // A registered key that cannot be read verifies nothing.
        assertEquals("400 invalid_signature: signature by SG-BFI-BADKEY does not verify", judged(body("USDC_RECEIVED", p, sig(p, bfiKey, "SG-BFI-BADKEY"))));

        // A payload that has no canonical form (a number that is not whole) cannot have been signed.
        Map<String, Object> s = sig(p, bfiKey, BFI);
        assertEquals(refused, judged(body("USDC_RECEIVED", payload("tx_hash", "0xabc", "amount", 1.5d), s)));

        // The members of the payload in another order are the same payload.
        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("tx_hash", "0xabc");
        reordered.put("reported_at", p.get("reported_at"));
        reordered.put("payment_id", PAYMENT);
        assertEquals("passed", judged(body("USDC_RECEIVED", reordered, sig(p, bfiKey, BFI))));
    }

    // ── 4. the type, and a completion's level ────────────────────────────────

    @Test
    void theTypeIsJudgedAfterTheSignature() {
        Map<String, Object> p = payload();
        for (String type : Callbacks.TYPES) {
            assertEquals("passed", judged(signed(type, p)), type);
        }
        assertEquals(List.of("USDC_RECEIVED", "PAYOUT_SUBMITTED", "PAYOUT_COMPLETED", "PAYOUT_FAILED", "USDC_RETURNED"), Callbacks.TYPES);

        Object[][] unknown = {
                { "PAYOUT_REVERSED", "PAYOUT_REVERSED" }, { "usdc_received", "usdc_received" }, { " USDC_RECEIVED", " USDC_RECEIVED" },
                { 5d, "5" }, { 0d, "0" }, { false, "false" }, { true, "true" },
                // A list with the type in it prints as the type, and is still no type.
                { Arrays.asList("USDC_RECEIVED"), "USDC_RECEIVED" }, { Rail.map("type", "USDC_RECEIVED"), "[object Object]" },
        };
        for (Object[] c : unknown) {
            assertEquals("400 unknown_callback_type: unsupported callback type " + c[1], judged(signed(c[0], p)), "type " + Js.stringify(c[0]));
            // With a signature that does not verify, the signature is what is answered.
            assertEquals("400 invalid_signature: signature by " + BFI + " does not verify", judged(body(c[0], p, sig(p, strangerKey, BFI))), "type " + Js.stringify(c[0]));
        }
    }

    @Test
    void aCompletionsLevelIsTextOrAbsent() {
        World world = new World();
        assertEquals("L2", Callbacks.check(signed("PAYOUT_COMPLETED", payload()), world).level, "a completion that states no level");
        assertEquals("L2", Callbacks.check(signed("PAYOUT_COMPLETED", payload("evidence_level", null)), world).level, "null states none");
        for (String level : new String[] { "L1", "L2", "L3", "L4", "l1", "", "L1 ", "anything" }) {
            assertEquals(level, Callbacks.check(signed("PAYOUT_COMPLETED", payload("evidence_level", level)), world).level);
        }
        for (Object notText : new Object[] { 1d, 0d, true, false, Arrays.asList("L1"), Rail.map("level", "L1"), Arrays.asList() }) {
            Map<String, Object> p = payload("evidence_level", notText);
            assertEquals("400 missing_field: payload.evidence_level must be text", judged(signed("PAYOUT_COMPLETED", p)), "evidence_level " + Js.stringify(notText));
            // It is a completion's level: the other kinds of callback carry what they carry.
            for (String other : new String[] { "USDC_RECEIVED", "PAYOUT_SUBMITTED", "PAYOUT_FAILED", "USDC_RETURNED" }) {
                assertEquals("passed", judged(signed(other, p)), other + " with evidence_level " + Js.stringify(notText));
            }
            // And it is judged last: after the signature …
            assertEquals("400 invalid_signature: signature by " + BFI + " does not verify", judged(body("PAYOUT_COMPLETED", p, sig(p, strangerKey, BFI))));
        }
        for (String other : new String[] { "USDC_RECEIVED", "PAYOUT_SUBMITTED", "PAYOUT_FAILED", "USDC_RETURNED" }) {
            assertNull(Callbacks.check(signed(other, payload("evidence_level", "L1")), world).level, other + " has no level");
        }
    }

    @Test
    void whatPassedIsHandedOnAsItArrived() {
        World world = new World();
        Map<String, Object> p = payload("bank_reference", "FT-1", "amount", 100d);
        Object body = signed("PAYOUT_COMPLETED", p);
        Callbacks.Checked c = Callbacks.check(body, world);
        assertEquals("PAYOUT_COMPLETED", c.type);
        assertEquals(PAYMENT, c.paymentId);
        assertEquals(BFI, c.issuer, "the institution that signed, by its id");
        assertSame(JsValues.member(body, "payload"), c.payload, "the payload that is stored is the one that was signed");
        assertSame(JsValues.member(body, "sig"), c.sig);
        assertEquals(List.of("settlement " + PAYMENT, "institution " + BFI), world.asked, "two questions, in this order, and no more");
    }

    // ── what the bank is told ────────────────────────────────────────────────

    @Test
    void theNoticesCarryWhatTheyAlwaysCarried() {
        Object full = arrived(Rail.map("payment_id", PAYMENT, "tx_hash", "0xfeed", "local_rail", "NAPAS", "reason", "account closed",
                "bank_reference", "FT-77", "evidence_level", "L3"));
        Object bare = arrived(Rail.map("payment_id", PAYMENT));
        Object nulls = arrived(Rail.map("payment_id", PAYMENT, "tx_hash", null, "local_rail", null, "reason", null, "bank_reference", null));

        assertEquals("{\"tx_hash\":\"0xfeed\"}", Js.stringify(EvidenceEvents.receivedNotice(full)));
        assertEquals("{\"tx_hash\":null}", Js.stringify(EvidenceEvents.receivedNotice(bare)));
        assertEquals("{\"tx_hash\":null}", Js.stringify(EvidenceEvents.receivedNotice(nulls)));

        assertEquals("{\"local_rail\":\"NAPAS\"}", Js.stringify(EvidenceEvents.submittedNotice(full)));
        assertEquals("{\"local_rail\":\"FAST\"}", Js.stringify(EvidenceEvents.submittedNotice(bare)));
        assertEquals("{\"local_rail\":\"FAST\"}", Js.stringify(EvidenceEvents.submittedNotice(nulls)));

        assertEquals("{\"reason\":\"account closed\",\"will_return\":true}", Js.stringify(EvidenceEvents.failedNotice(full)));
        assertEquals("{\"reason\":\"local payout failed\",\"will_return\":true}", Js.stringify(EvidenceEvents.failedNotice(bare)));
        assertEquals("{\"reason\":\"local payout failed\",\"will_return\":true}", Js.stringify(EvidenceEvents.failedNotice(nulls)));

        assertEquals("{\"bank_reference\":\"FT-77\",\"evidence_level\":\"L3\"}", Js.stringify(EvidenceEvents.completedNotice(full, "L3")));
        assertEquals("{\"bank_reference\":null,\"evidence_level\":\"L2\"}", Js.stringify(EvidenceEvents.completedNotice(bare, "L2")));

        String note = "\"note\":\"USDC returned to the settlement entity; the bank refunds the customer VND on its own ledger\"";
        // No failure was reported: "returned". One was: its reason — and where it gave none, the notice has none.
        assertEquals("{\"reason\":\"returned\",\"return_tx\":\"0xfeed\"," + note + "}", Js.stringify(EvidenceEvents.returnedNotice(full, null)));
        assertEquals("{\"reason\":\"returned\",\"return_tx\":null," + note + "}", Js.stringify(EvidenceEvents.returnedNotice(bare, null)));
        assertEquals("{\"reason\":\"account closed\",\"return_tx\":\"0xfeed\"," + note + "}", Js.stringify(EvidenceEvents.returnedNotice(full, full)));
        assertEquals("{\"return_tx\":\"0xfeed\"," + note + "}", Js.stringify(EvidenceEvents.returnedNotice(full, bare)));
        assertEquals("{\"reason\":null,\"return_tx\":null," + note + "}", Js.stringify(EvidenceEvents.returnedNotice(nulls, nulls)));

        // A value that is not text where text is expected is passed on as it is: only nothing is replaced.
        Object odd = arrived(Rail.map("tx_hash", 5d, "local_rail", false, "reason", 0d, "bank_reference", Arrays.asList("a")));
        assertEquals("{\"tx_hash\":5}", Js.stringify(EvidenceEvents.receivedNotice(odd)));
        assertEquals("{\"local_rail\":false}", Js.stringify(EvidenceEvents.submittedNotice(odd)));
        assertEquals("{\"reason\":0,\"will_return\":true}", Js.stringify(EvidenceEvents.failedNotice(odd)));
        assertEquals("{\"bank_reference\":[\"a\"],\"evidence_level\":\"L2\"}", Js.stringify(EvidenceEvents.completedNotice(odd, "L2")));
    }

    @Test
    void aCompletionNobodySignedIsWrittenDownAsHeld() {
        assertEquals("{\"payment_id\":\"" + PAYMENT + "\",\"evidence_level\":\"L1\",\"holds_at\":\"PAYOUT_IN_PROGRESS\","
                + "\"reason\":\"payout completion arrived without an institution signature (L1); credit confirmation requires L2 or better\","
                + "\"remediation\":\"request a signed (L2) or bank-referenced (L3) confirmation from the BFI, or reconcile via the daily signed statement\"}",
                Js.stringify(EvidenceEvents.insufficient(PAYMENT, "L1")));
        assertEquals("{\"evidence_level\":\"L1\"}", Js.stringify(EvidenceEvents.insufficientNotice("L1")));
    }

    @Test
    void aReconciliationsJobNamesItsCompletion() {
        assertEquals("{\"completion_seq\":7}", Js.stringify(EvidenceEvents.reconcileInput(7)));
        assertEquals(7, EvidenceEvents.completionSeq(Js.stringify(EvidenceEvents.reconcileInput(7))));
        assertEquals(0, EvidenceEvents.completionSeq("{\"completion_seq\":0}"));
        for (String namesNone : new String[] { null, "null", "{}", "7", "[7]", "{\"completion_seq\":\"7\"}", "{\"completion_seq\":-1}", "{\"completion_seq\":1.5}",
                "{\"completion_seq\":null}" }) {
            assertNull(EvidenceEvents.completionSeq(namesNone), String.valueOf(namesNone));
        }
        assertTrue(RemitJobs.Kind.RECONCILE.lane.equals(Callbacks.EVIDENCE_LANE) && RemitJobs.Kind.PACKAGE.lane.equals(Callbacks.EVIDENCE_LANE),
                "the reconciliation and the package share the lane a second completion is refused on");
    }
}
