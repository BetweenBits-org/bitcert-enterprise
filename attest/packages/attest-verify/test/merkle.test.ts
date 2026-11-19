/**
 * Merkle inclusion (§3) and anchor decoding (§4.1) at unit level.
 *
 * `conformance.test.ts` proves the whole pipeline agrees with the producer; this
 * file pins the individual rules so a failure says *which* rule broke rather
 * than just "bundle 04 regressed".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leafHash, nodeHash, verifyInclusion } from '../src/merkle.ts';
import { decodeAnchorPayload, extractAnchorOutput } from '../src/anchor.ts';
import { bytesToHex, hexToBytes, utf8 } from '../src/bytes.ts';
import { jcsString } from '../src/jcs.ts';

test('RFC 6962 domain tags are distinct — leaf and node preimages never collide', () => {
  const d = new Uint8Array(32).fill(7);
  assert.notEqual(bytesToHex(leafHash(d)), bytesToHex(nodeHash(d, d)));
  // The frozen vector from bundle-schema.md §3.
  assert.equal(bytesToHex(leafHash(new Uint8Array(32))),
    '7f9c9e31ac8256ca2f258583df262dbc7d6f68f2a03043d5c99a4ae5a7396ce9');
});

test('H_node is order-sensitive — left and right are not interchangeable', () => {
  const l = new Uint8Array(32).fill(1);
  const r = new Uint8Array(32).fill(2);
  assert.notEqual(bytesToHex(nodeHash(l, r)), bytesToHex(nodeHash(r, l)));
});

test('single-leaf tree: root = H_leaf(leaf), no self-pairing', () => {
  const leaf = 'aa'.repeat(32);
  const root = bytesToHex(leafHash(hexToBytes(leaf)));
  const res = verifyInclusion(leaf, { root, siblings: [], directions: [] });
  assert.equal(res.ok, true);
  assert.equal(res.computedRoot, root);
});

test('a two-leaf proof folds in the declared direction', () => {
  const a = hexToBytes('11'.repeat(32));
  const b = hexToBytes('22'.repeat(32));
  const root = bytesToHex(nodeHash(leafHash(a), leafHash(b)));
  // Leaf a sits left, so its sibling is on the right.
  assert.equal(verifyInclusion('11'.repeat(32),
    { root, siblings: [bytesToHex(leafHash(b))], directions: ['right'] }).ok, true);
  // Leaf b sits right, so its sibling is on the left.
  assert.equal(verifyInclusion('22'.repeat(32),
    { root, siblings: [bytesToHex(leafHash(a))], directions: ['left'] }).ok, true);
  // Flipping a direction must not still verify.
  assert.equal(verifyInclusion('11'.repeat(32),
    { root, siblings: [bytesToHex(leafHash(b))], directions: ['left'] }).ok, false);
});

test('malformed proofs throw rather than quietly returning false', () => {
  const root = 'cc'.repeat(32);
  assert.throws(() => verifyInclusion('aa', { root, siblings: [], directions: [] }), /32 bytes/);
  assert.throws(() => verifyInclusion('aa'.repeat(32),
    { root, siblings: ['bb'.repeat(32)], directions: [] }), /length mismatch/);
  assert.throws(() => verifyInclusion('aa'.repeat(32),
    { root, siblings: ['bb'.repeat(32)], directions: ['up' as never] }), /left.*right/);
  assert.throws(() => verifyInclusion('aa'.repeat(32),
    { root, siblings: ['bb'], directions: ['right'] }), /not 32 bytes/);
});

test('BC01 decodes to its documented 53-byte layout', () => {
  const magic = '42433031';            // "BC01"
  const version = '01';
  const root = 'ab'.repeat(32);
  const batch = 'cd'.repeat(16);
  const d = decodeAnchorPayload(magic + version + root + batch);
  assert.equal(d?.format, 'BC01');
  assert.equal(d?.version, 1);
  assert.equal(d?.merkleRoot, root);
  assert.equal(d?.batchId, batch);
});

test('BC30 decodes to its documented 86-byte layout', () => {
  const payload = '42433330' + '1e' + '01' + 'cd'.repeat(16) + 'ab'.repeat(32) + '00'.repeat(32);
  const d = decodeAnchorPayload(payload);
  assert.equal(d?.format, 'BC30');
  assert.equal(d?.version, 0x1e);
  assert.equal(d?.flags, 1);
  assert.equal(d?.merkleRoot, 'ab'.repeat(32));
  assert.equal(d?.aux, '00'.repeat(32));
});

test('wrong-length BC payloads throw; an unknown magic returns null (legacy selector)', () => {
  assert.throws(() => decodeAnchorPayload('42433031' + '01' + 'ab'.repeat(16)), /53 bytes/);
  assert.throws(() => decodeAnchorPayload('42433330' + '1e01' + 'ab'.repeat(16)), /86 bytes/);
  // A raw 32-byte payload is how a legacy witness reveal signals its mode.
  assert.equal(decodeAnchorPayload('ab'.repeat(32)), null);
});

test('OP_RETURN extraction handles direct, PUSHDATA1 and non-OP_RETURN scripts', () => {
  const data = 'ab'.repeat(10);
  assert.equal(bytesToHex(extractAnchorOutput(hexToBytes('6a' + '0a' + data))!), data);
  const big = 'cd'.repeat(80);
  assert.equal(bytesToHex(extractAnchorOutput(hexToBytes('6a' + '4c' + '50' + big))!), big);
  // A P2PKH script is not an anchor output.
  assert.equal(extractAnchorOutput(hexToBytes('76a914' + '00'.repeat(20) + '88ac')), null);
});

test('JCS sorts keys, stays compact, and refuses floats', () => {
  assert.equal(jcsString({ b: '2', a: '1' }), '{"a":"1","b":"2"}');
  assert.equal(jcsString({ z: 1, a: { y: 'x', b: 'c' } }), '{"a":{"b":"c","y":"x"},"z":1}');
  assert.equal(jcsString(['b', 'a']), '["b","a"]', 'array order is data, not to be sorted');
  assert.throws(() => jcsString({ n: 1.5 }), /only integers/);
  assert.equal(new TextDecoder().decode(utf8(jcsString({ k: 'v' }))), '{"k":"v"}');
});
