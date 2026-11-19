package com.stonehash.attest.core.format;

/**
 * {@code BC01} anchor payload — 53 bytes, the layout published in
 * bundle-schema.md §4.1.
 *
 * <pre>
 * | offset | len | field                        |
 * |--------|-----|------------------------------|
 * | 0..4   | 4   | magic BC01 (42 43 30 31)     |
 * | 4..5   | 1   | version 0x01                 |
 * | 5..37  | 32  | merkle_root                  |
 * | 37..53 | 16  | batch_id (UUID, raw)         |
 * </pre>
 *
 * The OP_RETURN v30 ({@code BC30}) witness double-envelope is patent-pending
 * and its encoder is deliberately not implemented in this repository. BC01
 * carries everything a proof bundle needs — a committed root and a batch
 * identifier — and the published verifiers already decode it.
 */
public final class Bc01 {
    private Bc01() {
    }

    public static final int LENGTH = 53;
    private static final byte[] MAGIC = { 0x42, 0x43, 0x30, 0x31 };
    private static final byte VERSION = 0x01;

    /** A 32-byte root and a 16-byte batch id as the 53-byte payload. */
    public static byte[] encode(byte[] merkleRoot, byte[] batchId16) {
        if (merkleRoot.length != 32) {
            throw new IllegalArgumentException("merkle_root must be 32 bytes, got " + merkleRoot.length);
        }
        if (batchId16.length != 16) {
            throw new IllegalArgumentException("batch_id must be 16 bytes, got " + batchId16.length);
        }
        byte[] out = new byte[LENGTH];
        System.arraycopy(MAGIC, 0, out, 0, 4);
        out[4] = VERSION;
        System.arraycopy(merkleRoot, 0, out, 5, 32);
        System.arraycopy(batchId16, 0, out, 37, 16);
        return out;
    }

    /** A UUID with its dashes as its 16 raw bytes. */
    public static byte[] uuidToBytes(String uuid) {
        String hex = uuid.replace("-", "");
        if (hex.length() != 32) {
            throw new IllegalArgumentException("not a uuid: " + uuid);
        }
        try {
            return Hex.decode(hex);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("not a uuid: " + uuid);
        }
    }
}
