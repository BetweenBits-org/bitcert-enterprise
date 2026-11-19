/**
 * The agreement test — the one that makes "one engine" an assertion rather than
 * a claim on a slide.
 *
 * It takes real documents through the full producer path (hash → Merkle tree →
 * BC01 payload → transaction → bundle) and then hands the result to
 * `@stonehash/attest-verify`, which shares **no code** with any of it. The
 * producer lives in `apps/core/src`, the verifier in `packages/attest-verify`,
 * and `apps/core` depends on it only as a devDependency — so nothing in the
 * shipping service can import the checker.
 *
 * Two implementations written separately against a published spec agreeing on
 * real bytes is evidence. One implementation agreeing with itself is not.
 *
 * No Bitcoin node is involved. Links A, B and C1 are pure mathematics and prove
 * out offline; link C2 — "this txid is in a public block" — needs a chain and is
 * therefore asserted to stay unverified, which is exactly how it must be
 * reported on regtest too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { verifyBundle } from '@stonehash/attest-verify';
import { MerkleTree } from '../src/merkle/tree.ts';
import { encodeBc01, uuidToBytes, BC01_LEN } from '../src/btc/bc01.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import { assembleBundle } from '../src/bundle/assemble.ts';
import type { ProofBundleV1 } from '../src/bundle/assemble.ts';

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * Build an anchor transaction carrying `payload`. Unsigned, with a placeholder
 * input: the txid commits to the serialisation, and link C1 checks exactly that
 * the anchor bytes belong to the txid. Funding and signing are bitcoind's job
 * (`anchor/bitcoind.ts`) and change nothing this test is about.
 */
function anchorTx(payload: Uint8Array): { txid: string; rawTxHex: string } {
  const legacy = serializeLegacy(
    [{ txid: '11'.repeat(32), vout: 0 }],
    [
      { value: 0, scriptPubKey: opReturnScript(payload) },
      { value: 9_000, scriptPubKey: new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)]) },
    ],
  );
  return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy) };
}

interface Issued {
  docs: Uint8Array[];
  bundles: ProofBundleV1[];
  root: string;
  txid: string;
}

/** Run `docs` through the whole producer pipeline and return one bundle each. */
function issueBatch(docs: Uint8Array[], network: 'regtest' | 'mainnet' = 'regtest'): Issued {
  const leaves = docs.map(sha256);
  const tree = MerkleTree.fromLeaves(leaves);
  const batchId = randomUUID();
  const payload = encodeBc01(tree.root(), uuidToBytes(batchId));
  const tx = anchorTx(payload);

  const bundles = docs.map((_, i) => {
    const p = tree.proof(i);
    return assembleBundle({
      leafBytesHex: hex(leaves[i]!),
      contentType: 'application/pdf',
      descriptor: { batch_id: batchId },
      merkle: { root: p.root, siblings: p.siblings, directions: p.directions, leafIndex: p.leafIndex },
      anchor: { txid: tx.txid, rawTxHex: tx.rawTxHex, payloadHex: hex(payload) },
      network,
      generatedAt: '2026-11-04T00:00:00Z',
    });
  });
  return { docs, bundles, root: tree.rootHex(), txid: tx.txid };
}

function states(r: ReturnType<typeof verifyBundle>): string {
  return r.checks.map((c) => `${c.state} ${c.id}`).join(' | ');
}

test('single document: producer output verifies under the independent verifier', () => {
  const doc = utf8('StoneHash Attest — reserve report 2026-11-04');
  const { bundles } = issueBatch([doc]);
  const report = verifyBundle(bundles[0]!, { originalBytes: doc });

  assert.equal(report.verified, true, states(report));
  assert.equal(report.links.A, 'pass', 'original must bind to leaf_bytes');
  assert.equal(report.links.B, 'pass', 'single-leaf tree must verify');
  assert.equal(report.links.C1, 'pass', 'anchor payload must bind to the txid');
  assert.equal(report.links.C2, 'skip', 'public-chain inclusion is not provable offline');
  assert.equal(report.network, 'regtest');
});

test('batch of 7: every leaf verifies, including the self-paired last one', () => {
  // 7 is deliberately odd at two levels (7 → 4 → 2 → 1), so it exercises the
  // duplicate-last-leaf rule more than once.
  const docs = Array.from({ length: 7 }, (_, i) => utf8(`document number ${i}`));
  const { bundles } = issueBatch(docs);
  for (const [i, b] of bundles.entries()) {
    const report = verifyBundle(b, { originalBytes: docs[i]! });
    assert.equal(report.verified, true, `leaf ${i}: ${states(report)}`);
    assert.equal(report.links.B, 'pass', `leaf ${i} inclusion`);
  }
});

test('batch sizes 1..16 all round-trip for every member', () => {
  for (let n = 1; n <= 16; n++) {
    const docs = Array.from({ length: n }, (_, i) => utf8(`batch-${n} doc-${i}`));
    const { bundles } = issueBatch(docs);
    for (const [i, b] of bundles.entries()) {
      const r = verifyBundle(b, { originalBytes: docs[i]! });
      assert.equal(r.verified, true, `n=${n} leaf=${i}: ${states(r)}`);
    }
  }
});

test('a tampered original is rejected — link A fails, links B and C1 still hold', () => {
  const doc = utf8('Payment amount: USD 10,000');
  const { bundles } = issueBatch([doc]);
  const tampered = utf8('Payment amount: USD 90,000');

  const report = verifyBundle(bundles[0]!, { originalBytes: tampered });
  assert.equal(report.verified, false);
  assert.equal(report.links.A, 'fail', 'the substituted document must not bind');
  // The point of reporting links separately: the anchor is still perfectly good.
  // It is the document that does not match, and the UI must be able to say so.
  assert.equal(report.links.B, 'pass');
  assert.equal(report.links.C1, 'pass');
});

test('a bundle re-pointed at another leaf in the same batch is rejected', () => {
  const docs = [utf8('alpha'), utf8('beta'), utf8('gamma')];
  const { bundles } = issueBatch(docs);
  // Swap leaf 0's proof path onto leaf 1's record — same root, wrong path.
  const forged = structuredClone(bundles[1]!);
  forged.merkle = bundles[0]!.merkle;
  const report = verifyBundle(forged, { originalBytes: docs[1]! });
  assert.equal(report.verified, false);
  assert.equal(report.links.B, 'fail');
});

test('the anchor payload decodes to the Merkle root the producer committed', () => {
  const docs = [utf8('one'), utf8('two')];
  const { bundles, root } = issueBatch(docs);
  const payloadHex = bundles[0]!.anchor.op_return_payload_hex;
  assert.equal(payloadHex.length, BC01_LEN * 2);
  assert.equal(payloadHex.slice(0, 8), '42433031', 'BC01 magic');
  assert.equal(payloadHex.slice(10, 74), root, 'bytes 5..37 carry the root');
  const report = verifyBundle(bundles[0]!, { originalBytes: docs[0]! });
  const commit = report.checks.find((c) => c.id === 'anchor-commitment');
  assert.equal(commit?.state, 'pass');
  assert.equal(commit?.detail?.['format'], 'BC01');
});

test('mainnet bundles are labelled mainnet and regtest bundles regtest', () => {
  const doc = utf8('network labelling');
  assert.equal(verifyBundle(issueBatch([doc], 'regtest').bundles[0]!, { originalBytes: doc }).network, 'regtest');
  assert.equal(verifyBundle(issueBatch([doc], 'mainnet').bundles[0]!, { originalBytes: doc }).network, 'mainnet');
});

test('without the original, link A reports unverified rather than passing', () => {
  const doc = utf8('no original supplied');
  const { bundles } = issueBatch([doc]);
  const report = verifyBundle(bundles[0]!);
  assert.equal(report.links.A, 'skip');
  const pre = report.checks.find((c) => c.id === 'preimage');
  assert.equal(pre?.state, 'warn');
  assert.equal(pre?.gating, false, 'a missing original must not be treated as a failure either');
});
