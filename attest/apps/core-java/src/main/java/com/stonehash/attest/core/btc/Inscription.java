package com.stonehash.attest.core.btc;

import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.Hex;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The inscription envelope — the original document, as script.
 *
 * <p>Layout, fixed by bundle-schema.md §4.4 and by the conformance fixture
 * {@code 07-witness-unified}, which this class keeps byte-compatible:
 *
 * <pre>
 *   &lt;32-byte x-only pubkey&gt; OP_CHECKSIG
 *   OP_FALSE OP_IF
 *     &lt;protocol tag&gt;  &lt;content type&gt;  &lt;body chunk…&gt;
 *   OP_ENDIF
 * </pre>
 *
 * <h2>Why the document survives in a place the txid does not cover</h2>
 *
 * The envelope sits inside {@code OP_FALSE OP_IF … OP_ENDIF}, so the
 * interpreter never executes it: the pushes are inert data that the chain
 * nonetheless stores and republishes for ever. The signature check in front
 * is what makes the output spendable only by us before the reveal lands.
 *
 * <p>The witness is not committed by the txid. Bytes recovered from it are
 * worth nothing on their own, and a verifier treats them that way — it
 * hashes the recovered body and requires the digest to equal
 * {@code leaf_bytes}, which is committed, through the anchor output. So
 * {@link #build} computes the leaf from the body rather than accepting one.
 */
public final class Inscription {
    private static final int OP_CHECKSIG = 0xac;
    private static final int OP_FALSE = 0x00;
    private static final int OP_IF = 0x63;
    private static final int OP_ENDIF = 0x68;

    /**
     * Consensus caps a single push at 520 bytes inside a script, so a larger
     * body is split. The verifier concatenates every push after the content
     * type, so where the boundaries fall does not change what is recovered.
     */
    public static final int MAX_PUSH = 520;

    /**
     * The BIP341 NUMS point — {@code lift_x} of the SHA-256 of the
     * uncompressed generator, with no known discrete logarithm.
     *
     * <p>Every inscription commits under this as its taproot internal key,
     * so the commit output has no key path. That is the entire point: an
     * output that can be spent by the key path can be spent without
     * revealing the script, and the script is where the document lives. Such
     * a spend has the same outputs, the same anchor digest and — because the
     * witness is not committed by it — a txid that looks exactly as expected,
     * while the inscribed bytes were never published. With NUMS the only way
     * to spend the commit output is the script path, which reveals the
     * envelope by construction.
     */
    private static final byte[] NUMS = Hex.decode("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");

    public static byte[] numsInternalKey() {
        return NUMS.clone();
    }

    /** {@code bcrt} on regtest, {@code bc} on mainnet — recorded in the bundle, not interpreted. */
    public static String protocolTagFor(String network) {
        return network.equals("mainnet") ? "bc" : "bcrt";
    }

    public static List<byte[]> chunk(byte[] body) {
        List<byte[]> out = new ArrayList<>();
        if (body.length == 0) {
            out.add(new byte[0]);
            return out;
        }
        for (int o = 0; o < body.length; o += MAX_PUSH) {
            out.add(Arrays.copyOfRange(body, o, Math.min(o + MAX_PUSH, body.length)));
        }
        return out;
    }

    /** The {@code OP_FALSE OP_IF … OP_ENDIF} block on its own. */
    public static byte[] envelopeScript(String tag, String contentType, byte[] body) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(body.length + body.length / MAX_PUSH * 3 + 64);
        out.write(OP_FALSE);
        out.write(OP_IF);
        out.writeBytes(Taproot.pushData(tag.getBytes(StandardCharsets.UTF_8)));
        out.writeBytes(Taproot.pushData(contentType.getBytes(StandardCharsets.UTF_8)));
        for (byte[] c : chunk(body)) {
            out.writeBytes(Taproot.pushData(c));
        }
        out.write(OP_ENDIF);
        return out.toByteArray();
    }

    /** The complete tapscript leaf: the signature check, then the envelope. */
    public static byte[] leafScript(byte[] xOnlyPubkey, String tag, String contentType, byte[] body) {
        if (xOnlyPubkey.length != 32) {
            throw new IllegalArgumentException("leaf pubkey must be x-only (32 bytes)");
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(body.length + 128);
        out.writeBytes(Taproot.pushData(xOnlyPubkey));
        out.write(OP_CHECKSIG);
        out.writeBytes(envelopeScript(tag, contentType, body));
        return out.toByteArray();
    }

    /** SHA-256 of the body — the record's {@code leaf_bytes}, and what binds link A. */
    public final String leafHex;
    public final byte[] leafScript;
    public final Taproot.Output taproot;
    public final String contentType;
    public final String protocolTag;
    public final int bodyLength;

    private Inscription(String leafHex, byte[] leafScript, Taproot.Output taproot, String contentType, String protocolTag, int bodyLength) {
        this.leafHex = leafHex;
        this.leafScript = leafScript;
        this.taproot = taproot;
        this.contentType = contentType;
        this.protocolTag = protocolTag;
        this.bodyLength = bodyLength;
    }

    /**
     * Everything the commit and the reveal need, derived from the document.
     *
     * <p>Two different keys, and the distinction is load-bearing:
     * {@code xOnlyPubkey} goes into the tapscript's {@code OP_CHECKSIG} and
     * signs the reveal, while the taproot internal key is always the NUMS
     * point, so the commit output has no key path at all.
     *
     * @param maxBodyBytes this deployment's limit, or {@code null} for the default; clamped to the hard ceiling
     * @throws IllegalArgumentException in the words a caller is answered with: nothing to inscribe, no content type, too large
     */
    public static Inscription build(byte[] xOnlyPubkey, byte[] body, String contentType, String protocolTag, Long maxBodyBytes) {
        if (body.length == 0) {
            throw new IllegalArgumentException("nothing to inscribe: the document is empty");
        }
        if (contentType == null || contentType.isEmpty()) {
            throw new IllegalArgumentException("content_type is mandatory and must be a single push");
        }
        // Measured in bytes, as the script holds them. A push of more than 520 bytes makes the
        // whole script invalid on the chain — and the node only says so when the reveal is sent,
        // after the commit has been paid for and with its key about to be dropped.
        if (contentType.getBytes(StandardCharsets.UTF_8).length > MAX_PUSH || protocolTag.getBytes(StandardCharsets.UTF_8).length > MAX_PUSH) {
            throw new IllegalArgumentException("content_type and protocol_tag must each fit in one push");
        }
        long cap = Math.min(maxBodyBytes == null ? CoreConfig.DEFAULT_SOFT_CAP_BYTES : maxBodyBytes, CoreConfig.HARD_CEILING_BYTES);
        if (body.length > cap) {
            throw new IllegalArgumentException("document is " + body.length + " bytes; the inscription limit is " + cap);
        }
        byte[] script = leafScript(xOnlyPubkey, protocolTag, contentType, body);
        // NUMS, never the signing key — see the constant for what that prevents.
        return new Inscription(Hex.encode(Hex.sha256(body)), script, Taproot.singleLeaf(NUMS, script), contentType, protocolTag, body.length);
    }
}
