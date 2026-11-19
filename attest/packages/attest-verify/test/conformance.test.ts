/**
 * Conformance against the producer's published fixtures.
 *
 * This is the drift guard, and it is the reason the independent verifier is
 * credible rather than merely claimed. The same eight bundles are checked by the
 * Rust producer's CI and by the reference Python verifier; this file makes a
 * third, independently written implementation agree with both.
 *
 * The three tampered cases matter more than the five valid ones. A verifier that
 * only proves good bundles good is worthless — these assert that a modified
 * original, a forged chain link and a mutated witness body are each **rejected**.
 * If a refactor ever made them pass, the build goes red before anything ships.
 *
 * Invocations mirror `bitcert-verifier/examples/run.sh` exactly, including the
 * two separate runs of example 02 (self-consistency, then identity binding).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyBundle } from '../src/index.ts';
import type { ProofBundle, VerifyReport } from '../src/index.ts';

// Fixtures live inside this repo, not beside it: production runs on a different
// instance, so nothing may depend on a path outside the checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/conformance');

const ACCOUNT = 'alice@demoex';
const SALT = '5e'.repeat(32);

function load(dir: string): ProofBundle {
  return JSON.parse(readFileSync(path.join(FIXTURES, dir, 'bundle.json'), 'utf8')) as ProofBundle;
}
function bytes(dir: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, dir, file)));
}
/** `expected.txt` is the producer's own recorded verdict — read it, don't restate it. */
function expectedVerified(dir: string): boolean {
  const txt = readFileSync(path.join(FIXTURES, dir, 'expected.txt'), 'utf8');
  if (/^VERIFIED/m.test(txt)) return true;
  if (/^FAILED/m.test(txt)) return false;
  throw new Error(`${dir}/expected.txt states neither VERIFIED nor FAILED`);
}

function why(r: VerifyReport): string {
  return r.checks.map((c) => `${c.state.toUpperCase()} ${c.id}${c.gating ? '' : ' (non-gating)'}`).join('\n');
}

interface Case {
  dir: string;
  label: string;
  input?: Parameters<typeof verifyBundle>[1];
}

const CASES: Case[] = [
  { dir: '01-attestation-file', label: 'link A: hash the supplied original',
    input: { originalBytes: bytes('01-attestation-file', 'original-report.txt') } },
  { dir: '02-daily-balance', label: 'link A: declared-field self-consistency' },
  { dir: '03-tampered-original', label: 'link A must catch a modified original',
    input: { originalBytes: bytes('03-tampered-original', 'tampered-report.txt') } },
  { dir: '04-tampered-chain', label: 'link D must catch a forged chain entry' },
  { dir: '05-daily-chain-walkback', label: 'chain walk-back continuity',
    input: { accountId: ACCOUNT, saltHex: SALT } },
  { dir: '06-daily-day-root', label: 'v2 day_root commits the reconciliation',
    input: { accountId: ACCOUNT, saltHex: SALT } },
  { dir: '07-witness-unified', label: 'PDF in witness + BC30 anchor, merkle-bound' },
  { dir: '08-tampered-witness', label: 'mutated witness body must be caught' },
];

for (const c of CASES) {
  test(`${c.dir} — ${c.label}`, () => {
    const want = expectedVerified(c.dir);
    const report = verifyBundle(load(c.dir), c.input ?? {});
    assert.equal(report.verified, want,
      `expected verified=${want}, got ${report.verified}\n${why(report)}`);
  });
}

test('02-daily-balance — identity binding with account id + private salt', () => {
  const report = verifyBundle(load('02-daily-balance'), { accountId: ACCOUNT, saltHex: SALT });
  assert.equal(report.verified, true, why(report));
  const pre = report.checks.find((c) => c.id === 'preimage');
  assert.equal(pre?.detail?.['identityOk'], true, 'salted commitment should reproduce');
});

test('02-daily-balance — a wrong salt fails the identity bind, not the whole bundle silently', () => {
  const report = verifyBundle(load('02-daily-balance'), { accountId: ACCOUNT, saltHex: 'ab'.repeat(32) });
  assert.equal(report.verified, false, 'a mismatched identity must gate');
  assert.equal(report.links.A, 'fail');
});

test('every fixture reports its own network — regtest can never pass as mainnet', () => {
  for (const c of CASES) {
    const report = verifyBundle(load(c.dir), c.input ?? {});
    assert.ok(report.network, `${c.dir}: bitcoin_network is required by the schema`);
  }
});

test('link C2 is never asserted offline, even for a fully valid bundle', () => {
  const report = verifyBundle(load('01-attestation-file'),
    { originalBytes: bytes('01-attestation-file', 'original-report.txt') });
  assert.equal(report.verified, true, why(report));
  assert.equal(report.links.C2, 'skip',
    'public-chain inclusion must stay unverified until a Bitcoin source is consulted');
  const onchain = report.checks.find((c) => c.id === 'onchain');
  assert.equal(onchain?.state, 'skip');
  assert.equal(onchain?.gating, false);
});

test('a bundle with no preimage rule reports link A as skip, never pass', () => {
  const b = load('01-attestation-file');
  delete b.record.preimage;
  const report = verifyBundle(b);
  assert.equal(report.links.A, 'skip');
  assert.ok(report.checks.some((c) => c.id === 'preimage' && c.state === 'skip'));
});

test('sha256-file without the original warns instead of passing', () => {
  const report = verifyBundle(load('01-attestation-file'));
  assert.equal(report.links.A, 'skip');
  const pre = report.checks.find((c) => c.id === 'preimage');
  assert.equal(pre?.state, 'warn');
  assert.equal(pre?.gating, false);
});

test('an unknown schema is rejected outright', () => {
  const b = load('01-attestation-file');
  b.schema = 'some-other-format/v9';
  const report = verifyBundle(b);
  assert.equal(report.verified, false);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]?.id, 'schema');
});

test('a flipped byte in the Merkle root breaks link B', () => {
  const b = load('01-attestation-file');
  const root = b.merkle!.root;
  b.merkle!.root = (root[0] === 'a' ? 'b' : 'a') + root.slice(1);
  const report = verifyBundle(b, { originalBytes: bytes('01-attestation-file', 'original-report.txt') });
  assert.equal(report.verified, false);
  assert.equal(report.links.B, 'fail');
});

test('a swapped reveal transaction breaks link C1', () => {
  const b = load('01-attestation-file');
  b.anchor.reveal_txid = 'ff'.repeat(32);
  const report = verifyBundle(b, { originalBytes: bytes('01-attestation-file', 'original-report.txt') });
  assert.equal(report.verified, false);
  assert.equal(report.links.C1, 'fail');
});
