package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.SwiftMapping;

/** What became of a SWIFT message handed to {@link RemitClient#submitSwift}. */
public final class SwiftSubmission {
    private final String paymentId;
    private final String state;
    private final boolean already;
    private final SwiftMapping mapping;
    private final Quote quote;

    SwiftSubmission(String paymentId, String state, boolean already, SwiftMapping mapping, Quote quote) {
        this.paymentId = paymentId;
        this.state = state;
        this.already = already;
        this.mapping = mapping;
        this.quote = quote;
    }

    public String paymentId() {
        return paymentId;
    }

    /** The settlement's state: on acceptance when it was just sent, the current one when it had been sent before. */
    public String state() {
        return state;
    }

    /** True when this payment had been submitted before: nothing new was sent, and nothing was signed. */
    public boolean already() {
        return already;
    }

    /** The full mapping table: where every value came from, and what had no place. */
    public SwiftMapping mapping() {
        return mapping;
    }

    /** The quote the instruction was signed on, or {@code null} when nothing was sent ({@link #already()}). */
    public Quote quote() {
        return quote;
    }
}
