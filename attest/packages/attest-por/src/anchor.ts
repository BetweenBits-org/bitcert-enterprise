/**
 * A snapshot from the exchange's own source, in two calls — and two files.
 *
 *   anchorBalanceFile   reads the balance export, builds the tree, signs the
 *                       statement, hands it to the platform, and writes one
 *                       proof file.
 *   openSnapshot        takes that proof file and the same export, rebuilds
 *                       the tree, and issues any account's proof.
 *
 * What an exchange keeps is the export it already has and the proof file.
 * Nothing is stored account by account: the proof file carries the statement,
 * its signature, the seed and how the export was read, and the tree is a
 * function of those and the export.
 *
 * ## The order things happen in
 *
 * The proof file is written before the statement is sent, with no snapshot
 * id in it yet, and completed when the platform answers. A snapshot the
 * platform has accepted and whose seed was never saved could issue no proof
 * to anyone, ever; written first, the worst a crash leaves behind is a file
 * for a snapshot that was never published.
 *
 * The same call made again finishes what the first began. If the proof file
 * at that path belongs to this export, this exchange and this as-of time, its
 * statement is sent again as it stands — the platform answers with the
 * snapshot it already holds — rather than a second snapshot being made.
 *
 * A proof file is never overwritten by another snapshot's. The seed in it is
 * the only copy there is.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import type { PorBalances, PorInclusionProof } from '@stonehash/attest-verify';
import type { AmountUnit } from './amounts.ts';
import { PorApiError } from './client.ts';
import type { PorClient, PorPublishResult } from './client.ts';
import { readLiabilitiesCsv, readLiabilitiesJson } from './intake.ts';
import type { CsvLayout, IntakeOptions, IntakeReport, LiabilityRow } from './intake.ts';
import { leafFromRow } from './leaves.ts';
import { checkCapacity } from './limits.ts';
import { buildSnapshotStatement, porSnapshotCommitment } from './snapshot.ts';
import type { PorAssetSpec, PorSnapshotStatement } from './snapshot.ts';
import {
  SnapshotProofError, buildSnapshotProof, ledgerOptionsOf, parseSnapshotProof, restoreSnapshot, snapshotProofText,
} from './snapshot-proof.ts';
import type { PorSnapshotProof, PorSnapshotProofSource, SnapshotMismatch } from './snapshot-proof.ts';
import { buildPorTree, provePorLeaf } from './sumtree.ts';
import type { PorLeafInput, PorTree } from './sumtree.ts';

/** How the export is to be read, and what the snapshot is to say. */
export interface AnchorBalanceFileOptions {
  /** Every asset the snapshot covers, with its decimal places. */
  assets: PorAssetSpec[];
  /** How amounts are written in the file: `decimal` (0.5 for half a coin) or `base` (whole smallest units). Never guessed. */
  amounts: AmountUnit;
  /** The moment the balances stand for, as an ISO instant. */
  asof: string;
  /** Where the proof file is written — the one file to keep beside the export. */
  proofFile: string;
  /** Have the platform sample the tree before it anchors. Account-level data for the sampled accounts leaves the machine. */
  spotCheck?: boolean;
  /** Wait this long for the anchor to confirm before returning; without it the call returns on acceptance. */
  waitAnchoredMs?: number;
  /** `csv` or `json` (an array of accounts). Taken from the file's extension when omitted. */
  format?: 'csv' | 'json';
  /** CSV only, and only for an export that departs from the standard: see `IntakeOptions`. */
  layout?: CsvLayout;
  columns?: { account?: string; asset?: string; balance?: string };
  ignoreColumns?: string[];
  delimiter?: string;
  reserves?: PorSnapshotStatement['reserves'];
  /** For tests: the 32-byte seed. Left out, one is drawn — and that is what an exchange wants. */
  seed?: Uint8Array;
}

export interface AnchoredSnapshot {
  snapshotId: string;
  /** ACCEPTED: anchored on the signature alone. VERIFIED: the spot check passed first. */
  status: 'ACCEPTED' | 'VERIFIED';
  /** The snapshot was already there: an earlier call for this export was finished, or found finished, rather than repeated. */
  already: boolean;
  root: string;
  /** Per asset, in smallest units. */
  totals: PorBalances;
  accounts: number;
  commitment: string;
  /** Accounts opened to the platform: 0 unless a spot check was asked for. */
  sampled: number;
  anchor: 'pending' | 'confirmed';
  proofFile: string;
  /** Where anyone can read what the platform holds for the snapshot. */
  publicUrl: string;
  /** What the export added up to. No account in it. */
  report: IntakeReport;
}

/** The balance export cannot be used: it has problems, or it is larger than this run can build. Nothing was written or sent. */
export class PorLedgerError extends Error {
  readonly code: 'ledger_problems' | 'too_large';
  /** Every problem counted, the first of them listed. Present when `code` is `ledger_problems`. */
  readonly report: IntakeReport | null;
  constructor(code: 'ledger_problems' | 'too_large', message: string, report: IntakeReport | null = null) {
    super(message);
    this.name = 'PorLedgerError';
    this.code = code;
    this.report = report;
  }
}

/** An export that did not rebuild its snapshot, with which file it was and which it should have been. */
export class SnapshotRestoreError extends SnapshotProofError {
  /** The export given is, byte for byte, the one the proof file records — so it is the proof file that changed. */
  readonly sameFile: boolean;
  readonly given: { file: string; bytes: number; sha256: string };
  readonly recorded: PorSnapshotProofSource;
  constructor(message: string, mismatch: SnapshotMismatch, sameFile: boolean,
    given: { file: string; bytes: number; sha256: string }, recorded: PorSnapshotProofSource) {
    super('mismatch', message, { mismatch });
    this.name = 'SnapshotRestoreError';
    this.sameFile = sameFile;
    this.given = given;
    this.recorded = recorded;
  }
}

/** What one account's holder is handed: their leaf, and the path from it to the anchored root. */
export interface PorCustomerProof {
  schema: 'stonehash.por-proof.v1';
  exchange: PorSnapshotStatement['exchange'];
  asof: string;
  root: string;
  totals: PorBalances;
  leaf_count: number;
  user_ref: string;
  proof: PorInclusionProof;
}

export function customerProof(statement: PorSnapshotStatement, leaf: PorLeafInput, proof: PorInclusionProof): PorCustomerProof {
  return {
    schema: 'stonehash.por-proof.v1',
    exchange: statement.exchange,
    asof: statement.asof,
    root: statement.tree.root,
    totals: statement.totals,
    leaf_count: statement.tree.leaf_count,
    user_ref: leaf.user_ref,
    proof,
  };
}

const grouped = (n: number): string => n.toLocaleString('en-US');
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const formatOf = (file: string, stated?: 'csv' | 'json'): 'csv' | 'json' => stated ?? (/\.json$/i.test(file) ? 'json' : 'csv');

/** Read an export and refuse it, with the report, unless it can be built. */
async function readExport(file: string, format: 'csv' | 'json', intake: IntakeOptions, algo: PorSnapshotStatement['tree']['algo']): Promise<{
  rows: LiabilityRow[]; report: IntakeReport;
}> {
  if (!existsSync(file)) throw new PorLedgerError('ledger_problems', `${file} not found`);
  const { rows, report } = format === 'csv' ? await readLiabilitiesCsv(file, intake) : readLiabilitiesJson(file, intake);
  if (!report.ok) {
    const first = report.problems.slice(0, 3).map((p) => `${p.line > 0 ? `line ${p.line}: ` : ''}${p.code} — ${p.message}`).join('; ');
    throw new PorLedgerError('ledger_problems',
      `${path.basename(file)} has ${grouped(report.problem_count)} problem${report.problem_count === 1 ? '' : 's'}; nothing was built (${first}${report.problem_count > 3 ? '; …' : ''})`,
      report);
  }
  // v1 writes a figure for every listed asset; v2 only for what is held.
  const figures = rows.reduce((n, r) => n + Object.values(r.balances).filter((v) => v !== '0').length, 0);
  const capacity = checkCapacity(rows.length, intake.assets.length, undefined,
    algo === 'merkle-sum-sha256-v1' ? intake.assets.length : figures / Math.max(1, rows.length));
  if (!capacity.ok) throw new PorLedgerError('too_large', `too large for this run: ${capacity.message}`, report);
  return { rows, report };
}

function writeProofFile(file: string, proof: PorSnapshotProof, replace: boolean): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (!replace) {
    // `wx`: if something appeared at the path since it was looked at, fail rather than write over it.
    writeFileSync(file, snapshotProofText(proof), { mode: 0o600, flag: 'wx' });
  } else {
    // Whole or not at all: a reader never finds half a proof file under the name.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, snapshotProofText(proof), { mode: 0o600 });
    renameSync(tmp, file);
  }
  // The mode at creation is subject to the umask; state it outright.
  chmodSync(file, 0o600);
}

/**
 * Anchor a balance export: one call, one proof file.
 *
 * Nothing is built, written or sent from an export with a problem in it; the
 * error carries the report. What is sent is the statement and its signature
 * — and, only if `spotCheck` is asked for, the openings the platform samples.
 */
export async function anchorBalanceFile(client: PorClient, file: string, o: AnchorBalanceFileOptions): Promise<AnchoredSnapshot> {
  if (Number.isNaN(Date.parse(o.asof))) throw new Error(`asof "${o.asof}" is not a time; write it as 2026-11-16T00:00:00Z`);
  if (o.seed && o.seed.length !== 32) throw new Error('the seed must be 32 bytes');
  const exchange = client.institution;
  const format = formatOf(file, o.format);
  const intake: IntakeOptions = {
    assets: o.assets,
    amounts: o.amounts,
    ...(o.layout ? { layout: o.layout } : {}),
    ...(o.columns && Object.keys(o.columns).length > 0 ? { columns: o.columns } : {}),
    ...(o.ignoreColumns && o.ignoreColumns.length > 0 ? { ignoreColumns: o.ignoreColumns } : {}),
    ...(o.delimiter ? { delimiter: o.delimiter } : {}),
  };

  // What is already at the path decides everything else, so it is looked at first.
  let existing: PorSnapshotProof | null = null;
  if (existsSync(o.proofFile)) {
    try {
      existing = parseSnapshotProof(readFileSync(o.proofFile, 'utf8'));
    } catch (e) {
      throw new SnapshotProofError('in_use',
        `${o.proofFile} exists and is not a proof file this version reads (${e instanceof Error ? e.message : String(e)}); it was left as it is — choose another path`);
    }
  }

  const { rows, report } = await readExport(file, format, intake, existing?.statement.tree.algo ?? 'merkle-sum-sha256-v2');
  const source: PorSnapshotProofSource = {
    file: report.input.file, bytes: report.input.bytes, sha256: report.input.sha256,
    layout: report.layout ?? (format === 'json' ? 'json' : 'long'),
    amounts: o.amounts,
    ...(intake.columns ? { columns: intake.columns } : {}),
    ...(intake.ignoreColumns ? { ignore_columns: intake.ignoreColumns } : {}),
    ...(intake.delimiter ? { delimiter: intake.delimiter } : {}),
  };

  let proof: PorSnapshotProof;
  let tree: PorTree;
  let leaves: PorLeafInput[];
  let created = false;
  if (existing) {
    const st = existing.statement;
    const sameSnapshot = existing.source.sha256 === source.sha256
      && st.exchange.institution_id === exchange.id
      && Date.parse(st.asof) === Date.parse(o.asof)
      && sameJson(st.assets, o.assets)
      && existing.source.amounts === o.amounts;
    if (!sameSnapshot) {
      throw new SnapshotProofError('in_use',
        `${o.proofFile} already holds the proof file of another snapshot (${st.exchange.institution_id}, as of ${st.asof}, built from ${existing.source.file}); `
        + 'a proof file is never overwritten — choose another path for this one');
    }
    // The same export again: what was begun is finished, not repeated. The
    // tree is rebuilt from the stored seed, and must be the stored statement's.
    ({ tree, leaves } = restoreSnapshot(existing, rows, { leaf: leafFromRow }));
    proof = existing;
  } else {
    const seed = o.seed ?? randomBytes(32);
    leaves = rows.map((r) => leafFromRow(exchange.id, seed, r));
    tree = buildPorTree(leaves, o.assets.map((a) => a.symbol));
    const statement = buildSnapshotStatement({
      institutionId: exchange.id, name: exchange.name, asof: o.asof, assets: o.assets,
      ...(o.reserves ? { reserves: o.reserves } : {}),
    }, tree);
    proof = buildSnapshotProof({
      snapshotId: null, platform: client.platform, statement, sig: client.signStatement(statement), seed, source,
    });
    // On disk before anything is public.
    writeProofFile(o.proofFile, proof, false);
    created = true;
  }

  const st = proof.statement;
  const summary = {
    root: st.tree.root, totals: st.totals, accounts: st.tree.leaf_count, commitment: porSnapshotCommitment(st),
    proofFile: o.proofFile, report,
  };

  if (proof.snapshot_id !== null) {
    // Finished on an earlier call. Say where it stands; send nothing.
    const held = await client.status(proof.snapshot_id);
    return {
      ...summary, snapshotId: proof.snapshot_id, already: true, sampled: 0,
      status: held.status === 'VERIFIED' ? 'VERIFIED' : 'ACCEPTED',
      anchor: held.attestation?.status === 'confirmed' ? 'confirmed' : 'pending',
      publicUrl: client.publicUrl(proof.snapshot_id),
    };
  }

  let result: PorPublishResult;
  try {
    result = await client.submit({ statement: st, sig: proof.sig }, o.spotCheck ? { spotCheck: { tree, leaves } } : {});
  } catch (e) {
    // A refusal is final, and a file written a moment ago for a snapshot that
    // will never exist is only something to trip over. Anything less certain
    // — no answer, a server error — and the file stays: the statement may
    // have arrived, and this call made again will find out.
    if (created && e instanceof PorApiError && e.status >= 400 && e.status < 500) rmSync(o.proofFile, { force: true });
    throw e;
  }
  writeProofFile(o.proofFile, { ...proof, snapshot_id: result.snapshotId }, true);

  let anchor: AnchoredSnapshot['anchor'] = 'pending';
  if (o.waitAnchoredMs && o.waitAnchoredMs > 0) {
    await client.waitAnchored(result.snapshotId, o.waitAnchoredMs);
    anchor = 'confirmed';
  }
  return {
    ...summary, snapshotId: result.snapshotId, status: result.status, already: result.already,
    sampled: result.sampled, anchor, publicUrl: client.publicUrl(result.snapshotId),
  };
}

/** A snapshot rebuilt from its two files, ready to issue proofs. */
export interface OpenedSnapshot {
  /** `null` for a proof file whose statement the platform never answered for. */
  snapshotId: string | null;
  statement: PorSnapshotStatement;
  tree: PorTree;
  /** In tree order: `leaves[i]` is the leaf at index `i`. */
  leaves: PorLeafInput[];
  /** The proof to hand an account's holder, or `null` when the account is not in the snapshot. */
  proofFor(account: string): PorCustomerProof | null;
  /**
   * Every account's proof, under `dir` as `<first two characters>/<hashed
   * reference>.json` — no directory with a million entries, no file named by
   * an account. Resolves to how many were written.
   */
  writeAllProofs(dir: string): Promise<number>;
}

/**
 * Rebuild a snapshot from its proof file and the export it was built from.
 *
 * The export is read the way the proof file says it was read, and unless the
 * tree that comes out is the anchored one — root, account count, totals —
 * nothing is returned: the error says what differed and whether the file
 * given is the one the proof file was written for.
 */
export async function openSnapshot(proofFile: string, balanceFile: string): Promise<OpenedSnapshot> {
  if (!existsSync(proofFile)) throw new SnapshotProofError('not_snapshot_proof', `${proofFile} not found`);
  const proof = parseSnapshotProof(readFileSync(proofFile, 'utf8'));
  const options = ledgerOptionsOf(proof);
  const format = proof.source.layout === 'json' ? 'json' : 'csv';
  const { rows, report } = await readExport(balanceFile, format, options, proof.statement.tree.algo);

  let tree: PorTree;
  let leaves: PorLeafInput[];
  try {
    ({ tree, leaves } = restoreSnapshot(proof, rows, { leaf: leafFromRow }));
  } catch (e) {
    if (!(e instanceof SnapshotProofError) || e.mismatch === null) throw e;
    const sameFile = report.input.sha256 === proof.source.sha256;
    throw new SnapshotRestoreError(
      `${path.basename(balanceFile)} does not rebuild snapshot ${proof.snapshot_id ?? '(not yet submitted)'}; nothing was issued`,
      e.mismatch, sameFile, report.input, proof.source);
  }
  const statement = proof.statement;
  return {
    snapshotId: proof.snapshot_id,
    statement,
    tree,
    leaves,
    proofFor(account: string): PorCustomerProof | null {
      // Looked up in the leaves themselves rather than through a keyed object:
      // a reference is whatever the exchange's ledger says it is.
      const at = leaves.findIndex((l) => l.user_ref === account);
      if (at < 0) return null;
      const leaf = leaves[at]!;
      return customerProof(statement, leaf, provePorLeaf(tree, at, leaf));
    },
    async writeAllProofs(dir: string): Promise<number> {
      const made = new Set<string>();
      for (let at = 0; at < leaves.length; at++) {
        const leaf = leaves[at]!;
        const sub = path.join(dir, leaf.user_ref_hash.slice(0, 2));
        if (!made.has(sub)) { mkdirSync(sub, { recursive: true }); made.add(sub); }
        const out = createWriteStream(path.join(sub, `${leaf.user_ref_hash}.json`));
        out.end(JSON.stringify(customerProof(statement, leaf, provePorLeaf(tree, at, leaf)), null, 2) + '\n');
        await once(out, 'finish');
      }
      return leaves.length;
    },
  };
}
