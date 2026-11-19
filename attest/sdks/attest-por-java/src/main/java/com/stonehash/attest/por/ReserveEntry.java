package com.stonehash.attest.por;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One reserve address an exchange declares in its statement. The statement
 * names addresses and never balances: whoever verifies measures those on
 * chain, which is the half of proof of reserves a signature cannot fake.
 */
public final class ReserveEntry {
    private final String chain;
    private final String asset;
    private final String address;
    private final String tokenContract;

    /** An address holding a chain's native asset. */
    public ReserveEntry(String chain, String asset, String address) {
        this(chain, asset, address, null);
    }

    /**
     * @param chain         the chain identifier, for example {@code eip155:1}
     * @param tokenContract the token's contract for a token balance; null for a native asset
     * @throws PorException {@code invalid_reserve} when chain, asset or address is empty
     */
    public ReserveEntry(String chain, String asset, String address, String tokenContract) {
        if (isEmpty(chain) || isEmpty(asset) || isEmpty(address)) {
            throw new PorException("invalid_reserve", "a reserve entry needs a chain, an asset and an address");
        }
        this.chain = chain;
        this.asset = asset;
        this.address = address;
        this.tokenContract = tokenContract;
    }

    Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chain", chain);
        out.put("asset", asset);
        out.put("address", address);
        if (tokenContract != null) {
            out.put("token_contract", tokenContract);
        }
        return out;
    }

    private static boolean isEmpty(String s) {
        return s == null || s.isEmpty();
    }
}
