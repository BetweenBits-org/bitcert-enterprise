package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What a settlement instruction is built from, once a message maps without an
 * issue: the trade amount, the two companies, the commercial reference, and
 * the reference to the bank's message that is signed into the instruction.
 */
public final class SwiftInstructionInput {
    private final String tradeAmount;
    private final String tradeCurrency;
    private final Map<String, Object> parties;
    private final String invoiceRef;
    private final String purposeCode;
    private final String instructionRef;
    private final Map<String, Object> source;
    private final List<String> messageFields;

    @SuppressWarnings("unchecked")
    SwiftInstructionInput(String tradeAmount, String tradeCurrency, Map<String, Object> parties, String invoiceRef,
            String purposeCode, String instructionRef, Map<String, Object> source, List<String> messageFields) {
        this.tradeAmount = tradeAmount;
        this.tradeCurrency = tradeCurrency;
        this.parties = (Map<String, Object>) Json.freeze(parties);
        this.invoiceRef = invoiceRef;
        this.purposeCode = purposeCode;
        this.instructionRef = instructionRef;
        this.source = (Map<String, Object>) Json.freeze(source);
        this.messageFields = Collections.unmodifiableList(new ArrayList<>(messageFields));
    }

    /** The amount of the trade, as the message states it ({@code 12500.00}). */
    public String tradeAmount() {
        return tradeAmount;
    }

    public String tradeCurrency() {
        return tradeCurrency;
    }

    /**
     * The two companies, in the shape the instruction takes them:
     * {@code { debtor: { name, country, address, registration_number, account? },
     * creditor: { name, country, account, bank } }}, in that order.
     */
    public Map<String, Object> parties() {
        return parties;
    }

    public String invoiceRef() {
        return invoiceRef;
    }

    /** The purpose code, or null when neither the message nor the supplement gives one. */
    public String purposeCode() {
        return purposeCode;
    }

    /** The bank's own reference for the instruction, or null when the message has none. */
    public String instructionRef() {
        return instructionRef;
    }

    /**
     * The reference to the bank's message, as it is signed into the
     * instruction: {@code type}, {@code sha256}, {@code content}, then — when
     * stated — {@code valueDate}, {@code index}, {@code paymentInfoId},
     * {@code messageId}, {@code instructionId}, {@code endToEndId},
     * {@code uetr}. A value that is not there is left out.
     */
    public Map<String, Object> source() {
        return source;
    }

    /** Element names / field tags present in the message. */
    public List<String> messageFields() {
        return messageFields;
    }

    /** The input as the reference's JSON has it, keys in its order. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tradeAmount", tradeAmount);
        out.put("tradeCurrency", tradeCurrency);
        out.put("parties", copy(parties));
        out.put("invoiceRef", invoiceRef);
        JsonOut.put(out, "purposeCode", purposeCode);
        JsonOut.put(out, "instructionRef", instructionRef);
        out.put("source", copy(source));
        out.put("messageFields", new ArrayList<Object>(messageFields));
        return out;
    }

    /** A copy that can be changed without changing this input. */
    private static Object copy(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                out.put((String) e.getKey(), copy(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : (List<?>) v) {
                out.add(copy(item));
            }
            return out;
        }
        return v;
    }
}
