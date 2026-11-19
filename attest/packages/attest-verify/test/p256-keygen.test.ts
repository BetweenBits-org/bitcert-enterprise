import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { p256KeypairFromSeed } from '../src/p256.ts';

test('pure-JS keypair parses as standard DER and round-trips a signature', () => {
  for (let i = 0; i < 8; i++) {
    const { privateKeyPkcs8, publicKeySpki } = p256KeypairFromSeed(new Uint8Array(randomBytes(32)));
    const priv = createPrivateKey({ key: Buffer.from(privateKeyPkcs8), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey({ key: Buffer.from(publicKeySpki), format: 'der', type: 'spki' });
    // The SPKI we emitted must be exactly what the platform derives from d.
    assert.equal(
      (createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer).toString('hex'),
      Buffer.from(publicKeySpki).toString('hex'));
    const msg = Buffer.from(`round ${i}`);
    const sig = sign('sha256', msg, { key: priv, dsaEncoding: 'ieee-p1363' });
    assert.equal(verify('sha256', msg, { key: pub, dsaEncoding: 'ieee-p1363' }, sig), true);
  }
});

test('out-of-range seeds are refused, not silently reduced', () => {
  assert.throws(() => p256KeypairFromSeed(new Uint8Array(32)), /scalar range/);
  assert.throws(() => p256KeypairFromSeed(new Uint8Array(31)), /32 bytes/);
  const tooBig = new Uint8Array(32).fill(0xff);
  assert.throws(() => p256KeypairFromSeed(tooBig), /scalar range/);
});
