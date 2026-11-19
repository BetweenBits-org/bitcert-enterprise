package com.stonehash.attest.por;

/**
 * How amounts are written where they come from. Always stated by the caller,
 * never inferred: {@code 1} is one bitcoin or one satoshi depending on a fact
 * only the exchange knows, and a wrong guess is a liability total off by a
 * factor of a hundred million that still looks like a number.
 */
public enum AmountUnit {
    /** {@code 0.5} means half a coin: the unit people read. */
    DECIMAL("decimal"),
    /** {@code 50000000} means that many smallest units (satoshi, wei). */
    BASE("base");

    private final String wireName;

    AmountUnit(String wireName) {
        this.wireName = wireName;
    }

    /** {@code "decimal"} or {@code "base"}, as command lines and the specification spell it. */
    public String wireName() {
        return wireName;
    }

    /** The unit named {@code decimal} or {@code base}; anything else is refused rather than defaulted. */
    public static AmountUnit parse(String name) {
        for (AmountUnit u : values()) {
            if (u.wireName.equals(name)) {
                return u;
            }
        }
        throw new PorException("invalid_unit",
                "the amount unit is \"decimal\" (0.5 means half a coin) or \"base\" (whole numbers of the smallest unit)");
    }
}
