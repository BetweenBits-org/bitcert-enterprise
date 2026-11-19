/**
 * Two files are a snapshot: the balance export, and the proof file.
 *
 * The claim under test is that nothing else has to be kept. A snapshot that
 * was built and anchored leaves one small file behind; given that file and
 * the export again, the tree is the same tree — same root, same proofs — and
 * given anything else in the export's place, nothing is issued and the
 * refusal says what differed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { porUserRefHash, verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import {
  CsvLedgerReader, SNAPSHOT_PROOF_SCHEMA, SnapshotProofError, buildPorTree, buildSnapshotProof, buildSnapshotStatement,
  leafFromRow, ledgerOptionsOf, parseSnapshotProof, provePorLeaf, readAccountsJson, restoreSnapshot, snapshotProofText,
  validateSnapshotProof,
} from '../src/index.ts';
import type { IntakeOptions, LiabilityRow, PorSnapshotProof, PorSnapshotProofSource, PorTreeAlgo } from '../src/index.ts';
import { leafFromRowPortable } from '../src/portable.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
const SAMPLES = path.resolve(import.meta.dirname, '../samples');
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const EXCHANGE = 'KR-EX-0a1b2c';
const ASSETS = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
/** The root `handoff.test.ts` pins for the sample ledger under this seed, in each tree format. */
const SAMPLE_ROOT = 'eeb2534289eb2a990c5b526a511a5d0ebf80a06069488a9cf1b8ef905feba297';
const SAMPLE_ROOT_V1 = '0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa';
const SIG = { alg: 'ES256' as const, key_id: EXCHANGE, issuer: 'Sample Exchange', sig: 'c2lnbmF0dXJl' };

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Read an export's text the way a caller does: the CSV reader, or the JSON one. */
function read(text: string, layout: PorSnapshotProofSource['layout'], o: IntakeOptions): LiabilityRow[] {
  const { rows, report } = layout === 'json'
    ? readAccountsJson(text, o)
    : (() => { const r = new CsvLedgerReader(o); r.pushText(text); return r.end(); })();
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  return rows;
}

/** Build a snapshot from an export and write its proof file, as the console does after the platform accepts. */
function anchor(text: string, file: string, layout: PorSnapshotProofSource['layout'], o: {
  assets?: typeof ASSETS; algo?: PorTreeAlgo; reader?: Partial<IntakeOptions>; source?: Partial<PorSnapshotProofSource>;
} = {}): { proof: PorSnapshotProof; root: string } {
  const assets = o.assets ?? ASSETS;
  const rows = read(text, layout, { assets, amounts: 'decimal', ...o.reader });
  const tree = buildPorTree(rows.map((r) => leafFromRow(EXCHANGE, SEED, r)), assets.map((a) => a.symbol), o.algo ? { algo: o.algo } : {});
  const statement = buildSnapshotStatement({ institutionId: EXCHANGE, name: 'Sample Exchange', asof: '2026-11-16T00:00:00Z', assets }, tree);
  const proof = buildSnapshotProof({
    snapshotId: '3ca03638-415f-432f-b733-f203b824ba5d', platform: 'http://platform.example', statement, sig: SIG, seed: SEED,
    source: { file, bytes: Buffer.byteLength(text), sha256: sha256(text), layout, amounts: 'decimal', ...o.source },
  });
  return { proof, root: tree.root };
}

const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), 'utf8');

test('the proof file and the export rebuild the anchored tree, and every account\'s proof from it verifies', () => {
  const text = sample('balances.long.csv');
  const { proof, root } = anchor(text, 'balances.long.csv', 'long');
  assert.equal(root, SAMPLE_ROOT, 'the snapshot under test is the one whose root is pinned');

  // Only the file goes forward: what is restored comes from its text and the export's.
  const kept = parseSnapshotProof(snapshotProofText(proof));
  assert.deepEqual(kept, proof);
  const { tree, leaves } = restoreSnapshot(kept, read(text, kept.source.layout, ledgerOptionsOf(kept)));
  assert.equal(tree.root, SAMPLE_ROOT);
  assert.equal(tree.leaf_count, kept.statement.tree.leaf_count);
  assert.deepEqual(tree.totals, kept.statement.totals);

  assert.equal(leaves.length, 12);
  for (let at = 0; at < leaves.length; at++) {
    const leaf = leaves[at]!;
    assert.equal(tree.index[leaf.user_ref], at, 'leaves come back in tree order');
    assert.equal(leaf.user_ref_hash, porUserRefHash(EXCHANGE, leaf.user_ref));
    const r = verifyPorInclusion(provePorLeaf(tree, at, leaf), { root: kept.statement.tree.root, totals: kept.statement.totals });
    assert.equal(r.ok, true, `${leaf.user_ref}: ${r.problems.join('; ')}`);
  }
});

test('the file holds the seed and how the export was read, and no account or balance', () => {
  const text = sample('balances.long.csv');
  const { proof } = anchor(text, 'balances.long.csv', 'long');
  const written = snapshotProofText(proof);
  assert.equal(proof.schema, SNAPSHOT_PROOF_SCHEMA);
  assert.equal(proof.seed, SEED.toString('hex'));
  assert.deepEqual(proof.source, {
    file: 'balances.long.csv', bytes: Buffer.byteLength(text), sha256: sha256(text), layout: 'long', amounts: 'decimal',
  });
  assert.match(proof.notice, /Private/);
  // Neither an identifier nor a hashed one, nor any figure that is one account's.
  for (const row of read(text, 'long', { assets: ASSETS, amounts: 'decimal' })) {
    assert.ok(!written.includes(row.user_ref), `${row.user_ref} is in the proof file`);
    assert.ok(!written.includes(porUserRefHash(EXCHANGE, row.user_ref)), 'a hashed reference is in the proof file');
  }
  assert.ok(written.length < 2500, `a proof file should stay small whatever the ledger; this one is ${written.length} bytes`);
});

test('the same ledger in each of the four shapes restores to the same root from its own proof file', () => {
  for (const [file, layout] of [['balances.long.csv', 'long'], ['balances.wide.csv', 'wide'],
    ['balances.sheet.csv', 'sheet'], ['accounts.json', 'json']] as const) {
    const text = sample(file);
    const { proof } = anchor(text, file, layout);
    const kept = parseSnapshotProof(snapshotProofText(proof));
    const options = ledgerOptionsOf(kept);
    assert.equal(options.layout, layout === 'json' ? undefined : layout, 'the recorded layout is the one the export is read back in');
    assert.equal(restoreSnapshot(kept, read(text, layout, options)).tree.root, SAMPLE_ROOT, file);
  }
});

test('a snapshot in the first tree format is restored in that format', () => {
  const text = sample('balances.long.csv');
  const { proof, root } = anchor(text, 'balances.long.csv', 'long', { algo: 'merkle-sum-sha256-v1' });
  assert.equal(root, SAMPLE_ROOT_V1);
  const { tree, leaves } = restoreSnapshot(proof, read(text, 'long', ledgerOptionsOf(proof)));
  assert.equal(tree.algo, 'merkle-sum-sha256-v1');
  assert.equal(tree.root, SAMPLE_ROOT_V1);
  const r = verifyPorInclusion(provePorLeaf(tree, 0, leaves[0]!), { root: SAMPLE_ROOT_V1, totals: proof.statement.totals });
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('an export read with its own column names, delimiter and skipped columns is read back the same way', () => {
  const text = 'uid;memo;BTC;ETH\nA-1;vip;0.5;2\nA-2;;0.25;\nA-3;x;;7.000000000000000001\n';
  const reader = { columns: { account: 'uid' }, ignoreColumns: ['memo'], delimiter: ';' };
  const assets = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }];
  const { proof, root } = anchor(text, 'export.csv', 'wide', {
    assets, reader, source: { columns: reader.columns, ignore_columns: reader.ignoreColumns, delimiter: ';' },
  });
  const kept = parseSnapshotProof(snapshotProofText(proof));
  assert.deepEqual(ledgerOptionsOf(kept), { assets, amounts: 'decimal', layout: 'wide', ...reader });
  assert.equal(restoreSnapshot(kept, read(text, 'wide', ledgerOptionsOf(kept))).tree.root, root);
  // The defaults are not written: a file read the plain way says nothing about columns.
  const plain = anchor(sample('balances.wide.csv'), 'balances.wide.csv', 'wide', { source: { delimiter: ',', ignore_columns: [], columns: {} } });
  assert.deepEqual(Object.keys(plain.proof.source), ['file', 'bytes', 'sha256', 'layout', 'amounts']);
});

test('an export that is not the anchored one is refused, and the refusal says what differed', () => {
  const text = sample('balances.long.csv');
  const { proof } = anchor(text, 'balances.long.csv', 'long');
  const attempt = (changed: string): SnapshotProofError => {
    try {
      restoreSnapshot(proof, read(changed, 'long', ledgerOptionsOf(proof)));
    } catch (e) {
      assert.ok(e instanceof SnapshotProofError, String(e));
      assert.equal(e.code, 'mismatch');
      assert.ok(e.mismatch);
      assert.equal(e.mismatch.root[0], SAMPLE_ROOT);
      assert.notEqual(e.mismatch.root[1], SAMPLE_ROOT);
      return e;
    }
    return assert.fail('a changed export was restored');
  };

  // One balance edited: that asset's total differs, the account count does not.
  const edited = attempt(text.replace('U-100001,BTC,0.50000000', 'U-100001,BTC,0.50000001')).mismatch!;
  assert.deepEqual(edited.totals, { BTC: ['2463358024', '2463358025'] });
  assert.deepEqual(edited.accounts, [12, 12]);

  // One account's rows removed.
  const removed = attempt(text.split('\n').filter((l) => !l.startsWith('U-100002,')).join('\n')).mismatch!;
  assert.deepEqual(removed.accounts, [12, 11]);
  assert.deepEqual(Object.keys(removed.totals), ['BTC']);

  // A balance moved from one account to another: every total and the count still agree. Only the root tells.
  const moved = attempt(text.replace('U-100001,USDT,1500.25', 'U-100001,USDT,1500.24')
    .replace(/^(U-100003,USDT,)250000$/m, '$1250000.01')).mismatch!;
  assert.deepEqual(moved.totals, {});
  assert.deepEqual(moved.accounts, [12, 12]);

  // An account renamed.
  const renamed = attempt(text.replaceAll('U-100001,', 'U-200001,')).mismatch!;
  assert.deepEqual(renamed.totals, {});
  assert.deepEqual(renamed.accounts, [12, 12]);

  // No rows at all (a reader that refused the file hands back none).
  assert.throws(() => restoreSnapshot(proof, []), (e: unknown) => e instanceof SnapshotProofError && e.code === 'mismatch'
    && e.mismatch!.accounts[1] === 0 && e.mismatch!.root[1] === '');
});

test('a proof file that was altered does not restore either', () => {
  const text = sample('balances.long.csv');
  const { proof } = anchor(text, 'balances.long.csv', 'long');
  const rows = read(text, 'long', ledgerOptionsOf(proof));
  const altered = (change: (p: PorSnapshotProof) => void): PorSnapshotProof => {
    const copy = JSON.parse(JSON.stringify(proof)) as PorSnapshotProof;
    change(copy);
    return parseSnapshotProof(JSON.stringify(copy));
  };
  // Another seed: every salt, so every leaf, so the root.
  assert.throws(() => restoreSnapshot(altered((p) => { p.seed = 'ff'.repeat(32); }), rows), /does not rebuild/);
  // Another exchange: every hashed reference.
  assert.throws(() => restoreSnapshot(altered((p) => { p.statement.exchange.institution_id = 'KR-EX-ffffff'; }), rows), /does not rebuild/);
  // A total raised in the statement: the root still matches, the stated total does not.
  assert.throws(() => restoreSnapshot(altered((p) => { p.statement.totals['BTC'] = '9999999999'; }), rows),
    (e: unknown) => e instanceof SnapshotProofError && JSON.stringify(e.mismatch!.totals) === '{"BTC":["9999999999","2463358024"]}');
  // Other decimal places: the same text is read as other amounts.
  const scaled = altered((p) => { p.statement.assets[0]!.decimals = 9; });
  assert.throws(() => restoreSnapshot(scaled, read(text, 'long', ledgerOptionsOf(scaled))), /does not rebuild/);
});

test('the wrong file in the proof file\'s place is told apart by what it is', () => {
  const { proof } = anchor(sample('balances.long.csv'), 'balances.long.csv', 'long');
  const code = (text: string): string => {
    try { parseSnapshotProof(text); } catch (e) { assert.ok(e instanceof SnapshotProofError, String(e)); return e.code; }
    return 'accepted';
  };
  assert.equal(code(snapshotProofText(proof)), 'accepted');
  assert.equal(code('﻿' + snapshotProofText(proof)), 'accepted', 'a byte-order mark is not part of the file');
  assert.equal(code(sample('balances.long.csv')), 'not_json', 'the balance file itself');
  assert.equal(code(sample('accounts.json')), 'not_snapshot_proof', 'a JSON balance file');
  assert.equal(code(JSON.stringify({ schema: 'stonehash.por-proof.v1', user_ref: 'U-1', proof: {} })), 'account_proof');
  assert.equal(code(JSON.stringify({ schema: 'stonehash.por-submission.v1', statement: proof.statement, sig: SIG })), 'not_snapshot_proof');
  assert.equal(code(JSON.stringify({ ...proof, schema: 'stonehash.por-snapshot-proof.v2' })), 'unsupported_version');
  assert.equal(code('null'), 'not_snapshot_proof');
  assert.equal(code('"stonehash.por-snapshot-proof.v1"'), 'not_snapshot_proof');
});

test('a damaged proof file is refused with each thing that is wrong with it', () => {
  const { proof } = anchor(sample('balances.long.csv'), 'balances.long.csv', 'long');
  const problems = (change: (p: Record<string, any>) => void): string[] => {
    const copy = JSON.parse(JSON.stringify(proof)) as Record<string, any>;
    change(copy);
    try {
      parseSnapshotProof(JSON.stringify(copy));
    } catch (e) {
      assert.ok(e instanceof SnapshotProofError, String(e));
      assert.equal(e.code, 'damaged');
      assert.deepEqual(e.problems, validateSnapshotProof(copy));
      return e.problems;
    }
    return [];
  };
  assert.deepEqual(validateSnapshotProof(proof), []);
  assert.deepEqual(problems((p) => { p.seed = 'abc'; }), ['seed must be 64 hex characters']);
  assert.deepEqual(problems((p) => { delete p.seed; delete p.snapshot_id; }), ['snapshot_id is missing', 'seed must be 64 hex characters']);
  assert.deepEqual(problems((p) => { delete p.source; }), ['source is missing']);
  assert.deepEqual(problems((p) => { p.source.layout = 'tall'; p.source.amounts = 'coins'; p.source.sha256 = 'x'; p.source.bytes = -1; }), [
    'source.bytes must be a whole number', 'source.sha256 must be 64 hex characters',
    'source.layout must be long, wide, sheet or json', 'source.amounts must be decimal or base',
  ]);
  assert.deepEqual(problems((p) => { p.source.columns = { account: 'uid', colour: 'red' }; p.source.ignore_columns = 'memo'; p.source.delimiter = ';;'; }), [
    'source.columns may name account, asset and balance, each as text', 'source.ignore_columns must be a list of column names',
    'source.delimiter must be a single character',
  ]);
  assert.deepEqual(problems((p) => { delete p.sig; }), ['sig is missing']);
  assert.deepEqual(problems((p) => { p.statement.tree.root = 'zz'; }), ['statement: tree.root must be 64 lowercase hex']);
  assert.deepEqual(problems((p) => { p.statement.tree.algo = 'merkle-sum-sha256-v3'; }),
    ['statement: tree.algo must be merkle-sum-sha256-v1 or merkle-sum-sha256-v2']);
  // The asset list is about to become the reader's: each entry is held to the reader's rules.
  assert.deepEqual(problems((p) => { p.statement.assets[0].symbol = 'B TC'; p.statement.assets[1].decimals = 80; p.statement.assets[2] = { ...p.statement.assets[1], decimals: 18 }; }), [
    'statement: asset symbol "B TC" is not one the reader accepts', 'statement: ETH decimals must be a whole number from 0 to 36',
    'statement: asset ETH is listed twice',
  ]);
  assert.deepEqual(problems((p) => { p.statement.assets = [null, 7]; }), [
    'statement: asset symbol undefined is not one the reader accepts', 'statement: asset symbol undefined is not one the reader accepts',
  ]);
  assert.deepEqual(validateSnapshotProof([proof]), ['the file is not a JSON object']);
  assert.throws(() => buildSnapshotProof({ snapshotId: 'x', statement: proof.statement, sig: SIG, seed: new Uint8Array(31), source: proof.source }), /32 bytes/);
  assert.throws(() => buildSnapshotProof({ snapshotId: '', statement: proof.statement, sig: SIG, seed: SEED, source: proof.source }), /snapshot_id is missing/);
});

test('names that are data stay data: an asset called constructor, an account called __proto__', () => {
  const assets = [{ symbol: 'constructor', decimals: 2 }, { symbol: 'toString', decimals: 0 }];
  const text = 'account_id,asset,balance\n__proto__,constructor,1.25\nhasOwnProperty,toString,7\nvalueOf,constructor,0.75\n';
  const { proof, root } = anchor(text, 'odd.csv', 'long', { assets });
  const kept = parseSnapshotProof(snapshotProofText(proof));
  const { tree, leaves } = restoreSnapshot(kept, read(text, 'long', ledgerOptionsOf(kept)));
  assert.equal(tree.root, root);
  assert.deepEqual(leaves.map((l) => l.user_ref).sort(), ['__proto__', 'hasOwnProperty', 'valueOf']);
  // With the total of `constructor` changed, that is the asset the refusal names.
  try {
    restoreSnapshot(kept, read(text.replace('1.25', '1.26'), 'long', ledgerOptionsOf(kept)));
    assert.fail('restored');
  } catch (e) {
    assert.ok(e instanceof SnapshotProofError);
    assert.deepEqual(Object.keys(e.mismatch!.totals), ['constructor']);
    assert.deepEqual(e.mismatch!.totals['constructor'], ['200', '201']);
  }
});

test('the plain-JavaScript leaves and the server\'s are the same snapshot', () => {
  const text = sample('balances.wide.csv');
  const { proof } = anchor(text, 'balances.wide.csv', 'wide');
  const rows = read(text, 'wide', ledgerOptionsOf(proof));
  const a = restoreSnapshot(proof, rows);
  const b = restoreSnapshot(proof, rows, { leaf: leafFromRow });
  const c = restoreSnapshot(proof, rows, { leaf: leafFromRowPortable });
  assert.deepEqual(a.leaves, b.leaves);
  assert.deepEqual(a.leaves, c.leaves);
  assert.equal(a.tree.root, SAMPLE_ROOT);
});

test('the module needs nothing but the language, so a page can run it', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../src/snapshot-proof.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /from 'node:|\bBuffer\b|crypto\.subtle|\brequire\(/);
});

// ── the command line ───────────────────────────────────────────────────────

interface CliResult { code: number; stdout: string; stderr: string }
async function cli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 1, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
  }
}

test('prove issues from the proof file and the export, and from nothing less', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-proof-file-'));
  try {
    const ledger = path.join(SAMPLES, 'balances.long.csv');
    const { proof } = anchor(sample('balances.long.csv'), 'balances.long.csv', 'long');
    const kept = path.join(dir, 'por-proof.json');
    writeFileSync(kept, snapshotProofText(proof));
    const snapshot = path.join(dir, 'snapshot.json');
    writeFileSync(snapshot, JSON.stringify(proof.statement));

    // One account.
    const out = path.join(dir, 'account-proof.json');
    const one = await cli(['prove', '--snapshot-proof', kept, '--csv', ledger, '--user-ref', 'U-100008', '--out', out]);
    assert.equal(one.code, 0, one.stderr);
    const file = JSON.parse(readFileSync(out, 'utf8')) as { schema: string; root: string; user_ref: string; proof: PorInclusionProof };
    assert.equal(file.schema, 'stonehash.por-proof.v1');
    assert.equal(file.root, SAMPLE_ROOT);
    assert.equal(file.user_ref, 'U-100008');
    assert.equal(verifyPorInclusion(file.proof, { root: SAMPLE_ROOT, totals: proof.statement.totals }).ok, true);
    const checked = await cli(['verify-proof', '--proof', out, '--snapshot', snapshot]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.match(checked.stdout, /root\+totals\s+MATCH/);

    // Every account.
    const all = await cli(['prove', '--snapshot-proof', kept, '--csv', ledger, '--all', '--out-dir', path.join(dir, 'all')]);
    assert.equal(all.code, 0, all.stderr);
    const written = readdirSync(path.join(dir, 'all'), { recursive: true }).filter((f) => String(f).endsWith('.json'));
    assert.equal(written.length, 12);

    // The same snapshot from a JSON export has its own proof file, and wants that export.
    const jsonKept = path.join(dir, 'por-proof-json.json');
    writeFileSync(jsonKept, snapshotProofText(anchor(sample('accounts.json'), 'accounts.json', 'json').proof));
    const fromJson = await cli(['prove', '--snapshot-proof', jsonKept, '--accounts-json', path.join(SAMPLES, 'accounts.json'),
      '--user-ref', 'U-100001', '--out', path.join(dir, 'p2.json')]);
    assert.equal(fromJson.code, 0, fromJson.stderr);
    const crossed = await cli(['prove', '--snapshot-proof', jsonKept, '--csv', ledger, '--user-ref', 'U-100001', '--out', path.join(dir, 'p3.json')]);
    assert.equal(crossed.code, 1);
    assert.match(crossed.stderr, /built from a JSON array of accounts; pass that file with --accounts-json/);

    // An export with one figure changed: nothing is written, and the message says which total moved.
    const changed = path.join(dir, 'changed.csv');
    writeFileSync(changed, sample('balances.long.csv').replace('U-100001,BTC,0.50000000', 'U-100001,BTC,0.60000000'));
    const refused = await cli(['prove', '--snapshot-proof', kept, '--csv', changed, '--user-ref', 'U-100008', '--out', path.join(dir, 'never.json')]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /does not rebuild snapshot 3ca03638-415f-432f-b733-f203b824ba5d; nothing was issued/);
    assert.match(refused.stderr, new RegExp(`root      anchored ${SAMPLE_ROOT}`));
    assert.match(refused.stderr, /BTC  anchored 2463358024, rebuilt 2473358024/);
    assert.match(refused.stderr, /the proof file was written for balances\.long\.csv \(\d+ bytes, sha256 [0-9a-f]{16}…\); this file's sha256 is [0-9a-f]{16}…/);
    assert.equal(readdirSync(dir).includes('never.json'), false);

    // The right export with an altered proof file: the export is cleared, the proof file is not.
    const forged = path.join(dir, 'forged.json');
    writeFileSync(forged, snapshotProofText({ ...proof, seed: 'ab'.repeat(32) }));
    const forgedRun = await cli(['prove', '--snapshot-proof', forged, '--csv', ledger, '--user-ref', 'U-100008', '--out', path.join(dir, 'never.json')]);
    assert.equal(forgedRun.code, 2);
    assert.match(forgedRun.stderr, /byte for byte the one recorded, so it is the proof file that has been altered/);

    // A file that cannot be read as the export at all.
    const broken = path.join(dir, 'broken.csv');
    writeFileSync(broken, 'account_id,asset,balance\nU-1,BTC,-1\n');
    const brokenRun = await cli(['prove', '--snapshot-proof', kept, '--csv', broken, '--user-ref', 'U-1', '--out', path.join(dir, 'never.json')]);
    assert.equal(brokenRun.code, 2);
    assert.match(brokenRun.stderr, /amount_negative/);
    assert.match(brokenRun.stderr, /cannot be read as the export of snapshot/);

    // What the flags ask for, said plainly when they are wrong.
    const neither = await cli(['prove', '--user-ref', 'U-100008', '--out', out]);
    assert.match(neither.stderr, /pass --tree .* or --snapshot-proof <file> with the export/);
    const noExport = await cli(['prove', '--snapshot-proof', kept, '--user-ref', 'U-100008', '--out', out]);
    assert.match(noExport.stderr, /needs the export the snapshot was built from: --csv or --accounts-json/);
    const notOne = await cli(['prove', '--snapshot-proof', out, '--csv', ledger, '--user-ref', 'U-100008', '--out', out]);
    assert.match(notOne.stderr, /one account's proof, not the snapshot's proof file/);
    const both = await cli(['prove', '--tree', dir, '--snapshot-proof', kept, '--csv', ledger, '--user-ref', 'U-1', '--out', out]);
    assert.match(both.stderr, /pass --tree .* or --snapshot-proof/);
    const unknown = await cli(['prove', '--snapshot-proof', kept, '--csv', ledger, '--user-ref', 'U-999999', '--out', path.join(dir, 'never.json')]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no leaf for user_ref U-999999/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
