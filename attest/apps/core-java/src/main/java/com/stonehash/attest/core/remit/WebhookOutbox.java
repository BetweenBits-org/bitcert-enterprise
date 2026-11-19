package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The webhook outbox — at least once, platform-signed, backed by a table.
 *
 * <p>This is the half that queues: one row per event an organisation is
 * told about, written in the same transaction as the transition it reports,
 * so that there is never a transition without its notice or a notice without
 * its transition. Sending the rows is the worker's.
 *
 * <p>What is stored is what will be sent, character for character: an object
 * of two members,
 * {@code { "envelope": { event_id, payment_id, sequence, type, state, occurred_at, data },
 * "signature": { alg, key_id, issuer, sig } }}, the signature being the
 * platform's over the envelope. The receiver removes duplicates by
 * {@code event_id} and orders by {@code sequence}.
 */
@Component
public class WebhookOutbox {
    private final RemitMapper mapper;
    private final ProductRegistry registry;
    private final PlatformKey platform;

    public WebhookOutbox(RemitMapper mapper, ProductRegistry registry, PlatformKey platform) {
        this.mapper = mapper;
        this.registry = registry;
        this.platform = platform;
    }

    /**
     * Where an organisation's settlement notices go: the {@code webhook_url}
     * of its settlement subscription — read also when the subscription is
     * switched off — or nothing.
     */
    Object urlOf(String orgId) {
        Map<String, Object> sub = registry.subscription(orgId, "remit");
        if (sub == null) {
            return Js.UNDEFINED;
        }
        return JsValues.member(Js.parse((String) sub.get("config")), "webhook_url");
    }

    /**
     * Queue one notice. An organisation with no address gets none.
     *
     * @param sequence the sequence number of the event the notice reports
     * @param state the state the settlement is in once the transition is done
     * @param data what this kind of notice carries, its members in the order they are sent
     */
    public void enqueue(String orgId, String paymentId, int sequence, String type, String state, Map<String, Object> data) {
        Object url = urlOf(orgId);
        if (!JsValues.truthy(url)) {
            return;
        }
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("event_id", UUID.randomUUID().toString());
        envelope.put("payment_id", paymentId);
        envelope.put("sequence", sequence);
        envelope.put("type", type);
        envelope.put("state", state);
        envelope.put("occurred_at", IsoTime.now());
        envelope.put("data", data);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("envelope", envelope);
        body.put("signature", platform.signEvent(envelope));
        String now = IsoTime.now();
        mapper.insertWebhook(UUID.randomUUID().toString(), orgId, paymentId, (String) envelope.get("event_id"), AttestService.storable(url),
                Js.stringify(body), now, now);
    }
}
