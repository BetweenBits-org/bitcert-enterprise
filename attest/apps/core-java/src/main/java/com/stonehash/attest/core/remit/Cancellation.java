package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.db.TxRetry;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.log.Log;
import com.stonehash.attest.core.time.IsoTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Cancelling a settlement — {@code POST /v1/settlements/:id/cancel} once the
 * caller is known.
 *
 * <p>The bank may cancel until the receiving institution has pre-approved
 * the payout: while the settlement is {@code REQUEST_ACCEPTED},
 * {@code BANK_AUTHORIZED} or {@code TRAVEL_RULE_PENDING}. Funds have not
 * moved — the bank refunds its customer on its own ledger. The bank signs
 * what it asks for: {@code { payment_id, reason }}, with the reason it sends
 * or, when it sends none, the platform's default sentence.
 *
 * <p>The checks come in the order they have always come in — the settlement
 * (404, also for another organisation's), its state (409, the sentence names
 * it), the signature (400) — and only read. Then one transaction, the
 * settlement's row locked first: a pre-approval that committed in the
 * meantime leaves nothing to cancel (409), and a cancellation that commits
 * first leaves the pre-approval nothing to move — of the two, exactly one
 * happens. The transaction writes the bank's signed request as an event, the
 * state, the notice to the bank, and the job that tells the receiving
 * institution; personal data still held from the request is taken out.
 *
 * <p>The bank is answered as soon as that has committed. Telling the
 * receiving institution is the job's ({@link CancelNotice}) and happens
 * behind the answer: the cancellation stands whatever becomes of the notice.
 */
@Component
public class Cancellation {
    /** The states a settlement may be cancelled in. */
    static final List<String> CANCELLABLE = List.of("REQUEST_ACCEPTED", "BANK_AUTHORIZED", "TRAVEL_RULE_PENDING");
    /** What is cancelled for when the bank gives no reason — and what the bank then has to have signed. */
    static final String DEFAULT_REASON = "cancelled by instructing bank";

    private final RemitStore store;
    private final RemitJobs jobs;
    private final WebhookOutbox outbox;
    private final RemitExecutor executor;
    private final TransactionTemplate tx;

    public Cancellation(RemitStore store, RemitJobs jobs, WebhookOutbox outbox, RemitExecutor executor, TransactionTemplate tx) {
        this.store = store;
        this.jobs = jobs;
        this.outbox = outbox;
        this.executor = executor;
        this.tx = tx;
    }

    private static ServiceError notFound(String paymentId) {
        return new ServiceError(404, "payment_not_found", "no payment " + paymentId);
    }

    private static ServiceError notCancellable(Object state) {
        return new ServiceError(409, "not_cancellable", "payment is " + state + "; cancellation is only possible before payout pre-approval");
    }

    /** What the transaction came to. */
    private static final class Outcome {
        ServiceError refusal;
        RemitJobs.Held notice;
    }

    /**
     * @param bank the caller's collection bank, as the gate of the settlement API returned it
     * @param paymentId the id as the request named it
     * @param body the request body, any JSON at all
     * @return {@code { payment_id, state: "CANCELLED" }}
     * @throws ServiceError 404 {@code payment_not_found}, 409 {@code not_cancellable}, 400 {@code invalid_signature}
     */
    public Map<String, Object> cancel(String orgId, Map<String, Object> bank, String paymentId, Object body) {
        Map<String, Object> fields = Body.fields(body);
        Map<String, Object> p = store.get(paymentId);
        if (p == null || !orgId.equals(p.get("org_id"))) {
            throw notFound(paymentId);
        }
        if (!CANCELLABLE.contains(p.get("state"))) {
            throw notCancellable(p.get("state"));
        }
        // From here on the id is the settlement's own, as stored.
        String id = (String) p.get("id");
        // Any JSON value is a reason; none at all, or null, is the default sentence.
        Object reason = JsValues.nullish(fields.get("reason")) ? DEFAULT_REASON : fields.get("reason");
        Object sig = fields.get("sig");
        Object spki = bank.get("signing_spki");
        Map<String, Object> asked = new LinkedHashMap<>();
        asked.put("payment_id", id);
        asked.put("reason", reason);
        if (!JsValues.truthy(sig) || !(spki instanceof String) || ((String) spki).isEmpty() || !Signatures.verifyEvent(asked, sig, (String) spki)) {
            throw new ServiceError(400, "invalid_signature", "sig must cover {payment_id, reason} with the bank key");
        }
        String bankId = (String) bank.get("id");

        Outcome out = TxRetry.execute(tx, (status) -> {
            Outcome o = new Outcome();
            // The lock is the first statement: what is read after it is what is there now.
            Map<String, Object> now = store.lock(id);
            if (now == null || !orgId.equals(now.get("org_id"))) {
                o.refusal = notFound(paymentId);
                return o;
            }
            String state = (String) now.get("state");
            if (!CANCELLABLE.contains(state)) {
                // The pre-approval (or an end of another kind) committed first: there is nothing left to cancel.
                o.refusal = notCancellable(state);
                return o;
            }
            Map<String, Object> requested = new LinkedHashMap<>();
            requested.put("payment_id", id);
            requested.put("reason", reason);
            requested.put("requested_at", IsoTime.now());
            // The event keeps the bank's signature as the bank sent it.
            int seq = store.appendEvent(id, "CANCEL_REQUESTED", bankId, requested, sig);
            if (!store.moveState(id, state, "CANCELLED")) {
                throw new IllegalStateException("settlement " + id + " was moved while its row was locked");
            }
            String scrubbed = withoutPlaintext(id, (String) now.get("request_body"));
            if (scrubbed != null) {
                store.setRequestBody(id, scrubbed);
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("reason", reason);
            data.put("by", bankId);
            outbox.enqueue(orgId, id, seq, "CANCELLED", "CANCELLED", data);
            try {
                o.notice = jobs.insertClaimed(id, orgId, RemitJobs.Kind.CANCEL_NOTICE, id + ":cancel", null);
            } catch (DuplicateKeyException e) {
                // A job is already open among this settlement's notices — which no settlement that can still be cancelled
                // should have. The cancellation is not held up by it: it is the bank's instruction, in time, and it stands.
                Log.line("cancel notice not queued: the settlement already has an open notice job", Log.fields("payment", id));
            }
            return o;
        });
        if (out.refusal != null) {
            throw out.refusal;
        }
        if (out.notice != null) {
            // Telling the receiving institution goes on off this request's lifetime.
            executor.runNow(out.notice);
        }
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("payment_id", id);
        answer.put("state", "CANCELLED");
        return answer;
    }

    /**
     * A stored request without the personal data it may still hold — the
     * member the travel-rule step would have consumed and deleted, had the
     * settlement got that far.
     *
     * @return the request as it is to be stored, or {@code null} when it holds none (or cannot be read: it is then left as it is, and that is logged)
     */
    static String withoutPlaintext(String paymentId, String requestBody) {
        if (requestBody == null || !requestBody.contains("compliance_plaintext")) {
            return null;
        }
        Object request;
        try {
            request = Js.parse(requestBody);
        } catch (RuntimeException e) {
            // Nothing either service ever stored. The cancellation is not held up by it; the line says where to look.
            Log.line("a stored request could not be read to take the personal data out", Log.fields("payment", paymentId));
            return null;
        }
        if (!(request instanceof Map) || !((Map<?, ?>) request).containsKey("compliance_plaintext")) {
            return null;
        }
        ((Map<?, ?>) request).remove("compliance_plaintext");
        return Js.stringify(request);
    }
}
