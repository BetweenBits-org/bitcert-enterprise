package com.stonehash.attest.por;

import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * A signature over a statement, in the envelope it travels in
 * (specification §6): ECDSA over P-256 with SHA-256, the 64 bytes
 * {@code r ‖ s} in base64url without padding.
 */
public final class SignatureEnvelope {
    private static final String CODE = "invalid_signature";
    private static final String ALG = "ES256";

    private final String alg;
    private final String keyId;
    private final String issuer;
    private final String sig;

    private SignatureEnvelope(String alg, String keyId, String issuer, String sig) {
        this.alg = alg;
        this.keyId = keyId;
        this.issuer = issuer;
        this.sig = sig;
    }

    /**
     * Signs a statement. The envelope names the statement's own exchange as
     * the key and the issuer, which is how the platform finds the registered
     * key to check it against.
     *
     * @throws PorException {@code invalid_signature_format} when the signer returns anything but 64 bytes
     */
    public static SignatureEnvelope sign(Statement statement, Signer signer) {
        Objects.requireNonNull(statement, "statement");
        Objects.requireNonNull(signer, "signer");
        String keyId = statement.institutionId();
        String issuer = statement.name();
        byte[] raw = signer.sign(statement.signingInput());
        if (raw == null || raw.length != 64) {
            throw new PorException("invalid_signature_format", "a Signer must return the 64 bytes r ‖ s; this one returned "
                    + (raw == null ? "nothing" : raw.length + " bytes") + " (a DER signature is converted with Signers.derToRaw)");
        }
        return new SignatureEnvelope(ALG, keyId, issuer, Base64.getUrlEncoder().withoutPadding().encodeToString(raw));
    }

    /**
     * Whether this signature is the given key's signature over the statement.
     * The platform runs the same check on arrival; running it first turns
     * "the wrong key was used" from a refused request into a message on the
     * machine where it can be fixed.
     *
     * @param spkiBase64 the public key as SubjectPublicKeyInfo DER in base64, the form the platform registers
     * @return false for a signature that does not verify and for anything malformed — never an exception
     */
    public boolean verifies(Statement statement, String spkiBase64) {
        Objects.requireNonNull(statement, "statement");
        byte[] raw = rawSignature();
        if (!ALG.equals(alg) || raw == null || spkiBase64 == null) {
            return false;
        }
        try {
            PublicKey key = KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(Base64.getMimeDecoder().decode(spkiBase64)));
            if (!isP256(key)) {
                return false;
            }
            Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
            verifier.initVerify(key);
            verifier.update(statement.signingInput());
            return verifier.verify(raw);
        } catch (GeneralSecurityException | IllegalArgumentException | PorException e) {
            // Not a key, not a signature, or a statement with no canonical form: in every case, not verified.
            return false;
        }
    }

    private static boolean isP256(PublicKey key) throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec p256 = parameters.getParameterSpec(ECParameterSpec.class);
        ECParameterSpec actual = ((ECPublicKey) key).getParams();
        return actual.getCurve().equals(p256.getCurve()) && actual.getGenerator().equals(p256.getGenerator())
                && actual.getOrder().equals(p256.getOrder());
    }

    /** The 64 signature bytes, or null when {@code sig} is not base64url of exactly that many. */
    private byte[] rawSignature() {
        if (sig.isEmpty()) {
            return null;
        }
        for (int i = 0; i < sig.length(); i++) {
            char c = sig.charAt(i);
            boolean base64url = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!base64url) {
                return null;
            }
        }
        try {
            byte[] raw = Base64.getUrlDecoder().decode(sig);
            return raw.length == 64 ? raw : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** True when {@code alg} is ES256 and {@code sig} decodes to 64 bytes: the envelope's shape, not its validity. */
    boolean wellFormed() {
        return ALG.equals(alg) && rawSignature() != null;
    }

    /** Always {@code ES256} for an envelope made here. */
    public String alg() {
        return alg;
    }

    /** The exchange's institution id: names the registered key the platform checks against. */
    public String keyId() {
        return keyId;
    }

    public String issuer() {
        return issuer;
    }

    /** The signature: base64url, no padding, of the 64 bytes {@code r ‖ s}. */
    public String sig() {
        return sig;
    }

    public Map<String, Object> toMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("alg", alg);
        out.put("key_id", keyId);
        out.put("issuer", issuer);
        out.put("sig", sig);
        return out;
    }

    /** @throws PorException {@code invalid_signature} when a member is missing or not a string */
    public static SignatureEnvelope fromMap(Map<String, ?> json) {
        return fromJson(json);
    }

    static SignatureEnvelope fromJson(Object value) {
        Map<String, Object> m = Json.object(value, CODE, "sig");
        return new SignatureEnvelope(Json.string(m.get("alg"), CODE, "sig.alg"), Json.string(m.get("key_id"), CODE, "sig.key_id"),
                Json.string(m.get("issuer"), CODE, "sig.issuer"), Json.string(m.get("sig"), CODE, "sig.sig"));
    }
}
