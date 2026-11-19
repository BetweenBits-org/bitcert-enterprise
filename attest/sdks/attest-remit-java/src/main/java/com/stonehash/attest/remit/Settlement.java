package com.stonehash.attest.remit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** What the platform holds for one payment: its state, and every signed event so far. */
public final class Settlement {
    private final Map<String, Object> json;

    Settlement(Map<String, Object> json) {
        this.json = Collections.unmodifiableMap(json);
    }

    /** The platform's answer, whole. */
    public Map<String, Object> json() {
        return json;
    }

    public String paymentId() {
        return (String) json.get("payment_id");
    }

    /** The pipeline state, e.g. {@code TRAVEL_RULE_PENDING}, {@code PAYOUT_IN_PROGRESS}, {@code EVIDENCE_ANCHORED}. */
    public String state() {
        return (String) json.get("state");
    }

    /** The evidence level reached, or {@code null} before there is one. */
    public String evidenceLevel() {
        Object v = json.get("evidence_level");
        return v instanceof String ? (String) v : null;
    }

    public boolean evidenceAvailable() {
        return Boolean.TRUE.equals(json.get("evidence_available"));
    }

    /** The settlement leg's chain transaction, or {@code null} before it exists. */
    public String chainTx() {
        Object v = json.get("chain_tx");
        return v instanceof String ? (String) v : null;
    }

    /** The events so far, oldest first; each has {@code seq}, {@code type}, {@code issuer}, {@code at}, {@code payload}, {@code sig}. */
    public List<Map<String, Object>> events() {
        List<Map<String, Object>> out = new ArrayList<>();
        Object events = json.get("events");
        if (events instanceof List) {
            for (Object e : (List<?>) events) {
                if (e instanceof Map) {
                    out.add(Json.object(e, "not_a_platform_answer", "an event"));
                }
            }
        }
        return out;
    }

    /** The types of the events so far, oldest first. */
    public List<String> eventTypes() {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> e : events()) {
            out.add(String.valueOf(e.get("type")));
        }
        return out;
    }

    /**
     * Is a question of the receiving institution waiting for the bank's
     * answer? It is when the last {@code TRAVEL_RULE_RFI} comes after the last
     * event that answers or settles the exchange
     * ({@code TRAVEL_RULE_RFI_RESOLVED}, {@code TRAVEL_RULE_RECEIVED},
     * {@code TRAVEL_RULE_REJECTED}) — not merely when no answer was ever given:
     * a second question, asked after an earlier answer, is as open as the first.
     */
    public boolean travelRuleQuestionOpen() {
        boolean open = false;
        for (String type : eventTypes()) {
            if (type.equals("TRAVEL_RULE_RFI")) {
                open = true;
            } else if (type.equals("TRAVEL_RULE_RFI_RESOLVED") || type.equals("TRAVEL_RULE_RECEIVED") || type.equals("TRAVEL_RULE_REJECTED")) {
                open = false;
            }
        }
        return open;
    }

    /** True once the pipeline has stopped for good: anchored, cancelled, returned or in exception. */
    public boolean isFinal() {
        String s = state();
        return "EVIDENCE_ANCHORED".equals(s) || "CANCELLED".equals(s) || "RETURNED".equals(s) || "EXCEPTION".equals(s);
    }
}
