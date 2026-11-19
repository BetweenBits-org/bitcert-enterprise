package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.http.HttpError;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The sentences an instruction is refused with when a settlement already
 * stands where it wants to stand. They are read by programs as much as by
 * people — the codes and the two further fields are what a bank's payment
 * hub acts on — and they are the previous service's, to the character.
 */
final class Refusals {
    private Refusals() {
    }

    /**
     * A bank's payment hub resends when an answer is late. It is told where
     * the answer is, instead of being left to guess that the first try
     * landed.
     */
    static ServiceError duplicatePayment(String paymentId) {
        return new ServiceError(409, "duplicate_payment", "payment_id " + paymentId + " already exists — if this is a retry, read its state with "
                + "GET /v1/settlements/" + paymentId + " instead of resending; a new instruction needs a new payment_id");
    }

    static HttpError idempotencyConflict() {
        return new HttpError(409, "idempotency_conflict",
                "this Idempotency-Key was already used with a different request body — a rebuilt instruction "
                        + "(new quote, new signatures) is a different body; if this is a retry, read the payment with "
                        + "GET /v1/settlements/{payment_id} instead of resending");
    }

    /**
     * The refusal of a second settlement for a message that already has one.
     *
     * <p>Two codes, because the bank's system does two different things with
     * them: {@code duplicate_source_message} is the payment it already sent
     * — read that settlement, send nothing; {@code reference_reused} is a
     * UETR standing on two different payments — one of them needs a
     * reference of its own. Either way the answer carries the settlement
     * that holds the message ({@code existing_payment_id}) and the ground
     * ({@code ground}: {@code message}, {@code uetr}, {@code twin}, or
     * {@code twin_undated} — the one case that is not a recognition: two
     * messages that nothing tells apart).
     */
    static ServiceError sourceConflict(SourceRef source, RemitStore.Conflict conflict) {
        String existing = conflict.paymentId;
        String own = "a reference of its own — another instruction or end-to-end identifier";
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("existing_payment_id", existing);
        if (conflict.reused) {
            detail.put("ground", "uetr");
            return new ServiceError(409, "reference_reused",
                    "UETR " + source.uetr + " is already on settlement " + existing + ", which is a different payment — "
                            + "its amount, parties, accounts or identifiers differ, or it is another transaction of the same file. "
                            + "Nothing was accepted. A UETR names one payment: give this one its own",
                    detail);
        }
        if (conflict.undated) {
            detail.put("ground", "twin_undated");
            return new ServiceError(409, "duplicate_source_message",
                    "this payment cannot be told from settlement " + existing + ": the same identifiers and the same content, and the "
                            + "message states no value date to tell two payments apart. Nothing was accepted. "
                            + "If it is that payment, read its state with GET /v1/settlements/" + existing + "; if it is another one, give it " + own,
                    detail);
        }
        String ground = conflict.ground.equals("uetr") ? "the same UETR (" + source.uetr + ")"
                : conflict.ground.equals("message") ? "the same transaction of the same message"
                        : "the same identifiers, the same value date and the same content, in another message";
        detail.put("ground", conflict.ground);
        return new ServiceError(409, "duplicate_source_message",
                "this message's payment is already settlement " + existing + " — " + ground + ". Nothing was accepted; "
                        + "read its state with GET /v1/settlements/" + existing + " instead of sending it again"
                        + (conflict.ground.equals("twin") ? ". If it is meant as another payment, give it " + own : ""),
                detail);
    }
}
