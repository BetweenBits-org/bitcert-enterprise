package com.example.bank.settlement;

import com.stonehash.attest.remit.RemitClient;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Where the platform delivers each step of a payment, if a webhook URL was
 * given when Cross-border Settlement was activated.
 *
 * <p>A delivery is acted on only when the platform's signature on it
 * verifies. Deliveries are at-least-once, so {@link PaymentEvents} is told the
 * event id to drop repeats by and the sequence to order by.
 */
@RestController
public class SettlementWebhookController {

    /** Your side of it: the table, queue or workflow that follows a payment. */
    public interface PaymentEvents {
        /** @return false when this event id was recorded before */
        boolean record(String eventId, String paymentId, long sequence, String type, String state);
    }

    private final RemitClient client;
    private final PaymentEvents events;

    public SettlementWebhookController(RemitClient client, PaymentEvents events) {
        this.client = client;
        this.events = events;
    }

    @PostMapping(path = "/stonehash/webhook", consumes = "application/json")
    public ResponseEntity<Void> delivery(@RequestBody String body) {
        Optional<Map<String, Object>> verified = client.verifyWebhook(body);
        if (!verified.isPresent()) {
            // Not signed by the platform: not acknowledged, and nothing is done with it.
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        Map<String, Object> envelope = verified.get();
        events.record((String) envelope.get("event_id"), (String) envelope.get("payment_id"),
                ((Number) envelope.get("sequence")).longValue(), (String) envelope.get("type"), (String) envelope.get("state"));
        // Any 2xx acknowledges the delivery. Only BENEFICIARY_CREDIT_CONFIRMED may be treated as the credit.
        return ResponseEntity.noContent().build();
    }
}
