/**
 * The snapshot statement — the only artefact that travels to the platform.
 *
 * Root, totals, parameters, nothing else: no account references, no
 * balances, no leaf material. Its commitment (domain-separated SHA-256 over
 * the JCS form) is the leaf the platform anchors, so "the exchange published
 * these liabilities at this time" becomes independently checkable from the
 * statement plus the Bitcoin proof alone.
 */
import { porSnapshotCommitment } from '../attest-verify/index.ts';
import type { PorBalances } from '../attest-verify/index.ts';
import type { PorTree, PorTreeAlgo } from './sumtree.ts';

export interface PorAssetSpec {
  symbol: string;
  /** Decimals of the base unit the integer balances are denominated in. */
  decimals: number;
}

export interface PorSnapshotStatement {
  schema: 'stonehash.por-snapshot.v1';
  exchange: { institution_id: string; name: string };
  asof: string;
  assets: PorAssetSpec[];
  tree: {
    algo: PorTreeAlgo;
    leaf_count: number;
    root: string;
    /** What the padding node carries: a zero per listed asset (v1), or nothing (v2). */
    padding: 'empty-zero' | 'empty';
  };
  totals: PorBalances;
  params: {
    user_ref_hash: 'sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)';
    salt: 'hmac-sha256(master_seed, user_ref)';
  };
  /**
   * Reserve side: the exchange *declares* addresses; balances are never in
   * the statement — the platform (and anyone else) measures them on chain at
   * verification time, which is the half of PoR a signature cannot fake.
   * Address *control* proof (signing from the key) is a live-tier control,
   * declared here as out of sandbox scope rather than simulated.
   */
  reserves?: {
    mode: 'DECLARED';
    entries: { chain: string; asset: string; address: string; token_contract?: string }[];
    note: string;
  };
  generated_at: string;
}

export function buildSnapshotStatement(cfg: {
  institutionId: string;
  name: string;
  asof: string;
  assets: PorAssetSpec[];
  reserves?: PorSnapshotStatement['reserves'];
}, tree: PorTree, now = new Date()): PorSnapshotStatement {
  return {
    schema: 'stonehash.por-snapshot.v1',
    exchange: { institution_id: cfg.institutionId, name: cfg.name },
    asof: cfg.asof,
    assets: cfg.assets,
    tree: {
      algo: tree.algo,
      leaf_count: tree.leaf_count,
      root: tree.root,
      padding: PADDING[tree.algo],
    },
    totals: tree.totals,
    params: {
      user_ref_hash: 'sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)',
      salt: 'hmac-sha256(master_seed, user_ref)',
    },
    ...(cfg.reserves ? { reserves: cfg.reserves } : {}),
    generated_at: now.toISOString(),
  };
}

export { porSnapshotCommitment };

/** The padding each tree format declares; a statement naming one with the other's is not one this SDK wrote. */
const PADDING: Record<PorTreeAlgo, 'empty-zero' | 'empty'> = {
  'merkle-sum-sha256-v1': 'empty-zero',
  'merkle-sum-sha256-v2': 'empty',
};

/** Shape check for the platform side; returns problems, empty = valid. */
export function validateSnapshotStatement(st: unknown): string[] {
  const p: string[] = [];
  const s = st as Partial<PorSnapshotStatement> | null;
  if (!s || typeof s !== 'object') return ['statement must be an object'];
  if (s.schema !== 'stonehash.por-snapshot.v1') p.push('schema must be stonehash.por-snapshot.v1');
  if (!s.exchange?.institution_id) p.push('exchange.institution_id is required');
  if (!s.asof || Number.isNaN(Date.parse(s.asof))) p.push('asof must be an ISO instant');
  if (!Array.isArray(s.assets) || s.assets.length === 0) p.push('assets must be non-empty');
  const algo = s.tree?.algo;
  if (algo !== 'merkle-sum-sha256-v1' && algo !== 'merkle-sum-sha256-v2') {
    p.push('tree.algo must be merkle-sum-sha256-v1 or merkle-sum-sha256-v2');
  } else if (s.tree?.padding !== undefined && s.tree.padding !== PADDING[algo]) {
    p.push(`tree.padding must be ${PADDING[algo]} for ${algo}`);
  }
  if (!/^[0-9a-f]{64}$/.test(s.tree?.root ?? '')) p.push('tree.root must be 64 lowercase hex');
  if (!Number.isInteger(s.tree?.leaf_count) || (s.tree?.leaf_count ?? 0) < 1) p.push('tree.leaf_count must be ≥ 1');
  if (!s.totals || typeof s.totals !== 'object') p.push('totals is required');
  else {
    for (const [k, v] of Object.entries(s.totals)) {
      if (!/^(0|[1-9]\d*)$/.test(String(v))) p.push(`totals.${k} must be a non-negative integer string`);
    }
  }
  return p;
}
