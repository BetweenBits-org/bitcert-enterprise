package com.stonehash.attest.core.console;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** What the console reads and writes beyond the records themselves. The SQL is in {@code mapper/ConsoleMapper.xml}. */
@Mapper
public interface ConsoleMapper {
    // ── the account's organisation, its keys, its allowance ──────────────────

    /** {@code id, slug, name, created_at}. */
    Map<String, Object> org(String id);

    /** {@code id, label, created_at} of the key issued last and not revoked. */
    Map<String, Object> newestActiveKey(String orgId);

    /** {@code id, prefix, label, created_at}, newest first. */
    List<Map<String, Object>> activeKeys(String orgId);

    long activeKeyCount(String orgId);

    int renameKey(String label, String id, String orgId);

    int revokeKey(String at, String id, String orgId);

    int revokeKeyById(String at, String id);

    /** {@code id, label, algorithm, created_at}. */
    List<Map<String, Object>> activeIssuerKeys(String orgId);

    /** Records one product made for the organisation since a time. */
    long anchorsSince(String orgId, String since, String product);

    int subscribeToAttest(String id, String orgId, String createdAt);

    /** The id of a record of this organisation that this transaction anchors, or {@code null}. */
    String recordUsingTx(String orgId, String txid);

    // ── the dashboard ────────────────────────────────────────────────────────

    long rfiWaitingCount(String orgId);

    long l1HeldCount(String orgId);

    long exceptionCount(String orgId);

    long webhookExhaustedCount(String orgId);

    long unconfirmedAnchorCount(String orgId);

    /** {@code id, state, created_at, payload}. */
    List<Map<String, Object>> exceptionItems(String orgId, int limit);

    /** {@code id, state, created_at}. */
    List<Map<String, Object>> rfiItems(String orgId, int limit);

    /** {@code id, state, created_at}. */
    List<Map<String, Object>> heldItems(String orgId, int limit);

    /** {@code payment_id, last_error, created_at}. */
    List<Map<String, Object>> exhaustedItems(String orgId, int limit);

    /** {@code status, n}. */
    List<Map<String, Object>> attestFunnel(String orgId);

    long signedCount(String orgId);

    long registeredCount(String orgId);

    /** {@code c, f}: accepted at, confirmed at. */
    List<Map<String, Object>> confirmPairs(String orgId);

    /** {@code id, leaf_bytes, kind, status, created_at}. */
    List<Map<String, Object>> recentAttest(String orgId);

    /** {@code n, s}: how many settlements were made that day (UTC) and their trade amounts added up. */
    Map<String, Object> remitOfDay(String orgId, String day);

    /** {@code n, s}, since a time. */
    Map<String, Object> remitSince(String orgId, String since);

    /** {@code state, n}. */
    List<Map<String, Object>> remitStates(String orgId);

    String manifestVerdict(String orgId, String date);

    /** {@code date, verdict}. */
    Map<String, Object> latestManifest(String orgId);

    /** {@code status, n}. */
    List<Map<String, Object>> webhookStatuses(String orgId);

    /** {@code c, f}: requested at, reconciled at. */
    List<Map<String, Object>> creditPairs(String orgId);

    long terminalBadSince(String orgId, String since);

    /** {@code id, state, trade_amount, trade_currency, evidence_level, created_at}. */
    List<Map<String, Object>> recentRemit(String orgId);

    /** {@code id, status, asof, root, leaf_count, totals, reserves, attestation_id, created_at}, newest first, ten at most. */
    List<Map<String, Object>> recentSnapshots(String orgId);

    String attestationStatus(String id);

    // ── products ─────────────────────────────────────────────────────────────

    /** {@code id, org_id, product, plan, status, config, created_at}, oldest first. */
    List<Map<String, Object>> subscriptions(String orgId);

    Map<String, Object> subscription(String orgId, String product);

    int reactivateSubscription(String id, String config);

    int insertSubscription(String id, String orgId, String product, String config, String createdAt);

    /** {@code id, org_id, role, name, country, signing_spki, encryption_jwk, authority, created_at, console_spki}. */
    Map<String, Object> institution(String id);

    Map<String, Object> institutionForOrg(String orgId, String role);

    /** Every institution of the deployment, in the order they were registered: the same columns as {@link #institution}. */
    List<Map<String, Object>> institutions();

    int updateInstitution(String id, String role, String name, String country, String orgId, String signingSpki,
            String encryptionJwk, String authority);

    int insertInstitution(String id, String orgId, String role, String name, String country, String signingSpki,
            String encryptionJwk, String authority, String createdAt);

    /** {@code public_key, algorithm} of one of the organisation's keys, unless it was revoked. */
    Map<String, Object> activeIssuerKey(String id, String orgId);

    /** {@code public_key, algorithm, revoked_at} of one of the organisation's keys, revoked or not. */
    Map<String, Object> issuerKey(String id, String orgId);

    int deactivateSubscription(String id);

    int setSigningKey(String id, String spki);

    int setConsoleKey(String id, String spki);

    long settlementsSince(String orgId, String since);

    long snapshotsSince(String orgId, String since);
}
