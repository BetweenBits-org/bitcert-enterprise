package com.stonehash.attest.core.anchor;

import com.stonehash.attest.core.btc.Inscription;
import com.stonehash.attest.core.btc.Secp256k1;
import com.stonehash.attest.core.btc.Taproot;
import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.log.Log;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Commit and reveal — putting the document itself on the chain.
 *
 * <p>Two transactions, because taproot only discloses a script when it is
 * spent:
 * <ul>
 * <li><b>commit</b> pays a funded output to a P2TR key that secretly commits
 *     to a tapscript leaf containing the document. Nothing is revealed.
 * <li><b>reveal</b> spends that output by the script path, which forces the
 *     whole leaf — document included — into the witness, where it stays on
 *     the chain for ever.
 * </ul>
 *
 * The node funds and signs the commit, exactly as it does for a hash anchor,
 * so no wallet key is handled here. The reveal is different: it spends a
 * tapscript the node's descriptor language cannot express, so the signature
 * is made in this process with a key drawn for this one inscription. That
 * key controls one small output and is dropped when this method returns. It
 * is not the taproot internal key — that is always the NUMS point, so the
 * commit output has no key path and the only way to spend it is the one that
 * publishes the document.
 *
 * <h2>What the OP_RETURN carries, and why it is not a Merkle root</h2>
 *
 * An inscription is per-document and immediate — there is no batch, so there
 * is no tree. The anchor output carries the 32-byte {@code leaf_bytes}
 * directly: a verifier checks {@code anchor payload == leaf_bytes} and skips
 * the inclusion proof that does not exist. Both copies of the commitment
 * ride in the same transaction: the digest in an output the txid covers, and
 * the bytes in a witness it does not. The verifier ties them together.
 *
 * <p>Nothing is written down before it is broadcast here, on purpose: the
 * reveal transaction holds the document, and this service keeps no document
 * that is not already public. A refusal is answered in the sentence the
 * service has always given for it ({@link PlainError}); the node's own
 * refusals are passed on as {@code bitcoind rpc <code>: <reason>}.
 */
@Component
public class Inscriber {
    /** Value left in the reveal's own output. Comfortably over the P2TR dust floor. */
    static final long REVEAL_OUTPUT_SATS = 1000;
    /** regtest and a quiet mempool; the same knob as the hash anchor's {@code fee_rate}. */
    static final long FEE_RATE_SAT_VB = 2;

    private static final SecureRandom RANDOM = new SecureRandom();

    /** Where an inscription landed. */
    public static final class Result {
        public final String commitTxid;
        public final String revealTxid;
        /** The full reveal transaction, witness included — what the bundle carries. */
        public final String revealTxHex;
        /** SHA-256 of the inscribed body: the digest in the anchor output. */
        public final String leafHex;
        public final String contentType;
        public final String protocolTag;
        public final long bodyLength;
        public final long feePaidSats;

        Result(String commitTxid, String revealTxid, String revealTxHex, String leafHex, String contentType, String protocolTag,
                long bodyLength, long feePaidSats) {
            this.commitTxid = commitTxid;
            this.revealTxid = revealTxid;
            this.revealTxHex = revealTxHex;
            this.leafHex = leafHex;
            this.contentType = contentType;
            this.protocolTag = protocolTag;
            this.bodyLength = bodyLength;
            this.feePaidSats = feePaidSats;
        }
    }

    private final BitcoindRpc rpc;
    private final CoreConfig cfg;

    public Inscriber(BitcoindRpc rpc, CoreConfig cfg) {
        this.rpc = rpc;
        this.cfg = cfg;
    }

    private static Object field(Object o, String key) {
        return o instanceof Map ? ((Map<?, ?>) o).get(key) : null;
    }

    /**
     * The reveal's outputs. The anchor comes first — the digest, in an output
     * the txid covers — and then the small output that returns to the wallet.
     */
    public static List<Tx.Output> revealOutputs(Inscription ins, byte[] returnScript) {
        return Arrays.asList(new Tx.Output(0, Tx.opReturnScript(Hex.decode(ins.leafHex))), new Tx.Output(REVEAL_OUTPUT_SATS, returnScript));
    }

    /** The reveal's one input: the commit output, replaceable. */
    private static List<Tx.Input> revealInputs(String commitTxid, long commitVout) {
        return Collections.singletonList(new Tx.Input(commitTxid, commitVout, new byte[0], 0xfffffffdL));
    }

    /**
     * Weight-accurate size, so the commit funds the reveal exactly once.
     * Guessing high wastes a customer's money on mainnet; guessing low gets
     * the reveal refused after the commit has confirmed — leaving funds in
     * an output only this process could ever spend, with the key already
     * dropped. So the reveal is serialised twice: once to measure, once for
     * real. Measured against a placeholder input and signature; only their
     * size matters.
     */
    public static long revealVsize(Inscription ins, List<Tx.Output> outputs) {
        List<Tx.Input> inputs = revealInputs("00".repeat(32), 0);
        long base = Tx.serializeLegacy(inputs, outputs).length;
        long total = Taproot.serializeWitness(inputs, outputs,
                Collections.singletonList(Arrays.asList(new byte[64], ins.leafScript, ins.taproot.controlBlock))).length;
        long weight = base * 3 + total;
        return (weight + 3) / 4;
    }

    /** What the commit output must hold: the reveal's own output, and the reveal's fee. */
    public static long commitValue(long revealVsize) {
        return REVEAL_OUTPUT_SATS + revealVsize * FEE_RATE_SAT_VB;
    }

    /**
     * The reveal, signed: it spends the commit output by the script path,
     * with the witness {@code [signature, leaf script, control block]}.
     *
     * @param secret the leaf key — the one inside the tapscript's {@code OP_CHECKSIG}, not the tweaked output key
     * @param aux the signature's auxiliary randomness; fresh for a real inscription
     */
    public static byte[] signedReveal(Inscription ins, byte[] secret, byte[] aux, String commitTxid, long commitVout, long commitValue,
            List<Tx.Output> outputs) {
        List<Tx.Input> inputs = revealInputs(commitTxid, commitVout);
        // The sighash covers the amount and the script of what is spent — the commit output, exactly as it was funded.
        List<Taproot.Prevout> prevouts = Collections.singletonList(new Taproot.Prevout(commitValue, ins.taproot.scriptPubKey));
        byte[] sighash = Taproot.tapSighash(inputs, outputs, prevouts, 0, ins.taproot.tapleaf);
        byte[] signature = Secp256k1.schnorrSign(sighash, secret, aux);
        return Taproot.serializeWitness(inputs, outputs, Collections.singletonList(Arrays.asList(signature, ins.leafScript, ins.taproot.controlBlock)));
    }

    /** The txid the reveal will have: over the form without the witness. */
    public static String revealTxid(String commitTxid, long commitVout, List<Tx.Output> outputs) {
        return Tx.txidOf(Tx.serializeLegacy(revealInputs(commitTxid, commitVout), outputs));
    }

    /**
     * Inscribe a document.
     *
     * @throws PlainError for every refusal — the document's size or content type, the node's answer
     */
    public Result inscribe(byte[] body, String contentType) {
        try {
            return commitAndReveal(body, contentType);
        } catch (BitcoindRpc.RpcError | BitcoindRpc.RpcUnavailable e) {
            throw new PlainError(e.getMessage());
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw new PlainError(e.getMessage());
        }
    }

    private Result commitAndReveal(byte[] body, String contentType) throws BitcoindRpc.RpcError, BitcoindRpc.RpcUnavailable {
        String wallet = cfg.bitcoind.wallet;
        byte[] secret = Taproot.ephemeralSecret(() -> {
            byte[] b = new byte[32];
            RANDOM.nextBytes(b);
            return b;
        });
        byte[] pubkey = Secp256k1.xOnlyPubkey(secret);
        // Checked before any coin is committed: an empty or oversized document, a content type that is not one push.
        Inscription ins = Inscription.build(pubkey, body, contentType, Inscription.protocolTagFor(cfg.bitcoinNetwork), cfg.inscriptionMaxBytes);

        // Where the reveal's change goes. Asking the node for the script rather than encoding
        // bech32m here means we cannot disagree with it about the address.
        Object address = rpc.call("getnewaddress", Arrays.asList("inscription", "bech32m"), wallet);
        Object info = rpc.call("getaddressinfo", Collections.singletonList(address), wallet);
        List<Tx.Output> outputs = revealOutputs(ins, Hex.decode((String) field(info, "scriptPubKey")));
        long revealFee = revealVsize(ins, outputs) * FEE_RATE_SAT_VB;
        long commitValue = REVEAL_OUTPUT_SATS + revealFee;

        // ── commit ───────────────────────────────────────────────────────────
        // Serialised here with no inputs: `createrawtransaction` only speaks addresses, and
        // the P2TR script is derived from a key the node has never seen. `fundrawtransaction`
        // takes the raw form.
        String skeleton = Hex.encode(Tx.serializeLegacy(Collections.emptyList(),
                Collections.singletonList(new Tx.Output(commitValue, ins.taproot.scriptPubKey))));
        Map<String, Object> options = new LinkedHashMap<>();
        options.put("fee_rate", FEE_RATE_SAT_VB);
        Object funded = rpc.call("fundrawtransaction", Arrays.asList(skeleton, options), wallet);
        Object signedCommit = rpc.call("signrawtransactionwithwallet", Collections.singletonList(field(funded, "hex")), wallet);
        if (!Boolean.TRUE.equals(field(signedCommit, "complete"))) {
            List<String> why = new ArrayList<>();
            if (field(signedCommit, "errors") instanceof List) {
                for (Object e : (List<?>) field(signedCommit, "errors")) {
                    why.add(BitcoindRpc.text(field(e, "error")));
                }
            }
            throw new IllegalStateException("bitcoind could not sign the commit transaction: " + (why.isEmpty() ? "unknown" : String.join("; ", why)));
        }
        String commitHex = (String) field(signedCommit, "hex");

        // Funding inserts change at an arbitrary position, so the inscription output is found
        // by its script, never by assuming index 0.
        Object decoded = rpc.call("decoderawtransaction", Collections.singletonList(commitHex));
        String want = Hex.encode(ins.taproot.scriptPubKey);
        Long mine = null;
        if (field(decoded, "vout") instanceof List) {
            for (Object v : (List<?>) field(decoded, "vout")) {
                if (want.equals(field(field(v, "scriptPubKey"), "hex")) && field(v, "n") instanceof Double) {
                    mine = ((Double) field(v, "n")).longValue();
                    break;
                }
            }
        }
        if (mine == null) {
            throw new IllegalStateException("the funded commit transaction no longer carries the inscription output");
        }
        String commitTxid = (String) rpc.call("sendrawtransaction", Collections.singletonList(commitHex), wallet);

        // ── reveal ───────────────────────────────────────────────────────────
        byte[] aux = new byte[32];
        RANDOM.nextBytes(aux);
        String revealHex = Hex.encode(signedReveal(ins, secret, aux, commitTxid, mine, commitValue, outputs));
        // The key has done the one thing it was drawn for.
        Arrays.fill(secret, (byte) 0);
        String revealTxid;
        try {
            revealTxid = (String) rpc.call("sendrawtransaction", Collections.singletonList(revealHex), wallet);
        } catch (BitcoindRpc.RpcError | BitcoindRpc.RpcUnavailable e) {
            // The commit is out and its reveal was refused, or the node did not answer: the one
            // thing here an operator has to know about. What the commit paid cannot be had back.
            Log.line("inscription commit sent, reveal failed", Log.fields("commitTxid", commitTxid, "leaf", ins.leafHex, "error", e.getMessage()));
            throw e;
        }
        // Said before anything is stored: from here on the chain holds an inscription, whatever becomes of this process.
        Log.line("inscription broadcast", Log.fields("commitTxid", commitTxid, "revealTxid", revealTxid, "leaf", ins.leafHex, "bytes", ins.bodyLength));

        // The node's txid and ours must agree; if they ever did not, the bundle would point at
        // a transaction nobody can look up.
        String computed = revealTxid(commitTxid, mine, outputs);
        if (!computed.equals(revealTxid)) {
            throw new IllegalStateException("txid disagreement: node says " + revealTxid + ", we computed " + computed);
        }
        Object fee = field(funded, "fee");
        long commitFee = fee instanceof Double ? Math.round((Double) fee * 1e8) : 0;
        return new Result(commitTxid, revealTxid, revealHex, ins.leafHex, ins.contentType, ins.protocolTag, ins.bodyLength, revealFee + commitFee);
    }
}
