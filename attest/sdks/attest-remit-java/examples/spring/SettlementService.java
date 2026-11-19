package com.example.bank.settlement;

import com.stonehash.attest.remit.PartySupplement;
import com.stonehash.attest.remit.RemitClient;
import com.stonehash.attest.remit.SwiftOptions;
import com.stonehash.attest.remit.SwiftSubmission;
import org.springframework.stereotype.Service;

/**
 * Where your payment hub hands over a payment for this corridor: the MT103,
 * pacs.008 or pain.001 it already writes goes in as it is, and a
 * {@code pacs.002} comes back out.
 *
 * <p>What to expect from {@link #send}:
 * <ul>
 * <li>{@code SwiftMessageException} — the bytes are not a message this SDK reads; {@code code()} and {@code field()} say where.
 * <li>{@code SwiftMappingException} — the message lacks a value the corridor requires; {@code issues()} names each
 *     in the message's own vocabulary. Nothing was signed.
 * <li>{@code RemitApiException} with {@code reference_reused} — the message's reference is already on a
 *     <em>different</em> payment. Nothing was sent; this is not a repeat.
 * <li>{@code RemitApiException} with {@code not_a_platform_answer} or {@code unreachable} — the platform was not
 *     reached. Call again with the same message: it cannot become two payments.
 * </ul>
 */
@Service
public class SettlementService {

    /** Your customer master: what your bank knows about a debtor beyond what a message carries. */
    public interface CustomerMaster {
        /** @return the values to add for this account, or {@code null} when the records hold nothing for it */
        PartySupplement supplementFor(String debtorAccount);
    }

    private final RemitClient client;
    private final CustomerMaster customers;

    public SettlementService(RemitClient client, CustomerMaster customers) {
        this.client = client;
        this.customers = customers;
    }

    /**
     * Read, convert, quote, sign and submit — one call, and safe to repeat:
     * a message handed over twice is recognised, and the second call returns
     * the first one's payment with {@code already()} true.
     */
    public SwiftSubmission send(byte[] message) {
        return client.submitSwift(message, new SwiftOptions()
                .supplement((payment) -> customers.supplementFor(payment.debtor().account())));
    }

    /** The status report for a payment, in the form your payment hub already processes. */
    public String statusReport(String paymentId) {
        return client.statusReport(paymentId);
    }
}
