package com.stonehash.attest.por;

import java.util.Arrays;

/**
 * A reusable byte buffer for assembling what is about to be hashed. A tree of
 * a million accounts hashes a few million short messages; building each in
 * one buffer that is reset rather than reallocated is most of the difference
 * between seconds and a minute.
 */
final class ByteSink {
    private byte[] buf = new byte[256];
    private int length;

    void reset() {
        length = 0;
    }

    int length() {
        return length;
    }

    byte[] array() {
        return buf;
    }

    void put(byte b) {
        ensure(1);
        buf[length++] = b;
    }

    void put(byte[] bytes) {
        put(bytes, 0, bytes.length);
    }

    void put(byte[] bytes, int offset, int count) {
        ensure(count);
        System.arraycopy(bytes, offset, buf, length, count);
        length += count;
    }

    /** For text known to be ASCII (digits, hex): one byte per character. */
    void putAscii(String s) {
        int n = s.length();
        ensure(n);
        for (int i = 0; i < n; i++) {
            buf[length++] = (byte) s.charAt(i);
        }
    }

    private void ensure(int more) {
        if (length + more > buf.length) {
            buf = Arrays.copyOf(buf, Math.max(buf.length * 2, length + more));
        }
    }
}
