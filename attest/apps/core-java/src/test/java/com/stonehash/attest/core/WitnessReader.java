package com.stonehash.attest.core;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Reads an inscription back out of a transaction — for the tests only. The
 * service writes envelopes and never reads one (reading is the verifier's
 * work, {@code packages/attest-verify}); this reader shares no code with the
 * producer, so what it recovers says something about what was produced.
 */
final class WitnessReader {
    private WitnessReader() {
    }

    private static final class Cursor {
        final byte[] b;
        int at;

        Cursor(byte[] b) {
            this.b = b;
        }

        byte[] take(long n) {
            if (n < 0 || at + n > b.length) {
                throw new IllegalArgumentException("the transaction ends before its fields do");
            }
            byte[] out = Arrays.copyOfRange(b, at, at + (int) n);
            at += (int) n;
            return out;
        }

        long le(int width) {
            long v = 0;
            byte[] raw = take(width);
            for (int i = width - 1; i >= 0; i--) {
                v = (v << 8) | (raw[i] & 0xff);
            }
            return v;
        }

        long varint() {
            int first = b[at++] & 0xff;
            return first < 0xfd ? first : first == 0xfd ? le(2) : first == 0xfe ? le(4) : le(8);
        }
    }

    /** The witness stack of one input, from a transaction in its witness form. */
    static List<byte[]> witnessItems(byte[] tx, int inputIndex) {
        Cursor c = new Cursor(tx);
        c.take(4);
        byte[] marker = c.take(2);
        if (marker[0] != 0x00 || marker[1] != 0x01) {
            throw new IllegalArgumentException("not in the witness form");
        }
        long inputs = c.varint();
        for (long i = 0; i < inputs; i++) {
            c.take(36);
            c.take(c.varint());
            c.take(4);
        }
        long outputs = c.varint();
        for (long i = 0; i < outputs; i++) {
            c.take(8);
            c.take(c.varint());
        }
        List<byte[]> wanted = null;
        for (long i = 0; i < inputs; i++) {
            List<byte[]> stack = new ArrayList<>();
            long items = c.varint();
            for (long j = 0; j < items; j++) {
                stack.add(c.take(c.varint()));
            }
            if (i == inputIndex) {
                wanted = stack;
            }
        }
        c.take(4);
        if (c.at != tx.length || wanted == null) {
            throw new IllegalArgumentException("the transaction does not end where its fields do");
        }
        return wanted;
    }

    /** What a leaf script of the inscription layout holds. */
    static final class Envelope {
        byte[] pubkey;
        String protocolTag;
        String contentType;
        byte[] body;
        /** The size of every body push, in order. */
        final List<Integer> pushes = new ArrayList<>();
    }

    private static byte[] push(Cursor c) {
        int op = c.b[c.at++] & 0xff;
        if (op <= 0x4b) {
            return c.take(op);
        }
        if (op == 0x4c) {
            return c.take(c.le(1));
        }
        if (op == 0x4d) {
            return c.take(c.le(2));
        }
        throw new IllegalArgumentException("not a push: opcode " + Integer.toHexString(op));
    }

    /** {@code <pubkey> OP_CHECKSIG OP_FALSE OP_IF <tag> <content type> <body…> OP_ENDIF}, and nothing else. */
    static Envelope envelope(byte[] leafScript) {
        Cursor c = new Cursor(leafScript);
        Envelope e = new Envelope();
        e.pubkey = push(c);
        if (e.pubkey.length != 32 || (c.take(1)[0] & 0xff) != 0xac || (c.take(1)[0] & 0xff) != 0x00 || (c.take(1)[0] & 0xff) != 0x63) {
            throw new IllegalArgumentException("not an inscription leaf: it does not open with <key> OP_CHECKSIG OP_FALSE OP_IF");
        }
        e.protocolTag = new String(push(c), StandardCharsets.UTF_8);
        e.contentType = new String(push(c), StandardCharsets.UTF_8);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        while ((c.b[c.at] & 0xff) != 0x68) {
            byte[] chunk = push(c);
            e.pushes.add(chunk.length);
            body.writeBytes(chunk);
        }
        c.take(1);
        if (c.at != leafScript.length) {
            throw new IllegalArgumentException("bytes after OP_ENDIF");
        }
        e.body = body.toByteArray();
        return e;
    }
}
