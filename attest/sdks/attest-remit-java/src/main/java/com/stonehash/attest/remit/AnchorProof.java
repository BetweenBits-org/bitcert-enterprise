package com.stonehash.attest.remit;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Re-verifying the proof file that anchors an evidence commitment: is the
 * record in the batch's Merkle root, is that root what the anchor output
 * commits to, and does that output belong to the transaction the file names.
 * Arithmetic only — no network, no clock.
 *
 * <p>The checks, their names and their order are the reference verifier's
 * ({@code verifyBundle} of the TypeScript package), for the form of proof file
 * an evidence package carries: one record, its Merkle path, the anchor output
 * and the raw transaction. Two things are stated rather than done:
 *
 * <ul>
 * <li><b>onchain</b> is always {@code skip}. Whether the transaction is in a
 *     block of a public chain is a question for a Bitcoin source of the
 *     reader's choosing; no verifier of ours answers it.
 * <li>A proof file of another form — an original inscribed in the witness, a
 *     daily balance row with reconciliation figures or a chain entry, a signed
 *     statement or declared fields as the original — is <b>not supported</b>
 *     here and is reported as such, never as passed.
 * </ul>
 */
final class AnchorProof {
    private static final List<String> SUPPORTED_SCHEMAS = Arrays.asList("bitcert-proof-bundle/v1", "bitcert-proof-bundle/v2");

    /** What re-verifying one proof file found. */
    static final class Outcome {
        /** Why this form of proof file is not re-verified here; {@code null} when it was. */
        final String unsupported;
        /** No check whose failure matters failed. Meaningless when {@link #unsupported} is set. */
        final boolean verified;
        /** {@code id:state} for each check, in the reference verifier's order and words. */
        final List<String> checks;

        private Outcome(String unsupported, boolean verified, List<String> checks) {
            this.unsupported = unsupported;
            this.verified = verified;
            this.checks = checks;
        }
    }

    private AnchorProof() {
    }

    static Outcome verify(Map<String, Object> bundle) {
        List<String> checks = new ArrayList<>();
        Object schema = bundle.get("schema");
        if (!(schema instanceof String) || !SUPPORTED_SCHEMAS.contains(schema)) {
            checks.add("schema:fail");
            return new Outcome(null, false, checks);
        }
        checks.add("schema:pass");

        Map<String, Object> anchor = mapOrNull(bundle.get("anchor"));
        Map<String, Object> record = mapOrNull(bundle.get("record"));
        Map<String, Object> chain = mapOrNull(bundle.get("chain"));
        Map<String, Object> preimage = record == null ? null : mapOrNull(record.get("preimage"));
        if (anchor != null && truthy(anchor.get("witness_envelope"))) {
            return new Outcome("its original is inscribed in the transaction's witness", false, checks);
        }
        if (truthy(bundle.get("reconciliation"))) {
            return new Outcome("it commits a day root with reconciliation figures", false, checks);
        }
        if (chain != null && truthy(chain.get("entry"))) {
            return new Outcome("it carries a chain entry", false, checks);
        }
        Object scheme = preimage == null ? null : preimage.get("scheme");
        if ("sha256-signed-statement/v1".equals(scheme) || "sha256-jcs-fields".equals(scheme)) {
            return new Outcome("its original is bound by the rule " + scheme, false, checks);
        }

        boolean verified = true;

        // Link A — original → leaf_bytes. An evidence package's leaf is the commitment, which the
        // caller recomputes; here the rule is only read, as the reference verifier reads it without the original.
        if (record == null) {
            checks.add("preimage:fail");
            verified = false;
        } else if (!truthy(record.get("preimage"))) {
            checks.add("preimage:skip"); // no rule declared: a digest is anchored, and that is all the file says of it
        } else if (record.get("leaf_bytes") instanceof String && "sha256-file".equals(scheme)) {
            checks.add("preimage:warn"); // the rule needs the original, which is not here
        } else {
            checks.add("preimage:fail"); // a rule nobody knows is not skipped: it was never evaluated
            verified = false;
        }

        // Link B — Merkle inclusion (RFC 6962).
        String merkleRoot = null;
        try {
            Map<String, Object> merkle = mapOrNull(bundle.get("merkle"));
            if (merkle == null) {
                throw new IllegalArgumentException("bundle has no merkle section");
            }
            String leaf = record == null ? null : text(record.get("leaf_bytes"));
            String computed = foldInclusion(leaf, merkle);
            merkleRoot = (merkle.get("root") == null ? "" : String.valueOf(merkle.get("root"))).toLowerCase(Locale.ROOT);
            boolean ok = computed.equals(merkleRoot);
            checks.add(ok ? "merkle:pass" : "merkle:fail");
            verified &= ok;
        } catch (IllegalArgumentException e) {
            checks.add("merkle:fail");
            verified = false;
        }

        // The anchor output commits the Merkle root.
        try {
            String payload = anchor == null ? null : text(anchor.get("op_return_payload_hex"));
            String anchored = committedRoot(decodeHex(payload));
            if (anchored == null) {
                throw new IllegalArgumentException("anchor payload has no BC01/BC30 magic");
            }
            boolean ok = merkleRoot != null && anchored.equalsIgnoreCase(merkleRoot);
            checks.add(ok ? "anchor-commitment:pass" : "anchor-commitment:fail");
            verified &= ok;
        } catch (IllegalArgumentException e) {
            checks.add("anchor-commitment:fail");
            verified = false;
        }

        // Link C1 — the anchor output belongs to the stated transaction.
        Object rawTx = anchor == null ? null : anchor.get("reveal_tx_hex");
        if (truthy(rawTx)) {
            try {
                Transaction tx = Transaction.parse(decodeHex(text(rawTx)));
                boolean txidOk = hexEquals(tx.txid(), anchor.get("reveal_txid"));
                boolean payloadOk = hexEquals(tx.anchorPayloadHex(), anchor.get("op_return_payload_hex"));
                boolean ok = txidOk && payloadOk;
                checks.add(ok ? "txid-binding:pass" : "txid-binding:fail");
                verified &= ok;
            } catch (IllegalArgumentException e) {
                checks.add("txid-binding:fail");
                verified = false;
            }
        } else {
            checks.add("txid-binding:warn");
        }

        // Never performed in-process, by any verifier of ours.
        checks.add("onchain:skip");
        return new Outcome(null, verified, checks);
    }

    // ── Merkle ────────────────────────────────────────────────────────────────

    /** Folds the record up through its proof path and returns the root reached, in hex. */
    private static String foldInclusion(String leafHex, Map<String, Object> merkle) {
        byte[] leaf = decodeHex(leafHex);
        if (leaf.length != 32) {
            throw new IllegalArgumentException("leaf_bytes must be 32 bytes");
        }
        if (!(merkle.get("siblings") instanceof List) || !(merkle.get("directions") instanceof List)) {
            throw new IllegalArgumentException("merkle.siblings and merkle.directions must be arrays");
        }
        List<?> siblings = (List<?>) merkle.get("siblings");
        List<?> directions = (List<?>) merkle.get("directions");
        if (siblings.size() != directions.size()) {
            throw new IllegalArgumentException("siblings/directions length mismatch");
        }
        byte[] current = sha256(new byte[] { 0x00 }, leaf);
        for (int i = 0; i < siblings.size(); i++) {
            byte[] sibling = decodeHex(text(siblings.get(i)));
            if (sibling.length != 32) {
                throw new IllegalArgumentException("sibling " + i + " is not 32 bytes");
            }
            Object direction = directions.get(i);
            // The direction is the sibling's position, not the current node's.
            if ("left".equals(direction)) {
                current = sha256(new byte[] { 0x01 }, sibling, current);
            } else if ("right".equals(direction)) {
                current = sha256(new byte[] { 0x01 }, current, sibling);
            } else {
                throw new IllegalArgumentException("direction " + i + " must be \"left\" or \"right\"");
            }
        }
        return Hex.encode(current);
    }

    // ── the anchor output ─────────────────────────────────────────────────────

    /** The 32 bytes a {@code BC01} (53 bytes) or {@code BC30} (86 bytes) payload commits, in hex; {@code null} for another payload. */
    private static String committedRoot(byte[] payload) {
        String magic = payload.length >= 4 ? new String(payload, 0, 4, StandardCharsets.ISO_8859_1) : "";
        if ("BC01".equals(magic)) {
            if (payload.length != 53) {
                throw new IllegalArgumentException("BC01 must be 53 bytes");
            }
            return Hex.encode(payload, 5, 32);
        }
        if ("BC30".equals(magic)) {
            if (payload.length != 86) {
                throw new IllegalArgumentException("BC30 must be 86 bytes");
            }
            return Hex.encode(payload, 22, 32);
        }
        return null;
    }

    // ── the transaction ───────────────────────────────────────────────────────

    /**
     * A raw transaction, read far enough to recompute its id and find its
     * anchor output. The id is the double SHA-256 of the serialisation
     * <em>without</em> witness data, so a segwit transaction is re-serialised
     * with its marker, flag and witness stacks left out; hashing the raw bytes
     * as they stand would give the wtxid.
     */
    private static final class Transaction {
        private final byte[] legacy;
        private final List<byte[]> outputScripts;

        private Transaction(byte[] legacy, List<byte[]> outputScripts) {
            this.legacy = legacy;
            this.outputScripts = outputScripts;
        }

        static Transaction parse(byte[] raw) {
            Reader r = new Reader(raw);
            ByteArrayOutputStream legacy = new ByteArrayOutputStream();
            legacy.writeBytes(r.take(4)); // version
            boolean segwit = r.remaining() >= 2 && raw[r.at] == 0x00 && raw[r.at + 1] == 0x01;
            if (segwit) {
                r.take(2);
            }
            long inputs = r.varint();
            writeVarint(legacy, inputs);
            for (long i = 0; i < inputs; i++) {
                legacy.writeBytes(r.take(32)); // previous txid
                legacy.writeBytes(r.take(4));  // previous output index
                long scriptLength = r.varint();
                writeVarint(legacy, scriptLength);
                legacy.writeBytes(r.take(scriptLength)); // scriptSig
                legacy.writeBytes(r.take(4));  // sequence
            }
            long outputs = r.varint();
            writeVarint(legacy, outputs);
            List<byte[]> scripts = new ArrayList<>();
            for (long i = 0; i < outputs; i++) {
                legacy.writeBytes(r.take(8)); // value
                long scriptLength = r.varint();
                byte[] script = r.take(scriptLength);
                writeVarint(legacy, scriptLength);
                legacy.writeBytes(script);
                scripts.add(script);
            }
            if (segwit) {
                for (long i = 0; i < inputs; i++) {
                    long items = r.varint();
                    for (long j = 0; j < items; j++) {
                        r.take(r.varint());
                    }
                }
            }
            legacy.writeBytes(r.take(4)); // locktime
            return new Transaction(legacy.toByteArray(), scripts);
        }

        /** The transaction id in display (big-endian) order. */
        String txid() {
            byte[] hash = sha256(sha256(legacy));
            byte[] display = new byte[hash.length];
            for (int i = 0; i < hash.length; i++) {
                display[i] = hash[hash.length - 1 - i];
            }
            return Hex.encode(display);
        }

        /** The data pushed by the first {@code OP_RETURN} output, in hex; {@code null} when the transaction has none. */
        String anchorPayloadHex() {
            for (byte[] script : outputScripts) {
                byte[] pushed = opReturnData(script);
                if (pushed != null) {
                    return Hex.encode(pushed);
                }
            }
            return null;
        }

        private static byte[] opReturnData(byte[] script) {
            if (script.length < 1 || (script[0] & 0xff) != 0x6a) {
                return null;
            }
            if (script.length == 1) {
                return new byte[0];
            }
            int at = 1;
            int op = script[at++] & 0xff;
            long length;
            if (op <= 0x4b) {
                length = op;
            } else if (op == 0x4c) {
                length = byteAt(script, at);
                at += 1;
            } else if (op == 0x4d) {
                length = byteAt(script, at) | (byteAt(script, at + 1) << 8);
                at += 2;
            } else if (op == 0x4e) {
                // Thirty-two bits, signed, as the reference computes it: a length with the top bit set
                // is no length, and such a push carries nothing.
                int declared = byteAt(script, at) | (byteAt(script, at + 1) << 8) | (byteAt(script, at + 2) << 16) | (byteAt(script, at + 3) << 24);
                if (declared < 0) {
                    return new byte[0];
                }
                length = declared;
                at += 4;
            } else {
                return null;
            }
            // A push that runs past the end of the script is what is there, as the reference reads it:
            // shorter than declared, and so never equal to the payload the file states.
            int from = Math.min(at, script.length);
            int to = (int) Math.min((long) from + length, script.length);
            return Arrays.copyOfRange(script, from, to);
        }

        private static int byteAt(byte[] script, int at) {
            return at < script.length ? script[at] & 0xff : 0;
        }

        private static void writeVarint(ByteArrayOutputStream out, long n) {
            if (n < 0xfd) {
                out.write((int) n);
            } else if (n <= 0xffff) {
                out.write(0xfd);
                out.write((int) (n & 0xff));
                out.write((int) ((n >>> 8) & 0xff));
            } else if (n <= 0xffffffffL) {
                out.write(0xfe);
                for (int i = 0; i < 4; i++) {
                    out.write((int) ((n >>> (8 * i)) & 0xff));
                }
            } else {
                out.write(0xff);
                for (int i = 0; i < 8; i++) {
                    out.write((int) ((n >>> (8 * i)) & 0xff));
                }
            }
        }
    }

    /** Reads a transaction front to back; running off its end is "tx truncated". */
    private static final class Reader {
        private final byte[] bytes;
        private int at;

        Reader(byte[] bytes) {
            this.bytes = bytes;
        }

        int remaining() {
            return bytes.length - at;
        }

        byte[] take(long n) {
            if (n < 0 || n > remaining()) {
                throw new IllegalArgumentException("tx truncated");
            }
            byte[] out = Arrays.copyOfRange(bytes, at, at + (int) n);
            at += (int) n;
            return out;
        }

        private long littleEndian(int n) {
            byte[] b = take(n);
            long v = 0;
            for (int i = n - 1; i >= 0; i--) {
                v = (v << 8) | (b[i] & 0xff);
            }
            return v;
        }

        long varint() {
            int first = take(1)[0] & 0xff;
            if (first < 0xfd) {
                return first;
            }
            long v = littleEndian(first == 0xfd ? 2 : first == 0xfe ? 4 : 8);
            if (v < 0) {
                throw new IllegalArgumentException("tx truncated"); // a count no transaction can hold
            }
            return v;
        }
    }

    // ── bytes ─────────────────────────────────────────────────────────────────

    private static byte[] sha256(byte[]... parts) {
        MessageDigest digest = Hex.sha256();
        for (byte[] part : parts) {
            digest.update(part);
        }
        return digest.digest();
    }

    /** Hex of either case to bytes. Anything that is not hex is an error, never a guess. */
    private static byte[] decodeHex(String hex) {
        if (hex == null || hex.length() % 2 != 0) {
            throw new IllegalArgumentException("not hex");
        }
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int high = Character.digit(hex.charAt(2 * i), 16);
            int low = Character.digit(hex.charAt(2 * i + 1), 16);
            if (high < 0 || low < 0 || hex.charAt(2 * i) > 'f' || hex.charAt(2 * i + 1) > 'f') {
                throw new IllegalArgumentException("not hex");
            }
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }

    /** Two hex texts name the same bytes, whatever their case. A value that is not text equals nothing. */
    private static boolean hexEquals(Object a, Object b) {
        return a instanceof String && b instanceof String && ((String) a).equalsIgnoreCase((String) b);
    }

    private static String text(Object v) {
        if (!(v instanceof String)) {
            throw new IllegalArgumentException("not text");
        }
        return (String) v;
    }

    private static Map<String, Object> mapOrNull(Object v) {
        return v instanceof Map ? Json.object(v, "invalid_evidence", "the proof file") : null;
    }

    /** Present and not empty, as the reference verifier asks "is there one". */
    private static boolean truthy(Object v) {
        if (v == null || Boolean.FALSE.equals(v)) {
            return false;
        }
        if (v instanceof String) {
            return !((String) v).isEmpty();
        }
        if (v instanceof Number) {
            return ((Number) v).doubleValue() != 0;
        }
        return true;
    }
}
