-- Version 1: the schema as the service this one replaces left it.
--
-- Taken from the live schema with SHOW CREATE TABLE (tools/dump-schema.mjs,
-- tools/make-baseline.mjs) — 22 tables, MySQL 8.0.46, utf8mb4_bin.
-- Do not edit: a schema built from this file is compared with the live one,
-- catalogue row by catalogue row (tools/compare-schema.mjs), and has to be
-- the same. On the live schema this version is not run; it is recorded as
-- already there (the baseline step). Everything after it is a migration of
-- its own.
--
-- Times are text columns holding UTC with milliseconds and a Z
-- (2026-11-18T06:00:00.000Z), compared and sorted as text.

CREATE TABLE `batches` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `merkle_root` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `leaf_count` int NOT NULL DEFAULT '0',
  `opened_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `sealed_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  `anchor_txid` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `anchor_txs` (
  `txid` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `batch_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `network` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `payload_hex` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `raw_tx_hex` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `block_height` int DEFAULT NULL,
  `block_hash` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `confirmations` int NOT NULL DEFAULT '0',
  `submitted_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `confirmed_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`txid`),
  KEY `fk_anchor_txs_batch` (`batch_id`),
  KEY `anchor_txs_pending` (`status`),
  CONSTRAINT `fk_anchor_txs_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `orgs` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `slug` varchar(191) COLLATE utf8mb4_bin NOT NULL,
  `name` text COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `accounts` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `email` varchar(320) COLLATE utf8mb4_bin NOT NULL,
  `password_hash` varchar(512) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `last_login_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  `disabled_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `fk_accounts_org` (`org_id`),
  CONSTRAINT `fk_accounts_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `api_keys` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `key_hash` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `prefix` varchar(32) COLLATE utf8mb4_bin NOT NULL,
  `label` varchar(191) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `revoked_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `key_hash` (`key_hash`),
  KEY `fk_api_keys_org` (`org_id`),
  CONSTRAINT `fk_api_keys_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `attestations` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `rowseq` bigint NOT NULL AUTO_INCREMENT,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `leaf_bytes` char(64) COLLATE utf8mb4_bin NOT NULL,
  `content_type` varchar(255) COLLATE utf8mb4_bin DEFAULT NULL,
  `descriptor` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `batch_id` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `leaf_index` int DEFAULT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `source` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'api',
  `expires_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  `kind` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'digest',
  `commit_txid` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `reveal_txid` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `reveal_tx_hex` mediumtext COLLATE utf8mb4_bin,
  `body_length` int DEFAULT NULL,
  `protocol_tag` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `block_height` int DEFAULT NULL,
  `block_hash` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `confirmations` int NOT NULL DEFAULT '0',
  `statement` mediumtext COLLATE utf8mb4_bin,
  `issuer_trust` varchar(16) COLLATE utf8mb4_bin DEFAULT NULL,
  `product` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'attest',
  PRIMARY KEY (`id`),
  UNIQUE KEY `rowseq` (`rowseq`),
  UNIQUE KEY `attestations_org_leaf` (`org_id`,`leaf_bytes`),
  KEY `attestations_open` (`batch_id`,`status`),
  KEY `attestations_open_order` (`batch_id`,`created_at`),
  KEY `attestations_expiry` (`expires_at`),
  KEY `attestations_org_created` (`org_id`,`created_at`),
  CONSTRAINT `fk_attestations_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
  CONSTRAINT `fk_attestations_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`),
  CONSTRAINT `attestations_chk_1` CHECK ((char_length(`leaf_bytes`) = 64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `audit_log` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `actor_type` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `actor_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `actor_label` varchar(320) COLLATE utf8mb4_bin NOT NULL,
  `service` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `method` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `path` varchar(512) COLLATE utf8mb4_bin NOT NULL,
  `status` int NOT NULL,
  `duration_ms` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `audit_log_org_at` (`org_id`,`at`,`id`),
  CONSTRAINT `fk_audit_log_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `institutions` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `role` varchar(32) COLLATE utf8mb4_bin NOT NULL,
  `name` text COLLATE utf8mb4_bin NOT NULL,
  `country` varchar(8) COLLATE utf8mb4_bin DEFAULT NULL,
  `signing_spki` text COLLATE utf8mb4_bin,
  `encryption_jwk` text COLLATE utf8mb4_bin,
  `authority` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `console_spki` text COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`),
  KEY `fk_institutions_org` (`org_id`),
  CONSTRAINT `fk_institutions_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `issuer_keys` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `label` varchar(191) COLLATE utf8mb4_bin NOT NULL,
  `public_key` text COLLATE utf8mb4_bin NOT NULL,
  `algorithm` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'ES256',
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `revoked_at` varchar(40) COLLATE utf8mb4_bin DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_issuer_keys_org` (`org_id`),
  CONSTRAINT `fk_issuer_keys_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `merkle_proofs` (
  `attestation_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `batch_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `leaf_index` int NOT NULL,
  `siblings` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `directions` mediumtext COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`attestation_id`),
  KEY `fk_proofs_batch` (`batch_id`),
  CONSTRAINT `fk_proofs_att` FOREIGN KEY (`attestation_id`) REFERENCES `attestations` (`id`),
  CONSTRAINT `fk_proofs_batch` FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `por_snapshots` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `institution_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(24) COLLATE utf8mb4_bin NOT NULL,
  `statement` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `sig` text COLLATE utf8mb4_bin NOT NULL,
  `commitment` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `root` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `asof` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `leaf_count` int NOT NULL,
  `totals` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `challenge` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `problems` mediumtext COLLATE utf8mb4_bin,
  `reserves` mediumtext COLLATE utf8mb4_bin,
  `attestation_id` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `updated_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `signing_spki` text COLLATE utf8mb4_bin,
  PRIMARY KEY (`id`),
  KEY `por_snapshots_org` (`org_id`,`created_at`),
  CONSTRAINT `fk_por_snapshots_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_idempotency` (
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `idem_key` varchar(191) COLLATE utf8mb4_bin NOT NULL,
  `request_hash` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `response_status` int NOT NULL,
  `response_body` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`org_id`,`idem_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_manifests` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `date` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `manifest` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `sig` text COLLATE utf8mb4_bin NOT NULL,
  `verdict` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `platform_sig` text COLLATE utf8mb4_bin NOT NULL,
  `commitment` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `attestation_id` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `remit_manifests_org_date` (`org_id`,`date`),
  CONSTRAINT `fk_remit_manifests_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_quotes` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `corridor_origin` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `corridor_destination` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `request` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `response` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `expires_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_remit_quotes_org` (`org_id`),
  CONSTRAINT `fk_remit_quotes_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_payments` (
  `id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `quote_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `state` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `corridor_origin` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `corridor_destination` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `trade_currency` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `trade_amount` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `collect_currency` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `collect_amount` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `usdc_amount` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `payout_currency` varchar(8) COLLATE utf8mb4_bin NOT NULL,
  `payout_amount` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `beneficiary_institution` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `deposit_address` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `chain_tx` varchar(191) COLLATE utf8mb4_bin DEFAULT NULL,
  `evidence_level` varchar(8) COLLATE utf8mb4_bin DEFAULT NULL,
  `request_body` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `verdict` mediumtext COLLATE utf8mb4_bin,
  `package_json` mediumtext COLLATE utf8mb4_bin,
  `commitment` varchar(128) COLLATE utf8mb4_bin DEFAULT NULL,
  `nonce` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `attestation_id` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `updated_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_remit_payments_quote` (`quote_id`),
  KEY `remit_payments_org` (`org_id`,`created_at`),
  KEY `remit_payments_org_state` (`org_id`,`state`,`created_at`),
  KEY `remit_payments_anchor` (`attestation_id`),
  CONSTRAINT `fk_remit_payments_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`),
  CONSTRAINT `fk_remit_payments_quote` FOREIGN KEY (`quote_id`) REFERENCES `remit_quotes` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_events` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `seq` int NOT NULL,
  `type` varchar(48) COLLATE utf8mb4_bin NOT NULL,
  `issuer` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `payload` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `sig` text COLLATE utf8mb4_bin,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `remit_events_payment_seq` (`payment_id`,`seq`),
  CONSTRAINT `fk_remit_events_payment` FOREIGN KEY (`payment_id`) REFERENCES `remit_payments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_source_matches` (
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `sha256` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `idx` int NOT NULL DEFAULT '0',
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`org_id`,`sha256`,`idx`),
  KEY `remit_source_matches_payment` (`org_id`,`payment_id`,`sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_source_refs` (
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `message_type` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `sha256` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `idx` int NOT NULL DEFAULT '0',
  `uetr` varchar(36) COLLATE utf8mb4_bin DEFAULT NULL,
  `value_date` varchar(10) COLLATE utf8mb4_bin DEFAULT NULL,
  `content` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `twin_key` varchar(64) COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`payment_id`),
  UNIQUE KEY `remit_source_refs_message` (`org_id`,`sha256`,`idx`),
  UNIQUE KEY `remit_source_refs_uetr` (`org_id`,`uetr`),
  KEY `remit_source_refs_twin` (`org_id`,`twin_key`),
  KEY `remit_source_refs_content` (`org_id`,`content`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_travel_rule` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `protocol` varchar(32) COLLATE utf8mb4_bin NOT NULL,
  `recipient` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `ciphertext` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `ivms101_digest` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `response` mediumtext COLLATE utf8mb4_bin,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_remit_tr_payment` (`payment_id`),
  CONSTRAINT `fk_remit_tr_payment` FOREIGN KEY (`payment_id`) REFERENCES `remit_payments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `remit_webhook_deliveries` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `payment_id` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `event_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `url` text COLLATE utf8mb4_bin NOT NULL,
  `body` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'pending',
  `last_error` text COLLATE utf8mb4_bin,
  `next_attempt_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  KEY `remit_webhook_pending` (`status`,`next_attempt_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `sessions` (
  `token_hash` varchar(128) COLLATE utf8mb4_bin NOT NULL,
  `account_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `expires_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  `user_agent` text COLLATE utf8mb4_bin,
  PRIMARY KEY (`token_hash`),
  KEY `fk_sessions_account` (`account_id`),
  KEY `sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_sessions_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE `subscriptions` (
  `id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `org_id` varchar(64) COLLATE utf8mb4_bin NOT NULL,
  `product` varchar(16) COLLATE utf8mb4_bin NOT NULL,
  `plan` varchar(32) COLLATE utf8mb4_bin NOT NULL DEFAULT 'sandbox',
  `status` varchar(16) COLLATE utf8mb4_bin NOT NULL DEFAULT 'active',
  `config` mediumtext COLLATE utf8mb4_bin NOT NULL,
  `created_at` varchar(40) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `subscriptions_org_product` (`org_id`,`product`),
  CONSTRAINT `fk_subscriptions_org` FOREIGN KEY (`org_id`) REFERENCES `orgs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
