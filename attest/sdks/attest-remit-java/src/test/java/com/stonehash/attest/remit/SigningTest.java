package com.stonehash.attest.remit;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The signing conventions on their own: what is signed, in which order, and
 * what a signer that keeps its key elsewhere may hand back.
 */
final class SigningTest {
    private SigningTest() {
    }

    private static KeySigner newKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(g.generateKeyPair().getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
        return Signers.fromPkcs8Pem(pem);
    }

    private static Map<String, Object> element() {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("ref", "PAY-20261118-ab12cd");
        e.put("amount", "10000.00");
        e.put("currency", "USD");
        e.put("attached", Arrays.asList("invoice"));
        e.put("citedOnly", Arrays.asList());
        return e;
    }

    static void testEventBytesAreTheDomainThenCanonicalJson() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("payment_id", "PAY-1");
        payload.put("answers", Map.of("b", "2"));
        Check.equal("stonehash:remit:event:v1\n{\"answers\":{\"b\":\"2\"},\"payment_id\":\"PAY-1\"}",
                new String(Signing.eventBytes(payload), StandardCharsets.UTF_8), "the bytes signed for an event");
    }

    static void testAnEventSignedHereVerifiesAndAChangedOneDoesNot() throws Exception {
        KeySigner key = newKey();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("payment_id", "PAY-1");
        payload.put("reason", "duplicate");
        Map<String, Object> sig = Signing.signEvent(key, payload, "VN-BANK-0001", "Sample Bank");
        Check.equal(Arrays.asList("alg", "key_id", "issuer", "sig"), Arrays.asList(sig.keySet().toArray()), "the envelope's fields, in order");
        Check.equal(64, Base64.getUrlDecoder().decode((String) sig.get("sig")).length, "a raw r‖s signature");
        Check.isTrue(Signing.verifyEvent(payload, sig, key.publicKeySpkiBase64()), "the signature verifies under the signer's key");
        payload.put("reason", "another");
        Check.isTrue(!Signing.verifyEvent(payload, sig, key.publicKeySpkiBase64()), "and not over a changed payload");
        Check.isTrue(!Signing.verifyEvent(payload, sig, newKey().publicKeySpkiBase64()), "nor under another key");
    }

    static void testAnElementIsDigestedThenSignedAndTheUnsignedFieldsStayOutside() throws Exception {
        KeySigner key = newKey();
        Map<String, Object> finished = Signing.finishElement(key, element(), "VN-BANK-0001", "Sample Bank");
        Check.equal(Signing.elementDigest(element()), finished.get("digest"), "the digest is the element's own");
        Check.isTrue(Signing.verifyElement(finished, key.publicKeySpkiBase64()), "digest and signature hold");

        // What arrived in the submission is not what the issuer signed: changing it breaks nothing.
        Map<String, Object> repackaged = new LinkedHashMap<>(finished);
        repackaged.put("attached", Arrays.asList());
        repackaged.put("digestVerified", Boolean.FALSE);
        Check.isTrue(Signing.verifyElement(repackaged, key.publicKeySpkiBase64()), "attached / citedOnly / digestVerified are outside the signature");

        // What the issuer asserted is: an amount edited afterwards breaks both.
        Map<String, Object> edited = new LinkedHashMap<>(finished);
        edited.put("amount", "10000.01");
        Check.isTrue(!Signing.verifyElement(edited, key.publicKeySpkiBase64()), "an edited amount no longer verifies");
        String bytes = new String(Signing.elementBytes(finished), StandardCharsets.UTF_8);
        Check.isTrue(bytes.startsWith("stonehash:evidence:sig:v1\n{\"amount\":\"10000.00\",\"currency\":\"USD\",\"digest\":\""),
                "the signed bytes cover the digest and leave the unsigned fields out: " + bytes);
    }

    static void testASignerMayAnswerInDerOrRawAndIsCheckedEitherWay() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        java.security.KeyPair pair = g.generateKeyPair();
        String spki = Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
        String pem = "-----BEGIN PUBLIC KEY-----\n" + spki + "\n-----END PUBLIC KEY-----";
        byte[] message = "the exact bytes".getBytes(StandardCharsets.UTF_8);

        // The way an HSM behind JCA answers: DER.
        Signer der = Signers.external(pem, (m) -> {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(pair.getPrivate());
            s.update(m);
            return s.sign();
        });
        Check.equal(spki, der.publicKeySpkiBase64(), "a PEM public key is the same key as its base64 SPKI");
        byte[] raw = Signers.signRaw(der, message);
        Check.equal(64, raw.length, "a DER answer is returned raw");
        Check.isTrue(Signers.verifies(spki, message, raw), "and verifies");

        // A signer holding another key, and one that signs a digest of the message instead of the message.
        java.security.KeyPair other = g.generateKeyPair();
        Signer wrongKey = Signers.external(spki, (m) -> {
            Signature s = Signature.getInstance("SHA256withECDSAinP1363Format");
            s.initSign(other.getPrivate());
            s.update(m);
            return s.sign();
        });
        Check.refuses("signature_unverified", () -> Signers.signRaw(wrongKey, message));
        Signer truncated = Signers.external(spki, (m) -> new byte[40]);
        Check.refuses("signer_failed", () -> Signers.signRaw(truncated, message));
        Signer broken = Signers.external(spki, (m) -> { throw new java.io.IOException("slot 3 is not logged in"); });
        RemitException e = Check.refuses("signer_failed", () -> Signers.signRaw(broken, message));
        Check.isTrue(e.getMessage().contains("slot 3 is not logged in"), "the signer's own reason is passed on: " + e.getMessage());
        Check.refuses("invalid_key", () -> Signers.external("not a key", (m) -> m));
    }
}
