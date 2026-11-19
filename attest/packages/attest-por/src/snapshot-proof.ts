/**
 * The snapshot's proof file — the one file an exchange keeps beside the
 * balance export a snapshot was built from.
 *
 * A snapshot is a function of three things: the balances, the master seed
 * the salts are derived from, and a handful of decisions about how the
 * balances were read (which assets, how many decimal places, how amounts are
 * written, which layout). The balances are already a file the exchange has —
 * the export it anchored. So nothing else needs to be stored account by
 * account: this file carries the seed, the decisions, and the statement that
 * was signed and anchored, and the tree is rebuilt from the export whenever a
 * proof is wanted.
 *
 * Two files, then, and nothing else to keep:
 *
 *   the export        every account and balance. The exchange's own file.
 *   the proof file    this. Small; no account and no balance in it — but it
 *                     holds the seed, so it is private all the same.
 *
 * `restoreSnapshot` is the check that makes the pair trustworthy. It rebuilds
 * the tree and compares the root, the account count and the totals with the
 * statement before anything is issued. An export that was edited, re-run on
 * another day or mixed up with another snapshot's fails there, by name,
 * instead of producing proofs that do not verify — which would leave a
 * customer to conclude the exchange had left them out.
 *
 * The export's checksum is recorded as well. It is not what proves the file
 * (the root is); it is what lets a refusal say "this is not the file" rather
 * than only "the root differs".
 *
 * Nothing here needs a server or a file system: the sandbox console runs the
 * same code in a browser, on files the visitor picks.
 */
import { hexToBytes } from '@stonehash/attest-verify';
import { MAX_DECIMALS } from './amounts.ts';
import type { AmountUnit } from './amounts.ts';
import { ASSET_SYMBOL } from './ledger.ts';
import type { CsvLayout, IntakeOptions, LiabilityRow } from './ledger.ts';
import { leafFromRowPortable } from './portable.ts';
import { validateSnapshotStatement } from './snapshot.ts';
import type { PorSnapshotStatement } from './snapshot.ts';
import { buildPorTree } from './sumtree.ts';
import type { PorLeafInput, PorTree } from './sumtree.ts';

export const SNAPSHOT_PROOF_SCHEMA = 'stonehash.por-snapshot-proof.v1';

/** What an account's own proof calls itself. Named here only to tell the two files apart when the wrong one is given. */
const ACCOUNT_PROOF_SCHEMA = 'stonehash.por-proof.v1';

const NOTICE = 'Private. With the balance export named under "source", this file rebuilds the snapshot and issues '
  + 'every account\'s proof. It holds no account and no balance, but it holds the seed the salts are derived from: '
  + 'keep it where the export is kept, and do not publish it.';

export interface PorSnapshotProofSource {
  /** The export's file name — a reminder of which file to bring, not something that is checked. */
  file: string;
  bytes: number;
  /** SHA-256 of the export as it was read. It names the file; the rebuilt root is what proves it. */
  sha256: string;
  /** How the export was read: one of the CSV layouts, or `json` for an array of accounts. */
  layout: CsvLayout | 'json';
  amounts: AmountUnit;
  /** The three below are written only when the export was read with something other than the defaults. */
  columns?: { account?: string; asset?: string; balance?: string };
  ignore_columns?: string[];
  delimiter?: string;
}

export interface PorSnapshotProofSignature {
  alg: 'ES256';
  key_id: string;
  issuer: string;
  /** base64url of the 64-byte r‖s. */
  sig: string;
}

export interface PorSnapshotProof {
  schema: typeof SNAPSHOT_PROOF_SCHEMA;
  notice: string;
  /**
   * The id the platform gave the snapshot when it accepted the statement.
   * `null` in a file written just before the statement is sent: the seed is
   * on disk before anything is public, and the id is filled in on acceptance.
   * Such a file rebuilds the snapshot like any other.
   */
  snapshot_id: string | null;
  /** Where it was submitted, when the writer knew. */
  platform?: string;
  created_at: string;
  /** Exactly what was signed and anchored. */
  statement: PorSnapshotStatement;
  sig: PorSnapshotProofSignature;
  /** The master seed, 64 hex characters. The one secret in the file. */
  seed: string;
  source: PorSnapshotProofSource;
}

export type SnapshotProofProblem =
  /** The text is not JSON at all. */
  | 'not_json'
  /** An account's proof was given where the snapshot's proof file was wanted. */
  | 'account_proof'
  /** JSON, but not a proof file. */
  | 'not_snapshot_proof'
  /** A proof file of a version this code does not read. */
  | 'unsupported_version'
  /** A proof file with something missing or malformed in it. */
  | 'damaged'
  /** A new proof file was to be written where another snapshot's, or some other file, already is. */
  | 'in_use'
  /** The export does not rebuild the snapshot the proof file states. */
  | 'mismatch';

/** What differed when an export failed to rebuild its snapshot: `[stated, rebuilt]` each. */
export interface SnapshotMismatch {
  root: [string, string];
  accounts: [number, number];
  /** Only the assets whose totals differ, in smallest units. */
  totals: Record<string, [string, string]>;
}

export class SnapshotProofError extends Error {
  readonly code: SnapshotProofProblem;
  /** Each thing wrong with a damaged file, one per entry. */
  readonly problems: string[];
  /** Set when `code` is `mismatch`. */
  readonly mismatch: SnapshotMismatch | null;
  constructor(code: SnapshotProofProblem, message: string, extra: { problems?: string[]; mismatch?: SnapshotMismatch } = {}) {
    super(message);
    this.name = 'SnapshotProofError';
    this.code = code;
    this.problems = extra.problems ?? [];
    this.mismatch = extra.mismatch ?? null;
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const LAYOUTS = new Set<string>(['long', 'wide', 'sheet', 'json']);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Shape check for a proof file read back; returns problems, empty = usable. */
export function validateSnapshotProof(value: unknown): string[] {
  const f = value as Partial<PorSnapshotProof> | null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return ['the file is not a JSON object'];
  const p: string[] = [];
  if (f.schema !== SNAPSHOT_PROOF_SCHEMA) p.push(`schema must be ${SNAPSHOT_PROOF_SCHEMA}`);
  if (f.snapshot_id !== null && !isText(f.snapshot_id)) p.push('snapshot_id is missing');
  if (f.platform !== undefined && typeof f.platform !== 'string') p.push('platform must be text');
  if (!isText(f.seed) || !HEX64.test(f.seed)) p.push('seed must be 64 hex characters');

  const statementProblems = validateSnapshotStatement(f.statement);
  p.push(...statementProblems.map((m) => `statement: ${m}`));
  if (statementProblems.length === 0) {
    // The statement's own check asks only that there are assets. They are
    // about to be handed to the reader as its asset list, so each is checked
    // as the reader would check it.
    const seen = new Set<string>();
    for (const a of f.statement!.assets as unknown[]) {
      const spec = a as { symbol?: unknown; decimals?: unknown } | null;
      const symbol = spec?.symbol;
      if (typeof symbol !== 'string' || !ASSET_SYMBOL.test(symbol)) { p.push(`statement: asset symbol ${JSON.stringify(symbol)} is not one the reader accepts`); continue; }
      const decimals = spec?.decimals;
      if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        p.push(`statement: ${symbol} decimals must be a whole number from 0 to ${MAX_DECIMALS}`);
      }
      if (seen.has(symbol)) p.push(`statement: asset ${symbol} is listed twice`);
      seen.add(symbol);
    }
    if (typeof f.statement!.exchange?.institution_id !== 'string') p.push('statement: exchange.institution_id must be text');
  }

  const sig = f.sig as Partial<PorSnapshotProofSignature> | null | undefined;
  if (!sig || typeof sig !== 'object') p.push('sig is missing');
  else if (sig.alg !== 'ES256' || !isText(sig.sig)) p.push('sig must be an ES256 signature');

  const src = f.source as Partial<PorSnapshotProofSource> | null | undefined;
  if (!src || typeof src !== 'object') p.push('source is missing');
  else {
    if (typeof src.file !== 'string') p.push('source.file must be text');
    if (typeof src.bytes !== 'number' || !Number.isInteger(src.bytes) || src.bytes < 0) p.push('source.bytes must be a whole number');
    if (!isText(src.sha256) || !HEX64.test(src.sha256)) p.push('source.sha256 must be 64 hex characters');
    if (!isText(src.layout) || !LAYOUTS.has(src.layout)) p.push('source.layout must be long, wide, sheet or json');
    if (src.amounts !== 'decimal' && src.amounts !== 'base') p.push('source.amounts must be decimal or base');
    if (src.columns !== undefined) {
      const c = src.columns as Record<string, unknown> | null;
      if (!c || typeof c !== 'object' || Array.isArray(c)
        || Object.entries(c).some(([k, v]) => !['account', 'asset', 'balance'].includes(k) || !isText(v))) {
        p.push('source.columns may name account, asset and balance, each as text');
      }
    }
    if (src.ignore_columns !== undefined && !(Array.isArray(src.ignore_columns) && src.ignore_columns.every(isText))) {
      p.push('source.ignore_columns must be a list of column names');
    }
    if (src.delimiter !== undefined && !(typeof src.delimiter === 'string' && src.delimiter.length === 1)) {
      p.push('source.delimiter must be a single character');
    }
  }
  return p;
}

/**
 * The proof file for a snapshot: `snapshotId` is the platform's once it has
 * accepted the statement, `null` for the file written before sending it.
 * `seed` is the 32-byte master seed the leaves were salted with.
 */
export function buildSnapshotProof(input: {
  snapshotId: string | null;
  platform?: string;
  statement: PorSnapshotStatement;
  sig: PorSnapshotProofSignature;
  seed: Uint8Array;
  source: PorSnapshotProofSource;
  now?: Date;
}): PorSnapshotProof {
  if (input.seed.length !== 32) throw new Error('the master seed must be 32 bytes');
  let seed = '';
  for (const byte of input.seed) seed += byte.toString(16).padStart(2, '0');
  const src = input.source;
  const proof: PorSnapshotProof = {
    schema: SNAPSHOT_PROOF_SCHEMA,
    notice: NOTICE,
    snapshot_id: input.snapshotId,
    ...(input.platform ? { platform: input.platform } : {}),
    created_at: (input.now ?? new Date()).toISOString(),
    statement: input.statement,
    sig: input.sig,
    seed,
    source: {
      file: src.file,
      bytes: src.bytes,
      sha256: src.sha256.toLowerCase(),
      layout: src.layout,
      amounts: src.amounts,
      ...(src.columns && Object.keys(src.columns).length > 0 ? { columns: src.columns } : {}),
      ...(src.ignore_columns && src.ignore_columns.length > 0 ? { ignore_columns: src.ignore_columns } : {}),
      ...(src.delimiter !== undefined && src.delimiter !== ',' ? { delimiter: src.delimiter } : {}),
    },
  };
  const problems = validateSnapshotProof(proof);
  if (problems.length > 0) throw new Error(`cannot write a proof file: ${problems.join('; ')}`);
  return proof;
}

/** The file as it is written: indented, so a person can open it and see what it is. */
export function snapshotProofText(proof: PorSnapshotProof): string {
  return JSON.stringify(proof, null, 2) + '\n';
}

/**
 * Read a proof file. Throws `SnapshotProofError`, whose `code` says which of
 * the ways a wrong file can be wrong this one is — the commonest being that
 * an account's proof, or the balance file itself, was picked instead.
 */
export function parseSnapshotProof(text: string): PorSnapshotProof {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new SnapshotProofError('not_json', 'this is not a proof file (it is not JSON)');
  }
  const schema = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { schema?: unknown }).schema : undefined;
  if (schema === ACCOUNT_PROOF_SCHEMA) {
    throw new SnapshotProofError('account_proof',
      'this is one account\'s proof, not the snapshot\'s proof file; the snapshot\'s is the file downloaded when the snapshot was anchored');
  }
  if (typeof schema === 'string' && schema.startsWith('stonehash.por-snapshot-proof.') && schema !== SNAPSHOT_PROOF_SCHEMA) {
    throw new SnapshotProofError('unsupported_version', `this proof file is ${schema}; this version reads ${SNAPSHOT_PROOF_SCHEMA}`);
  }
  if (schema !== SNAPSHOT_PROOF_SCHEMA) {
    throw new SnapshotProofError('not_snapshot_proof', 'this is not a snapshot\'s proof file');
  }
  const problems = validateSnapshotProof(value);
  if (problems.length > 0) {
    throw new SnapshotProofError('damaged', `the proof file is damaged: ${problems.join('; ')}`, { problems });
  }
  return value as PorSnapshotProof;
}

/**
 * How to read the export so that it comes out as it did when the snapshot
 * was built: the statement's assets, and the layout and amount style that
 * were recorded. A `json` source is read with `readAccountsJson`, which takes
 * the first two fields and has no use for the rest.
 */
export function ledgerOptionsOf(proof: PorSnapshotProof): IntakeOptions {
  const src = proof.source;
  return {
    assets: proof.statement.assets.map((a) => ({ symbol: a.symbol, decimals: a.decimals })),
    amounts: src.amounts,
    ...(src.layout !== 'json' ? { layout: src.layout } : {}),
    ...(src.columns ? { columns: src.columns } : {}),
    ...(src.ignore_columns ? { ignoreColumns: src.ignore_columns } : {}),
    ...(src.delimiter !== undefined ? { delimiter: src.delimiter } : {}),
  };
}

export interface RestoredSnapshot {
  tree: PorTree;
  /** In tree order: `leaves[i]` is the leaf at index `i`. */
  leaves: PorLeafInput[];
}

/**
 * Rebuild a snapshot from its proof file and the rows of its export (read
 * with `ledgerOptionsOf`).
 *
 * Refuses, with what differed, unless the rows reproduce the root, the
 * account count and the totals the statement gives: nothing may be issued
 * from a tree that is not the anchored one.
 *
 * `leaf` is how a row becomes a leaf. The default needs nothing but the
 * language; a server may pass `leafFromRow`, which does the same with the
 * platform's own HMAC and is faster over a large ledger.
 */
export function restoreSnapshot(
  proof: PorSnapshotProof,
  rows: LiabilityRow[],
  opts: { leaf?: (exchangeId: string, seed: Uint8Array, row: LiabilityRow) => PorLeafInput } = {},
): RestoredSnapshot {
  const st = proof.statement;
  const seed = hexToBytes(proof.seed);
  const leafOf = opts.leaf ?? leafFromRowPortable;
  const symbols = st.assets.map((a) => a.symbol);
  const zeroTotals = (): Record<string, string> => Object.fromEntries(symbols.map((s) => [s, '0']));

  let tree: PorTree | null = null;
  let leaves: PorLeafInput[] = [];
  if (rows.length > 0) {
    leaves = rows.map((r) => leafOf(st.exchange.institution_id, seed, r));
    tree = buildPorTree(leaves, symbols, { algo: st.tree.algo });
  }
  const rebuilt = {
    root: tree?.root ?? '',
    accounts: tree?.leaf_count ?? 0,
    totals: tree?.totals ?? zeroTotals(),
  };
  // An asset may be called `constructor`: read each side's own entries only.
  const own = (o: object, k: string): string => (Object.hasOwn(o, k) ? String((o as Record<string, unknown>)[k]) : '0');
  const totals: Record<string, [string, string]> = {};
  for (const s of symbols) {
    const stated = own(st.totals, s);
    const got = own(rebuilt.totals, s);
    if (stated !== got) totals[s] = [stated, got];
  }
  if (tree === null || rebuilt.root !== st.tree.root || rebuilt.accounts !== st.tree.leaf_count || Object.keys(totals).length > 0) {
    throw new SnapshotProofError('mismatch',
      'this export does not rebuild the snapshot in the proof file: the root it gives is not the anchored one',
      { mismatch: { root: [st.tree.root, rebuilt.root], accounts: [st.tree.leaf_count, rebuilt.accounts], totals } });
  }
  return { tree, leaves: [...leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1)) };
}
