/**
 * A file the reader supplies is checked against what was anchored — for every
 * kind of bundle — and a file nobody supplied is never said to match.
 *
 * `sha256-file` has always worked this way. These tests hold the other two
 * kinds to the same rule: a signed anchor, where the leaf is the hash of a
 * statement that names the document, and a witness bundle, where the document
 * rides in the transaction itself. Before, a signed anchor reported link A
 * `pass` on the statement alone — with the right file, with a different file,
 * and with no file — and a witness bundle did not look at a supplied file.
 *
 * The signed bundle below is built by hand, from the published layout, with
 * no producer code: the verifier shares nothing with what it checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../src/index.ts';
import type { ProofBundle } from '../src/index.ts';
import { statementLeaf, statementSigningInput, buildStatement } from '../src/statement.ts';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/conformance');
const sha256 = (...parts: Uint8Array[]): Buffer => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const why = (r: ReturnType<typeof verifyBundle>): string => r.checks.map((c) => `${c.state} ${c.id}`).join(' | ');

const DOC = utf8('Reserve report, 18 November 2026');
const OTHER = utf8('Reserve report, 18 November 2026 (amended)');

/** A signed anchor of DOC: one leaf, a BC01 payload, an unsigned transaction that carries it. */
async function signedBundle(): Promise<ProofBundle> {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', key.publicKey)).toString('base64');
  const core = buildStatement({ documentSha256: sha256(DOC).toString('hex'), keyId: 'test-key', publicKeySpkiBase64: spki, issuedAt: '2026-11-18T00:00:00.000Z' });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, statementSigningInput(core))).toString('base64url');
  const statement = { ...core, signature };
  const leaf = statementLeaf(statement);
  const root = sha256(new Uint8Array([0x00]), Buffer.from(leaf, 'hex'));
  const payload = Buffer.concat([Buffer.from('BC01', 'latin1'), Buffer.from([0x01]), root, Buffer.alloc(16, 0x07)]);
  const tx = Buffer.concat([
    Buffer.from('02000000', 'hex'), Buffer.from([0x01]), Buffer.alloc(32, 0x11), Buffer.alloc(4), Buffer.from([0x00]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([0x01]), Buffer.alloc(8), Buffer.from([payload.length + 2, 0x6a, payload.length]), payload, Buffer.alloc(4),
  ]);
  const txid = Buffer.from(sha256(sha256(tx))).reverse().toString('hex');
  return {
    schema: 'bitcert-proof-bundle/v1', bitcoin_network: 'regtest', generated_at: '2026-11-18T00:00:00Z',
    record: { kind: 'attestation', leaf_bytes: leaf, preimage: { scheme: 'sha256-signed-statement/v1', statement } },
    merkle: { leaf_index: 0, root: root.toString('hex'), siblings: [], directions: [] },
    anchor: { reveal_txid: txid, reveal_tx_hex: tx.toString('hex'), op_return_payload_hex: payload.toString('hex') },
  } as unknown as ProofBundle;
}

test('a signed anchor with its own document: both halves of link A hold', async () => {
  const r = verifyBundle(await signedBundle(), { originalBytes: DOC });
  assert.equal(r.verified, true, why(r));
  assert.deepEqual([r.links.A, r.links.B, r.links.C1], ['pass', 'pass', 'pass'], why(r));
  assert.equal(r.checks.find((c) => c.id === 'preimage')?.detail?.documentOk, true);
});

test('a signed anchor with another document is not verified', async () => {
  const r = verifyBundle(await signedBundle(), { originalBytes: OTHER });
  assert.equal(r.verified, false, 'a different file must never be reported as the anchored one');
  assert.equal(r.links.A, 'fail');
  // The anchor itself is as good as ever; it is the file that is not the one it names.
  assert.deepEqual([r.links.B, r.links.C1], ['pass', 'pass'], why(r));
  const pre = r.checks.find((c) => c.id === 'preimage');
  assert.equal(pre?.state, 'fail');
  assert.equal(pre?.detail?.selfOk, true);
  assert.equal(pre?.detail?.documentOk, false);
});

test('a signed anchor without the document says nothing about the document', async () => {
  const r = verifyBundle(await signedBundle());
  assert.equal(r.links.A, 'skip', 'nobody looked at a document, so link A is not a pass');
  const pre = r.checks.find((c) => c.id === 'preimage');
  assert.equal(pre?.state, 'warn');
  assert.equal(pre?.gating, false);
  assert.equal(pre?.detail?.selfOk, true, 'the statement half is still checked, from the bundle alone');
  assert.equal(pre?.detail?.documentOk, undefined);
  // As for sha256-file without its original: the anchor stands, link A is simply not claimed.
  assert.equal(r.verified, true, why(r));
});

test('a signed statement that does not hash to the leaf fails, whatever file is supplied', async () => {
  const b = await signedBundle();
  (b.record.preimage as unknown as { statement: { issued_at: string } }).statement.issued_at = '2026-11-18T00:00:00.001Z';
  for (const input of [{ originalBytes: DOC }, {}]) {
    const r = verifyBundle(structuredClone(b), input);
    assert.equal(r.links.A, 'fail', why(r));
    assert.equal(r.verified, false);
  }
});

test('a witness bundle: the supplied file has to be the inscribed document', () => {
  const bundle = JSON.parse(readFileSync(path.join(FIX, '07-witness-unified', 'bundle.json'), 'utf8')) as ProofBundle;
  const original = new Uint8Array(readFileSync(path.join(FIX, '07-witness-unified', 'original.pdf')));

  const alone = verifyBundle(structuredClone(bundle));
  assert.equal(alone.links.A, 'pass', 'the document recovered from the transaction binds by itself');
  assert.equal(alone.checks.some((c) => c.id === 'supplied-original'), false, 'no file supplied, no claim about one');

  const withIt = verifyBundle(structuredClone(bundle), { originalBytes: original });
  assert.equal(withIt.verified, alone.verified, why(withIt));
  assert.equal(withIt.links.A, 'pass');
  assert.equal(withIt.checks.find((c) => c.id === 'supplied-original')?.state, 'pass');

  const withAnother = verifyBundle(structuredClone(bundle), { originalBytes: OTHER });
  assert.equal(withAnother.verified, false, 'a different file must never be reported as the inscribed one');
  assert.equal(withAnother.links.A, 'fail');
  assert.equal(withAnother.checks.find((c) => c.id === 'supplied-original')?.state, 'fail');
  assert.equal(withAnother.checks.find((c) => c.id === 'witness-original')?.state, alone.checks.find((c) => c.id === 'witness-original')?.state,
    'what the transaction carries is unchanged; it is the supplied file that is not it');
});
