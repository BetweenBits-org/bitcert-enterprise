import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { documentSigningRequest, checkDocumentSignature } from '../src/document-signing.ts';
import { statementSigningInput } from '../../../packages/attest-verify/src/index.ts';
import { signPreparedStatementWith } from '../../../packages/attest-sign/src/index.ts';

const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = { id: 'registered-id', label: 'test issuer', algorithm: 'ES256',
  public_key: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), created_at: '2026-11-19T00:00:00Z' };
const digest = createHash('sha256').update('document A').digest('hex');
const request = documentSigningRequest(digest, key, 'text/plain', '2026-11-19T00:00:00Z');
const signed = { ...request, signature: sign('sha256', statementSigningInput(request),
  { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };

test('downloaded request survives JSON transport and is signed by the external SDK path', async () => {
  const imported = JSON.parse(JSON.stringify(request));
  const output = await signPreparedStatementWith({ algorithm: 'ES256', publicKeySpkiBase64: key.public_key,
    sign: (bytes) => new Uint8Array(sign('sha256', bytes, { key: pair.privateKey, dsaEncoding: 'der' })) }, imported);
  assert.deepEqual(output.document, request.document);
  assert.equal(output.issued_at, request.issued_at);
  const check = await checkDocumentSignature(JSON.stringify(output), digest, key);
  assert.equal(check.valid, true);
  assert.equal(JSON.stringify(request).includes('privateKey'), false);
});

test('a valid signature cannot be used with another document or registered public key', async () => {
  const raw = JSON.stringify(signed);
  assert.equal((await checkDocumentSignature(raw, digest, key)).valid, true);
  const wrongDoc = await checkDocumentSignature(raw, 'a'.repeat(64), key);
  assert.equal(wrongDoc.signatureOk, true); assert.equal(wrongDoc.matchesDocument, false); assert.equal(wrongDoc.valid, false);
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const wrongKey = await checkDocumentSignature(raw, digest, { ...key, public_key: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
  assert.equal(wrongKey.signatureOk, true); assert.equal(wrongKey.matchesKey, false); assert.equal(wrongKey.valid, false);
  assert.equal((await checkDocumentSignature(raw, digest, null)).valid, false);
});

test('tampering and unsigned requests never enable anchoring', async () => {
  const bad = await checkDocumentSignature(JSON.stringify({ ...signed, issued_at: '2026-11-20T00:00:00Z' }), digest, key);
  assert.equal(bad.signatureOk, false); assert.equal(bad.valid, false);
  await assert.rejects(checkDocumentSignature(JSON.stringify(request), digest, key));
  await assert.rejects(checkDocumentSignature('not json', digest, key));
});
