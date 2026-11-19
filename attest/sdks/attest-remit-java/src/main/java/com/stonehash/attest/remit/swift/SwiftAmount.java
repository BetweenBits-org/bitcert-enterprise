package com.stonehash.attest.remit.swift;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** An amount as a message states it: an ISO 4217 code and a plain decimal string ({@code 1000.00}). */
public final class SwiftAmount {
    private final String currency;
    private final String value;

    public SwiftAmount(String currency, String value) {
        this.currency = Objects.requireNonNull(currency, "currency");
        this.value = Objects.requireNonNull(value, "value");
    }

    public String currency() {
        return currency;
    }

    /** Decimal string with a full stop and no grouping. */
    public String value() {
        return value;
    }

    /** {@code { currency, value }}, in that order. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("currency", currency);
        out.put("value", value);
        return out;
    }

    static SwiftAmount fromJson(Object json) {
        if (json == null) {
            return null;
        }
        Map<?, ?> m = (Map<?, ?>) json;
        return new SwiftAmount((String) m.get("currency"), (String) m.get("value"));
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof SwiftAmount && ((SwiftAmount) o).currency.equals(currency) && ((SwiftAmount) o).value.equals(value);
    }

    @Override
    public int hashCode() {
        return Objects.hash(currency, value);
    }

    @Override
    public String toString() {
        return value + " " + currency;
    }
}
