package com.stonehash.attest.por;

/** The two shapes a balance export comes in. */
public enum CsvLayout {
    /** One row per account and asset: {@code account_id,asset,balance}. */
    LONG("long"),
    /** One row per account, a column per asset: {@code account_id,BTC,ETH,USDT}. */
    WIDE("wide");

    private final String wireName;

    CsvLayout(String wireName) {
        this.wireName = wireName;
    }

    /** {@code "long"} or {@code "wide"}. */
    public String wireName() {
        return wireName;
    }

    public static CsvLayout parse(String name) {
        for (CsvLayout l : values()) {
            if (l.wireName.equals(name)) {
                return l;
            }
        }
        throw new PorException("invalid_layout", "the layout is \"long\" or \"wide\"");
    }
}
