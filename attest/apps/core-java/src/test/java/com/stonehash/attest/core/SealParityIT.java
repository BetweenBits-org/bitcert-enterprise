package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.attest.BatchService;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Seals everything that waits in the test schema, one batch after another —
 * the Java half of {@code tools/compare-sealing.mjs}, which gives the
 * reference service and this one the same waiting records and then requires
 * the same batches: the same roots, the same leaf index for every record,
 * the same proofs.
 *
 * <p>Inscriptions are in that schema too, without a batch — and stay so: an
 * inscription does not wait for anything, and no batch takes it.
 */
class SealParityIT {
    @Test
    void sealsEverythingThatWaits() throws Exception {
        try (TestServer server = TestServer.start()) {
            BatchService batches = server.bean(BatchService.class);
            JdbcTemplate sql = new JdbcTemplate(server.bean(DataSource.class));
            String loose = "SELECT COUNT(*) FROM attestations WHERE kind = 'inscription' AND batch_id IS NULL";
            long inscriptions = sql.queryForObject(loose, Long.class);
            int sealed = 0;
            while (batches.sealBatch() != null) {
                sealed++;
                // Batches are told apart by when they were sealed.
                Thread.sleep(3);
            }
            assertTrue(batches.pendingCount() == 0, "nothing waits any more");
            assertTrue(sql.queryForObject("SELECT COUNT(*) FROM attestations WHERE batch_id IS NULL AND kind <> 'inscription'", Long.class) == 0, "no digest is left without a batch");
            assertTrue(sql.queryForObject(loose, Long.class) == inscriptions, "every inscription that had no batch still has none");
            System.out.println("sealed " + sealed + " batches; " + inscriptions + " inscriptions left alone");
        }
    }
}
