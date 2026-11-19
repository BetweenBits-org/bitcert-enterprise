import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPorTree, provePorLeaf } from '../src/sumtree.ts';
import type { PorLeafInput } from '../src/sumtree.ts';
import { buildSnapshotStatement, porSnapshotCommitment, validateSnapshotStatement } from '../src/snapshot.ts';
import { synthesiseLiabilities } from '../src/synth.ts';
import { porUserRefHash, verifyPorInclusion, porEmptyNode } from '@stonehash/attest-verify';

const ASSETS = ['BTC', 'ETH', 'USDT'];

function leaves(n: number, seed = 7): PorLeafInput[] {
  return synthesiseLiabilities({ users: n, assets: ASSETS, seed }).map((u) => ({
    user_ref: u.user_ref,
    user_ref_hash: porUserRefHash('EX-TEST-001', u.user_ref),
    salt: 'ab'.repeat(32 / 2) + u.user_ref.slice(-4).padStart(4, '0').repeat(8),
    balances: u.balances,
  })).map((l) => ({ ...l, salt: l.salt.slice(0, 64) }));
}

test('every leaf of an odd-sized tree proves against root and totals', () => {
  const input = leaves(11);
  const tree = buildPorTree(input, ASSETS);
  const sorted = [...input].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  // declared totals must equal the plain sum of the inputs (padding adds zero)
  const expected: Record<string, bigint> = { BTC: 0n, ETH: 0n, USDT: 0n };
  for (const l of input) for (const [k, v] of Object.entries(l.balances)) expected[k]! += BigInt(v);
  for (const k of ASSETS) assert.equal(tree.totals[k], expected[k]!.toString());

  for (let i = 0; i < tree.leaf_count; i++) {
    const proof = provePorLeaf(tree, i, sorted[i]!);
    const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
    assert.equal(r.ok, true, `leaf ${i}: ${r.problems.join('; ')}`);
  }
});

test('determinism: same liabilities, same root', () => {
  const a = buildPorTree(leaves(50), ASSETS);
  const b = buildPorTree([...leaves(50)].reverse(), ASSETS);
  assert.equal(a.root, b.root);
  assert.deepEqual(a.totals, b.totals);
});

test('a tampered balance breaks the proof', () => {
  const input = leaves(8);
  const tree = buildPorTree(input, ASSETS);
  const sorted = [...input].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const proof = provePorLeaf(tree, 3, sorted[3]!);
  proof.leaf.balances.BTC = (BigInt(proof.leaf.balances.BTC ?? '0') + 1n).toString();
  const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
  assert.equal(r.ok, false);
});

test('a tampered sibling sum breaks root and totals together', () => {
  const input = leaves(8);
  const tree = buildPorTree(input, ASSETS);
  const sorted = [...input].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const proof = provePorLeaf(tree, 0, sorted[0]!);
  proof.siblings[1]!.sums.USDT = '0'; // understate a subtree
  const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('root') || p.includes('total')));
});

test('negative balances are rejected at build and at verify', () => {
  const bad = leaves(3);
  bad[0]!.balances.BTC = '-5';
  assert.throws(() => buildPorTree(bad, ASSETS), /non-negative/);

  const good = leaves(4);
  const tree = buildPorTree(good, ASSETS);
  const sorted = [...good].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const proof = provePorLeaf(tree, 1, sorted[1]!);
  proof.siblings[0]!.sums.BTC = '-1';
  const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('non-negative')));
});

test('a proof cannot be replayed at a different index', () => {
  const input = leaves(8);
  const tree = buildPorTree(input, ASSETS);
  const sorted = [...input].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const proof = provePorLeaf(tree, 2, sorted[2]!);
  proof.leaf_index = 5;
  const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('leaf_index')));
});

test('duplicate user_ref_hash is refused', () => {
  const input = leaves(4);
  input[1] = { ...input[1]!, user_ref_hash: input[0]!.user_ref_hash };
  assert.throws(() => buildPorTree(input, ASSETS), /duplicate/);
});

test('empty padding node adds nothing', () => {
  const empty = porEmptyNode(ASSETS);
  assert.deepEqual(empty.sums, { BTC: '0', ETH: '0', USDT: '0' });
});

test('snapshot statement validates and commits deterministically', () => {
  const tree = buildPorTree(leaves(5), ASSETS);
  const st = buildSnapshotStatement({
    institutionId: 'EX-TEST-001', name: 'Test Exchange',
    asof: '2026-11-10T00:00:00Z',
    assets: ASSETS.map((symbol) => ({ symbol, decimals: 8 })),
  }, tree, new Date('2026-11-10T01:00:00Z'));
  assert.deepEqual(validateSnapshotStatement(st), []);
  assert.equal(porSnapshotCommitment(st), porSnapshotCommitment(JSON.parse(JSON.stringify(st))));
  assert.ok(validateSnapshotStatement({ ...st, tree: { ...st.tree, root: 'xyz' } }).length > 0);
});

test('cli end-to-end: synth → build → prove → verify-proof, and open', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-'));
  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const run = (...args: string[]): string =>
    execFileSync('node', [cli, ...args], { encoding: 'utf8', cwd: dir });

  run('synth', '--users', '200', '--assets', 'BTC,ETH,USDT', '--out', path.join(dir, 'liab.jsonl'), '--seed', '42');
  const built = run('build', '--liabilities', path.join(dir, 'liab.jsonl'),
    '--exchange', 'EX-TEST-001', '--name', 'Test Exchange',
    '--asof', '2026-11-10T00:00:00Z', '--assets', 'BTC:8,ETH:18,USDT:6',
    '--out', path.join(dir, 'run'));
  assert.match(built, /200 leaves/);

  run('prove', '--tree', path.join(dir, 'run'), '--user-ref', 'user-0000042',
    '--out', path.join(dir, 'proof.json'));
  const verified = run('verify-proof', '--proof', path.join(dir, 'proof.json'),
    '--snapshot', path.join(dir, 'run', 'snapshot.json'));
  assert.match(verified, /root\+totals {2}MATCH/);
  assert.match(verified, /matches user_ref_hash/);

  run('open', '--tree', path.join(dir, 'run'), '--indices', '0,7,42,199',
    '--out', path.join(dir, 'openings.json'));
  const openings = JSON.parse(readFileSync(path.join(dir, 'openings.json'), 'utf8'));
  assert.equal(openings.openings.length, 4);
  assert.equal(openings.openings[0].leaf.user_ref, undefined); // pseudonymous
  // a tampered proof fails with exit 2
  const proof = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  proof.proof.leaf.balances[Object.keys(proof.proof.leaf.balances)[0]!] = '999999999999';
  writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(proof));
  assert.throws(() => run('verify-proof', '--proof', path.join(dir, 'bad.json'),
    '--snapshot', path.join(dir, 'run', 'snapshot.json')));
});
