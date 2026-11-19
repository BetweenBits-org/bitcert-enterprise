package com.stonehash.attest.core.btc;

import com.stonehash.attest.core.format.Hex;
import java.io.ByteArrayOutputStream;
import java.util.List;

/**
 * Transaction serialisation and txid computation — only what anchoring
 * needs: the {@code OP_RETURN} output script, a transaction in legacy
 * (non-witness) form, and its txid. Signing and funding are the node's job;
 * no private key of a wallet is ever handled in this process.
 *
 * <p>Byte-order warning, because getting it wrong fails silently: a txid is
 * the double SHA-256 of the legacy serialisation, reversed into display
 * order. Everything inside a transaction is little-endian; everything a
 * person or an explorer sees is big-endian.
 */
public final class Tx {
    private Tx() {
    }

    public static final class Input {
        /** The previous txid in display order, as a user or an explorer quotes it. */
        public final String txid;
        public final long vout;
        public final byte[] scriptSig;
        public final long sequence;

        public Input(String txid, long vout) {
            this(txid, vout, new byte[0], 0xffffffffL);
        }

        public Input(String txid, long vout, byte[] scriptSig, long sequence) {
            this.txid = txid;
            this.vout = vout;
            this.scriptSig = scriptSig;
            this.sequence = sequence;
        }
    }

    public static final class Output {
        /** Satoshis. An {@code OP_RETURN} output carries 0. */
        public final long value;
        public final byte[] scriptPubKey;

        public Output(long value, byte[] scriptPubKey) {
            this.value = value;
            this.scriptPubKey = scriptPubKey;
        }
    }

    public static byte[] sha256d(byte[] b) {
        return Hex.sha256(Hex.sha256(b));
    }

    public static byte[] reversed(byte[] b) {
        byte[] out = new byte[b.length];
        for (int i = 0; i < b.length; i++) {
            out[i] = b[b.length - 1 - i];
        }
        return out;
    }

    /**
     * {@code OP_RETURN <push data>}. Payloads up to 75 bytes use a direct
     * push; larger ones use {@code OP_PUSHDATA1}. A BC01 payload is 53 bytes,
     * so the whole output script is 55.
     */
    public static byte[] opReturnScript(byte[] payload) {
        if (payload.length > 0xff) {
            throw new IllegalArgumentException("anchor payload too large: " + payload.length);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0x6a);
        if (payload.length > 0x4b) {
            out.write(0x4c);
        }
        out.write(payload.length);
        out.writeBytes(payload);
        return out.toByteArray();
    }

    /** Serialise in legacy (non-witness) form — what the txid is the hash of. */
    public static byte[] serializeLegacy(List<Input> inputs, List<Output> outputs, long version, long locktime) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(Varint.uintLE(version, 4));
        out.writeBytes(Varint.encode(inputs.size()));
        for (Input i : inputs) {
            // Display order in, wire order out.
            out.writeBytes(reversed(Hex.decode(i.txid)));
            out.writeBytes(Varint.uintLE(i.vout, 4));
            out.writeBytes(Varint.encode(i.scriptSig.length));
            out.writeBytes(i.scriptSig);
            out.writeBytes(Varint.uintLE(i.sequence, 4));
        }
        out.writeBytes(Varint.encode(outputs.size()));
        for (Output o : outputs) {
            out.writeBytes(Varint.uintLE(o.value, 8));
            out.writeBytes(Varint.encode(o.scriptPubKey.length));
            out.writeBytes(o.scriptPubKey);
        }
        out.writeBytes(Varint.uintLE(locktime, 4));
        return out.toByteArray();
    }

    public static byte[] serializeLegacy(List<Input> inputs, List<Output> outputs) {
        return serializeLegacy(inputs, outputs, 2, 0);
    }

    /** The txid of a legacy serialisation, in display (big-endian) order. */
    public static String txidOf(byte[] legacy) {
        return Hex.encode(reversed(sha256d(legacy)));
    }
}
