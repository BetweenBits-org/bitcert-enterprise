package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.db.StoredText;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.remit.Conventions;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Checking what others signed.
 *
 * <p>Two conventions, one primitive (ES256 over domain-separated canonical
 * JSON, raw {@code r ‖ s} in base64url). An <b>event</b> — an authorisation,
 * a cancellation, a partner's acknowledgement — travels as a payload with a
 * detached envelope {@code { alg, key_id, issuer, sig }} beside it. An
 * <b>evidence element</b> carries its signature inside itself
 * ({@code signature.value}), over the element without its unsigned fields.
 * The bytes are the SDK's ({@link Conventions}); what is here is only how
 * the service reads a signature a client or a partner handed it — a value of
 * any shape — and answers yes or no, never with a fault of its own.
 */
public final class Signatures {
    private Signatures() {
    }

    /**
     * Does the envelope's signature verify over the payload with this key?
     * Not {@code ES256}, no signature text, a key that cannot be read, a
     * payload with no canonical form: all no.
     *
     * @param sig the envelope as it arrived; anything but nothing at all (the callers refuse a missing one first)
     * @param spki the signer's registered key, as stored
     */
    public static boolean verifyEvent(Object payload, Object sig, String spki) {
        if (!"ES256".equals(JsValues.member(sig, "alg")) || !JsValues.truthy(JsValues.member(sig, "sig"))) {
            return false;
        }
        Object canonical;
        try {
            canonical = Canonical.forSdk(payload);
        } catch (PlainError | IllegalArgumentException e) {
            return false;
        }
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("alg", "ES256");
        envelope.put("sig", JsValues.member(sig, "sig"));
        return Conventions.verifyEvent(canonical, envelope, PublicKeys.forVerification(spki));
    }

    /** Does an evidence element's own signature verify with this key? Anything that is not an element with a signature value: no. */
    @SuppressWarnings("unchecked")
    public static boolean elementSignatureValid(Object element, String spki) {
        if (!(element instanceof Map)) {
            return false;
        }
        Object signature = ((Map<String, Object>) element).get("signature");
        if (!JsValues.truthy(JsValues.memberIfAny(signature, "value"))) {
            return false;
        }
        Object canonical;
        try {
            canonical = Canonical.forSdk(element);
        } catch (PlainError | IllegalArgumentException e) {
            return false;
        }
        return Conventions.verifyElementSignature((Map<String, Object>) canonical, PublicKeys.forVerification(spki));
    }

    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    /** Is the value, read as text, 64 lower-case hex digits? Nothing at all is not. */
    static boolean isDigestText(Object v) {
        return HEX64.matcher(JsValues.nullish(v) ? "" : JsValues.string(v)).matches();
    }

    /**
     * The bytes of a client's text as the previous service's runtime made
     * them before hashing: UTF-8, half a surrogate pair written as U+FFFD.
     * A list is read as a list of bytes, as that runtime read one. Anything
     * else had no bytes there — that service failed inside its runtime.
     */
    static byte[] bytesOf(Object v) {
        if (v instanceof String) {
            return StoredText.wellFormed((String) v).getBytes(StandardCharsets.UTF_8);
        }
        if (v instanceof List) {
            List<?> list = (List<?>) v;
            byte[] out = new byte[list.size()];
            for (int i = 0; i < out.length; i++) {
                Object item = list.get(i);
                double n = item instanceof Double ? (Double) item : item instanceof Boolean ? ((Boolean) item ? 1 : 0)
                        : item instanceof String ? Js.toNumber((String) item) : item == null ? 0 : Double.NaN;
                out[i] = Double.isNaN(n) || Double.isInfinite(n) ? 0 : (byte) (long) n;
            }
            return out;
        }
        throw new JsValues.EngineError("a value that is neither text nor a list was read as bytes");
    }

    /** SHA-256, in hex, of {@link #bytesOf}. */
    static String sha256Hex(Object textOrBytes) {
        return Hex.encode(Hex.sha256(bytesOf(textOrBytes)));
    }

    /**
     * Mode B: is the bank's signed statement about <em>this</em> message?
     *
     * <p>The platform cannot read a mode B message, so everything rests on
     * what the bank put its key to. A statement that says only "the required
     * fields are present" stays true of any other ciphertext put in its
     * place — and with it another beneficiary account. So the statement must
     * also carry the digest of the message and the SHA-256 of the compact
     * JWE, and both must be the ones submitted.
     *
     * @param assertion {@code compliance_payload.fields_assertion}, as it arrived
     * @return what is wrong, or {@code null}
     */
    public static String fieldsAssertionProblem(Object assertion, String paymentId, Object ivms101Digest, Object ciphertext, String bankSpki) {
        Object payload = JsValues.memberIfAny(assertion, "payload");
        Object sig = JsValues.memberIfAny(assertion, "sig");
        if (!JsValues.truthy(payload) || !JsValues.truthy(sig) || !verifyEvent(payload, sig, bankSpki)) {
            return "mode B requires a bank-signed fields_assertion over the required-fields claim";
        }
        if (!JsValues.strictEquals(JsValues.member(payload, "payment_id"), paymentId)
                || !Boolean.TRUE.equals(JsValues.member(payload, "required_fields_present"))) {
            return "fields_assertion must name this payment_id and assert required_fields_present: true";
        }
        if (!JsValues.strictEquals(JsValues.member(payload, "ivms101_digest"), ivms101Digest)
                || !JsValues.strictEquals(JsValues.member(payload, "ciphertext_sha256"), sha256Hex(ciphertext))) {
            return "fields_assertion must carry ivms101_digest and ciphertext_sha256 (the SHA-256 of the compact JWE), and both must be "
                    + "the ones submitted — the bank's signature has to cover the message it vouches for, or another could be put in its place";
        }
        return null;
    }
}
