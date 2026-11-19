/**
 * The whole loop, with nothing simulated except the chain.
 *
 * Sign offline → derive the leaf → put that leaf in a Merkle tree → verify
 * the way a recipient would, from the bundle alone. This is the test that
 * answers the question the feature exists for: does a signature made on the
 * customer's machine still prove authorship, years later, to someone running
 * only the published verifier?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statementLeaf, verifyPreimage, verifyStatement } from '@stonehash/attest-verify';
import { generateKey, signStatement } from '../src/index.ts';

const DOC = new TextEncoder().encode('INVOICE 2026-0041\nUSD 18,000.00\n');
const docDigest = createHash('sha256').update(DOC).digest('hex');

test('a signature made offline is committed by the leaf and checks out from the bundle', async () => {
  const key = await generateKey();
  const signed = await signStatement(key, {
    documentSha256: docDigest, contentType: 'text/plain',
  });

  // What the service would anchor.
  const leaf = statementLeaf(signed);

  // What a recipient does with the bundle: recompute link A both ways.
  const withOriginal = verifyPreimage(leaf, {
    scheme: 'sha256-signed-statement/v1', statement: signed,
  }, { originalBytes: DOC });
  assert.ok(withOriginal);
  assert.equal(withOriginal.selfOk, true, 'the statement must hash to the anchored leaf');
  assert.equal(withOriginal.documentOk, true, 'and the original must match the statement');

  // And the signature itself.
  const v = await verifyStatement(signed, leaf);
  assert.equal(v.signatureOk, true);
  assert.equal(v.leafOk, true);
});

test('without the original, authorship still checks but the document does not', async () => {
  const key = await generateKey();
  const signed = await signStatement(key, { documentSha256: docDigest });
  const leaf = statementLeaf(signed);

  const noOriginal = verifyPreimage(leaf, {
    scheme: 'sha256-signed-statement/v1', statement: signed,
  }, {});
  assert.ok(noOriginal);
  assert.equal(noOriginal.selfOk, true);
  assert.equal(noOriginal.documentOk, undefined,
    'not checked must stay undefined, never false and never true');
  assert.equal((await verifyStatement(signed, leaf)).signatureOk, true);
});

test('swapping the document breaks the document half and nothing else', async () => {
  const key = await generateKey();
  const signed = await signStatement(key, { documentSha256: docDigest });
  const leaf = statementLeaf(signed);

  const other = new TextEncoder().encode('INVOICE 2026-0041\nUSD 81,000.00\n');
  const r = verifyPreimage(leaf, {
    scheme: 'sha256-signed-statement/v1', statement: signed,
  }, { originalBytes: other });
  assert.ok(r);
  assert.equal(r.selfOk, true, 'the statement is untouched, so this half still passes');
  assert.equal(r.documentOk, false, 'but it is not a statement about this document');
});

test('editing the statement after anchoring breaks the leaf', async () => {
  const key = await generateKey();
  const signed = await signStatement(key, { documentSha256: docDigest });
  const anchored = statementLeaf(signed);

  // Re-point the statement at a different document and re-sign it honestly:
  // the signature is valid, but it is not what the chain committed to.
  const forged = await signStatement(key, { documentSha256: 'f'.repeat(64) });
  const r = verifyPreimage(anchored, {
    scheme: 'sha256-signed-statement/v1', statement: forged,
  }, {});
  assert.ok(r);
  assert.equal(r.selfOk, false, 'a substituted statement must not match the anchored leaf');
  assert.equal((await verifyStatement(forged, anchored)).leafOk, false);
});

test('an unknown scheme throws rather than reporting link A as fine', () => {
  assert.throws(
    () => verifyPreimage('a'.repeat(64), { scheme: 'sha256-signed-statement/v9' } as never, {}),
    /unknown preimage scheme/);
});

test('the signed-statement scheme refuses to run without the statement', () => {
  assert.throws(
    () => verifyPreimage('a'.repeat(64), { scheme: 'sha256-signed-statement/v1' }, {}),
    /requires the statement/);
});
