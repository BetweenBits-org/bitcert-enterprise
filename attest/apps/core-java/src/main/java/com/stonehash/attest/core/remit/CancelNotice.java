package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.log.Log;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Telling the receiving institution that a settlement was cancelled — the
 * job a cancellation leaves behind ({@link Cancellation}).
 *
 * <p>The institution drops its record, so that a pre-approval it may have
 * given cannot linger. Nothing of the settlement depends on it: the
 * settlement is {@code CANCELLED} before this job first runs, no transfer
 * can follow, and whatever happens here never changes that. So this is the
 * one kind of job that does not look at the settlement's state at all — it
 * runs <em>because</em> the settlement has ended — and that never moves a
 * settlement to {@code EXCEPTION}: when the notice cannot be delivered the
 * job is left for a person ({@code attention}), and an operator sends it
 * again ({@code remit-job-requeue}) or closes it.
 *
 * <p>The notice is {@code { payment_id, reason, sender }}: the reason the
 * bank's signed request carried, and the platform's signature over the first
 * two. It is made once, at the first attempt, and kept with the job, so that
 * every further attempt sends the same bytes under the same key
 * ({@code <payment id>:cancel}).
 *
 * <p>Any answer below 400 is the notice delivered — the answer itself is not
 * read. A call that never connected may be made again; a refusal (4xx) will
 * not turn into anything else; and where nobody knows whether the notice
 * arrived (no answer, 5xx) it is sent again only to a partner that has said
 * it honours the key.
 */
@Component
public class CancelNotice implements JobHandler {
    static final String PATH = "/bfi/cancel";
    /** A sentence kept with a job is kept short enough for its column, whatever a partner answered. */
    private static final int SENTENCE_MAX = 4_000;

    private final RemitStore store;
    private final RemitJobs jobs;
    private final PlatformKey platform;
    private final Supplier<PartnerExchange> exchange;

    @Autowired
    public CancelNotice(RemitStore store, RemitJobs jobs, PlatformKey platform, ObjectProvider<PartnerExchange> exchange) {
        this(store, jobs, platform, exchange::getIfAvailable);
    }

    /** For a test that plays the partner itself. */
    CancelNotice(RemitStore store, RemitJobs jobs, PlatformKey platform, Supplier<PartnerExchange> exchange) {
        this.store = store;
        this.jobs = jobs;
        this.platform = platform;
        this.exchange = exchange;
    }

    @Override
    public RemitJobs.Kind kind() {
        return RemitJobs.Kind.CANCEL_NOTICE;
    }

    /** The notice for a cancellation, as it is sent: the reason is the one the bank's signed request carried. */
    String noticeFor(String paymentId, Object reason) {
        Map<String, Object> told = new LinkedHashMap<>();
        told.put("payment_id", paymentId);
        told.put("reason", reason);
        Map<String, Object> notice = new LinkedHashMap<>(told);
        notice.put("sender", platform.signEvent(told));
        return Js.stringify(notice);
    }

    @Override
    public JobResult run(JobAttempt attempt) {
        PartnerExchange partner = exchange.get();
        if (partner == null) {
            return JobResult.failed("this build has no connection to the receiving institution");
        }
        String body;
        if (attempt.input == null) {
            Map<String, Object> requested = store.eventOfType(attempt.paymentId, "CANCEL_REQUESTED");
            if (requested == null) {
                return JobResult.failed("no cancellation is on file for this settlement: there is nothing to tell the receiving institution");
            }
            Object reason = JsValues.memberIfAny(Js.parse((String) requested.get("payload")), "reason");
            body = noticeFor(attempt.paymentId, JsValues.nullish(reason) ? Cancellation.DEFAULT_REASON : reason);
            Map<String, Object> kept = new LinkedHashMap<>();
            kept.put("body", body);
            if (!jobs.setInput(attempt.job, kept, null)) {
                return JobResult.closed(); // somebody else's now: nothing more is written here
            }
        } else {
            body = (String) JsValues.member(Js.parse(attempt.input), "body");
        }
        // The lease counts from just before the call, so that it cannot run out while a live holder waits for the answer.
        if (!jobs.renew(attempt.job)) {
            return JobResult.closed();
        }
        String key = attempt.idempotencyKey != null ? attempt.idempotencyKey : attempt.paymentId + ":cancel";
        PartnerAnswer answer = partner.post(PATH, key, body);
        if (answer.ok()) {
            // Delivered. That is a result: it closes the job whoever holds it by now.
            jobs.closeAnyway(attempt.job.id, RemitJobs.DONE, null);
            return JobResult.closed();
        }
        String sentence = clip(answer.failure(PATH, partner.base()));
        if (answer.kind == PartnerAnswer.Kind.NOT_REACHED) {
            return JobResult.retry(sentence);
        }
        if (answer.unknown() && partner.honoursIdempotencyKeys()) {
            return JobResult.retry(sentence);
        }
        return JobResult.failed(sentence);
    }

    /** The notice was not delivered and will not be tried again by itself: a person looks. The settlement stays cancelled. */
    @Override
    public void giveUp(JobAttempt attempt, String error) {
        if (jobs.close(attempt.job, RemitJobs.ATTENTION, clip(error))) {
            Log.line("BFI cancel notice failed", Log.fields("payment", attempt.paymentId, "job", attempt.job.id, "error", error));
        }
    }

    private static String clip(String sentence) {
        return sentence == null || sentence.length() <= SENTENCE_MAX ? sentence : sentence.substring(0, SENTENCE_MAX) + "…";
    }
}
