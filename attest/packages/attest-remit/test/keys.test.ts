/**
 * The generated pair must be usable end to end: the PEM parses as a private
 * key, the SPKI parses as its public half, and a signature made with one
 * verifies with the other — because this exact material is what signs every
 * instruction after registration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { generateSigningKey } from '../src/keys.ts';

test('generateSigningKey emits a working ES256 pair', () => {
  const k = generateSigningKey();
  assert.match(k.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);

  const priv = createPrivateKey(k.privateKeyPem);
  const pub = createPublicKey({ key: Buffer.from(k.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
  assert.equal(priv.asymmetricKeyType, 'ec');

  const msg = Buffer.from('instruction bytes');
  const sig = sign('sha256', msg, { key: priv, dsaEncoding: 'ieee-p1363' });
  assert.equal(verify('sha256', msg, { key: pub, dsaEncoding: 'ieee-p1363' }, sig), true);

  // The public half must match the private half, not merely parse.
  const derived = createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(derived, k.publicKeySpkiBase64);

  // Two calls, two keys: no hidden determinism.
  assert.notEqual(generateSigningKey().publicKeySpkiBase64, k.publicKeySpkiBase64);
});
