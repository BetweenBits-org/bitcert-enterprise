package com.stonehash.attest.remit;

import java.util.Collections;
import java.util.Map;

/**
 * A settlement instruction, signed and ready to submit: the three evidence
 * elements, the payment-release authorization and the Travel Rule payload,
 * each under the bank's key.
 */
public final class Instruction {
    private final String paymentId;
    private final Map<String, Object> body;

    Instruction(String paymentId, Map<String, Object> body) {
        this.paymentId = paymentId;
        this.body = Collections.unmodifiableMap(body);
    }

    public String paymentId() {
        return paymentId;
    }

    /** Exactly what {@link RemitClient#submit(Instruction)} sends. */
    public Map<String, Object> body() {
        return body;
    }

    /** The body as JSON text, for a log or an audit record. */
    public String toJson() {
        return Json.pretty(body);
    }
}
