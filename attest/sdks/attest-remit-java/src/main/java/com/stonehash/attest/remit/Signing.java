package com.stonehash.attest.remit;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The bank's half of the signing conventions — implemented from the published
 * rules, on the bank's side of the wire.
 *
 * <p>Three byte strings, each behind its own domain separator so that a
 * signature over one can never be replayed as a signature over another:
 * <ul>
 * <li>an <b>event</b> (an authorization, a cancellation, a manifest, a webhook
 *     envelope): {@code "stonehash:remit:event:v1\n" ‖ JCS(payload)};
 * <li>an evidence element's <b>content digest</b>:
 *     {@code SHA-256("stonehash:evidence:digest:v1\n" ‖ JCS(element without the unsigned fields and its digest))};
 * <li>an evidence element's <b>signature</b>:
 *     {@code "stonehash:evidence:sig:v1\n" ‖ JCS(element, digest included, without the unsigned fields)}.
 * </ul>
 * Digest, then sign — the order every issuer follows, so the signature covers
 * the digest the element declares.
 */
final class Signing {
    static final String EVENT_DOMAIN = "stonehash:remit:event:v1\n";
    static final String DIGEST_DOMAIN = "stonehash:evidence:digest:v1\n";
    static final String SIGNATURE_DOMAIN = "stonehash:evidence:sig:v1\n";

    /** Fields outside both the signature and the digest, per the evidence specification. */
    private static final List<String> UNSIGNED_FIELDS = Arrays.asList("signature", "digestVerified", "attached", "citedOnly");

    private Signing() {
    }

    private static byte[] prefixed(String domain, Object value) {
        byte[] head = domain.getBytes(StandardCharsets.UTF_8);
        byte[] body = Json.canonicalBytes(value);
        byte[] out = new byte[head.length + body.length];
        System.arraycopy(head, 0, out, 0, head.length);
        System.arraycopy(body, 0, out, head.length, body.length);
        return out;
    }

    /** The exact bytes signed for an event. */
    static byte[] eventBytes(Object payload) {
        return prefixed(EVENT_DOMAIN, payload);
    }

    private static Map<String, Object> core(Map<String, Object> element, boolean dropDigest) {
        Map<String, Object> core = new LinkedHashMap<>(element);
        for (String field : UNSIGNED_FIELDS) {
            core.remove(field);
        }
        if (dropDigest) {
            core.remove("digest");
        }
        return core;
    }

    /** An element's self-describing content digest: 64 lowercase hex characters. */
    static String elementDigest(Map<String, Object> element) {
        return Hex.sha256Hex(prefixed(DIGEST_DOMAIN, core(element, true)));
    }

    /** The exact bytes an issuer signs for one evidence element (its digest included). */
    static byte[] elementBytes(Map<String, Object> element) {
        return prefixed(SIGNATURE_DOMAIN, core(element, false));
    }

    /** The signature envelope over an event: {@code { alg, key_id, issuer, sig }}. */
    static Map<String, Object> signEvent(Signer signer, Object payload, String keyId, String issuer) {
        byte[] raw = Signers.signRaw(signer, eventBytes(payload));
        Map<String, Object> sig = new LinkedHashMap<>();
        sig.put("alg", "ES256");
        sig.put("key_id", keyId);
        sig.put("issuer", issuer);
        sig.put("sig", Base64Url.encode(raw));
        return sig;
    }

    /** Whether {@code sig} is a valid ES256 event signature over {@code payload} under the given key. */
    static boolean verifyEvent(Object payload, Object sig, String spkiBase64) {
        if (!(sig instanceof Map)) {
            return false;
        }
        Map<?, ?> envelope = (Map<?, ?>) sig;
        if (!"ES256".equals(envelope.get("alg")) || !(envelope.get("sig") instanceof String) || spkiBase64 == null) {
            return false;
        }
        byte[] raw = Base64Url.decodeOrNull((String) envelope.get("sig"));
        try {
            return Signers.verifies(spkiBase64, eventBytes(payload), raw);
        } catch (RemitException e) {
            return false;
        }
    }

    /**
     * The element with an issuer signature added, over the element as it
     * stands: its digest is covered if it carries one, and none is added.
     */
    static Map<String, Object> signElement(Signer signer, Map<String, Object> element, String keyId, String issuer) {
        byte[] raw = Signers.signRaw(signer, elementBytes(element));
        Map<String, Object> signature = new LinkedHashMap<>();
        signature.put("status", "VALID");
        signature.put("keyId", keyId);
        signature.put("algorithm", "ES256");
        signature.put("issuer", issuer);
        signature.put("trustLevel", "ATTESTED");
        signature.put("value", Base64Url.encode(raw));
        Map<String, Object> out = new LinkedHashMap<>(element);
        out.put("signature", signature);
        return out;
    }

    /** The element with its digest and its issuer signature added, in that order. */
    static Map<String, Object> finishElement(Signer signer, Map<String, Object> element, String keyId, String issuer) {
        Map<String, Object> out = new LinkedHashMap<>(element);
        out.put("digest", elementDigest(element));
        return signElement(signer, out, keyId, issuer);
    }

    /**
     * What an evidence package is anchored as:
     * {@code SHA-256("STONEHASH-EVIDENCE-V1" ‖ nonce ‖ JCS(package))}, 64
     * lowercase hex characters.
     *
     * @throws RemitException {@code invalid_nonce} when the nonce is not an even number of hex digits; {@code not_canonical}
     */
    static String commitment(Object evidencePackage, String nonceHex) {
        byte[] nonce = new byte[nonceHex.length() / 2];
        if (nonceHex.length() % 2 != 0 || !Hex.decodeInto(nonceHex, nonce, 0, nonce.length)) {
            throw new RemitException("invalid_nonce", "the commitment's nonce is not hex");
        }
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        bytes.writeBytes(EvidenceVerifier.COMMIT_DOMAIN.getBytes(StandardCharsets.UTF_8));
        bytes.writeBytes(nonce);
        bytes.writeBytes(Json.canonicalBytes(evidencePackage));
        return Hex.sha256Hex(bytes.toByteArray());
    }

    /** Whether a finished element's digest and signature both hold under the given key. */
    static boolean verifyElement(Map<String, Object> element, String spkiBase64) {
        Object signature = element.get("signature");
        if (!(signature instanceof Map) || !(element.get("digest") instanceof String)) {
            return false;
        }
        if (!elementDigest(element).equals(element.get("digest"))) {
            return false;
        }
        Object value = ((Map<?, ?>) signature).get("value");
        byte[] raw = value instanceof String ? Base64Url.decodeOrNull((String) value) : null;
        return Signers.verifies(spkiBase64, elementBytes(element), raw);
    }
}
