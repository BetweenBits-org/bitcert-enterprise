/**
 * attest-por CLI — the SDK's calls from a shell, on the exchange's own machine.
 *
 * An exchange applies the SDK in its own source (`anchorBalanceFile`,
 * `openSnapshot`); this is the same thing for a person at a terminal, and what
 * the tests and the check tools drive.
 *
 *   anchor        export → tree → signed statement → platform, and ONE proof
 *                 file left behind. With the export, that file is the snapshot.
 *   prove         a customer's proof (one, or all) from the proof file and the
 *                 export
 *   check         read a balance export and say whether it can be built
 *
 * The same errand in separate steps, leaving a directory — how snapshots were
 * kept before the proof file, still read, and what a signing key on another
 * machine than the one with a network needs:
 *
 *   build         export → sum tree + snapshot statement + master seed
 *   sign          sign the statement: writes the one file that is sent
 *   submit        hand that file to the platform, which anchors it
 *   status        what the platform holds for a snapshot
 *   prove --tree  a customer's proof from that directory
 *   open          export openings for challenged indices (spot-check reply)
 *   verify-proof  check a proof offline against a snapshot statement
 *   synth         make a synthetic export (demo data)
 *
 * Files and custody, in the directory `build` writes:
 *   snapshot.json     the statement: root and totals.
 *   submission.json   the statement and its signature — everything `submit`
 *                     sends unless a spot check is asked for.
 *   leaves.jsonl      stays in the exchange (every account: reference, salt, balances).
 *   seed.hex          stays in the exchange (master seed for the salts).
 *   tree.json         stays in the exchange (header naming root and leaves).
 *   build-report.json what was read and what it added up to; no account in it.
 *
 * A snapshot anchored with `anchor`, or from the console, leaves one file
 * instead of that directory — its proof file — and `prove` takes it together
 * with the export the snapshot was built from: the two rebuild the tree, and
 * nothing is issued unless they reproduce the anchored root.
 *
 * `verify-proof` deliberately needs nothing but the two files — a customer
 * (or their auditor) runs it against the published statement with no account
 * at StoneHash and no network.
 */
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildPorTree, provePorLeaf } from './sumtree.ts';
import type { PorLeafInput, PorTree, PorTreeAlgo } from './sumtree.ts';
import { buildSnapshotStatement, porSnapshotCommitment, validateSnapshotStatement } from './snapshot.ts';
import type { PorSnapshotStatement } from './snapshot.ts';
import { synthesiseLiabilities } from './synth.ts';
import { fromBaseUnits } from './amounts.ts';
import type { AmountUnit } from './amounts.ts';
import { parseAssetSpecs, readAssetList, readLiabilitiesCsv, readLiabilitiesJson, STANDARD_COLUMNS } from './intake.ts';
import type { CsvLayout, IntakeOptions, IntakeReport, LiabilityRow } from './intake.ts';
import { leafFromRow } from './leaves.ts';
import { checkCapacity } from './limits.ts';
import { loadTreeDir, writeTreeDir } from './store.ts';
import { PorLedgerError, SnapshotRestoreError, anchorBalanceFile, customerProof, openSnapshot } from './anchor.ts';
import { SnapshotProofError, parseSnapshotProof } from './snapshot-proof.ts';
import type { PorSnapshotProof } from './snapshot-proof.ts';
import { buildSubmission, publicSpkiBase64, validateSubmission, verifySnapshotSignature } from './sign.ts';
import type { PorSubmission } from './sign.ts';
import { PorApiError, PorClient } from './client.ts';
import { porUserRefHash, verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';

const USAGE = `usage: attest-por <command> [options]

  anchor        --csv f.csv | --accounts-json f.json
                --amounts decimal|base --assets BTC:8,… | --assets-file assets.csv
                --exchange EX --name N --asof ISO --key signing-key.pem --core URL
                --proof-file por-proof.json [--spot-check] [--wait] [--timeout-sec 600] [csv options]
                API key: STONEHASH_API_KEY, or --api-key-file f, or --api-key k
                leaves one file, the proof file: with the export, it is the snapshot
  prove         --snapshot-proof por-proof.json --csv f.csv | --accounts-json f.json
                --user-ref u --out proof.json   |   --all --out-dir dir
  check         --csv f.csv | --accounts-json f.json
                --assets BTC:8,ETH:18 | --assets-file assets.csv
                --amounts decimal|base [csv options] [--json]
  status        --core URL --snapshot ID      (API key as for anchor)
  verify-proof  --proof proof.json --snapshot snapshot.json
  synth         --users N --assets BTC,ETH,USDT --out f.jsonl|f.csv [--seed n]

  in separate steps, leaving a directory (as snapshots were kept before the proof file):
  build         --csv f.csv | --accounts-json f.json   (or --liabilities f.jsonl)
                --amounts decimal|base --assets BTC:8,… | --assets-file assets.csv
                --exchange EX --name N --asof ISO --out dir
                [--seed-hex h] [--reserves r.json] [--tree-format v2|v1] [csv options]
  sign          --tree dir --key signing-key.pem
  submit        --tree dir --core URL [--spot-check] [--wait] [--timeout-sec 600]
  prove         --tree dir --user-ref u --out proof.json   |   --tree dir --all --out-dir dir
  open          --tree dir --indices 1,5,9 --out openings.json

  assets        --assets-file names a file of "symbol,decimals" lines, for an
                exchange that lists more assets than fit on a command line
  csv options   --layout wide|long|sheet      decided from the header when omitted (wide — one row
                                              per account — is the standard shape)
                --col-account n --col-asset n --col-balance n
                                              header names, when not ${STANDARD_COLUMNS.account},${STANDARD_COLUMNS.asset},${STANDARD_COLUMNS.balance}
                --ignore-columns a,b          wide layout: columns that are not balances
                --delimiter ';'               when the export is not comma-separated
`;

class Exit extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
function die(msg: string, code = 1): never { throw new Exit(code, msg); }
const say = (text: string): void => { process.stdout.write(text + '\n'); };

type Spec = Record<string, { type: 'string' | 'boolean'; required?: boolean }>;

function opts(spec: Spec): Record<string, string | boolean | undefined> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(3),
      options: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, { type: v.type }])),
    }));
  } catch (e) {
    // parseArgs reports an unknown flag by throwing; without this the reader
    // gets a stack trace for a typing mistake.
    return die(`${e instanceof Error ? e.message.split('\n')[0] : String(e)}\n\n${USAGE}`);
  }
  for (const [k, v] of Object.entries(spec)) {
    if (v.required && values[k] === undefined) die(`--${k} is required`);
  }
  return values;
}

const CSV_OPTIONS: Spec = {
  'accounts-json': { type: 'string' }, 'assets-file': { type: 'string' },
  layout: { type: 'string' }, 'col-account': { type: 'string' }, 'col-asset': { type: 'string' },
  'col-balance': { type: 'string' }, 'ignore-columns': { type: 'string' }, delimiter: { type: 'string' },
};

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function assetsFrom(text: string): IntakeOptions['assets'] {
  const { assets, problems } = parseAssetSpecs(text);
  if (problems.length > 0) die(`--assets: ${problems.join('; ')}`);
  return assets;
}

/**
 * The asset list: on the command line, or — because an exchange may list
 * hundreds — in a file of `symbol,decimals` lines. Either way it is the
 * exchange that states it; nothing is taken from the balances themselves.
 */
function assetsOf(o: Record<string, string | boolean | undefined>): IntakeOptions['assets'] {
  const inline = str(o.assets);
  const file = str(o['assets-file']);
  if ((inline === undefined) === (file === undefined)) die('pass exactly one of --assets and --assets-file');
  if (inline !== undefined) return assetsFrom(inline);
  if (!existsSync(file!)) die(`${file} not found`);
  try {
    return readAssetList(file!);
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
}

/** Which export to read: a CSV in one of its layouts, or a JSON array of accounts. */
function exportOf(o: Record<string, string | boolean | undefined>): { kind: 'csv' | 'json'; file: string } | null {
  const csv = str(o.csv);
  const json = str(o['accounts-json']);
  if (csv !== undefined && json !== undefined) die('pass --csv or --accounts-json, not both');
  const file = csv ?? json;
  if (file === undefined) return null;
  if (!existsSync(file)) die(`${file} not found`);
  return { kind: csv !== undefined ? 'csv' : 'json', file };
}

/** Balances held per account, on average — what the size of a tree follows. */
function heldPerAccount(holders: Record<string, number>, accounts: number): number {
  return accounts > 0 ? Object.values(holders).reduce((a, b) => a + b, 0) / accounts : 0;
}

function intakeOptions(o: Record<string, string | boolean | undefined>, assets: IntakeOptions['assets']): IntakeOptions {
  const amounts = str(o.amounts);
  if (amounts !== 'decimal' && amounts !== 'base') {
    // Never defaulted: "1" is one coin or one smallest unit, and only the
    // exchange knows which its ledger exports.
    die('--amounts is required: "decimal" if the file says 0.5 for half a coin, "base" if it holds whole numbers of the smallest unit');
  }
  const layout = str(o.layout);
  if (layout !== undefined && layout !== 'long' && layout !== 'wide' && layout !== 'sheet') die('--layout is "long", "wide" or "sheet"');
  const delimiter = str(o.delimiter) === '\\t' ? '\t' : str(o.delimiter);
  if (delimiter !== undefined && delimiter.length !== 1) die('--delimiter is a single character (write \\t for a tab)');
  const columns = {
    ...(str(o['col-account']) ? { account: str(o['col-account'])! } : {}),
    ...(str(o['col-asset']) ? { asset: str(o['col-asset'])! } : {}),
    ...(str(o['col-balance']) ? { balance: str(o['col-balance'])! } : {}),
  };
  return {
    assets,
    amounts: amounts as AmountUnit,
    ...(layout ? { layout: layout as CsvLayout } : {}),
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(str(o['ignore-columns']) ? { ignoreColumns: str(o['ignore-columns'])!.split(',').map((c) => c.trim()).filter(Boolean) } : {}),
    ...(delimiter ? { delimiter } : {}),
  };
}

const grouped = (n: number): string => n.toLocaleString('en-US');

function describeReport(r: IntakeReport, assets: IntakeOptions['assets']): string[] {
  const lines = [
    `read ${r.input.file}  (${grouped(r.input.bytes)} bytes, sha256 ${r.input.sha256.slice(0, 16)}…)`,
    `  layout    ${r.layout ?? '—'}`,
    `  rows      ${grouped(r.rows)}`,
    `  accounts  ${grouped(r.accounts)}${r.zero_balance_accounts > 0 ? `  (${grouped(r.zero_balance_accounts)} with every balance zero)` : ''}`,
  ];
  if (r.ok) {
    const width = Math.max(...assets.map((a) => a.symbol.length));
    for (const a of assets) {
      const total = r.totals[a.symbol] ?? '0';
      lines.push(`  ${a.symbol.padEnd(width)}  total ${fromBaseUnits(total, a.decimals)}  (${total} smallest units), held by ${grouped(r.holders[a.symbol] ?? 0)}`);
    }
    if (r.ignored_columns.length > 0) lines.push(`  ignored columns: ${r.ignored_columns.join(', ')}`);
    if (r.assets_without_balance.length > 0) {
      lines.push(`  note: no balance above zero for ${r.assets_without_balance.join(', ')} — remove from --assets if the exchange holds none`);
    }
    return lines;
  }
  lines.push(`✗ ${grouped(r.problem_count)} problem${r.problem_count === 1 ? '' : 's'}${r.problem_count > r.problems.length ? ` (first ${r.problems.length} shown)` : ''}`);
  for (const p of r.problems) lines.push(`  ${p.line > 0 ? `line ${p.line}`.padEnd(11) : 'file'.padEnd(11)} ${p.code.padEnd(24)} ${p.message}`);
  return lines;
}

function readJsonl(file: string): LiabilityRow[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    let row: LiabilityRow;
    try {
      row = JSON.parse(line) as LiabilityRow;
    } catch {
      return die(`liabilities line ${i + 1} is not JSON`);
    }
    if (typeof row?.user_ref !== 'string' || row.user_ref === '' || typeof row.balances !== 'object' || row.balances === null) {
      die(`liabilities line ${i + 1}: expected {"user_ref": "…", "balances": {"ASSET": "integer"}}`);
    }
    return row;
  });
}

function apiKey(o: Record<string, string | boolean | undefined>): string {
  const file = str(o['api-key-file']);
  const key = str(o['api-key']) ?? (file ? readFileSync(file, 'utf8').trim() : undefined) ?? process.env['STONEHASH_API_KEY'];
  if (!key) die('no API key: set STONEHASH_API_KEY, or pass --api-key-file <file> (or --api-key <key>)');
  return key!;
}

const readJson = <T>(file: string, what: string): T => {
  if (!existsSync(file)) die(`${file} not found — ${what}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return die(`${file} is not JSON`);
  }
};

const proofFile = customerProof;

/**
 * A snapshot from its proof file and the export it was built from — the
 * SDK's `openSnapshot`, with its refusals said the way a terminal wants them:
 * what differed, and whether the file given is the one the proof file was
 * written for.
 */
async function restoreFromFiles(proofPath: string, o: Record<string, string | boolean | undefined>): Promise<{
  statement: PorSnapshotStatement; tree: PorTree; leaves: PorLeafInput[];
}> {
  if (!existsSync(proofPath)) die(`${proofPath} not found`);
  let proof: PorSnapshotProof;
  try {
    proof = parseSnapshotProof(readFileSync(proofPath, 'utf8'));
  } catch (e) {
    if (e instanceof SnapshotProofError) return die(`${proofPath}: ${e.message}`);
    throw e;
  }
  const from = exportOf(o) ?? die('--snapshot-proof needs the export the snapshot was built from: --csv or --accounts-json');
  const wantJson = proof.source.layout === 'json';
  if ((from.kind === 'json') !== wantJson) {
    die(wantJson
      ? 'this snapshot was built from a JSON array of accounts; pass that file with --accounts-json'
      : 'this snapshot was built from a CSV export; pass that file with --csv');
  }
  const named = proof.snapshot_id ?? '(not yet submitted)';
  const recorded = `the proof file was written for ${proof.source.file} (${grouped(proof.source.bytes)} bytes, sha256 ${proof.source.sha256.slice(0, 16)}…)`;
  try {
    const { statement, tree, leaves } = await openSnapshot(proofPath, from.file);
    return { statement, tree, leaves };
  } catch (e) {
    if (e instanceof PorLedgerError) {
      if (e.code === 'too_large' || e.report === null) return die(e.message, 2);
      process.stderr.write(describeReport(e.report, proof.statement.assets).join('\n') + '\n');
      return die(`${from.file} cannot be read as the export of snapshot ${named}; nothing was issued.${
        e.report.input.sha256 === proof.source.sha256 ? '' : `\n  ${recorded}`}`, 2);
    }
    if (!(e instanceof SnapshotRestoreError) || e.mismatch === null) throw e;
    const m = e.mismatch;
    return die([
      `${from.file} does not rebuild snapshot ${named}; nothing was issued.`,
      `  root      anchored ${m.root[0]}`,
      `            rebuilt  ${m.root[1] || '—'}`,
      ...(m.accounts[0] !== m.accounts[1] ? [`  accounts  anchored ${grouped(m.accounts[0])}, rebuilt ${grouped(m.accounts[1])}`] : []),
      ...Object.entries(m.totals).map(([asset, [stated, got]]) => `  ${asset}  anchored ${stated}, rebuilt ${got}  (smallest units)`),
      e.sameFile
        ? '  the export is byte for byte the one recorded, so it is the proof file that has been altered'
        : `  ${recorded}; this file's sha256 is ${e.given.sha256.slice(0, 16)}…`,
    ].join('\n'), 2);
  }
}

/** A signing key from a PEM file, or the run stops saying what the file is not. */
function signingKey(file: string): KeyObject {
  if (!existsSync(file)) die(`${file} not found`);
  try {
    return createPrivateKey(readFileSync(file, 'utf8'));
  } catch {
    return die(`${file} is not a private key in PEM form`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'synth': {
      const o = opts({ users: { type: 'string', required: true }, assets: { type: 'string', required: true },
        out: { type: 'string', required: true }, seed: { type: 'string' } });
      const symbols = str(o.assets)!.split(',');
      const users = synthesiseLiabilities({
        users: Number(o.users), assets: symbols,
        ...(o.seed ? { seed: Number(o.seed) } : {}),
      });
      const out = str(o.out)!;
      if (out.toLowerCase().endsWith('.csv')) {
        // Long layout, whole numbers of the smallest unit: build it with --amounts base.
        const lines = [`${STANDARD_COLUMNS.account},${STANDARD_COLUMNS.asset},${STANDARD_COLUMNS.balance}`];
        for (const u of users) for (const [asset, v] of Object.entries(u.balances)) lines.push(`${u.user_ref},${asset},${v}`);
        writeFileSync(out, lines.join('\n') + '\n');
      } else {
        writeFileSync(out, users.map((u) => JSON.stringify(u)).join('\n') + '\n');
      }
      say(`wrote ${users.length} synthetic liabilities → ${out}`);
      break;
    }

    case 'anchor': {
      const o = opts({
        csv: { type: 'string' }, amounts: { type: 'string' }, assets: { type: 'string' },
        exchange: { type: 'string', required: true }, name: { type: 'string', required: true },
        asof: { type: 'string', required: true }, key: { type: 'string', required: true },
        core: { type: 'string', required: true }, 'proof-file': { type: 'string', required: true },
        'spot-check': { type: 'boolean' }, wait: { type: 'boolean' }, 'timeout-sec': { type: 'string' },
        'api-key': { type: 'string' }, 'api-key-file': { type: 'string' }, 'seed-hex': { type: 'string' },
        ...CSV_OPTIONS,
      });
      const from = exportOf(o) ?? die('--csv or --accounts-json is required');
      const assets = assetsOf(o);
      const intake = intakeOptions(o, assets);
      const asof = str(o.asof)!;
      if (Number.isNaN(Date.parse(asof))) die(`--asof "${asof}" is not a time; write it as 2026-11-16T00:00:00Z`);
      const timeoutSec = o['timeout-sec'] === undefined ? 600 : Number(o['timeout-sec']);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout-sec is a number of seconds');
      const seed = o['seed-hex'] ? Buffer.from(str(o['seed-hex'])!, 'hex') : undefined;
      if (seed && seed.length !== 32) die('--seed-hex must be 32 bytes of hex');
      const client = new PorClient({
        core: str(o.core)!, apiKey: apiKey(o),
        institutionId: str(o.exchange)!, institutionName: str(o.name)!, key: signingKey(str(o.key)!),
      });
      // Said here, before anything is read or written: a statement signed with
      // a key the platform does not hold would only be refused on arrival.
      try {
        await client.assertRegistered();
      } catch (e) {
        if (e instanceof PorApiError && e.code === 'key_mismatch') {
          return die(`${str(o.key)} is not the key registered for ${str(o.exchange)}; sign with the registered key, or register this one in the console`);
        }
        throw e;
      }
      const proofPath = str(o['proof-file'])!;
      const spot = o['spot-check'] === true;
      let r;
      try {
        r = await anchorBalanceFile(client, from.file, {
          assets, amounts: intake.amounts, asof, proofFile: proofPath, format: from.kind,
          ...(spot ? { spotCheck: true } : {}),
          ...(o.wait ? { waitAnchoredMs: timeoutSec * 1000 } : {}),
          ...(intake.layout ? { layout: intake.layout } : {}),
          ...(intake.columns ? { columns: intake.columns } : {}),
          ...(intake.ignoreColumns ? { ignoreColumns: intake.ignoreColumns } : {}),
          ...(intake.delimiter ? { delimiter: intake.delimiter } : {}),
          ...(seed ? { seed } : {}),
        });
      } catch (e) {
        if (e instanceof PorLedgerError) {
          if (e.report && !e.report.ok) process.stderr.write(describeReport(e.report, assets).join('\n') + '\n');
          return die(e.code === 'too_large' ? e.message : 'the export has problems; nothing was built or sent. Fix the export and run again.', 2);
        }
        if (e instanceof SnapshotProofError) return die(e.message, 2);
        throw e;
      }
      say([
        ...describeReport(r.report, assets),
        `${r.already ? 'already held by the platform' : 'accepted'}: snapshot ${r.snapshotId}  (${r.status})`,
        `  root         ${r.root}`,
        `  totals       ${JSON.stringify(r.totals)}`,
        `  commitment   ${r.commitment}`,
        spot
          ? `  spot check   passed — ${r.sampled} accounts opened to the platform`
          : '  spot check   not requested — no account was opened to the platform',
        `  anchor       ${r.anchor === 'confirmed' ? 'confirmed' : 'pending — "status" shows it confirm (or anchor again with --wait)'}`,
        `  public       ${r.publicUrl}`,
        `→ ${proofPath}  (the proof file — keep it with ${from.file}; the two are the snapshot. It holds the seed: keep it private)`,
      ].join('\n'));
      break;
    }

    case 'check': {
      const o = opts({ csv: { type: 'string' }, assets: { type: 'string' },
        amounts: { type: 'string' }, json: { type: 'boolean' }, ...CSV_OPTIONS });
      const assets = assetsOf(o);
      const from = exportOf(o) ?? die('--csv or --accounts-json is required');
      const intake = intakeOptions(o, assets);
      const { report } = from.kind === 'csv' ? await readLiabilitiesCsv(from.file, intake) : readLiabilitiesJson(from.file, intake);
      const capacity = checkCapacity(report.accounts, assets.length, undefined, heldPerAccount(report.holders, report.accounts));
      if (o.json) say(JSON.stringify({ ...report, capacity }, null, 2));
      else {
        say(describeReport(report, assets).join('\n'));
        if (report.ok && !capacity.ok) say(`✗ too large for this run: ${capacity.message}`);
        else if (report.ok) say('OK — this file can be built.');
      }
      if (!report.ok || !capacity.ok) throw new Exit(2, '');
      break;
    }

    case 'build': {
      const o = opts({
        liabilities: { type: 'string' }, csv: { type: 'string' }, amounts: { type: 'string' },
        exchange: { type: 'string', required: true },
        name: { type: 'string', required: true },
        asof: { type: 'string', required: true },
        assets: { type: 'string' },                     // "BTC:8,ETH:18,USDT:6"
        out: { type: 'string', required: true },
        'seed-hex': { type: 'string' },
        reserves: { type: 'string' },
        'tree-format': { type: 'string' },
        ...CSV_OPTIONS,
      });
      const from = exportOf(o);
      if ((from === null) === (o.liabilities === undefined)) die('pass exactly one of --csv, --accounts-json and --liabilities');
      // v2 unless asked: v1 is for reproducing a snapshot that was built with it.
      const format = str(o['tree-format']) ?? 'v2';
      if (format !== 'v1' && format !== 'v2') die('--tree-format is "v2" (the default) or "v1"');
      const algo: PorTreeAlgo = format === 'v1' ? 'merkle-sum-sha256-v1' : 'merkle-sum-sha256-v2';
      const exchange = str(o.exchange)!;
      const asof = str(o.asof)!;
      if (Number.isNaN(Date.parse(asof))) die(`--asof "${asof}" is not a time; write it as 2026-11-16T00:00:00Z`);
      const assetSpecs = assetsOf(o);
      const symbols = assetSpecs.map((a) => a.symbol);
      const seed = o['seed-hex'] ? Buffer.from(str(o['seed-hex'])!, 'hex') : randomBytes(32);
      if (seed.length !== 32) die('--seed-hex must be 32 bytes of hex');

      let rows: LiabilityRow[];
      let report: IntakeReport | null = null;
      let source: Record<string, unknown>;
      if (from !== null) {
        const intake = intakeOptions(o, assetSpecs);
        ({ rows, report } = from.kind === 'csv' ? await readLiabilitiesCsv(from.file, intake) : readLiabilitiesJson(from.file, intake));
        if (!report.ok) {
          process.stderr.write(describeReport(report, assetSpecs).join('\n') + '\n');
          die('the export has problems; nothing was built. Fix the export and run again.', 2);
        }
        source = { kind: from.kind, ...report.input, layout: report.layout, amounts: intake.amounts, rows: report.rows };
      } else {
        const file = str(o.liabilities)!;
        if (!existsSync(file)) die(`${file} not found`);
        rows = readJsonl(file);
        source = {
          kind: 'jsonl', file: path.basename(file), bytes: statSync(file).size,
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), rows: rows.length,
        };
      }
      // v1 writes a figure for every listed asset; v2 only for what is held.
      const figures = rows.reduce((n, r) => n + Object.values(r.balances).filter((v) => v !== '0').length, 0);
      const capacity = checkCapacity(rows.length, symbols.length, undefined,
        algo === 'merkle-sum-sha256-v1' ? symbols.length : figures / Math.max(1, rows.length));
      if (!capacity.ok) die(`too large for this run: ${capacity.message}`, 2);

      const leaves = rows.map((r) => leafFromRow(exchange, seed, r));
      const t0 = Date.now();
      const tree = buildPorTree(leaves, symbols, { algo });
      let reserves;
      if (o.reserves) {
        const entries = readJson<{ chain: string; asset: string; address: string; token_contract?: string }[]>(
          str(o.reserves)!, 'the reserve address list');
        // The platform refuses a statement whose reserve list it cannot read;
        // say so here, before the statement is built and signed.
        const usable = Array.isArray(entries) && entries.every((e) => e !== null && typeof e === 'object'
          && [e.chain, e.asset, e.address].every((v) => typeof v === 'string' && v !== '')
          && (e.token_contract === undefined || typeof e.token_contract === 'string'));
        if (!usable) die(`${str(o.reserves)} must be a JSON list of { "chain", "asset", "address", "token_contract"? } with text values`);
        reserves = {
          mode: 'DECLARED' as const,
          entries,
          note: 'Addresses declared by the exchange; balances are measured on chain by verifiers. '
            + 'Address-control proof is out of sandbox scope.',
        };
      }
      const statement = buildSnapshotStatement({
        institutionId: exchange, name: str(o.name)!, asof, assets: assetSpecs,
        ...(reserves ? { reserves } : {}),
      }, tree);
      const commitment = porSnapshotCommitment(statement);

      const out = str(o.out)!;
      mkdirSync(out, { recursive: true });
      await writeTreeDir(out, exchange, tree, leaves);
      writeFileSync(path.join(out, 'seed.hex'), seed.toString('hex') + '\n');
      chmodSync(path.join(out, 'seed.hex'), 0o600);
      writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify(statement, null, 2) + '\n');
      writeFileSync(path.join(out, 'build-report.json'), JSON.stringify({
        schema: 'stonehash.por-build-report.v1',
        built_at: statement.generated_at,
        exchange_id: exchange,
        asof,
        source,
        accounts: tree.leaf_count,
        ...(report ? { zero_balance_accounts: report.zero_balance_accounts } : {}),
        assets: assetSpecs.map((a) => ({
          symbol: a.symbol, decimals: a.decimals,
          total_smallest_units: tree.totals[a.symbol] ?? '0',
          total: fromBaseUnits(tree.totals[a.symbol] ?? '0', a.decimals),
          ...(report ? { holders: report.holders[a.symbol] ?? 0 } : {}),
        })),
        root: tree.root,
        commitment,
      }, null, 2) + '\n');

      say([
        `built sum tree: ${tree.leaf_count} leaves in ${Date.now() - t0}ms`,
        `root       ${tree.root}`,
        `totals     ${JSON.stringify(tree.totals)}`,
        `commitment ${commitment}`,
        `→ ${out}/snapshot.json (platform)  leaves.jsonl + seed.hex + tree.json (keep private, 0600)`,
        ...(report ? describeReport(report, assetSpecs) : []),
      ].join('\n'));
      break;
    }

    case 'sign': {
      const o = opts({ tree: { type: 'string', required: true }, key: { type: 'string', required: true } });
      const dir = str(o.tree)!;
      const statement = readJson<PorSnapshotStatement>(path.join(dir, 'snapshot.json'), 'run "build" first');
      const key = signingKey(str(o.key)!);
      let submission: PorSubmission;
      try {
        submission = buildSubmission(statement, key);
      } catch (e) {
        return die(e instanceof Error ? e.message : String(e));
      }
      const spki = publicSpkiBase64(key);
      if (!verifySnapshotSignature(statement, submission.sig, spki)) die('the signature did not verify against its own key; nothing was written');
      const file = path.join(dir, 'submission.json');
      writeFileSync(file, JSON.stringify(submission, null, 2) + '\n');
      say([
        `signed → ${file}  (${grouped(statSync(file).size)} bytes)`,
        `  exchange    ${statement.exchange.institution_id}  ${statement.exchange.name}`,
        `  as of       ${statement.asof}`,
        `  accounts    ${grouped(statement.tree.leaf_count)}`,
        `  root        ${statement.tree.root}`,
        `  totals      ${JSON.stringify(statement.totals)}`,
        `  commitment  ${porSnapshotCommitment(statement)}`,
        `  signing key sha256 ${createHash('sha256').update(Buffer.from(spki, 'base64')).digest('hex').slice(0, 16)}…`,
        'This file is everything "submit" sends. It holds no account and no balance.',
      ].join('\n'));
      break;
    }

    case 'submit': {
      const o = opts({ tree: { type: 'string', required: true }, core: { type: 'string', required: true },
        'spot-check': { type: 'boolean' }, wait: { type: 'boolean' }, 'timeout-sec': { type: 'string' },
        'api-key': { type: 'string' }, 'api-key-file': { type: 'string' } });
      const dir = str(o.tree)!;
      const submission = readJson<PorSubmission>(path.join(dir, 'submission.json'), 'run "sign" first');
      const bad = validateSubmission(submission);
      if (bad.length > 0) die(`submission.json is not usable: ${bad.join('; ')}`);
      const timeoutSec = o['timeout-sec'] === undefined ? 600 : Number(o['timeout-sec']);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) die('--timeout-sec is a number of seconds');
      const core = str(o.core)!.replace(/\/+$/, '');
      const client = new PorClient({
        core, apiKey: apiKey(o),
        institutionId: submission.statement.exchange.institution_id,
        institutionName: submission.statement.exchange.name,
      });

      // Checked here so "signed with a key the platform does not hold" is a
      // message on this machine, before anything has been sent.
      const registered = await client.registeredKey();
      if (!verifySnapshotSignature(submission.statement, submission.sig, registered)) {
        die('submission.json was not signed with the key registered for this exchange; sign it with the registered key, or register this one in the console');
      }

      const spot = o['spot-check'] === true;
      const result = await client.submit(submission, spot ? { spotCheck: await loadTreeDir(dir) } : {});
      if (result.openings) {
        // Kept beside the snapshot: an exact record of the account-level data that left.
        writeFileSync(path.join(dir, 'openings.json'),
          JSON.stringify({ schema: 'stonehash.por-openings.v1', openings: result.openings }, null, 2) + '\n');
      }
      const receipt: Record<string, unknown> = {
        schema: 'stonehash.por-receipt.v1',
        snapshot_id: result.snapshotId,
        status: result.status,
        spot_check: spot,
        sampled_accounts: result.sampled,
        attestation_id: result.attestationId,
        commitment: porSnapshotCommitment(submission.statement),
        root: submission.statement.tree.root,
        platform: core,
        public_url: client.publicUrl(result.snapshotId),
        verify_page: `${core}/playground/por.html`,
        received_at: new Date().toISOString(),
        anchor: 'pending',
      };
      const receiptPath = path.join(dir, 'receipt.json');
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      say([
        `${result.already ? 'already held by the platform' : 'accepted'}: snapshot ${result.snapshotId}  (${result.status})`,
        spot
          ? `  spot check   passed — ${result.sampled} accounts opened to the platform (what was sent: ${path.join(dir, 'openings.json')})`
          : '  spot check   not requested — no account was opened to the platform',
        `  anchoring    record ${result.attestationId}`,
        `  public       ${receipt['public_url']}`,
      ].join('\n'));

      if (o.wait) {
        await client.waitAnchored(result.snapshotId, timeoutSec * 1000);
        receipt['anchor'] = 'confirmed';
        receipt['anchor_confirmed_at'] = new Date().toISOString();
        writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
        say('  anchor       confirmed');
      } else {
        say('  anchor       pending — run "status" (or submit again with --wait) to see it confirm');
      }
      say(`→ ${receiptPath}`);
      break;
    }

    case 'status': {
      const o = opts({ core: { type: 'string', required: true }, snapshot: { type: 'string', required: true },
        'api-key': { type: 'string' }, 'api-key-file': { type: 'string' } });
      const client = new PorClient({ core: str(o.core)!, apiKey: apiKey(o), institutionId: '', institutionName: '' });
      say(JSON.stringify(await client.status(str(o.snapshot)!), null, 2));
      break;
    }

    case 'prove': {
      const o = opts({ tree: { type: 'string' }, 'snapshot-proof': { type: 'string' }, csv: { type: 'string' },
        'accounts-json': { type: 'string' }, 'user-ref': { type: 'string' }, out: { type: 'string' },
        all: { type: 'boolean' }, 'out-dir': { type: 'string' } });
      const dir = str(o.tree);
      const proofPath = str(o['snapshot-proof']);
      if ((dir === undefined) === (proofPath === undefined)) {
        die('pass --tree <the directory "build" wrote>, or --snapshot-proof <file> with the export it was built from (--csv or --accounts-json)');
      }
      if (dir !== undefined && exportOf(o) !== null) die('--csv and --accounts-json go with --snapshot-proof; --tree already holds the leaves');
      const { statement, tree, leaves } = dir !== undefined
        ? { statement: readJson<PorSnapshotStatement>(path.join(dir, 'snapshot.json'), 'run "build" first'), ...await loadTreeDir(dir) }
        : await restoreFromFiles(proofPath!, o);

      if (o.all) {
        const outDir = str(o['out-dir']) ?? die('--all needs --out-dir');
        // Filed under the hashed reference, two levels deep: no directory
        // ends up with a million entries, and no file name is an account id.
        const made = new Set<string>();
        for (let at = 0; at < leaves.length; at++) {
          const leaf = leaves[at]!;
          const sub = path.join(outDir, leaf.user_ref_hash.slice(0, 2));
          if (!made.has(sub)) { mkdirSync(sub, { recursive: true }); made.add(sub); }
          const file = createWriteStream(path.join(sub, `${leaf.user_ref_hash}.json`));
          file.end(JSON.stringify(proofFile(statement, leaf, provePorLeaf(tree, at, leaf)), null, 2) + '\n');
          await once(file, 'finish');
        }
        say(`${grouped(leaves.length)} proofs → ${outDir}/<first two characters>/<hashed reference>.json`);
        break;
      }

      const ref = str(o['user-ref']) ?? die('--user-ref is required (or --all with --out-dir)');
      const outFile = str(o.out) ?? die('--out is required');
      // Looked up in the leaves themselves rather than through a keyed object:
      // a reference is whatever the exchange's ledger says it is.
      const at = leaves.findIndex((l) => l.user_ref === ref);
      if (at < 0) die(`no leaf for user_ref ${ref}`);
      const leaf = leaves[at]!;
      writeFileSync(outFile, JSON.stringify(proofFile(statement, leaf, provePorLeaf(tree, at, leaf)), null, 2) + '\n');
      say(`proof for ${leaf.user_ref} (leaf ${at}) → ${outFile}`);
      break;
    }

    case 'open': {
      const o = opts({ tree: { type: 'string', required: true },
        indices: { type: 'string', required: true }, out: { type: 'string', required: true } });
      const { tree, leaves } = await loadTreeDir(str(o.tree)!);
      const indices = str(o.indices)!.split(',').map((x) => Number(x.trim()));
      const openings = indices.map((i) => {
        const leaf = Number.isInteger(i) ? leaves[i] : undefined;
        if (!leaf) return die(`challenged index ${i} out of range`);
        // The opening is pseudonymous: user_ref_hash and balances, never user_ref.
        const { user_ref: _omit, ...opening } = leaf;
        return provePorLeaf(tree, i, opening);
      });
      writeFileSync(str(o.out)!, JSON.stringify({ schema: 'stonehash.por-openings.v1', openings }, null, 2) + '\n');
      say(`${openings.length} openings → ${str(o.out)}`);
      break;
    }

    case 'verify-proof': {
      const o = opts({ proof: { type: 'string', required: true }, snapshot: { type: 'string', required: true } });
      const proof = readJson<{ exchange: { institution_id: string }; user_ref?: string; proof: PorInclusionProof }>(
        str(o.proof)!, 'the proof file your exchange gave you');
      const statement = readJson<PorSnapshotStatement>(str(o.snapshot)!, 'the snapshot statement');
      const bad = validateSnapshotStatement(statement);
      if (bad.length > 0) die(`snapshot statement invalid: ${bad.join('; ')}`);

      const r = verifyPorInclusion(proof.proof, { root: statement.tree.root, totals: statement.totals });
      const refOk = proof.user_ref
        ? porUserRefHash(statement.exchange.institution_id, proof.user_ref) === proof.proof.leaf.user_ref_hash
        : null;

      say([
        `root+totals  ${r.ok ? 'MATCH' : 'FAIL'}`,
        ...(refOk !== null ? [`user_ref     ${refOk ? 'matches user_ref_hash' : 'DOES NOT match user_ref_hash'}`] : []),
        `balances     ${JSON.stringify(proof.proof.leaf.balances)}`,
        ...(r.problems.length ? r.problems.map((x) => `  ! ${x}`) : []),
        `commitment   ${porSnapshotCommitment(statement)} (compare with the anchored leaf)`,
      ].join('\n'));
      if (!r.ok || refOk === false) throw new Exit(2, '');
      break;
    }

    case undefined: case '--help': case '-h': case 'help':
      say(USAGE);
      break;

    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof Exit) {
    if (e.message) process.stderr.write(`attest-por: ${e.message}\n`);
    process.exitCode = e.code;
  } else if (e instanceof PorApiError) {
    process.stderr.write(`attest-por: the platform refused (${e.code}${e.status ? `, HTTP ${e.status}` : ''}): ${e.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`attest-por: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
