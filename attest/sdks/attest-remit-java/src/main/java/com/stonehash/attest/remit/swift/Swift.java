package com.stonehash.attest.remit.swift;

import java.util.List;
import java.util.Map;

/**
 * SWIFT messages in: the MT103, pacs.008 or pain.001 the bank's payment
 * system already writes, read for the payment it carries.
 *
 * <p>This is a reader, not a validator: a message is read for its payment
 * and is not checked against a schema or a network rulebook, and nothing here
 * is a connection to the Swift network.
 */
public final class Swift {
    private Swift() {
    }

    /** Every customer credit transfer in the message — or the file of messages — in order. */
    public static List<SwiftPayment> parseAll(byte[] message) {
        return SwiftMessages.parseAll(message);
    }

    /** The same for a message held as text. Hand over bytes where the digest must equal that of the bank's file. */
    public static List<SwiftPayment> parseAll(String message) {
        return SwiftMessages.parseAll(message);
    }

    /**
     * The one payment in a message. With {@code index} null, a message that
     * carries several is refused ({@code multiple_transactions}) — a payment
     * is never picked by accident. {@code index} counts from 0.
     */
    public static SwiftPayment parse(byte[] message, Integer index) {
        return SwiftMessages.parse(SwiftMessages.parseAll(message), index);
    }

    public static SwiftPayment parse(String message, Integer index) {
        return SwiftMessages.parse(SwiftMessages.parseAll(message), index);
    }

    /**
     * The payment read onto what a settlement instruction needs: where every
     * value came from, what is missing (in the message's own vocabulary), and
     * what has no place in the corridor. Never throws for missing data — it
     * reports; {@code new SwiftMappingException(mapping)} is the refusal a
     * caller raises when {@link SwiftMapping#input()} is null. Null options are
     * the defaults.
     */
    public static SwiftMapping map(SwiftPayment payment, SwiftMappingOptions options) {
        return SwiftMapper.map(payment, options);
    }

    /**
     * The payment id the message always maps to for this institution, derived
     * from the message's own references ({@code PAY-<8>-<10>}).
     */
    public static String paymentId(String institutionId, SwiftPayment payment) {
        return SwiftIds.paymentId(institutionId, payment);
    }

    /** SHA-256 (hex) over what makes the payment this payment — not over the message's bytes. */
    public static String contentDigest(SwiftPayment payment) {
        return SwiftMapper.contentDigest(payment);
    }

    /** The ISO 20022 element names the payment's content corresponds to. */
    public static List<String> isoFieldNames(SwiftPayment payment) {
        return SwiftIds.isoFieldNames(payment);
    }

    // ── Status going back ──────────────────────────────────────────────────

    /**
     * The ISO 20022 transaction status of a settlement, from its view — the
     * platform's answer for the payment ({@code payment_id}, {@code state},
     * {@code events}) as JSON.
     *
     * <p>Never throws for what the view holds: a view that is not what the platform sends — an
     * event list that is not a list, a state that is not text — is answered as the reference
     * answers it, with what can still be said about the payment.
     */
    public static SwiftStatus statusOf(Map<String, Object> view) {
        return StatusReport.statusOf(view);
    }

    /**
     * The reference to the bank's message that the bank signed into its
     * instruction — {@code type}, {@code sha256}, {@code index},
     * {@code messageId}, {@code instructionId}, {@code paymentInfoId},
     * {@code endToEndId}, {@code uetr}, {@code valueDate}, {@code content} as
     * stated — or null when the settlement did not come from a message.
     */
    public static Map<String, Object> sourceMessageOf(Map<String, Object> view) {
        return StatusReport.sourceMessageOf(view);
    }

    /**
     * The settlement's state as a {@code pacs.002.001.10} status report
     * (FIToFIPaymentStatusReport), pointing at the bank's own message by its
     * identifiers. Its message id is made from the payment id and the last
     * event's number; its creation time is now.
     */
    public static String buildPacs002(Map<String, Object> view) {
        return StatusReport.buildPacs002(view, null, null);
    }

    /**
     * The same, with the report's own message id (Max35Text) and creation time
     * given — for reproducible output. Either may be null for the default.
     */
    public static String buildPacs002(Map<String, Object> view, String messageId, String createdAt) {
        return StatusReport.buildPacs002(view, messageId, createdAt);
    }

    /**
     * The table a bank maps onto its own status codes, one row per situation:
     * {@code state}, {@code when}, {@code code}, {@code reason} ({@code ""}
     * where the status carries none). It cannot be changed.
     */
    public static List<Map<String, Object>> statusTable() {
        return StatusReport.SWIFT_STATUS_TABLE;
    }
}
