package com.stonehash.attest.core.anchor;

import com.stonehash.attest.core.config.CoreConfig;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Is the Bitcoin node there, and on the chain this process expects?
 *
 * <p>Reported, not enforced: an unreachable node must not stop the API from
 * accepting attestations — they queue as {@code accepted} until the chain
 * returns. One JSON-RPC call, {@code getblockchaininfo}; it reads and
 * changes nothing, and names no wallet.
 */
@Component
public class BitcoindHealth {
    private final CoreConfig cfg;
    private final BitcoindRpc rpc;

    public BitcoindHealth(CoreConfig cfg, BitcoindRpc rpc) {
        this.cfg = cfg;
        this.rpc = rpc;
    }

    /** {@code ok} and a {@code detail} sentence. */
    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            Object info = rpc.call("getblockchaininfo", Collections.emptyList());
            Object chain = info instanceof Map ? ((Map<?, ?>) info).get("chain") : null;
            Object blocks = info instanceof Map ? ((Map<?, ?>) info).get("blocks") : null;
            String expected = cfg.bitcoinNetwork.equals("mainnet") ? "main" : "regtest";
            if (!expected.equals(chain)) {
                out.put("ok", false);
                out.put("detail", "bitcoind is on \"" + BitcoindRpc.text(chain) + "\" but this process expects \"" + expected + "\"");
                return out;
            }
            out.put("ok", true);
            out.put("detail", "chain " + BitcoindRpc.text(chain) + " at height " + BitcoindRpc.text(blocks));
        } catch (BitcoindRpc.RpcError | BitcoindRpc.RpcUnavailable e) {
            out.put("ok", false);
            out.put("detail", e.getMessage());
        }
        return out;
    }
}
