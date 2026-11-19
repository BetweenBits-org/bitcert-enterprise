/**
 * Whatever an exchange lists, and however it hands its balances over.
 *
 * Two things were learned from reading how two large exchanges build their
 * own proofs of reserves. They list hundreds of assets — different ones each
 * — while an account holds a handful; and their exports come in shapes of
 * their own: one row per account with an equity and a debt column for every
 * asset, or a JSON array of accounts. The first is why the tree now writes
 * only what is held. The second is why those two shapes are read as they
 * are, into the same ledger and under the same rules as the two layouts this
 * SDK defines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPorInclusion } from '@stonehash/attest-verify';
import {
  CsvLedgerReader, LedgerBuilder, POR_TREE_ALGO, buildPorTree, buildSnapshotStatement, checkCapacity, estimateTreeFigures,
  leafFromRow, loadTreeDir, provePorLeaf, readAccountsJson, readLiabilitiesCsv, validateSnapshotStatement, writeTreeDir,
} from '../src/index.ts';
import type { IntakeOptions, LiabilityRow, PorLeafInput } from '../src/index.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
const SAMPLES = path.resolve(import.meta.dirname, '../samples');
const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/por');
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const EXCHANGE = 'KR-EX-0a1b2c';
const ASSETS3 = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
const V1 = 'merkle-sum-sha256-v1' as const;
const V2 = 'merkle-sum-sha256-v2' as const;

const tmp = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'por-formats-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const read = (text: string, o: Partial<IntakeOptions> = {}) => {
  const reader = new CsvLedgerReader({ assets: ASSETS3, amounts: 'decimal', ...o });
  reader.pushText(text);
  return reader.end();
};
const codes = (r: { report: { problems: { line: number; code: string }[] } }): string[] =>
  r.report.problems.map((p) => `${p.line}:${p.code}`);
const leavesOf = (rows: LiabilityRow[]): PorLeafInput[] => rows.map((r) => leafFromRow(EXCHANGE, SEED, r));
const sum = (rows: LiabilityRow[], asset: string): string =>
  rows.reduce((n, r) => n + BigInt(r.balances[asset] ?? '0'), 0n).toString();

/** A ledger of `accounts`, each holding `held` of the listed assets. */
function ledger(accounts: number, listed: string[], held: number): LiabilityRow[] {
  return Array.from({ length: accounts }, (_, i) => ({
    user_ref: `acct-${i}`,
    balances: Object.fromEntries(Array.from({ length: held }, (_, k) =>
      [listed[(i * 7 + k * 13) % listed.length]!, String(1_000_000 + i * 31 + k)])),
  }));
}

// ── the tree ───────────────────────────────────────────────────────────────

test('v2 is what a new tree is built in, and it writes nothing for what is not held', () => {
  assert.equal(POR_TREE_ALGO, V2);
  const listed = ['BTC', 'ETH', 'USDT'];
  const rows: LiabilityRow[] = [
    { user_ref: 'a', balances: { BTC: '5' } },
    { user_ref: 'b', balances: { ETH: '7', USDT: '0' } },   // a zero that was written out
    { user_ref: 'c', balances: {} },                        // an account that holds nothing
  ];
  const tree = buildPorTree(leavesOf(rows), listed);
  assert.equal(tree.algo, V2);
  for (const level of tree.levels) {
    for (const node of level) {
      assert.ok(Object.values(node.sums).every((v) => v !== '0'), `a zero was written: ${JSON.stringify(node.sums)}`);
    }
  }
  // Three leaves pad to four: the padding node carries no figure at all.
  assert.deepEqual(tree.levels[0]![3]!.sums, {});
  // The statement still says zero out loud for an asset nobody holds.
  assert.deepEqual(tree.totals, { BTC: '5', ETH: '7', USDT: '0' });
  assert.equal(buildSnapshotStatement({ institutionId: EXCHANGE, name: 'X', asof: '2026-11-17T00:00:00Z', assets: ASSETS3 }, tree).tree.padding, 'empty');
});

test('a v2 root does not depend on which assets are listed, only on what is held', () => {
  const held = ['BTC', 'ETH'];
  const rows = ledger(37, held, 2);
  const few = buildPorTree(leavesOf(rows), held);
  const many = buildPorTree(leavesOf(rows), [...held, ...Array.from({ length: 498 }, (_, i) => `X${i}`)]);
  const reordered = buildPorTree(leavesOf(rows), ['ETH', 'BTC', 'ZZZ']);
  assert.equal(many.root, few.root, 'listing 498 assets nobody holds changed the root');
  assert.equal(reordered.root, few.root, 'the order of the listing changed the root');
  assert.equal(Object.keys(many.totals).length, 500);
  // The v1 tree is the opposite, which is exactly its cost.
  assert.notEqual(buildPorTree(leavesOf(rows), [...held, 'X0'], { algo: V1 }).root, buildPorTree(leavesOf(rows), held, { algo: V1 }).root);
});

test('both formats agree on every total and prove every account; only the root differs', () => {
  const listed = Array.from({ length: 60 }, (_, i) => `T${i}`);
  const rows = ledger(131, listed, 4);
  const leaves = leavesOf(rows);
  const v1 = buildPorTree(leaves, listed, { algo: V1 });
  const v2 = buildPorTree(leaves, listed, { algo: V2 });
  assert.deepEqual(v2.totals, v1.totals);
  for (const asset of listed) assert.equal(v2.totals[asset], sum(rows, asset), asset);
  assert.notEqual(v2.root, v1.root);
  const sorted = [...leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  for (const tree of [v1, v2]) {
    for (let i = 0; i < sorted.length; i += 13) {
      const proof = provePorLeaf(tree, i, sorted[i]!);
      const checked = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
      assert.equal(checked.ok, true, `${tree.algo} leaf ${i}: ${checked.problems.join('; ')}`);
    }
  }
  // A v2 proof is the smaller one: it carries no zeros.
  const size = (t: typeof v1): number => JSON.stringify(provePorLeaf(t, 0, sorted[0]!)).length;
  assert.ok(size(v2) < size(v1));
  // And a proof from one tree does not pass for the other.
  assert.equal(verifyPorInclusion(provePorLeaf(v1, 0, sorted[0]!), { root: v2.root, totals: v2.totals }).ok, false);
});

test('seven hundred listed assets cost what is held, not what is listed', () => {
  const listed = Array.from({ length: 700 }, (_, i) => `A${i}`);
  const rows = ledger(2_000, listed, 5);
  const tree = buildPorTree(leavesOf(rows), listed);
  let figures = 0;
  for (const level of tree.levels) for (const node of level) figures += Object.keys(node.sums).length;
  // Written out in full this tree would hold 2,048 × 2 × 700 figures.
  assert.ok(figures < 2_048 * 2 * 700 / 10, `${figures} figures`);
  assert.ok(figures <= estimateTreeFigures(2_000, 700, 5) * 1.05, 'the estimate must not run under what a tree really holds');
  for (const asset of listed.slice(0, 40)) assert.equal(tree.totals[asset], sum(rows, asset));
  // What the capacity check is asked is how much is held.
  const GB = 1024 ** 3;
  assert.equal(checkCapacity(300_000, 700, 4 * GB, 5).ok, true);
  assert.equal(checkCapacity(300_000, 700, 4 * GB).ok, false, 'every account holding all 700 would not fit');
});

test('an asset or an account may be called what an object already has', () => {
  /*
   * `constructor`, `toString`, `__proto__`: names every JavaScript object
   * answers to. In the v1 tree every balances object carried every asset, so
   * none was ever looked up where it was missing; in v2 a missing asset is the
   * ordinary case, and the first build with an asset called `constructor`
   * died converting a function to a number. Found by building against an
   * implementation written separately.
   */
  const assets = ['BTC', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const rows: LiabilityRow[] = [
    { user_ref: '__proto__', balances: { BTC: '5' } },
    { user_ref: 'constructor', balances: { constructor: '7', toString: '1' } },
    { user_ref: 'toString', balances: { valueOf: '2' } },
    { user_ref: 'plain', balances: {} },
  ];
  for (const algo of [V1, V2]) {
    const leaves = leavesOf(rows);
    const tree = buildPorTree(leaves, assets, { algo });
    assert.deepEqual(tree.totals, { BTC: '5', constructor: '7', toString: '1', valueOf: '2', hasOwnProperty: '0' }, algo);
    const sorted = [...leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
    for (const [i, leaf] of sorted.entries()) {
      // Every account is found under its own name, and proves.
      assert.equal(tree.index[leaf.user_ref], i, `${algo} ${leaf.user_ref}`);
      const checked = verifyPorInclusion(provePorLeaf(tree, i, leaf), { root: tree.root, totals: tree.totals });
      assert.equal(checked.ok, true, `${algo} ${leaf.user_ref}: ${checked.problems.join('; ')}`);
    }
    // And a name nobody has is not found, whatever an object would have said.
    for (const nobody of ['valueOf', 'hasOwnProperty', 'nobody']) assert.equal(tree.index[nobody], undefined);
  }
  // The one name that cannot be an entry of a plain object is refused where it would be hashed and then lost.
  const smuggled = JSON.parse('{"leaf_index":0,"leaf":{"user_ref_hash":"' + 'a'.repeat(64) + '","salt":"' + 'b'.repeat(64) + '","balances":{"__proto__":"9"}},"siblings":[]}');
  const refused = verifyPorInclusion(smuggled, { root: 'c'.repeat(64), totals: {} });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join(), /"__proto__" is not an asset name/);
  // The readers take such assets too, and file them where they belong.
  const read = new CsvLedgerReader({ assets: [{ symbol: 'constructor', decimals: 2 }, { symbol: 'toString', decimals: 0 }], amounts: 'decimal' });
  read.pushText('account_id,constructor,toString\nu1,1.5,\n__proto__,2,1\n');
  const { rows: got, report } = read.end();
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.totals, { constructor: '350', toString: '1' });
  assert.deepEqual(got.map((r) => r.user_ref), ['u1', '__proto__']);
});

test('a statement names its tree format, and the platform accepts both and nothing else', () => {
  const leaves = leavesOf(ledger(5, ['BTC', 'ETH', 'USDT'], 2));
  const statement = (algo: typeof V1 | typeof V2) => buildSnapshotStatement(
    { institutionId: EXCHANGE, name: 'X', asof: '2026-11-17T00:00:00Z', assets: ASSETS3 },
    buildPorTree(leaves, ['BTC', 'ETH', 'USDT'], { algo }));
  assert.deepEqual(validateSnapshotStatement(statement(V1)), []);
  assert.deepEqual(validateSnapshotStatement(statement(V2)), []);
  assert.equal(statement(V1).tree.padding, 'empty-zero');
  const crossed = { ...statement(V2), tree: { ...statement(V2).tree, padding: 'empty-zero' } };
  assert.match(validateSnapshotStatement(crossed).join(), /tree\.padding must be empty for merkle-sum-sha256-v2/);
  const unknown = { ...statement(V2), tree: { ...statement(V2).tree, algo: 'merkle-sum-sha256-v3' } };
  assert.match(validateSnapshotStatement(unknown).join(), /tree\.algo must be/);
  assert.throws(() => buildPorTree(leaves, ['BTC', 'ETH', 'USDT'], { algo: 'nope' as never }), /unknown tree format/);
});

test('a snapshot directory is read back in the format it was built in', async () => {
  const t = tmp();
  try {
    const rows = ledger(9, ['BTC', 'ETH', 'USDT'], 2);
    for (const algo of [V1, V2]) {
      const dir = path.join(t.dir, algo);
      await run('mkdir', ['-p', dir]);
      const leaves = leavesOf(rows);
      const tree = buildPorTree(leaves, ['BTC', 'ETH', 'USDT'], { algo });
      await writeTreeDir(dir, EXCHANGE, tree, leaves);
      const header = JSON.parse(readFileSync(path.join(dir, 'tree.json'), 'utf8')) as { algo?: string };
      // v1 directories are written exactly as they always were; v2 names itself.
      assert.equal(header.algo, algo === V1 ? undefined : V2);
      const loaded = await loadTreeDir(dir);
      assert.equal(loaded.tree.algo, algo);
      assert.equal(loaded.tree.root, tree.root);
    }
    // The header decides: the same leaves claimed as the other format are refused, not re-rooted.
    const dir = path.join(t.dir, V2);
    const header = JSON.parse(readFileSync(path.join(dir, 'tree.json'), 'utf8')) as Record<string, unknown>;
    delete header['algo'];
    writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(header));
    await assert.rejects(loadTreeDir(dir), /do not reproduce the recorded root/);
    // The published v1 directory, written before there were two formats, still loads.
    const published = await loadTreeDir(path.join(FIXTURES, 'snapshot-dir'));
    assert.equal(published.tree.algo, V1);
    assert.equal(published.tree.root, '0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa');
  } finally { t.done(); }
});

// ── the shapes an export comes in ──────────────────────────────────────────

test('the sheet layout: an equity and a debt column per asset, read as the same ledger', async () => {
  const wide = await readLiabilitiesCsv(path.join(SAMPLES, 'balances.wide.csv'), { assets: ASSETS3, amounts: 'decimal' });
  // The sample: an `id` column, and per asset an equity, a debt and the columns this SDK skips.
  const sheet = await readLiabilitiesCsv(path.join(SAMPLES, 'balances.sheet.csv'), { assets: ASSETS3, amounts: 'decimal' });
  assert.equal(sheet.report.ok, true, JSON.stringify(sheet.report.problems));
  assert.equal(sheet.report.layout, 'sheet');
  assert.equal(sheet.report.accounts, 12);
  assert.deepEqual(sheet.report.totals, wide.report.totals);
  assert.deepEqual(sheet.rows, wide.rows, 'the wide ledger, row for row');
  // Read, not ignored: the debt columns are not among the columns skipped.
  assert.ok(!sheet.report.ignored_columns.includes('d_BTC'));
  assert.ok(['rn', 'BTC', 'vl_BTC', 'm_BTC', 'pm_BTC', 'total_net_balance_usdt'].every((c) => sheet.report.ignored_columns.includes(c)));
  // Such exports are often written with lower-case symbols. Asset symbols are
  // matched exactly here as everywhere else: the list has to spell them as the file does.
  const lowered = readFileSync(path.join(SAMPLES, 'balances.sheet.csv'), 'utf8')
    .replace(/([_,])(BTC|ETH|USDT)(?=[,\n])/g, (_m, lead: string, sym: string) => lead + sym.toLowerCase());
  assert.deepEqual(codes(read(lowered)),
    ['1:header_unknown_column', '1:header_unknown_column', '1:header_unknown_column', '1:header_missing_asset', '1:header_missing_asset', '1:header_missing_asset']);
  const lowerAssets = ASSETS3.map((a) => ({ ...a, symbol: a.symbol.toLowerCase() }));
  const asWritten = read(lowered, { assets: lowerAssets });
  assert.equal(asWritten.report.ok, true, JSON.stringify(asWritten.report.problems));
  assert.deepEqual(asWritten.report.totals, { btc: wide.report.totals['BTC'], eth: wide.report.totals['ETH'], usdt: wide.report.totals['USDT'] });
});

test('the sheet layout: a debt is neither netted nor ignored — the account is refused', () => {
  const header = 'id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT';
  const none = read(`${header}\nu1,1,0,2,0.0,3,\nu2,1,0.00000000,,,,.0\n`);
  assert.equal(none.report.ok, true, JSON.stringify(none.report.problems));
  assert.deepEqual(none.rows, [
    { user_ref: 'u1', balances: { BTC: '100000000', ETH: '2000000000000000000', USDT: '3000000' } },
    { user_ref: 'u2', balances: { BTC: '100000000' } },
  ]);
  const owed = read(`${header}\nu1,1,0,2,0,3,0\nu2,1,0.00000001,,,,\nu3,5,,1,2,,\n`);
  assert.deepEqual(codes(owed), ['3:debt_not_supported', '4:debt_not_supported']);
  assert.deepEqual(owed.rows, [], 'nothing is built from a ledger with a debt in it');
  assert.match(owed.report.problems[0]!.message, /BTC: debt "0\.00000001"/);
  // A debt cell is an amount like any other: what the amount rules cannot read is said to be unreadable, not "a debt".
  const unread = read(`${header}\nu1,1,-0,,,,\nu2,1,x,,,,\nu3,1,0.,,,,\nu4,1,1e3,,,,\nu5,1,0.000000001,,,,\n`);
  assert.deepEqual(codes(unread), ['2:amount_negative', '3:amount_format', '4:amount_format', '5:amount_exponent', '6:amount_precision']);
  assert.match(unread.report.problems[0]!.message, /^BTC debt: /);
});

test('the sheet layout: every column is accounted for, and the layout is not guessed from one prefix', () => {
  // The balance of an asset that was not declared would vanish from the totals.
  // Said once, at its equity column — not again for each column that goes with it.
  assert.deepEqual(codes(read('id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT,e_DOGE,d_DOGE,DOGE,vl_DOGE\nu1,1,0,1,0,1,0,5,0,5,0\n')),
    ['1:header_unknown_column']);
  assert.deepEqual(codes(read('id,e_BTC,d_BTC,e_ETH,d_ETH\nu1,1,0,1,0\n')), ['1:header_missing_asset']);
  assert.deepEqual(codes(read('id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT,note\nu1,1,0,1,0,1,0,x\n')), ['1:header_unknown_column']);
  assert.equal(read('id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT,note\nu1,1,0,1,0,1,0,x\n', { ignoreColumns: ['note'] }).report.ok, true);
  // `account_id` works as well as `id`; a column named by the caller is the only one looked for.
  assert.equal(read('account_id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT\nu1,1,0,1,0,1,0\n').report.layout, 'sheet');
  assert.deepEqual(codes(read('id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT\nu1,1,0,1,0,1,0\n', { columns: { account: 'uid' } })), ['1:header_no_account']);
  // An asset whose symbol happens to start with e_ does not make a wide file a sheet…
  const eAsset = { assets: [{ symbol: 'e_gold', decimals: 2 }], amounts: 'decimal' as const };
  const wide = read('account_id,e_gold\nu1,1.5\n', eAsset);
  assert.equal(wide.report.layout, 'wide');
  assert.deepEqual(wide.rows, [{ user_ref: 'u1', balances: { e_gold: '150' } }]);
  // …not even when two assets are called e_x and d_x, which is what a sheet's pair looks like.
  const pairNamed = { assets: [{ symbol: 'e_x', decimals: 0 }, { symbol: 'd_x', decimals: 0 }], amounts: 'decimal' as const };
  const stillWide = read('account_id,e_x,d_x\nu1,1,2\n', pairNamed);
  assert.equal(stillWide.report.layout, 'wide');
  assert.deepEqual(stillWide.rows, [{ user_ref: 'u1', balances: { e_x: '1', d_x: '2' } }]);
  // An asset the caller leaves out on purpose goes with all of its columns, and is listed as skipped.
  const leftOut = read('id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT,e_DOGE,d_DOGE,DOGE,vl_DOGE\nu1,1,0,1,0,1,0,5,3,2,0\n', { ignoreColumns: ['e_DOGE'] });
  assert.equal(leftOut.report.ok, true, JSON.stringify(leftOut.report.problems));
  assert.deepEqual(leftOut.report.ignored_columns, ['e_DOGE', 'd_DOGE', 'DOGE', 'vl_DOGE']);
  // …and the standard long header stays long whatever else is in it.
  assert.equal(read('account_id,asset,balance,e_BTC,d_BTC\nu1,BTC,1,9,9\n').report.layout, 'long');
  // The layout can be stated outright.
  assert.equal(read('id,e_BTC,e_ETH,e_USDT\nu1,1,2,3\n', { layout: 'sheet' }).report.ok, true);
});

test('accounts as JSON: the same ledger, the same rules', () => {
  const wide = read(readFileSync(path.join(SAMPLES, 'balances.wide.csv'), 'utf8'));
  const json = readAccountsJson(readFileSync(path.join(SAMPLES, 'accounts.json'), 'utf8'), { assets: ASSETS3, amounts: 'decimal' });
  assert.equal(json.report.ok, true, JSON.stringify(json.report.problems));
  assert.equal(json.report.layout, 'json');
  assert.deepEqual(json.rows, wide.rows);
  assert.deepEqual(json.report.totals, wide.report.totals);
  // `account_id` and `balances` are read as well; an account with nothing is still an account.
  const other = readAccountsJson('[{"account_id":"u1","balances":{"BTC":"1"}},{"id":"u2","assets":{}}]', { assets: ASSETS3, amounts: 'decimal' });
  assert.deepEqual(other.rows, [{ user_ref: 'u1', balances: { BTC: '100000000' } }, { user_ref: 'u2', balances: {} }]);
  assert.equal(other.report.zero_balance_accounts, 1);
});

test('accounts as JSON: an amount is text, an asset is declared, an account appears once', () => {
  const bad = readAccountsJson(JSON.stringify([
    { id: 'u1', assets: { BTC: 0.5 } },          // 1 a number cannot carry every digit
    { id: 'u2', assets: { DOGE: '1' } },         // 2 undeclared
    { id: 'u3', assets: { BTC: '1' } },
    { id: 'u3', assets: { ETH: '1' } },          // 4 twice
    { id: 'u4', assets: { USDT: '-1' } },        // 5 negative
    { id: 5, assets: {} },                       // 6 the id is not text
    { id: 'u7', assets: ['BTC', '1'] },          // 7 not an object
    { id: ' u8', assets: { BTC: '1' } },         // 8 the account rules are the CSV's
  ]), { assets: ASSETS3, amounts: 'decimal' });
  assert.deepEqual(codes(bad), ['1:amount_not_text', '2:unknown_asset', '4:duplicate_account', '5:amount_negative',
    '6:json_shape', '7:json_shape', '8:account_whitespace']);
  assert.deepEqual(bad.rows, []);
  assert.equal(bad.report.rows, 8);
  assert.deepEqual(codes(readAccountsJson('{"u1":{"BTC":"1"}}', { assets: ASSETS3, amounts: 'decimal' })), ['0:json_shape']);
  // Nothing is chosen between two spellings, and nothing is dropped by a key written twice.
  const o = { assets: ASSETS3, amounts: 'decimal' as const };
  const ambiguous = readAccountsJson(`[
    {"id":"u1","account_id":"u9","assets":{"BTC":"1"}},
    {"id":"u2","assets":{"BTC":"1"},"balances":{"BTC":"2"}},
    {"id":"u3","assets":{"BTC":"1","ETH":"1","BTC":"2"}},
    {"id":"u4","id":"u5","assets":{"BTC":"1"}},
    {"id":"u6","assets":{"BTC":"1"},"assets":{"ETH":"1"}},
    {"id":"u7","assets":{"BTC":"1"},"note":{"BTC":"1","BTC":"x"}},
    {"id":"u8","assets":{"BTC":"3"}}
  ]`, o);
  assert.deepEqual(codes(ambiguous), ['1:json_shape', '2:json_shape', '3:json_duplicate_key', '4:json_duplicate_key', '5:json_duplicate_key', '6:json_duplicate_key']);
  assert.match(ambiguous.report.problems[0]!.message, /both "id" and "account_id"/);
  assert.match(ambiguous.report.problems[2]!.message, /writes "BTC" more than once/);
  // The account is named by where it is in the array, whatever came before it: a bare string, a number, an array.
  for (const [first, said] of [['"u0"', 'json_shape'], ['7', 'json_shape'], ['null', 'json_shape'], ['["x"]', 'json_shape'],
    ['["x", {"a": "1", "a": "2"}]', 'json_duplicate_key']] as const) {
    const placed = readAccountsJson(`[${first}, {"id":"u1","assets":{"BTC":"1"}}, {"id":"u2","assets":{"BTC":"1","BTC":"2"}}]`, o);
    assert.deepEqual(codes(placed), [`1:${said}`, '3:json_duplicate_key'], first);
  }
  // A key inside a string, or the same key in two different objects, is not a repeat.
  const fine = readAccountsJson('[{"id":"a\\"id\\":{","assets":{"BTC":"1"}},{"id":"b","assets":{"BTC":"1"}}]', o);
  assert.equal(fine.report.ok, true, JSON.stringify(fine.report.problems));
  assert.deepEqual(fine.rows.map((r) => r.user_ref), ['a"id":{', 'b']);
  // Any other field of an account is skipped, and said to have been.
  const extra = readAccountsJson('[{"id":"u1","assets":{"BTC":"1"},"tier":"vip","updated_at":"2026-11-17"},{"id":"u2","assets":{},"tier":"x"}]', o);
  assert.equal(extra.report.ok, true);
  assert.deepEqual(extra.report.ignored_columns, ['tier', 'updated_at']);
  assert.deepEqual(codes(readAccountsJson('[{"id":"u1"', { assets: ASSETS3, amounts: 'decimal' })), ['0:json_syntax']);
  assert.deepEqual(codes(readAccountsJson('[]', { assets: ASSETS3, amounts: 'decimal' })), ['0:no_accounts']);
  // Whole numbers of the smallest unit, when the export says so.
  assert.deepEqual(readAccountsJson('[{"id":"u1","assets":{"BTC":"50000000"}}]', { assets: ASSETS3, amounts: 'base' }).rows,
    [{ user_ref: 'u1', balances: { BTC: '50000000' } }]);
});

test('an asset list built in code is held to the rules of one typed on the command line', () => {
  const amounts = 'decimal' as const;
  assert.throws(() => new LedgerBuilder({ assets: [{ symbol: '__proto__', decimals: 0 }], amounts }), /may contain only letters/);
  assert.throws(() => new LedgerBuilder({ assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'BTC', decimals: 8 }], amounts }), /listed twice/);
  assert.throws(() => new LedgerBuilder({ assets: [{ symbol: 'BTC', decimals: 37 }], amounts }), /decimals must be/);
  assert.throws(() => new LedgerBuilder({ assets: [{ symbol: 'BTC', decimals: 1.5 }], amounts }), /decimals must be/);
  assert.throws(() => readAccountsJson('[]', { assets: [{ symbol: 'B TC', decimals: 8 }], amounts }), /may contain only letters/);
  // Names an object already answers to are ordinary asset names.
  assert.doesNotThrow(() => new LedgerBuilder({ assets: [{ symbol: 'constructor', decimals: 0 }, { symbol: 'toString', decimals: 0 }], amounts }));
});

// ── the command line ───────────────────────────────────────────────────────

test('the command line builds the one sample ledger from all five shapes to the same root', async () => {
  const t = tmp();
  try {
    const common = ['--amounts', 'decimal', '--exchange', EXCHANGE, '--name', 'Sample Exchange',
      '--asof', '2026-11-16T00:00:00Z', '--seed-hex', SEED.toString('hex')];
    const builds: [string, string[]][] = [
      ['long', ['--csv', path.join(SAMPLES, 'balances.long.csv'), '--assets', 'BTC:8,ETH:18,USDT:6']],
      ['wide', ['--csv', path.join(SAMPLES, 'balances.wide.csv'), '--assets', 'BTC:8,ETH:18,USDT:6']],
      ['sheet', ['--csv', path.join(SAMPLES, 'balances.sheet.csv'), '--assets', 'BTC:8,ETH:18,USDT:6']],
      ['json', ['--accounts-json', path.join(SAMPLES, 'accounts.json'), '--assets', 'BTC:8,ETH:18,USDT:6']],
      ['assets-file', ['--csv', path.join(SAMPLES, 'balances.long.csv'), '--assets-file', path.join(SAMPLES, 'assets.csv')]],
    ];
    for (const [name, args] of builds) {
      const out = path.join(t.dir, name);
      await run('node', [CLI, 'build', ...args, ...common, '--out', out]);
      const st = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8')) as { tree: { root: string; algo: string } };
      assert.equal(st.tree.root, 'eeb2534289eb2a990c5b526a511a5d0ebf80a06069488a9cf1b8ef905feba297', name);
      assert.equal(st.tree.algo, V2);
    }
    // The asset list is stated once, in one place.
    await assert.rejects(run('node', [CLI, 'check', '--csv', path.join(SAMPLES, 'balances.long.csv'), '--amounts', 'decimal',
      '--assets', 'BTC:8', '--assets-file', path.join(SAMPLES, 'assets.csv')]), /exactly one of --assets and --assets-file/);
    const check = await run('node', [CLI, 'check', '--accounts-json', path.join(SAMPLES, 'accounts.json'), '--amounts', 'decimal',
      '--assets-file', path.join(SAMPLES, 'assets.csv')]);
    assert.match(check.stdout, /layout\s+json/);
    assert.match(check.stdout, /OK — this file can be built/);
  } finally { t.done(); }
});
