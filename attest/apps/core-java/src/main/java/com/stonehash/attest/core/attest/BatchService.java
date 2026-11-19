package com.stonehash.attest.core.attest;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.anchor.AnchorBackend;
import com.stonehash.attest.core.format.Bc01;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.Merkle;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.log.Log;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The transitions the batch worker makes: seal waiting records into a batch,
 * commit a batch's root to the chain, promote what has landed in a block,
 * and drop free-tier records whose time has passed.
 *
 * <pre>accepted → batched → submitted → confirmed</pre>
 *
 * Each transition is one transaction, and carries the state it expects as
 * its condition: a record is put in a batch only while it has none, a batch
 * is marked submitted only while it is sealed. A count that is not what it
 * must be rolls the transaction back — so the same step asked for twice, by
 * two cycles or two instances, happens once.
 *
 * <p>What a client sees is what the service this one replaces produced: the
 * same batches from the same records in the same order, the same rows. What
 * is new is inside: the conditions, and the record made before a broadcast
 * ({@code anchor_attempts}) — see {@link #anchorBatch}.
 */
@Service
public class BatchService {
    /** The lease the batch worker works under. */
    public static final String LEASE = "batch";

    private final BatchMapper mapper;
    private final AnchorBackend backend;
    private final WorkerLease lease;
    private final TransactionTemplate tx;
    private final long maxLeaves;

    public BatchService(BatchMapper mapper, AnchorBackend backend, WorkerLease lease, TransactionTemplate tx,
            com.stonehash.attest.core.config.CoreConfig cfg) {
        this.mapper = mapper;
        this.backend = backend;
        this.lease = lease;
        this.tx = tx;
        this.maxLeaves = cfg.batch.maxLeaves;
    }

    public long pendingCount() {
        return mapper.pendingCount();
    }

    /**
     * Seal one batch, drawn from a single organisation. Returns the batch id,
     * or {@code null} if nothing waited.
     *
     * <p>The oldest waiting record picks the organisation; everything else of
     * that organisation joins it, oldest first — by time, and within one
     * millisecond by the order the records arrived in, never by id. Choosing
     * by age rather than by volume is what keeps a tenant with one document
     * from waiting behind one with thousands. The grouping follows the
     * privacy boundary, not the cost one: a batch that may one day carry
     * issuer statements must not publish one tenant's beside another's.
     *
     * <p>The order is each record's leaf index, and so part of its proof.
     */
    public String sealBatch() {
        return tx.execute((status) -> {
            // The lock is the first statement on purpose: whatever the isolation level, what
            // is read after it is what is there now.
            String orgId = mapper.oldestPendingOrgForUpdate();
            if (orgId == null) {
                return null;
            }
            List<Map<String, Object>> pending = mapper.pendingOfOrgForUpdate(orgId, maxLeaves);
            if (pending.isEmpty()) {
                return null;
            }
            List<byte[]> leaves = new ArrayList<>();
            for (Map<String, Object> row : pending) {
                leaves.add(Hex.decode((String) row.get("leaf_bytes")));
            }
            Merkle tree = Merkle.fromLeaves(leaves);
            String batchId = UUID.randomUUID().toString();
            mapper.insertBatch(batchId, tree.rootHex(), pending.size(), IsoTime.now());
            for (int i = 0; i < pending.size(); i++) {
                String id = (String) pending.get(i).get("id");
                Merkle.Proof proof = tree.proof(i);
                if (mapper.putInBatch(id, batchId, i) != 1) {
                    throw new IllegalStateException("record " + id + " was given a batch by someone else while batch " + batchId + " was being sealed");
                }
                mapper.insertProof(id, batchId, i, Js.stringify(proof.siblings), Js.stringify(proof.directions));
            }
            return batchId;
        });
    }

    /**
     * Commit a sealed batch's root to the chain. Returns the txid.
     *
     * <p>The transaction is written down before it is sent. Between a
     * broadcast and the rows that say so there is a moment in which a stop
     * leaves a batch that looks untouched and a transaction on the network;
     * a retry that funded a new one would then anchor the batch twice. So:
     * sign, record the signed transaction and its name
     * ({@code anchor_attempts}), send, and only then write the batch's rows.
     * Asked again for a batch that has a recorded attempt, the same bytes
     * are sent again — the node answers that it has them — and the rows are
     * written. Only when the node says that what the recorded transaction
     * spends is gone is the attempt marked dead and a new one made.
     *
     * <p>Nothing is written to {@code anchor_txs} before a broadcast
     * succeeded: a row there is a transaction to poll.
     */
    public String anchorBatch(String batchId) throws Exception {
        Map<String, Object> batch = mapper.batch(batchId);
        if (batch == null) {
            throw new ServiceError(404, "batch_not_found", "no batch " + batchId);
        }
        if (!"sealed".equals(batch.get("status"))) {
            throw new ServiceError(409, "batch_not_sealed", "batch " + batchId + " is " + batch.get("status") + ", expected sealed");
        }
        String root = (String) batch.get("merkle_root");
        if (root == null || root.isEmpty()) {
            throw new ServiceError(500, "batch_has_no_root", "batch " + batchId + " has no root");
        }
        byte[] payload = Bc01.encode(Hex.decode(root), Bc01.uuidToBytes(batchId));

        AnchorBackend.Prepared sent = null;
        long attempt = 0;
        Map<String, Object> open = mapper.openAttempt(batchId);
        if (open != null) {
            attempt = ((Number) open.get("attempt")).longValue();
            String txid = (String) open.get("txid");
            if (backend.resend(txid, (String) open.get("raw_tx_hex")) == AnchorBackend.Fate.SENT) {
                sent = new AnchorBackend.Prepared(txid, (String) open.get("raw_tx_hex"), (String) open.get("payload_hex"));
            } else {
                mapper.setAttemptState(batchId, attempt, "dead");
                Log.line("anchor attempt abandoned: what it spends is gone", Log.fields("batchId", batchId, "attempt", attempt, "txid", txid));
            }
        }
        if (sent == null) {
            AnchorBackend.Prepared prepared = backend.prepare(payload);
            // Asked again right before the one step that cannot be taken back.
            if (!lease.stillHeld(LEASE)) {
                throw new IllegalStateException("the worker's lease is another instance's now; nothing was sent for batch " + batchId);
            }
            attempt = mapper.attemptCount(batchId) + 1;
            mapper.insertAttempt(batchId, attempt, prepared.txid, prepared.rawTxHex, prepared.payloadHex);
            backend.send(prepared);
            sent = prepared;
        }

        AnchorBackend.Prepared done = sent;
        long number = attempt;
        return tx.execute((status) -> {
            Map<String, Object> now = mapper.batchForUpdate(batchId);
            if (now == null || !"sealed".equals(now.get("status"))) {
                // Finished by another cycle between the broadcast and here: its rows stand.
                mapper.setAttemptState(batchId, number, "sent");
                return now == null ? done.txid : String.valueOf(now.get("anchor_txid"));
            }
            mapper.insertAnchorTx(done.txid, batchId, backend.network(), done.payloadHex, done.rawTxHex, IsoTime.now());
            if (mapper.markBatchSubmitted(batchId, done.txid) != 1) {
                throw new IllegalStateException("batch " + batchId + " was no longer sealed");
            }
            mapper.markAttestationsSubmitted(batchId);
            mapper.setAttemptState(batchId, number, "sent");
            return done.txid;
        });
    }

    /** The oldest batch still sealed — one whose anchoring did not go through — other than {@code except}. */
    public String oldestSealedBatch(String except) {
        return mapper.oldestSealedBatch(except);
    }

    /**
     * Poll unconfirmed anchors and promote those that have landed in a block.
     * One transaction that cannot be asked about is logged and does not keep
     * the others from being promoted.
     */
    public long refreshConfirmations() {
        long promoted = 0;
        for (Map<String, Object> row : mapper.unconfirmedAnchors()) {
            String txid = (String) row.get("txid");
            String batchId = (String) row.get("batch_id");
            AnchorBackend.State state;
            try {
                state = backend.poll(txid);
            } catch (Exception e) {
                Log.line("anchor poll failed", Log.fields("txid", txid, "error", String.valueOf(e.getMessage())));
                continue;
            }
            if (!state.confirmed) {
                continue;
            }
            Boolean done = tx.execute((status) -> {
                if (mapper.confirmAnchorTx(txid, state.blockHeight, state.blockHash, state.confirmations, IsoTime.now()) != 1) {
                    return false;
                }
                mapper.confirmBatch(batchId);
                mapper.confirmAttestations(batchId);
                return true;
            });
            promoted += Boolean.TRUE.equals(done) ? 1 : 0;
        }
        // Inscriptions are not in anchor_txs — they have no batch — so they are polled on
        // their own reveal transaction.
        for (Map<String, Object> row : mapper.unconfirmedInscriptions()) {
            String id = (String) row.get("id");
            AnchorBackend.State state;
            try {
                state = backend.poll((String) row.get("reveal_txid"));
            } catch (Exception e) {
                Log.line("anchor poll failed", Log.fields("txid", row.get("reveal_txid"), "error", String.valueOf(e.getMessage())));
                continue;
            }
            if (!state.confirmed) {
                continue;
            }
            promoted += mapper.confirmInscription(id, state.blockHeight, state.blockHash, state.confirmations) == 1 ? 1 : 0;
        }
        return promoted;
    }

    /**
     * Whether the transaction of an inscription sits in the node's mempool.
     *
     * <p>An inscription has no batch, so no anchor is ever sent on its behalf
     * — and on a private chain it is the anchor that brings a block. The
     * worker asks this to know that a block is needed there.
     */
    public boolean inscriptionWaitsForABlock() {
        for (Map<String, Object> row : mapper.unconfirmedInscriptions()) {
            try {
                if (backend.waiting((String) row.get("reveal_txid"))) {
                    return true;
                }
            } catch (Exception e) {
                // The node could not say. The refresh that follows asks about the same
                // transaction and logs what is wrong with it.
            }
        }
        return false;
    }

    /**
     * Delete expired free-tier records.
     *
     * <p>Safe because the proof bundle is self-contained: once downloaded it
     * stays verifiable for ever with no reference to us. Retention here is a
     * convenience for someone who has not downloaded it yet, not the custody
     * of their proof. The batch and the anchor transaction are left alone: a
     * batch is shared across many leaves, and someone else's proof may still
     * depend on it. Only the free tier expires — an organisation's records
     * never do.
     */
    public long purgeExpiredPublic() {
        List<String> doomed = mapper.expiredPublic(IsoTime.now());
        if (doomed.isEmpty()) {
            return 0;
        }
        tx.executeWithoutResult((status) -> {
            // The proof refers to the record, so it goes first.
            for (String id : doomed) {
                mapper.deleteProof(id);
                mapper.deleteAttestation(id);
            }
        });
        return doomed.size();
    }
}
