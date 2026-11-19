package com.stonehash.attest.por;

/**
 * Whatever holds the exchange's signing key.
 *
 * <p>The library never needs the key itself, only this one operation, so the
 * key can stay where an exchange keeps such things: in an HSM, in a cloud KMS,
 * on a machine with no route to the internet. Implement the method over that
 * and hand the object to {@link Submission#sign}.
 *
 * <pre>{@code
 * Signer kms = message -> {
 *     byte[] der = myKms.sign(KEY_ID, "ECDSA_SHA_256", message);   // most services answer in DER
 *     return Signers.derToRaw(der);                                 // the protocol wants r ‖ s
 * };
 * }</pre>
 *
 * <p>For a key in a PKCS#8 PEM file there is {@link Signers#fromPkcs8Pem}.
 */
public interface Signer {
    /**
     * Signs with ECDSA over the curve P-256, hashing the message with
     * SHA-256 (the algorithm JOSE calls ES256).
     *
     * @param message the exact bytes to be signed — not a digest of them. A
     *                service that takes a digest is given their SHA-256.
     * @return the signature as 64 bytes: {@code r} then {@code s}, each 32
     *         bytes, big-endian. Not DER; {@link Signers#derToRaw} converts.
     */
    byte[] sign(byte[] message);
}
