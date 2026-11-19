/**
 * "One message, one settlement", as the reference's real store answers it on MySQL — the rule the Java store has to
 * reproduce row for row (`apps/core/src/remit/store.ts`: createFromMessage, sourceConflict).
 *
 *   node apps/core-java/tools/make-remit-b1-store-vectors.mjs [<reference env file>]          write src/test/resources/vectors/remit-b1-store.json
 *   node apps/core-java/tools/make-remit-b1-store-vectors.mjs [<reference env file>] --check  fail when the file on disk differs
 *
 * Each sequence is a list of instructions handed to `RemitStore.createFromMessage` one after the other, on an
 * organisation of its own: what each step came to (accepted / the id is taken / the conflict with its ground), and
 * the rows the sequence left in `remit_source_refs` and `remit_source_matches` — including the recognitions and
 * inherited UETRs written by steps that were refused. The sequences are those of the reference's own tests
 * (apps/core/test/remit.test.ts, mysql-parity.test.ts), the example of the hand-over memo (docs/REMIT-HANDOVER.md 1.1),
 * and sequences drawn from a fixed seed over a small alphabet of files, positions, UETRs, identifiers, days and contents.
 *
 * It runs on the reference's own test schema — the one `STONEHASH_DB_URL` of the env file names (default
 * `.env.ref`, `stonehash_test_coreref`) — under organisations and payment ids of its own (`b1seq-…`, `B1SEQ-…`),
 * which it removes before it starts and when it is done. It refuses any schema that is not `stonehash_test_…`, and
 * refuses to run while the comparison's reference server is up on that schema (a comparison run seeds and clears
 * the schema; the two must not overlap).
 *
 * The clock is the tool's: it moves one millisecond every time the reference reads it, so every row has a time of
 * its own and the same one on every run (rule 4 orders twins by `created_at`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { problems, readEnvFile } from './check-test-env.mjs';
import { openDb } from '../../core/src/db.ts';
import { RemitStore, sourceRefOf } from '../../core/src/remit/store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/remit-b1-store.json');
const args = process.argv.slice(2);
const check = args.includes('--check');
const envFile = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.resolve(HERE, '../.env.ref'));
if (path.dirname(envFile) !== path.resolve(HERE, '..') || !path.basename(envFile).startsWith('.env.')) { console.error('not a settings file of this module (apps/core-java/.env.*)'); process.exit(1); }
const env = readEnvFile(envFile);
const unsafe = problems(env);
if (unsafe.length) { for (const p of unsafe) console.error(`${path.basename(envFile)}: ${p}`); process.exit(1); }
const schema = new URL(env.STONEHASH_DB_URL).pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) { console.error(`refusing: ${schema} is not a stonehash_test_ schema`); process.exit(1); }
const listening = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: Number(port) });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (await listening(env.PORT)) { console.error(`refusing: a server is listening on :${env.PORT} — a comparison run is using ${schema}`); process.exit(1); }

const RealDate = Date;
let clock = RealDate.parse('2026-11-19T04:00:00.000Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(clock++); else super(...a); }
  static now() { return clock++; }
};

// ── the sequences ───────────────────────────────────────────────────────────────────────────────────────────────
const sha = (label) => createHash('sha256').update(`file:${label}`).digest('hex');
const U = ['b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f', '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f'];
const base = (over = {}) => ({ type: 'MT103', sha256: 'ab'.repeat(32), uetr: U[0], messageId: 'A1', instructionId: 'A1', valueDate: '2026-11-17', content: 'cd'.repeat(32), ...over });
const instalment = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'BATCH-1', endToEndId: 'RENT', content: 'aa'.repeat(32) };
const plain = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, endToEndId: 'NOTPROVIDED', messageId: 'FILE-7', content: 'cc'.repeat(32) };
const undated = { uetr: undefined, instructionId: 'C3', messageId: 'C3', valueDate: undefined, content: 'dd'.repeat(32) };
const anonymous = { uetr: undefined, instructionId: undefined, messageId: undefined };
const h = { instructionId: 'H1', messageId: 'H1', content: '10'.repeat(32) };
const inBatch = { type: 'pain.001.001.09', uetr: undefined, instructionId: 'INS-7', messageId: 'BATCH-2', content: 'bb'.repeat(32) };
const two = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'F', endToEndId: 'SAME', valueDate: '2026-11-17', content: 'f0'.repeat(32) };
const named = [
  ['the rules of one message, one settlement (remit.test.ts)', [
    ['PAY-1', {}], ['PAY-2', {}], ['PAY-2b', { content: 'e0'.repeat(32) }], ['PAY-2c', { sha256: sha('again') }],
    ['PAY-3', { sha256: sha('other amount'), content: 'ee'.repeat(32) }], ['PAY-3b', { index: 1 }], ['PAY-4', { sha256: sha('stripped'), uetr: undefined }],
    ['PAY-5', { sha256: sha('own uetr'), uetr: U[1] }], ['PAY-6', { sha256: sha('next day'), uetr: undefined, valueDate: '2026-11-18' }],
    ['PAY-1', { sha256: sha('new'), uetr: U[2], instructionId: 'F6' }], ['PAY-24', { sha256: sha('new'), uetr: U[2], instructionId: 'F6' }],
    ['PAY-18', { ...anonymous, sha256: sha('anon 1') }], ['PAY-19', { ...anonymous, sha256: sha('anon 2') }]]],
  ['a twin is matched one to one (remit.test.ts)', [
    ['PAY-H', { ...h, sha256: sha('H bare'), uetr: undefined }], ['PAY-W1', { ...h, sha256: sha('H with U1'), uetr: U[0] }], ['PAY-W2', { ...h, sha256: sha('H with U2'), uetr: U[1] }],
    ['PAY-W1b', { ...h, sha256: sha('H with U1'), uetr: U[0] }], ['PAY-W1c', { ...h, sha256: sha('H with U1, again'), uetr: U[0] }], ['PAY-W3', { ...h, sha256: sha('H bare, later'), uetr: undefined }],
    ['PAY-F0', { ...instalment, sha256: sha('F'), index: 0 }], ['PAY-X0', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 0 }],
    ['PAY-F1R', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 1 }], ['PAY-X1', { ...instalment, sha256: sha('F'), index: 1 }],
    ['PAY-X0b', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 0 }], ['PAY-X1b', { ...instalment, sha256: sha('F'), index: 1 }],
    ['PAY-Y1', { ...instalment, sha256: sha('F third'), index: 1 }], ['PAY-Y0', { ...instalment, sha256: sha('F third'), index: 0 }],
    ['PAY-B7', { ...inBatch, sha256: sha('batch 2'), index: 6 }], ['PAY-B7x', { ...inBatch, messageId: 'SINGLE-9', sha256: sha('alone'), index: 0 }],
    ['PAY-N0', { ...plain, sha256: sha('file 7') }], ['PAY-N0x', { ...plain, sha256: sha('file 7, new creation time') }],
    ['BANK-RETRY-2', { ...plain, sha256: sha('file 7, third time'), endToEndId: undefined }], ['PAY-N1', { ...plain, sha256: sha('file 7'), index: 1 }],
    ['PAY-N8', { ...plain, sha256: sha('file 8'), messageId: 'FILE-8' }],
    ['PAY-16', { ...undated, sha256: sha('undated') }], ['PAY-17', { ...undated, sha256: sha('undated again') }], ['PAY-17', { ...undated, sha256: sha('undated again') }],
    ['PAY-17b', { ...undated, sha256: sha('undated') }]]],
  ['the rules as the MySQL test of the reference states them (mysql-parity.test.ts)', [
    ['PAY-SRC-1', { sha256: sha('base') }], ['PAY-SRC-2', { sha256: sha('base') }], ['PAY-SRC-3', { sha256: sha('other amount'), content: 'ee'.repeat(32) }],
    ['PAY-SRC-4', { sha256: sha('stripped'), uetr: undefined }], ['PAY-SRC-4', { sha256: sha('stripped'), uetr: undefined }], ['PAY-SRC-5', { sha256: sha('own uetr'), uetr: U[1] }],
    ['PAY-SRC-1', { sha256: sha('new'), uetr: undefined, instructionId: 'Z9' }],
    ['PAY-F0', { ...instalment, sha256: sha('F'), index: 0 }], ['PAY-X0', { ...instalment, sha256: sha('F again'), index: 0 }], ['PAY-F1R', { ...instalment, sha256: sha('F again'), index: 1 }],
    ['PAY-X1', { ...instalment, sha256: sha('F'), index: 1 }],
    ['PAY-H', { ...h, sha256: sha('H bare'), uetr: undefined }], ['PAY-W1', { ...h, sha256: sha('H with U1'), uetr: U[2] }], ['PAY-W2', { ...h, sha256: sha('H with U2'), uetr: '11111111-2222-4333-8444-555555555555' }],
    ['PAY-N0', { ...plain, sha256: sha('file 7') }], ['PAY-N0x', { ...plain, sha256: sha('file 7 again') }],
    ['PAY-U0', { uetr: undefined, instructionId: 'C3', valueDate: undefined, content: 'dd'.repeat(32), sha256: sha('undated') }],
    ['PAY-U1', { uetr: undefined, instructionId: 'C3', valueDate: undefined, content: 'dd'.repeat(32), sha256: sha('undated again') }]]],
  ['two like transactions of one file, written out again, the second with a UETR (docs/REMIT-HANDOVER.md 1.1)', [
    ['PAY-F0', { ...two, sha256: sha('F'), index: 0 }], ['PAY-F1', { ...two, sha256: sha('F'), index: 1 }],
    ['PAY-G0', { ...two, messageId: 'F-again', sha256: sha('F prime'), index: 0 }], ['PAY-G1', { ...two, messageId: 'F-again', sha256: sha('F prime'), index: 1, uetr: U[1] }],
    ['PAY-G1b', { ...two, messageId: 'F-third', sha256: sha('F third'), index: 1, uetr: U[1] }], ['PAY-G2', { ...two, messageId: 'F-third', sha256: sha('F third'), index: 0, uetr: U[2] }]]],
  ['letter case and white space tell nothing apart', [
    ['PAY-C1', { sha256: sha('case') }], ['PAY-C2', { sha256: sha('case').toUpperCase() }], ['PAY-C3', { sha256: sha('case 2'), uetr: U[0].toUpperCase() }],
    ['PAY-C4', { sha256: sha('case 3'), uetr: undefined, instructionId: ' A1 ', content: 'CD'.repeat(32) }], ['PAY-C5', { sha256: sha('case 4'), uetr: undefined, endToEndId: 'nonref' }],
    ['PAY-C6', { sha256: sha('case 5'), uetr: undefined, instructionId: 'a1' }]]],
];

// Drawn sequences: a small alphabet, so that the steps run into each other in every way the four rules know.
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const random = mulberry32(20261119);
const pick = (list) => list[Math.floor(random() * list.length)];
const drawn = [];
for (let n = 0; n < 90; n++) {
  const steps = [];
  const count = 8 + Math.floor(random() * 7);
  for (let i = 0; i < count; i++) {
    const ids = pick(['both', 'instruction', 'e2e', 'message', 'none', 'both']);
    const source = {
      type: pick(['MT103', 'pacs.008.001.08']), sha256: sha(`drawn ${pick(['a', 'b', 'c'])}`), index: pick([0, 0, 1, 2]),
      uetr: pick([undefined, undefined, U[0], U[1], U[2]]), valueDate: pick(['2026-11-17', '2026-11-17', '2026-11-18', undefined]), content: pick(['c1'.repeat(32), 'c1'.repeat(32), 'c2'.repeat(32), undefined]),
      messageId: ids === 'none' ? undefined : pick(['M1', 'M2']),
      instructionId: ids === 'both' || ids === 'instruction' ? pick(['I1', 'I2']) : undefined,
      endToEndId: ids === 'both' || ids === 'e2e' ? pick(['E1', 'NOTPROVIDED']) : undefined,
    };
    steps.push([random() < 0.08 && i > 0 ? `PAY-${Math.floor(random() * i)}` : `PAY-${i}`, source]);
  }
  drawn.push([`drawn ${n}`, steps]);
}

// ── run them on the reference's store ───────────────────────────────────────────────────────────────────────────
const db = await openDb(env.STONEHASH_DB_URL);
const clean = async () => {
  await db.prepare("DELETE FROM remit_source_matches WHERE org_id LIKE 'b1seq-%'").run();
  await db.prepare("DELETE FROM remit_source_refs WHERE org_id LIKE 'b1seq-%'").run();
  await db.prepare("DELETE FROM remit_events WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id LIKE 'b1seq-%')").run();
  await db.prepare("DELETE FROM remit_payments WHERE org_id LIKE 'b1seq-%'").run();
  await db.prepare("DELETE FROM remit_quotes WHERE org_id LIKE 'b1seq-%'").run();
  await db.prepare("DELETE FROM orgs WHERE id LIKE 'b1seq-%'").run();
};
const sequences = [];
let ledgerVectors = null;
try {
  await clean();
  const store = new RemitStore(db);
  let k = 0;
  for (const [name, steps] of [...named, ...drawn]) {
    const n = String(k++).padStart(3, '0');
    const org = `b1seq-${n}`;
    const prefix = `B1SEQ-${n}-`;
    await db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?,?,?,?)').run(org, org, `B1 sequence ${n}`, '2026-01-01T00:00:00.000Z');
    await store.saveQuote(org, `QT-${prefix}`, 'VN', 'SG', {}, {}, '2099-01-01T00:00:00.000Z');
    const out = { name, org, prefix, steps: [] };
    for (const [id, source] of steps) {
      const sourceJson = JSON.stringify(name.startsWith('drawn') || name.startsWith('two like') ? source : base(source));
      const payment = { id: `${prefix}${id}`, org_id: org, quote_id: `QT-${prefix}`, corridor_origin: 'VN', corridor_destination: 'SG', trade_currency: 'USD', trade_amount: '10.00',
        collect_currency: 'VND', collect_amount: '1', usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35', beneficiary_institution: 'SG-BFI-001', request_body: '{}' };
      const made = await store.createFromMessage(payment, sourceRefOf(JSON.parse(sourceJson)));
      const step = { id: payment.id, sourceJson };
      if ('conflict' in made) step.conflict = made.conflict;
      else if ('idTaken' in made) step.idTaken = true;
      else { step.accepted = true; step.createdAt = made.payment.created_at; }
      out.steps.push(step);
    }
    out.refs = await db.prepare('SELECT payment_id, message_type, sha256, idx, uetr, value_date, content, twin_key FROM remit_source_refs WHERE org_id = ? ORDER BY payment_id').all(org);
    out.matches = await db.prepare('SELECT sha256, idx, payment_id FROM remit_source_matches WHERE org_id = ? ORDER BY sha256, idx').all(org);
    sequences.push(out);
  }

  // ── the ledger: search, exact lookups, paging — MySQL's own answers ─────────────────────────────────────────
  // The statement that searches the bank's references inside event payloads is MySQL's (JSON_EXTRACT), so what it
  // finds is recorded from MySQL: the field as JSON text, quotes and escapes included.
  const org = 'b1seq-search';
  await db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?,?,?,?)').run(org, org, 'B1 ledger', '2026-01-01T00:00:00.000Z');
  for (const q of ['QT-B1SEQ-S-ALPHA', 'QT-B1SEQ-S-beta']) await store.saveQuote(org, q, 'VN', 'SG', {}, {}, '2099-01-01T00:00:00.000Z');
  const pay = (id, quote) => ({ id, org_id: org, quote_id: quote, corridor_origin: 'VN', corridor_destination: 'SG', trade_currency: 'USD', trade_amount: '10.00',
    collect_currency: 'VND', collect_amount: '1', usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35', beneficiary_institution: 'SG-BFI-001', request_body: '{}' });
  const ledger = [
    // id, quote, state, chain_tx, created_at, events: [type, payload]
    ['B1SEQ-S-01', 'QT-B1SEQ-S-ALPHA', 'BANK_AUTHORIZED', null, '2026-11-10T01:00:00.000Z', [['BANK_EVIDENCE_SUBMITTED', { bankInstruction: { ref: 'B1SEQ-S-01', sourceMessage: { type: 'MT103', uetr: 'B4D9E7A1-5C36-4F82-A1D0-6E9F3C2B8A57', instructionId: 'INSTR-Alpha/7', endToEndId: 'E2E 100%', messageId: 'MSG_one' } }, bankApproval: { approvalRef: 'APPR-2026-0001' }, commercialDocs: { invoiceRef: 'INV-NOT-SEARCHED' } }],
      ['BANK_AUTHORIZATION_VERIFIED', { payment_id: 'B1SEQ-S-01', bank_authorization: { instruction_ref: 'AUTH!ref' } }]]],
    ['B1SEQ-S-02', 'QT-B1SEQ-S-ALPHA', 'EVIDENCE_ANCHORED', '0xABCDEF0123', '2026-11-10T01:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-02', bank_reference: 'FAST-20261110-0001', evidence_level: 'L3' }]]],
    ['B1SEQ-S-03', 'QT-B1SEQ-S-beta', 'EVIDENCE_ANCHORED', '0xabc', '2026-11-11T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-03', bank_reference: 'ref "quoted" back\\slash' }], ['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-03', bank_reference: 'second-completion' }]]],
    ['B1SEQ-S-04', 'QT-B1SEQ-S-beta', 'CANCELLED', null, '2026-11-12T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-04', bank_reference: 12345 }]]],
    ['B1SEQ-S-05', 'QT-B1SEQ-S-beta', 'EXCEPTION', null, '2026-11-12T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-05', bank_reference: null }], ['EXCEPTION', { payment_id: 'B1SEQ-S-05', error: 'FAST-20261110-0001 is quoted here and is not searched' }]]],
    ['B1SEQ-S-06', 'QT-B1SEQ-S-beta', 'PAYOUT_IN_PROGRESS', null, '2026-11-13T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-06', bank_reference: true }]]],
    ['B1SEQ-S-07', 'QT-B1SEQ-S-beta', 'PAYOUT_IN_PROGRESS', null, '2026-11-13T00:00:00.001Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-07', bank_reference: { branch: 'HANOI', n: 1 } }]]],
    ['B1SEQ-S-08', 'QT-B1SEQ-S-beta', 'RETURNED', null, '2026-11-14T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-08', bank_reference: ['list', 'of', 'two'] }]]],
    ['B1SEQ-S-09', 'QT-B1SEQ-S-beta', 'REQUEST_ACCEPTED', null, '2026-11-15T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-09', bank_reference: 'straße-ǆ' }]]],
    ['B1SEQ-S-10', 'QT-B1SEQ-S-beta', 'TRAVEL_RULE_PENDING', null, '2026-11-15T00:00:00.000Z', [['PAYOUT_COMPLETED', { payment_id: 'B1SEQ-S-10', bank_reference: 'line\nbreak\ttab' }]]],
    ['B1SEQ_S-11', 'QT-B1SEQ-S-beta', 'TRAVEL_RULE_PENDING', null, '2026-11-16T00:00:00.000Z', [['BANK_EVIDENCE_SUBMITTED', { bankInstruction: { sourceMessage: { messageId: '한글-메시지', endToEndId: 'NOTPROVIDED' } }, bankApproval: {} }]]],
    ['B1SEQ-S-12', 'QT-B1SEQ-S-beta', 'PAYOUT_PRE_APPROVED', null, '2026-11-17T00:00:00.000Z', []],
  ];
  for (const [id, quote, state, chainTx, at, events] of ledger) {
    await store.create(pay(id, quote));
    for (const [type, payload] of events) await store.appendEvent(id, type, 'B1', payload);
    await db.prepare('UPDATE remit_payments SET state = ?, chain_tx = ?, created_at = ?, updated_at = ? WHERE id = ?').run(state, chainTx, at, at, id);
  }
  // Two of them were made from a message: the exact lookups read the reference rows.
  const refRow = async (id, m) => { const r = sourceRefOf(m); await db.prepare('INSERT INTO remit_source_refs (payment_id, org_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, org, r.messageType, r.sha256, r.index, r.uetr, r.valueDate, r.content, r.twinKey, '2026-11-10T01:00:00.000Z'); };
  await refRow('B1SEQ-S-01', { type: 'MT103', sha256: sha('ledger 1'), uetr: U[0], valueDate: '2026-11-17', content: 'cd'.repeat(32), instructionId: 'L1' });
  await refRow('B1SEQ-S-02', { type: 'MT103', sha256: sha('ledger 2'), uetr: U[1], valueDate: '2026-11-18', content: 'cd'.repeat(32), instructionId: 'L2' });
  const searchRows = {
    payments: await db.prepare('SELECT id, quote_id, state, chain_tx, created_at FROM remit_payments WHERE org_id = ? ORDER BY id').all(org),
    events: await db.prepare("SELECT payment_id, seq, type, issuer, payload FROM remit_events WHERE payment_id LIKE 'B1SEQ%S-%' ORDER BY payment_id, seq").all(),
    refs: await db.prepare('SELECT payment_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at FROM remit_source_refs WHERE org_id = ? ORDER BY payment_id').all(org),
  };
  const needles = ['b1seq-s-0', 'B1SEQ_S', 'b1seq-s', '_', '%', '!', 'qt-b1seq-s-alpha', 'BETA', '0xabc', 'ABCDEF', 'fast-2026', 'FAST-20261110-0001', '0001', 'quoted', '"quoted"', '\\"quoted', 'back\\slash', 'back\\\\slash',
    'second-completion', '12345', '234', 'null', 'nul', 'true', 'ru', 'HANOI', 'branch', '"branch": "HANOI"', 'list', '"of"', 'straße', 'STRASSE', 'strasse', 'ǆ', 'Ǆ', 'ǅ', 'line', 'break', '\\n', 'line\nbreak', 'tab',
    'b4d9e7a1', 'B4D9E7A1-5C36', 'instr-alpha', 'alpha/7', 'e2e 100%', '100%', 'msg_one', 'MSG-ONE', 'appr-2026', 'INV-NOT', 'auth!ref', 'AUTH', '한글', '메시지', 'NOTPROVIDED', 'payment_id', 'bank_reference', '"', '-', 'é', 'no such thing'];
  const searches = [];
  const ask = async (params) => {
    try {
      const page = await store.search(org, params);
      return { params, answer: { ids: page.items.map((p) => p.id), total: page.total, nextCursor: page.nextCursor } };
    } catch (e) { return { params, refused: { status: e.status, error: e.code, message: e.message, name: e.constructor.name } }; }
  };
  for (const q of needles) searches.push(await ask({ q, limit: 100 }));
  for (const state of ['EVIDENCE_ANCHORED', 'PAYOUT_IN_PROGRESS,RETURNED', ' CANCELLED , EXCEPTION ,', 'CANCELLED,,EXCEPTION', 'PAID', 'EVIDENCE_ANCHORED,PAID', 'evidence_anchored', 'REQUEST_ACCEPTED']) searches.push(await ask({ state, limit: 100 }));
  for (const [from, to] of [['2026-11-12T00:00:00.000Z', undefined], [undefined, '2026-11-12T00:00:00.000Z'], ['2026-11-11', '2026-11-13'], ['2026-11-13T00:00:00.001Z', '2026-11-13T00:00:00.001Z'], ['2027', undefined], [undefined, '2026-11-12']]) {
    searches.push(await ask({ ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 100 }));
  }
  for (const lookup of [{ sourceUetr: U[0] }, { sourceUetr: U[0].toUpperCase() }, { sourceUetr: U[2] }, { sourceContent: 'cd'.repeat(32) }, { sourceContent: 'CD'.repeat(32) }, { sourceContent: 'cd'.repeat(32), sourceValueDate: '2026-11-18' },
    { sourceContent: 'cd'.repeat(32), sourceValueDate: '2026-11-19' }, { sourceUetr: U[0], sourceContent: 'cd'.repeat(32) }, { sourceUetr: U[1], sourceContent: 'cd'.repeat(32), sourceValueDate: '2026-11-17' },
    { sourceContent: 'cd'.repeat(32), state: 'EVIDENCE_ANCHORED' }, { sourceUetr: U[0], q: 'no such thing' }]) searches.push(await ask({ ...lookup, limit: 100 }));
  searches.push(await ask({ q: 'b1seq', state: 'EVIDENCE_ANCHORED,PAYOUT_IN_PROGRESS', from: '2026-11-10T01:00:00.000Z', to: '2026-11-13T00:00:00.000Z', limit: 100 }));
  for (const limit of [1, 5, 100, 0, 1000]) {
    let cursor;
    for (let n = 0; n < 20; n++) {
      const page = await ask({ limit, ...(cursor ? { cursor } : {}) });
      searches.push(page);
      cursor = page.answer?.nextCursor;
      if (!cursor) break;
    }
  }
  searches.push(await ask({ limit: 3, state: 'EVIDENCE_ANCHORED,PAYOUT_IN_PROGRESS,TRAVEL_RULE_PENDING' }));
  searches.push(await ask({ cursor: 'not-a-cursor', limit: 5 }));
  searches.push(await ask({ cursor: 'not-a-cursor', state: 'PAID', limit: 5 }));
  ledgerVectors = { org, rows: searchRows, searches };
} finally {
  await clean();
  await db.close();
}

const count = (f) => sequences.reduce((n, s) => n + s.steps.filter(f).length, 0);
const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-remit-b1-store-vectors.mjs from apps/core/src/remit/store.ts, run on MySQL. Do not edit by hand.',
  sequences, ledger: ledgerVectors,
}, null, 1)}\n`;
const summary = `${sequences.length} sequences, ${count(() => true)} steps: ${count((s) => s.accepted)} accepted, ${count((s) => s.idTaken)} with the id taken, `
  + `${count((s) => s.conflict?.ground === 'message')} the same message, ${count((s) => s.conflict?.ground === 'uetr' && !s.conflict.reused)} the same UETR, ${count((s) => s.conflict?.reused)} a UETR reused, `
  + `${count((s) => s.conflict?.ground === 'twin' && !s.conflict.undated)} twins, ${count((s) => s.conflict?.undated)} twins without a date; `
  + `${sequences.reduce((n, s) => n + s.matches.length, 0)} recognitions; the ledger: ${ledgerVectors.rows.payments.length} settlements, ${ledgerVectors.searches.length} searches `
  + `(${ledgerVectors.searches.filter((x) => x.refused).length} refused)`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) { console.error('remit-b1-store.json differs from what the reference answers now — run without --check and review the change'); process.exit(1); }
  console.log(`remit-b1-store.json is current (${summary})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${summary}`);
}
