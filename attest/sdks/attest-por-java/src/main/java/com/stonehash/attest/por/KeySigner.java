package com.stonehash.attest.por;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Base64;
import javax.crypto.KeyAgreement;

/**
 * A {@link Signer} over a P-256 private key held in memory, with the key's
 * public half in the form the platform registers.
 */
public final class KeySigner implements Signer {
    private static final String ALGORITHM = "SHA256withECDSAinP1363Format";

    private final ECPrivateKey key;
    private final String publicKeySpkiBase64;

    KeySigner(ECPrivateKey key) {
        ECParameterSpec p256 = p256();
        ECParameterSpec params = key.getParams();
        if (params == null || !params.getCurve().equals(p256.getCurve()) || !params.getGenerator().equals(p256.getGenerator())
                || !params.getOrder().equals(p256.getOrder())) {
            throw new PorException("invalid_key",
                    "the signing key must be an ECDSA P-256 key (ES256), the kind the console issues");
        }
        this.key = key;
        this.publicKeySpkiBase64 = derivePublicKey(key, p256);
    }

    @Override
    public byte[] sign(byte[] message) {
        try {
            Signature signature = Signature.getInstance(ALGORITHM);
            signature.initSign(key);
            signature.update(message);
            return signature.sign();
        } catch (GeneralSecurityException e) {
            throw new PorException("signing_failed", "the key could not sign: " + e.getMessage(), e);
        }
    }

    /**
     * The public half as SubjectPublicKeyInfo DER in base64 — exactly the
     * text the platform's registry holds, so the two can be compared before
     * anything is signed with a key the platform would not accept.
     */
    public String publicKeySpkiBase64() {
        return publicKeySpkiBase64;
    }

    private static ECParameterSpec p256() {
        try {
            AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
            parameters.init(new ECGenParameterSpec("secp256r1"));
            return parameters.getParameterSpec(ECParameterSpec.class);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("this Java runtime does not provide the curve P-256", e);
        }
    }

    /**
     * A PKCS#8 file need not carry the public key, and Java offers no call
     * that computes it. A Diffie-Hellman agreement with the curve's base point
     * as the other party returns the x-coordinate of exactly that key; the
     * curve equation then leaves two candidates for y, and the right one is
     * the one a signature from this key verifies under. The private scalar
     * never leaves the provider's own arithmetic.
     */
    private static String derivePublicKey(ECPrivateKey key, ECParameterSpec p256) {
        try {
            KeyFactory factory = KeyFactory.getInstance("EC");
            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(key);
            agreement.doPhase(factory.generatePublic(new ECPublicKeySpec(p256.getGenerator(), p256)), true);
            BigInteger x = new BigInteger(1, agreement.generateSecret());

            BigInteger p = ((ECFieldFp) p256.getCurve().getField()).getP();
            BigInteger ySquared = x.pow(3).add(p256.getCurve().getA().multiply(x)).add(p256.getCurve().getB()).mod(p);
            // p ≡ 3 (mod 4), so a square root is the (p + 1) / 4 th power.
            BigInteger y = ySquared.modPow(p.add(BigInteger.ONE).shiftRight(2), p);

            byte[] probe = "stonehash-attest-por public key derivation".getBytes(StandardCharsets.US_ASCII);
            Signature signer = Signature.getInstance(ALGORITHM);
            signer.initSign(key);
            signer.update(probe);
            byte[] signed = signer.sign();
            for (BigInteger candidate : new BigInteger[] { y, p.subtract(y) }) {
                PublicKey publicKey = factory.generatePublic(new ECPublicKeySpec(new ECPoint(x, candidate), p256));
                Signature verifier = Signature.getInstance(ALGORITHM);
                verifier.initVerify(publicKey);
                verifier.update(probe);
                if (verifier.verify(signed)) {
                    return Base64.getEncoder().encodeToString(publicKey.getEncoded());
                }
            }
        } catch (GeneralSecurityException e) {
            throw new PorException("invalid_key", "the signing key could not be used: " + e.getMessage(), e);
        }
        throw new PorException("invalid_key", "the signing key does not verify its own signature");
    }
}
