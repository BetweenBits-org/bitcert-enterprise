/**
 * The MySQL engine, against a real server.
 *
 * Every other test runs on the SQLite engine because it needs no setup; this
 * one proves the MySQL adapter executes the same SQL with the same results —
 * schema bootstrap, CRUD, transactions that roll back, the REPLACE upsert,
 * keyset-paged search, and the rowseq hygiene rule (never visible in a row).
 *
 * Needs `STONEHASH_TEST_MYSQL_URL` (server URL without a fixed database;
 * the test creates and drops its own `stonehash_test_*` schema). Without it
 * the test states that it skipped rather than silently passing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { openDb } from '../src/db.ts';
import { RemitStore, sourceRefOf } from '../src/remit/store.ts';

const SERVER = process.env['STONEHASH_TEST_MYSQL_URL'] ?? '';

test('mysql adapter parity', { skip: SERVER === '' ? 'STONEHASH_TEST_MYSQL_URL not set — MySQL parity not exercised' : false }, async (t) => {
  const u = new URL(SERVER);
  const schema = `stonehash_test_${randomUUID().slice(0, 8)}`;
  const admin = await createConnection({
    host: u.hostname, port: Number(u.port || 3306),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  });
  await admin.query(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const db = await openDb(`mysql://${u.username}:${u.password}@${u.hostname}:${u.port || 3306}/${schema}`);

  try {
    assert.equal(db.dialect, 'mysql');

    await t.test('bootstrap created all tables', async () => {
      const rows = await db.prepare(
        'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?').all(schema);
      const names = new Set((rows as { t: string }[]).map((r) => r.t));
      for (const required of ['orgs', 'attestations', 'remit_payments', 'por_snapshots', 'remit_manifests']) {
        assert.ok(names.has(required), `missing table ${required}`);
      }
    });

    await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1','o1','Org','2026-01-01T00:00:00Z')").run();

    await t.test('rowseq exists for ordering but never leaks into a row', async () => {
      await db.prepare(
        `INSERT INTO attestations (id, org_id, leaf_bytes, descriptor, status, created_at)
         VALUES ('a1', 'o1', ?, '{}', 'accepted', '2026-01-01T00:00:00Z')`).run('a'.repeat(64));
      const row = await db.prepare('SELECT * FROM attestations WHERE id = ?').get('a1') as Record<string, unknown>;
      assert.equal(row.leaf_bytes, 'a'.repeat(64));
      assert.ok(!('rowseq' in row), 'rowseq is engine plumbing and must not cross the adapter');
      const ord = await db.prepare(
        'SELECT id FROM attestations ORDER BY created_at ASC, rowseq ASC LIMIT 1').get() as { id: string };
      assert.equal(ord.id, 'a1');
    });

    await t.test('transaction rolls back atomically', async () => {
      await assert.rejects(db.tx(async (tx) => {
        await tx.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o2','o2','X','2026-01-01T00:00:00Z')").run();
        throw new Error('boom');
      }), /boom/);
      assert.equal(await db.prepare("SELECT id FROM orgs WHERE id = 'o2'").get(), undefined);
    });

    await t.test('REPLACE INTO upserts the idempotency row', async () => {
      const store = new RemitStore(db);
      await store.idempotencyStore('o1', 'k1', 'h1', 202, { a: 1 });
      await store.idempotencyStore('o1', 'k1', 'h1', 202, { a: 2 });
      const hit = await store.idempotencyHit('o1', 'k1');
      assert.equal(JSON.parse(hit!.response_body).a, 2);
    });

    await t.test('keyset search pages without gaps or repeats', async () => {
      const store = new RemitStore(db);
      await db.prepare(
        `INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at)
         VALUES ('Q1','o1','VN','SG','{}','{}','2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run();
      for (let i = 0; i < 7; i++) {
        await store.create({
          id: `PAY-PAR-${String(i).padStart(2, '0')}`, org_id: 'o1', quote_id: 'Q1',
          corridor_origin: 'VN', corridor_destination: 'SG',
          trade_currency: 'USD', trade_amount: '10.00',
          collect_currency: 'VND', collect_amount: '1',
          usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35',
          beneficiary_institution: 'SG-BFI-001', request_body: '{}',
        });
      }
      const page1 = await store.search('o1', { limit: 3 });
      assert.equal(page1.total, 7);
      assert.equal(page1.items.length, 3);
      assert.ok(page1.nextCursor);
      const page2 = await store.search('o1', { limit: 3, cursor: page1.nextCursor! });
      const page3 = await store.search('o1', { limit: 3, cursor: page2.nextCursor! });
      const all = [...page1.items, ...page2.items, ...page3.items].map((p) => p.id);
      assert.equal(new Set(all).size, 7, 'no repeats across pages');
      assert.equal(page3.nextCursor, null, 'the last page says so');
      const filtered = await store.search('o1', { q: 'par-03' });
      assert.deepEqual(filtered.items.map((p) => p.id), ['PAY-PAR-03'], 'case-insensitive id search');
      // The other identifiers an operator is handed find the same row: the
      // USDC transaction hash and the bank's reference on the payout.
      await store.patch('PAY-PAR-02', { chain_tx: '0xABCDEF0123' });
      await store.appendEvent('PAY-PAR-04', 'PAYOUT_COMPLETED', 'SG-BFI-001',
        { payment_id: 'PAY-PAR-04', bank_reference: 'FAST-7788' }, null);
      assert.deepEqual((await store.search('o1', { q: 'cdef01' })).items.map((p) => p.id), ['PAY-PAR-02'], 'by tx hash');
      assert.deepEqual((await store.search('o1', { q: 'fast-7788' })).items.map((p) => p.id), ['PAY-PAR-04'], 'by bank reference');
      // The bank's own references, signed into its instruction: the SWIFT
      // message's UETR and instruction id, and its approval reference.
      await store.appendEvent('PAY-PAR-05', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', {
        bankInstruction: { sourceMessage: { uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', instructionId: 'OUT-2026-000123' } },
        bankApproval: { approvalRef: 'APPR-PAR-05' },
      }, null);
      await store.appendEvent('PAY-PAR-06', 'BANK_AUTHORIZATION_VERIFIED', 'STONEHASH',
        { bank_authorization: { instruction_ref: 'BANK-INST-PAR-06' } }, null);
      assert.deepEqual((await store.search('o1', { q: '3F1C9A52-7b0e' })).items.map((p) => p.id), ['PAY-PAR-05'], 'by UETR');
      assert.deepEqual((await store.search('o1', { q: 'out-2026-000123' })).items.map((p) => p.id), ['PAY-PAR-05'], 'by instruction id');
      assert.deepEqual((await store.search('o1', { q: 'appr-par-05' })).items.map((p) => p.id), ['PAY-PAR-05'], 'by approval reference');
      assert.deepEqual((await store.search('o1', { q: 'bank-inst-par-06' })).items.map((p) => p.id), ['PAY-PAR-06'], 'by instruction reference');
      // The field, not the JSON around it: a key name must not match.
      assert.deepEqual((await store.search('o1', { q: 'payment_id' })).items, [], 'JSON keys are not searchable');
      assert.deepEqual((await store.search('o1', { q: 'sourceMessage' })).items, [], 'nor the keys of the bank instruction');
      const byState = await store.search('o1', { state: 'REQUEST_ACCEPTED', limit: 100 });
      assert.equal(byState.total, 7);
      // Several states at once, and an unknown one in the list is refused.
      assert.equal((await store.search('o1', { state: 'REQUEST_ACCEPTED,CANCELLED', limit: 100 })).total, 7);
      await assert.rejects(store.search('o1', { state: 'REQUEST_ACCEPTED,BOGUS' }), /invalid_state|state must be one of/);
      // LIKE wildcards in the query are literal on both engines.
      await store.create({
        id: 'PAY_PAR_UNDERSCORE', org_id: 'o1', quote_id: 'Q1',
        corridor_origin: 'VN', corridor_destination: 'SG',
        trade_currency: 'USD', trade_amount: '10.00',
        collect_currency: 'VND', collect_amount: '1',
        usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35',
        beneficiary_institution: 'SG-BFI-001', request_body: '{}',
      });
      assert.deepEqual((await store.search('o1', { q: '_par_' })).items.map((p) => p.id), ['PAY_PAR_UNDERSCORE'], 'underscore is literal');
      assert.deepEqual((await store.search('o1', { q: '%' })).items, [], 'percent is literal');
    });

    await t.test('one message is one settlement — also when the requests arrive together', async () => {
      const store = new RemitStore(db);
      const pay = (id: string) => ({
        id, org_id: 'o1', quote_id: 'Q1', corridor_origin: 'VN', corridor_destination: 'SG',
        trade_currency: 'USD', trade_amount: '10.00', collect_currency: 'VND', collect_amount: '1',
        usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35',
        beneficiary_institution: 'SG-BFI-001', request_body: '{}',
      });
      const sha = (label: string): string => createHash('sha256').update(`file:${label}`).digest('hex');
      const message = (over: Record<string, unknown> = {}) => sourceRefOf({
        type: 'MT103', sha256: sha('base'), uetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57',
        messageId: 'A1', instructionId: 'A1', valueDate: '2026-11-17', content: 'cd'.repeat(32), ...over })!;
      const send = async (id: string, over: Record<string, unknown> = {}) => {
        const made = await store.createFromMessage(pay(id), message(over));
        return 'conflict' in made ? made.conflict : 'idTaken' in made ? 'id taken' : null;
      };
      const same = (paymentId: string, ground: string, more: { reused?: boolean; undated?: boolean } = {}) =>
        ({ paymentId, ground, reused: more.reused ?? false, undated: more.undated ?? false });

      // The rules, as on SQLite.
      assert.equal(await send('PAY-SRC-1'), null);
      assert.deepEqual(await send('PAY-SRC-2'), same('PAY-SRC-1', 'message'));
      assert.ok(!(await store.get('PAY-SRC-2')), 'a refused instruction leaves no settlement behind');
      assert.deepEqual(await send('PAY-SRC-3', { sha256: sha('other amount'), content: 'ee'.repeat(32) }), same('PAY-SRC-1', 'uetr', { reused: true }));
      assert.deepEqual(await send('PAY-SRC-4', { sha256: sha('stripped'), uetr: undefined }), same('PAY-SRC-1', 'twin'));
      assert.deepEqual(await send('PAY-SRC-4', { sha256: sha('stripped'), uetr: undefined }), same('PAY-SRC-1', 'twin'), 'the recognition is kept');
      assert.equal(await send('PAY-SRC-5', { sha256: sha('own uetr'), uetr: '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f' }), null);
      assert.equal(await send('PAY-SRC-1', { sha256: sha('new'), uetr: undefined, instructionId: 'Z9' }), 'id taken');
      // Two instalments that read alike: the re-export's second transaction is not the first one again.
      const instalment = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'BATCH-1', endToEndId: 'RENT', content: 'aa'.repeat(32) };
      assert.equal(await send('PAY-F0', { ...instalment, sha256: sha('F'), index: 0 }), null);
      assert.deepEqual(await send('PAY-X0', { ...instalment, sha256: sha('F again'), index: 0 }), same('PAY-F0', 'twin'));
      assert.equal(await send('PAY-F1R', { ...instalment, sha256: sha('F again'), index: 1 }), null);
      assert.deepEqual(await send('PAY-X1', { ...instalment, sha256: sha('F'), index: 1 }), same('PAY-F1R', 'twin'));
      // A settlement without a UETR takes the UETR of the rendering it is recognised in.
      const body = { instructionId: 'H1', messageId: 'H1', content: '10'.repeat(32) };
      assert.equal(await send('PAY-H', { ...body, sha256: sha('H bare'), uetr: undefined }), null);
      assert.deepEqual(await send('PAY-W1', { ...body, sha256: sha('H with U1'), uetr: '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f' }), same('PAY-H', 'twin'));
      assert.equal(await send('PAY-W2', { ...body, sha256: sha('H with U2'), uetr: '11111111-2222-4333-8444-555555555555' }), null);
      assert.deepEqual((await store.search('o1', { sourceUetr: '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f' })).items.map((p) => p.id), ['PAY-H']);
      // A payment known only by its message id; and one without a value date.
      const plain = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, endToEndId: 'NOTPROVIDED', messageId: 'FILE-7', content: 'cc'.repeat(32) };
      assert.equal(await send('PAY-N0', { ...plain, sha256: sha('file 7') }), null);
      assert.deepEqual(await send('PAY-N0x', { ...plain, sha256: sha('file 7 again') }), same('PAY-N0', 'twin'));
      const undated = { uetr: undefined, instructionId: 'C3', valueDate: undefined, content: 'dd'.repeat(32) };
      assert.equal(await send('PAY-U0', { ...undated, sha256: sha('undated') }), null);
      assert.deepEqual(await send('PAY-U1', { ...undated, sha256: sha('undated again') }), same('PAY-U0', 'twin', { undated: true }));

      // A settlement is accepted whole — its opening events and first state with it — or not at all.
      const whole = await store.createFromMessage(pay('PAY-WHOLE'), message({ sha256: sha('whole'), uetr: undefined, instructionId: 'W1' }), async (bound) => {
        await bound.appendEvent('PAY-WHOLE', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { ref: 'PAY-WHOLE' } });
        await bound.transition('PAY-WHOLE', 'BANK_AUTHORIZED');
      });
      assert.equal('payment' in whole && whole.payment.state, 'BANK_AUTHORIZED');
      assert.equal((await store.events('PAY-WHOLE')).length, 1);
      await assert.rejects(store.createFromMessage(pay('PAY-HALF'), message({ sha256: sha('half'), uetr: undefined, instructionId: 'W2' }), async (bound) => {
        await bound.appendEvent('PAY-HALF', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { ref: 'PAY-HALF' } });
        throw new Error('the evidence could not be stored');
      }), /could not be stored/);
      assert.ok(!(await store.get('PAY-HALF')));
      assert.equal(await send('PAY-HALF-2', { sha256: sha('half'), uetr: undefined, instructionId: 'W2' }), null, 'its message is free');

      // Eight requests for one message on eight connections: one settlement.
      const sameUetr = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        send(`PAY-RACE-U${i}`, { sha256: sha('race'), uetr: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', instructionId: 'D4' })));
      assert.equal(sameUetr.filter((c) => c === null).length, 1, 'same UETR');
      // The renderings only the twin rule recognises: one with its UETR, seven with the header blocks cut away.
      const twins = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        send(`PAY-RACE-T${i}`, { sha256: sha(`twin ${i}`), uetr: i === 0 ? 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' : undefined, instructionId: 'E5' })));
      assert.equal(twins.filter((c) => c === null).length, 1, 'twins');
      // Eight renderings of a payment known only by its message id.
      const byMessage = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        send(`PAY-RACE-M${i}`, { ...plain, messageId: 'FILE-9', sha256: sha(`file 9, ${i}`) })));
      assert.equal(byMessage.filter((c) => c === null).length, 1, 'known by its message id');
      // Eight requests under one payment id, each made from another message: one settlement, seven "taken" — none fails.
      const oneId = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        send('PAY-RACE-ID', { sha256: sha(`one id ${i}`), uetr: undefined, instructionId: `I${i}` })));
      assert.deepEqual([oneId.filter((c) => c === null).length, oneId.filter((c) => c === 'id taken').length], [1, 7]);
      const made = await db.prepare(
        "SELECT COUNT(*) AS n FROM remit_payments WHERE id LIKE 'PAY-RACE-%'").get() as { n: number };
      assert.equal(Number(made.n), 4, 'one settlement per message, and none half-made');
      const refs = await db.prepare(
        "SELECT COUNT(*) AS n FROM remit_source_refs WHERE payment_id LIKE 'PAY-RACE-%'").get() as { n: number };
      assert.equal(Number(refs.n), 4, 'a reference exists exactly when its settlement does');
      // Different messages at the same moment do not stand in each other's way.
      const apart = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        send(`PAY-APART-${i}`, { sha256: sha(`apart ${i}`), uetr: undefined, instructionId: `F${i}` })));
      assert.equal(apart.filter((c) => c === null).length, 8);

      // The exact lookups, and the place given to settlements from before the table existed.
      const ids = async (s: Record<string, string>): Promise<string[]> => (await store.search('o1', s)).items.map((p) => p.id);
      assert.deepEqual(await ids({ sourceUetr: 'B4D9E7A1-5C36-4F82-A1D0-6E9F3C2B8A57' }), ['PAY-SRC-1']);
      assert.deepEqual(await ids({ sourceUetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a58' }), []);
      assert.deepEqual((await ids({ sourceContent: 'cd'.repeat(32), sourceValueDate: '2026-11-17' })).includes('PAY-SRC-1'), true);
      assert.deepEqual(await ids({ sourceContent: 'cd'.repeat(32), sourceValueDate: '2026-11-18' }), []);
      await store.create(pay('PAY-OLD-1'));
      await store.appendEvent('PAY-OLD-1', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { sourceMessage: {
        type: 'MT103', sha256: sha('old'), instructionId: 'G7', valueDate: '2026-11-17', content: 'd1'.repeat(32) } } }, null);
      await store.create(pay('PAY-OLD-2'));
      await store.appendEvent('PAY-OLD-2', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { sourceMessage: {
        type: 'MT103', sha256: sha('old'), instructionId: 'G7', valueDate: '2026-11-17', content: 'd1'.repeat(32) } } }, null);
      // PAY-PAR-05 above carries a reference without a type or a digest, but a UETR: it is given its place by that.
      assert.deepEqual(await store.backfillSourceRefs(), { claimed: 2, duplicates: 1, unreadable: 0, failed: 0, failures: [], rekeyed: 0 });
      assert.deepEqual(await ids({ sourceContent: 'd1'.repeat(32) }), ['PAY-OLD-1']);
      assert.deepEqual(await ids({ sourceUetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10' }), ['PAY-PAR-05']);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${schema}`);
    await admin.end();
  }
});
