/**
 * Producer-side units: the tree builder, the BC01 encoder, transaction
 * serialisation, and the configuration guard rails.
 *
 * The transaction tests parse their own output with the **verifier's** parser.
 * A serialiser checked only by its own reader can be self-consistently wrong;
 * round-tripping through independently written code cannot be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { txidFromRaw, parseTx, decodeAnchorPayload, extractAnchorOutput } from '@stonehash/attest-verify';
import { MerkleTree, leafHash, nodeHash } from '../src/merkle/tree.ts';
import { encodeBc01, uuidToBytes, BC01_LEN } from '../src/btc/bc01.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import { encodeVarint, uintLE } from '../src/btc/varint.ts';
import { loadConfig } from '../src/config.ts';
import { hashKey, keyPrefix, mintKey } from '../src/auth.ts';

const leaf = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = n; b[31] = n ^ 0xff;
  return b;
};
const leaves = (n: number): Uint8Array[] => Array.from({ length: n }, (_, i) => leaf(i));

test('single leaf: root is H_leaf(leaf), with no self-pairing', () => {
  const t = MerkleTree.fromLeaves([leaf(1)]);
  assert.equal(t.rootHex(), Buffer.from(leafHash(leaf(1))).toString('hex'));
  const p = t.proof(0);
  assert.deepEqual(p.siblings, []);
  assert.deepEqual(p.directions, []);
});

test('two leaves fold in index order', () => {
  const t = MerkleTree.fromLeaves([leaf(0), leaf(1)]);
  const want = nodeHash(leafHash(leaf(0)), leafHash(leaf(1)));
  assert.equal(t.rootHex(), Buffer.from(want).toString('hex'));
});

test('odd level: the last node pairs with itself (Bitcoin convention)', () => {
  const t = MerkleTree.fromLeaves([leaf(0), leaf(1), leaf(2)]);
  const h = [leaf(0), leaf(1), leaf(2)].map(leafHash);
  const want = nodeHash(nodeHash(h[0]!, h[1]!), nodeHash(h[2]!, h[2]!));
  assert.equal(t.rootHex(), Buffer.from(want).toString('hex'));
  // Leaf 2's sibling is leaf 2: emitting it is what lets a verifier reproduce
  // the fold without knowing the tree width.
  assert.equal(t.proof(2).siblings[0], Buffer.from(h[2]!).toString('hex'));
});

test('duplicate leaves are refused — their inclusion proofs would be ambiguous', () => {
  assert.throws(() => MerkleTree.fromLeaves([leaf(1), leaf(2), leaf(1)]), /duplicate leaf at index 2/);
});

test('an empty leaf set and wrong-sized leaves are refused', () => {
  assert.throws(() => MerkleTree.fromLeaves([]), /no leaves/);
  assert.throws(() => MerkleTree.fromLeaves([new Uint8Array(31)]), /must be 32 bytes/);
});

test('proof index is bounds-checked', () => {
  const t = MerkleTree.fromLeaves(leaves(4));
  assert.throws(() => t.proof(4), /out of range/);
  assert.throws(() => t.proof(-1), /out of range/);
  assert.throws(() => t.proof(1.5), /out of range/);
});

test('tree depth grows logarithmically, and sizes 1..64 all build', () => {
  for (let n = 1; n <= 64; n++) {
    const t = MerkleTree.fromLeaves(leaves(n));
    const depth = t.proof(0).siblings.length;
    assert.equal(depth, Math.ceil(Math.log2(n)), `n=${n}`);
  }
});

test('BC01 encodes the published 53-byte layout and rejects wrong sizes', () => {
  const root = new Uint8Array(32).fill(0xab);
  const batch = uuidToBytes(randomUUID());
  const p = encodeBc01(root, batch);
  assert.equal(p.length, BC01_LEN);
  const d = decodeAnchorPayload(bytesToHex(p));
  assert.equal(d?.format, 'BC01');
  assert.equal(d?.merkleRoot, 'ab'.repeat(32));
  assert.equal(d?.batchId, Buffer.from(batch).toString('hex'));
  assert.throws(() => encodeBc01(new Uint8Array(31), batch), /32 bytes/);
  assert.throws(() => encodeBc01(root, new Uint8Array(15)), /16 bytes/);
  assert.throws(() => uuidToBytes('nope'), /not a uuid/);
});

test('varint matches the CompactSize boundaries', () => {
  assert.equal(bytesToHex(encodeVarint(0)), '00');
  assert.equal(bytesToHex(encodeVarint(0xfc)), 'fc');
  assert.equal(bytesToHex(encodeVarint(0xfd)), 'fdfd00');
  assert.equal(bytesToHex(encodeVarint(0xffff)), 'fdffff');
  assert.equal(bytesToHex(encodeVarint(0x10000)), 'fe00000100');
  assert.equal(bytesToHex(uintLE(1, 4)), '01000000');
  assert.throws(() => encodeVarint(-1), /non-negative/);
});

test('OP_RETURN uses a direct push below 76 bytes and PUSHDATA1 above', () => {
  const small = new Uint8Array(53).fill(1);
  assert.equal(bytesToHex(opReturnScript(small)).slice(0, 4), '6a35'); // 0x35 = 53
  const big = new Uint8Array(100).fill(2);
  assert.equal(bytesToHex(opReturnScript(big)).slice(0, 6), '6a4c64'); // PUSHDATA1, 0x64 = 100
  assert.throws(() => opReturnScript(new Uint8Array(300)), /too large/);
});

test('our serialiser round-trips through the verifier\'s parser, txid included', () => {
  const payload = encodeBc01(new Uint8Array(32).fill(7), uuidToBytes(randomUUID()));
  const legacy = serializeLegacy(
    [{ txid: 'ab'.repeat(32), vout: 3 }],
    [
      { value: 0, scriptPubKey: opReturnScript(payload) },
      { value: 123_456_789_012, scriptPubKey: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(9)]) },
    ],
  );
  const hex = bytesToHex(legacy);

  const parsed = parseTx(hex);
  assert.equal(parsed.segwit, false);
  assert.equal(parsed.outputScripts.length, 2);
  assert.equal(bytesToHex(new Uint8Array(parsed.legacy)), hex, 're-serialisation must be identical');

  const binding = txidFromRaw(hex);
  assert.equal(binding.txid, txidOf(legacy), 'both implementations must agree on the txid');
  assert.equal(binding.anchorPayloadHex, bytesToHex(payload));
  assert.equal(bytesToHex(extractAnchorOutput(parsed.outputScripts[0]!)!), bytesToHex(payload));
});

test('values above 2^32 satoshis survive serialisation', () => {
  // 21 million BTC in satoshis exceeds 32 bits; a bitwise shift would truncate it.
  const legacy = serializeLegacy(
    [{ txid: '00'.repeat(32), vout: 0 }],
    [{ value: 2_100_000_000_000_000, scriptPubKey: new Uint8Array([0x51]) }],
  );
  // Little-endian 8-byte value sits after version(4) + varint(1) + input(41) + varint(1).
  const valueHex = bytesToHex(legacy.subarray(4 + 1 + 41 + 1, 4 + 1 + 41 + 1 + 8));
  const readBack = Buffer.from(valueHex, 'hex').readBigUInt64LE(0);
  assert.equal(readBack, 2_100_000_000_000_000n);
});

test('config is environment-driven with no compiled-in paths', () => {
  const c = loadConfig({ dataDir: '/srv/attest', dbPath: '/srv/attest/x.sqlite' });
  assert.equal(c.dbPath, '/srv/attest/x.sqlite');
  assert.equal(c.env, 'test');
  assert.equal(c.bitcoinNetwork, 'regtest');
  // Defaults must bind to loopback: a service that defaults to 0.0.0.0 is
  // exposed the first time someone forgets to set HOST.
  assert.equal(c.host, '127.0.0.1');
});

test('live + regtest is refused at boot unless explicitly overridden', () => {
  const prev = { ...process.env };
  try {
    process.env['STONEHASH_ENV'] = 'live';
    process.env['ANCHOR_BACKEND'] = 'regtest';
    delete process.env['ALLOW_REGTEST_IN_LIVE'];
    assert.throws(() => loadConfig(), /not publicly verifiable/);
    process.env['ALLOW_REGTEST_IN_LIVE'] = '1';
    assert.equal(loadConfig().env, 'live', 'a deliberate internal deployment is still possible');
  } finally {
    process.env = prev;
  }
});

test('an unknown env or backend is refused rather than defaulted', () => {
  const prev = { ...process.env };
  try {
    process.env['STONEHASH_ENV'] = 'staging';
    assert.throws(() => loadConfig(), /must be "test" or "live"/);
    process.env['STONEHASH_ENV'] = 'test';
    process.env['ANCHOR_BACKEND'] = 'signet';
    assert.throws(() => loadConfig(), /must be "regtest" or "mainnet"/);
  } finally {
    process.env = prev;
  }
});

test('key prefixes differ per environment and only the hash is derivable', () => {
  assert.equal(keyPrefix('test'), 'sk_test_');
  assert.equal(keyPrefix('live'), 'sk_live_');
  const km = mintKey('test');
  assert.ok(km.secret.startsWith('sk_test_'));
  assert.equal(km.hash, hashKey(km.secret));
  assert.equal(km.hash, createHash('sha256').update(km.secret).digest('hex'));
  assert.notEqual(mintKey('test').secret, mintKey('test').secret, 'keys must not repeat');
});
