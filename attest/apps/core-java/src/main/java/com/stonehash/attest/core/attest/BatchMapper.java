package com.stonehash.attest.core.attest;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * What the batch worker reads and writes: records waiting for a batch,
 * batches, proofs, anchor transactions, the attempts recorded before a
 * broadcast, and the lease. The SQL is in {@code mapper/BatchMapper.xml}.
 */
@Mapper
public interface BatchMapper {
    long pendingCount();

    /** The organisation of the oldest record without a batch — locked, so this is the first statement of the sealing transaction. */
    String oldestPendingOrgForUpdate();

    /** {@code id, leaf_bytes} of that organisation's records without a batch, oldest first, locked. */
    List<Map<String, Object>> pendingOfOrgForUpdate(String orgId, long limit);

    int insertBatch(String id, String merkleRoot, long leafCount, String ts);

    /** Counts 1 only when the record was still without a batch. */
    int putInBatch(String id, String batchId, long leafIndex);

    int insertProof(String attestationId, String batchId, long leafIndex, String siblings, String directions);

    /** {@code id, status, merkle_root}. */
    Map<String, Object> batch(String id);

    /** The same row, locked: the first statement of the transaction that finishes an anchoring. */
    Map<String, Object> batchForUpdate(String id);

    /** The oldest batch still {@code sealed}, leaving out one that this cycle has dealt with already. */
    String oldestSealedBatch(@Param("except") String except);

    int insertAnchorTx(String txid, String batchId, String network, String payloadHex, String rawTxHex, String submittedAt);

    /** Counts 1 only when the batch was still {@code sealed}. */
    int markBatchSubmitted(String id, String txid);

    int markAttestationsSubmitted(String batchId);

    /** {@code txid, batch_id, raw_tx_hex, payload_hex} of anchors not confirmed yet. */
    List<Map<String, Object>> unconfirmedAnchors();

    /** Counts 1 only when the anchor was not confirmed yet. */
    int confirmAnchorTx(String txid, Long blockHeight, String blockHash, long confirmations, String confirmedAt);

    int confirmBatch(String id);

    int confirmAttestations(String batchId);

    /** {@code id, reveal_txid} of inscriptions not confirmed yet. */
    List<Map<String, Object>> unconfirmedInscriptions();

    int confirmInscription(String id, Long blockHeight, String blockHash, long confirmations);

    /** Ids of free-tier records whose time has passed. */
    List<String> expiredPublic(String cutoff);

    int deleteProof(String attestationId);

    int deleteAttestation(String id);

    // ── attempts ──────────────────────────────────────────────────────────────

    /** The attempt of a batch that is recorded and neither finished nor dead: {@code attempt, txid, raw_tx_hex, payload_hex}. */
    Map<String, Object> openAttempt(String batchId);

    long attemptCount(String batchId);

    int insertAttempt(String batchId, long attempt, String txid, String rawTxHex, String payloadHex);

    /** Counts 1 only when the attempt was still {@code recorded}. */
    int setAttemptState(String batchId, long attempt, String state);

    // ── lease ─────────────────────────────────────────────────────────────────

    /** Counts 1 when the lease is this owner's, or was nobody's any more and is this owner's now. */
    int takeLease(String name, String owner, long ttlSeconds);

    /** Counts 1 when there was no lease of this name and this owner has it now. */
    int createLease(String name, String owner, long ttlSeconds);

    /** Counts 1 only when the lease is this owner's and has not run out. */
    int renewLease(String name, String owner, long ttlSeconds);

    int releaseLease(String name, String owner);

    /** {@code owner} and whether it has {@code expired}, by the database's clock. */
    Map<String, Object> lease(String name);
}
