package com.stonehash.attest.core.anchor;

import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.Hex;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Anchor backend backed by a bitcoind wallet. Serves {@code regtest} today
 * and {@code mainnet} unchanged — the only difference is which node the URL
 * points at.
 *
 * <h2>Why bitcoind funds and signs, not us</h2>
 *
 * The flow is {@code createrawtransaction} → {@code fundrawtransaction} →
 * {@code signrawtransactionwithwallet} → {@code sendrawtransaction}. bitcoind
 * picks the inputs, computes the fee, adds change and signs. So no private
 * key ever enters this process — a compromise of the API cannot move coins —
 * and there is no fee estimator, coin selector or signer here to get subtly
 * wrong. We contribute exactly one thing: the {@code OP_RETURN} output
 * carrying the commitment.
 */
@Component
public class BitcoindAnchorBackend implements AnchorBackend {
    private final BitcoindRpc rpc;
    private final String network;
    private final String wallet;

    public BitcoindAnchorBackend(BitcoindRpc rpc, CoreConfig cfg) {
        this.rpc = rpc;
        this.network = cfg.bitcoinNetwork;
        this.wallet = cfg.bitcoind.wallet;
    }

    @Override
    public String network() {
        return network;
    }

    @Override
    public String name() {
        return "bitcoind:" + network;
    }

    private static Map<String, Object> map(String key, Object value) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(key, value);
        return out;
    }

    private static Object field(Object o, String key) {
        return o instanceof Map ? ((Map<?, ?>) o).get(key) : null;
    }

    @Override
    public Prepared prepare(byte[] payload) throws Exception {
        String script = Hex.encode(Tx.opReturnScript(payload));
        // `data` is bitcoind's own OP_RETURN shorthand: it builds `OP_RETURN <push>` from the
        // hex, byte for byte what our encoder builds. We keep our own encoder because the
        // bundle needs the exact bytes, and the check below holds the two together.
        Object unfunded = rpc.call("createrawtransaction", Arrays.asList(Collections.emptyList(), Collections.singletonList(map("data", Hex.encode(payload)))));
        Object funded = rpc.call("fundrawtransaction", Arrays.asList(unfunded, map("fee_rate", 1L)), wallet);
        Object signed = rpc.call("signrawtransactionwithwallet", Collections.singletonList(field(funded, "hex")), wallet);
        if (!Boolean.TRUE.equals(field(signed, "complete"))) {
            List<String> why = new ArrayList<>();
            if (field(signed, "errors") instanceof List) {
                for (Object e : (List<?>) field(signed, "errors")) {
                    why.add(BitcoindRpc.text(field(e, "error")));
                }
            }
            throw new IllegalStateException("bitcoind could not fully sign the anchor transaction: " + (why.isEmpty() ? "unknown" : String.join("; ", why)));
        }
        String hex = (String) field(signed, "hex");
        // Before anything is sent: bitcoind framed the OP_RETURN exactly as our own encoder
        // would. If the two ever disagreed, the bundle would advertise one payload while the
        // chain carried another, and the mismatch would surface in a customer's verifier.
        if (!hex.contains(script)) {
            throw new IllegalStateException("bitcoind framed the anchor output differently than expected; refusing to broadcast. "
                    + "expected script " + script + " to appear in the signed transaction");
        }
        // The name the transaction will have, asked of the node that signed it — known before it is sent.
        Object decoded = rpc.call("decoderawtransaction", Collections.singletonList(hex));
        return new Prepared((String) field(decoded, "txid"), hex, Hex.encode(payload));
    }

    @Override
    public void send(Prepared prepared) throws Exception {
        Object txid = rpc.call("sendrawtransaction", Collections.singletonList(prepared.rawTxHex), wallet);
        if (!prepared.txid.equals(txid)) {
            throw new IllegalStateException("bitcoind names the transaction " + txid + ", not " + prepared.txid + " as it said before it was sent");
        }
    }

    /** {@code -5}: the wallet does not know this transaction. */
    private static final long NOT_IN_WALLET = -5;
    /** {@code -25}: what the transaction spends is missing or spent. */
    private static final long MISSING_INPUTS = -25;
    /** {@code -26}: the mempool refused it; the reason says why. */
    private static final long REJECTED = -26;
    /** {@code -27}: its outputs are in the chain already. */
    private static final long ALREADY_IN_CHAIN = -27;

    @Override
    public Fate resend(String txid, String rawTxHex) throws Exception {
        // Does the wallet know it? Then it was sent — or was displaced by another spend of the same coins.
        try {
            Object known = rpc.call("gettransaction", Collections.singletonList(txid), wallet);
            Object confirmations = field(known, "confirmations");
            return confirmations instanceof Double && (Double) confirmations < 0 ? Fate.DEAD : Fate.SENT;
        } catch (BitcoindRpc.RpcError e) {
            if (e.code != NOT_IN_WALLET) {
                throw e;
            }
        }
        // It does not: the same bytes are sent, and the node says what they are worth now.
        try {
            rpc.call("sendrawtransaction", Collections.singletonList(rawTxHex), wallet);
            return Fate.SENT;
        } catch (BitcoindRpc.RpcError e) {
            if (e.code == ALREADY_IN_CHAIN) {
                return Fate.SENT;
            }
            String reason = e.reason.toLowerCase(java.util.Locale.ROOT);
            if (e.code == MISSING_INPUTS || (e.code == REJECTED && (reason.contains("conflict") || reason.contains("missingorspent") || reason.contains("replacement")))) {
                return Fate.DEAD;
            }
            throw e;
        }
    }

    @Override
    public State poll(String txid) throws Exception {
        Object tx = rpc.call("gettransaction", Arrays.asList(txid, true, true), wallet);
        Object confirmations = field(tx, "confirmations");
        long n = confirmations instanceof Double ? ((Double) confirmations).longValue() : 0;
        if (n <= 0) {
            return new State(false, null, null, 0);
        }
        Object hash = field(tx, "blockhash");
        Object height = field(tx, "blockheight");
        return new State(true, height instanceof Double ? Long.valueOf(((Double) height).longValue()) : null,
                hash instanceof String && !((String) hash).isEmpty() ? (String) hash : null, n);
    }

    /** {@code -5}, from the mempool's side: it holds no such transaction. */
    private static final long NOT_IN_MEMPOOL = -5;

    @Override
    public boolean waiting(String txid) throws Exception {
        try {
            rpc.call("getmempoolentry", Collections.singletonList(txid));
            return true;
        } catch (BitcoindRpc.RpcError e) {
            if (e.code == NOT_IN_MEMPOOL) {
                return false;
            }
            throw e;
        }
    }

    @Override
    public void generate(int n) throws Exception {
        if (!network.equals("regtest")) {
            throw new IllegalStateException("block generation is regtest-only");
        }
        Object address = rpc.call("getnewaddress", Collections.emptyList(), wallet);
        rpc.call("generatetoaddress", Arrays.asList((long) n, address), wallet);
    }
}
