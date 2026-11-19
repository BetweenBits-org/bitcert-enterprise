package com.stonehash.attest.remit;

import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Objects;

/** Ready-made {@link Signer}s, and what an HSM or KMS integration needs around them. */
public final class Signers {
    /** The one operation an external signer supplies: message in, ES256 signature (raw or DER) out. */
    @FunctionalInterface
    public interface SignFunction {
        byte[] sign(byte[] message) throws Exception;
    }

    /**
     * A signer over a key this process never holds: an HSM slot, a KMS key, a
     * signing service.
     *
     * @param publicKey the public half of that key — a PEM {@code PUBLIC KEY} block or base64 SPKI (DER)
     * @param sign      signs the given bytes with ECDSA P-256 over SHA-256 and returns the signature,
     *                  raw {@code r ‖ s} or DER
     * @throws RemitException {@code invalid_key} when the public key is not a P-256 key
     */
    public static Signer external(String publicKey, SignFunction sign) {
        Objects.requireNonNull(sign, "sign");
        final String spki = spkiBase64Of(publicKey);
        return new Signer() {
            @Override
            public byte[] sign(byte[] message) {
                try {
                    return sign.sign(message);
                } catch (RemitException e) {
                    throw e;
                } catch (Exception e) {
                    throw new RemitException("signer_failed", "the external signer failed: " + e.getMessage(), e);
                }
            }

            @Override
            public String publicKeySpkiBase64() {
                return spki;
            }
        };
    }

    /**
     * PEM or base64 SPKI → base64 SPKI (DER), checked to be a P-256 public key.
     *
     * @throws RemitException {@code invalid_key}
     */
    public static String spkiBase64Of(String publicKey) {
        Objects.requireNonNull(publicKey, "publicKey");
        String text = publicKey.trim();
        byte[] der;
        try {
            if (text.startsWith("-----")) {
                int begin = text.indexOf("-----BEGIN PUBLIC KEY-----");
                int end = text.indexOf("-----END PUBLIC KEY-----");
                if (begin < 0 || end < begin) {
                    throw new RemitException("invalid_key", "the signer's public key is not a PEM PUBLIC KEY block");
                }
                der = Base64.getMimeDecoder().decode(text.substring(begin + "-----BEGIN PUBLIC KEY-----".length(), end));
            } else {
                der = Base64.getDecoder().decode(text);
            }
        } catch (IllegalArgumentException e) {
            throw new RemitException("invalid_key", "the signer's public key is neither a PEM PUBLIC KEY block nor base64 SPKI");
        }
        return Base64.getEncoder().encodeToString(publicKeyOf(der).getEncoded());
    }

    /** A P-256 public key from SPKI DER, or {@code invalid_key}. */
    static java.security.interfaces.ECPublicKey publicKeyOf(byte[] spkiDer) {
        java.security.PublicKey key;
        try {
            key = KeyFactory.getInstance("EC").generatePublic(new java.security.spec.X509EncodedKeySpec(spkiDer));
        } catch (InvalidKeySpecException e) {
            throw new RemitException("invalid_key",
                    "the public key is not an ECDSA P-256 key (ES256 is the only algorithm the corridor signs with)");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("this Java runtime has no elliptic-curve support", e);
        }
        java.security.interfaces.ECPublicKey ec = (java.security.interfaces.ECPublicKey) key;
        // P-256 and no other curve: its field is 256 bits and its cofactor one, and its order is the one below.
        if (ec.getParams().getOrder().bitLength() != 256 || !ec.getParams().getOrder().toString(16)
                .equals("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")) {
            throw new RemitException("invalid_key",
                    "the public key is not an ECDSA P-256 key (ES256 is the only algorithm the corridor signs with)");
        }
        return ec;
    }

    /** Whether {@code raw} (64 bytes, {@code r ‖ s}) is an ES256 signature over {@code message} under the key. */
    static boolean verifies(String spkiBase64, byte[] message, byte[] raw) {
        if (raw == null || raw.length != 64) {
            return false;
        }
        try {
            java.security.Signature verifier = java.security.Signature.getInstance("SHA256withECDSAinP1363Format");
            verifier.initVerify(publicKeyOf(Base64.getDecoder().decode(spkiBase64)));
            verifier.update(message);
            return verifier.verify(raw);
        } catch (java.security.GeneralSecurityException | IllegalArgumentException | RemitException e) {
            return false;
        }
    }

    /**
     * Asks the signer for a signature and returns it raw ({@code r ‖ s}),
     * having checked that it verifies over exactly these bytes with the
     * signer's own public key. Raw and DER answers are both taken;
     * verification decides which it was.
     *
     * @throws RemitException {@code signer_failed} when nothing usable came back, {@code signature_unverified}
     *                        when what came back does not verify
     */
    static byte[] signRaw(Signer signer, byte[] message) {
        byte[] produced;
        try {
            produced = signer.sign(message);
        } catch (RemitException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new RemitException("signer_failed", "the signer failed: " + e.getMessage(), e);
        }
        if (produced == null || produced.length == 0) {
            throw new RemitException("signer_failed", "the signer returned no signature bytes");
        }
        String spki = signer.publicKeySpkiBase64();
        boolean candidate = false;
        if (produced.length == 64) {
            candidate = true;
            if (verifies(spki, message, produced)) {
                return produced;
            }
        }
        byte[] fromDer = null;
        try {
            fromDer = derToRaw(produced);
        } catch (RemitException notDer) {
            // not DER: the raw reading above was the only one
        }
        if (fromDer != null) {
            candidate = true;
            if (verifies(spki, message, fromDer)) {
                return fromDer;
            }
        }
        throw new RemitException(candidate ? "signature_unverified" : "signer_failed", candidate
                ? "the signer's signature does not verify with its public key — the signer is using a different key, "
                        + "or signed a digest instead of the message (it must sign the bytes with SHA-256 itself)"
                : "the signer returned " + produced.length + " bytes that are neither a raw r‖s signature (64 bytes) nor DER");
    }

    private static final String BEGIN = "-----BEGIN PRIVATE KEY-----";
    private static final String END = "-----END PRIVATE KEY-----";

    private Signers() {
    }

    /**
     * A signer over a private key held in this process, read from PKCS#8 PEM
     * text ({@code -----BEGIN PRIVATE KEY-----}) — the form the platform's
     * console issues and {@code openssl genpkey} writes.
     *
     * @throws RemitException {@code invalid_key} when the text is not an unencrypted PKCS#8 P-256 key. The
     *                      message never quotes the text.
     */
    public static KeySigner fromPkcs8Pem(String pem) {
        Objects.requireNonNull(pem, "pem");
        int begin = pem.indexOf(BEGIN);
        int end = pem.indexOf(END);
        if (begin < 0 || end < begin) {
            String hint = pem.contains("BEGIN EC PRIVATE KEY")
                    ? "this is a SEC1 (\"EC PRIVATE KEY\") file; convert it with: openssl pkcs8 -topk8 -nocrypt"
                    : pem.contains("BEGIN ENCRYPTED PRIVATE KEY") ? "encrypted keys are not read; decrypt it first"
                            : "expected a -----BEGIN PRIVATE KEY----- block";
            throw new RemitException("invalid_key", "not a PKCS#8 PEM private key: " + hint);
        }
        byte[] der;
        try {
            der = Base64.getMimeDecoder().decode(pem.substring(begin + BEGIN.length(), end));
        } catch (IllegalArgumentException e) {
            throw new RemitException("invalid_key", "not a PKCS#8 PEM private key: the block is not base64");
        }
        PrivateKey key;
        try {
            key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
        } catch (InvalidKeySpecException e) {
            throw new RemitException("invalid_key",
                    "the signing key must be an ECDSA P-256 key (ES256), the kind the console issues");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("this Java runtime has no elliptic-curve support", e);
        }
        return new KeySigner((ECPrivateKey) key);
    }

    /**
     * Converts an ECDSA signature from DER — what Java's default, PKCS#11
     * tokens and most cloud key services produce — to the 64 bytes
     * {@code r ‖ s} the protocol carries.
     *
     * @throws RemitException {@code invalid_signature_format} when the bytes are not a DER P-256 signature
     */
    public static byte[] derToRaw(byte[] der) {
        Objects.requireNonNull(der, "der");
        // SEQUENCE { INTEGER r, INTEGER s }; at most 72 bytes for P-256, so every length fits one byte.
        if (der.length < 8 || der.length > 72 || der[0] != 0x30 || (der[1] & 0xff) != der.length - 2) {
            throw notDer();
        }
        byte[] out = new byte[64];
        int at = copyInteger(der, 2, out, 0);
        at = copyInteger(der, at, out, 32);
        if (at != der.length) {
            throw notDer();
        }
        return out;
    }

    /** Copies one DER INTEGER, right-aligned into 32 bytes; returns the offset after it. */
    private static int copyInteger(byte[] der, int at, byte[] out, int outOffset) {
        if (at + 2 > der.length || der[at] != 0x02) {
            throw notDer();
        }
        int length = der[at + 1] & 0xff;
        int from = at + 2;
        if (length == 0 || from + length > der.length || (der[from] & 0x80) != 0) {
            throw notDer();
        }
        // A positive integer whose top bit is set carries one leading zero byte.
        if (der[from] == 0 && length > 1) {
            from++;
            length--;
        }
        if (length > 32) {
            throw notDer();
        }
        System.arraycopy(der, from, out, outOffset + 32 - length, length);
        return from + length;
    }

    private static RemitException notDer() {
        return new RemitException("invalid_signature_format", "not a DER-encoded ECDSA P-256 signature");
    }
}
