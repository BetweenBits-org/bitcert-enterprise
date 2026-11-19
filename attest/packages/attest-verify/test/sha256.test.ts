/**
 * Pins the hand-rolled SHA-256 (src/sha256.ts) so it cannot drift.
 *
 * Three independent anchors:
 *  1. FIPS 180-4 / NIST published vectors.
 *  2. The proof-bundle spec's own frozen vector (bundle-schema.md §3), which the
 *     Rust producer and the Python verifier also pin.
 *  3. A differential check against `node:crypto` over randomised lengths,
 *     including every block-boundary edge case around 55/56/63/64/119/120 bytes
 *     where padding logic classically breaks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256, sha256d } from '../src/sha256.ts';
import { bytesToHex, hexToBytes, utf8, concat } from '../src/bytes.ts';

test('NIST vectors', () => {
  assert.equal(bytesToHex(sha256(utf8(''))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(bytesToHex(sha256(utf8('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(bytesToHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  // 1,000,000 × 'a' — exercises the multi-block path hard.
  assert.equal(bytesToHex(sha256(new Uint8Array(1_000_000).fill(0x61))),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('frozen proof-bundle vector: H_leaf(0x00 x 32) — bundle-schema.md §3', () => {
  const leaf = concat(new Uint8Array([0x00]), new Uint8Array(32));
  assert.equal(bytesToHex(sha256(leaf)),
    '7f9c9e31ac8256ca2f258583df262dbc7d6f68f2a03043d5c99a4ae5a7396ce9');
});

test('sha256d matches double application', () => {
  const data = utf8('bitcoin');
  assert.equal(bytesToHex(sha256d(data)), bytesToHex(sha256(sha256(data))));
  assert.equal(bytesToHex(sha256d(new Uint8Array(0))),
    bytesToHex(hexToBytes(createHash('sha256')
      .update(createHash('sha256').update(Buffer.alloc(0)).digest()).digest('hex'))));
});

test('differential vs node:crypto across block boundaries and random lengths', () => {
  const lengths = [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1023, 1024, 4096];
  for (const n of lengths) {
    const buf = randomBytes(n);
    assert.equal(bytesToHex(sha256(new Uint8Array(buf))),
      createHash('sha256').update(buf).digest('hex'), `length ${n}`);
  }
  for (let i = 0; i < 200; i++) {
    const n = Math.floor(Math.random() * 600);
    const buf = randomBytes(n);
    assert.equal(bytesToHex(sha256(new Uint8Array(buf))),
      createHash('sha256').update(buf).digest('hex'), `random length ${n}`);
  }
});

test('hex round-trip and rejection', () => {
  assert.equal(bytesToHex(hexToBytes('00ff10')), '00ff10');
  assert.equal(bytesToHex(hexToBytes('00FF10')), '00ff10');
  assert.throws(() => hexToBytes('abc'), /even/);
  assert.throws(() => hexToBytes('zz'), /invalid hex/);
});
