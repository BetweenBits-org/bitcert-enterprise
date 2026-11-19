-- Version 2: what the batch worker needs that the previous service did not keep.
--
-- Two new tables and nothing else. No existing table, column or value is
-- changed, so the previous service can run on this schema as it is (it does
-- not know these tables and never reads them).
--
-- New tables hold times as times (UTC, to the millisecond), compared with the
-- database's own clock — unlike the tables of version 1, whose times are text.

-- Who may work. A worker takes the lease of its name before each cycle and
-- renews it while it works; one that does not hold it does nothing. So two
-- instances started side by side seal and anchor each batch once.
CREATE TABLE `worker_leases` (
  `name` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `owner` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `renewed_at` datetime(3) NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- What was about to be broadcast, written down before it is. An anchor
-- transaction is recorded here once it is signed and before it is sent, so a
-- stop between the broadcast and the writes that follow it is found again:
-- the same transaction is sent once more, never a second one. `state` is
-- `recorded` (signed, perhaps sent), `sent` (the batch's own rows say so too)
-- or `dead` (the node says its inputs are gone; a new attempt was made).
CREATE TABLE `anchor_attempts` (
  `batch_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `attempt` int NOT NULL,
  `txid` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `raw_tx_hex` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `payload_hex` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`batch_id`, `attempt`),
  KEY `anchor_attempts_txid` (`txid`),
  CONSTRAINT `fk_anchor_attempts_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
