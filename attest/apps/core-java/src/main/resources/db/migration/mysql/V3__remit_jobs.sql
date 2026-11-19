-- Version 3: the settlement rail's work, kept in the store.
--
-- One new table and nothing else. No existing table, column or value is
-- changed: the states a settlement can be in, its events and its webhooks stay
-- exactly what the previous service wrote and reads, so that service can run
-- on this schema as it is (it does not know this table and never reads it).
--
-- What happens to a settlement after its request was answered — the call to
-- the receiving institution, the transfer, the notices, the reconciliation,
-- the evidence package — is a row here before it is done, so that a restart
-- continues it instead of leaving the settlement where it stood.
--
-- Times are times (UTC, to the millisecond), written and compared with the
-- database's own clock, as in version 2: two instances need not agree on the
-- time for a lease to mean the same to both.
--
-- No foreign key on purpose. A key to `orgs` would take a shared lock on the
-- organisation's row with every job inserted, behind the exclusive lock that
-- accepting a settlement holds on that row.

-- `state`     queued -> running -> done; or waiting (to be tried again at
--             `next_attempt_at`), cancelled (the settlement ended first),
--             attention (a person has to look).
-- `open_slot` 1 while the job is open (queued, running, waiting), NULL once
--             it is closed. With the unique key below: a settlement has at
--             most one open job in a lane — the pipeline (travel rule,
--             approval, transfer), the notices, the evidence (reconciliation,
--             package). Closed jobs do not count: NULLs never collide.
-- `lease_owner`, `lease_expires_at`
--             who is running it, and until when that claim holds.
-- `call_started_at`
--             set before the wallet is called: from then on the transfer may
--             have gone out, and nobody but the caller may call again.
-- `idempotency_key`
--             the key the job's outbound call carries; the same on every try.
-- `input`     what the call needs that the settlement's row and events do
--             not hold (JSON). Never personal data in the clear.
CREATE TABLE `remit_jobs` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `kind` varchar(32) COLLATE utf8mb4_bin NOT NULL,
  `lane` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `open_slot` tinyint DEFAULT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `next_attempt_at` datetime(3) NOT NULL,
  `last_error` text COLLATE utf8mb4_bin,
  `lease_owner` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `lease_expires_at` datetime(3) DEFAULT NULL,
  `call_started_at` datetime(3) DEFAULT NULL,
  `idempotency_key` varchar(300) COLLATE utf8mb4_bin DEFAULT NULL,
  `input` mediumtext COLLATE utf8mb4_bin,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `remit_jobs_open` (`payment_id`, `lane`, `open_slot`),
  KEY `remit_jobs_due` (`state`, `next_attempt_at`),
  KEY `remit_jobs_payment` (`payment_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
