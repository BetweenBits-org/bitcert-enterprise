/**
 * Batching groups by organisation, and that is a privacy boundary.
 *
 * Mixing tenants into one tree is cheaper — the transaction fee divides
 * across more documents — and it was harmless while the chain only ever saw
 * a Merkle root. A root is 32 bytes and reveals nothing about who built it.
 *
 * It stops being harmless once a batch's witness carries issuer statements,
 * because a statement is readable: document digest, key id, timestamp. One
 * shared batch would publish every co-tenant's statements to anyone who
 * opens the transaction — the customer list, and each customer's volume, on
 * a public chain.
 *
 * So this file is not a test of a grouping preference. It is the test that
 * keeps one tenant's records out of another tenant's transaction, and the
 * reason it must keep passing even if someone later notices that shared
 * batches would be cheaper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db.ts';
import { AttestService } from '../src/service.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from '../src/anchor/backend.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';

const digest = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Never contacted here; batching is pure bookkeeping until `anchorBatch`. */
const backend: AnchorBackend = {
  network: 'regtest',
  name: 'stub',
  submit: (): Promise<AnchorHandle> => { throw new Error('not used'); },
  poll: (): Promise<AnchorState> => { throw new Error('not used'); },
  health: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
};

async function fixture(): Promise<{ svc: AttestService; a: string; b: string }> {
  const svc = new AttestService(await openDb(':memory:'), backend, 1024);
  return { svc, a: await svc.ensureOrg('org-a', 'A'), b: await svc.ensureOrg('org-b', 'B') };
}

/** Which org each leaf in a sealed batch belongs to. */
async function orgsInBatch(svc: AttestService, batchId: string): Promise<Set<string>> {
  const rows = await (svc as unknown as { db: { prepare: (q: string) => { all: (...a: unknown[]) => Promise<unknown[]> } } })
    .db.prepare('SELECT DISTINCT org_id FROM attestations WHERE batch_id = ?').all(batchId);
  return new Set((rows as { org_id: string }[]).map((r) => r.org_id));
}

test('a batch never contains two organisations', async () => {
  const { svc, a, b } = await fixture();
  // Interleaved on purpose: insertion order alone would mix them.
  await svc.issue(a, digest('a-1'));
  await svc.issue(b, digest('b-1'));
  await svc.issue(a, digest('a-2'));
  await svc.issue(b, digest('b-2'));

  const first = await svc.sealBatch();
  assert.ok(first, 'expected a batch');
  const firstOrgs = await orgsInBatch(svc, first);
  assert.equal(firstOrgs.size, 1, `a batch mixed ${firstOrgs.size} organisations`);

  const second = await svc.sealBatch();
  assert.ok(second, 'the other org should still be waiting, in its own batch');
  const secondOrgs = await orgsInBatch(svc, second);
  assert.equal(secondOrgs.size, 1);
  assert.notDeepEqual([...firstOrgs], [...secondOrgs], 'the two batches should be different orgs');

  assert.equal(await svc.sealBatch(), null, 'nothing left to seal');
});

test('the oldest pending record picks the org, so a quiet tenant is not starved', async () => {
  const { svc, a, b } = await fixture();
  // B is first in and has one record; A arrives after and has many. Choosing
  // the busiest org would leave B waiting behind every A flush, forever.
  await svc.issue(b, digest('b-only'));
  for (let i = 0; i < 5; i++) await svc.issue(a, digest(`a-${i}`));

  const first = await svc.sealBatch();
  assert.ok(first);
  assert.deepEqual([...await orgsInBatch(svc, first)], [b], 'the earliest record should decide the batch');
});

test('one org fills a batch up to the leaf cap and the remainder waits', async () => {
  const db = await openDb(':memory:');
  const svc = new AttestService(db, backend, 3);
  const a = await svc.ensureOrg('org-a', 'A');
  for (let i = 0; i < 5; i++) await svc.issue(a, digest(`x-${i}`));

  const first = await svc.sealBatch();
  assert.ok(first);
  const n = ((await db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE batch_id = ?')
    .get(first)) as { n: number }).n;
  assert.equal(n, 3, 'the cap still applies within one org');

  const second = await svc.sealBatch();
  assert.ok(second, 'the leftover two should seal next');
  assert.equal(await svc.sealBatch(), null);
});

test('an empty table seals nothing rather than an empty batch', async () => {
  const { svc } = await fixture();
  assert.equal(await svc.sealBatch(), null);
});

test('every leaf in a sealed batch gets an inclusion proof against that batch', async () => {
  const { svc, a } = await fixture();
  for (let i = 0; i < 4; i++) await svc.issue(a, digest(`p-${i}`));
  const batchId = await svc.sealBatch();
  assert.ok(batchId);

  const db = (svc as unknown as { db: {
    prepare: (q: string) => { all: (...x: unknown[]) => Promise<unknown[]>; get: (...x: unknown[]) => Promise<unknown> };
  } }).db;
  const leaves = (await db.prepare('SELECT id FROM attestations WHERE batch_id = ?').all(batchId)) as { id: string }[];
  assert.equal(leaves.length, 4);
  for (const l of leaves) {
    const proof = (await db.prepare(
      'SELECT batch_id FROM merkle_proofs WHERE attestation_id = ?').get(l.id)) as { batch_id: string } | undefined;
    assert.ok(proof, `no proof for ${l.id}`);
    assert.equal(proof.batch_id, batchId, 'a proof pointing at a different batch is unverifiable');
  }
});

test('the list carries the batch\'s anchoring transaction, so a batched digest is not "awaiting batch"', async () => {
  // The records screen links each row's transaction. An inscription has its
  // own on the row; a batched digest's lives on the batch, and before this
  // the list left it out — so a confirmed digest showed as still waiting.
  const anchoring: AnchorBackend = {
    network: 'regtest', name: 'stub',
    async submit(payload: Uint8Array): Promise<AnchorHandle> {
      const legacy = serializeLegacy([{ txid: '33'.repeat(32), vout: 0 }], [{ value: 0, scriptPubKey: opReturnScript(payload) }]);
      return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy), anchorPayloadHex: bytesToHex(payload) };
    },
    poll: (): Promise<AnchorState> => Promise.resolve({ status: 'pending', confirmations: 0 }),
    health: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
  };
  const svc = new AttestService(await openDb(':memory:'), anchoring, 1024);
  const org = await svc.ensureOrg('org-l', 'L');
  const first = await svc.issue(org, digest('l-1'));
  const batchId = await svc.sealBatch();
  assert.ok(batchId, 'expected a batch');
  const txid = await svc.anchorBatch(batchId!);
  const later = await svc.issue(org, digest('l-2'));
  const byId = new Map((await svc.list(org)).map((a) => [a.id, a]));
  assert.equal(byId.get(first.id)?.status, 'submitted');
  assert.equal(byId.get(first.id)?.anchor_txid, txid, 'a batched digest lists the batch\'s transaction');
  assert.equal(byId.get(later.id)?.anchor_txid ?? null, null, 'a record not yet batched has none');
});
