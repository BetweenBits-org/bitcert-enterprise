package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.SwiftPayment;
import java.util.function.Function;

/**
 * How a SWIFT message is turned into an instruction, beyond what the message
 * itself says. None of it is required: a message that states everything the
 * corridor needs goes through with {@code new SwiftOptions()}.
 */
public final class SwiftOptions {
    Integer index;
    Function<SwiftPayment, PartySupplement> supplement;
    Boolean inferCountryFromBic;
    String paymentId;
    String beneficiaryInstitution;
    InstructionOptions.Review review;
    InstructionOptions.TravelRule travelRule;

    /** Which transaction, counted from zero, when the message carries several. */
    public SwiftOptions index(int index) {
        this.index = index;
        return this;
    }

    /** What your bank knows beyond the message, as one value for this call. */
    public SwiftOptions supplement(PartySupplement supplement) {
        this.supplement = supplement == null ? null : (payment) -> supplement;
        return this;
    }

    /**
     * What your bank knows beyond the message, looked up for the payment that
     * was read — typically the customer master, by the debtor's account.
     * Return {@code null} when the records hold nothing for it.
     */
    public SwiftOptions supplement(Function<SwiftPayment, PartySupplement> lookup) {
        this.supplement = lookup;
        return this;
    }

    /** Take a party's missing country from its agent's BIC. Default true; whenever it is done, the mapping says so. */
    public SwiftOptions inferCountryFromBic(boolean infer) {
        this.inferCountryFromBic = infer;
        return this;
    }

    /**
     * A payment id of your choosing, instead of the one derived from the
     * message's own references. It is a name and nothing more: a message that
     * already has a settlement is answered with that settlement
     * ({@link SwiftSubmission#already()}) whatever id is passed here — an id
     * of your own does not make a second payment out of one message.
     */
    public SwiftOptions paymentId(String paymentId) {
        this.paymentId = paymentId;
        return this;
    }

    /** The institution that pays out to the creditor. Default: the sandbox's {@code SG-BFI-001}. */
    public SwiftOptions beneficiaryInstitution(String institutionId) {
        this.beneficiaryInstitution = institutionId;
        return this;
    }

    /** What your bank's own review concluded; signed with your key. See {@link InstructionOptions.Review}. */
    public SwiftOptions review(InstructionOptions.Review review) {
        this.review = review;
        return this;
    }

    /** Travel Rule mode. Default {@link InstructionOptions.TravelRule#A}. */
    public SwiftOptions travelRule(InstructionOptions.TravelRule mode) {
        this.travelRule = mode;
        return this;
    }
}
