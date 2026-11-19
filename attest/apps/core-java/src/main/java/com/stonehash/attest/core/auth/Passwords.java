package com.stonehash.attest.core.auth;

import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.json.Js;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.Semaphore;
import org.bouncycastle.crypto.generators.SCrypt;

/**
 * Console passwords: scrypt, a salt per account, and the parameters stored
 * beside the digest —
 *
 * <pre>   scrypt$N$r$p$salt$hash      (salt and hash in standard base64)</pre>
 *
 * — so that the cost can be raised later without locking out the accounts
 * made under the old one. A stored string is therefore verified with the
 * parameters and the digest length <em>it</em> names, never with the ones a
 * new password gets today.
 *
 * <p>The accounts that exist were written by the service this one replaces,
 * and have to keep signing in. So a stored string is read exactly as that
 * service read it (the numbers as its runtime converts text to a number, a
 * zero standing for that runtime's own default, the limits its scrypt
 * enforced), and anything it could not compute is a password that does not
 * match — a failed sign-in, never an error.
 *
 * <p>Three things are deliberately stricter here
 * (docs/JAVA-INTENDED-DIFFERENCES.md):
 * <ul>
 * <li>a stored string with an empty digest matches nothing — the reference
 *     compared two empty digests and let any password in;</li>
 * <li>a stored string is computed only up to four times today's cost in time
 *     and twice in memory; past that it is a failed sign-in, where the
 *     reference tried whatever the row said;</li>
 * <li>at most {@value #AT_ONCE} are computed at a time. One takes about
 *     32 MiB; the previous runtime computed one at a time by its nature, a
 *     servlet container would compute one per request thread.</li>
 * </ul>
 */
public final class Passwords {
    private Passwords() {
    }

    /** N = 2^15 with r = 8 is a few hundred milliseconds: expensive to guess offline, unnoticed by a person. */
    private static final int N = 32_768;
    private static final int R = 8;
    private static final int P = 1;
    private static final int KEY_LENGTH = 32;

    /** How many are computed at the same time; the rest wait their turn. */
    public static final int AT_ONCE = 2;
    private static final Semaphore TURNS = new Semaphore(AT_ONCE, true);

    /** Time: N·r·p of a stored string, at most four times today's. */
    static final long MAX_WORK = 4L * N * R * P;
    /** Memory: 128·N·r bytes, at most twice today's (64 MiB). */
    static final long MAX_MEMORY = 2L * 128 * N * R;

    private static final double UINT32_MAX = 4_294_967_295d;
    private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;
    /** What the previous runtime's scrypt allowed itself when it was given no limit. */
    private static final double DEFAULT_MAX_MEMORY = 32d * 1024 * 1024;

    private static final SecureRandom RANDOM = new SecureRandom();

    /** A new password as it is stored. */
    public static String hash(String password) {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        byte[] digest = derive(utf8(password), salt, N, R, P, KEY_LENGTH);
        return "scrypt$" + N + "$" + R + "$" + P + "$" + Base64.getEncoder().encodeToString(salt) + "$" + Base64.getEncoder().encodeToString(digest);
    }

    /** Does this password match the stored string? A stored string that cannot be read or computed matches nothing. */
    public static boolean verify(String password, String stored) {
        String[] parts = stored.split("\\$", -1);
        if (parts.length != 6 || !parts[0].equals("scrypt")) {
            return false;
        }
        double n = Js.toNumber(parts[1]);
        double r = Js.toNumber(parts[2]);
        double p = Js.toNumber(parts[3]);
        if (!finite(n) || !finite(r) || !finite(p)) {
            return false;
        }
        byte[] expected = PublicKeys.base64(parts[5]);
        byte[] salt = PublicKeys.base64(parts[4]);
        long[] cost = cost(n, r, p);
        if (cost == null || expected.length == 0 || !affordable(cost[0], cost[1], cost[2])) {
            return false;
        }
        byte[] actual = derive(utf8(password), salt, (int) cost[0], (int) cost[1], (int) cost[2], expected.length);
        return MessageDigest.isEqual(actual, expected);
    }

    /**
     * The parameters a stored string names, as the reference's scrypt would
     * take them — or {@code null} where it refused them: not whole, not
     * within 32 bits, N not a power of two above 1, or more memory than the
     * limit it was given (256·N·r as written; 32 MiB where that is zero). A
     * zero stands for that runtime's default: N 16384, r 8, p 1.
     */
    static long[] cost(double n, double r, double p) {
        if (!uint32(n) || !uint32(r) || !uint32(p)) {
            return null;
        }
        double maxMemory = 256d * n * r;
        if (maxMemory > MAX_SAFE_INTEGER) {
            return null;
        }
        long nn = n == 0 ? 16_384 : (long) n;
        long rr = r == 0 ? 8 : (long) r;
        long pp = p == 0 ? 1 : (long) p;
        if (maxMemory == 0) {
            maxMemory = DEFAULT_MAX_MEMORY;
        }
        if (nn < 2 || (nn & (nn - 1)) != 0) {
            return null;
        }
        if (pp > ((1L << 30) - 1) / rr) {
            return null;
        }
        if (16 * rr <= 63 && nn >= (1L << (16 * rr))) {
            return null;
        }
        if (pp * 128 * rr > Integer.MAX_VALUE) {
            return null;
        }
        // 128·r·(N + 2) for the table and its two working blocks, 128·r·p for the blocks themselves.
        double needed = 128d * rr * (nn + 2) + 128d * rr * pp;
        return needed > maxMemory ? null : new long[] { nn, rr, pp };
    }

    /** Is this cost one this service is willing to pay for a sign-in? */
    static boolean affordable(long n, long r, long p) {
        return n * r <= MAX_MEMORY / 128 && n * r * p <= MAX_WORK;
    }

    private static boolean finite(double d) {
        return !Double.isNaN(d) && !Double.isInfinite(d);
    }

    private static boolean uint32(double d) {
        return d >= 0 && d <= UINT32_MAX && d == Math.rint(d);
    }

    private static byte[] derive(byte[] password, byte[] salt, int n, int r, int p, int length) {
        TURNS.acquireUninterruptibly();
        try {
            return SCrypt.generate(password, salt, n, r, p, length);
        } finally {
            TURNS.release();
        }
    }

    /** UTF-8, with a half of a surrogate pair that stands alone written as U+FFFD — as the reference's runtime wrote it. */
    static byte[] utf8(String text) {
        try {
            ByteBuffer out = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPLACE)
                    .onUnmappableCharacter(CodingErrorAction.REPLACE)
                    .replaceWith(new byte[] { (byte) 0xEF, (byte) 0xBF, (byte) 0xBD })
                    .encode(CharBuffer.wrap(text));
            byte[] bytes = new byte[out.remaining()];
            out.get(bytes);
            return bytes;
        } catch (CharacterCodingException e) {
            // Cannot happen: both actions replace.
            throw new IllegalStateException(e);
        }
    }
}
