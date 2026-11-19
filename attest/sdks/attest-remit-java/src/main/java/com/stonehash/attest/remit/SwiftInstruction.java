package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.SwiftMapping;

/** A signed instruction made from a SWIFT message, with the quote it was signed on and the account of where every value came from. */
public final class SwiftInstruction {
    private final Instruction instruction;
    private final Quote quote;
    private final SwiftMapping mapping;

    SwiftInstruction(Instruction instruction, Quote quote, SwiftMapping mapping) {
        this.instruction = instruction;
        this.quote = quote;
        this.mapping = mapping;
    }

    public String paymentId() {
        return instruction.paymentId();
    }

    /** Signed and ready for {@link RemitClient#submit(Instruction)}. */
    public Instruction instruction() {
        return instruction;
    }

    public Quote quote() {
        return quote;
    }

    /** The full mapping table: where every value came from, and what had no place. */
    public SwiftMapping mapping() {
        return mapping;
    }
}
