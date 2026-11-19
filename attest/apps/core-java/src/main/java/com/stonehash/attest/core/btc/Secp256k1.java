package com.stonehash.attest.core.btc;

import com.stonehash.attest.core.format.Hex;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.math.ec.ECPoint;

/**
 * secp256k1 and BIP340 Schnorr — the minimum needed to sign one tapscript
 * spend.
 *
 * <h2>Why this exists at all</h2>
 *
 * Every other signature in this service is delegated: the node funds and
 * signs anchor transactions, so no key has ever had to live in this process.
 * A witness inscription breaks that, and not by choice. The reveal
 * transaction spends a P2TR output by the script path, and the leaf script
 * is an {@code OP_CHECKSIG} over a key invented for that one output. The
 * node cannot sign it — its descriptor language has no way to say "spend
 * this arbitrary tapscript" — so the signature is produced here.
 *
 * <p>What that does not mean: no wallet key enters this process. The key in
 * play is generated for a single inscription, controls a single small output
 * that was funded a moment earlier, and is dropped once the reveal is
 * broadcast. Losing it costs that output and nothing else.
 *
 * <h2>Not constant time</h2>
 *
 * Nothing here hides what it computes on. That is acceptable for exactly the
 * reason above — the secret is used once, over dust — and would not be for a
 * key that holds value. Do not reach for this class to sign anything else.
 *
 * <p>The curve arithmetic is BouncyCastle's; the signature scheme is written
 * out here so that a signature is, for the same key, message and auxiliary
 * randomness, byte for byte what BIP340 says it is (the published vectors
 * are in {@code vectors/btc.json}).
 */
public final class Secp256k1 {
    private Secp256k1() {
    }

    private static final X9ECParameters CURVE = CustomNamedCurves.getByName("secp256k1");
    /** Field prime: 2^256 − 2^32 − 977. */
    public static final BigInteger P = CURVE.getCurve().getField().getCharacteristic();
    /** Group order. */
    public static final BigInteger N = CURVE.getN();
    public static final ECPoint G = CURVE.getG();

    private static final BigInteger SEVEN = BigInteger.valueOf(7);
    private static final SecureRandom RANDOM = new SecureRandom();

    /** {@code a + b}; the result may be the point at infinity. */
    public static ECPoint pointAdd(ECPoint a, ECPoint b) {
        return a.add(b).normalize();
    }

    /** {@code k·G}; the point at infinity when {@code k} is a multiple of the order. */
    public static ECPoint pointMul(BigInteger k) {
        return pointMul(k, G);
    }

    public static ECPoint pointMul(BigInteger k, ECPoint p) {
        return p.multiply(k.mod(N)).normalize();
    }

    /**
     * BIP340 {@code lift_x}: the point with this x and an even y, or
     * {@code null} when x is not on the curve — a real possibility for a key
     * that came from outside, and not an exception that would read as a bug.
     */
    public static ECPoint liftX(BigInteger x) {
        if (x.signum() <= 0 || x.compareTo(P) >= 0) {
            return null;
        }
        BigInteger ySq = x.modPow(BigInteger.valueOf(3), P).add(SEVEN).mod(P);
        // p ≡ 3 (mod 4), so the square root is c^((p+1)/4) when one exists.
        BigInteger y = ySq.modPow(P.add(BigInteger.ONE).shiftRight(2), P);
        if (!y.multiply(y).mod(P).equals(ySq)) {
            return null;
        }
        return CURVE.getCurve().createPoint(x, y.testBit(0) ? P.subtract(y) : y);
    }

    // ── encoding ──────────────────────────────────────────────────────────────

    public static BigInteger bytesToBigint(byte[] b) {
        return new BigInteger(1, b);
    }

    public static byte[] bigintTo32(BigInteger v) {
        if (v.signum() < 0 || v.bitLength() > 256) {
            throw new IllegalArgumentException("value does not fit in 32 bytes");
        }
        byte[] raw = v.toByteArray();
        byte[] out = new byte[32];
        int n = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - n, out, 32 - n, n);
        return out;
    }

    /** The 32-byte x-only encoding BIP340 and taproot use everywhere. */
    public static byte[] xOnly(ECPoint p) {
        if (p.isInfinity()) {
            throw new IllegalArgumentException("secp256k1: no x-only encoding for infinity");
        }
        return bigintTo32(p.normalize().getAffineXCoord().toBigInteger());
    }

    public static boolean hasEvenY(ECPoint p) {
        return !p.isInfinity() && !p.normalize().getAffineYCoord().toBigInteger().testBit(0);
    }

    // ── tagged hashes ─────────────────────────────────────────────────────────

    private static final Map<String, byte[]> TAGS = new ConcurrentHashMap<>();

    /**
     * BIP340 tagged hash: {@code SHA256(SHA256(tag) ‖ SHA256(tag) ‖ msg)}.
     * The doubled tag digest is the domain separator: it is what stops a
     * signature over one structure from being replayed as a signature over
     * another.
     */
    public static byte[] taggedHash(String tag, byte[]... parts) {
        byte[] prefix = TAGS.computeIfAbsent(tag, (t) -> Hex.sha256(t.getBytes(StandardCharsets.UTF_8)));
        byte[][] all = new byte[parts.length + 2][];
        all[0] = prefix;
        all[1] = prefix;
        System.arraycopy(parts, 0, all, 2, parts.length);
        return Hex.sha256(all);
    }

    // ── BIP340 ────────────────────────────────────────────────────────────────

    private static BigInteger secretScalar(byte[] secret) {
        BigInteger d = bytesToBigint(secret);
        if (d.signum() <= 0 || d.compareTo(N) >= 0) {
            throw new IllegalArgumentException("secp256k1: secret key out of range");
        }
        return d;
    }

    /** The x-only public key of a secret, as BIP340 defines it. */
    public static byte[] xOnlyPubkey(byte[] secret) {
        ECPoint p = pointMul(secretScalar(secret));
        if (p.isInfinity()) {
            throw new IllegalArgumentException("secp256k1: secret key produced infinity");
        }
        return xOnly(p);
    }

    /** BIP340 sign with fresh auxiliary randomness — what the standard recommends, and what the service uses. */
    public static byte[] schnorrSign(byte[] msg, byte[] secret) {
        byte[] aux = new byte[32];
        RANDOM.nextBytes(aux);
        return schnorrSign(msg, secret, aux);
    }

    /**
     * BIP340 sign. With the same auxiliary randomness the signature is the
     * same bytes every time, which is how it is held to the published vectors.
     */
    public static byte[] schnorrSign(byte[] msg, byte[] secret, byte[] aux) {
        BigInteger d0 = secretScalar(secret);
        ECPoint pointP = pointMul(d0);
        if (pointP.isInfinity()) {
            throw new IllegalArgumentException("secp256k1: secret key produced infinity");
        }
        // BIP340 signs with the key whose public point has an even y; if ours does not, the
        // scalar is negated. Skipping this is the classic way to produce signatures that
        // verify locally and are rejected by every node.
        BigInteger d = hasEvenY(pointP) ? d0 : N.subtract(d0);

        byte[] t = bigintTo32(d.xor(bytesToBigint(taggedHash("BIP0340/aux", aux))));
        byte[] rand = taggedHash("BIP0340/nonce", t, xOnly(pointP), msg);
        BigInteger k0 = bytesToBigint(rand).mod(N);
        if (k0.signum() == 0) {
            throw new IllegalArgumentException("secp256k1: nonce was zero");
        }
        ECPoint pointR = pointMul(k0);
        if (pointR.isInfinity()) {
            throw new IllegalArgumentException("secp256k1: nonce produced infinity");
        }
        BigInteger k = hasEvenY(pointR) ? k0 : N.subtract(k0);
        BigInteger e = bytesToBigint(taggedHash("BIP0340/challenge", xOnly(pointR), xOnly(pointP), msg)).mod(N);

        byte[] sig = new byte[64];
        System.arraycopy(xOnly(pointR), 0, sig, 0, 32);
        System.arraycopy(bigintTo32(k.add(e.multiply(d)).mod(N)), 0, sig, 32, 32);
        return sig;
    }

    /** BIP340 verify. */
    public static boolean schnorrVerify(byte[] sig, byte[] msg, byte[] pubkey) {
        if (sig.length != 64 || pubkey.length != 32) {
            return false;
        }
        ECPoint pointP = liftX(bytesToBigint(pubkey));
        if (pointP == null) {
            return false;
        }
        byte[] rBytes = java.util.Arrays.copyOfRange(sig, 0, 32);
        BigInteger r = bytesToBigint(rBytes);
        BigInteger s = bytesToBigint(java.util.Arrays.copyOfRange(sig, 32, 64));
        if (r.compareTo(P) >= 0 || s.compareTo(N) >= 0) {
            return false;
        }
        BigInteger e = bytesToBigint(taggedHash("BIP0340/challenge", rBytes, pubkey, msg)).mod(N);
        // R = sG − eP
        ECPoint pointR = pointAdd(pointMul(s), pointMul(N.subtract(e).mod(N), pointP));
        if (pointR.isInfinity()) {
            return false;
        }
        return hasEvenY(pointR) && pointR.getAffineXCoord().toBigInteger().equals(r);
    }
}
