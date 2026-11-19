/**
 * Remit rail units: the crypto primitives, the quote arithmetic, the state
 * machine, and — the load-bearing one — a full happy-path reconciliation
 * where every element is signed exactly as the partner simulators will sign
 * it. If `gold path reconciles green` fails, demo-partners is being built
 * against a contract the engine will reject; it is the executable spec for
 * the element shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { openDb } from '../src/db.ts';
import { Registry } from '../src/remit/registry.ts';
import { RemitStore, legacySourceRefOf, sourceRefOf } from '../src/remit/store.ts';
import { ServiceError } from '../src/service.ts';
import { concatKdf, encryptJwe, decryptJwe, generateEncryptionKey, jwePrivateKeyFromPem } from '../src/remit/jwe.ts';
import {
  signEvent, verifyEvent, signEvidenceElement, elementDigest,
  spkiFromPublicKey, loadOrCreatePlatformKey, sha256hex,
} from '../src/remit/sign.ts';
import { buildQuote, mulDecimal, addDecimal } from '../src/remit/quotes.ts';
import { reconcilePayment } from '../src/remit/evidence.ts';
import { buildIvms101, missingTravelRuleFields } from '../src/remit/ivms101.ts';
import { fieldsAssertionProblem } from '../src/remit/orchestrator.ts';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import os from 'node:os';
import path from 'node:path';

// ── KDF: the one piece of hand-rolled crypto, pinned to the RFC vector ─────
test('concat KDF reproduces RFC 7518 appendix C', () => {
  const z = Buffer.from([158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132,
    38, 156, 251, 49, 110, 163, 218, 128, 106, 72, 246, 218, 167, 121, 140, 254, 144, 196]);
  const derived = concatKdf(z, 128, 'A128GCM', 'Alice', 'Bob');
  assert.equal(derived.toString('base64url'), 'VqqN6vgjbSBcIijNcacQGg');
});

test('jwe round-trips and rejects tamper', () => {
  const recipient = generateEncryptionKey();
  const plaintext = Buffer.from(JSON.stringify({ msg: 'originator data', n: 1 }), 'utf8');
  const compact = encryptJwe(plaintext, recipient.publicJwk, 'TEST-KID');
  assert.equal(compact.split('.').length, 5);
  assert.equal(compact.split('.')[1], '');
  const opened = decryptJwe(compact, jwePrivateKeyFromPem(recipient.privatePem));
  assert.deepEqual(opened, plaintext);
  const parts = compact.split('.');
  const ct = Buffer.from(parts[3]!, 'base64url');
  ct[0]! ^= 0xff;
  parts[3] = ct.toString('base64url');
  assert.throws(() => decryptJwe(parts.join('.'), jwePrivateKeyFromPem(recipient.privatePem)));
});

test('event signatures verify and bind the payload', () => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = spkiFromPublicKey(createPublicKey(kp.privateKey));
  const payload = { payment_id: 'P-1', amount: '10.00' };
  const sig = signEvent(payload, kp.privateKey, 'K1', 'TESTER');
  assert.equal(verifyEvent(payload, sig, spki), true);
  assert.equal(verifyEvent({ ...payload, amount: '11.00' }, sig, spki), false);
});

test('quote arithmetic is exact fixed-point', () => {
  assert.equal(mulDecimal('10000.00', '25380', 0), '253800000');
  assert.equal(mulDecimal('10000.00', '1.3350', 2), '13350.00');
  assert.equal(addDecimal('10000.00', '25.00', 2), '10025.00');
  const q = buildQuote({
    corridor: { origin: 'VN', destination: 'SG' },
    trade: { currency: 'USD', amount: '10000.00' },
    collect: { currency: 'VND' }, payout: { currency: 'SGD' },
  }, { rates: { usdVnd: '25380', usdSgd: '1.3350' }, feeUsd: '25.00', ttlMs: 600_000, chainLabel: 'eip155:31337' });
  assert.equal(q.settlement.amount, '10000.00');
  assert.equal(q.collect.amount, '254434500'); // (10000+25) × 25380
  assert.equal(q.payout.amount, '13350.00');
});

test('state machine only advances and terminal is final', async () => {
  const db = await openDb(':memory:');
  await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1','o1','O1','2026-01-01')").run();
  const store = new RemitStore(db);
  await seedQuote(store, 'o1', 'Q1');
  const p = await store.create(basePayment('o1', 'PAY-SM-1', 'Q1'));
  await store.transition(p.id, 'BANK_AUTHORIZED');
  await store.transition(p.id, 'TRAVEL_RULE_PENDING');
  await assert.rejects(store.transition(p.id, 'BANK_AUTHORIZED'), /only advance/);
  await store.transition(p.id, 'CANCELLED');
  await assert.rejects(store.transition(p.id, 'PAYOUT_PRE_APPROVED'), /terminal/);
});

test('ivms101 requires the corridor fields and builds both layers', () => {
  assert.ok(missingTravelRuleFields({}).length >= 8);
  const msg = buildIvms101({
    originator: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi, HCMC', registration_number: 'VN-0312345678', account: 'VN-ACC-1' },
    beneficiary: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-9', bank: 'DBS (sim)' },
    purpose_code: 'GOODS_PAYMENT',
  }, {
    paymentId: 'PAY-1', tradeAmount: '10000.00', tradeCurrency: 'USD',
    originatingInstitution: { id: 'VN-BANK-001', name: 'Demo Bank', country: 'VN' },
    beneficiaryInstitution: { id: 'SG-BFI-001', name: 'Triple-A profile BFI', country: 'SG' },
    settlementEntity: { id: 'SETTLE-ENTITY-001', name: 'Settlement Entity' },
    usdcAmount: '10000.00',
  });
  const digest = sha256hex(Buffer.from(jcs(msg as JcsValue)));
  assert.equal(digest.length, 64);
  const layered = msg as { underlyingPayment: unknown; settlementLeg: unknown };
  assert.ok(layered.underlyingPayment && layered.settlementLeg);
});

// ── The executable spec: every element as the partners will emit it ────────

async function seedQuote(store: RemitStore, org: string, id: string): Promise<void> {
  const now = new Date();
  await store.saveQuote(org, id, 'VN', 'SG', {}, {
    quote_id: id,
    corridor: { origin: 'VN', destination: 'SG' },
    trade: { currency: 'USD', amount: '10000.00' },
    settlement: { asset: 'USDC', amount: '10000.00', chain: 'eip155:31337' },
    collect: { currency: 'VND', amount: '254434500', rate: '25380', rate_pair: 'USD/VND' },
    payout: { currency: 'SGD', amount: '13350.00', rate: '1.3350', rate_pair: 'USD/SGD' },
    fees: [{ type: 'platform', currency: 'USD', amount: '25.00' }],
    quoted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 600_000).toISOString(),
    required_travel_rule_fields: [],
  }, new Date(now.getTime() + 600_000).toISOString());
}

function basePayment(org: string, id: string, quoteId: string) {
  return {
    id, org_id: org, quote_id: quoteId,
    corridor_origin: 'VN', corridor_destination: 'SG',
    trade_currency: 'USD', trade_amount: '10000.00',
    collect_currency: 'VND', collect_amount: '254434500',
    usdc_amount: '10000.00',
    payout_currency: 'SGD', payout_amount: '13350.00',
    beneficiary_institution: 'SG-BFI-001',
    request_body: '{}',
  };
}

/** Finish an element the way every issuer must: digest first, then sign. */
function finishElement(core: Record<string, unknown>, key: import('node:crypto').KeyObject,
  keyId: string, issuer: string): Record<string, unknown> {
  const withDigest = { ...core, digest: elementDigest(core) };
  return signEvidenceElement(withDigest, key, keyId, issuer);
}

async function buildGoldPayment(tamper?: (els: Record<string, Record<string, unknown>>) => void) {
  const db = await openDb(':memory:');
  await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1','o1','O1','2026-01-01')").run();
  const registry = new Registry(db);
  const store = new RemitStore(db);

  const mk = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const bankKp = mk(); const bfiKp = mk(); const settleKp = mk();
  await registry.upsert({ id: 'VN-BANK-001', role: 'COLLECTION_BANK', name: 'Demo Bank', country: 'VN',
    org_id: 'o1', signing_spki: spkiFromPublicKey(createPublicKey(bankKp.privateKey)) });
  await registry.upsert({ id: 'SG-BFI-001', role: 'BENEFICIARY_FI', name: 'Triple-A profile BFI (sim)', country: 'SG',
    signing_spki: spkiFromPublicKey(createPublicKey(bfiKp.privateKey)) });
  await registry.upsert({ id: 'SETTLE-ENTITY-001', role: 'SETTLEMENT_ENTITY', name: 'Settlement Entity (sim)',
    signing_spki: spkiFromPublicKey(createPublicKey(settleKp.privateKey)) });

  await seedQuote(store, 'o1', 'Q1');
  const paymentId = `PAY-${randomUUID().slice(0, 8)}`;
  const p = await store.create(basePayment('o1', paymentId, 'Q1'));

  const t0 = Date.now();
  const iso = (ms: number) => new Date(t0 + ms).toISOString();
  const invoiceRef = 'INV-2026-0455';
  const deposit = '0x' + 'ab'.repeat(20);

  const els: Record<string, Record<string, unknown>> = {
    bankInstruction: {
      ref: paymentId, amount: '10000.00', currency: 'USD',
      debtor: 'Vina Trading Co., Ltd.', creditor: 'Pacific Supply Pte Ltd',
      approvedAt: iso(0),
      iso20022Fields: ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf', invoiceRef],
    },
    bankApproval: {
      approvalRef: `APPR-${paymentId}`,
      regulatorReportRef: 'VN-SBV-C27-DEMO',
      approvedByRole: 'FX Compliance Officer',
      approvedAt: iso(0),
      fxQuote: { pair: 'USD/VND', rate: '25380', quotedAt: iso(-60_000), validUntil: iso(600_000) },
    },
    commercialDocs: {
      invoiceRef, amount: '10000.00', currency: 'USD',
      buyer: 'Vina Trading Co., Ltd.', seller: 'Pacific Supply Pte Ltd',
      attached: ['invoice'], citedOnly: [],
    },
    travelRule: {
      protocol: 'IVMS101/JWE',
      ivms101Digest: 'c'.repeat(64),
      originatingVasp: 'SETTLE-ENTITY-001',
      beneficiaryVasp: 'SG-BFI-001',
      approvalStatus: 'APPROVED',
      approvalDigest: 'd'.repeat(64),
      approvedAt: iso(10_000),
      approvedBeneficiaryAddress: deposit,
    },
    chainTransfer: {
      chain: 'eip155:31337', asset: 'USDC', amount: '10000.00', currency: 'USDC',
      fromAddress: '0x' + 'cd'.repeat(20), toAddress: deposit,
      txRef: '0x' + 'ef'.repeat(32), settlementIdMemo: paymentId,
      confirmations: 1, observedAt: iso(20_000),
    },
    payoutReceipt: {
      ref: `${paymentId}/FAST-20261110-0001`, amount: '10000.00', currency: 'USD',
      paidAt: iso(30_000),
      local_amount: '13350.00', local_currency: 'SGD',
      local_rate_pair: 'USD/SGD', local_rate: '1.3350', quote_ref: 'Q1',
      bank_reference: 'FAST-20261110-0001', evidence_level: 'L3',
    },
  };
  tamper?.(els);

  await store.appendEvent(p.id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', {
    bankInstruction: finishElement(els.bankInstruction!, bankKp.privateKey, 'VN-BANK-001', 'Demo Bank'),
    bankApproval: finishElement(els.bankApproval!, bankKp.privateKey, 'VN-BANK-001', 'Demo Bank'),
    commercialDocs: finishElement(els.commercialDocs!, bankKp.privateKey, 'VN-BANK-001', 'Demo Bank'),
  });
  await store.appendEvent(p.id, 'PAYOUT_ACCEPTED', 'SG-BFI-001', {
    payment_id: p.id, deposit_address: deposit,
    travel_rule_element: finishElement(els.travelRule!, bfiKp.privateKey, 'SG-BFI-001', 'Triple-A profile BFI (sim)'),
  });
  await store.appendEvent(p.id, 'USDC_TRANSFER_CONFIRMED', 'SETTLE-ENTITY-001', {
    payment_id: p.id,
    chain_transfer_element: finishElement(els.chainTransfer!, settleKp.privateKey, 'SETTLE-ENTITY-001', 'Settlement Entity (sim)'),
  });
  await store.appendEvent(p.id, 'PAYOUT_COMPLETED', 'SG-BFI-001', {
    payment_id: p.id, bank_reference: 'FAST-20261110-0001', evidence_level: 'L3',
    payout_receipt_element: finishElement(els.payoutReceipt!, bfiKp.privateKey, 'SG-BFI-001', 'Triple-A profile BFI (sim)'),
  });

  return { p: (await store.get(paymentId))!, store, registry };
}

test('gold path reconciles green on all six axes', async () => {
  const { p, store, registry } = await buildGoldPayment();
  const out = await reconcilePayment(p, store, registry, true);
  const states = Object.fromEntries(
    Object.entries(out.verdict.axes).map(([k, v]) => [k, (v as { state: string }).state]));
  assert.deepEqual(states, {
    integrity: 'VALID',
    issuer: 'VALID',
    matching: 'MATCH',
    completeness: 'COMPLETE',
    regulatoryMapping: 'REVIEW_REQUIRED', // SYNTHETIC pins this by rule; gate checks field coverage
    businessFinality: 'DEMO_ONLY',        // sandbox rail is synthetic by declaration
  }, JSON.stringify(out.verdict.findings, null, 2));
  assert.equal(out.pass, true, out.reasons.join(', '));
});

test('a changed amount fails matching and the issuer axis', async () => {
  const { p, store, registry } = await buildGoldPayment((els) => {
    els.payoutReceipt!.amount = '10100.00';
  });
  const out = await reconcilePayment(p, store, registry, true);
  assert.equal(out.pass, false);
  assert.equal(out.verdict.axes.matching.state, 'MISMATCH');
});

test('an institution key that does not convert leaves the keyring, and every other tenant keeps settling', async () => {
  /*
   * One keyring is built from every org's institutions, so one bad row used
   * to throw for all of them — and `reconcilePayment` awaits it, so every
   * tenant's settlements stopped. Two such rows, written as rows from before
   * the doors checked keys would be: the signup placeholder, and a curve the
   * JWK export cannot name.
   */
  const { p, store, registry } = await buildGoldPayment();
  const brainpool = spkiFromPublicKey(generateKeyPairSync('ec', { namedCurve: 'brainpoolP256r1' }).publicKey);
  await registry.upsert({ id: 'KR-BANK-PLACEHOLDER', role: 'COLLECTION_BANK', name: 'Another tenant', org_id: null,
    signing_spki: 'DEMO-PUBLIC-KEY-PLACEHOLDER' });
  await registry.upsert({ id: 'KR-EX-BRAINPOOL', role: 'EXCHANGE', name: 'A third tenant', org_id: null,
    signing_spki: brainpool });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
  try {
    const ring = await registry.keyring();
    assert.deepEqual([...ring.keys()].sort(), ['SETTLE-ENTITY-001', 'SG-BFI-001', 'VN-BANK-001']);
    const out = await reconcilePayment(p, store, registry, true);
    assert.equal(out.pass, true, out.reasons.join(', '));
  } finally {
    console.error = original;
  }
  for (const id of ['KR-BANK-PLACEHOLDER', 'KR-EX-BRAINPOOL']) {
    assert.ok(logged.some((l) => l.includes(id)), `${id} is named for an operator`);
  }
  for (const l of logged) {
    assert.ok(!l.includes('DEMO-PUBLIC-KEY-PLACEHOLDER') && !l.includes(brainpool), 'by id, never by its key material');
  }
});

test('platform key loads once and persists', () => {
  const dir = path.join(os.tmpdir(), `remit-key-${randomUUID()}`);
  const a = loadOrCreatePlatformKey(path.join(dir, 'k.pem'));
  const b = loadOrCreatePlatformKey(path.join(dir, 'k.pem'));
  assert.equal(a.publicSpkiBase64, b.publicSpkiBase64);
  assert.match(a.keyId, /^STONEHASH-SIGN-/);
});

// ── R2: exception-path units ───────────────────────────────────────────────

test('an unsigned (L1) payout receipt fails the issuer axis', async () => {
  const { p, store, registry } = await buildGoldPayment();
  // replace the signed receipt event with an L1-style unsigned one
  const db = (store as unknown as { db: import('../src/db.ts').Db }).db;
  const ev = (await store.eventOfType(p.id, 'PAYOUT_COMPLETED'))!;
  const payload = JSON.parse(ev.payload) as { payout_receipt_element: Record<string, unknown> };
  delete payload.payout_receipt_element.signature;
  payload.payout_receipt_element = {
    ...payload.payout_receipt_element,
    signature: { status: 'ABSENT' },
  };
  await db.prepare('UPDATE remit_events SET payload = ? WHERE id = ?')
    .run(JSON.stringify(payload), ev.id);
  const out = await reconcilePayment((await store.get(p.id))!, store, registry, true);
  assert.equal(out.pass, false);
  assert.equal(out.verdict.axes.issuer.state, 'UNKNOWN_ISSUER');
});

test('terminal RETURNED is reachable from mid-flight and is final', async () => {
  const db = await openDb(':memory:');
  await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1','o1','O1','2026-01-01')").run();
  const store = new RemitStore(db);
  await seedQuote(store, 'o1', 'Q1');
  const p = await store.create(basePayment('o1', 'PAY-RET-1', 'Q1'));
  await store.transition(p.id, 'BANK_AUTHORIZED');
  await store.transition(p.id, 'TRAVEL_RULE_PENDING');
  await store.transition(p.id, 'PAYOUT_PRE_APPROVED');
  await store.transition(p.id, 'ONCHAIN_SETTLED');
  await store.transition(p.id, 'PAYOUT_IN_PROGRESS');
  await store.transition(p.id, 'RETURNED');
  await assert.rejects(store.transition(p.id, 'BENEFICIARY_CREDIT_CONFIRMED'), /terminal/);
});

test('the ledger finds a payment by the references the bank\'s own system printed', async () => {
  const db = await openDb(':memory:');
  await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1','o1','O1','2026-01-01')").run();
  await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o2','o2','O2','2026-01-01')").run();
  const store = new RemitStore(db);
  await seedQuote(store, 'o1', 'Q1');
  await seedQuote(store, 'o2', 'Q2');
  const swift = await store.create(basePayment('o1', 'PAY-REF-SWIFT', 'Q1'));
  const plain = await store.create(basePayment('o1', 'PAY-REF-PLAIN', 'Q1'));
  const other = await store.create(basePayment('o2', 'PAY-REF-OTHER', 'Q2'));

  // What a bank adapter signs into the instruction when it was made from a SWIFT message.
  const sourceMessage = {
    type: 'pacs.008.001.08', sha256: 'ab'.repeat(32),
    messageId: 'DEMOVNVX20261117000123', instructionId: 'OUT-2026-000123',
    endToEndId: 'PO-7781', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10',
  };
  await store.appendEvent(swift.id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', {
    bankInstruction: { ref: swift.id, sourceMessage },
    bankApproval: { approvalRef: 'APPR-7781-A' },
    commercialDocs: { invoiceRef: 'INV-2026-0457' },
  });
  await store.appendEvent(swift.id, 'BANK_AUTHORIZATION_VERIFIED', 'STONEHASH',
    { payment_id: swift.id, bank_authorization: { instruction_ref: 'BANK-INST-000123' } });
  await store.appendEvent(plain.id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001',
    { bankInstruction: { ref: plain.id }, bankApproval: { approvalRef: 'APPR-OTHER' }, commercialDocs: {} });
  // The same UETR under another organisation must stay invisible to this one.
  await store.appendEvent(other.id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-002',
    { bankInstruction: { ref: other.id, sourceMessage }, bankApproval: {}, commercialDocs: {} });

  const ids = async (q: string): Promise<string[]> => (await store.search('o1', { q })).items.map((p) => p.id);
  assert.deepEqual(await ids('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10'), ['PAY-REF-SWIFT'], 'by UETR');
  assert.deepEqual(await ids('3F1C9A52'), ['PAY-REF-SWIFT'], 'case-insensitive, by a part of it');
  assert.deepEqual(await ids('out-2026-000123'), ['PAY-REF-SWIFT'], 'by the message\'s instruction id');
  assert.deepEqual(await ids('PO-7781'), ['PAY-REF-SWIFT'], 'by end-to-end id');
  assert.deepEqual(await ids('DEMOVNVX2026'), ['PAY-REF-SWIFT'], 'by message id');
  assert.deepEqual(await ids('APPR-7781-A'), ['PAY-REF-SWIFT'], 'by the bank\'s approval reference');
  assert.deepEqual(await ids('BANK-INST-000123'), ['PAY-REF-SWIFT'], 'by the authorisation\'s instruction reference');
  assert.deepEqual(await ids('appr-other'), ['PAY-REF-PLAIN']);
  // The fields, not the JSON around them.
  assert.deepEqual(await ids('sourceMessage'), []);
  assert.deepEqual(await ids('pacs.008'), [], 'the message type is not a reference');
  assert.deepEqual(await ids('INV-2026-0457'), [], 'only references are searched, not the commercial documents');
  assert.deepEqual((await store.search('o2', { q: '3f1c9a52' })).items.map((p) => p.id), ['PAY-REF-OTHER']);
});

test('mode B: the bank\'s statement has to be about the message that is submitted', () => {
  const bank = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const bankSpki = spkiFromPublicKey(createPublicKey(bank.privateKey));
  const recipient = generateEncryptionKey();
  const message = { schema: 'IVMS101-2023', payment_id: 'PAY-B', beneficiaryAccount: 'SG-ACC-000009' };
  const ciphertext = encryptJwe(Buffer.from(JSON.stringify(message), 'utf8'), recipient.publicJwk, 'SG-BFI-001-ENC');
  const ivms101Digest = sha256hex(Buffer.from(jcs(message as JcsValue)));
  const expect = { paymentId: 'PAY-B', ivms101Digest, ciphertext, bankSpki };
  const sign = (payload: Record<string, unknown>) => ({ payload, sig: signEvent(payload, bank.privateKey, 'VN-BANK-1', 'Bank') });
  const full = { payment_id: 'PAY-B', required_fields_present: true, field_count: 8, schema: 'IVMS101-2023',
    ivms101_digest: ivms101Digest, ciphertext_sha256: sha256hex(Buffer.from(ciphertext, 'utf8')) };

  assert.equal(fieldsAssertionProblem(sign(full), expect), null);
  // The statement the SDK used to make: true of any ciphertext, so it binds none.
  const { ivms101_digest: _d, ciphertext_sha256: _c, ...bare } = full;
  assert.match(fieldsAssertionProblem(sign(bare), expect)!, /must carry ivms101_digest and ciphertext_sha256/);
  // Another message put in its place — another beneficiary account — with the bank's statement left as it was.
  const other = { ...message, beneficiaryAccount: 'SG-ACC-ATTACKER' };
  const swapped = encryptJwe(Buffer.from(JSON.stringify(other), 'utf8'), recipient.publicJwk, 'SG-BFI-001-ENC');
  assert.match(fieldsAssertionProblem(sign(full),
    { ...expect, ciphertext: swapped, ivms101Digest: sha256hex(Buffer.from(jcs(other as JcsValue))) })!, /both must be the ones submitted/);
  assert.match(fieldsAssertionProblem(sign(full), { ...expect, ciphertext: swapped })!, /both must be the ones submitted/);
  // The older checks still hold.
  assert.match(fieldsAssertionProblem(sign({ ...full, payment_id: 'PAY-OTHER' }), expect)!, /must name this payment_id/);
  assert.match(fieldsAssertionProblem({ payload: full, sig: signEvent(full, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, 'x', 'x') }, expect)!, /bank-signed/);
  assert.match(fieldsAssertionProblem(undefined, expect)!, /bank-signed/);
});

test('ivms101: an LEI is typed as an LEI, any other number as before', () => {
  const ctx = {
    paymentId: 'PAY-L', tradeAmount: '10.00', tradeCurrency: 'USD',
    originatingInstitution: { id: 'VN-BANK-1', name: 'Bank', country: 'VN' },
    beneficiaryInstitution: { id: 'SG-BFI-001', name: 'BFI', country: 'SG' },
    settlementEntity: { id: 'SETTLE-ENTITY-001', name: 'Entity' }, usdcAmount: '10.00',
  };
  const typeOf = (registration_number: string): unknown => {
    const m = buildIvms101({ originator: { name: 'A', country: 'VN', address: 'x', registration_number }, beneficiary: { name: 'B', country: 'SG', account: '1', bank: 'b' } }, ctx) as
      { underlyingPayment: { originator: { originatorPersons: { legalPerson: { nationalIdentification: { nationalIdentifierType: string } } }[] } } };
    return m.underlyingPayment.originator.originatorPersons[0]!.legalPerson.nationalIdentification.nationalIdentifierType;
  };
  assert.equal(typeOf('9845003X7Y4K2B1Q8W63'), 'LEIX');
  assert.equal(typeOf('0312345678'), 'RAID');
});

// ── One settlement per message ─────────────────────────────────────────────

const UETR_A = 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57';
const UETR_B = '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f';
const UETR_C = '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f';
/** A source-message reference as a bank's SDK signs it into the instruction. */
function sourceMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'MT103', sha256: 'ab'.repeat(32), uetr: UETR_A, messageId: 'A1', instructionId: 'A1',
    valueDate: '2026-11-17', content: 'cd'.repeat(32), ...over };
}
/** A file digest that is its own for every label: `sha('x')`. */
const sha = (label: string): string => sha256hex(Buffer.from(`file:${label}`));
const same = (paymentId: string, ground: 'message' | 'uetr' | 'twin', more: { reused?: boolean; undated?: boolean } = {}) =>
  ({ paymentId, ground, reused: more.reused ?? false, undated: more.undated ?? false });

async function sourceLedger() {
  const db = await openDb(':memory:');
  for (const o of ['o1', 'o2']) {
    await db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?,?,?,?)').run(o, o, o.toUpperCase(), '2026-01-01');
  }
  const store = new RemitStore(db);
  await seedQuote(store, 'o1', 'Q1');
  await seedQuote(store, 'o2', 'Q2');
  const send = async (org: string, id: string, over: Record<string, unknown> = {}) => {
    const made = await store.createFromMessage(basePayment(org, id, org === 'o1' ? 'Q1' : 'Q2'), sourceRefOf(sourceMessage(over))!);
    return 'conflict' in made ? made.conflict : 'idTaken' in made ? 'id taken' : null;
  };
  const exists = async (id: string): Promise<boolean> => !!(await store.get(id));
  return { db, store, send, exists };
}

test('the signed reference to the bank\'s message is read strictly, and what tells nothing apart is normalised', () => {
  const full = sourceMessage({ endToEndId: 'PO-1' });
  const ref = sourceRefOf(full)!;
  assert.deepEqual([ref.messageType, ref.sha256, ref.index, ref.uetr, ref.valueDate, ref.content, ref.undated],
    ['MT103', 'ab'.repeat(32), 0, UETR_A, '2026-11-17', 'cd'.repeat(32), false]);
  assert.match(ref.twinKey!, /^[0-9a-f]{64}$/);
  assert.equal(sourceRefOf(undefined), null, 'an instruction built from the bank\'s own data has none');
  assert.equal(sourceRefOf({ ...full, index: 3 })!.index, 3);
  const key = (over: Record<string, unknown>): string | null => sourceRefOf({ ...full, ...over })!.twinKey;

  // The twin key is the same payment said again: same ids, same day, same content — whatever the UETR, type, file or message id.
  assert.equal(key({ uetr: undefined, type: 'pacs.008.001.08', sha256: 'ef'.repeat(32), messageId: 'Z9', index: 4 }), ref.twinKey);
  assert.notEqual(key({ valueDate: '2026-11-18' }), ref.twinKey, 'another day is another payment');
  assert.notEqual(key({ content: 'ee'.repeat(32) }), ref.twinKey);
  assert.notEqual(key({ endToEndId: 'PO-2' }), ref.twinKey);
  assert.equal(key({ content: undefined }), null, 'an instruction that states no content digest');
  // What never tells two references apart does not make two keys: case, white space, the words for "no end-to-end id".
  const loud = sourceRefOf({ ...full, uetr: UETR_A.toUpperCase(), sha256: 'AB'.repeat(32), content: 'CD'.repeat(32) })!;
  assert.deepEqual([loud.uetr, loud.sha256, loud.content, loud.twinKey], [ref.uetr, ref.sha256, ref.content, ref.twinKey]);
  assert.equal(key({ instructionId: ' A1 ', endToEndId: 'PO-1\t' }), ref.twinKey);
  const noE2e = key({ endToEndId: undefined });
  for (const word of ['NOTPROVIDED', 'notprovided', ' NONREF ', 'NoRef', '', '   ']) assert.equal(key({ endToEndId: word }), noE2e, JSON.stringify(word));
  assert.notEqual(noE2e, ref.twinKey);

  // A payment with neither identifier is known by its message: type, message id, position, day and content.
  const bare = { instructionId: undefined, endToEndId: 'NOTPROVIDED', type: 'pain.001.001.09', messageId: 'FILE-7' };
  const byMessage = key(bare);
  assert.match(byMessage!, /^[0-9a-f]{64}$/);
  assert.equal(key({ ...bare, sha256: 'ef'.repeat(32), uetr: undefined, messageId: ' FILE-7 ' }), byMessage, 'the same file written out again');
  for (const other of [{ messageId: 'FILE-8' }, { index: 1 }, { type: 'pain.001.001.03' }, { valueDate: '2026-11-18' }, { content: 'ee'.repeat(32) }]) {
    assert.notEqual(key({ ...bare, ...other }), byMessage, JSON.stringify(other));
  }
  assert.notEqual(byMessage, key({ ...bare, instructionId: 'FILE-7', messageId: 'X' }), 'a message id is not an instruction id');
  assert.equal(key({ ...bare, messageId: undefined }), null, 'nothing to recognise it by');
  assert.deepEqual([sourceRefOf({ ...full, valueDate: undefined })!.undated, sourceRefOf({ ...full, valueDate: undefined })!.valueDate], [true, null]);

  // Taken as written, each of these would walk past the duplicate check.
  for (const bad of [{ ...full, uetr: `${UETR_A} ` }, { ...full, uetr: 'B4D9E7A15C364F82A1D06E9F3C2B8A57' }, { ...full, uetr: 7 }, { ...full, uetr: '' },
    { ...full, content: 'cd' }, { ...full, content: '' }, { ...full, sha256: undefined }, { ...full, sha256: 'zz'.repeat(32) }, { ...full, type: '' },
    { ...full, index: -1 }, { ...full, index: 1.5 }, { ...full, index: '0' }, { ...full, instructionId: ['A1'] },
    { ...full, endToEndId: 'x'.repeat(300) },
    { ...full, valueDate: '20261117' }, { ...full, valueDate: '2026-11-17T00:00:00Z' }, { ...full, valueDate: ' 2026-11-17' },
    { ...full, valueDate: '17/11/2026' }, { ...full, valueDate: '2026-02-31' }, { ...full, valueDate: '' },
    'MT103', [full]]) {
    assert.throws(() => sourceRefOf(bad), (e: unknown) => e instanceof ServiceError && e.status === 400 && e.code === 'invalid_source_message',
      JSON.stringify(bad).slice(0, 110));
  }

  // An old settlement's reference is never refused: whatever identifies it is kept.
  const old = legacySourceRefOf({ uetr: UETR_A.toUpperCase(), index: '1', valueDate: '20261117', instructionId: ' A1 ', content: 'CD'.repeat(32) }, 'PAY-OLD')!;
  assert.deepEqual([old.messageType, old.index, old.uetr, old.valueDate, old.undated, old.content], ['unknown', 1, UETR_A, null, true, 'cd'.repeat(32)]);
  assert.match(old.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(old.sha256, legacySourceRefOf({ uetr: UETR_A }, 'PAY-OTHER')!.sha256, 'a digest of its own when the file\'s cannot be read');
  assert.deepEqual(legacySourceRefOf(full, 'PAY-X'), ref, 'a well-formed reference reads the same either way');
  assert.equal(legacySourceRefOf(undefined, 'PAY-X'), null);
  assert.equal(legacySourceRefOf('MT103', 'PAY-X'), null);
});

test('one message is one settlement: the same message is not accepted twice, in any of its renderings', async () => {
  const { store, send, exists } = await sourceLedger();

  assert.equal(await send('o1', 'PAY-1'), null);
  // The same transaction of the same file under another payment id: sent again. Nothing is created.
  assert.deepEqual(await send('o1', 'PAY-2'), same('PAY-1', 'message'));
  assert.equal(await exists('PAY-2'), false, 'a refused instruction leaves no settlement behind');
  // …also when another version of the reader came to another content digest for the same bytes:
  // the same file is the same payment, never "a UETR used twice".
  assert.deepEqual(await send('o1', 'PAY-2b', { content: 'e0'.repeat(32) }), same('PAY-1', 'message'));
  // The same UETR in another file: the same payment.
  assert.deepEqual(await send('o1', 'PAY-2c', { sha256: sha('again') }), same('PAY-1', 'uetr'));
  // The same UETR on another amount: the reference reused on a different payment.
  assert.deepEqual(await send('o1', 'PAY-3', { sha256: sha('other amount'), content: 'ee'.repeat(32) }), same('PAY-1', 'uetr', { reused: true }));
  // The same UETR on a second transaction of the same file: two payments under one reference.
  assert.deepEqual(await send('o1', 'PAY-3b', { index: 1 }), same('PAY-1', 'uetr', { reused: true }));
  // The MT103 again with its header blocks cut away — other bytes, no UETR, a reference of two characters.
  assert.deepEqual(await send('o1', 'PAY-4', { sha256: sha('stripped'), uetr: undefined }), same('PAY-1', 'twin'));
  // Two different UETRs are two payments, whatever else they share.
  assert.equal(await send('o1', 'PAY-5', { sha256: sha('own uetr'), uetr: UETR_B }), null);
  // Another day, another payment; another organisation, its own ledger.
  assert.equal(await send('o1', 'PAY-6', { sha256: sha('next day'), uetr: undefined, valueDate: '2026-11-18' }), null);
  assert.equal(await send('o2', 'PAY-7'), null);

  // A payment id that is taken is answered as such — before anything is looked at, and not as a failure.
  assert.equal(await send('o1', 'PAY-1', { sha256: sha('new'), uetr: UETR_C, instructionId: 'F6' }), 'id taken');
  assert.equal(await send('o1', 'PAY-24', { sha256: sha('new'), uetr: UETR_C, instructionId: 'F6' }), null, 'and its message stays free');

  // Nothing to recognise it by (no identifier, no message id, no UETR): the platform does not guess.
  const anonymous = { uetr: undefined, instructionId: undefined, messageId: undefined };
  assert.equal(await send('o1', 'PAY-18', { ...anonymous, sha256: sha('anon 1') }), null);
  assert.equal(await send('o1', 'PAY-19', { ...anonymous, sha256: sha('anon 2') }), null);

  // Two requests for one message at the same moment: exactly one settlement.
  const racing = { sha256: sha('race'), uetr: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', instructionId: 'D4' };
  const both = await Promise.all([send('o1', 'PAY-20', racing), send('o1', 'PAY-21', racing)]);
  assert.equal(both.filter((c) => c === null).length, 1);
  assert.equal([await exists('PAY-20'), await exists('PAY-21')].filter(Boolean).length, 1);
  // …the same for the rendering that only the twin rule recognises…
  const strippedRace = await Promise.all([
    send('o1', 'PAY-22', { sha256: sha('race bare'), uetr: undefined, instructionId: 'E5' }),
    send('o1', 'PAY-23', { sha256: sha('race full'), uetr: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', instructionId: 'E5' }),
  ]);
  assert.equal(strippedRace.filter((c) => c === null).length, 1);
  // …and for two requests under one payment id made from two different messages.
  const sameId = await Promise.all([
    send('o1', 'PAY-25', { sha256: sha('id race 1'), uetr: undefined, instructionId: 'G1' }),
    send('o1', 'PAY-25', { sha256: sha('id race 2'), uetr: undefined, instructionId: 'G2' }),
  ]);
  assert.deepEqual(sameId.map((c) => (c === null ? 'accepted' : c)).sort(), ['accepted', 'id taken']);
  void store;
});

test('a twin is matched one to one: no payment is called paid because one like it was', async () => {
  const { store, send } = await sourceLedger();
  const ids = async (s: Record<string, string>): Promise<string[]> => (await store.search('o1', s)).items.map((p) => p.id);

  // A settlement without a UETR, then the same payment with one: it is that payment — and from then on that UETR's.
  const body = { instructionId: 'H1', messageId: 'H1', content: '10'.repeat(32) };
  assert.equal(await send('o1', 'PAY-H', { ...body, sha256: sha('H bare'), uetr: undefined }), null);
  assert.deepEqual(await send('o1', 'PAY-W1', { ...body, sha256: sha('H with U1'), uetr: UETR_A }), same('PAY-H', 'twin'));
  assert.deepEqual(await ids({ sourceUetr: UETR_A }), ['PAY-H'], 'the settlement took the UETR of its other rendering');
  // Another payment that only reads alike, under a UETR of its own, is not the same settlement a second time.
  assert.equal(await send('o1', 'PAY-W2', { ...body, sha256: sha('H with U2'), uetr: UETR_B }), null);
  // The first rendering again, and in a third file: still PAY-H.
  assert.deepEqual(await send('o1', 'PAY-W1b', { ...body, sha256: sha('H with U1'), uetr: UETR_A }), same('PAY-H', 'twin'));
  assert.deepEqual(await send('o1', 'PAY-W1c', { ...body, sha256: sha('H with U1, again'), uetr: UETR_A }), same('PAY-H', 'uetr'));
  // And with both UETRs taken, a rendering without one is the older of the two.
  assert.deepEqual(await send('o1', 'PAY-W3', { ...body, sha256: sha('H bare, later'), uetr: undefined }), same('PAY-H', 'twin'));

  // A file with two instalments that read alike. Only the first went through before the file was written out again.
  const instalment = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'BATCH-1', endToEndId: 'RENT', content: 'aa'.repeat(32) };
  assert.equal(await send('o1', 'PAY-F0', { ...instalment, sha256: sha('F'), index: 0 }), null);
  // The re-export: its first transaction is the one already paid; its second is NOT — it was never sent.
  assert.deepEqual(await send('o1', 'PAY-X0', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 0 }), same('PAY-F0', 'twin'));
  assert.equal(await send('o1', 'PAY-F1R', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 1 }), null,
    'the second instalment is a payment of its own, not the first one again');
  // The original file's second transaction, handed over after all, is that same second instalment.
  assert.deepEqual(await send('o1', 'PAY-X1', { ...instalment, sha256: sha('F'), index: 1 }), same('PAY-F1R', 'twin'));
  // Asked again, each keeps its answer.
  assert.deepEqual(await send('o1', 'PAY-X0b', { ...instalment, messageId: 'BATCH-1R', sha256: sha('F again'), index: 0 }), same('PAY-F0', 'twin'));
  assert.deepEqual(await send('o1', 'PAY-X1b', { ...instalment, sha256: sha('F'), index: 1 }), same('PAY-F1R', 'twin'));
  // A third export: each transaction is one of the two, and not the same one. The other order, too.
  assert.deepEqual(await send('o1', 'PAY-Y1', { ...instalment, sha256: sha('F third'), index: 1 }), same('PAY-F0', 'twin'));
  assert.deepEqual(await send('o1', 'PAY-Y0', { ...instalment, sha256: sha('F third'), index: 0 }), same('PAY-F1R', 'twin'));
  assert.equal((await store.search('o1', { sourceContent: 'aa'.repeat(32) })).total, 2, 'two instalments, two settlements — however often the file came');

  // A payment retried alone after it went out in a batch is the one in the batch.
  const inBatch = { type: 'pain.001.001.09', uetr: undefined, instructionId: 'INS-7', messageId: 'BATCH-2', content: 'bb'.repeat(32) };
  assert.equal(await send('o1', 'PAY-B7', { ...inBatch, sha256: sha('batch 2'), index: 6 }), null);
  assert.deepEqual(await send('o1', 'PAY-B7x', { ...inBatch, messageId: 'SINGLE-9', sha256: sha('alone'), index: 0 }), same('PAY-B7', 'twin'));

  // A payment with neither identifier (a pain.001 that says NOTPROVIDED): known by its message id and position.
  const plain = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, endToEndId: 'NOTPROVIDED', messageId: 'FILE-7', content: 'cc'.repeat(32) };
  assert.equal(await send('o1', 'PAY-N0', { ...plain, sha256: sha('file 7') }), null);
  assert.deepEqual(await send('o1', 'PAY-N0x', { ...plain, sha256: sha('file 7, new creation time') }), same('PAY-N0', 'twin'), 'the file exported again');
  assert.deepEqual(await send('o1', 'BANK-RETRY-2', { ...plain, sha256: sha('file 7, third time'), endToEndId: undefined }), same('PAY-N0', 'twin'), 'under any payment id');
  assert.equal(await send('o1', 'PAY-N1', { ...plain, sha256: sha('file 7'), index: 1 }), null, 'the next transaction of the file is another payment');
  assert.equal(await send('o1', 'PAY-N8', { ...plain, sha256: sha('file 8'), messageId: 'FILE-8' }), null, 'under another message id nothing says it is the same');

  // No value date: nothing tells this payment from the next one like it. Refused each time — and never recorded as a recognition.
  const undated = { uetr: undefined, instructionId: 'C3', messageId: 'C3', valueDate: undefined, content: 'dd'.repeat(32) };
  assert.equal(await send('o1', 'PAY-16', { ...undated, sha256: sha('undated') }), null);
  assert.deepEqual(await send('o1', 'PAY-17', { ...undated, sha256: sha('undated again') }), same('PAY-16', 'twin', { undated: true }));
  assert.deepEqual(await send('o1', 'PAY-17', { ...undated, sha256: sha('undated again') }), same('PAY-16', 'twin', { undated: true }));
  assert.deepEqual(await send('o1', 'PAY-17b', { ...undated, sha256: sha('undated') }), same('PAY-16', 'message'), 'the very same file is still certain');
});

test('the ledger answers "is this payment here already?" exactly, and old settlements are given their place', async () => {
  const { db, store } = await sourceLedger();
  // Settlements as an earlier platform stored them: the reference only inside the signed evidence.
  const old = async (org: string, id: string, quote: string, source: unknown, state?: 'CANCELLED'): Promise<void> => {
    await store.create(basePayment(org, id, quote));
    await store.appendEvent(id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001',
      { bankInstruction: { ref: id, ...(source === undefined ? {} : { sourceMessage: source }) }, bankApproval: {}, commercialDocs: {} });
    if (state) await store.transition(id, state);
  };
  await old('o1', 'PAY-A', 'Q1', sourceMessage());
  await old('o1', 'PAY-B', 'Q1', sourceMessage());                          // the double payment an earlier check let through
  await old('o1', 'PAY-C', 'Q1', sourceMessage({ sha256: sha('C'), uetr: undefined, instructionId: 'ZZ', messageId: 'ZZ', content: 'ee'.repeat(32) }));
  await old('o1', 'PAY-D', 'Q1', undefined);                               // built from the bank's own data
  // References an earlier platform took unchecked. Each still identifies its settlement by what can be read.
  await old('o1', 'PAY-E', 'Q1', { uetr: UETR_B.toUpperCase(), index: '1', valueDate: '20261117' });
  await old('o1', 'PAY-E2', 'Q1', { type: 'MT103', sha256: sha('E2'), uetr: 'NOT-A-UUID', instructionId: 'E2' });
  await old('o2', 'PAY-F', 'Q2', sourceMessage());
  // An old double payment where the first was cancelled: the one that went on holds the place.
  await old('o1', 'PAY-G1', 'Q1', sourceMessage({ sha256: sha('G'), uetr: UETR_C, instructionId: 'G' }), 'CANCELLED');
  await old('o1', 'PAY-G2', 'Q1', sourceMessage({ sha256: sha('G'), uetr: UETR_C, instructionId: 'G' }));

  assert.deepEqual(await store.backfillSourceRefs(), { claimed: 6, duplicates: 2, unreadable: 0, failed: 0, failures: [], rekeyed: 0 });
  assert.deepEqual(await store.backfillSourceRefs(), { claimed: 0, duplicates: 2, unreadable: 0, failed: 0, failures: [], rekeyed: 0 }, 'safe to run again');

  const ids = async (org: string, s: Record<string, string>): Promise<string[]> => (await store.search(org, s)).items.map((p) => p.id);
  assert.deepEqual(await ids('o1', { sourceUetr: UETR_A }), ['PAY-A'], 'the first one holds the place');
  assert.deepEqual(await ids('o1', { sourceUetr: UETR_A.toUpperCase() }), ['PAY-A']);
  assert.deepEqual(await ids('o1', { sourceUetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a58' }), [], 'the whole value, not a part of it');
  assert.deepEqual(await ids('o1', { sourceContent: 'ee'.repeat(32) }), ['PAY-C'], 'a payment whose only reference has two characters');
  assert.deepEqual(await ids('o1', { sourceContent: 'ee'.repeat(32), sourceValueDate: '2026-11-17' }), ['PAY-C']);
  assert.deepEqual(await ids('o1', { sourceContent: 'ee'.repeat(32), sourceValueDate: '2026-11-18' }), []);
  assert.deepEqual(await ids('o1', { sourceContent: 'ee'.repeat(32), state: 'EVIDENCE_ANCHORED' }), [], 'the other filters still narrow it');
  assert.deepEqual(await ids('o2', { sourceUetr: UETR_A }), ['PAY-F'], 'each organisation its own ledger');
  assert.deepEqual(await ids('o1', { sourceUetr: UETR_B }), ['PAY-E'], 'found by the UETR it carried, however loosely the rest was written');
  assert.deepEqual(await ids('o1', { sourceUetr: UETR_C }), ['PAY-G2'], 'of two old settlements for one message, the one that was not cancelled');

  // And a new submission of any of those messages is now stopped.
  const again = async (id: string, over: Record<string, unknown>) => {
    const made = await store.createFromMessage(basePayment('o1', id, 'Q1'), sourceRefOf(sourceMessage(over))!);
    return 'conflict' in made ? made.conflict : null;
  };
  assert.deepEqual(await again('PAY-N1', {}), same('PAY-A', 'message'));
  assert.deepEqual(await again('PAY-N2', { sha256: sha('E again'), uetr: UETR_B, instructionId: 'E' }), same('PAY-E', 'uetr'));
  assert.deepEqual(await again('PAY-N3', { sha256: sha('E2'), uetr: undefined, instructionId: 'E2' }), same('PAY-E2', 'message'));

  // A row from before the platform learnt to key a payment by its message id gets its key at the next start.
  const plain = sourceMessage({ type: 'pain.001.001.09', sha256: sha('plain'), uetr: undefined, instructionId: undefined, messageId: 'FILE-7', content: 'cc'.repeat(32) });
  await old('o1', 'PAY-P', 'Q1', plain);
  await db.prepare('INSERT INTO remit_source_refs (payment_id, org_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('PAY-P', 'o1', 'pain.001.001.09', sha('plain'), 0, null, '2026-11-17', 'cc'.repeat(32), null, '2026-11-17T00:00:00.000Z');
  assert.equal((await store.backfillSourceRefs()).rekeyed, 1);
  assert.deepEqual(await again('PAY-N4', { ...plain, sha256: sha('plain, exported again') }), same('PAY-P', 'twin'));
  assert.equal((await store.backfillSourceRefs()).rekeyed, 0);
});

test('a settlement is accepted whole: its opening events and first state are written with it, or nothing is', async () => {
  const { db, store } = await sourceLedger();
  const opening = async (bound: RemitStore, id: string): Promise<void> => {
    await bound.appendEvent(id, 'REQUEST_ACCEPTED', 'STONEHASH', { payment_id: id });
    await bound.appendEvent(id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { ref: id } });
    await bound.transition(id, 'BANK_AUTHORIZED');
  };
  const ref = (label: string) => sourceRefOf(sourceMessage({ sha256: sha(label), uetr: undefined, instructionId: label }))!;

  const made = await store.createFromMessage(basePayment('o1', 'PAY-W1', 'Q1'), ref('whole'), (bound) => opening(bound, 'PAY-W1'));
  assert.equal('payment' in made && made.payment.state, 'BANK_AUTHORIZED');
  assert.deepEqual((await store.events('PAY-W1')).map((e) => e.type), ['REQUEST_ACCEPTED', 'BANK_EVIDENCE_SUBMITTED']);

  // What must be there from the first moment cannot be written: the settlement is not there either,
  // nor its claim on the message — the next request for that message is accepted.
  await assert.rejects(store.createFromMessage(basePayment('o1', 'PAY-W2', 'Q1'), ref('half'), async (bound) => {
    await bound.appendEvent('PAY-W2', 'REQUEST_ACCEPTED', 'STONEHASH', { payment_id: 'PAY-W2' });
    throw new Error('the evidence could not be stored');
  }), /could not be stored/);
  assert.ok(!(await store.get('PAY-W2')));
  assert.deepEqual(await store.events('PAY-W2'), []);
  const rows = await db.prepare('SELECT COUNT(*) AS n FROM remit_source_refs WHERE payment_id = ?').get('PAY-W2') as { n: number };
  assert.equal(Number(rows.n), 0);
  const again = await store.createFromMessage(basePayment('o1', 'PAY-W3', 'Q1'), ref('half'), (bound) => opening(bound, 'PAY-W3'));
  assert.equal('payment' in again && again.payment.id, 'PAY-W3');

  // The same for a settlement that was not made from a message.
  assert.equal((await store.create(basePayment('o1', 'PAY-W4', 'Q1'), (bound) => opening(bound, 'PAY-W4'))).state, 'BANK_AUTHORIZED');
  await assert.rejects(store.create(basePayment('o1', 'PAY-W5', 'Q1'), async () => { throw new Error('no'); }), /no/);
  assert.ok(!(await store.get('PAY-W5')));
});
