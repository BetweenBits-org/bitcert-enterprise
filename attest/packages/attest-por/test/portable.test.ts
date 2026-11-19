/**
 * The plain-JavaScript derivations against their `node:crypto` counterparts.
 *
 * `portable.ts` is what a browser page runs when the platform's own crypto is
 * withheld. It has to give the same salts and leaves as the server path — or
 * a snapshot built in the console and one built by the SDK from the same
 * ledger would have different roots — and signatures the platform accepts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyP256 } from '@stonehash/attest-verify';
import {
  buildPorTree, buildSnapshotStatement, deriveSalt, leafFromRow, publicSpkiBase64, verifySnapshotSignature,
} from '../src/index.ts';
import {
  deriveSaltPortable, hmacSha256, leafFromRowPortable, privateScalarFromPem, publicSpkiFromScalar,
  signP256, signSnapshotStatementPortable,
} from '../src/portable.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

test('hmac: the RFC 4231 cases, and whatever node gives for random inputs', () => {
  // RFC 4231 test case 1 and 2.
  assert.equal(hex(hmacSha256(Buffer.alloc(20, 0x0b), Buffer.from('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(hex(hmacSha256(Buffer.from('Jefe'), Buffer.from('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  // A key longer than the block is hashed first (RFC 4231 test case 6).
  assert.equal(hex(hmacSha256(Buffer.alloc(131, 0xaa), Buffer.from('Test Using Larger Than Block-Size Key - Hash Key First'))),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  for (let i = 0; i < 50; i++) {
    const key = randomBytes(1 + (i * 7) % 100);
    const msg = randomBytes((i * 13) % 300);
    assert.equal(hex(hmacSha256(key, msg)), createHmac('sha256', key).update(msg).digest('hex'));
  }
});

test('salts and leaves are the ones the server path derives', () => {
  const seed = randomBytes(32);
  for (const ref of ['U-100001', 'kim, 민수', '😀 account', 'a'.repeat(256)]) {
    assert.equal(deriveSaltPortable(seed, ref), deriveSalt(seed, ref));
    const row = { user_ref: ref, balances: { BTC: '5' } };
    assert.deepEqual(leafFromRowPortable('KR-EX-0a1b2c', seed, row), leafFromRow('KR-EX-0a1b2c', seed, row));
  }
  assert.throws(() => deriveSaltPortable(new Uint8Array(31), 'x'), /32 bytes/);
});

test('signing: the RFC 6979 vector for P-256 with SHA-256', () => {
  // RFC 6979, appendix A.2.5, message "sample".
  const d = Buffer.from('C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721', 'hex');
  const sig = signP256(d, Buffer.from('sample'));
  assert.equal(hex(sig.subarray(0, 32)).toUpperCase(), 'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716');
  assert.equal(hex(sig.subarray(32)).toUpperCase(), 'F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8');
  // …and "test".
  const sig2 = signP256(d, Buffer.from('test'));
  assert.equal(hex(sig2.subarray(0, 32)).toUpperCase(), 'F1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367');
  assert.equal(hex(sig2.subarray(32)).toUpperCase(), '019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083');
});

test('signing: what the page signs, the platform verifies — for keys from node, the console and openssl forms', () => {
  for (let i = 0; i < 8; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const pem of [
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      privateKey.export({ format: 'pem', type: 'sec1' }).toString(),
    ]) {
      const d = privateScalarFromPem(pem);
      assert.equal(publicSpkiFromScalar(d), spki, 'the public half is the registered form');
      const message = randomBytes(i * 37 + 1);
      const sig = signP256(d, message);
      assert.equal(sig.length, 64);
      assert.equal(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), true, 'node verifies it');
      assert.equal(verifyP256(sig, message, Buffer.from(spki, 'base64')), true, 'the verifier package verifies it');
      assert.equal(verify('sha256', Buffer.concat([message, Buffer.from('x')]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), false);
    }
  }
});

test('a statement signed in the page is accepted exactly like one signed on a server', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const seed = randomBytes(32);
  const leaves = [{ user_ref: 'u1', balances: { BTC: '5' } }, { user_ref: 'u2', balances: { BTC: '7' } }]
    .map((r) => leafFromRowPortable('KR-EX-0a1b2c', seed, r));
  const tree = buildPorTree(leaves, ['BTC']);
  const statement = buildSnapshotStatement({
    institutionId: 'KR-EX-0a1b2c', name: '한빛 거래소', asof: '2026-11-17T00:00:00Z', assets: [{ symbol: 'BTC', decimals: 8 }],
  }, tree);
  const sig = signSnapshotStatementPortable(statement, privateScalarFromPem(pem));
  assert.equal(sig.alg, 'ES256');
  assert.equal(sig.key_id, 'KR-EX-0a1b2c');
  assert.equal(verifySnapshotSignature(statement, sig, publicSpkiBase64(createPrivateKey(pem))), true);
  assert.equal(verifySnapshotSignature({ ...statement, totals: { BTC: '1' } }, sig, publicSpkiBase64(createPrivateKey(pem))), false);
  // The same statement signs to the same bytes: the nonce is derived, not drawn.
  assert.deepEqual(signSnapshotStatementPortable(statement, privateScalarFromPem(pem)), sig);
});

test('a file that is not a P-256 private key is refused without being echoed', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pub = createPublicKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey).export({ format: 'pem', type: 'spki' }).toString();
  for (const bad of [rsa, k1, pub, 'not a key', '-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----']) {
    assert.throws(() => privateScalarFromPem(bad), (e: unknown) => {
      const msg = (e as Error).message;
      // Whatever was offered, none of it comes back in the message.
      const fragment = bad.slice(40, 80);
      return /private key/.test(msg) && (fragment.length < 8 || !msg.includes(fragment));
    });
  }
  // The test key published with the vectors reads, too.
  const vector = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../fixtures/por/statement.json'), 'utf8')) as
    { test_key: { private_pkcs8_pem: string; public_spki_base64: string } };
  assert.equal(publicSpkiFromScalar(privateScalarFromPem(vector.test_key.private_pkcs8_pem)), vector.test_key.public_spki_base64);
});
