package com.stonehash.attest.core.format;

import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The attestation statement — what an issuer signs, and what the chain
 * commits to.
 *
 * <p>Anchoring {@code sha256(document)} proves a document existed by a block
 * height and says nothing about who published it. So the issuer's signature
 * goes inside the thing the chain commits to: the leaf is the hash of a
 * statement that already contains the signature, and one block height covers
 * the document, its author and the time.
 *
 * <pre>
 *   signed:    "stonehash:attestation:sig:v1\n" ‖ JCS(statement without `signature`)
 *   anchored:  leaf_bytes = sha256(JCS(statement with `signature`))
 * </pre>
 *
 * The asymmetry is deliberate: the leaf must commit to the signature, or the
 * signature is not timestamped.
 *
 * <p>A statement arrives as a request brought it. This class reads it the way
 * the reference ({@code packages/attest-verify/src/statement.ts}) reads it —
 * a field of the wrong kind is refused in the same words, because a client
 * reads those words in a 400. Where the reference's words were the JavaScript
 * engine's own complaint about the code ("Cannot read properties of
 * undefined", "b64.replace is not a function"), the refusal here is a
 * sentence of this service's ({@code docs/JAVA-INTENDED-DIFFERENCES.md}, D-03).
 */
public final class Statement {
    private Statement() {
    }

    /** Prefix on the signing input. Never reused by any other structure. */
    public static final String DOMAIN = "stonehash:attestation:sig:v1\n";
    public static final String SCHEMA = "stonehash-attestation-statement/v1";

    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    /** A statement that cannot be read as one. The message is what a client is told. */
    public static final class Malformed extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Malformed(String message) {
            super(message);
        }
    }

    /** What checking a signed statement found. Both halves are reported: they are different failures. */
    public static final class Verdict {
        /** The signature checks out against the key the statement carries. */
        public final boolean signatureOk;
        /** {@code sha256(JCS(statement))} equals the leaf the chain committed to. */
        public final boolean leafOk;
        public final String keyId;
        public final String algorithm;
        public final String computedLeaf;
        /** Set when the check could not run at all; {@code null} otherwise. */
        public final String error;

        Verdict(boolean signatureOk, boolean leafOk, String keyId, String algorithm, String computedLeaf, String error) {
            this.signatureOk = signatureOk;
            this.leafOk = leafOk;
            this.keyId = keyId;
            this.algorithm = algorithm;
            this.computedLeaf = computedLeaf;
            this.error = error;
        }
    }

    // ── values as JavaScript reads them ───────────────────────────────────────

    private static boolean falsy(Object v) {
        return v == null || v == Js.UNDEFINED || Boolean.FALSE.equals(v) || "".equals(v)
                || (v instanceof Double && ((Double) v == 0 || ((Double) v).isNaN()));
    }

    /** {@code String(v)}, where {@code absent} tells a property that is not there from one that is null. */
    static String text(Object v, boolean absent) {
        if (absent || v == Js.UNDEFINED) {
            return "undefined";
        }
        if (v == null) {
            return "null";
        }
        if (v instanceof String) {
            return (String) v;
        }
        if (v instanceof Double) {
            return Js.numberToString((Double) v);
        }
        if (v instanceof Boolean) {
            return v.toString();
        }
        if (v instanceof List) {
            return joined((List<?>) v);
        }
        return "[object Object]";
    }

    private static String joined(List<?> list) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            Object item = list.get(i);
            out.append(item == null || item == Js.UNDEFINED ? "" : text(item, false));
        }
        return out.toString();
    }

    /** A property of an object; of anything that is not an object, nothing. */
    private static Object get(Object o, String key) {
        return o instanceof Map ? ((Map<?, ?>) o).get(key) : null;
    }

    private static boolean absent(Object o, String key) {
        return !(o instanceof Map) || !((Map<?, ?>) o).containsKey(key);
    }

    // ── the statement ─────────────────────────────────────────────────────────

    /** Everything but {@code signature}, so that signing and verifying agree. */
    private static Map<String, Object> coreOf(Map<String, Object> statement) {
        Map<String, Object> core = new LinkedHashMap<>(statement);
        core.remove("signature");
        return core;
    }

    /**
     * Refuse anything that would produce a statement nobody can verify.
     *
     * @throws Malformed in the reference's words
     */
    static void assertCore(Map<String, Object> core) {
        if (!SCHEMA.equals(core.get("schema"))) {
            throw new Malformed("statement schema must be " + SCHEMA);
        }
        Object document = core.get("document");
        if (document == null) {
            throw new Malformed("document is required: { sha256, content_type? }");
        }
        if (!HEX64.matcher(text(get(document, "sha256"), absent(document, "sha256"))).matches()) {
            throw new Malformed("document.sha256 must be 64 lowercase hex characters");
        }
        Object issuer = core.get("issuer");
        if (issuer == null) {
            throw new Malformed("issuer is required: { key_id, algorithm, public_key }");
        }
        if (falsy(get(issuer, "key_id"))) {
            throw new Malformed("issuer.key_id is required");
        }
        Object algorithm = get(issuer, "algorithm");
        if (!"ES256".equals(algorithm) && !"RS256".equals(algorithm)) {
            throw new Malformed("unsupported algorithm: " + text(algorithm, absent(issuer, "algorithm")));
        }
        if (falsy(get(issuer, "public_key"))) {
            throw new Malformed("issuer.public_key is required");
        }
        if (!IsoDate.parses(text(core.get("issued_at"), !core.containsKey("issued_at")))) {
            throw new Malformed("issued_at must be an ISO-8601 timestamp");
        }
    }

    private static byte[] canonical(Object value) {
        try {
            return Canonical.bytes(value);
        } catch (PlainError e) {
            throw new Malformed(e.getMessage());
        }
    }

    /** The exact bytes an issuer signs. A signed statement is taken as happily: its signature is left out. */
    public static byte[] signingInput(Map<String, Object> statement) {
        Map<String, Object> core = coreOf(statement);
        assertCore(core);
        byte[] domain = DOMAIN.getBytes(StandardCharsets.UTF_8);
        byte[] body = canonical(core);
        byte[] out = new byte[domain.length + body.length];
        System.arraycopy(domain, 0, out, 0, domain.length);
        System.arraycopy(body, 0, out, domain.length, body.length);
        return out;
    }

    /**
     * {@code leaf_bytes} for a signed anchor — the hash of the statement
     * including its signature. These are the 32 bytes that reach Bitcoin.
     *
     * @throws Malformed when the statement cannot be one
     */
    public static String leaf(Map<String, Object> statement) {
        assertCore(coreOf(statement));
        if (falsy(statement.get("signature"))) {
            throw new Malformed("a signed statement needs its signature");
        }
        return Hex.encode(Hex.sha256(canonical(statement)));
    }

    // ── verification ──────────────────────────────────────────────────────────

    /**
     * base64 or base64url as bytes, read exactly as the reference reads it;
     * {@code null} when it is neither. The reference pads the text to a
     * multiple of four and hands it to {@code atob()}: ASCII white space is
     * dropped there, one or two {@code =} are taken off a text whose length
     * is a multiple of four, and anything else that is not of the alphabet —
     * or one character too many — is refused.
     */
    static byte[] base64(String text) {
        String std = text.replace('-', '+').replace('_', '/');
        String data = (std + "=".repeat((4 - std.length() % 4) % 4)).replaceAll("[\\t\\n\\f\\r ]", "");
        if (data.length() % 4 == 0 && data.endsWith("==")) {
            data = data.substring(0, data.length() - 2);
        } else if (data.length() % 4 == 0 && data.endsWith("=")) {
            data = data.substring(0, data.length() - 1);
        }
        if (data.length() % 4 == 1 || !data.matches("[A-Za-z0-9+/]*")) {
            return null;
        }
        // The last character may carry bits beyond the last whole byte; they are dropped, as atob() drops them.
        int rest = data.length() % 4;
        if (rest != 0) {
            String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            int last = alphabet.indexOf(data.charAt(data.length() - 1));
            int cleared = rest == 2 ? last & 0x30 : last & 0x3c;
            data = data.substring(0, data.length() - 1) + alphabet.charAt(cleared);
        }
        return Base64.getDecoder().decode(data + "=".repeat((4 - data.length() % 4) % 4));
    }

    /**
     * Check a signed statement against the leaf the chain carries.
     *
     * <p>The key comes from the statement itself, so this proves consistency,
     * not identity: the holder of that key signed this document. Whether the
     * key belongs to who it claims is a separate question.
     */
    public static Verdict verify(Map<String, Object> statement, String anchoredLeafHex) {
        Object issuer = statement.get("issuer");
        Object keyIdValue = get(issuer, "key_id");
        Object algorithmValue = get(issuer, "algorithm");
        // As the reference reports them: whatever the statement holds there, or "" where it holds nothing.
        String keyId = keyIdValue == null ? "" : text(keyIdValue, false);
        String algorithm = algorithmValue == null ? "" : text(algorithmValue, false);
        String computedLeaf;
        try {
            computedLeaf = leaf(statement);
        } catch (Malformed e) {
            return new Verdict(false, false, keyId, algorithm, "", e.getMessage());
        }
        boolean leafOk = computedLeaf.equals(anchoredLeafHex.toLowerCase(java.util.Locale.ROOT));
        Object signatureValue = statement.get("signature");
        Object publicKeyValue = get(issuer, "public_key");
        if (!(signatureValue instanceof String)) {
            return new Verdict(false, false, keyId, algorithm, "", "signature must be text: the base64url of the signature");
        }
        if (!(publicKeyValue instanceof String)) {
            return new Verdict(false, false, keyId, algorithm, "", "issuer.public_key must be text: the base64 of the key's SPKI");
        }
        byte[] signature = base64((String) signatureValue);
        byte[] spki = signature == null ? null : base64((String) publicKeyValue);
        if (signature == null || spki == null) {
            return new Verdict(false, false, keyId, algorithm, "", "Invalid character");
        }
        byte[] input = signingInput(statement);
        boolean es256 = "ES256".equals(algorithm);
        // What kind of key is it? Said in the words the reference's crypto library used, which clients have seen.
        String problem = keyProblem(spki, es256);
        if (problem != null) {
            return new Verdict(false, false, keyId, algorithm, "", problem);
        }
        try {
            PublicKey key = es256 ? p256Key(spki) : KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(spki));
            // An ES256 signature is r ‖ s, 64 bytes; anything else is not a signature of this key.
            if (es256 && signature.length != 64) {
                return new Verdict(false, leafOk, keyId, algorithm, computedLeaf, null);
            }
            Signature verifier = Signature.getInstance(es256 ? "SHA256withECDSAinP1363Format" : "SHA256withRSA");
            verifier.initVerify(key);
            verifier.update(input);
            return new Verdict(verifies(verifier, signature), leafOk, keyId, algorithm, computedLeaf, null);
        } catch (java.security.GeneralSecurityException e) {
            return new Verdict(false, false, keyId, algorithm, "", "Invalid keyData");
        }
    }

    /**
     * A P-256 public key out of its SubjectPublicKeyInfo, however its point is
     * written — in full, compressed to one coordinate and a sign, or in the
     * hybrid form. The reference's crypto library reads all three; the JDK's
     * own key factory reads the first only, so the point is decoded here.
     *
     * @throws java.security.GeneralSecurityException when the bytes are not a point on the curve
     */
    private static PublicKey p256Key(byte[] spki) throws java.security.GeneralSecurityException {
        try {
            org.bouncycastle.asn1.x509.SubjectPublicKeyInfo info =
                    org.bouncycastle.asn1.x509.SubjectPublicKeyInfo.getInstance(org.bouncycastle.asn1.ASN1Primitive.fromByteArray(spki));
            org.bouncycastle.math.ec.ECPoint point = org.bouncycastle.asn1.x9.ECNamedCurveTable.getByName("P-256").getCurve()
                    .decodePoint(info.getPublicKeyData().getBytes()).normalize();
            if (point.isInfinity() || !point.isValid()) {
                throw new java.security.spec.InvalidKeySpecException("not a point of the curve");
            }
            java.security.AlgorithmParameters parameters = java.security.AlgorithmParameters.getInstance("EC");
            parameters.init(new java.security.spec.ECGenParameterSpec("secp256r1"));
            return KeyFactory.getInstance("EC").generatePublic(new java.security.spec.ECPublicKeySpec(
                    new java.security.spec.ECPoint(point.getAffineXCoord().toBigInteger(), point.getAffineYCoord().toBigInteger()),
                    parameters.getParameterSpec(java.security.spec.ECParameterSpec.class)));
        } catch (java.io.IOException | RuntimeException e) {
            throw new java.security.spec.InvalidKeySpecException(e.getMessage());
        }
    }

    /**
     * Why these bytes cannot be the public key the algorithm needs, or
     * {@code null}: not a SubjectPublicKeyInfo at all, a key of another kind,
     * or an EC key on another curve than P-256.
     */
    private static String keyProblem(byte[] spki, boolean es256) {
        org.bouncycastle.asn1.x509.SubjectPublicKeyInfo info;
        try {
            info = org.bouncycastle.asn1.x509.SubjectPublicKeyInfo.getInstance(org.bouncycastle.asn1.ASN1Primitive.fromByteArray(spki));
        } catch (java.io.IOException | RuntimeException e) {
            return "Invalid keyData";
        }
        if (info == null) {
            return "Invalid keyData";
        }
        org.bouncycastle.asn1.ASN1ObjectIdentifier kind = info.getAlgorithm().getAlgorithm();
        if (es256) {
            if (!org.bouncycastle.asn1.x9.X9ObjectIdentifiers.id_ecPublicKey.equals(kind)) {
                return "Invalid key type";
            }
            return org.bouncycastle.asn1.x9.X9ObjectIdentifiers.prime256v1.equals(info.getAlgorithm().getParameters()) ? null : "Named curve mismatch";
        }
        return org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers.rsaEncryption.equals(kind) ? null : "Invalid key type";
    }

    private static boolean verifies(Signature verifier, byte[] signature) {
        try {
            return verifier.verify(signature);
        } catch (java.security.SignatureException e) {
            return false;
        }
    }

}
