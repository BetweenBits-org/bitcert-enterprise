package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.anchor.AnchorBackend;
import com.stonehash.attest.core.anchor.BitcoindRpc;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.attest.BatchMapper;
import com.stonehash.attest.core.attest.BatchService;
import com.stonehash.attest.core.attest.BatchWorker;
import com.stonehash.attest.core.attest.WorkerLease;
import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.format.Bc01;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.PlainError;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * What the batch worker does when things go wrong, on the real store and the
 * real regtest chain: a stop between a broadcast and the rows that record
 * it, a recorded transaction whose coins were spent elsewhere, an instance
 * that does not hold the lease, a transition asked for twice — and what it
 * does not do at all: take an inscription into a batch.
 *
 * <p>Each test makes the broken state with the same pieces the worker uses
 * (the backend, the attempt record) and then lets an ordinary cycle run. No
 * switch for failing exists in the service itself.
 */
class WorkerRecoveryIT {
    private static TestServer server;
    private static AttestService attest;
    private static BatchService batches;
    private static BatchWorker worker;
    private static BatchMapper mapper;
    private static WorkerLease lease;
    private static AnchorBackend backend;
    private static BitcoindRpc rpc;
    private static JdbcTemplate sql;
    private static String wallet;

    @BeforeAll
    static void start() throws Exception {
        server = TestServer.start();
        attest = server.bean(AttestService.class);
        batches = server.bean(BatchService.class);
        worker = server.bean(BatchWorker.class);
        mapper = server.bean(BatchMapper.class);
        lease = server.bean(WorkerLease.class);
        backend = server.bean(AnchorBackend.class);
        rpc = server.bean(BitcoindRpc.class);
        sql = new JdbcTemplate(server.bean(DataSource.class));
        wallet = server.cfg.bitcoind.wallet;
        assertEquals(0L, batches.pendingCount(), "these tests start with nothing waiting in the test schema");
        assertEquals(null, batches.oldestSealedBatch(null), "and no batch left sealed");
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            server.close();
        }
    }

    private static String digest(String label) {
        return Hex.encode(Hex.sha256(label.getBytes(StandardCharsets.UTF_8)));
    }

    /** A new organisation with {@code n} records waiting, sealed into one batch; the batch id. */
    private static String sealedBatchOfNewOrg(String what, int n) {
        String run = UUID.randomUUID().toString().substring(0, 8);
        String org = attest.ensureOrg("it-" + what + "-" + run, "Worker test " + what);
        for (int i = 0; i < n; i++) {
            attest.issue(org, digest(what + " " + run + " " + i), new AttestService.Issue());
        }
        String batchId = batches.sealBatch();
        assertNotNull(batchId);
        assertEquals((long) n, sql.queryForObject("SELECT leaf_count FROM batches WHERE id = ?", Long.class, batchId));
        return batchId;
    }

    private static byte[] payloadOf(String batchId) {
        return Bc01.encode(Hex.decode(sql.queryForObject("SELECT merkle_root FROM batches WHERE id = ?", String.class, batchId)), Bc01.uuidToBytes(batchId));
    }

    private static String status(String batchId) {
        return sql.queryForObject("SELECT status FROM batches WHERE id = ?", String.class, batchId);
    }

    private static List<Map<String, Object>> attempts(String batchId) {
        return sql.queryForList("SELECT attempt, txid, state FROM anchor_attempts WHERE batch_id = ? ORDER BY attempt", batchId);
    }

    private static List<Map<String, Object>> anchors(String batchId) {
        return sql.queryForList("SELECT txid, status FROM anchor_txs WHERE batch_id = ?", batchId);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    /** How many transactions of the wallet carry this payload. */
    private static int transactionsCarrying(byte[] payload) throws Exception {
        String script = Hex.encode(Tx.opReturnScript(payload));
        int found = 0;
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (Map<String, Object> entry : list(rpc.call("listtransactions", Arrays.asList("*", 1000L, 0L, true), wallet))) {
            String txid = (String) entry.get("txid");
            if (!seen.add(txid)) {
                continue;
            }
            Object tx = rpc.call("gettransaction", Collections.singletonList(txid), wallet);
            found += String.valueOf(((Map<?, ?>) tx).get("hex")).contains(script) ? 1 : 0;
        }
        return found;
    }

    /** Cycles until the batch is confirmed. */
    private static void cyclesUntilConfirmed(String batchId) throws Exception {
        for (int i = 0; i < 20 && !"confirmed".equals(status(batchId)); i++) {
            worker.tick();
            Thread.sleep(100);
        }
        assertEquals("confirmed", status(batchId));
    }

    @Test
    void aStopBetweenTheBroadcastAndTheRowsNeverMakesASecondTransaction() throws Exception {
        String batchId = sealedBatchOfNewOrg("stop", 3);
        byte[] payload = payloadOf(batchId);

        // What the worker does up to the broadcast — and then nothing, as if the process had stopped there.
        AnchorBackend.Prepared prepared = backend.prepare(payload);
        mapper.insertAttempt(batchId, 1, prepared.txid, prepared.rawTxHex, prepared.payloadHex);
        backend.send(prepared);
        assertEquals("sealed", status(batchId));
        assertTrue(anchors(batchId).isEmpty(), "no row says the batch was anchored");

        cyclesUntilConfirmed(batchId);

        List<Map<String, Object>> rows = anchors(batchId);
        assertEquals(1, rows.size());
        assertEquals(prepared.txid, rows.get(0).get("txid"), "the transaction that was sent is the batch's anchor");
        assertEquals(1, attempts(batchId).size(), "no second attempt was made");
        assertEquals("sent", attempts(batchId).get(0).get("state"));
        assertEquals(1, transactionsCarrying(payload), "one transaction on the chain carries the batch");
        assertEquals(3L, sql.queryForObject("SELECT COUNT(*) FROM attestations WHERE batch_id = ? AND status = 'confirmed'", Long.class, batchId));
    }

    @Test
    void aStopAfterTheRecordAndBeforeTheBroadcastSendsTheRecordedTransaction() throws Exception {
        String batchId = sealedBatchOfNewOrg("unsent", 2);
        byte[] payload = payloadOf(batchId);
        AnchorBackend.Prepared prepared = backend.prepare(payload);
        mapper.insertAttempt(batchId, 1, prepared.txid, prepared.rawTxHex, prepared.payloadHex);
        // Recorded, never sent.

        cyclesUntilConfirmed(batchId);

        assertEquals(prepared.txid, anchors(batchId).get(0).get("txid"), "the recorded transaction itself was sent");
        assertEquals(1, attempts(batchId).size());
        assertEquals(1, transactionsCarrying(payload));
    }

    @Test
    void aRecordedTransactionWhoseCoinsAreGoneIsAbandonedAndANewOneConfirms() throws Exception {
        String first = sealedBatchOfNewOrg("gone", 2);
        byte[] payload = payloadOf(first);
        AnchorBackend.Prepared prepared = backend.prepare(payload);
        mapper.insertAttempt(first, 1, prepared.txid, prepared.rawTxHex, prepared.payloadHex);

        // Another batch is anchored with the very coins the recorded transaction spends: every
        // other coin of the wallet is held back while it is funded.
        Object decoded = rpc.call("decoderawtransaction", Collections.singletonList(prepared.rawTxHex));
        List<String> spends = new ArrayList<>();
        for (Map<String, Object> in : list(((Map<?, ?>) decoded).get("vin"))) {
            spends.add(in.get("txid") + ":" + ((Double) in.get("vout")).longValue());
        }
        List<Object> others = new ArrayList<>();
        for (Map<String, Object> coin : list(rpc.call("listunspent", Collections.singletonList(0L), wallet))) {
            if (!spends.contains(coin.get("txid") + ":" + ((Double) coin.get("vout")).longValue())) {
                Map<String, Object> ref = new LinkedHashMap<>();
                ref.put("txid", coin.get("txid"));
                ref.put("vout", ((Double) coin.get("vout")).longValue());
                others.add(ref);
            }
        }
        String second = sealedBatchOfNewOrg("taker", 1);
        rpc.call("lockunspent", Arrays.asList(false, others), wallet);
        try {
            assertTrue(lease.take(BatchService.LEASE));
            batches.anchorBatch(second);
        } finally {
            rpc.call("lockunspent", Arrays.asList(true, others), wallet);
        }
        backend.generate(1);

        cyclesUntilConfirmed(first);
        cyclesUntilConfirmed(second);

        List<Map<String, Object>> made = attempts(first);
        assertEquals(2, made.size(), "a new attempt was made");
        assertEquals("dead", made.get(0).get("state"));
        assertEquals("sent", made.get(1).get("state"));
        assertNotEquals(prepared.txid, made.get(1).get("txid"));
        assertEquals(1, anchors(first).size());
        assertEquals(made.get(1).get("txid"), anchors(first).get(0).get("txid"));
        assertEquals(1, transactionsCarrying(payload), "one transaction on the chain carries the batch; the abandoned one never got there");
    }

    @Test
    void anInstanceThatDoesNotHoldTheLeaseDoesNothing() throws Exception {
        // Another instance holds the lease.
        sql.update("DELETE FROM worker_leases WHERE name = ?", BatchService.LEASE);
        sql.update("INSERT INTO worker_leases (name, owner, expires_at, renewed_at) VALUES (?, 'another-instance', UTC_TIMESTAMP(3) + INTERVAL 60 SECOND, UTC_TIMESTAMP(3))", BatchService.LEASE);
        String run = UUID.randomUUID().toString().substring(0, 8);
        String org = attest.ensureOrg("it-lease-" + run, "Worker test lease");
        attest.issue(org, digest("lease " + run), new AttestService.Issue());
        Thread.sleep(server.cfg.batch.flushIntervalMs + 100);
        for (int i = 0; i < 3; i++) {
            worker.tick();
        }
        assertEquals(1L, batches.pendingCount(), "the record still waits");
        assertEquals("another-instance", sql.queryForObject("SELECT owner FROM worker_leases WHERE name = ?", String.class, BatchService.LEASE));

        // A lease that has run out is anyone's.
        sql.update("UPDATE worker_leases SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE name = ?", BatchService.LEASE);
        worker.tick();
        assertEquals(0L, batches.pendingCount(), "with the lease, the record is sealed");
        assertEquals(lease.owner(), sql.queryForObject("SELECT owner FROM worker_leases WHERE name = ?", String.class, BatchService.LEASE));
        String batchId = sql.queryForObject("SELECT batch_id FROM attestations WHERE org_id = ?", String.class, org);
        cyclesUntilConfirmed(batchId);
    }

    @Test
    void anInscriptionWaitsForNoBatchAndIsConfirmedByItsOwnTransaction() throws Exception {
        String run = UUID.randomUUID().toString().substring(0, 8);
        String org = attest.ensureOrg("it-inscribed-" + run, "Worker test inscription");
        byte[] document = ("worker test " + run + ": this document is on the chain itself").getBytes(StandardCharsets.UTF_8);
        String leaf = Hex.encode(Hex.sha256(document));

        Map<String, Object> made = attest.inscribe(org, document, "text/plain", null, "api");
        String id = (String) made.get("id");
        String reveal = (String) made.get("reveal_txid");
        assertEquals("submitted", made.get("status"), "it is on the network when it is answered");
        assertEquals("inscription", made.get("kind"));
        assertEquals(leaf, made.get("leaf_bytes"));
        assertNull(made.get("batch_id"));
        assertEquals(0L, batches.pendingCount(), "an inscription waits for no batch");
        assertTrue(batches.inscriptionWaitsForABlock(), "its transaction is in the mempool");

        // A cycle with nothing to seal: on this private chain the worker makes the block the transaction needs.
        for (int i = 0; i < 20 && !"confirmed".equals(sql.queryForObject("SELECT status FROM attestations WHERE id = ?", String.class, id)); i++) {
            worker.tick();
            Thread.sleep(100);
        }
        Map<String, Object> row = sql.queryForMap("SELECT status, batch_id, leaf_index, block_height, block_hash, confirmations FROM attestations WHERE id = ?", id);
        assertEquals("confirmed", row.get("status"));
        assertNull(row.get("batch_id"));
        assertNull(row.get("leaf_index"));
        Map<?, ?> onChain = (Map<?, ?>) rpc.call("gettransaction", Collections.singletonList(reveal), wallet);
        assertEquals(onChain.get("blockhash"), row.get("block_hash"), "the block it records is the block the node names");
        assertEquals(((Double) onChain.get("blockheight")).longValue(), ((Number) row.get("block_height")).longValue());
        assertFalse(batches.inscriptionWaitsForABlock(), "and no further block is asked for");

        // What the chain holds is the document: read out of the reveal's witness by a reader that is not the writer.
        List<byte[]> witness = WitnessReader.witnessItems(Hex.decode((String) onChain.get("hex")), 0);
        WitnessReader.Envelope envelope = WitnessReader.envelope(witness.get(1));
        assertArrayEquals(document, envelope.body);
        assertEquals("text/plain", envelope.contentType);
        assertEquals("bcrt", envelope.protocolTag);
        assertEquals((String) onChain.get("hex"), made.get("reveal_tx_hex"), "and the bundle carries that very transaction");

        // A digest handed in beside it gets a batch; the inscription is not in it, and stays as it is.
        attest.issue(org, digest("beside the inscription " + run), new AttestService.Issue());
        assertEquals(1L, batches.pendingCount());
        Thread.sleep(server.cfg.batch.flushIntervalMs + 100);
        worker.tick();
        String batchId = sql.queryForObject("SELECT batch_id FROM attestations WHERE org_id = ? AND kind = 'digest'", String.class, org);
        assertNotNull(batchId);
        cyclesUntilConfirmed(batchId);
        assertEquals(1L, sql.queryForObject("SELECT leaf_count FROM batches WHERE id = ?", Long.class, batchId), "the batch holds the digest alone");
        assertEquals(1L, sql.queryForObject("SELECT COUNT(*) FROM batches b WHERE EXISTS (SELECT 1 FROM attestations a WHERE a.batch_id = b.id AND a.org_id = ?)", Long.class, org));
        assertEquals("confirmed", sql.queryForObject("SELECT status FROM attestations WHERE id = ? AND batch_id IS NULL AND leaf_index IS NULL", String.class, id));
        assertEquals(0L, sql.queryForObject("SELECT COUNT(*) FROM merkle_proofs WHERE attestation_id = ?", Long.class, id));

        // Each transition once: a confirmed inscription is not confirmed again, and never put into a batch.
        assertEquals(0, mapper.confirmInscription(id, 1L, "00", 1), "an inscription that is confirmed is not confirmed again");
        assertEquals(0, mapper.putInBatch(id, batchId, 1), "an inscription is not given a batch");

        // The same document again — as a document or as its digest — is the record that exists; nothing more is sent.
        com.stonehash.attest.core.ServiceError again = assertThrows(com.stonehash.attest.core.ServiceError.class, () -> attest.inscribe(org, document, "application/pdf", null, "api"));
        assertEquals("duplicate_digest", again.code());
        assertEquals("this document is already attested as " + id, again.getMessage());
        assertEquals("duplicate_digest", assertThrows(com.stonehash.attest.core.ServiceError.class, () -> attest.issue(org, leaf, new AttestService.Issue())).code());
        assertEquals(1, transactionsCarrying(Hex.decode(leaf)), "one transaction carries the document's digest");

        // Its bundle needs no batch.
        Map<?, ?> bundle = (Map<?, ?>) attest.exportBundle(org, id);
        Map<?, ?> anchor = (Map<?, ?>) bundle.get("anchor");
        assertEquals(reveal, anchor.get("reveal_txid"));
        assertEquals(made.get("commit_txid"), bundle.get("commit_txid"));
        assertNull(bundle.get("merkle"), "no tree: the anchor output is the document's digest itself");
        assertEquals(leaf, anchor.get("op_return_payload_hex"));
        assertEquals(row.get("block_hash"), ((Map<?, ?>) anchor.get("confirmed")).get("block_hash"));
    }

    @Test
    void anInscriptionTheNodeRefusesLeavesNoRecord() throws Exception {
        String run = UUID.randomUUID().toString().substring(0, 8);
        String org = attest.ensureOrg("it-refused-" + run, "Worker test refused inscription");
        byte[] document = ("worker test " + run + ": never inscribed").getBytes(StandardCharsets.UTF_8);
        // Every coin of the wallet is held back: the node cannot fund the commit.
        List<Object> coins = new ArrayList<>();
        for (Map<String, Object> coin : list(rpc.call("listunspent", Collections.singletonList(0L), wallet))) {
            Map<String, Object> ref = new LinkedHashMap<>();
            ref.put("txid", coin.get("txid"));
            ref.put("vout", ((Double) coin.get("vout")).longValue());
            coins.add(ref);
        }
        rpc.call("lockunspent", Arrays.asList(false, coins), wallet);
        PlainError refused;
        try {
            refused = assertThrows(PlainError.class, () -> attest.inscribe(org, document, "text/plain", null, "api"));
        } finally {
            rpc.call("lockunspent", Arrays.asList(true, coins), wallet);
        }
        assertEquals("bitcoind rpc -4: Insufficient funds", refused.getMessage(), "the node's refusal, as the service has always passed it on");
        assertEquals(0L, sql.queryForObject("SELECT COUNT(*) FROM attestations WHERE org_id = ?", Long.class, org), "nothing was recorded");
        assertEquals(0, transactionsCarrying(Hex.sha256(document)), "and nothing was sent");

        // Checked before the wallet is asked for anything: what cannot be inscribed at all.
        assertEquals("document is " + (server.cfg.inscriptionMaxBytes + 1) + " bytes; the inscription limit is " + server.cfg.inscriptionMaxBytes,
                assertThrows(PlainError.class, () -> attest.inscribe(org, new byte[(int) server.cfg.inscriptionMaxBytes + 1], "text/plain", null, "api")).getMessage());
        assertEquals("content_type is mandatory and must be a single push", assertThrows(PlainError.class, () -> attest.inscribe(org, document, "", null, "api")).getMessage());
        assertEquals(0L, sql.queryForObject("SELECT COUNT(*) FROM attestations WHERE org_id = ?", Long.class, org));
    }

    @Test
    void aTransitionAskedForTwiceHappensOnce() throws Exception {
        String batchId = sealedBatchOfNewOrg("twice", 2);
        String member = sql.queryForObject("SELECT id FROM attestations WHERE batch_id = ? AND leaf_index = 0", String.class, batchId);
        assertEquals(0, mapper.putInBatch(member, UUID.randomUUID().toString(), 0), "a record that has a batch is not given another");
        assertTrue(lease.take(BatchService.LEASE));
        String txid = batches.anchorBatch(batchId);
        assertEquals(0, mapper.markBatchSubmitted(batchId, "ff".repeat(32)), "a batch that is submitted is not submitted again");
        com.stonehash.attest.core.ServiceError refused = assertThrows(com.stonehash.attest.core.ServiceError.class, () -> batches.anchorBatch(batchId));
        assertEquals("batch_not_sealed", refused.code());
        assertEquals(txid, sql.queryForObject("SELECT anchor_txid FROM batches WHERE id = ?", String.class, batchId));
        backend.generate(1);
        cyclesUntilConfirmed(batchId);
        assertEquals(0, mapper.confirmAnchorTx(txid, 1L, "00", 1, "2026-01-01T00:00:00.000Z"), "an anchor that is confirmed is not confirmed again");
        assertEquals(1, anchors(batchId).size());
    }
}
