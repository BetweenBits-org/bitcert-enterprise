package com.stonehash.attest.core.format;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Bytes as lower-case hex, and SHA-256. */
public final class Hex {
    private Hex() {
    }

    private static final char[] DIGITS = "0123456789abcdef".toCharArray();

    public static String encode(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = DIGITS[(bytes[i] >> 4) & 15];
            out[i * 2 + 1] = DIGITS[bytes[i] & 15];
        }
        return new String(out);
    }

    /** @throws IllegalArgumentException when the text is not an even number of hex digits */
    public static byte[] decode(String hex) {
        if (hex.length() % 2 != 0) {
            throw new IllegalArgumentException("hex of odd length");
        }
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = digit(hex.charAt(i * 2));
            int lo = digit(hex.charAt(i * 2 + 1));
            if (hi < 0 || lo < 0) {
                throw new IllegalArgumentException("not hex");
            }
            out[i] = (byte) (hi * 16 + lo);
        }
        return out;
    }

    private static int digit(char c) {
        return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
    }

    public static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest d = MessageDigest.getInstance("SHA-256");
            for (byte[] part : parts) {
                d.update(part);
            }
            return d.digest();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
