/**
 * The conformance vectors and the reference must say the same thing.
 *
 * `fixtures/por/` is what the SDKs in other languages are tested against. If
 * this package changed and the files did not, those SDKs would go on passing
 * while disagreeing with the platform — so the files are regenerated in
 * memory here and compared with what is on disk, byte for byte, apart from
 * the one value that cannot be reproduced (an ECDSA signature), which is
 * checked by verifying it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadTreeDir, porSnapshotCommitment, verifySnapshotSignature } from '../src/index.ts';
import type { PorSignature, PorSnapshotStatement } from '../src/index.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/por');
const GENERATOR = path.resolve(import.meta.dirname, '../tools/make-vectors.ts');

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full, base) : [path.relative(base, full)];
  }).sort();
}

test('the published vectors are exactly what the reference produces', () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'attest-por-vectors-'));
  try {
    // Regenerate into a copy of the tree, so the files on disk are only read.
    const root = path.join(work, 'attest');
    for (const part of ['packages/attest-por/src', 'packages/attest-por/tools', 'packages/attest-por/samples', 'fixtures/por']) {
      cpSync(path.resolve(import.meta.dirname, '../../..', part), path.join(root, part), { recursive: true });
    }
    cpSync(path.resolve(import.meta.dirname, '../node_modules'), path.join(root, 'packages/attest-por/node_modules'),
      { recursive: true, verbatimSymlinks: false, dereference: true });
    execFileSync('node', [path.join(root, 'packages/attest-por/tools/make-vectors.ts')], { stdio: 'pipe' });

    const fresh = path.join(root, 'fixtures/por');
    assert.deepEqual(files(fresh), files(FIXTURES), 'the same set of files');
    for (const f of files(FIXTURES)) {
      assert.equal(readFileSync(path.join(fresh, f), 'utf8'), readFileSync(path.join(FIXTURES, f), 'utf8'),
        `fixtures/por/${f} is out of date — run: node ${path.relative(process.cwd(), GENERATOR)}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the signature vector verifies, and its tampered forms do not', () => {
  const v = JSON.parse(readFileSync(path.join(FIXTURES, 'statement.json'), 'utf8')) as {
    statement: PorSnapshotStatement; commitment: string; signature: PorSignature;
    test_key: { public_spki_base64: string };
    must_not_verify: { why: string; statement: PorSnapshotStatement; signature: PorSignature }[];
  };
  assert.equal(porSnapshotCommitment(v.statement), v.commitment);
  assert.equal(verifySnapshotSignature(v.statement, v.signature, v.test_key.public_spki_base64), true);
  for (const bad of v.must_not_verify) {
    assert.equal(verifySnapshotSignature(bad.statement, bad.signature, v.test_key.public_spki_base64), false, bad.why);
  }
});

test('the snapshot directory in the vectors loads and reproduces its root', async () => {
  const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'snapshot-dir.expected.json'), 'utf8')) as { root: string; leaf_count: number };
  const loaded = await loadTreeDir(path.join(FIXTURES, 'snapshot-dir'));
  assert.equal(loaded.tree.root, expected.root);
  assert.equal(loaded.leaves.length, expected.leaf_count);
});
