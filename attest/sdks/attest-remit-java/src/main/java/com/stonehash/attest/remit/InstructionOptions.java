package com.stonehash.attest.remit;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What an instruction says beyond the quote and the parties. Every field has
 * a default that lets a first sandbox payment through; in production each is
 * set from the bank's own systems.
 *
 * <pre>{@code
 * InstructionOptions options = new InstructionOptions()
 *     .invoiceRef("INV-2026-0457")
 *     .instructionRef("OUT-2026-000123")
 *     .review(new InstructionOptions.Review()
 *         .kybPolicyVersion("2026.3").regulatorReportRef("RPT-0457").approvedByRole("Trade Operations"));
 * }</pre>
 */
public final class InstructionOptions {
    /** Travel Rule mode: who shapes and encrypts the party data for the beneficiary institution. */
    public enum TravelRule {
        /** The party fields go to the platform, which encrypts them for the beneficiary institution. The default. */
        A,
        /** This SDK encrypts them here; the platform relays a ciphertext it cannot read. */
        B
    }

    String paymentId;
    String invoiceRef;
    String beneficiaryInstitution;
    String purposeCode;
    String instructionRef;
    Review review = new Review();
    Map<String, Object> source;
    List<String> messageFields;
    TravelRule travelRule = TravelRule.A;

    /** The payment's id. Default: {@code PAY-<yyyymmdd>-<10 hex>}, drawn here. */
    public InstructionOptions paymentId(String paymentId) {
        this.paymentId = paymentId;
        return this;
    }

    /** The invoice the payment settles. Default: a drawn {@code INV-…} reference. */
    public InstructionOptions invoiceRef(String invoiceRef) {
        this.invoiceRef = invoiceRef;
        return this;
    }

    /** The institution that pays out to the creditor. Default: the sandbox's {@code SG-BFI-001}. */
    public InstructionOptions beneficiaryInstitution(String institutionId) {
        this.beneficiaryInstitution = institutionId;
        return this;
    }

    /** Purpose of the payment, your code list or ISO 20022's. Default {@code GOODS_PAYMENT}. */
    public InstructionOptions purposeCode(String purposeCode) {
        this.purposeCode = purposeCode;
        return this;
    }

    /** Your own reference for the instruction. Default {@code INST-<payment id>}. */
    public InstructionOptions instructionRef(String instructionRef) {
        this.instructionRef = instructionRef;
        return this;
    }

    /** What your bank's own review concluded; signed with your key. */
    public InstructionOptions review(Review review) {
        this.review = review == null ? new Review() : review;
        return this;
    }

    /** Reference to the message the instruction was made from; signed into it. Set by the SWIFT path. */
    public InstructionOptions source(Map<String, Object> source) {
        this.source = source == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(source));
        return this;
    }

    /** ISO 20022 element names the instruction's content corresponds to. Set by the SWIFT path. */
    public InstructionOptions messageFields(List<String> fields) {
        this.messageFields = fields == null ? null : Collections.unmodifiableList(new ArrayList<>(fields));
        return this;
    }

    public InstructionOptions travelRule(TravelRule mode) {
        this.travelRule = mode == null ? TravelRule.A : mode;
        return this;
    }

    /**
     * What the bank's own review concluded. These are the bank's assertions
     * and are signed with its key, so set them from your approval system. The
     * defaults exist for a first sandbox run, not for production.
     */
    public static final class Review {
        String kybStatus = "VERIFIED";
        String kybPolicyVersion = "sdk-1";
        String tradeReview = "APPROVED";
        String regulatorReportRef = "SDK-DEMO";
        String approvedByRole = "FX Compliance Officer";
        String fiatReceivedRef;

        /** KYB outcome for the debtor. Default {@code VERIFIED}. */
        public Review kybStatus(String v) {
            this.kybStatus = v;
            return this;
        }

        /** Version of the policy the KYB was done under. Default {@code sdk-1}. */
        public Review kybPolicyVersion(String v) {
            this.kybPolicyVersion = v;
            return this;
        }

        /** Outcome of the trade-document review. Default {@code APPROVED}. */
        public Review tradeReview(String v) {
            this.tradeReview = v;
            return this;
        }

        /** Your regulatory report reference for this payment. Default {@code SDK-DEMO}. */
        public Review regulatorReportRef(String v) {
            this.regulatorReportRef = v;
            return this;
        }

        /** Role of the approver, never a name. Default {@code FX Compliance Officer}. */
        public Review approvedByRole(String v) {
            this.approvedByRole = v;
            return this;
        }

        /** Your receipt for the funds collected from the debtor. Default {@code RCPT-<payment id>}. */
        public Review fiatReceivedRef(String v) {
            this.fiatReceivedRef = v;
            return this;
        }
    }
}
