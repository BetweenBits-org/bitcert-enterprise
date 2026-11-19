package com.stonehash.attest.por;

import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Objects;

/** Ready-made {@link Signer}s, and the conversion most HSM and KMS integrations need. */
public final class Signers {
    private static final String BEGIN = "-----BEGIN PRIVATE KEY-----";
    private static final String END = "-----END PRIVATE KEY-----";

    private Signers() {
    }

    /**
     * A signer over a private key held in this process, read from PKCS#8 PEM
     * text ({@code -----BEGIN PRIVATE KEY-----}) — the form the platform's
     * console issues and {@code openssl genpkey} writes.
     *
     * @throws PorException {@code invalid_key} when the text is not an unencrypted PKCS#8 P-256 key. The
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
            throw new PorException("invalid_key", "not a PKCS#8 PEM private key: " + hint);
        }
        byte[] der;
        try {
            der = Base64.getMimeDecoder().decode(pem.substring(begin + BEGIN.length(), end));
        } catch (IllegalArgumentException e) {
            throw new PorException("invalid_key", "not a PKCS#8 PEM private key: the block is not base64");
        }
        PrivateKey key;
        try {
            key = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
        } catch (InvalidKeySpecException e) {
            throw new PorException("invalid_key",
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
     * @throws PorException {@code invalid_signature_format} when the bytes are not a DER P-256 signature
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

    private static PorException notDer() {
        return new PorException("invalid_signature_format", "not a DER-encoded ECDSA P-256 signature");
    }
}
