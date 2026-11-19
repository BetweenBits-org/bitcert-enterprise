package com.stonehash.attest.remit;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The byte conventions of the corridor, each in one place: what is signed,
 * what is hashed, and how a signature travels.
 *
 * <p><b>A bank integration does not need this class</b> —
 * {@link RemitClient} and {@link EvidenceVerifier} apply the conventions for
 * it. It is here for the platform's own back end, which signs events and
 * evidence elements, commits to evidence packages and verifies what banks
 * send, and must produce the very bytes the reference implementation
 * produces. Every method is held to that implementation by
 * {@code golden/conventions.json}.
 *
 * <ul>
 * <li><b>Canonical JSON</b> (RFC 8785): members sorted by name, no white
 *     space, whole numbers only. Everything below is over canonical bytes.
 *     A number is taken at its value, as the reference — which holds
 *     nothing else of a number — takes it: 1, 1.0 and 1e0 are one number,
 *     written {@code 1}, whether it arrives as a {@code Long}, a
 *     {@code BigDecimal} or a {@code Double}; a number that is not whole, or
 *     beyond ±(2^53 − 1), has no canonical form.
 * <li><b>An event</b> — an authorisation, a webhook envelope, a state
 *     change — is signed over {@code "stonehash:remit:event:v1\n" ‖ JCS(payload)}.
 * <li><b>An evidence element</b> is signed over
 *     {@code "stonehash:evidence:sig:v1\n" ‖ JCS(element)} without its
 *     {@code signature}, {@code digestVerified}, {@code attached} and
 *     {@code citedOnly}; its content digest is SHA-256 of
 *     {@code "stonehash:evidence:digest:v1\n" ‖ JCS(element)} without those
 *     and without {@code digest} itself.
 * <li><b>An evidence package</b> is committed to as
 *     {@code SHA-256("STONEHASH-EVIDENCE-V1" ‖ nonce ‖ JCS(package))}.
 * <li><b>A signature</b> is ES256 — ECDSA on P-256 over SHA-256 and nothing
 *     else — as raw {@code r ‖ s} (64 bytes) in base64url without padding.
 * </ul>
 * The domains differ so that a signature over one kind of thing can never be
 * replayed as a signature over another.
 */
public final class Conventions {
    private Conventions() {
    }

    /** What precedes an event's canonical bytes when it is signed. The line break is part of it. */
    public static final String EVENT_DOMAIN = Signing.EVENT_DOMAIN;
    /** What precedes an evidence element's canonical bytes when it is signed. */
    public static final String ELEMENT_SIGNATURE_DOMAIN = Signing.SIGNATURE_DOMAIN;
    /** What precedes an evidence element's canonical bytes when its content digest is taken. */
    public static final String ELEMENT_DIGEST_DOMAIN = Signing.DIGEST_DOMAIN;
    /** What precedes the nonce and the package when an evidence package is committed to. No line break. */
    public static final String EVIDENCE_COMMIT_DOMAIN = EvidenceVerifier.COMMIT_DOMAIN;

    // ── canonical JSON ────────────────────────────────────────────────────────

    /**
     * RFC 8785 canonical JSON, as text.
     *
     * @throws RemitException {@code not_canonical} for a number whose value is not a whole number within ±(2^53 − 1) — an
     *                        amount is written as a decimal string, never as a number
     */
    public static String canonical(Object value) {
        return Json.canonical(JsValue.integers(value));
    }

    /** The UTF-8 bytes of {@link #canonical}: what is signed and hashed. */
    public static byte[] canonicalBytes(Object value) {
        return Json.canonicalBytes(JsValue.integers(value));
    }

    /** The element with its numbers at their value; the element itself where there is nothing to change. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> atValue(Map<String, Object> element) {
        return (Map<String, Object>) JsValue.integers(Objects.requireNonNull(element, "element"));
    }

    // ── events ────────────────────────────────────────────────────────────────

    /** The exact bytes signed for an event: {@link #EVENT_DOMAIN} ‖ JCS(payload). */
    public static byte[] eventSigningBytes(Object payload) {
        return Signing.eventBytes(JsValue.integers(payload));
    }

    /** SHA-256 of {@link #eventSigningBytes}, 64 lowercase hex characters: a name for exactly what was signed. */
    public static String eventSigningDigest(Object payload) {
        return Hex.sha256Hex(eventSigningBytes(payload));
    }

    /**
     * The detached signature envelope over an event:
     * {@code { alg: "ES256", key_id, issuer, sig }}. The signer's answer is
     * checked against its own public key before it is returned.
     *
     * @throws RemitException {@code signer_failed} or {@code signature_unverified} when the signer did not produce a
     *                        signature that verifies over these bytes
     */
    public static Map<String, Object> signEvent(Object payload, Signer signer, String keyId, String issuer) {
        Objects.requireNonNull(signer, "signer");
        Objects.requireNonNull(keyId, "keyId");
        Objects.requireNonNull(issuer, "issuer");
        return Signing.signEvent(signer, JsValue.integers(payload), keyId, issuer);
    }

    /**
     * Whether {@code signature} is a valid envelope over {@code payload}
     * under the key — never an exception: an envelope that is not one, an
     * algorithm other than ES256, a key that is not a P-256 key, a payload
     * with no canonical form, all answer {@code false}.
     *
     * <p>The signature text and the key are read as kindly as the reference
     * reads them (either base64 alphabet, padded or not; a key with line
     * breaks in it), because kindness there decides nothing: the bytes still
     * have to verify. One thing is stricter than the reference, whose
     * runtime would check a signature of whatever kind the key is: here a
     * key that is not ECDSA P-256 verifies nothing.
     *
     * @param signature the envelope, as it travelled: an object with {@code alg} and {@code sig}
     * @param spkiBase64 the signer's public key, base64 of its SPKI (DER)
     */
    public static boolean verifyEvent(Object payload, Object signature, String spkiBase64) {
        if (!(signature instanceof Map)) {
            return false;
        }
        Map<?, ?> envelope = (Map<?, ?>) signature;
        if (!"ES256".equals(envelope.get("alg")) || !(envelope.get("sig") instanceof String)) {
            return false;
        }
        byte[] message;
        try {
            message = eventSigningBytes(payload);
        } catch (RemitException e) {
            return false;
        }
        return verifies(message, (String) envelope.get("sig"), spkiBase64);
    }

    // ── evidence elements ─────────────────────────────────────────────────────

    /**
     * The exact bytes an issuer signs for one evidence element:
     * {@link #ELEMENT_SIGNATURE_DOMAIN} ‖ JCS(element without
     * {@code signature}, {@code digestVerified}, {@code attached},
     * {@code citedOnly}). The element's {@code digest}, when it carries one,
     * is covered.
     */
    public static byte[] elementSigningBytes(Map<String, Object> element) {
        return Signing.elementBytes(atValue(element));
    }

    /** SHA-256 of {@link #elementSigningBytes}, 64 lowercase hex characters: for display, and for citing in a finding. */
    public static String elementSigningDigest(Map<String, Object> element) {
        return Hex.sha256Hex(elementSigningBytes(element));
    }

    /**
     * An element's content digest, which it then carries as {@code digest}:
     * SHA-256 of {@link #ELEMENT_DIGEST_DOMAIN} ‖ JCS(element without the
     * four unsigned fields and without {@code digest}). 64 lowercase hex
     * characters.
     */
    public static String elementDigest(Map<String, Object> element) {
        return Signing.elementDigest(atValue(element));
    }

    /**
     * The element with an issuer signature added, over the element as it
     * stands — nothing else about it is changed, and no digest is added:
     * {@code signature: { status: "VALID", keyId, algorithm: "ES256", issuer, trustLevel: "ATTESTED", value }}.
     * The status is a claim; whoever verifies recomputes it.
     *
     * @return a new element; the one handed over is not changed
     * @throws RemitException {@code signer_failed} or {@code signature_unverified}
     */
    public static Map<String, Object> signElement(Map<String, Object> element, Signer signer, String keyId, String issuer) {
        Objects.requireNonNull(element, "element");
        Objects.requireNonNull(signer, "signer");
        Objects.requireNonNull(keyId, "keyId");
        Objects.requireNonNull(issuer, "issuer");
        // Signed over the element with its numbers at their value; what comes back is the element as it was handed over.
        Map<String, Object> out = new LinkedHashMap<>(element);
        out.put("signature", Signing.signElement(signer, atValue(element), keyId, issuer).get("signature"));
        return out;
    }

    /**
     * Digest, then sign — the order every issuer follows, so that the
     * signature covers the digest the element declares: the element with its
     * {@code digest} set to {@link #elementDigest} and then signed as
     * {@link #signElement} signs.
     */
    public static Map<String, Object> digestAndSignElement(Map<String, Object> element, Signer signer, String keyId, String issuer) {
        Objects.requireNonNull(element, "element");
        Objects.requireNonNull(signer, "signer");
        Objects.requireNonNull(keyId, "keyId");
        Objects.requireNonNull(issuer, "issuer");
        Map<String, Object> finished = Signing.finishElement(signer, atValue(element), keyId, issuer);
        Map<String, Object> out = new LinkedHashMap<>(element);
        out.put("digest", finished.get("digest"));
        out.put("signature", finished.get("signature"));
        return out;
    }

    /**
     * Whether the element's {@code signature.value} is a valid signature
     * over {@link #elementSigningBytes} under the key. Says nothing about who
     * holds the key; that is a keyring's business ({@link Rules#checkSignatures}).
     */
    public static boolean verifyElementSignature(Map<String, Object> element, String spkiBase64) {
        Objects.requireNonNull(element, "element");
        Object signature = element.get("signature");
        Object value = signature instanceof Map ? ((Map<?, ?>) signature).get("value") : null;
        if (!(value instanceof String)) {
            return false;
        }
        byte[] message;
        try {
            message = elementSigningBytes(element);
        } catch (RemitException e) {
            return false;
        }
        return verifies(message, (String) value, spkiBase64);
    }

    // ── ES256 ─────────────────────────────────────────────────────────────────

    /**
     * An ES256 signature over the message as it travels: raw {@code r ‖ s}
     * in base64url without padding. The signer hashes the message itself
     * (SHA-256); its answer may be raw or DER, and is checked against its
     * own public key before it is returned.
     *
     * @throws RemitException {@code signer_failed} or {@code signature_unverified}
     */
    public static String sign(byte[] message, Signer signer) {
        Objects.requireNonNull(message, "message");
        Objects.requireNonNull(signer, "signer");
        return Base64Url.encode(Signers.signRaw(signer, message));
    }

    /**
     * Whether {@code signature} — raw {@code r ‖ s}, base64url — is an ES256
     * signature over the message under the key. Never an exception.
     *
     * @param spkiBase64 the public key, base64 of its SPKI (DER); anything but an ECDSA P-256 key verifies nothing
     */
    public static boolean verifies(byte[] message, String signature, String spkiBase64) {
        if (message == null || signature == null || signature.isEmpty() || spkiBase64 == null) {
            return false;
        }
        byte[] raw = Base64Url.forgiving(signature);
        return raw != null && Signers.verifies(Base64.getEncoder().encodeToString(Base64Url.lenient(spkiBase64)), message, raw);
    }

    // ── the evidence-package commitment ───────────────────────────────────────

    /**
     * What an evidence package is anchored as:
     * {@code SHA-256(}{@link #EVIDENCE_COMMIT_DOMAIN}{@code  ‖ nonce ‖ JCS(package))},
     * 64 lowercase hex characters. The nonce keeps the anchored value from
     * revealing anything about the payment; it is disclosed with the package.
     *
     * @param nonceHex the nonce, hex — an even number of hex digits
     * @throws RemitException {@code invalid_nonce} when the nonce is not hex (the reference would silently use the part
     *                        of it that is); {@code not_canonical} when the package has no canonical form
     */
    public static String commitment(Object evidencePackage, String nonceHex) {
        return Signing.commitment(JsValue.integers(evidencePackage), Objects.requireNonNull(nonceHex, "nonceHex"));
    }

    // ── base64 ────────────────────────────────────────────────────────────────

    /** base64url without padding: how a signature travels in every envelope of the protocol. */
    public static String base64Url(byte[] bytes) {
        return Base64Url.encode(Objects.requireNonNull(bytes, "bytes"));
    }

    /**
     * base64url to bytes, strictly: the URL-safe alphabet, padded or not.
     * {@code null} when the text is not that.
     */
    public static byte[] base64UrlStrict(String text) {
        return Base64Url.decodeOrNull(text);
    }

    /**
     * base64url to bytes the way the reference reads a signature
     * ({@code fromBase64Url}), which is more forgiving than base64url:
     * either alphabet, padded or not, ASCII white space ignored.
     * {@code null} when the text is not base64 at all — where the reference
     * throws.
     */
    public static byte[] base64UrlForgiving(String text) {
        return text == null ? null : Base64Url.forgiving(text);
    }

    /**
     * base64 to bytes the way the reference's runtime reads a stored key
     * ({@code Buffer.from(text, "base64")}): either alphabet, anything
     * outside it skipped, ending at the first padding character. Never
     * fails; whether the bytes are what was expected is for the caller.
     */
    public static byte[] base64Lenient(String text) {
        return Base64Url.lenient(Objects.requireNonNull(text, "text"));
    }
}
