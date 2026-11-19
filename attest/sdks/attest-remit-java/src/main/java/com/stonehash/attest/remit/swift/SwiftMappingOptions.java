package com.stonehash.attest.remit.swift;

import java.util.Map;

/**
 * What {@link SwiftMapper#map} is given besides the payment. Every option has
 * the reference's default, so {@code new SwiftMappingOptions()} maps a payment
 * the way {@code mapSwiftPayment(payment)} does.
 */
public final class SwiftMappingOptions {
    private Map<String, Object> supplement;
    private String tradeCurrency;
    private boolean inferCountryFromBic = true;
    private boolean allowTestMessages;
    private boolean corridorGiven;
    private String origin;
    private String destination;

    public SwiftMappingOptions() {
    }

    /**
     * What the bank knows beyond the message — typically its customer master,
     * looked up by the debtor's account. A value given here wins over the
     * message's, because a customer record is firmer than a free-text line.
     *
     * <p>The shape is the reference's {@code PartySupplement}:
     * {@code { debtor: { name, country, address, registration_number, account },
     * creditor: { name, country, account, bank }, invoiceRef, purposeCode }},
     * every member optional, every value a string.
     */
    public SwiftMappingOptions supplement(Map<String, Object> supplement) {
        this.supplement = supplement;
        return this;
    }

    /** The currency the corridor denominates trades in. Default (and when null): {@code USD}. */
    public SwiftMappingOptions tradeCurrency(String tradeCurrency) {
        this.tradeCurrency = tradeCurrency;
        return this;
    }

    /** Take a missing party country from its agent's BIC. Default true; always reported. */
    public SwiftMappingOptions inferCountryFromBic(boolean inferCountryFromBic) {
        this.inferCountryFromBic = inferCountryFromBic;
        return this;
    }

    /**
     * Let a message marked as a test through (MT103 field 23B {@code CRTS}, a
     * test and training BIC in the header, a pilot service). Set it for a test
     * key and for nothing else: such a message must not be executed as a
     * payment. Default false.
     */
    public SwiftMappingOptions allowTestMessages(boolean allowTestMessages) {
        this.allowTestMessages = allowTestMessages;
        return this;
    }

    /**
     * The route the instruction will be quoted on. A payment whose ordering
     * customer is not in {@code origin}, or whose beneficiary or beneficiary's
     * bank is not in {@code destination}, is not a payment of this corridor and
     * is refused. Default: VN → SG, the sandbox corridor.
     */
    public SwiftMappingOptions corridor(String origin, String destination) {
        this.corridorGiven = true;
        this.origin = origin;
        this.destination = destination;
        return this;
    }

    /** The supplement as given, or null. */
    public Map<String, Object> supplement() {
        return supplement;
    }

    /** The trade currency as given, or null for the default ({@code USD}). */
    public String tradeCurrency() {
        return tradeCurrency;
    }

    public boolean inferCountryFromBic() {
        return inferCountryFromBic;
    }

    public boolean allowTestMessages() {
        return allowTestMessages;
    }

    /** True once {@link #corridor(String, String)} was called; until then the corridor is VN → SG. */
    public boolean corridorGiven() {
        return corridorGiven;
    }

    /** The corridor's origin: as given, or {@code VN}. */
    public String corridorOrigin() {
        return corridorGiven ? origin : "VN";
    }

    /** The corridor's destination: as given, or {@code SG}. */
    public String corridorDestination() {
        return corridorGiven ? destination : "SG";
    }
}
