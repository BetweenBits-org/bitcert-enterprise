package com.stonehash.attest.core.format;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Enumeration;
import java.util.Locale;
import org.bouncycastle.asn1.ASN1InputStream;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.ASN1OctetString;
import org.bouncycastle.asn1.ASN1Primitive;
import org.bouncycastle.asn1.ASN1Sequence;
import org.bouncycastle.asn1.ASN1TaggedObject;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo;
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo;
import org.bouncycastle.asn1.x9.ECNamedCurveTable;
import org.bouncycastle.asn1.x9.X962Parameters;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.asn1.x9.X9ObjectIdentifiers;
import org.bouncycastle.crypto.util.PrivateKeyFactory;
import org.bouncycastle.crypto.util.PublicKeyFactory;

/**
 * Why offered key material cannot be used, for the door that refuses it.
 *
 * <p>The message completes "the key is …", so each caller names the key its
 * own way. None of them quotes the material: a refused value may be a
 * private key, and an error message is copied into logs and onto screens.
 *
 * <p>The private-key test comes first and is not a formality: bare base64
 * has no PEM armour saying PRIVATE KEY, so a pasted PKCS#8 looks like any
 * other base64 until it is decoded — and stored, it would be served back by
 * every list of "public" keys.
 *
 * <p>The codes and sentences are the reference's
 * ({@code apps/core/src/remit/sign.ts}), and so is what counts as which: the
 * text is read as that service's runtime reads base64 (either alphabet,
 * anything else skipped, ending at the first padding character), and bytes
 * after the key are ignored.
 */
public final class PublicKeys {
    private PublicKeys() {
    }

    public static final class Problem {
        /** {@code private_key_refused}, {@code invalid_public_key} or {@code unsupported_algorithm}. */
        public final String code;
        public final String message;

        Problem(String code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    private static final Problem PRIVATE = new Problem("private_key_refused",
            "a private key — only the public half (SPKI, base64) is ever registered; the private key stays with whoever signs");
    private static final Problem INVALID = new Problem("invalid_public_key",
            "not a base64-encoded SPKI (DER) public key, which is what the SDK's generateSigningKey() emits");

    private static final class Offered {
        Problem problem;
        SubjectPublicKeyInfo key;
    }

    /** Base64 as the reference's runtime reads it: either alphabet, anything else skipped, ending at the first {@code =}. */
    public static byte[] base64(String text) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(text.length() * 3 / 4);
        int bits = 0;
        int held = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '=') {
                break;
            }
            int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
                    : c == '+' || c == '-' ? 62 : c == '/' || c == '_' ? 63 : -1;
            if (v < 0) {
                continue;
            }
            held = (held << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write(held >> bits);
                held &= (1 << bits) - 1;
            }
        }
        return out.toByteArray();
    }

    private static Offered offered(String text) {
        Offered out = new Offered();
        if (text.contains("PRIVATE KEY")) {
            out.problem = PRIVATE;
            return out;
        }
        ASN1Primitive first = null;
        try (ASN1InputStream in = new ASN1InputStream(base64(text))) {
            first = in.readObject();
        } catch (IOException | RuntimeException e) {
            first = null;
        }
        if (first != null && isPrivateKey(first)) {
            out.problem = PRIVATE;
            return out;
        }
        try {
            SubjectPublicKeyInfo info = SubjectPublicKeyInfo.getInstance(first);
            if (info == null) {
                throw new IllegalArgumentException("nothing there");
            }
            // Reading it as a key is the test: the kind is known, the encoding holds, a point lies on its curve.
            PublicKeyFactory.createKey(info);
            out.key = info;
        } catch (IOException | RuntimeException e) {
            out.problem = INVALID;
        }
        return out;
    }

    /** Is this one of the containers a private key travels in — PKCS#8, SEC1 or PKCS#1? An SPKI is none of them. */
    private static boolean isPrivateKey(ASN1Primitive der) {
        try {
            PrivateKeyFactory.createKey(PrivateKeyInfo.getInstance(der));
            return true;
        } catch (IOException | RuntimeException e) {
            // not PKCS#8
        }
        if (!(der instanceof ASN1Sequence)) {
            return false;
        }
        ASN1Sequence seq = (ASN1Sequence) der;
        // SEC1: version 1, the key as an octet string, and the curve it is on.
        if (seq.size() >= 3 && seq.size() <= 4 && seq.getObjectAt(0) instanceof ASN1Integer && ((ASN1Integer) seq.getObjectAt(0)).hasValue(1)
                && seq.getObjectAt(1) instanceof ASN1OctetString && seq.getObjectAt(2) instanceof ASN1TaggedObject
                && ((ASN1TaggedObject) seq.getObjectAt(2)).getTagNo() == 0) {
            return true;
        }
        // PKCS#1: version, then the eight numbers of an RSA private key.
        if (seq.size() >= 9 && seq.getObjectAt(0) instanceof ASN1Integer
                && (((ASN1Integer) seq.getObjectAt(0)).hasValue(0) || ((ASN1Integer) seq.getObjectAt(0)).hasValue(1))) {
            for (int i = 1; i < 9; i++) {
                if (!(seq.getObjectAt(i) instanceof ASN1Integer)) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    /** Why this cannot be stored as public key material of any algorithm, or {@code null}. */
    public static Problem problem(String spkiBase64) {
        return offered(spkiBase64).problem;
    }

    /**
     * Why this cannot be an ES256 verification key, or {@code null} when it
     * can. ES256 is ECDSA on P-256 and nothing else: a key of another kind or
     * on another curve would sit in the registry and fail every signature
     * with no hint why.
     */
    public static Problem es256Problem(String spkiBase64) {
        Offered offered = offered(spkiBase64);
        if (offered.problem != null) {
            return offered.problem;
        }
        ASN1ObjectIdentifier kind = offered.key.getAlgorithm().getAlgorithm();
        boolean ec = X9ObjectIdentifiers.id_ecPublicKey.equals(kind);
        String curve = ec ? curveOf(offered.key) : null;
        if (ec && "prime256v1".equals(curve)) {
            return null;
        }
        return new Problem("unsupported_algorithm", "not an ES256 key: ES256 is ECDSA on P-256, and this one is "
                + (ec ? "EC on " + (curve == null ? "explicit curve parameters" : curve) : kindName(kind)));
    }

    /**
     * A stored key as a verifier takes it.
     *
     * <p>The reference's runtime verifies an ES256 signature with any P-256
     * key it can read: the point compressed, the curve spelled out as its
     * parameters instead of named, bytes after the key, either base64
     * alphabet, line breaks in the text. The verifier here (the SDK's, on the
     * JDK's key factory) reads the plain form only — the curve named, the
     * point uncompressed, nothing after it. So a key that is a P-256 key is
     * handed over in that form, and a signature it made verifies here as it
     * does there. Anything else is returned as it is, for the verifier to
     * find unusable.
     */
    public static String forVerification(String stored) {
        if (stored == null) {
            return null;
        }
        try (ASN1InputStream in = new ASN1InputStream(base64(stored))) {
            SubjectPublicKeyInfo key = SubjectPublicKeyInfo.getInstance(in.readObject());
            if (key != null && X9ObjectIdentifiers.id_ecPublicKey.equals(key.getAlgorithm().getAlgorithm()) && "prime256v1".equals(curveOf(key))) {
                byte[] point = ((org.bouncycastle.crypto.params.ECPublicKeyParameters) PublicKeyFactory.createKey(key)).getQ().getEncoded(false);
                SubjectPublicKeyInfo plain = new SubjectPublicKeyInfo(
                        new org.bouncycastle.asn1.x509.AlgorithmIdentifier(X9ObjectIdentifiers.id_ecPublicKey, X9ObjectIdentifiers.prime256v1), point);
                return java.util.Base64.getEncoder().encodeToString(plain.getEncoded("DER"));
            }
        } catch (IOException | RuntimeException e) {
            // not a key at all: left as it is
        }
        return stored;
    }

    /** The curves the reference's runtime writes an EC key out on as a JWK; a key on any other is not converted. */
    private static final java.util.Set<String> JWK_CURVES = java.util.Set.of("prime256v1", "secp384r1", "secp521r1", "secp256k1");

    /**
     * Would the reference's runtime turn this stored key into a JWK
     * ({@code spkiToJwk})?
     *
     * <p>The registry builds one keyring, for every organisation's
     * reconciliation, from every institution's signing key by that
     * conversion — and an institution whose key it fails on is left out of
     * the keyring. That decides what a verdict says of that institution's
     * signatures: left out, they read {@code UNKNOWN_KEY}; kept in with a key
     * that cannot verify, they read {@code INVALID}. The verdict is stored
     * and committed to, so which keys convert is part of the contract.
     *
     * <p>It converts a key it can read as a public key (the text read as it
     * reads base64; bytes after the key ignored) of a kind it has a JWK form
     * for: RSA, EC on P-256, P-384, P-521 or secp256k1 — named, or spelled
     * out as that curve's parameters — and the four Edwards and Montgomery
     * kinds. RSA-PSS, DSA, DH and EC on any other curve are read and not
     * converted. Nothing here asks whether the text mentions a private key:
     * that conversion never did.
     */
    public static boolean convertsToJwk(String spkiBase64) {
        if (spkiBase64 == null) {
            return false;
        }
        SubjectPublicKeyInfo key;
        try (ASN1InputStream in = new ASN1InputStream(base64(spkiBase64))) {
            key = SubjectPublicKeyInfo.getInstance(in.readObject());
            if (key == null) {
                return false;
            }
            PublicKeyFactory.createKey(key);
        } catch (IOException | RuntimeException e) {
            return false;
        }
        ASN1ObjectIdentifier kind = key.getAlgorithm().getAlgorithm();
        if (X9ObjectIdentifiers.id_ecPublicKey.equals(kind)) {
            String curve;
            try {
                curve = curveOf(key);
            } catch (RuntimeException e) {
                return false;
            }
            return curve != null && JWK_CURVES.contains(curve);
        }
        if (PKCSObjectIdentifiers.rsaEncryption.equals(kind)) {
            return true;
        }
        switch (kind.getId()) {
            case "1.3.101.110":
            case "1.3.101.111":
            case "1.3.101.112":
            case "1.3.101.113":
                return true;
            default:
                return false;
        }
    }

    /** The name of the curve an EC key is on — also when the key spells the curve out instead of naming it — or {@code null}. */
    private static String curveOf(SubjectPublicKeyInfo key) {
        X962Parameters params = X962Parameters.getInstance(key.getAlgorithm().getParameters());
        if (params.isNamedCurve()) {
            return ECNamedCurveTable.getName((ASN1ObjectIdentifier) params.getParameters());
        }
        if (params.isImplicitlyCA()) {
            return null;
        }
        X9ECParameters spelled = X9ECParameters.getInstance(params.getParameters());
        for (Enumeration<?> names = ECNamedCurveTable.getNames(); names.hasMoreElements();) {
            String name = (String) names.nextElement();
            X9ECParameters known = ECNamedCurveTable.getByName(name);
            if (known != null && known.getCurve().equals(spelled.getCurve()) && known.getG().equals(spelled.getG()) && known.getN().equals(spelled.getN())) {
                ASN1ObjectIdentifier oid = ECNamedCurveTable.getOID(name);
                return oid == null ? name : ECNamedCurveTable.getName(oid);
            }
        }
        return null;
    }

    private static String kindName(ASN1ObjectIdentifier kind) {
        String id = kind.getId();
        if (PKCSObjectIdentifiers.rsaEncryption.equals(kind)) {
            return "RSA";
        }
        if (PKCSObjectIdentifiers.id_RSASSA_PSS.equals(kind)) {
            return "RSA-PSS";
        }
        switch (id) {
            case "1.2.840.10040.4.1":
                return "DSA";
            case "1.3.101.110":
                return "X25519";
            case "1.3.101.111":
                return "X448";
            case "1.3.101.112":
                return "ED25519";
            case "1.3.101.113":
                return "ED448";
            case "1.2.840.113549.1.3.1":
            case "1.2.840.10046.2.1":
                return "DH";
            default:
                return "unknown".toUpperCase(Locale.ROOT);
        }
    }
}
