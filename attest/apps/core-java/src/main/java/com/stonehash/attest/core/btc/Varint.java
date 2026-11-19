package com.stonehash.attest.core.btc;

/** Bitcoin CompactSize and little-endian integers — the primitives every serialiser needs. */
public final class Varint {
    private Varint() {
    }

    public static byte[] encode(long n) {
        if (n < 0) {
            throw new IllegalArgumentException("varint must be a non-negative integer, got " + n);
        }
        if (n < 0xfd) {
            return new byte[] { (byte) n };
        }
        if (n <= 0xffff) {
            return new byte[] { (byte) 0xfd, (byte) n, (byte) (n >>> 8) };
        }
        if (n <= 0xffffffffL) {
            return new byte[] { (byte) 0xfe, (byte) n, (byte) (n >>> 8), (byte) (n >>> 16), (byte) (n >>> 24) };
        }
        byte[] out = new byte[9];
        out[0] = (byte) 0xff;
        System.arraycopy(uintLE(n, 8), 0, out, 1, 8);
        return out;
    }

    /** Little-endian unsigned integer of {@code width} bytes. */
    public static byte[] uintLE(long n, int width) {
        byte[] out = new byte[width];
        long v = n;
        for (int i = 0; i < width; i++) {
            out[i] = (byte) v;
            v >>>= 8;
        }
        return out;
    }
}
