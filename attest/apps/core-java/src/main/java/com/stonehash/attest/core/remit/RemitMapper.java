package com.stonehash.attest.core.remit;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * The settlement rail in the store. The SQL is in {@code mapper/RemitMapper.xml}.
 *
 * <p>The tables of version 1 keep their times as text, written by
 * {@code time/IsoTime} and handed in ({@code at}); {@code remit_jobs} keeps
 * times as times, on the database's own clock.
 */
@Mapper
public interface RemitMapper {
    // ── the lock an acceptance starts with ───────────────────────────────────

    /** The first statement of an acceptance: two requests of one organisation are judged one after the other. */
    String lockOrg(String orgId);

    // ── settlements ──────────────────────────────────────────────────────────

    /** Every column of one settlement, or {@code null}. */
    Map<String, Object> payment(String id);

    /** {@link #payment}, with the row locked until the transaction ends: the first statement of every transition. */
    Map<String, Object> paymentForUpdate(String id);

    /** Whether a settlement of that id exists, whoever it belongs to: {@code 1} or {@code null}. */
    Integer paymentExists(String id);

    int insertPayment(String id, String orgId, String quoteId, String corridorOrigin, String corridorDestination, String tradeCurrency,
            String tradeAmount, String collectCurrency, String collectAmount, String usdcAmount, String payoutCurrency, String payoutAmount,
            String beneficiaryInstitution, String requestBody, String at);

    /** The state moves only from the state it was expected in: the count says whether this transaction was the one that moved it. */
    int moveState(String id, String from, String to, String at);

    int setDepositAddress(String id, String depositAddress, String at);

    int setChainTx(String id, String chainTx, String at);

    int setEvidenceLevel(String id, String evidenceLevel, String at);

    int setVerdict(String id, String verdict, String at);

    /** Only a settlement that has no evidence record yet takes one. */
    int setPackage(String id, String packageJson, String nonce, String commitment, String attestationId, String at);

    int setRequestBody(String id, String requestBody, String at);

    /** {@code id, attestation_id} of the settlements whose evidence record has confirmed and that still wait for it. */
    List<Map<String, Object>> anchoredPending();

    // ── events ───────────────────────────────────────────────────────────────

    /** A settlement's events in their order: {@code id, payment_id, seq, type, issuer, payload, sig, created_at}. */
    List<Map<String, Object>> events(String paymentId);

    /** The first event of a type, or {@code null}. */
    Map<String, Object> eventOfType(String paymentId, String type);

    /** The events of one type, in their order. */
    List<Map<String, Object>> eventsOfType(String paymentId, String type);

    /** The sequence number the next event takes: 0 for the first. Asked under the settlement's lock. */
    int nextSeq(String paymentId);

    int insertEvent(String id, String paymentId, int seq, String type, String issuer, String payload, String sig, String at);

    // ── quotes ───────────────────────────────────────────────────────────────

    int insertQuote(String id, String orgId, String origin, String destination, String request, String response, String expiresAt, String at);

    /** {@code id, response, expires_at} of one of the organisation's quotes, or {@code null}. */
    Map<String, Object> quote(String id, String orgId);

    // ── request idempotency ──────────────────────────────────────────────────

    /** {@code request_hash, response_status, response_body}, or {@code null}. */
    Map<String, Object> idempotencyHit(String orgId, String key);

    int insertIdempotency(String orgId, String key, String requestHash, int status, String body, String at);

    // ── travel rule ──────────────────────────────────────────────────────────

    int insertTravelRule(String id, String paymentId, String recipient, String ciphertext, String digest, String status, String response, String at);

    /** {@code ivms101_digest, ciphertext, status} of the newest row, or {@code null}. */
    Map<String, Object> travelRule(String paymentId);

    // ── webhooks ─────────────────────────────────────────────────────────────

    int insertWebhook(String id, String orgId, String paymentId, String eventId, String url, String body, String nextAttemptAt, String at);

    /** {@code id, url, body, attempts} of what is due, oldest first. */
    List<Map<String, Object>> dueWebhooks(String now, int limit);

    /** A delivery's result is written only onto the attempt it was made from: {@code pending}, with that many attempts behind it. */
    int webhookDelivered(String id, int attempts);

    int webhookRescheduled(String id, int attempts, String error, String nextAttemptAt);

    int webhookExhausted(String id, int attempts, String error);

    /** Every delivery queued for a settlement, oldest first. */
    List<Map<String, Object>> webhooksOfPayment(String paymentId);

    // ── daily manifests ──────────────────────────────────────────────────────

    /** The ids of what the organisation instructed on a day (UTC), oldest first. */
    List<String> paymentIdsOfDay(String orgId, String date);

    /** One row per organisation and day: a second manifest for a day replaces the first. */
    int upsertManifest(String id, String orgId, String date, String manifest, String sig, String verdict, String platformSig, String commitment,
            String attestationId, String at);

    List<Map<String, Object>> manifestsOfDay(String orgId, String date);

    /** The organisation's newest thirty. */
    List<Map<String, Object>> latestManifests(String orgId);

    // ── one message, one settlement ──────────────────────────────────────────

    /** {@code payment_id, uetr, content, sha256, idx} of the settlement that holds this transaction of this file, or {@code null}. */
    Map<String, Object> sourceRefOfMessage(String orgId, String sha256, long idx);

    /** The settlement this transaction of this file was recognised as before, or {@code null}. */
    String sourceMatch(String orgId, String sha256, long idx);

    Map<String, Object> sourceRefOfUetr(String orgId, String uetr);

    /**
     * The oldest settlement that states the same payment in another file,
     * and that no other transaction of the incoming file was recognised as.
     *
     * @param withoutUetr only a settlement that has no UETR (the incoming message carries one)
     */
    Map<String, Object> sourceTwin(@Param("orgId") String orgId, @Param("twinKey") String twinKey, @Param("sha256") String sha256,
            @Param("withoutUetr") boolean withoutUetr);

    int insertSourceMatch(String orgId, String sha256, long idx, String paymentId, String at);

    /** A settlement without a UETR takes the UETR of the rendering it was recognised in. */
    int inheritUetr(String paymentId, String uetr);

    int insertSourceRef(String paymentId, String orgId, String messageType, String sha256, long idx, String uetr, String valueDate, String content,
            String twinKey, String at);

    /** Every column of a settlement's reference row, or {@code null}. */
    Map<String, Object> sourceRef(String paymentId);

    // ── the ledger ───────────────────────────────────────────────────────────

    long searchCount(@Param("orgId") String orgId, @Param("like") String like, @Param("lookup") boolean lookup, @Param("sourceUetr") String sourceUetr,
            @Param("sourceContent") String sourceContent, @Param("sourceValueDate") String sourceValueDate, @Param("states") List<String> states,
            @Param("from") String from, @Param("to") String to);

    List<Map<String, Object>> searchPage(@Param("orgId") String orgId, @Param("like") String like, @Param("lookup") boolean lookup,
            @Param("sourceUetr") String sourceUetr, @Param("sourceContent") String sourceContent, @Param("sourceValueDate") String sourceValueDate,
            @Param("states") List<String> states, @Param("from") String from, @Param("to") String to, @Param("cursorAt") String cursorAt,
            @Param("cursorId") String cursorId, @Param("limit") long limit);

    /** {@code org_id} of the account with that e-mail address, or {@code null}. */
    String orgOfAccount(String email);

    // ── jobs ─────────────────────────────────────────────────────────────────

    /** Every column of one job, or {@code null}. Times come back as text ({@code yyyy-MM-dd HH:mm:ss.SSS}, UTC). */
    Map<String, Object> job(String id);

    /** A settlement's jobs, oldest first. */
    List<Map<String, Object>> jobsOfPayment(String paymentId);

    /** The settlement's open job in a lane, or {@code null}. */
    Map<String, Object> openJob(String paymentId, String lane);

    /** A job that waits to be claimed. */
    int insertQueuedJob(String id, String paymentId, String orgId, String kind, String lane, String idempotencyKey, String input);

    /** A job that is its inserter's from its first moment: {@code running}, under a lease of so many seconds. */
    int insertClaimedJob(String id, String paymentId, String orgId, String kind, String lane, String idempotencyKey, String input, String owner,
            long leaseSeconds);

    /**
     * Claim a job: one statement, and its count is the answer. A job that
     * is queued, or waiting and due, or running under a lease that ran out,
     * becomes {@code owner}'s for so many seconds.
     */
    int claimJob(String id, String owner, long leaseSeconds);

    /** {@code id, payment_id, kind, lane, state, attempts} of the jobs nobody holds: due, or running under a lease that ran out. Oldest first. */
    List<Map<String, Object>> claimableJobs(int limit);

    /** The work starts: the lease counts from now and the attempt is counted. Only the job's holder. */
    int startJob(String id, String owner, long leaseSeconds);

    /** Only the job's holder. */
    int renewJobLease(String id, String owner, long leaseSeconds);

    /** The wallet may be called from here on. Only the job's holder; the lease counts from now. */
    int markJobCallStarted(String id, String owner, long leaseSeconds);

    /** Only the job's holder. */
    int setJobInput(String id, String owner, String input, String idempotencyKey);

    /** To be tried again after so many milliseconds. Only the job's holder. */
    int jobWaits(String id, String owner, long delayMs, String error);

    /** Back in the queue, for whoever claims it next: the holder could not start it. Only the job's holder. */
    int requeueHeldJob(String id, String owner);

    /** Closed by its holder: {@code done}, {@code cancelled} or {@code attention}. Only the job's holder. */
    int closeHeldJob(String id, String owner, String state, String error);

    /** Closed whoever holds it — for the transition that records a result, which a lost lease must not undo. */
    int closeJob(String id, String state, String error);

    /** An {@code attention} job back into the queue with nothing counted against it. */
    int reopenJob(String id);

    /** Jobs that are open or need a person: {@code id, payment_id, org_id, kind, lane, state, attempts, last_error, created_at, updated_at}. */
    List<Map<String, Object>> unfinishedJobs();
}
