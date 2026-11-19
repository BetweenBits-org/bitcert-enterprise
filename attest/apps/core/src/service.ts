/**
 * The service — every state transition an attestation goes through.
 *
 * ## One process, not fourteen
 *
 * Issue, batch, anchor and export live in one module behind one API because they
 * are one workflow with one database. Splitting them across services would buy
 * independent scaling nobody has asked for and cost a message bus, a gateway, a
 * deployment unit per service and a distributed failure mode per boundary.
 * `worker.ts` runs the batcher on a timer inside this process.
 *
 * ## Status is never collapsed
 *
 *   accepted → batched → submitted → confirmed
 *
 * Each step is recorded separately and reported separately. "Anchored" is not a
 * synonym for "submitted": a transaction in the mempool is not yet in a block,
 * and a caller that cannot tell those apart will eventually claim proof it does
 * not have.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MerkleTree } from './merkle/tree.ts';
import { encodeBc01, uuidToBytes } from './btc/bc01.ts';
import { assembleBundle } from './bundle/assemble.ts';
import type { ProofBundleV1 } from './bundle/assemble.ts';
import type { AnchorBackend } from './anchor/backend.ts';
import type { InscriptionResult } from './anchor/inscribe.ts';
import { statementLeaf, verifyStatement } from '@stonehash/attest-verify';
import type { SignedStatement } from '@stonehash/attest-verify';
import { insertionOrder } from './db.ts';
import type { Db } from './db.ts';

const HEX64 = /^[0-9a-f]{64}$/;

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Members that go into the answer beside `error` and `message` — what a
   * caller's program acts on, so that it never has to read it out of the prose.
   */
  readonly detail: Readonly<Record<string, string>> | undefined;
  constructor(status: number, code: string, message: string, detail?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = 'ServiceError';
  }
}

export interface Attestation {
  id: string;
  org_id: string;
  leaf_bytes: string;
  content_type: string | null;
  descriptor: string;
  status: string;
  batch_id: string | null;
  leaf_index: number | null;
  created_at: string;
  source: string;
  expires_at: string | null;
  /** 'digest' — hash only, batched. 'inscription' — document in the witness. */
  kind: string;
  commit_txid: string | null;
  reveal_txid: string | null;
  /** A batched digest's anchoring transaction — the batch's; set by `list()` only. */
  anchor_txid?: string | null;
  reveal_tx_hex: string | null;
  body_length: number | null;
  protocol_tag: string | null;
  /** The issuer statement, verbatim, when the anchor was signed. */
  statement: string | null;
  /**
   * Whether the signing key was one this org had registered at the time.
   *
   * `null` for unsigned anchors. `registered` means the public key in the
   * statement matches one on file; `unregistered` means the signature is
   * arithmetically sound and says nothing about whose key it is. The two are
   * recorded apart rather than collapsed into "signed", because the second
   * proves continuity and the first proves provenance.
   */
  issuer_trust: string | null;
  block_height: number | null;
  block_hash: string | null;
  confirmations: number;
}

const nowIso = (): string => new Date().toISOString();

/**
 * `node:sqlite` types every column as `SQLOutputValue`, so a row needs one
 * deliberate narrowing at the boundary. These two helpers keep that narrowing in
 * one place instead of scattering casts through the query sites — the schema in
 * `db.ts` is the thing that actually guarantees the shape.
 */
function row<T>(v: unknown): T | undefined {
  return v === undefined ? undefined : (v as T);
}
function rows<T>(v: unknown[]): T[] {
  return v as T[];
}

/**
 * Puts a document on the chain and reports where it landed.
 *
 * Injected rather than reached for, so the service can be exercised without a
 * node and so a deployment with no inscription support simply has none — the
 * absence is a missing capability, not a configuration flag to misread.
 */
export type Inscriber = (body: Uint8Array, contentType: string) => Promise<InscriptionResult>;

export class AttestService {
  private readonly db: Db;
  private readonly backend: AnchorBackend;
  private readonly maxLeaves: number;
  private readonly inscriber: Inscriber | null;

  constructor(db: Db, backend: AnchorBackend, maxLeaves: number, inscriber: Inscriber | null = null) {
    this.db = db;
    this.backend = backend;
    this.maxLeaves = maxLeaves;
    this.inscriber = inscriber;
  }

  /** Whether this deployment can inscribe originals, for `/v1/meta` and the console. */
  get canInscribe(): boolean { return this.inscriber !== null; }

  /** The org a slug names, if any — so a caller can refuse to reuse it. */
  async orgBySlug(slug: string): Promise<string | null> {
    return row<{ id: string }>(await this.db.prepare('SELECT id FROM orgs WHERE slug = ?').get(slug))?.id ?? null;
  }

  async ensureOrg(slug: string, name: string): Promise<string> {
    const found = row<{ id: string }>(await this.db.prepare('SELECT id FROM orgs WHERE slug = ?').get(slug));
    if (found) return found.id;
    const id = randomUUID();
    await this.db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, slug, name, nowIso());
    return id;
  }

  /**
   * Accept a document digest. The document itself never arrives — the caller
   * hashes it locally, so file contents never cross the network and we cannot
   * leak what we were never sent.
   */
  async issue(
    orgId: string, leafBytesHex: string, contentType?: string, descriptor?: unknown,
    opts: { source?: 'api' | 'public';
      /** Only with `source: 'public'` — see the check below. */
      expiresAt?: string;
      statement?: SignedStatement;
      /** Billing dimension: which product issued this. Defaults to 'attest'. */
      product?: 'attest' | 'remit' | 'por' } = {},
  ): Promise<Attestation> {
    // Only the anonymous free tier expires. An organisation's records — made
    // with an API key or in the console, in the sandbox or in production — are
    // kept until the organisation asks for them to be deleted, so an expiry on
    // one is a bug to stop here rather than a deadline nothing would honour
    // (the retention sweep deletes `source = 'public'` rows only).
    if (opts.expiresAt !== undefined && opts.source !== 'public') {
      throw new Error('only free-tier records expire; an organisation\'s records are kept until it asks for deletion');
    }
    const leaf = leafBytesHex.toLowerCase();
    if (!HEX64.test(leaf)) {
      throw new ServiceError(400, 'invalid_digest', 'leaf_bytes must be 64 lowercase hex characters (SHA-256)');
    }
    const dup = row<{ id: string }>(
      await this.db.prepare('SELECT id FROM attestations WHERE org_id = ? AND leaf_bytes = ?').get(orgId, leaf));
    if (dup) {
      throw new ServiceError(409, 'duplicate_digest',
        `this digest is already attested as ${dup.id}; a duplicate leaf would make its inclusion proof ambiguous`);
    }
    const trust = opts.statement ? await this.issuerTrust(orgId, opts.statement) : null;
    const id = randomUUID();
    await this.db.prepare(
      `INSERT INTO attestations
         (id, org_id, leaf_bytes, content_type, descriptor, status, created_at, source,
          expires_at, statement, issuer_trust, product)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, leaf, contentType ?? null, JSON.stringify(descriptor ?? {}), nowIso(),
      opts.source ?? 'api', opts.expiresAt ?? null,
      // Verbatim. Re-serialising would change the canonical bytes the
      // signature was made over.
      opts.statement ? JSON.stringify(opts.statement) : null,
      trust,
      opts.product ?? 'attest');
    return (await this.get(orgId, id))!;
  }

  /**
   * Inscribe a document: the bytes go onto the chain, and nowhere else.
   *
   * The caller hands over the document because that is the whole point of this
   * path — the original has to reach Bitcoin, and it cannot do that without
   * passing through here. What it does *not* do is rest anywhere: the buffer is
   * hashed, folded into a tapscript, broadcast, and left to the garbage
   * collector. Nothing is written to disk, no temporary file is opened, and the
   * row this creates holds the reveal transaction — which is public — rather
   * than the document.
   *
   * Unlike `issue`, this both records and anchors, because an inscription is
   * one document per transaction and there is no batch to wait for. The record
   * therefore starts at 'submitted' rather than 'accepted'.
   */
  async inscribe(
    orgId: string, body: Uint8Array, contentType: string, descriptor?: unknown,
    // No `expiresAt`: inscriptions are never free-tier, and only the free tier expires.
    opts: { source?: 'api' | 'public' } = {},
  ): Promise<Attestation> {
    if (!this.inscriber) {
      throw new ServiceError(501, 'inscription_unavailable',
        'this deployment has no inscription backend; only digest anchoring is available');
    }
    const leaf = createHash('sha256').update(body).digest('hex');
    const dup = row<{ id: string }>(
      await this.db.prepare('SELECT id FROM attestations WHERE org_id = ? AND leaf_bytes = ?').get(orgId, leaf));
    if (dup) {
      throw new ServiceError(409, 'duplicate_digest',
        `this document is already attested as ${dup.id}`);
    }

    // Broadcast first. A row written before the chain accepted the transaction
    // would claim an anchor that does not exist, and the failure modes here
    // (insufficient funds, oversize) are exactly the ones worth not recording.
    const r = await this.inscriber(body, contentType);

    const id = randomUUID();
    await this.db.prepare(
      `INSERT INTO attestations
         (id, org_id, leaf_bytes, content_type, descriptor, status, created_at, source,
          expires_at, kind, commit_txid, reveal_txid, reveal_tx_hex, body_length, protocol_tag)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, 'inscription', ?, ?, ?, ?, ?)`,
    ).run(id, orgId, leaf, contentType, JSON.stringify(descriptor ?? {}), nowIso(),
      opts.source ?? 'api', null,
      r.commitTxid, r.revealTxid, r.revealTxHex, r.bodyLength, r.protocolTag);
    return (await this.get(orgId, id))!;
  }

  /**
   * Was this key registered to this org when the record was made?
   *
   * The statement carries its own public key, so a valid signature proves
   * only that whoever holds that key signed — anyone can generate one. What
   * turns that into provenance is the org having said, beforehand, "this key
   * is ours". Matching on the key material rather than on `key_id` is
   * deliberate: the id is derived from the key and carries no authority, so
   * trusting it would let a caller claim a registered id with a different key.
   */
  private async issuerTrust(orgId: string, statement: SignedStatement): Promise<'registered' | 'unregistered'> {
    const hit = row<{ id: string }>(await this.db.prepare(
      `SELECT id FROM issuer_keys
        WHERE org_id = ? AND public_key = ? AND revoked_at IS NULL`,
    ).get(orgId, statement.issuer.public_key));
    return hit ? 'registered' : 'unregistered';
  }

  /** Register a public key so future signatures from it count as provenance. */
  async registerIssuerKey(
    orgId: string, publicKeySpkiBase64: string, label: string, algorithm = 'ES256',
  ): Promise<{ id: string; already: boolean }> {
    const existing = row<{ id: string }>(await this.db.prepare(
      'SELECT id FROM issuer_keys WHERE org_id = ? AND public_key = ? AND revoked_at IS NULL',
    ).get(orgId, publicKeySpkiBase64));
    if (existing) return { id: existing.id, already: true };
    const id = randomUUID();
    await this.db.prepare(
      `INSERT INTO issuer_keys (id, org_id, label, public_key, algorithm, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, label, publicKeySpkiBase64, algorithm, nowIso());
    return { id, already: false };
  }

  async listIssuerKeys(orgId: string): Promise<{ id: string; label: string; algorithm: string;
    public_key: string; created_at: string }[]> {
    return rows(await this.db.prepare(
      `SELECT id, label, algorithm, public_key, created_at FROM issuer_keys
        WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    ).all(orgId));
  }

  /**
   * Revoke a signing key, everywhere it is trusted.
   *
   * Product activation copies the key's public half onto the institution
   * (`institutions.signing_spki`), and the settlement and reserve rails verify
   * partner signatures against that copy, not against `issuer_keys`. A
   * revocation that touched only this table would leave the adapter signing
   * away unchallenged — the console would say "refused from now on" and the
   * rail would keep accepting. So the copy is cleared too, and `requireRemit`
   * / `requirePor` then refuse with `institution_unregistered` until a new
   * key is activated. Signed anchors are unaffected in the other direction:
   * they keep being accepted and report the key as `unregistered`.
   */
  async revokeIssuerKey(orgId: string, id: string): Promise<boolean> {
    const key = (await this.db.prepare(
      'SELECT public_key FROM issuer_keys WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
    ).get(id, orgId)) as unknown as { public_key: string } | undefined;
    if (!key) return false;
    await this.db.prepare(
      'UPDATE issuer_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
    ).run(nowIso(), id, orgId);
    await this.db.prepare(
      'UPDATE institutions SET signing_spki = NULL WHERE org_id = ? AND signing_spki = ?',
    ).run(orgId, key.public_key);
    return true;
  }

  /**
   * Accept a document digest together with the issuer's signature over it.
   *
   * The leaf is **not** the document's digest here — it is the hash of the
   * statement, which already contains both the digest and the signature. One
   * block height therefore timestamps the document and its authorship
   * together, and no witness is needed to do it: the leaf goes into the same
   * Merkle tree as every other record and the root reaches the chain exactly
   * as before. A signed anchor costs no more than an unsigned one.
   *
   * The signature is checked **here**, before anything is stored. A record
   * carrying a signature that does not verify would be worse than no
   * signature at all — it would read as provenance while establishing none,
   * and nobody would discover it until a recipient ran the verifier.
   *
   * What this does *not* check is who the key belongs to. That is a separate
   * question with a separate answer; this establishes only that the holder of
   * the key in the statement signed this document.
   */
  async issueSigned(
    orgId: string, statement: SignedStatement,
    // No `expiresAt`: signed anchors are never free-tier, and only the free tier expires.
    opts: { source?: 'api' | 'public'; descriptor?: unknown } = {},
  ): Promise<Attestation> {
    let leaf: string;
    try {
      leaf = statementLeaf(statement);
    } catch (e) {
      throw new ServiceError(400, 'invalid_statement',
        e instanceof Error ? e.message : 'the statement is malformed');
    }

    const verdict = await verifyStatement(statement, leaf);
    if (!verdict.signatureOk) {
      throw new ServiceError(400, 'invalid_signature',
        verdict.error
          ? `the signature could not be checked: ${verdict.error}`
          : 'the signature does not verify against the public key in the statement');
    }

    return this.issue(orgId, leaf, statement.document.content_type, opts.descriptor, {
      ...(opts.source ? { source: opts.source } : {}),
      statement,
    });
  }

  async get(orgId: string, id: string): Promise<Attestation | null> {
    return row<Attestation>(
      await this.db.prepare('SELECT * FROM attestations WHERE id = ? AND org_id = ?').get(id, orgId)) ?? null;
  }

  /**
   * The list carries each record's anchoring transaction, because the records
   * screen links it: an inscription has its own (`reveal_txid`, on the row), a
   * batched digest shares the batch's — kept on `anchor_txs`, and read here as
   * `anchor_txid` so a confirmed digest no longer lists as "awaiting batch".
   * Read off the batch row, which is where submission records it.
   */
  /**
   * The organisation's newest records, of every product unless one is named.
   *
   * Narrowing is done here rather than by the caller because the limit is
   * applied here: the newest fifty of everything a bank anchored are nearly
   * all settlement evidence, and its document anchors are somewhere behind
   * them. Asked for by product, each product's newest are what comes back.
   */
  async list(orgId: string, limit = 50, product?: 'attest' | 'remit' | 'por'): Promise<Attestation[]> {
    const params = product ? [orgId, product, Math.min(limit, 500)] : [orgId, Math.min(limit, 500)];
    return rows<Attestation>(
      await this.db.prepare(
        `SELECT a.*, b.anchor_txid AS anchor_txid
           FROM attestations a LEFT JOIN batches b ON b.id = a.batch_id
          WHERE a.org_id = ?${product ? ' AND a.product = ?' : ''} ORDER BY a.created_at DESC LIMIT ?`)
        .all(...params));
  }

  /**
   * Fetch a free-tier record by id alone.
   *
   * The id is the capability. A visitor with no account has nothing else to
   * authenticate with, and the id is a v4 UUID handed only to them. It is
   * scoped to `source = 'public'` so this can never reach a customer's record
   * even if an id were guessed.
   */
  async getPublic(id: string): Promise<Attestation | null> {
    return row<Attestation>(await this.db
      .prepare("SELECT * FROM attestations WHERE id = ? AND source = 'public'")
      .get(id)) ?? null;
  }

  /** Find a free-tier record by its digest, for the already-anchored case. */
  async findPublicByDigest(leafBytesHex: string): Promise<Attestation | null> {
    return row<Attestation>(await this.db
      .prepare("SELECT * FROM attestations WHERE leaf_bytes = ? AND source = 'public'")
      .get(leafBytesHex.toLowerCase())) ?? null;
  }

  /**
   * Delete expired free-tier records.
   *
   * Safe because the proof bundle is self-contained: once downloaded it stays
   * verifiable forever with no reference to us. Retention here is a convenience
   * for someone who has not downloaded it yet, not the custody of their proof —
   * so holding it indefinitely would be an obligation with no benefit to them.
   *
   * The batch and the anchor transaction are left alone: a batch is shared
   * across many leaves, and someone else's proof may still depend on it.
   */
  async purgeExpiredPublic(now = new Date()): Promise<number> {
    const cutoff = now.toISOString();
    const doomed = rows<{ id: string }>(await this.db.prepare(
      "SELECT id FROM attestations WHERE source = 'public' AND expires_at IS NOT NULL AND expires_at < ?",
    ).all(cutoff));
    if (doomed.length === 0) return 0;

    await this.db.tx(async (tx) => {
      // `merkle_proofs` references `attestations`, so the dependent row goes
      // first. Deleting in one statement would trip the foreign key.
      const dropProof = tx.prepare('DELETE FROM merkle_proofs WHERE attestation_id = ?');
      const dropAtt = tx.prepare('DELETE FROM attestations WHERE id = ?');
      for (const { id } of doomed) { await dropProof.run(id); await dropAtt.run(id); }
    });
    return doomed.length;
  }

  /** How many free-tier anchors were accepted since `since`. */
  async publicCountSince(sinceIso: string): Promise<number> {
    const r = row<{ n: number }>(await this.db
      .prepare("SELECT COUNT(*) AS n FROM attestations WHERE source = 'public' AND created_at >= ?")
      .get(sinceIso));
    return Number(r?.n ?? 0);
  }

  async pendingCount(): Promise<number> {
    const r = row<{ n: number }>(
      await this.db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE batch_id IS NULL').get());
    return Number(r?.n ?? 0);
  }

  /**
   * Seal every unbatched attestation into one batch, build the tree and store an
   * inclusion proof per leaf. Returns the batch id, or `null` if nothing waited.
   *
   * Ordering is by `created_at, id` — stable and reproducible, so rebuilding the
   * tree from the stored rows yields the same root.
   */
  /**
   * Seal one batch, drawn from a **single organisation**.
   *
   * Batches used to mix every tenant's pending records, which is cheaper —
   * the transaction fee splits across more documents — and was safe while the
   * chain only ever saw a Merkle root. A root is 32 bytes and says nothing
   * about who contributed to it.
   *
   * That stops being true the moment a batch carries issuer statements in its
   * witness, because a statement is readable text: document digest, key id,
   * timestamp. A shared batch would publish every co-tenant's statements to
   * anyone who opens the transaction — our customer list, and each one's
   * volume, on a public chain.
   *
   * So the grouping follows the privacy boundary rather than the cost one.
   * The cost is real: a tenant with one pending record pays for its own
   * transaction instead of a 1/N share.
   */
  async sealBatch(): Promise<string | null> {
    /*
     * Oldest pending record picks the org; everything else from that org
     * joins it. Choosing by age rather than by volume is what keeps a tenant
     * that submits one document from waiting behind one that submits
     * thousands.
     *
     * Ties break on the insertion-order column (`rowid`/`rowseq`), not on `id`. `created_at` is an ISO timestamp
     * with millisecond resolution, so a burst of submissions shares one
     * value and the previous tiebreaker — a random UUID — made the order
     * among them arbitrary. Insertion order is what
     * "oldest" was supposed to mean and what the fairness argument needs.
     */
    const ord = insertionOrder(this.db);
    const head = row<{ org_id: string }>(await this.db.prepare(
      `SELECT org_id FROM attestations
       WHERE batch_id IS NULL ORDER BY created_at ASC, ${ord} ASC LIMIT 1`,
    ).get());
    if (!head) return null;

    const pending = rows<{ id: string; leaf_bytes: string }>(await this.db.prepare(
      `SELECT id, leaf_bytes FROM attestations
       WHERE batch_id IS NULL AND org_id = ? ORDER BY created_at ASC, ${ord} ASC LIMIT ?`,
    ).all(head.org_id, this.maxLeaves));
    if (pending.length === 0) return null;

    const tree = MerkleTree.fromLeaves(pending.map((r) => Buffer.from(r.leaf_bytes, 'hex')));
    const batchId = randomUUID();
    const ts = nowIso();

    await this.db.tx(async (tx) => {
      await tx.prepare(
        `INSERT INTO batches (id, status, merkle_root, leaf_count, opened_at, sealed_at)
         VALUES (?, 'sealed', ?, ?, ?, ?)`,
      ).run(batchId, tree.rootHex(), pending.length, ts, ts);

      const upd = tx.prepare(
        "UPDATE attestations SET batch_id = ?, leaf_index = ?, status = 'batched' WHERE id = ?",
      );
      const ins = tx.prepare(
        `INSERT INTO merkle_proofs (attestation_id, batch_id, leaf_index, siblings, directions)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [i, r] of pending.entries()) {
        const p = tree.proof(i);
        await upd.run(batchId, i, r.id);
        await ins.run(r.id, batchId, i, JSON.stringify(p.siblings), JSON.stringify(p.directions));
      }
    });
    return batchId;
  }

  /** Commit a sealed batch's root to the chain via the configured backend. */
  async anchorBatch(batchId: string): Promise<string> {
    const batch = row<{ id: string; status: string; merkle_root: string | null }>(
      await this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId));
    if (!batch) throw new ServiceError(404, 'batch_not_found', `no batch ${batchId}`);
    if (batch.status !== 'sealed') {
      throw new ServiceError(409, 'batch_not_sealed', `batch ${batchId} is ${batch.status}, expected sealed`);
    }
    if (!batch.merkle_root) throw new ServiceError(500, 'batch_has_no_root', `batch ${batchId} has no root`);

    const payload = encodeBc01(Buffer.from(batch.merkle_root, 'hex'), uuidToBytes(batchId));
    const handle = await this.backend.submit(payload);
    const ts = nowIso();

    await this.db.tx(async (tx) => {
      await tx.prepare(
        `INSERT INTO anchor_txs (txid, batch_id, network, payload_hex, raw_tx_hex, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(handle.txid, batchId, this.backend.network, handle.anchorPayloadHex, handle.rawTxHex, ts);
      await tx.prepare("UPDATE batches SET status = 'submitted', anchor_txid = ? WHERE id = ?")
        .run(handle.txid, batchId);
      await tx.prepare("UPDATE attestations SET status = 'submitted' WHERE batch_id = ?").run(batchId);
    });
    return handle.txid;
  }

  /** Poll unconfirmed anchors and promote them when they land in a block. */
  async refreshConfirmations(): Promise<number> {
    const unconfirmed = rows<{ txid: string; batch_id: string; raw_tx_hex: string; payload_hex: string }>(
      await this.db.prepare(
        "SELECT txid, batch_id, raw_tx_hex, payload_hex FROM anchor_txs WHERE status != 'confirmed'",
      ).all());

    let promoted = 0;
    for (const r of unconfirmed) {
      const state = await this.backend.poll({
        txid: r.txid, rawTxHex: r.raw_tx_hex, anchorPayloadHex: r.payload_hex,
      });
      if (state.status !== 'confirmed') continue;
      await this.db.tx(async (tx) => {
        await tx.prepare(
          `UPDATE anchor_txs SET status = 'confirmed', block_height = ?, block_hash = ?,
             confirmations = ?, confirmed_at = ? WHERE txid = ?`,
        ).run(state.blockHeight ?? null, state.blockHash ?? null, state.confirmations ?? 1, nowIso(), r.txid);
        await tx.prepare("UPDATE batches SET status = 'confirmed' WHERE id = ?").run(r.batch_id);
        await tx.prepare("UPDATE attestations SET status = 'confirmed' WHERE batch_id = ?").run(r.batch_id);
      });
      promoted++;
    }

    // Inscriptions are not in `anchor_txs` — they have no batch — so they are
    // polled on their own reveal transaction.
    const pending = rows<{ id: string; reveal_txid: string; reveal_tx_hex: string; leaf_bytes: string }>(
      await this.db.prepare(
        "SELECT id, reveal_txid, reveal_tx_hex, leaf_bytes FROM attestations "
        + "WHERE kind = 'inscription' AND status != 'confirmed' AND reveal_txid IS NOT NULL",
      ).all());
    for (const r of pending) {
      const state = await this.backend.poll({
        txid: r.reveal_txid, rawTxHex: r.reveal_tx_hex, anchorPayloadHex: r.leaf_bytes,
      });
      if (state.status !== 'confirmed') continue;
      await this.db.prepare(
        `UPDATE attestations SET status = 'confirmed', block_height = ?, block_hash = ?,
           confirmations = ? WHERE id = ?`,
      ).run(state.blockHeight ?? null, state.blockHash ?? null, state.confirmations ?? 1, r.id);
      promoted++;
    }
    return promoted;
  }

  /**
   * Export the proof bundle — the whole product in one file.
   *
   * Refuses before the batch is anchored rather than emitting a bundle with an
   * empty anchor section. A caller who received one would have something that
   * looks like a proof and is not.
   */
  /**
   * Bundle for an inscription — no tree, and the original is already inside.
   *
   * The reveal transaction is the whole proof: its output commits the digest
   * (and the txid covers that), its witness carries the bytes (and the txid
   * does not). A reader needs nothing else from us, and crucially needs no
   * copy of the document, because recovering it *is* the verification step.
   */
  private witnessBundleFor(att: Attestation): ProofBundleV1 {
    if (!att.reveal_txid || !att.reveal_tx_hex) {
      throw new ServiceError(500, 'inscription_incomplete',
        'this inscription has no reveal transaction recorded');
    }
    return assembleBundle({
      leafBytesHex: att.leaf_bytes,
      ...(att.content_type ? { contentType: att.content_type } : {}),
      ...(att.statement ? { statement: JSON.parse(att.statement) as Record<string, unknown> } : {}),
      descriptor: {
        attestation_id: att.id,
        ...(JSON.parse(att.descriptor) as Record<string, unknown>),
      },
      anchor: {
        txid: att.reveal_txid,
        rawTxHex: att.reveal_tx_hex,
        // In this mode the anchor output *is* the leaf, which is what makes
        // the bundle self-contained without a Merkle section.
        payloadHex: att.leaf_bytes,
        witnessEnvelope: {
          inputIndex: 0,
          ...(att.content_type ? { contentType: att.content_type } : {}),
          ...(att.protocol_tag ? { protocolTag: att.protocol_tag } : {}),
        },
        ...(att.status === 'confirmed'
          ? {
              confirmed: {
                ...(att.block_height !== null ? { blockHeight: att.block_height } : {}),
                ...(att.block_hash !== null ? { blockHash: att.block_hash } : {}),
                confirmations: att.confirmations,
              },
            }
          : {}),
      },
      ...(att.commit_txid ? { commitTxid: att.commit_txid } : {}),
      network: this.backend.network,
      generatedAt: nowIso(),
    });
  }

  async exportBundle(orgId: string, attestationId: string): Promise<ProofBundleV1> {
    const att = await this.get(orgId, attestationId);
    if (!att) throw new ServiceError(404, 'not_found', `no attestation ${attestationId}`);
    return this.bundleFor(att);
  }

  /** Free-tier export. Authenticated by possession of the id. */
  async exportPublicBundle(attestationId: string): Promise<ProofBundleV1> {
    const att = await this.getPublic(attestationId);
    if (!att) {
      throw new ServiceError(404, 'not_found',
        `no free-tier anchor ${attestationId}. Free anchors are retrievable for a limited window; `
        + 'a downloaded bundle stays verifiable indefinitely without us.');
    }
    return this.bundleFor(att);
  }

  private async bundleFor(att: Attestation): Promise<ProofBundleV1> {
    if (att.kind === 'inscription') return this.witnessBundleFor(att);
    const attestationId = att.id;
    if (!att.batch_id) {
      throw new ServiceError(409, 'not_batched',
        'this attestation is accepted but not yet in a batch, so no proof exists yet');
    }
    const proof = row<{ leaf_index: number; siblings: string; directions: string }>(
      await this.db.prepare('SELECT * FROM merkle_proofs WHERE attestation_id = ?').get(attestationId));
    const batch = row<{ merkle_root: string }>(
      await this.db.prepare('SELECT merkle_root FROM batches WHERE id = ?').get(att.batch_id));
    const anchor = row<{
      txid: string; raw_tx_hex: string; payload_hex: string; status: string;
      block_height: number | null; block_hash: string | null; confirmations: number;
    }>(await this.db.prepare('SELECT * FROM anchor_txs WHERE batch_id = ?').get(att.batch_id));

    if (!proof || !batch) throw new ServiceError(500, 'proof_missing', 'batch is sealed but its proof is absent');
    if (!anchor) {
      throw new ServiceError(409, 'not_anchored',
        'this batch is sealed but not yet submitted to the chain, so there is nothing to anchor against');
    }

    return assembleBundle({
      leafBytesHex: att.leaf_bytes,
      ...(att.content_type ? { contentType: att.content_type } : {}),
      ...(att.statement ? { statement: JSON.parse(att.statement) as Record<string, unknown> } : {}),
      descriptor: {
        attestation_id: att.id,
        batch_id: att.batch_id,
        ...(JSON.parse(att.descriptor) as Record<string, unknown>),
      },
      merkle: {
        root: batch.merkle_root,
        siblings: JSON.parse(proof.siblings) as string[],
        directions: JSON.parse(proof.directions) as ('left' | 'right')[],
        leafIndex: proof.leaf_index,
      },
      anchor: {
        txid: anchor.txid,
        rawTxHex: anchor.raw_tx_hex,
        payloadHex: anchor.payload_hex,
        ...(anchor.status === 'confirmed'
          ? {
              confirmed: {
                ...(anchor.block_height !== null ? { blockHeight: anchor.block_height } : {}),
                ...(anchor.block_hash !== null ? { blockHash: anchor.block_hash } : {}),
                confirmations: anchor.confirmations,
              },
            }
          : {}),
      },
      network: this.backend.network,
      generatedAt: nowIso(),
    });
  }
}
