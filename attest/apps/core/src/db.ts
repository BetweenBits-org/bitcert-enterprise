/**
 * Storage — one async interface, two engines.
 *
 * ## Why MySQL is the primary engine
 *
 * This sandbox is the commercial module: the same tree deployed on a
 * production instance is the paid product, so the store it runs against must
 * be the store production runs against. That is MySQL (8.0, InnoDB,
 * utf8mb4_bin). Set `STONEHASH_DB_URL=mysql://user:pass@host:3306/db` and
 * every record — attestations, batches, anchors, accounts, remit, PoR —
 * lives there.
 *
 * ## Why SQLite is still here
 *
 * Unit tests need a database that exists before the test and not after.
 * `openDb(':memory:')` gives them one with zero setup, running the same SQL
 * through the same interface. It is also the fallback when no
 * `STONEHASH_DB_URL` is configured, so `node src/main.ts` on a bare machine
 * still boots. It is not the production engine.
 *
 * ## The interface
 *
 * `db.prepare(sql).get/all/run(...)` — the same shape the code always had,
 * now returning promises, because MySQL has no synchronous client. The SQL
 * in call sites is the common subset both engines execute verbatim; the few
 * statements that genuinely differ (upserts, insertion-order expressions)
 * branch on `db.dialect` at the call site, where the divergence is visible.
 *
 * Transactions go through `db.tx(fn)`: MySQL runs `fn` on a dedicated pooled
 * connection; SQLite serialises every operation on one queue, so a
 * transaction body cannot be interleaved with another request's statements —
 * which is exactly the hazard an async SQLite transaction would otherwise
 * invite.
 *
 * ## Environment separation
 *
 * `test` and `live` get different databases (a different file, or a
 * different schema in the DSN), not a shared one with an `env` column. There
 * is no query path that could join across them.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';

export type AttestationStatus = 'accepted' | 'batched' | 'submitted' | 'confirmed';
export type BatchStatus = 'open' | 'sealed' | 'submitted' | 'confirmed';

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface DbStatement {
  get(...params: SqlParam[]): Promise<unknown>;
  all(...params: SqlParam[]): Promise<unknown[]>;
  run(...params: SqlParam[]): Promise<{ changes: number }>;
}

export interface Db {
  readonly dialect: 'sqlite' | 'mysql';
  prepare(sql: string): DbStatement;
  /** One statement, DDL or control. Multi-statement strings are SQLite-only. */
  exec(sql: string): Promise<void>;
  /**
   * Atomic block. The `tx` handed to `fn` is the only handle that may touch
   * the database inside the block; statements on the outer `db` would run on
   * a different connection (MySQL) or deadlock the queue (SQLite).
   */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The column that reproduces insertion order within equal `created_at`.
 * SQLite has `rowid` for free; MySQL gets an AUTO_INCREMENT `rowseq` on the
 * one table whose batching semantics depend on it.
 */
export function insertionOrder(db: Db): string {
  return db.dialect === 'sqlite' ? 'rowid' : 'rowseq';
}

/**
 * A LIKE pattern that finds `needle` anywhere in a column, on both engines.
 *
 * Upper-cased, for a caller that writes `UPPER(col) LIKE ? ESCAPE '!'`:
 * utf8mb4_bin (MySQL) and default LIKE (SQLite) disagree on case, and
 * normalising both sides keeps the two engines answering alike. `!` is the
 * escape character and the caller must declare it — MySQL defaults to
 * backslash and SQLite to nothing, so an id with an underscore in it was
 * findable on one engine and not the other until the wildcards were made
 * literal here.
 */
/**
 * Did this statement fail because the row is there already (a primary or a
 * unique key)? Each engine says it in its own words; a caller that wants to
 * answer "exists" instead of failing asks here rather than reading them.
 */
export function isDuplicateKeyError(e: unknown): boolean {
  const err = e as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) return true;
  return typeof err.message === 'string' && /UNIQUE constraint failed|Duplicate entry/i.test(err.message);
}

export function likeContains(needle: string): string {
  return `%${needle.toUpperCase().replace(/[%_!]/g, (ch) => `!${ch}`)}%`;
}

/* ------------------------------------------------------------------ */
/* SQLite DDL — kept byte-identical in meaning to the original schema. */
/* ------------------------------------------------------------------ */

const SQLITE_TABLES = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  merkle_root     TEXT,
  leaf_count      INTEGER NOT NULL DEFAULT 0,
  opened_at       TEXT NOT NULL,
  sealed_at       TEXT,
  anchor_txid     TEXT
);

CREATE TABLE IF NOT EXISTS attestations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  leaf_bytes    TEXT NOT NULL,
  content_type  TEXT,
  descriptor    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL,
  batch_id      TEXT REFERENCES batches(id),
  leaf_index    INTEGER,
  created_at    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'api',
  expires_at    TEXT,
  CHECK (length(leaf_bytes) = 64),
  UNIQUE (org_id, leaf_bytes)
);

CREATE TABLE IF NOT EXISTS merkle_proofs (
  attestation_id TEXT PRIMARY KEY REFERENCES attestations(id),
  batch_id       TEXT NOT NULL REFERENCES batches(id),
  leaf_index     INTEGER NOT NULL,
  siblings       TEXT NOT NULL,
  directions     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchor_txs (
  txid             TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL REFERENCES batches(id),
  network          TEXT NOT NULL,
  payload_hex      TEXT NOT NULL,
  raw_tx_hex       TEXT NOT NULL,
  status           TEXT NOT NULL,
  block_height     INTEGER,
  block_hash       TEXT,
  confirmations    INTEGER NOT NULL DEFAULT 0,
  submitted_at     TEXT NOT NULL,
  confirmed_at     TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  created_at     TEXT NOT NULL,
  last_login_at  TEXT,
  disabled_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);

CREATE TABLE IF NOT EXISTS issuer_keys (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  label       TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  algorithm   TEXT NOT NULL DEFAULT 'ES256',
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  at           TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  actor_label  TEXT NOT NULL,
  service      TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL
);
`;

const SQLITE_REMIT_TABLES = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  product     TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'sandbox',
  status      TEXT NOT NULL DEFAULT 'active',
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, product)
);

CREATE TABLE IF NOT EXISTS institutions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT REFERENCES orgs(id),
  role            TEXT NOT NULL,
  name            TEXT NOT NULL,
  country         TEXT,
  signing_spki    TEXT,
  -- An EXCHANGE institution only: the public key of the console's reserve
  -- screen, accepted beside signing_spki and never in place of it.
  console_spki    TEXT,
  encryption_jwk  TEXT,
  authority       TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remit_quotes (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  corridor_origin      TEXT NOT NULL,
  corridor_destination TEXT NOT NULL,
  request              TEXT NOT NULL,
  response             TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remit_payments (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL REFERENCES orgs(id),
  quote_id                TEXT NOT NULL REFERENCES remit_quotes(id),
  state                   TEXT NOT NULL,
  corridor_origin         TEXT NOT NULL,
  corridor_destination    TEXT NOT NULL,
  trade_currency          TEXT NOT NULL,
  trade_amount            TEXT NOT NULL,
  collect_currency        TEXT NOT NULL,
  collect_amount          TEXT NOT NULL,
  usdc_amount             TEXT NOT NULL,
  payout_currency         TEXT NOT NULL,
  payout_amount           TEXT NOT NULL,
  beneficiary_institution TEXT NOT NULL,
  deposit_address         TEXT,
  chain_tx                TEXT,
  evidence_level          TEXT,
  request_body            TEXT NOT NULL,
  verdict                 TEXT,
  package_json            TEXT,
  commitment              TEXT,
  nonce                   TEXT,
  attestation_id          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remit_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES remit_payments(id),
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  sig         TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (payment_id, seq)
);

CREATE TABLE IF NOT EXISTS remit_travel_rule (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES remit_payments(id),
  protocol      TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  ivms101_digest TEXT NOT NULL,
  status        TEXT NOT NULL,
  response      TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remit_idempotency (
  org_id          TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (org_id, idem_key)
);

CREATE TABLE IF NOT EXISTS remit_source_refs (
  payment_id    TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  message_type  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  idx           INTEGER NOT NULL DEFAULT 0,
  uetr          TEXT,
  value_date    TEXT,
  content       TEXT,
  twin_key      TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, uetr),
  UNIQUE (org_id, sha256, idx)
);

CREATE TABLE IF NOT EXISTS remit_source_matches (
  org_id      TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  idx         INTEGER NOT NULL DEFAULT 0,
  payment_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (org_id, sha256, idx)
);

CREATE TABLE IF NOT EXISTS remit_webhook_deliveries (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  payment_id      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  url             TEXT NOT NULL,
  body            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  last_error      TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS por_snapshots (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  institution_id  TEXT NOT NULL,
  status          TEXT NOT NULL,
  statement       TEXT NOT NULL,
  sig             TEXT NOT NULL,
  commitment      TEXT NOT NULL,
  root            TEXT NOT NULL,
  asof            TEXT NOT NULL,
  leaf_count      INTEGER NOT NULL,
  totals          TEXT NOT NULL,
  challenge       TEXT NOT NULL,
  problems        TEXT,
  reserves        TEXT,
  attestation_id  TEXT,
  -- The public key the statement's signature was verified against when the
  -- snapshot was accepted. The institution's key can be replaced or revoked
  -- later; what was published under the old one has to go on verifying.
  signing_spki    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remit_manifests (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  date            TEXT NOT NULL,
  manifest        TEXT NOT NULL,
  sig             TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  platform_sig    TEXT NOT NULL,
  commitment      TEXT NOT NULL,
  attestation_id  TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (org_id, date)
);
`;

const SQLITE_INDEXES = `
CREATE INDEX IF NOT EXISTS attestations_open ON attestations(status) WHERE batch_id IS NULL;
CREATE INDEX IF NOT EXISTS attestations_batch ON attestations(batch_id);
CREATE INDEX IF NOT EXISTS attestations_expiry ON attestations(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS anchor_txs_batch ON anchor_txs(batch_id);
CREATE INDEX IF NOT EXISTS anchor_txs_pending ON anchor_txs(status) WHERE status != 'confirmed';
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS accounts_org ON accounts(org_id);
CREATE INDEX IF NOT EXISTS attestations_org_created ON attestations(org_id, created_at);
CREATE INDEX IF NOT EXISTS por_snapshots_org ON por_snapshots(org_id, created_at);
CREATE INDEX IF NOT EXISTS remit_events_payment ON remit_events(payment_id, seq);
CREATE INDEX IF NOT EXISTS remit_payments_org ON remit_payments(org_id, created_at);
CREATE INDEX IF NOT EXISTS remit_payments_org_state ON remit_payments(org_id, state, created_at);
CREATE INDEX IF NOT EXISTS remit_webhook_pending
  ON remit_webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS remit_source_refs_twin ON remit_source_refs(org_id, twin_key);
CREATE INDEX IF NOT EXISTS remit_source_refs_content ON remit_source_refs(org_id, content);
CREATE INDEX IF NOT EXISTS remit_source_matches_payment ON remit_source_matches(org_id, payment_id, sha256);
CREATE INDEX IF NOT EXISTS remit_payments_anchor
  ON remit_payments(attestation_id) WHERE attestation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_org_at ON audit_log(org_id, at, id);
`;

/* ---------------------------------------------------------------- */
/* MySQL DDL — same tables, typed for InnoDB.                        */
/*                                                                   */
/* Translation rules, applied uniformly:                             */
/*   - ids / hashes / enums / timestamps -> VARCHAR (indexable);     */
/*     payloads (JSON, hex, ciphertext)  -> MEDIUMTEXT (16 MB).      */
/*   - utf8mb4_bin collation: comparisons stay byte-exact, which is  */
/*     what SQLite was doing and what hashes and emails require.     */
/*   - Inline REFERENCES is parsed-but-ignored by MySQL, so every    */
/*     foreign key is a table-level constraint here.                 */
/*   - TEXT columns cannot take a literal DEFAULT; the three that    */
/*     had one use an expression default ('{}' / '[]').              */
/*   - Partial indexes do not exist; each becomes a composite over   */
/*     (predicate column, indexed column).                           */
/*   - `rowseq` replaces SQLite's rowid where insertion order is     */
/*     load-bearing (attestation batching).                          */
/* ---------------------------------------------------------------- */

const MYSQL_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS orgs (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    slug        VARCHAR(191) NOT NULL UNIQUE,
    name        TEXT         NOT NULL,
    created_at  VARCHAR(40)  NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id      VARCHAR(64)  NOT NULL,
    key_hash    VARCHAR(128) NOT NULL UNIQUE,
    prefix      VARCHAR(32)  NOT NULL,
    label       VARCHAR(191) NOT NULL DEFAULT '',
    created_at  VARCHAR(40)  NOT NULL,
    revoked_at  VARCHAR(40)  NULL,
    CONSTRAINT fk_api_keys_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS batches (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    status          VARCHAR(16)  NOT NULL,
    merkle_root     VARCHAR(128) NULL,
    leaf_count      INT          NOT NULL DEFAULT 0,
    opened_at       VARCHAR(40)  NOT NULL,
    sealed_at       VARCHAR(40)  NULL,
    anchor_txid     VARCHAR(128) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS attestations (
    id            VARCHAR(64)  NOT NULL PRIMARY KEY,
    rowseq        BIGINT       NOT NULL AUTO_INCREMENT UNIQUE,
    org_id        VARCHAR(64)  NOT NULL,
    leaf_bytes    CHAR(64)     NOT NULL,
    content_type  VARCHAR(255) NULL,
    descriptor    MEDIUMTEXT   NOT NULL,
    status        VARCHAR(16)  NOT NULL,
    batch_id      VARCHAR(64)  NULL,
    leaf_index    INT          NULL,
    created_at    VARCHAR(40)  NOT NULL,
    source        VARCHAR(16)  NOT NULL DEFAULT 'api',
    expires_at    VARCHAR(40)  NULL,
    kind          VARCHAR(16)  NOT NULL DEFAULT 'digest',
    commit_txid   VARCHAR(128) NULL,
    reveal_txid   VARCHAR(128) NULL,
    reveal_tx_hex MEDIUMTEXT   NULL,
    body_length   INT          NULL,
    protocol_tag  VARCHAR(64)  NULL,
    block_height  INT          NULL,
    block_hash    VARCHAR(128) NULL,
    confirmations INT          NOT NULL DEFAULT 0,
    statement     MEDIUMTEXT   NULL,
    issuer_trust  VARCHAR(16)  NULL,
    product       VARCHAR(16)  NOT NULL DEFAULT 'attest',
    CHECK (CHAR_LENGTH(leaf_bytes) = 64),
    UNIQUE KEY attestations_org_leaf (org_id, leaf_bytes),
    CONSTRAINT fk_attestations_org   FOREIGN KEY (org_id)   REFERENCES orgs(id),
    CONSTRAINT fk_attestations_batch FOREIGN KEY (batch_id) REFERENCES batches(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS merkle_proofs (
    attestation_id VARCHAR(64)  NOT NULL PRIMARY KEY,
    batch_id       VARCHAR(64)  NOT NULL,
    leaf_index     INT          NOT NULL,
    siblings       MEDIUMTEXT   NOT NULL,
    directions     MEDIUMTEXT   NOT NULL,
    CONSTRAINT fk_proofs_att   FOREIGN KEY (attestation_id) REFERENCES attestations(id),
    CONSTRAINT fk_proofs_batch FOREIGN KEY (batch_id)       REFERENCES batches(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS anchor_txs (
    txid             VARCHAR(128) NOT NULL PRIMARY KEY,
    batch_id         VARCHAR(64)  NOT NULL,
    network          VARCHAR(16)  NOT NULL,
    payload_hex      MEDIUMTEXT   NOT NULL,
    raw_tx_hex       MEDIUMTEXT   NOT NULL,
    status           VARCHAR(16)  NOT NULL,
    block_height     INT          NULL,
    block_hash       VARCHAR(128) NULL,
    confirmations    INT          NOT NULL DEFAULT 0,
    submitted_at     VARCHAR(40)  NOT NULL,
    confirmed_at     VARCHAR(40)  NULL,
    CONSTRAINT fk_anchor_txs_batch FOREIGN KEY (batch_id) REFERENCES batches(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS accounts (
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    email          VARCHAR(320) NOT NULL UNIQUE,
    password_hash  VARCHAR(512) NOT NULL,
    org_id         VARCHAR(64)  NOT NULL,
    created_at     VARCHAR(40)  NOT NULL,
    last_login_at  VARCHAR(40)  NULL,
    disabled_at    VARCHAR(40)  NULL,
    CONSTRAINT fk_accounts_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash  VARCHAR(128) NOT NULL PRIMARY KEY,
    account_id  VARCHAR(64)  NOT NULL,
    created_at  VARCHAR(40)  NOT NULL,
    expires_at  VARCHAR(40)  NOT NULL,
    user_agent  TEXT         NULL,
    CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS issuer_keys (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id      VARCHAR(64)  NOT NULL,
    label       VARCHAR(191) NOT NULL,
    public_key  TEXT         NOT NULL,
    algorithm   VARCHAR(16)  NOT NULL DEFAULT 'ES256',
    created_at  VARCHAR(40)  NOT NULL,
    revoked_at  VARCHAR(40)  NULL,
    CONSTRAINT fk_issuer_keys_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id           VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id       VARCHAR(64)  NOT NULL,
    at           VARCHAR(40)  NOT NULL,
    actor_type   VARCHAR(16)  NOT NULL,
    actor_id     VARCHAR(64)  NOT NULL,
    actor_label  VARCHAR(320) NOT NULL,
    service      VARCHAR(16)  NOT NULL,
    method       VARCHAR(16)  NOT NULL,
    path         VARCHAR(512) NOT NULL,
    status       INT          NOT NULL,
    duration_ms  INT          NOT NULL,
    CONSTRAINT fk_audit_log_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id      VARCHAR(64)  NOT NULL,
    product     VARCHAR(16)  NOT NULL,
    plan        VARCHAR(32)  NOT NULL DEFAULT 'sandbox',
    status      VARCHAR(16)  NOT NULL DEFAULT 'active',
    config      MEDIUMTEXT   NOT NULL,
    created_at  VARCHAR(40)  NOT NULL,
    UNIQUE KEY subscriptions_org_product (org_id, product),
    CONSTRAINT fk_subscriptions_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS institutions (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id          VARCHAR(64)  NULL,
    role            VARCHAR(32)  NOT NULL,
    name            TEXT         NOT NULL,
    country         VARCHAR(8)   NULL,
    signing_spki    TEXT         NULL,
    console_spki    TEXT         NULL,
    encryption_jwk  TEXT         NULL,
    authority       MEDIUMTEXT   NOT NULL,
    created_at      VARCHAR(40)  NOT NULL,
    CONSTRAINT fk_institutions_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_quotes (
    id                   VARCHAR(64) NOT NULL PRIMARY KEY,
    org_id               VARCHAR(64) NOT NULL,
    corridor_origin      VARCHAR(8)  NOT NULL,
    corridor_destination VARCHAR(8)  NOT NULL,
    request              MEDIUMTEXT  NOT NULL,
    response             MEDIUMTEXT  NOT NULL,
    expires_at           VARCHAR(40) NOT NULL,
    created_at           VARCHAR(40) NOT NULL,
    CONSTRAINT fk_remit_quotes_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_payments (
    id                      VARCHAR(128) NOT NULL PRIMARY KEY,
    org_id                  VARCHAR(64)  NOT NULL,
    quote_id                VARCHAR(64)  NOT NULL,
    state                   VARCHAR(40)  NOT NULL,
    corridor_origin         VARCHAR(8)   NOT NULL,
    corridor_destination    VARCHAR(8)   NOT NULL,
    trade_currency          VARCHAR(8)   NOT NULL,
    trade_amount            VARCHAR(64)  NOT NULL,
    collect_currency        VARCHAR(8)   NOT NULL,
    collect_amount          VARCHAR(64)  NOT NULL,
    usdc_amount             VARCHAR(64)  NOT NULL,
    payout_currency         VARCHAR(8)   NOT NULL,
    payout_amount           VARCHAR(64)  NOT NULL,
    beneficiary_institution VARCHAR(128) NOT NULL,
    deposit_address         VARCHAR(128) NULL,
    chain_tx                VARCHAR(191) NULL,
    evidence_level          VARCHAR(8)   NULL,
    request_body            MEDIUMTEXT   NOT NULL,
    verdict                 MEDIUMTEXT   NULL,
    package_json            MEDIUMTEXT   NULL,
    commitment              VARCHAR(128) NULL,
    nonce                   VARCHAR(64)  NULL,
    attestation_id          VARCHAR(64)  NULL,
    created_at              VARCHAR(40)  NOT NULL,
    updated_at              VARCHAR(40)  NOT NULL,
    CONSTRAINT fk_remit_payments_org   FOREIGN KEY (org_id)   REFERENCES orgs(id),
    CONSTRAINT fk_remit_payments_quote FOREIGN KEY (quote_id) REFERENCES remit_quotes(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_events (
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    payment_id  VARCHAR(128) NOT NULL,
    seq         INT          NOT NULL,
    type        VARCHAR(48)  NOT NULL,
    issuer      VARCHAR(128) NOT NULL,
    payload     MEDIUMTEXT   NOT NULL,
    sig         TEXT         NULL,
    created_at  VARCHAR(40)  NOT NULL,
    UNIQUE KEY remit_events_payment_seq (payment_id, seq),
    CONSTRAINT fk_remit_events_payment FOREIGN KEY (payment_id) REFERENCES remit_payments(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_travel_rule (
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    payment_id     VARCHAR(128) NOT NULL,
    protocol       VARCHAR(32)  NOT NULL,
    recipient      VARCHAR(128) NOT NULL,
    ciphertext     MEDIUMTEXT   NOT NULL,
    ivms101_digest VARCHAR(128) NOT NULL,
    status         VARCHAR(16)  NOT NULL,
    response       MEDIUMTEXT   NULL,
    created_at     VARCHAR(40)  NOT NULL,
    CONSTRAINT fk_remit_tr_payment FOREIGN KEY (payment_id) REFERENCES remit_payments(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_idempotency (
    org_id          VARCHAR(64)  NOT NULL,
    idem_key        VARCHAR(191) NOT NULL,
    request_hash    VARCHAR(128) NOT NULL,
    response_status INT          NOT NULL,
    response_body   MEDIUMTEXT   NOT NULL,
    created_at      VARCHAR(40)  NOT NULL,
    PRIMARY KEY (org_id, idem_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_source_refs (
    payment_id    VARCHAR(128) NOT NULL PRIMARY KEY,
    org_id        VARCHAR(64)  NOT NULL,
    message_type  VARCHAR(40)  NOT NULL,
    sha256        VARCHAR(64)  NOT NULL,
    idx           INT          NOT NULL DEFAULT 0,
    uetr          VARCHAR(36)  NULL,
    value_date    VARCHAR(10)  NULL,
    content       VARCHAR(64)  NULL,
    twin_key      VARCHAR(64)  NULL,
    created_at    VARCHAR(40)  NOT NULL,
    UNIQUE KEY remit_source_refs_uetr (org_id, uetr),
    UNIQUE KEY remit_source_refs_message (org_id, sha256, idx)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_source_matches (
    org_id      VARCHAR(64)  NOT NULL,
    sha256      VARCHAR(64)  NOT NULL,
    idx         INT          NOT NULL DEFAULT 0,
    payment_id  VARCHAR(128) NOT NULL,
    created_at  VARCHAR(40)  NOT NULL,
    PRIMARY KEY (org_id, sha256, idx)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_webhook_deliveries (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    payment_id      VARCHAR(128) NOT NULL,
    event_id        VARCHAR(64)  NOT NULL,
    url             TEXT         NOT NULL,
    body            MEDIUMTEXT   NOT NULL,
    attempts        INT          NOT NULL DEFAULT 0,
    status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
    last_error      TEXT         NULL,
    next_attempt_at VARCHAR(40)  NOT NULL,
    created_at      VARCHAR(40)  NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS por_snapshots (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    institution_id  VARCHAR(64)  NOT NULL,
    status          VARCHAR(24)  NOT NULL,
    statement       MEDIUMTEXT   NOT NULL,
    sig             TEXT         NOT NULL,
    commitment      VARCHAR(128) NOT NULL,
    root            VARCHAR(128) NOT NULL,
    asof            VARCHAR(40)  NOT NULL,
    leaf_count      INT          NOT NULL,
    totals          MEDIUMTEXT   NOT NULL,
    challenge       MEDIUMTEXT   NOT NULL,
    problems        MEDIUMTEXT   NULL,
    reserves        MEDIUMTEXT   NULL,
    attestation_id  VARCHAR(64)  NULL,
    signing_spki    TEXT         NULL,
    created_at      VARCHAR(40)  NOT NULL,
    updated_at      VARCHAR(40)  NOT NULL,
    CONSTRAINT fk_por_snapshots_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,

  `CREATE TABLE IF NOT EXISTS remit_manifests (
    id              VARCHAR(64)  NOT NULL PRIMARY KEY,
    org_id          VARCHAR(64)  NOT NULL,
    date            VARCHAR(16)  NOT NULL,
    manifest        MEDIUMTEXT   NOT NULL,
    sig             TEXT         NOT NULL,
    verdict         MEDIUMTEXT   NOT NULL,
    platform_sig    TEXT         NOT NULL,
    commitment      VARCHAR(128) NOT NULL,
    attestation_id  VARCHAR(64)  NULL,
    created_at      VARCHAR(40)  NOT NULL,
    UNIQUE KEY remit_manifests_org_date (org_id, date),
    CONSTRAINT fk_remit_manifests_org FOREIGN KEY (org_id) REFERENCES orgs(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

/** MySQL has no partial indexes and no CREATE INDEX IF NOT EXISTS. */
const MYSQL_INDEXES: { name: string; table: string; ddl: string }[] = [
  { name: 'attestations_open',        table: 'attestations', ddl: 'CREATE INDEX attestations_open ON attestations(batch_id, status)' },
  { name: 'attestations_open_order',  table: 'attestations', ddl: 'CREATE INDEX attestations_open_order ON attestations(batch_id, created_at)' },
  { name: 'attestations_expiry',      table: 'attestations', ddl: 'CREATE INDEX attestations_expiry ON attestations(expires_at)' },
  { name: 'attestations_org_created', table: 'attestations', ddl: 'CREATE INDEX attestations_org_created ON attestations(org_id, created_at)' },
  { name: 'anchor_txs_pending',       table: 'anchor_txs',   ddl: 'CREATE INDEX anchor_txs_pending ON anchor_txs(status)' },
  { name: 'sessions_expiry',          table: 'sessions',     ddl: 'CREATE INDEX sessions_expiry ON sessions(expires_at)' },
  { name: 'por_snapshots_org',        table: 'por_snapshots', ddl: 'CREATE INDEX por_snapshots_org ON por_snapshots(org_id, created_at)' },
  { name: 'remit_payments_org',       table: 'remit_payments', ddl: 'CREATE INDEX remit_payments_org ON remit_payments(org_id, created_at)' },
  { name: 'remit_payments_org_state', table: 'remit_payments', ddl: 'CREATE INDEX remit_payments_org_state ON remit_payments(org_id, state, created_at)' },
  { name: 'remit_payments_anchor',    table: 'remit_payments', ddl: 'CREATE INDEX remit_payments_anchor ON remit_payments(attestation_id)' },
  { name: 'remit_webhook_pending',    table: 'remit_webhook_deliveries', ddl: 'CREATE INDEX remit_webhook_pending ON remit_webhook_deliveries(status, next_attempt_at)' },
  { name: 'remit_source_refs_twin',    table: 'remit_source_refs', ddl: 'CREATE INDEX remit_source_refs_twin ON remit_source_refs(org_id, twin_key)' },
  { name: 'remit_source_refs_content', table: 'remit_source_refs', ddl: 'CREATE INDEX remit_source_refs_content ON remit_source_refs(org_id, content)' },
  { name: 'remit_source_matches_payment', table: 'remit_source_matches', ddl: 'CREATE INDEX remit_source_matches_payment ON remit_source_matches(org_id, payment_id, sha256)' },
  { name: 'audit_log_org_at',         table: 'audit_log',    ddl: 'CREATE INDEX audit_log_org_at ON audit_log(org_id, at, id)' },
];

/**
 * Columns added after a table first shipped — applied only when absent, so
 * any vintage of database migrates at boot. On MySQL a fresh install already
 * has all of them in CREATE TABLE; this path exists for databases created
 * before a column was introduced.
 */
/**
 * A data fix run on every open — idempotent, and cheap because it touches only
 * rows that still carry an expiry, which `attestations_expiry` finds.
 *
 * Only the anonymous free tier expires. An organisation's records are kept
 * until it asks for them to be deleted, in the sandbox and in production
 * alike. The console used to stamp its own records with a 30-day expiry that
 * nothing honoured (the retention sweep deletes `source = 'public'` rows
 * only); clearing the stamps means no reader takes them for a deadline, on
 * whichever database this code is pointed at.
 */
const CLEAR_ORG_EXPIRY =
  "UPDATE attestations SET expires_at = NULL WHERE source <> 'public' AND expires_at IS NOT NULL";

const ADDED_COLUMNS: { table: string; column: string; sqlite: string; mysql: string }[] = [
  { table: 'attestations', column: 'source',
    sqlite: "ALTER TABLE attestations ADD COLUMN source TEXT NOT NULL DEFAULT 'api'",
    mysql: "ALTER TABLE attestations ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'api'" },
  { table: 'attestations', column: 'expires_at',
    sqlite: 'ALTER TABLE attestations ADD COLUMN expires_at TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN expires_at VARCHAR(40) NULL' },
  { table: 'attestations', column: 'kind',
    sqlite: "ALTER TABLE attestations ADD COLUMN kind TEXT NOT NULL DEFAULT 'digest'",
    mysql: "ALTER TABLE attestations ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'digest'" },
  { table: 'attestations', column: 'commit_txid',
    sqlite: 'ALTER TABLE attestations ADD COLUMN commit_txid TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN commit_txid VARCHAR(128) NULL' },
  { table: 'attestations', column: 'reveal_txid',
    sqlite: 'ALTER TABLE attestations ADD COLUMN reveal_txid TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN reveal_txid VARCHAR(128) NULL' },
  { table: 'attestations', column: 'reveal_tx_hex',
    sqlite: 'ALTER TABLE attestations ADD COLUMN reveal_tx_hex TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN reveal_tx_hex MEDIUMTEXT NULL' },
  { table: 'attestations', column: 'body_length',
    sqlite: 'ALTER TABLE attestations ADD COLUMN body_length INTEGER',
    mysql: 'ALTER TABLE attestations ADD COLUMN body_length INT NULL' },
  { table: 'attestations', column: 'protocol_tag',
    sqlite: 'ALTER TABLE attestations ADD COLUMN protocol_tag TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN protocol_tag VARCHAR(64) NULL' },
  { table: 'attestations', column: 'block_height',
    sqlite: 'ALTER TABLE attestations ADD COLUMN block_height INTEGER',
    mysql: 'ALTER TABLE attestations ADD COLUMN block_height INT NULL' },
  { table: 'attestations', column: 'block_hash',
    sqlite: 'ALTER TABLE attestations ADD COLUMN block_hash TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN block_hash VARCHAR(128) NULL' },
  { table: 'attestations', column: 'confirmations',
    sqlite: 'ALTER TABLE attestations ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 0',
    mysql: 'ALTER TABLE attestations ADD COLUMN confirmations INT NOT NULL DEFAULT 0' },
  { table: 'attestations', column: 'statement',
    sqlite: 'ALTER TABLE attestations ADD COLUMN statement TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN statement MEDIUMTEXT NULL' },
  { table: 'attestations', column: 'issuer_trust',
    sqlite: 'ALTER TABLE attestations ADD COLUMN issuer_trust TEXT',
    mysql: 'ALTER TABLE attestations ADD COLUMN issuer_trust VARCHAR(16) NULL' },
  { table: 'por_snapshots', column: 'reserves',
    sqlite: 'ALTER TABLE por_snapshots ADD COLUMN reserves TEXT',
    mysql: 'ALTER TABLE por_snapshots ADD COLUMN reserves MEDIUMTEXT NULL' },
  { table: 'institutions', column: 'console_spki',
    sqlite: 'ALTER TABLE institutions ADD COLUMN console_spki TEXT',
    mysql: 'ALTER TABLE institutions ADD COLUMN console_spki TEXT NULL' },
  { table: 'por_snapshots', column: 'signing_spki',
    sqlite: 'ALTER TABLE por_snapshots ADD COLUMN signing_spki TEXT',
    mysql: 'ALTER TABLE por_snapshots ADD COLUMN signing_spki TEXT NULL' },
  { table: 'attestations', column: 'product',
    sqlite: "ALTER TABLE attestations ADD COLUMN product TEXT NOT NULL DEFAULT 'attest'",
    mysql: "ALTER TABLE attestations ADD COLUMN product VARCHAR(16) NOT NULL DEFAULT 'attest'" },
];

/* ---------------------------------------------------------------- */
/* Adapters                                                          */
/* ---------------------------------------------------------------- */

/** mysql2 rejects `undefined` and SQLite rejects booleans; normalise both. */
function norm(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as SqlParam;
  });
}

/**
 * SQLite behind the async interface.
 *
 * Every operation goes through one promise chain. That is not a performance
 * concession — node:sqlite is synchronous underneath, so each step is
 * microseconds — it is the correctness device that makes `tx()` safe: while
 * a transaction body runs, no other request's statement can slip onto the
 * connection and silently join the open transaction.
 */
class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private readonly raw: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(raw: DatabaseSync) { this.raw = raw; }

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(op);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  prepare(sql: string): DbStatement {
    return {
      get: (...p) => this.enqueue(() => this.raw.prepare(sql).get(...(norm(p) as never[]))),
      all: (...p) => this.enqueue(() => this.raw.prepare(sql).all(...(norm(p) as never[])) as unknown[]),
      run: (...p) => this.enqueue(() => {
        const r = this.raw.prepare(sql).run(...(norm(p) as never[]));
        return { changes: Number(r.changes) };
      }),
    };
  }

  exec(sql: string): Promise<void> { return this.enqueue(() => { this.raw.exec(sql); }); }

  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // The inner handle runs statements directly: the queue slot is already
    // ours for the whole block, and enqueueing from inside it would deadlock.
    const direct: Db = {
      dialect: 'sqlite',
      prepare: (sql: string) => ({
        get: async (...p: SqlParam[]) => this.raw.prepare(sql).get(...(norm(p) as never[])),
        all: async (...p: SqlParam[]) => this.raw.prepare(sql).all(...(norm(p) as never[])) as unknown[],
        run: async (...p: SqlParam[]) => {
          const r = this.raw.prepare(sql).run(...(norm(p) as never[]));
          return { changes: Number(r.changes) };
        },
      }),
      exec: async (sql: string) => { this.raw.exec(sql); },
      tx: () => { throw new Error('nested transactions are not supported'); },
      close: async () => { throw new Error('close() inside a transaction'); },
    };
    return this.enqueue(async () => {
      this.raw.exec('BEGIN');
      try {
        const out = await fn(direct);
        this.raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    });
  }

  async close(): Promise<void> { await this.chain; this.raw.close(); }
}

/** One pooled connection (or the pool itself) behind the same interface. */
class MysqlDb implements Db {
  readonly dialect = 'mysql' as const;
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  /**
   * `rowseq` is MySQL plumbing (insertion order), not part of any record's
   * shape. Rows cross this boundary without it so a `SELECT *` cannot leak
   * it into an API response the SQLite engine would never produce.
   */
  private static strip(rows: Record<string, unknown>[]): unknown[] {
    for (const r of rows) if ('rowseq' in r) delete r.rowseq;
    return rows;
  }

  prepare(sql: string): DbStatement {
    return MysqlDb.statement(this.pool, sql);
  }

  static statement(conn: Pool | PoolConnection, sql: string): DbStatement {
    return {
      get: async (...p) => {
        const [rows] = await conn.execute(sql, norm(p));
        return (MysqlDb.strip(rows as Record<string, unknown>[]) as unknown[])[0];
      },
      all: async (...p) => {
        const [rows] = await conn.execute(sql, norm(p));
        return MysqlDb.strip(rows as Record<string, unknown>[]);
      },
      run: async (...p) => {
        const [r] = await conn.execute(sql, norm(p));
        return { changes: (r as ResultSetHeader).affectedRows ?? 0 };
      },
    };
  }

  async exec(sql: string): Promise<void> { await this.pool.query(sql); }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    const inner: Db = {
      dialect: 'mysql',
      prepare: (sql: string) => MysqlDb.statement(conn, sql),
      exec: async (sql: string) => { await conn.query(sql); },
      tx: () => { throw new Error('nested transactions are not supported'); },
      close: async () => { throw new Error('close() inside a transaction'); },
    };
    try {
      await conn.beginTransaction();
      const out = await fn(inner);
      await conn.commit();
      return out;
    } catch (e) {
      try { await conn.rollback(); } catch { /* connection may be gone */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/* ---------------------------------------------------------------- */
/* Bootstrap                                                         */
/* ---------------------------------------------------------------- */

type Log = (msg: string, extra?: Record<string, unknown>) => void;

async function bootstrapMysql(url: string, log?: Log): Promise<Db> {
  const u = new URL(url);
  const database = u.pathname.replace(/^\//, '');
  if (!database) throw new Error('STONEHASH_DB_URL must name a database, e.g. mysql://user:pass@host:3306/stonehash_attest');
  const pool = createPool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4_bin',
  });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => {});
    throw new Error(`cannot reach MySQL at ${u.hostname}:${u.port || 3306}/${database} — ${(e as Error).message}`);
  }

  for (const ddl of MYSQL_TABLES) await pool.query(ddl);

  // Column migrations for databases created before a column existed.
  const applied: string[] = [];
  for (const { table, column, mysql } of ADDED_COLUMNS) {
    const [cols] = await pool.execute(
      `SELECT column_name AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    if ((cols as unknown[]).length > 0) continue;
    await pool.query(mysql);
    applied.push(`${table}.${column}`);
  }
  if (applied.length > 0) log?.('schema columns added', { columns: applied });

  // No CREATE INDEX IF NOT EXISTS in MySQL: consult the catalogue instead.
  const [idx] = await pool.query(
    `SELECT DISTINCT index_name AS n FROM information_schema.statistics
     WHERE table_schema = DATABASE()`,
  );
  const existing = new Set((idx as { n: string }[]).map((r) => r.n));
  for (const { name, ddl } of MYSQL_INDEXES) {
    if (existing.has(name)) continue;
    await pool.query(ddl);
  }

  const [cleared] = await pool.query(CLEAR_ORG_EXPIRY);
  const clearedCount = Number((cleared as { affectedRows?: number }).affectedRows ?? 0);
  if (clearedCount > 0) log?.('expiry cleared from organisation records', { count: clearedCount });

  log?.('storage ready', { engine: 'mysql', database });
  return new MysqlDb(pool);
}

function bootstrapSqlite(dbPath: string, log?: Log): Db {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec(SQLITE_TABLES);
  raw.exec(SQLITE_REMIT_TABLES);
  const applied: string[] = [];
  for (const { table, column, sqlite } of ADDED_COLUMNS) {
    const existing = raw.prepare('SELECT name FROM pragma_table_info(?)').all(table) as
      unknown as { name: string }[];
    if (existing.length === 0) continue;
    if (existing.some((c) => c.name === column)) continue;
    raw.exec(sqlite);
    applied.push(`${table}.${column}`);
  }
  if (applied.length > 0) log?.('schema columns added', { columns: applied });
  raw.exec(SQLITE_INDEXES);
  const clearedCount = Number(raw.prepare(CLEAR_ORG_EXPIRY).run().changes);
  if (clearedCount > 0) log?.('expiry cleared from organisation records', { count: clearedCount });
  return new SqliteDb(raw);
}

/**
 * Open the store named by `target`:
 *   - `mysql://user:pass@host:port/db` — the production engine;
 *   - a file path or `:memory:`        — SQLite, for tests and bare boots.
 */
export async function openDb(target: string, log?: Log): Promise<Db> {
  if (target.startsWith('mysql://')) return bootstrapMysql(target, log);
  return bootstrapSqlite(target, log);
}
