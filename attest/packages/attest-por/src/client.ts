/**
 * PorClient — the exchange side of the snapshot protocol, as a library: sign
 * the statement with your registered key, hand it to the platform, wait for
 * the anchor.
 *
 * What is transmitted, in full:
 *
 *   by default      the statement and its signature. Root, totals, the number
 *                   of accounts, the as-of time. No account, no balance, no
 *                   leaf. The platform checks the signature and anchors.
 *
 *   with a spot     the same, and then — for the eight accounts the platform
 *   check           picks at random — each one's hashed identifier, salt and
 *                   balances, with the sums beside it up the tree. That is
 *                   account-level data leaving the building, pseudonymously,
 *                   and it is why the spot check is something the exchange
 *                   asks for rather than something it gets.
 *
 * The tree and every leaf stay in this process either way.
 */
import type { KeyObject } from 'node:crypto';
import { provePorLeaf } from './sumtree.ts';
import type { PorLeafInput, PorTree } from './sumtree.ts';
import type { PorSnapshotStatement } from './snapshot.ts';
import { publicSpkiBase64, signSnapshotStatement } from './sign.ts';
import type { PorSignature, PorSubmission } from './sign.ts';
import type { PorInclusionProof } from '@stonehash/attest-verify';

export interface PorClientOptions {
  core: string;
  apiKey: string;
  institutionId: string;
  institutionName: string;
  /** Needed to sign; a client that only submits files signed elsewhere can omit it. */
  key?: KeyObject;
}

export class PorApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The local tree, needed only to answer a spot check. */
export interface PorSpotCheckSource {
  tree: PorTree;
  leaves: PorLeafInput[];
}

export interface PorPublishResult {
  snapshotId: string;
  attestationId: string;
  /** ACCEPTED: anchored on the signature alone. VERIFIED: the spot check passed first. */
  status: 'ACCEPTED' | 'VERIFIED';
  /** Accounts opened to the platform: 0 unless a spot check was asked for. */
  sampled: number;
  /** The platform already held this exact statement and returned the earlier record. */
  already: boolean;
  /** Present after a spot check: exactly what was sent in answer to it. */
  openings?: PorInclusionProof[];
}

export interface PorSnapshotStatus {
  snapshot_id: string;
  status: 'ACCEPTED' | 'CHALLENGED' | 'VERIFIED' | 'REJECTED';
  spot_check?: boolean;
  exchange: string;
  asof: string;
  root: string;
  leaf_count: number;
  totals: Record<string, string>;
  commitment: string;
  attestation: { id: string; status: string } | null;
  created_at: string;
}

/** Openings for the challenged positions, with the account reference removed. */
export function openChallenged(source: PorSpotCheckSource, indices: number[]): PorInclusionProof[] {
  const sorted = [...source.leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  return indices.map((i) => {
    const leaf = sorted[i];
    if (!leaf) throw new PorApiError(500, 'challenge_out_of_range', `challenged index ${i} is not in the local tree`);
    // Pseudonymous by construction: the hash and the balances, never the reference.
    const { user_ref: _private, ...opening } = leaf;
    return provePorLeaf(source.tree, i, opening);
  });
}

export class PorClient {
  private readonly o: PorClientOptions;
  constructor(o: PorClientOptions) { this.o = o; }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.o.core.replace(/\/+$/, '')}${path}`, {
        method,
        // One connection per request. Calls here are minutes apart at a large
        // ledger — a tree is rebuilt between two of them — and a pooled
        // connection the server has since closed fails the next request
        // instead of being reopened. This client makes a handful of calls a
        // day; reuse buys nothing.
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json', connection: 'close' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new PorApiError(0, 'unreachable', `could not reach ${this.o.core}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
    if (res.status >= 400) {
      throw new PorApiError(res.status, json.error ?? 'error', json.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  private key(): KeyObject {
    if (!this.o.key) throw new PorApiError(0, 'no_key', 'this client was created without a signing key');
    return this.o.key;
  }

  /** The exchange this client signs and submits for, as it was created. */
  get institution(): { id: string; name: string } {
    return { id: this.o.institutionId, name: this.o.institutionName };
  }

  /** The platform this client talks to: its origin, with no trailing slash. */
  get platform(): string {
    return this.o.core.replace(/\/+$/, '');
  }

  signStatement(statement: PorSnapshotStatement): PorSignature {
    return { ...signSnapshotStatement(statement, this.key()), key_id: this.o.institutionId, issuer: this.o.institutionName };
  }

  /** Confirm the registry holds exactly this key for this institution. */
  async assertRegistered(): Promise<void> {
    const registered = await this.registeredKey();
    if (registered !== publicSpkiBase64(this.key())) {
      throw new PorApiError(409, 'key_mismatch', 'local key differs from the registered signing key');
    }
  }

  /** The public key the platform will check signatures against (SPKI, base64). */
  async registeredKey(): Promise<string> {
    const meta = await this.call<{ institutions?: { id: string; signing_spki?: string }[] }>('GET', '/v1/remit/meta');
    const inst = meta.institutions?.find((i) => i.id === this.o.institutionId);
    if (!inst?.signing_spki) {
      throw new PorApiError(404, 'institution_unregistered', `${this.o.institutionId} has no signing key in the Trust Registry`);
    }
    return inst.signing_spki;
  }

  /**
   * Hand a signed statement to the platform.
   *
   * Without `spotCheck` nothing but the statement and its signature is sent,
   * and the call returns once the platform has accepted it for anchoring.
   * With it, the platform's challenge is answered from the local tree first.
   */
  async submit(submission: Pick<PorSubmission, 'statement' | 'sig'>, opts: { spotCheck?: PorSpotCheckSource } = {}): Promise<PorPublishResult> {
    const body = { statement: submission.statement, sig: submission.sig };

    if (!opts.spotCheck) {
      const r = await this.call<{
        snapshot_id: string; status: string; attestation_id?: string; already?: boolean;
      }>('POST', '/v1/por/snapshots', body);
      if (r.status !== 'ACCEPTED' || !r.attestation_id) {
        // A platform that predates the root-only path answers with a challenge.
        throw new PorApiError(409, 'spot_check_required',
          `the platform answered ${r.status}; it expects a spot check — submit with the local tree`);
      }
      return { snapshotId: r.snapshot_id, attestationId: r.attestation_id, status: 'ACCEPTED', sampled: 0, already: r.already === true };
    }

    const submitted = await this.call<{ snapshot_id: string; challenge: { indices: number[] } }>(
      'POST', '/v1/por/snapshots', { ...body, spot_check: true });
    const openings = openChallenged(opts.spotCheck, submitted.challenge.indices);
    const verified = await this.call<{ status: string; attestation_id: string; sampled_leaves: number }>(
      'POST', `/v1/por/snapshots/${submitted.snapshot_id}/openings`, { openings });
    if (verified.status !== 'VERIFIED') {
      throw new PorApiError(422, 'openings_rejected', `platform answered ${verified.status}`);
    }
    return {
      snapshotId: submitted.snapshot_id, attestationId: verified.attestation_id,
      status: 'VERIFIED', sampled: verified.sampled_leaves, already: false, openings,
    };
  }

  /**
   * Sign and submit in one call. Pass `spotCheck: true` together with the
   * tree and leaves to have the platform sample the tree before it anchors.
   */
  async publish(input: {
    statement: PorSnapshotStatement; tree?: PorTree; leaves?: PorLeafInput[]; spotCheck?: boolean;
  }): Promise<PorPublishResult> {
    const sig = this.signStatement(input.statement);
    if (!input.spotCheck) return this.submit({ statement: input.statement, sig });
    if (!input.tree || !input.leaves) {
      throw new PorApiError(0, 'no_tree', 'a spot check is answered from the local tree; pass tree and leaves');
    }
    return this.submit({ statement: input.statement, sig }, { spotCheck: { tree: input.tree, leaves: input.leaves } });
  }

  /** What the platform holds for a snapshot: root, totals, and where its anchor stands. */
  async status(snapshotId: string): Promise<PorSnapshotStatus> {
    return this.call<PorSnapshotStatus>('GET', `/v1/por/snapshots/${snapshotId}`);
  }

  async waitAnchored(snapshotId: string, timeoutMs = 120_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const v = await this.status(snapshotId);
      if (v.attestation?.status === 'confirmed') return;
      if (Date.now() - t0 > timeoutMs) throw new PorApiError(408, 'anchor_timeout', 'anchor not confirmed in time');
      await new Promise((ok) => setTimeout(ok, 2_000));
    }
  }

  publicUrl(snapshotId: string): string {
    return `${this.o.core.replace(/\/+$/, '')}/v1/public/por/snapshots/${snapshotId}`;
  }
}
