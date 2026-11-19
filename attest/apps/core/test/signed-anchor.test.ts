/**
 * Signed anchoring, end to end, through the real service.
 *
 * The feature's claim is narrow and worth stating exactly, because the
 * failure mode is claiming more:
 *
 *   The chain proves a document existed by a block height. A signature
 *   proves the holder of a key published it. Registering that key with us
 *   beforehand is what turns "a key" into "their key". All three are
 *   separate, and this file keeps them separate.
 *
 * The private key is generated here the way a customer's machine would
 * generate it and never crosses into the service — there is no API that
 * would take one, which is the property worth testing rather than asserting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statementLeaf, verifyBundle } from '@stonehash/attest-verify';
import { generateKey, signStatement } from '@stonehash/attest-sign';
import { openDb } from '../src/db.ts';
import { AttestService } from '../src/service.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from '../src/anchor/backend.ts';

const DOC = new TextEncoder().encode('SERVICES AGREEMENT\nUSD 18,000 per quarter\n');
const docDigest = createHash('sha256').update(DOC).digest('hex');

/** Builds a real transaction so the bundle is shaped like a live one. */
class StubBackend implements AnchorBackend {
  readonly network = 'regtest' as const;
  readonly name = 'stub';
  async submit(payload: Uint8Array): Promise<AnchorHandle> {
    const outputs = [{ value: 0, scriptPubKey: opReturnScript(payload) }];
    const inputs = [{ txid: '11'.repeat(32), vout: 0 }];
    const raw = serializeLegacy(inputs, outputs);
    return { txid: txidOf(raw), rawTxHex: bytesToHex(raw), anchorPayloadHex: bytesToHex(payload) };
  }
  async poll(): Promise<AnchorState> { return { status: 'confirmed', confirmations: 1, blockHeight: 9 }; }
  async health(): Promise<{ ok: boolean }> { return { ok: true }; }
}

async function svc(): Promise<{ s: AttestService; org: string }> {
  const s = new AttestService(await openDb(':memory:'), new StubBackend(), 1024);
  return { s, org: await s.ensureOrg('acme', 'Acme') };
}

test('a signed anchor commits the signature, and the bundle verifies without us', async () => {
  const { s, org } = await svc();
  const key = await generateKey();
  const statement = await signStatement(key, {
    documentSha256: docDigest, contentType: 'application/pdf',
  });

  const att = await s.issueSigned(org, statement);

  // The leaf is the statement's hash, not the document's — that is what puts
  // the signature under the chain's commitment.
  assert.equal(att.leaf_bytes, statementLeaf(statement));
  assert.notEqual(att.leaf_bytes, docDigest, 'anchoring the document digest would leave the signature untimestamped');

  const batchId = await s.sealBatch();
  assert.ok(batchId);
  await s.anchorBatch(batchId);

  const bundle = await s.exportBundle(org, att.id);
  assert.equal(bundle.record.preimage.scheme, 'sha256-signed-statement/v1');
  assert.deepEqual(bundle.record.preimage.statement, statement,
    'the statement must travel verbatim; re-serialising would void the signature');

  // The independent verifier, with the original, checks both halves of link A.
  const report = await verifyBundle(bundle as never, { originalBytes: DOC });
  assert.equal(report.verified, true, JSON.stringify(report.checks));
  assert.equal(report.links.A, 'pass');
  assert.equal(report.links.B, 'pass');
  assert.equal(report.links.C1, 'pass');
});

test('a signature that does not verify is refused, not stored', async () => {
  const { s, org } = await svc();
  const key = await generateKey();
  const statement = await signStatement(key, { documentSha256: docDigest });

  // Edit a signed field. The statement is still well formed and still hashes
  // to something; only the signature no longer covers it.
  const tampered = { ...statement, document: { sha256: 'f'.repeat(64) } };
  await assert.rejects(s.issueSigned(org, tampered as never), /does not verify/);
  assert.equal((await s.list(org)).length, 0, 'nothing may be stored for a rejected signature');
});

test('a malformed statement is refused before anything is hashed', async () => {
  const { s, org } = await svc();
  await assert.rejects(s.issueSigned(org, {} as never), /statement|schema/i);
  await assert.rejects(
    s.issueSigned(org, { schema: 'something-else' } as never), /schema/);
});

test('trust is recorded apart from validity, and only registration grants it', async () => {
  const { s, org } = await svc();
  const key = await generateKey();

  // Signed by a key nobody vouched for. Mathematically sound, provenance nil.
  const first = await s.issueSigned(org, await signStatement(key, { documentSha256: docDigest }));
  assert.equal(first.issuer_trust, 'unregistered');

  // Register the public half — the only half that is ever sent.
  const reg = await s.registerIssuerKey(org, key.publicKeySpkiBase64, 'finance signer');
  assert.equal(reg.already, false);
  assert.equal((await s.registerIssuerKey(org, key.publicKeySpkiBase64, 'again')).already, true,
    'registering the same key twice should be idempotent, not a duplicate');

  const second = await s.issueSigned(org, await signStatement(key, {
    documentSha256: 'b'.repeat(64),
  }));
  assert.equal(second.issuer_trust, 'registered');

  // Revoking takes the provenance back for future records, not past ones.
  assert.equal(await s.revokeIssuerKey(org, reg.id), true);
  const third = await s.issueSigned(org, await signStatement(key, {
    documentSha256: 'c'.repeat(64),
  }));
  assert.equal(third.issuer_trust, 'unregistered');
  assert.equal((await s.get(org, second.id))!.issuer_trust, 'registered',
    'a record states the trust it had when it was made');
});

test('registration matches on key material, never on the id it claims', async () => {
  /*
   * `key_id` is derived from the public key and carries no authority. If
   * trust were looked up by id, a caller could present a registered id
   * alongside a different key and be reported as provenance.
   */
  const { s, org } = await svc();
  const real = await generateKey();
  const impostor = await generateKey();
  await s.registerIssuerKey(org, real.publicKeySpkiBase64, 'the real one');

  // Sign with the impostor's key while claiming the registered key's id.
  const resigned = await signStatement(
    { ...impostor, keyId: real.keyId }, { documentSha256: docDigest });
  assert.equal(resigned.issuer.key_id, real.keyId);

  const att = await s.issueSigned(org, resigned);
  assert.equal(att.issuer_trust, 'unregistered',
    'claiming a registered id with another key must not be reported as provenance');
});

test('one org cannot borrow a key another org registered', async () => {
  const { s, org } = await svc();
  const other = await s.ensureOrg('other', 'Other');
  const key = await generateKey();
  await s.registerIssuerKey(other, key.publicKeySpkiBase64, 'theirs');

  const att = await s.issueSigned(org, await signStatement(key, { documentSha256: docDigest }));
  assert.equal(att.issuer_trust, 'unregistered', 'registration is per organisation');
});

test('unsigned anchoring is untouched and records no trust at all', async () => {
  const { s, org } = await svc();
  const att = await s.issue(org, docDigest, 'application/pdf');
  assert.equal(att.leaf_bytes, docDigest);
  assert.equal(att.statement, null);
  assert.equal(att.issuer_trust, null,
    'an unsigned record must not carry a trust value, not even a negative one');
});

test('the service has no way to produce an issuer signature', () => {
  // The product claim is that we cannot sign as the customer. The narrow,
  // checkable version: nothing in the service imports a signing primitive or
  // generates a keypair.
  const src = ['service.ts', 'http/routes.ts', 'http/console.ts']
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /generateKey|subtle\.sign|privateKey|pkcs8/i,
    'the service must have no signing capability for issuer statements');
});
