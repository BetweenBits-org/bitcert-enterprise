/**
 * The evidence archive end to end.
 *
 * The PDF is checked with `pdftotext` and `pdfinfo` rather than by inspecting
 * our own bytes: a hand-written PDF that only our own code can read would be
 * useless to the reviewer who has to open it. The archive is extracted with the
 * system `unzip` for the same reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenario, DEMO_KEYRING, evaluate, verifyEvidenceSignatures } from '@stonehash/attest-rules';
import type { Policy, SettlementEvidence } from '@stonehash/attest-rules';
import { verifyBundle } from '@stonehash/attest-verify';
import type { ProofBundle } from '@stonehash/attest-verify';
import { assembleEvidenceBundle, assembleFiles } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(HERE, '../../attest-rules');
const PROOFS = path.resolve(HERE, '../../../fixtures/conformance/01-attestation-file');

const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const EVIDENCE = read(path.join(RULES, 'fixtures/a-normal-trade-payment.json')) as SettlementEvidence;
const POLICY = read(path.join(RULES, 'policies/settlement-match-v1.json')) as Policy;
const PROOF = read(path.join(PROOFS, 'bundle.json')) as ProofBundle;

const AT = new Date('2026-03-04T09:02:00Z');
const ID = 'EV-2026-0001';

/**
 * Build a scenario, verify its signatures, then evaluate — the same order the
 * HTTP route and the Playground use. Verifying has to come after the scenario
 * transform: C corrupts signature bytes, so a verdict from pre-verified
 * evidence would describe something else entirely.
 */
async function input(scenario: 'A' | 'B' | 'C' | 'D' | 'E' = 'A', withProof = true) {
  const evidence = await verifyEvidenceSignatures(buildScenario(scenario, EVIDENCE), DEMO_KEYRING);
  const verdict = evaluate(evidence, POLICY);
  const proofReport = verifyBundle(PROOF, {
    originalBytes: new Uint8Array(readFileSync(path.join(PROOFS, 'original-report.txt'))),
  });
  return {
    evidence, policy: POLICY, verdict, bundleId: ID, generatedAt: AT,
    ...(withProof ? { proofBundle: PROOF, proofReport } : {}),
  };
}

function extract<T>(zip: Uint8Array, fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'ev-'));
  try {
    const file = path.join(dir, 'b.zip');
    writeFileSync(file, zip);
    execFileSync('unzip', ['-q', file, '-d', dir]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the archive carries every member the format promises', async () => {
  const b = await assembleEvidenceBundle(await input());
  const names = b.files.map((f) => f.path);
  for (const expected of [
    'manifest.json', 'evidence.json', 'policy.json', 'matching-results.json',
    'source-hashes.json', 'issuer-signatures.json',
    'proof-bundle.json', 'merkle-proof.json', 'bitcoin-anchor.json',
    'verification-report.json', 'verification-report.pdf',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  // The manifest is first, so a reader meets it before anything else.
  assert.equal(names[0], 'manifest.json');
  assert.match(b.filename, /^stonehash-evidence-EV-2026-0001\.zip$/);
  assert.match(b.sha256, /^[0-9a-f]{64}$/);
});

test('the system unzip extracts it cleanly', async () => {
  const b = await assembleEvidenceBundle(await input());
  extract(b.zip, (dir) => {
    for (const f of b.files) {
      const p = path.join(dir, f.path);
      assert.ok(existsSync(p), `${f.path} was not extracted`);
      assert.deepEqual(new Uint8Array(readFileSync(p)), f.bytes, `${f.path} differs after extraction`);
    }
  });
});

test('the manifest digests every other member, so an edited archive is detectable', async () => {
  const b = await assembleEvidenceBundle(await input());
  const manifest = JSON.parse(new TextDecoder().decode(b.files[0]!.bytes)) as {
    contents: { path: string; sha256: string; bytes: number }[];
  };
  const byPath = new Map(manifest.contents.map((c) => [c.path, c]));
  assert.equal(byPath.size, b.files.length - 1, 'the manifest should list every member but itself');
  const { createHash } = await import('node:crypto');
  for (const f of b.files.slice(1)) {
    const entry = byPath.get(f.path);
    assert.ok(entry, `${f.path} is not in the manifest`);
    assert.equal(entry.sha256, createHash('sha256').update(f.bytes).digest('hex'), f.path);
    assert.equal(entry.bytes, f.bytes.length, f.path);
  }
});

test('policy.json is the exact canonical bytes the verdict digest was taken over', async () => {
  const b = await assembleEvidenceBundle(await input());
  const policyFile = b.files.find((f) => f.path === 'policy.json')!;
  const verdict = JSON.parse(
    new TextDecoder().decode(b.files.find((f) => f.path === 'matching-results.json')!.bytes),
  ) as { policyDigest: string };
  const { createHash } = await import('node:crypto');
  // The file carries a trailing newline for readability; the digest covers the
  // canonical form without it. A reader can reproduce it exactly.
  const canonical = new TextDecoder().decode(policyFile.bytes).replace(/\n$/, '');
  assert.equal(createHash('sha256').update(canonical).digest('hex'), verdict.policyDigest,
    'the shipped policy must reproduce the digest recorded in the verdict');
});

test('the proof bundle ships whole, so the published verifier can read it directly', async () => {
  const b = await assembleEvidenceBundle(await input());
  const shipped = JSON.parse(
    new TextDecoder().decode(b.files.find((f) => f.path === 'proof-bundle.json')!.bytes),
  ) as ProofBundle;
  // Re-verify the shipped copy, not the original: the archive must be usable
  // on its own, with no StoneHash software in the loop.
  const r = verifyBundle(shipped, {
    originalBytes: new Uint8Array(readFileSync(path.join(PROOFS, 'original-report.txt'))),
  });
  assert.equal(r.verified, true, r.checks.map((c) => `${c.state} ${c.id}`).join(' | '));
  assert.equal(r.links.C2, 'skip', 'public-chain inclusion stays unverified offline');
});

test('the PDF is a valid document that external tools can read', async () => {
  const b = await assembleEvidenceBundle(await input());
  const pdf = b.files.find((f) => f.path === 'verification-report.pdf')!.bytes;
  assert.equal(new TextDecoder('latin1').decode(pdf.subarray(0, 8)), '%PDF-1.4');

  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-'));
  try {
    const file = path.join(dir, 'r.pdf');
    writeFileSync(file, pdf);
    // pdfinfo writes parse complaints to stderr while still exiting 0, so the
    // first version of this test passed over a malformed indirect reference
    // (`/Parent 12 R` instead of `/Parent 12 0 R`). stderr is now asserted
    // empty — a reader that merely tolerates our output is not good enough.
    const proc = execFileSync('pdfinfo', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const info = proc;
    const stderr = execFileSync('sh', ['-c', `pdfinfo ${JSON.stringify(file)} 2>&1 >/dev/null`],
      { encoding: 'utf8' });
    assert.equal(stderr.trim(), '', `pdfinfo reported a problem: ${stderr}`);
    assert.match(info, /Pages:\s+\d+/);
    assert.match(info, /Producer:\s+StoneHash Attest/);
    assert.match(info, /Page size:\s+595/, 'A4 width in points');

    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    assert.match(text, /Settlement Evidence Verification Report/);
    // The caveat must survive into the rendered page, not just the source.
    assert.match(text, /SYNTHETIC DATA/);
    assert.match(text, /settlement-match-v1/);
    assert.match(text, /What this report does not establish/);
    assert.match(text, /not a compliance determination/);
    // The policy digest has to be readable, or the report cannot be tied to its rules.
    const verdict = evaluate(buildScenario('A', EVIDENCE), POLICY);
    assert.ok(text.includes(verdict.policyDigest.slice(0, 32)),
      'the policy digest must appear in full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mismatch verdict reaches the printed report with its numbers', async () => {
  const b = await assembleEvidenceBundle(await input('B'));
  const pdf = b.files.find((f) => f.path === 'verification-report.pdf')!.bytes;
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-'));
  try {
    const file = path.join(dir, 'r.pdf');
    writeFileSync(file, pdf);
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    assert.match(text, /Matching: MISMATCH/);
    assert.match(text, /AMOUNT_MISMATCH/);
    // "amounts do not match" is not actionable; the figures must be on the page.
    assert.match(text, /expected=50000\.00/);
    assert.match(text, /actual=48000\.00/);
    assert.match(text, /tolerance=0\.00/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scenario C reaches the report as issuer failure with integrity intact', async () => {
  const b = await assembleEvidenceBundle(await input('C'));
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-'));
  try {
    const file = path.join(dir, 'r.pdf');
    writeFileSync(file, b.files.find((f) => f.path === 'verification-report.pdf')!.bytes);
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    assert.match(text, /Issuer: INVALID/);
    assert.match(text, /Integrity: VALID/, 'the combination a single tick would hide');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two exports of the same evidence are byte-identical', async () => {
  const a = await assembleEvidenceBundle(await input());
  const b = await assembleEvidenceBundle(await input());
  assert.deepEqual(a.zip, b.zip);
  assert.equal(a.sha256, b.sha256);
  // A different timestamp changes the archive; it is recorded, not ignored.
  const c = await assembleEvidenceBundle({ ...await input(), generatedAt: new Date('2026-03-05T09:02:00Z') });
  assert.notEqual(a.sha256, c.sha256);
});

test('the manifest states the limitations that apply to this archive', async () => {
  const b = await assembleEvidenceBundle(await input());
  const m = JSON.parse(new TextDecoder().decode(b.files[0]!.bytes)) as {
    limitations: string[]; dataMode: string; bitcoinNetwork: string | null;
    regulatoryDecision: string; axes: Record<string, string>;
  };
  assert.equal(m.dataMode, 'SYNTHETIC');
  assert.equal(m.regulatoryDecision, 'NOT_EVALUATED');
  assert.ok(m.limitations.some((l) => /synthetic/i.test(l)), 'synthetic data must be declared');
  assert.ok(m.limitations.some((l) => /not a compliance determination/i.test(l)));
  assert.ok(m.limitations.some((l) => /RFC 3161/.test(l)));
  // The fixture proof is anchored to regtest, so that caveat must appear too.
  assert.equal(m.bitcoinNetwork, 'regtest');
  assert.ok(m.limitations.some((l) => /non-public chain/i.test(l)),
    'a non-mainnet anchor must be called out');
  assert.equal(m.axes['matching'], 'MATCH');
  assert.equal(m.axes['businessFinality'], 'DEMO_ONLY');
});

test('an archive without a proof omits the proof members rather than faking them', async () => {
  const files = assembleFiles(await input('A', false));
  const names = files.map((f) => f.path);
  assert.ok(!names.includes('proof-bundle.json'));
  assert.ok(!names.includes('bitcoin-anchor.json'));
  assert.ok(!names.includes('merkle-proof.json'));
  // The evidence and the verdict are still a complete, honest record.
  assert.ok(names.includes('evidence.json'));
  assert.ok(names.includes('matching-results.json'));
  assert.ok(names.includes('verification-report.pdf'));
  const m = JSON.parse(new TextDecoder().decode(files[0]!.bytes)) as { bitcoinNetwork: null; anchorTxid: null };
  assert.equal(m.bitcoinNetwork, null);
  assert.equal(m.anchorTxid, null);
});

test('every member carries a one-line description, repeated into the manifest', async () => {
  const b = await assembleEvidenceBundle(await input());
  for (const f of b.files) {
    assert.ok(f.describes.length > 40, `${f.path} needs a description a reader can use`);
  }
  const m = JSON.parse(new TextDecoder().decode(b.files[0]!.bytes)) as {
    contents: { path: string; describes: string }[];
  };
  for (const c of m.contents) assert.ok(c.describes.length > 40, c.path);
});
