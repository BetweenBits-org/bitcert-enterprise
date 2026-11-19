package com.stonehash.attest.remit;

/**
 * Whatever holds the bank's instruction-signing key.
 *
 * <p>The SDK never needs the key itself, only these two things, so the key
 * stays where a bank keeps such things: in an HSM, behind a KMS, in a signing
 * service. The SDK prepares the exact bytes, the signer returns an ES256
 * signature, and the SDK <b>verifies it against {@link #publicKeySpkiBase64()}
 * before using it</b> — so a misconfigured slot, a wrong key label or a
 * truncated response fails here, with a clear message, instead of at the
 * platform as "invalid signature".
 *
 * <pre>{@code
 * Signer hsm = Signers.external(publicKeyPem, message -> {
 *     Signature s = Signature.getInstance("SHA256withECDSA", pkcs11Provider);
 *     s.initSign(hsmPrivateKey);
 *     s.update(message);
 *     return s.sign();                      // DER is fine; so is raw r ‖ s
 * });
 * }</pre>
 *
 * <p>For a key in a PKCS#8 PEM file — the sandbox key the console hands out —
 * there is {@link Signers#fromPkcs8Pem}.
 */
public interface Signer {
    /**
     * Signs with ECDSA over the curve P-256, hashing the message with SHA-256
     * (the algorithm JOSE calls ES256).
     *
     * @param message the exact bytes to be signed — not a digest of them. Hand
     *                them to a "sign with SHA-256" operation, not a pre-hashed one.
     * @return the signature, either as 64 bytes {@code r ‖ s} or as ASN.1 DER
     *         (what Java's {@code SHA256withECDSA}, PKCS#11 tokens through JCA
     *         and most cloud key services produce). Both are accepted;
     *         verification decides.
     */
    byte[] sign(byte[] message);

    /**
     * The public half of the key the signer holds, as SubjectPublicKeyInfo DER
     * in base64 — the form the platform's Trust Registry holds. It must be the
     * key registered for the institution; {@link RemitClient#assertRegistered()}
     * checks that.
     */
    String publicKeySpkiBase64();
}
