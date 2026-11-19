package com.stonehash.attest.por;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Lowercase hex and SHA-256: the two encodings every hash in the protocol goes through. */
final class Hex {
    private static final char[] DIGITS = "0123456789abcdef".toCharArray();

    private Hex() {
    }

    static String encode(byte[] bytes) {
        return encode(bytes, 0, bytes.length);
    }

    static String encode(byte[] bytes, int offset, int length) {
        char[] out = new char[length * 2];
        for (int i = 0; i < length; i++) {
            int b = bytes[offset + i] & 0xff;
            out[2 * i] = DIGITS[b >>> 4];
            out[2 * i + 1] = DIGITS[b & 0x0f];
        }
        return new String(out);
    }

    /** 64 lowercase hex characters: the only form a hash takes in the protocol. */
    static boolean isHash(String s) {
        if (s == null || s.length() != 64) {
            return false;
        }
        for (int i = 0; i < 64; i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    /** Decodes hex of either letter case into {@code out}; false when {@code s} is not exactly that many bytes of hex. */
    static boolean decodeInto(String s, byte[] out, int offset, int length) {
        if (s == null || s.length() != length * 2) {
            return false;
        }
        for (int i = 0; i < length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16);
            int lo = Character.digit(s.charAt(2 * i + 1), 16);
            // Character.digit also accepts full-width and other Unicode digits; hex here is ASCII.
            if (hi < 0 || lo < 0 || s.charAt(2 * i) > 'f' || s.charAt(2 * i + 1) > 'f') {
                return false;
            }
            out[offset + i] = (byte) ((hi << 4) | lo);
        }
        return true;
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            // Every Java runtime is required to provide SHA-256.
            throw new IllegalStateException("this Java runtime has no SHA-256", e);
        }
    }
}
