package com.stonehash.attest.core.btc;

import com.stonehash.attest.core.format.Hex;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.util.List;
import java.util.function.Supplier;
import org.bouncycastle.math.ec.ECPoint;

/**
 * Taproot — BIP341 commitments and BIP342 tapscript, for one spend shape.
 *
 * <p>Everything here exists to build and sign a single transaction: the
 * reveal that spends a one-leaf P2TR output by the script path, carrying an
 * inscription envelope in its witness. Nothing else in the service spends
 * anything, so this is not a general taproot library and should not grow
 * into one — key-path spends, trees of several leaves, annexes and the other
 * sighash types are absent because nothing needs them.
 *
 * <h2>The three things that are easy to get wrong</h2>
 *
 * <b>Parity.</b> The control block's low bit is the parity of the
 * <i>tweaked output</i> key's y coordinate, not the internal key's. Get it
 * wrong and the node recomputes a different output key and rejects the spend
 * with a message that does not mention parity.
 *
 * <p><b>Which key signs.</b> The tapscript's {@code OP_CHECKSIG} tests the
 * key pushed inside the leaf, so the signature is made with the plain leaf
 * key — not the tweaked key. The tweak only ever appears in the output.
 *
 * <p><b>The sighash covers every input's amount and scriptPubKey</b>, not
 * just the one being signed. A reveal that borrowed amounts from the wrong
 * previous output produces a signature that verifies against nothing.
 */
public final class Taproot {
    private Taproot() {
    }

    /** BIP342 tapscript leaf version. */
    public static final int LEAF_VERSION = 0xc0;

    /**
     * Minimal push encoding for script data. Minimality matters: a tapscript
     * with a non-minimal push is non-standard, so the reveal would be refused
     * by the mempool rather than failing a check we could see. An empty push
     * is {@code OP_0}, which is also the {@code OP_FALSE} that opens the
     * inscription envelope.
     */
    public static byte[] pushData(byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 3);
        if (data.length == 0) {
            out.write(0x00);
        } else if (data.length <= 0x4b) {
            out.write(data.length);
        } else if (data.length <= 0xff) {
            out.write(0x4c);
            out.write(data.length);
        } else if (data.length <= 0xffff) {
            out.write(0x4d);
            out.write(data.length & 0xff);
            out.write((data.length >> 8) & 0xff);
        } else {
            throw new IllegalArgumentException("push too large for this encoder: " + data.length);
        }
        out.writeBytes(data);
        return out.toByteArray();
    }

    /** {@code tagged_hash("TapLeaf", leaf_version ‖ compact_size(script) ‖ script)}. */
    public static byte[] tapleafHash(byte[] script) {
        return Secp256k1.taggedHash("TapLeaf", new byte[] { (byte) LEAF_VERSION }, Varint.encode(script.length), script);
    }

    /** A one-leaf script tree committed to an internal key. */
    public static final class Output {
        /** The x-only tweaked output key — what the scriptPubKey commits to. */
        public final byte[] outputKey;
        /** The y-parity of the tweaked point; the control block's low bit. */
        public final int parity;
        /** {@code OP_1 <32-byte push>} — the P2TR scriptPubKey. */
        public final byte[] scriptPubKey;
        /** {@code [leaf_version | parity] ‖ internal_key} — 33 bytes for a single leaf. */
        public final byte[] controlBlock;
        public final byte[] tapleaf;

        Output(byte[] outputKey, int parity, byte[] scriptPubKey, byte[] controlBlock, byte[] tapleaf) {
            this.outputKey = outputKey;
            this.parity = parity;
            this.scriptPubKey = scriptPubKey;
            this.controlBlock = controlBlock;
            this.tapleaf = tapleaf;
        }
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) {
            out.writeBytes(p);
        }
        return out.toByteArray();
    }

    /**
     * Commit a single-leaf script tree to an internal key. With one leaf the
     * Merkle root is the leaf hash and the control block carries no path,
     * which is why it is exactly 33 bytes here.
     */
    public static Output singleLeaf(byte[] internalXOnly, byte[] script) {
        if (internalXOnly.length != 32) {
            throw new IllegalArgumentException("internal key must be x-only (32 bytes)");
        }
        byte[] tapleaf = tapleafHash(script);
        BigInteger tweak = Secp256k1.bytesToBigint(Secp256k1.taggedHash("TapTweak", internalXOnly, tapleaf));
        if (tweak.compareTo(Secp256k1.N) >= 0) {
            throw new IllegalArgumentException("taproot tweak out of range");
        }
        ECPoint internalPoint = Secp256k1.liftX(Secp256k1.bytesToBigint(internalXOnly));
        if (internalPoint == null) {
            throw new IllegalArgumentException("internal key is not on the curve");
        }
        ECPoint q = Secp256k1.pointAdd(internalPoint, Secp256k1.pointMul(tweak));
        if (q.isInfinity()) {
            throw new IllegalArgumentException("taproot tweak produced the point at infinity");
        }
        byte[] outputKey = Secp256k1.xOnly(q);
        int parity = Secp256k1.hasEvenY(q) ? 0 : 1;
        return new Output(outputKey, parity, concat(new byte[] { 0x51, 0x20 }, outputKey),
                concat(new byte[] { (byte) (LEAF_VERSION | parity) }, internalXOnly), tapleaf);
    }

    // ── sighash ───────────────────────────────────────────────────────────────

    /** What an input spends — needed because the sighash covers all of them. */
    public static final class Prevout {
        public final long value;
        public final byte[] scriptPubKey;

        public Prevout(long value, byte[] scriptPubKey) {
            this.value = value;
            this.scriptPubKey = scriptPubKey;
        }
    }

    /**
     * BIP341 signature message for a script-path spend with
     * {@code SIGHASH_DEFAULT}: it signs every input and every output and
     * leaves no trailing byte on the signature, so the witness element is
     * exactly 64 bytes. The BIP342 extension (tapleaf, key version,
     * codeseparator position) is appended because this is a tapscript spend.
     */
    public static byte[] tapSighash(List<Tx.Input> inputs, List<Tx.Output> outputs, List<Prevout> prevouts, int inputIndex,
            byte[] tapleaf, long version, long locktime) {
        if (prevouts.size() != inputs.size()) {
            throw new IllegalArgumentException("every input needs its prevout: the sighash commits to all of them");
        }
        ByteArrayOutputStream prev = new ByteArrayOutputStream();
        ByteArrayOutputStream sequences = new ByteArrayOutputStream();
        for (Tx.Input i : inputs) {
            prev.writeBytes(Tx.reversed(Hex.decode(i.txid)));
            prev.writeBytes(Varint.uintLE(i.vout, 4));
            sequences.writeBytes(Varint.uintLE(i.sequence, 4));
        }
        ByteArrayOutputStream amounts = new ByteArrayOutputStream();
        ByteArrayOutputStream scripts = new ByteArrayOutputStream();
        for (Prevout p : prevouts) {
            amounts.writeBytes(Varint.uintLE(p.value, 8));
            scripts.writeBytes(Varint.encode(p.scriptPubKey.length));
            scripts.writeBytes(p.scriptPubKey);
        }
        ByteArrayOutputStream outs = new ByteArrayOutputStream();
        for (Tx.Output o : outputs) {
            outs.writeBytes(Varint.uintLE(o.value, 8));
            outs.writeBytes(Varint.encode(o.scriptPubKey.length));
            outs.writeBytes(o.scriptPubKey);
        }
        // spend_type = ext_flag * 2 + annex_present. Tapscript sets ext_flag = 1 and no annex is ever attached: 2.
        return Secp256k1.taggedHash("TapSighash",
                new byte[] { 0x00 },                 // sighash epoch
                new byte[] { 0x00 },                 // hash_type: SIGHASH_DEFAULT
                Varint.uintLE(version, 4),
                Varint.uintLE(locktime, 4),
                Hex.sha256(prev.toByteArray()), Hex.sha256(amounts.toByteArray()), Hex.sha256(scripts.toByteArray()),
                Hex.sha256(sequences.toByteArray()),
                Hex.sha256(outs.toByteArray()),
                new byte[] { 0x02 },                 // spend type
                Varint.uintLE(inputIndex, 4),
                tapleaf,
                new byte[] { 0x00 },                 // key version
                Varint.uintLE(0xffffffffL, 4));      // no codeseparator
    }

    public static byte[] tapSighash(List<Tx.Input> inputs, List<Tx.Output> outputs, List<Prevout> prevouts, int inputIndex, byte[] tapleaf) {
        return tapSighash(inputs, outputs, prevouts, inputIndex, tapleaf, 2, 0);
    }

    // ── segwit serialisation ──────────────────────────────────────────────────

    /**
     * Serialise with the witness marker, flag and stacks. The txid is still
     * taken over the legacy form ({@link Tx#serializeLegacy}), because the
     * witness is not committed by it. That asymmetry is the whole reason a
     * witness inscription must bind its body through {@code leaf_bytes}
     * rather than being trusted on sight.
     */
    public static byte[] serializeWitness(List<Tx.Input> inputs, List<Tx.Output> outputs, List<List<byte[]>> witnesses, long version, long locktime) {
        if (witnesses.size() != inputs.size()) {
            throw new IllegalArgumentException("serializeWitness needs one witness stack per input");
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(Varint.uintLE(version, 4));
        out.write(0x00);                             // segwit marker
        out.write(0x01);                             // and flag
        out.writeBytes(Varint.encode(inputs.size()));
        for (Tx.Input i : inputs) {
            out.writeBytes(Tx.reversed(Hex.decode(i.txid)));
            out.writeBytes(Varint.uintLE(i.vout, 4));
            out.writeBytes(Varint.encode(i.scriptSig.length));
            out.writeBytes(i.scriptSig);
            out.writeBytes(Varint.uintLE(i.sequence, 4));
        }
        out.writeBytes(Varint.encode(outputs.size()));
        for (Tx.Output o : outputs) {
            out.writeBytes(Varint.uintLE(o.value, 8));
            out.writeBytes(Varint.encode(o.scriptPubKey.length));
            out.writeBytes(o.scriptPubKey);
        }
        for (List<byte[]> stack : witnesses) {
            out.writeBytes(Varint.encode(stack.size()));
            for (byte[] item : stack) {
                out.writeBytes(Varint.encode(item.length));
                out.writeBytes(item);
            }
        }
        out.writeBytes(Varint.uintLE(locktime, 4));
        return out.toByteArray();
    }

    public static byte[] serializeWitness(List<Tx.Input> inputs, List<Tx.Output> outputs, List<List<byte[]>> witnesses) {
        return serializeWitness(inputs, outputs, witnesses, 2, 0);
    }

    /** wtxid — over the witness form. Only useful for logs; the txid is elsewhere. */
    public static String wtxidOf(byte[] witnessSerialisation) {
        return Hex.encode(Tx.reversed(Tx.sha256d(witnessSerialisation)));
    }

    /** A 32-byte secret in range, for one inscription and then dropped. */
    public static byte[] ephemeralSecret(Supplier<byte[]> random) {
        for (int attempt = 0; attempt < 64; attempt++) {
            BigInteger v = Secp256k1.bytesToBigint(random.get());
            if (v.signum() > 0 && v.compareTo(Secp256k1.N) < 0) {
                return Secp256k1.bigintTo32(v);
            }
        }
        throw new IllegalArgumentException("could not draw a secret key in range");
    }
}
