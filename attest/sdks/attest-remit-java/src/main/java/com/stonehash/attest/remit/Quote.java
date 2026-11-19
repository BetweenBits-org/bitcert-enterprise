package com.stonehash.attest.remit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * A quote for one trade payment: what is collected, what is settled, what is
 * paid out, at which rates, and until when. The bank signs on what the quote
 * says, so {@link RemitClient#quote} checks it against what was asked for
 * before returning it.
 */
public final class Quote {
    private final Map<String, Object> json;

    Quote(Map<String, Object> json) {
        this.json = Collections.unmodifiableMap(json);
    }

    /** The platform's answer, whole. */
    public Map<String, Object> json() {
        return json;
    }

    public String quoteId() {
        return (String) json.get("quote_id");
    }

    /** The trade amount, as decimal text, e.g. {@code 10000.00}. */
    public String tradeAmount() {
        return text("trade", "amount");
    }

    public String tradeCurrency() {
        return text("trade", "currency");
    }

    /** What is collected from the debtor, in {@link #collectCurrency()}. */
    public String collectAmount() {
        return text("collect", "amount");
    }

    public String collectCurrency() {
        return text("collect", "currency");
    }

    /** What the creditor is paid, in {@link #payoutCurrency()}. */
    public String payoutAmount() {
        return text("payout", "amount");
    }

    public String payoutCurrency() {
        return text("payout", "currency");
    }

    /** The settlement leg's amount, in {@link #settlementAsset()}. */
    public String settlementAmount() {
        return text("settlement", "amount");
    }

    public String settlementAsset() {
        return text("settlement", "asset");
    }

    public String quotedAt() {
        return (String) json.get("quoted_at");
    }

    public String expiresAt() {
        return (String) json.get("expires_at");
    }

    Map<String, Object> part(String name) {
        Object v = json.get(name);
        return v instanceof Map ? Json.object(v, "not_a_platform_answer", name) : Collections.emptyMap();
    }

    String text(String part, String field) {
        Object v = part(part).get(field);
        return v instanceof String ? (String) v : null;
    }

    /**
     * The party fields the beneficiary institution requires before it accepts
     * the payment, as the platform names them: {@code originator.name},
     * {@code beneficiary.account}, …
     */
    public List<String> requiredTravelRuleFields() {
        List<String> out = new ArrayList<>();
        Object v = json.get("required_travel_rule_fields");
        if (v instanceof List) {
            for (Object field : (List<?>) v) {
                if (field instanceof String) {
                    out.add((String) field);
                }
            }
        }
        return Collections.unmodifiableList(out);
    }

    int requiredTravelRuleFieldCount() {
        Object v = json.get("required_travel_rule_fields");
        return v instanceof List ? ((List<?>) v).size() : 0;
    }
}
