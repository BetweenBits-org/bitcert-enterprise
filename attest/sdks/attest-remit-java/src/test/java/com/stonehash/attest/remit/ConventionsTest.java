package com.stonehash.attest.remit;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@link Conventions} — what is signed, what is hashed and how a signature
 * travels — held to the platform's own code: {@code golden/conventions.json}
 * records the bytes it signs, the digests and commitments it computes, the
 * envelopes it takes for valid and signatures it made itself; and
 * {@code golden/signing.json} the same for the reference SDK. Each is put to
 * {@code Conventions} here, through its public methods only.
 */
final class ConventionsTest {
    private ConventionsTest() {
    }

    private static Map<String, Object> read(String file) throws Exception {
        return Json.object(Json.parse(TestMain.resource("golden/" + file), "invalid_json", file), "invalid_json", file);
    }

    private static Map<String, Object> object(Object o) {
        return VerdictEngineTest.object(o);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> cases(Object list) {
        return (List<Map<String, Object>>) list;
    }

    static byte[] unhex(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        }
        return out;
    }

    private static String hexOrNull(byte[] bytes) {
        return bytes == null ? null : Hex.encode(bytes);
    }

    /** The test key of {@code signing.json}, as a signer and as the public key it is verified under. */
    private static KeySigner signer() throws Exception {
        return Signers.fromPkcs8Pem((String) object(read("signing.json").get("testKey")).get("pkcs8Pem"));
    }

    // ── what is signed and what is hashed ─────────────────────────────────────

    static void testTheDomainsAreThePlatforms() throws Exception {
        Map<String, Object> domains = object(read("conventions.json").get("domains"));
        Check.equal(domains.get("event"), Conventions.EVENT_DOMAIN, "the event domain");
        Check.equal(domains.get("elementSignature"), Conventions.ELEMENT_SIGNATURE_DOMAIN, "the element signature domain");
        Check.equal(domains.get("elementDigest"), Conventions.ELEMENT_DIGEST_DOMAIN, "the element digest domain");
        Check.equal(domains.get("commitment"), Conventions.EVIDENCE_COMMIT_DOMAIN, "the commitment domain");
        Check.isTrue(Conventions.EVENT_DOMAIN.endsWith("\n") && Conventions.ELEMENT_SIGNATURE_DOMAIN.endsWith("\n") && Conventions.ELEMENT_DIGEST_DOMAIN.endsWith("\n")
                && !Conventions.EVIDENCE_COMMIT_DOMAIN.endsWith("\n"), "three end in a line break, and the commitment's does not");
        Map<String, Object> sdk = object(read("signing.json").get("domains"));
        Check.equal(sdk.get("event"), Conventions.EVENT_DOMAIN, "the reference SDK's event domain");
        Check.equal(sdk.get("digest"), Conventions.ELEMENT_DIGEST_DOMAIN, "the reference SDK's digest domain");
    }

    static void testCanonicalJsonIsByteForByteTheReferences() throws Exception {
        int same = 0;
        int refused = 0;
        for (Map<String, Object> c : cases(read("signing.json").get("jcs"))) {
            Object value = c.get("value");
            if (c.containsKey("error")) {
                Check.refuses("not_canonical", () -> Conventions.canonical(value));
                Check.refuses("not_canonical", () -> Conventions.canonicalBytes(value));
                refused++;
            } else {
                Check.equal(c.get("utf8Hex"), Hex.encode(Conventions.canonicalBytes(value)), "canonical bytes of " + Json.compact(value));
                Check.equal(c.get("utf8Hex"), Hex.encode(Conventions.canonical(value).getBytes(StandardCharsets.UTF_8)), "canonical text of " + Json.compact(value));
                same++;
            }
        }
        Check.isTrue(same >= 20 && refused >= 4, "the vectors were read: " + same + " values, " + refused + " refusals");
    }

    /**
     * A number is its value — the reference holds nothing else of it — so
     * the canonical form of 1 is {@code 1} however the number is held, and
     * a number that is not whole, or too large to be exact, has none.
     */
    static void testACanonicalNumberIsItsValueHoweverItIsHeld() throws Exception {
        for (Object one : new Object[] { 1L, 1, (short) 1, Double.valueOf(1.0), Float.valueOf(1f), new java.math.BigDecimal("1"), new java.math.BigDecimal("1.0"),
                new java.math.BigDecimal("1.000"), new java.math.BigDecimal("1E+0"), new java.math.BigDecimal("0.1E1"), new java.math.BigDecimal("10E-1") }) {
            Check.equal("{\"n\":[1]}", Conventions.canonical(Collections.singletonMap("n", Arrays.asList(one))), one.getClass().getSimpleName() + " " + one);
            Check.equal("{\"n\":[1]}", new String(Conventions.canonicalBytes(Collections.singletonMap("n", Arrays.asList(one))), StandardCharsets.UTF_8),
                    one.getClass().getSimpleName() + " " + one + ", as bytes");
        }
        Check.equal("[0,0,0,1000,-2500,9007199254740991,-9007199254740991]", Conventions.canonical(Arrays.asList(Double.valueOf(-0.0), new java.math.BigDecimal("0.0"), 0L,
                new java.math.BigDecimal("1E+3"), Double.valueOf(-2500.0), Double.valueOf(9007199254740991d), new java.math.BigDecimal("-9007199254740991.0"))), "whole numbers of every size");
        for (Object none : new Object[] { Double.valueOf(1.5), new java.math.BigDecimal("1.5"), new java.math.BigDecimal("0.1"), Double.valueOf(9007199254740992d), 9007199254740992L,
                new java.math.BigDecimal("9007199254740993"), new java.math.BigDecimal("1E+21"), Double.valueOf(1e300), Double.valueOf(Double.NaN), Double.valueOf(Double.POSITIVE_INFINITY),
                Double.valueOf(5e-324), new java.math.BigDecimal("1.0000000000000000000000001").subtract(new java.math.BigDecimal("0.5")) }) {
            Check.refuses("not_canonical", () -> Conventions.canonical(Arrays.asList(none)));
            Check.refuses("not_canonical", () -> Conventions.canonicalBytes(Arrays.asList(none)));
            Check.refuses("not_canonical", () -> Conventions.eventSigningBytes(Collections.singletonMap("n", none)));
            Check.refuses("not_canonical", () -> Conventions.commitment(Collections.singletonMap("n", none), "00"));
            Check.isTrue(!Conventions.verifyEvent(Collections.singletonMap("n", none), Collections.singletonMap("alg", "ES256"), null), "and nothing verifies over it");
        }
        // What is handed over is not changed by being canonicalised.
        Map<String, Object> held = new LinkedHashMap<>();
        Double two = Double.valueOf(2.0);
        held.put("n", two);
        held.put("list", new ArrayList<>(Arrays.asList(two, "x")));
        Check.equal("{\"list\":[2,\"x\"],\"n\":2}", Conventions.canonical(held), "doubles, canonically");
        Check.isTrue(held.get("n") == two && VerdictEngineTest.list(held.get("list")).get(0) == two, "the caller's numbers are the caller's still");
        // Every vector again, its numbers held as doubles: the same bytes, digests and commitments, the same signatures verified.
        Map<String, Object> conventions = read("conventions.json");
        int again = 0;
        for (Map<String, Object> c : cases(conventions.get("events"))) {
            if (!c.containsKey("threw")) {
                Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.eventSigningBytes(RulesTest.doubles(c.get("payload")))), c.get("name") + ", as doubles");
                again++;
            }
        }
        for (Map<String, Object> c : cases(conventions.get("elements"))) {
            if (!c.containsKey("signingThrew")) {
                Map<String, Object> element = object(RulesTest.doubles(c.get("element")));
                Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.elementSigningBytes(element)), c.get("name") + ", as doubles: the bytes signed");
                Check.equal(c.get("contentDigest"), Conventions.elementDigest(element), c.get("name") + ", as doubles: the content digest");
                again++;
            }
        }
        for (Map<String, Object> c : cases(conventions.get("commitments"))) {
            if (c.containsKey("value") && !c.containsKey("java")) {
                Check.equal(c.get("value"), Conventions.commitment(RulesTest.doubles(c.get("package")), (String) c.get("nonce")), c.get("name") + ", as doubles");
                again++;
            }
        }
        Map<String, Object> signed = object(conventions.get("signedByPlatform"));
        String spki = (String) object(signed.get("key")).get("spkiBase64");
        for (Map<String, Object> c : cases(signed.get("events"))) {
            Check.isTrue(Conventions.verifyEvent(RulesTest.doubles(c.get("payload")), c.get("sig"), spki), c.get("name") + ", as doubles: the platform's signature verifies");
            again++;
        }
        for (Map<String, Object> c : cases(signed.get("elements"))) {
            Check.isTrue(Conventions.verifyElementSignature(object(RulesTest.doubles(c.get("signed"))), spki), c.get("name") + ", as doubles: the platform's signature verifies");
            again++;
        }
        Check.isTrue(again >= 50, "the vectors were read again: " + again);
        // And signing: over the numbers at their value, handing back the element as it was handed over.
        KeySigner signer = signer();
        Map<String, Object> element = new LinkedHashMap<>();
        element.put("ref", "PAY-1");
        element.put("confirmations", Double.valueOf(3.0));
        Map<String, Object> finished = Conventions.digestAndSignElement(element, signer, "K", "I");
        Check.isTrue(finished.get("confirmations") == element.get("confirmations"), "signing does not change how a number is held");
        Map<String, Object> asRead = object(Json.parse(JsValue.stringify(finished)));
        Check.equal(3L, asRead.get("confirmations"), "written out and read back, it is 3");
        Check.isTrue(Conventions.verifyElementSignature(asRead, signer.publicKeySpkiBase64()) && Conventions.verifyElementSignature(finished, signer.publicKeySpkiBase64()),
                "and the signature verifies over either");
        Check.equal(Conventions.elementDigest(asRead), finished.get("digest"), "as does the digest");
    }

    static void testTheBytesSignedForAnEventAreThePlatforms() throws Exception {
        int same = 0;
        int refused = 0;
        for (Map<String, Object> c : cases(read("conventions.json").get("events"))) {
            Object payload = c.get("payload");
            if (c.containsKey("threw")) {
                Check.refuses("not_canonical", () -> Conventions.eventSigningBytes(payload));
                Check.refuses("not_canonical", () -> Conventions.eventSigningDigest(payload));
                refused++;
                continue;
            }
            Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.eventSigningBytes(payload)), c.get("name") + ": the bytes signed");
            Check.equal(c.get("signingDigest"), Conventions.eventSigningDigest(payload), c.get("name") + ": their digest");
            Check.isTrue(new String(Conventions.eventSigningBytes(payload), StandardCharsets.UTF_8).startsWith(Conventions.EVENT_DOMAIN), "the domain comes first");
            same++;
        }
        for (Map<String, Object> c : cases(read("signing.json").get("events"))) {
            Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.eventSigningBytes(c.get("payload"))), "the bytes the reference SDK signs for an event");
            same++;
        }
        Check.isTrue(same >= 12 && refused >= 2, "the vectors were read: " + same + " events, " + refused + " refusals");
    }

    static void testTheBytesSignedAndTheDigestsOfAnElementAreThePlatforms() throws Exception {
        int same = 0;
        int refused = 0;
        for (Map<String, Object> c : cases(read("conventions.json").get("elements"))) {
            Map<String, Object> element = object(c.get("element"));
            String before = Json.compact(element);
            if (c.containsKey("signingThrew")) {
                Check.refuses("not_canonical", () -> Conventions.elementSigningBytes(element));
                Check.refuses("not_canonical", () -> Conventions.elementSigningDigest(element));
                Check.refuses("not_canonical", () -> Conventions.elementDigest(element));
                refused++;
                continue;
            }
            Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.elementSigningBytes(element)), c.get("name") + ": the bytes signed");
            Check.equal(c.get("signingDigest"), Conventions.elementSigningDigest(element), c.get("name") + ": their digest");
            Check.equal(c.get("contentDigest"), Conventions.elementDigest(element), c.get("name") + ": the content digest");
            Check.equal(before, Json.compact(element), c.get("name") + ": the element is not changed by being read");
            same++;
        }
        for (Map<String, Object> c : cases(read("signing.json").get("elements"))) {
            Map<String, Object> element = object(c.get("element"));
            Check.equal(c.get("digest"), Conventions.elementDigest(element), "the content digest the reference SDK computes");
            Map<String, Object> withDigest = new LinkedHashMap<>(element);
            withDigest.put("digest", c.get("digest"));
            Check.equal(c.get("signingBytesHex"), Hex.encode(Conventions.elementSigningBytes(withDigest)), "the bytes the reference SDK signs for an element");
            same++;
        }
        Check.isTrue(same >= 17 && refused >= 1, "the vectors were read: " + same + " elements, " + refused + " refusals");
        // What is outside the signature is outside it; what is inside is not.
        Map<String, Object> element = new LinkedHashMap<>(object(cases(read("conventions.json").get("elements")).get(0).get("element")));
        String signed = Conventions.elementSigningDigest(element);
        String content = Conventions.elementDigest(element);
        for (String outside : Arrays.asList("signature", "digestVerified", "attached", "citedOnly")) {
            Map<String, Object> changed = new LinkedHashMap<>(element);
            changed.put(outside, "anything");
            Check.equal(signed, Conventions.elementSigningDigest(changed), outside + " is outside the signature");
            Check.equal(content, Conventions.elementDigest(changed), outside + " is outside the content digest");
        }
        Map<String, Object> withDigest = new LinkedHashMap<>(element);
        withDigest.put("digest", content);
        Check.isTrue(!signed.equals(Conventions.elementSigningDigest(withDigest)), "the digest an element declares is inside the signature");
        Check.equal(content, Conventions.elementDigest(withDigest), "and outside the content digest, which is that digest");
        Map<String, Object> edited = new LinkedHashMap<>(element);
        edited.put("amount", "2500.01");
        Check.isTrue(!signed.equals(Conventions.elementSigningDigest(edited)) && !content.equals(Conventions.elementDigest(edited)), "an amount is inside both");
    }

    // ── signatures ────────────────────────────────────────────────────────────

    static void testSignaturesMadeByThePlatformAndByTheReferenceSdkVerifyHere() throws Exception {
        Map<String, Object> signed = object(read("conventions.json").get("signedByPlatform"));
        Map<String, Object> key = object(signed.get("key"));
        String spki = (String) key.get("spkiBase64");
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("keyId", key.get("keyId"));
        entry.put("issuer", key.get("issuer"));
        entry.put("trustLevel", "ATTESTED");
        entry.put("publicKeySpki", spki);
        Rules.Keyring ring = Rules.keyring(Arrays.asList(entry));
        int events = 0;
        int elements = 0;
        for (Map<String, Object> c : cases(signed.get("events"))) {
            Check.isTrue(Conventions.verifyEvent(c.get("payload"), c.get("sig"), spki), c.get("name") + ": an event signed by the platform verifies");
            Check.isTrue(!Conventions.verifyEvent(Arrays.asList(c.get("payload")), c.get("sig"), spki), c.get("name") + ": and not over another payload");
            events++;
        }
        for (Map<String, Object> c : cases(signed.get("elements"))) {
            Map<String, Object> element = object(c.get("signed"));
            Check.isTrue(Conventions.verifyElementSignature(element, spki), c.get("name") + ": an element signed by the platform verifies");
            Map<String, Object> edited = new LinkedHashMap<>(element);
            edited.put("edited", Boolean.TRUE);
            Check.isTrue(!Conventions.verifyElementSignature(edited, spki), c.get("name") + ": and not once a member is added");
            // And the signature pass — the same check, with the keyring's word for who signed — reads it VALID.
            Map<String, Object> evidence = Collections.singletonMap("elements", Collections.singletonMap("bankInstruction", element));
            Object status = object(object(object(Rules.checkSignatures(evidence, ring).get("elements")).get("bankInstruction")).get("signature")).get("status");
            Check.equal("VALID", status, c.get("name") + ": under a keyring that holds the key");
            elements++;
        }
        Map<String, Object> sdk = read("signing.json");
        String sdkSpki = (String) object(sdk.get("testKey")).get("spkiBase64");
        for (Map<String, Object> c : cases(object(sdk.get("signedByTypeScript")).get("events"))) {
            Check.isTrue(Conventions.verifyEvent(c.get("payload"), c.get("signature"), sdkSpki), "an event signed by the reference SDK verifies");
            events++;
        }
        for (Map<String, Object> element : cases(object(sdk.get("signedByTypeScript")).get("elements"))) {
            Check.isTrue(Conventions.verifyElementSignature(element, sdkSpki), "an element signed by the reference SDK verifies");
            Check.equal(element.get("digest"), Conventions.elementDigest(element), "and declares the digest it has");
            elements++;
        }
        Check.isTrue(events >= 10 && elements >= 15, "the vectors were read: " + events + " events, " + elements + " elements");
    }

    static void testAnEnvelopeIsTakenOrNotAsThePlatformTakesIt() throws Exception {
        List<String> failures = new ArrayList<>();
        int taken = 0;
        int refused = 0;
        int stricter = 0;
        for (Map<String, Object> c : cases(read("conventions.json").get("verifyEvent"))) {
            // `java` is stated where this SDK answers otherwise on purpose: a key of another kind, an envelope that is not there.
            boolean expected = c.containsKey("java") ? (Boolean) c.get("java") : (Boolean) c.get("expected");
            stricter += c.containsKey("java") ? 1 : 0;
            String spki = c.get("spki") instanceof String ? (String) c.get("spki") : null;
            boolean actual;
            try {
                actual = Conventions.verifyEvent(c.get("payload"), c.get("sig"), spki);
            } catch (RuntimeException e) {
                failures.add(c.get("name") + ": " + e);
                continue;
            }
            if (actual != expected) {
                failures.add(c.get("name") + ": " + actual + ", the platform says " + expected);
            }
            if (expected) {
                taken++;
            } else {
                refused++;
            }
        }
        VerdictEngineTest.none(failures, "event envelopes");
        Check.isTrue(taken >= 10 && refused >= 30, "the vectors were read: " + taken + " taken, " + refused + " not");
        Check.equal(2, stricter, "the envelopes this SDK does not take and the platform does, or fails on");
    }

    static void testWhatIsSignedHereIsShapedAsThePlatformShapesItAndVerifies() throws Exception {
        KeySigner signer = signer();
        String spki = signer.publicKeySpkiBase64();
        Map<String, Object> conventions = read("conventions.json");
        Object payload = cases(conventions.get("events")).get(0).get("payload");

        Map<String, Object> envelope = Conventions.signEvent(payload, signer, "VN-BANK-001", "Vietnam Commercial Bank (sim)");
        Check.equal(Arrays.asList("alg", "key_id", "issuer", "sig"), new ArrayList<>(envelope.keySet()), "the envelope's members, in the platform's order");
        Check.equal("ES256", envelope.get("alg"), "alg");
        Check.equal("VN-BANK-001", envelope.get("key_id"), "key_id");
        Check.equal("Vietnam Commercial Bank (sim)", envelope.get("issuer"), "issuer");
        Check.equal(64, Conventions.base64UrlStrict((String) envelope.get("sig")).length, "raw r ‖ s, base64url without padding");
        Check.isTrue(!((String) envelope.get("sig")).contains("="), "no padding");
        Check.isTrue(Conventions.verifyEvent(payload, envelope, spki), "it verifies");
        Check.isTrue(Conventions.verifies(Conventions.eventSigningBytes(payload), (String) envelope.get("sig"), spki), "over exactly the event's signing bytes");
        Check.isTrue(!Conventions.verifies(Conventions.canonicalBytes(payload), (String) envelope.get("sig"), spki), "and not over the payload without the domain");

        Map<String, Object> element = object(cases(conventions.get("elements")).get(0).get("element"));
        Map<String, Object> signed = Conventions.signElement(element, signer, "VN-BANK-001", "Vietnam Commercial Bank (sim)");
        List<String> members = new ArrayList<>(element.keySet());
        members.add("signature");
        Check.equal(members, new ArrayList<>(signed.keySet()), "the element's members, then the signature; no digest is added");
        Map<String, Object> signature = object(signed.get("signature"));
        Check.equal(Arrays.asList("status", "keyId", "algorithm", "issuer", "trustLevel", "value"), new ArrayList<>(signature.keySet()), "the signature's members, in the platform's order");
        Check.equal("VALID|VN-BANK-001|ES256|Vietnam Commercial Bank (sim)|ATTESTED",
                signature.get("status") + "|" + signature.get("keyId") + "|" + signature.get("algorithm") + "|" + signature.get("issuer") + "|" + signature.get("trustLevel"), "what it states");
        Check.isTrue(!element.containsKey("signature"), "the element handed over is not changed");
        Check.isTrue(Conventions.verifyElementSignature(signed, spki), "it verifies");
        // Signing again replaces the signature where it stands; what it covers is the same.
        Map<String, Object> again = Conventions.signElement(signed, signer, "VN-BANK-001", "Vietnam Commercial Bank (sim)");
        Check.equal(new ArrayList<>(signed.keySet()), new ArrayList<>(again.keySet()), "signed twice: the same members");
        Check.isTrue(Conventions.verifyElementSignature(again, spki), "and the second signature verifies");

        Map<String, Object> finished = Conventions.digestAndSignElement(element, signer, "VN-BANK-001", "Vietnam Commercial Bank (sim)");
        Check.equal(Conventions.elementDigest(element), finished.get("digest"), "digest, then sign: the digest is the element's");
        Check.isTrue(Conventions.verifyElementSignature(finished, spki), "and the signature covers it");
        Map<String, Object> otherDigest = new LinkedHashMap<>(finished);
        otherDigest.put("digest", "0".repeat(64));
        Check.isTrue(!Conventions.verifyElementSignature(otherDigest, spki), "so a changed digest breaks the signature");

        byte[] message = "stonehash".getBytes(StandardCharsets.UTF_8);
        String raw = Conventions.sign(message, signer);
        Check.isTrue(Conventions.verifies(message, raw, spki), "a bare signature verifies");
        Check.isTrue(!Conventions.verifies("stonehasH".getBytes(StandardCharsets.UTF_8), raw, spki) && !Conventions.verifies(message, raw, null)
                && !Conventions.verifies(message, "", spki) && !Conventions.verifies(message, null, spki) && !Conventions.verifies(null, raw, spki), "and nothing else does");
        // A signer that answers in DER — an HSM, a JCA Signature — is taken; what travels is still raw.
        Signer der = Signers.external(spki, (bytes) -> {
            java.security.Signature s = java.security.Signature.getInstance("SHA256withECDSA");
            s.initSign(java.security.KeyFactory.getInstance("EC").generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(pkcs8())));
            s.update(bytes);
            return s.sign();
        });
        Check.equal(64, Conventions.base64UrlStrict(Conventions.sign(message, der)).length, "a DER answer travels raw");
        Check.isTrue(Conventions.verifyEvent(payload, Conventions.signEvent(payload, der, "K", "I"), spki), "and verifies");
        // A signer whose answer does not verify under its own public key is refused before anything leaves.
        String otherSpki = (String) object(VerdictEngineTest.list(VerdictEngineTest.base("sandbox").get("registry")).get(0)).get("signing_spki");
        Signer wrongKey = Signers.external(otherSpki, signer::sign);
        Check.refuses("signature_unverified", () -> Conventions.signEvent(payload, wrongKey, "K", "I"));
        Check.refuses("signature_unverified", () -> Conventions.signElement(element, wrongKey, "K", "I"));
        Check.refuses("not_canonical", () -> Conventions.signEvent(Collections.singletonMap("rate", new java.math.BigDecimal("1.5")), signer, "K", "I"));
        Check.fails(NullPointerException.class, () -> Conventions.signEvent(payload, signer, null, "I"));
    }

    private static byte[] pkcs8() throws Exception {
        String pem = (String) object(read("signing.json").get("testKey")).get("pkcs8Pem");
        return java.util.Base64.getMimeDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", ""));
    }

    // ── the commitment ────────────────────────────────────────────────────────

    static void testACommitmentIsThePlatforms() throws Exception {
        int same = 0;
        int refused = 0;
        for (Map<String, Object> c : cases(read("conventions.json").get("commitments"))) {
            Object pkg = c.get("package");
            String nonce = (String) c.get("nonce");
            if (c.containsKey("java")) {
                // The platform's runtime uses the part of such a nonce that is hex, without saying so; this SDK refuses it.
                Check.refuses((String) c.get("java"), () -> Conventions.commitment(pkg, nonce));
                refused++;
            } else if (c.containsKey("threw")) {
                Check.refuses("not_canonical", () -> Conventions.commitment(pkg, nonce));
                refused++;
            } else {
                Check.equal(c.get("value"), Conventions.commitment(pkg, nonce), (String) c.get("name"));
                same++;
            }
        }
        Check.isTrue(same >= 9 && refused >= 4, "the vectors were read: " + same + " commitments, " + refused + " refusals");
        // The sandbox settlement's own commitment, as the platform anchored it.
        Map<String, Object> response = Json.object(Json.parse(TestMain.resource("evidence/sandbox-anchored.json"), "invalid_json", "evidence"), "invalid_json", "evidence");
        Map<String, Object> commitment = object(response.get("commitment"));
        Check.equal(commitment.get("value"), Conventions.commitment(response.get("package"), (String) commitment.get("nonce")), "the commitment the platform anchored");
        Check.fails(NullPointerException.class, () -> Conventions.commitment(response.get("package"), null));
    }

    // ── base64 ────────────────────────────────────────────────────────────────

    static void testBase64IsReadAsTheReferenceReadsIt() throws Exception {
        Map<String, Object> base64 = object(read("conventions.json").get("base64"));
        List<String> failures = new ArrayList<>();
        int read = 0;
        int notBase64 = 0;
        for (Map<String, Object> c : cases(base64.get("decode"))) {
            String text = (String) c.get("text");
            String forgiving = hexOrNull(Conventions.base64UrlForgiving(text));
            if (c.get("forgiving") == null ? forgiving != null : !c.get("forgiving").equals(forgiving)) {
                failures.add(Json.compact(text) + " as a signature: " + forgiving + ", the reference reads " + c.get("forgiving"));
            }
            String lenient = Hex.encode(Conventions.base64Lenient(text));
            if (!c.get("lenient").equals(lenient)) {
                failures.add(Json.compact(text) + " as a stored key: " + lenient + ", the reference reads " + c.get("lenient"));
            }
            read++;
            notBase64 += c.get("forgiving") == null ? 1 : 0;
        }
        for (Map<String, Object> c : cases(base64.get("encode"))) {
            byte[] bytes = unhex((String) c.get("hex"));
            Check.equal(c.get("base64url"), Conventions.base64Url(bytes), "base64url of " + c.get("hex"));
            Check.equal(c.get("hex"), Hex.encode(Conventions.base64UrlStrict((String) c.get("base64url"))), "and back, strictly");
            Check.equal(c.get("hex"), Hex.encode(Conventions.base64UrlForgiving((String) c.get("base64url"))), "and back, forgivingly");
        }
        VerdictEngineTest.none(failures, "base64");
        Check.isTrue(read >= 55 && notBase64 >= 25, "the vectors were read: " + read + " texts, " + notBase64 + " that are not base64");
        // Strictly: the URL-safe alphabet, padded or not, and nothing else.
        Check.equal("010203", Hex.encode(Conventions.base64UrlStrict("AQID")), "four characters");
        Check.equal("01", Hex.encode(Conventions.base64UrlStrict("AQ")), "unpadded");
        Check.equal("01", Hex.encode(Conventions.base64UrlStrict("AQ==")), "padded");
        Check.equal("fbffbf", Hex.encode(Conventions.base64UrlStrict("-_-_")), "the URL-safe alphabet");
        Check.equal("", Hex.encode(Conventions.base64UrlStrict("")), "nothing");
        for (String refused : Arrays.asList("+/+/", "AQ ID", "AQ\nID", "AQID*", "A")) {
            Check.isTrue(Conventions.base64UrlStrict(refused) == null, Json.compact(refused) + " is not base64url");
        }
        Check.isTrue(Conventions.base64UrlStrict(null) == null && Conventions.base64UrlForgiving(null) == null, "no text is no bytes");
    }
}
