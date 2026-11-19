/**
 * Vectors that hold part 1 of the Java settlement rail (foundation, acceptance, the routes that need no partner)
 * to the reference, `apps/core/src/remit/`:
 *
 *   quotes        quotes.ts: mulDecimal, addDecimal, buildQuote — the arithmetic, every refusal, their order
 *   sourceRefs    store.ts: sourceRefOf — the normalised reference and its twin key, or the refusal
 *   requestHashes routes.ts: the hash a request is remembered by under its Idempotency-Key
 *   cursors       store.ts: the ledger's cursor as issued, and which texts are read as one
 *   keys          sign.ts: which stored keys the registry's keyring takes (spkiToJwk), which forms of a P-256 key verify
 *                 (verifyEvent), and the platform key's id for a key file (loadOrCreatePlatformKey)
 *   registry      registry.ts: the snapshot and the keyring of a registry's rows
 *   accept        routes.ts + orchestrator.ts: POST /v1/settlements through the reference's own handler, on its own store
 *                 (in-memory SQLite): every refusal of the checks that come before the transaction, in their order, and for
 *                 an accepted instruction the rows it was stored as
 *   conflicts     orchestrator.ts: the refusal a second settlement for a message gets, for every ground
 *   fieldsAssertion orchestrator.ts: fieldsAssertionProblem
 *   evidence      evidence.ts: collectElements, reconcilePayment, assemblePackage, packageCommitment over recorded event logs
 *   chain         chain-status.ts: chainTxStatus against scripted node answers (no node is contacted: `fetch` is replaced)
 *
 *   node apps/core-java/tools/make-remit-b1-vectors.mjs          write the files
 *   node apps/core-java/tools/make-remit-b1-vectors.mjs --check  fail when a file on disk differs
 *
 * It also writes the one data file the Java rail reads at run time, `src/main/resources/remit/corridor-policy.json`:
 * the reference's own constant REMIT_POLICY, member order kept.
 *
 * Signatures are random, so everything that has to be signed to get past a check is signed once and kept
 * (`src/test/resources/vectors/remit-b1-materials.json`, made when absent). These are test keys: the private halves in
 * that file protect nothing. Every answer is the reference's: `{ status, body }` as its error mapper answers,
 * `{ plain }` where its code threw a sentence of its own that is no refusal, `{ engine }` where its runtime threw.
 * Where the Java service answers differently on purpose the case says so (`java`), with the row of
 * docs/JAVA-INTENDED-DIFFERENCES.md that says why. Inputs are kept as the JSON text they were.
 *
 * Nothing live is touched: no port is opened, no database but SQLite in memory, no address is called.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulDecimal, addDecimal, buildQuote } from '../../core/src/remit/quotes.ts';
import { sourceRefOf, RemitStore } from '../../core/src/remit/store.ts';
import { RemitOrchestrator, fieldsAssertionProblem } from '../../core/src/remit/orchestrator.ts';
import { signEvent, verifyEvent, signEvidenceElement, elementDigest, sha256hex, spkiToJwk, spkiFromPublicKey, loadOrCreatePlatformKey } from '../../core/src/remit/sign.ts';
import { REMIT_POLICY, collectElements, reconcilePayment, assemblePackage, packageCommitment } from '../../core/src/remit/evidence.ts';
import { chainTxStatus } from '../../core/src/remit/chain-status.ts';
import { Registry } from '../../core/src/remit/registry.ts';
import { WebhookOutbox } from '../../core/src/remit/webhook.ts';
import { registerRemitRoutes } from '../../core/src/remit/routes.ts';
import { generateEncryptionKey } from '../../core/src/remit/jwe.ts';
import { openDb } from '../../core/src/db.ts';
import { ServiceError } from '../../core/src/service.ts';
import { HttpError, HttpResult } from '../../core/src/http/server.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../src/test/resources/vectors');
const FILES = {
  vectors: path.join(DIR, 'remit-b1.json'),
  policy: path.resolve(HERE, '../src/main/resources/remit/corridor-policy.json'),
};
const MATERIALS = path.join(DIR, 'remit-b1-materials.json');
const KEY_MATERIALS = path.join(DIR, 'key-materials.json');
const TMP = path.resolve(HERE, '../target/remit-b1-tmp');
const check = process.argv.includes('--check');

// ── a clock that moves one millisecond every time it is read ────────────────────────────────────────────────────
// Rows written one after the other get times one after the other, the same on every run.
const RealDate = Date;
let clock = RealDate.parse('2026-11-19T03:00:00.000Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(clock++); else super(...a); }
  static now() { return clock++; }
};
const T0 = RealDate.parse('2026-11-19T02:00:00.000Z');
const iso = (ms) => new RealDate(T0 + ms).toISOString();

// ── answers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const refusal = (e) => {
  if (e instanceof ServiceError) return { status: e.status, body: { ...(e.detail ?? {}), error: e.code, message: e.message } };
  if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message } };
  return e?.constructor === Error ? { plain: e.message } : { engine: `${e?.constructor?.name}: ${e?.message}` };
};
const answer = (fn) => { try { return { value: fn() }; } catch (e) { return refusal(e); } };
const answerAsync = async (fn) => { try { return { value: await fn() }; } catch (e) { return refusal(e); } };
const D18 = 'D-18: an id that is not text is refused as the id it is not; the reference read the value as text where it tested it and as a number where it stored it';

// ── materials: keys, and what was signed with them, made once ───────────────────────────────────────────────────
const pemOf = (k) => k.export({ format: 'pem', type: 'pkcs8' });
const spkiOf = (pem) => spkiFromPublicKey(createPublicKey(createPrivateKey(pem)));
/** A value as JSON carries it: members that are `undefined` are not there. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const finish = (given, pem, keyId, issuer) => { const core = plain(given); return signEvidenceElement({ ...core, digest: elementDigest(core) }, createPrivateKey(pem), keyId, issuer); };
const PAY = 'PAY-B1-0001';
const BANK = { id: 'VN-BANK-B1', name: 'B1 Collection Bank' };
const BFI = { id: 'SG-BFI-B1', name: 'B1 Beneficiary Institution' };
const SETTLE = { id: 'SETTLE-B1', name: 'B1 Settlement Entity' };
const SHA = (label) => sha256hex(Buffer.from(`b1 file:${label}`));
const UETR = ['b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f'];
const sourceMessage = (over = {}) => ({ type: 'MT103', sha256: SHA('base'), uetr: UETR[0], messageId: 'M-1', instructionId: 'I-1', endToEndId: 'E-1',
  valueDate: '2026-11-19', content: 'cd'.repeat(32), ...over });

function makeMaterials() {
  const key = () => pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
  const pem = { bank: key(), bank2: key(), bfi: key(), settle: key(), stranger: key(), platform: key() };
  const bankKey = createPrivateKey(pem.bank);
  const sign = (payload, who = 'bank') => signEvent(payload, createPrivateKey(pem[who]), who === 'bank' ? BANK.id : 'VN-BANK-OTHER', who === 'bank' ? BANK.name : 'Other Bank');
  const instructionCore = (over = {}) => ({ ref: PAY, amount: '10000.00', currency: 'USD', debtor: 'Vina Trading Co., Ltd.', creditor: 'Pacific Supply Pte Ltd',
    approvedAt: iso(0), iso20022Fields: ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf', 'INV-B1-0001'], ...over });
  const el = (core, who = 'bank') => finish(core, pem[who], BANK.id, BANK.name);
  const approvalCore = { approvalRef: `APPR-${PAY}`, regulatorReportRef: 'VN-SBV-C27-DEMO', approvedByRole: 'FX Compliance Officer', approvedAt: iso(0),
    fxQuote: { pair: 'USD/VND', rate: '25380', quotedAt: iso(-60_000), validUntil: iso(600_000) } };
  const docsCore = { invoiceRef: 'INV-B1-0001', amount: '10000.00', currency: 'USD', buyer: 'Vina Trading Co., Ltd.', seller: 'Pacific Supply Pte Ltd',
    attached: ['invoice'], citedOnly: [] };
  const authorization = { payment_id: PAY, quote_id: 'QT-B1-GOOD', amount: '10000.00', currency: 'USD', instruction_ref: 'INS-B1-0001', authorized_at: iso(0) };
  const instructions = {
    base: el(instructionCore()),
    amount9999: el(instructionCore({ amount: '9999.00' })),
    amountNumber: el(instructionCore({ amount: 10000 })),
    eur: el(instructionCore({ currency: 'EUR' })),
    otherRef: el(instructionCore({ ref: 'PAY-B1-9999' })),
    byBank2: el(instructionCore(), 'bank2'),
    srcFull: el(instructionCore({ sourceMessage: sourceMessage({ index: 2 }) })),
    srcBare: el(instructionCore({ sourceMessage: { type: 'pacs.008.001.08', sha256: SHA('bare').toUpperCase() } })),
    srcBadUetr: el(instructionCore({ sourceMessage: sourceMessage({ uetr: 'not-a-uuid' }) })),
    srcText: el(instructionCore({ sourceMessage: 'MT103' })),
    srcNull: el(instructionCore({ sourceMessage: null })),
  };
  // Instructions for other payment ids: the id is signed into the instruction, so each needs its own.
  for (const id of ['PAY-B1-TAKEN', 'PAY-B1-OTHERS', 'ABCD', `P${'9'.repeat(63)}`]) instructions[`ref:${id}`] = el(instructionCore({ ref: id }));
  // Pairs for the conflict sentences: a first settlement, and a second instruction that runs into it.
  const pair = (name, first, second) => {
    instructions[`${name}:first`] = el(instructionCore({ ref: `PAY-B1-${name}-1`, sourceMessage: sourceMessage(first) }));
    instructions[`${name}:second`] = el(instructionCore({ ref: `PAY-B1-${name}-2`, sourceMessage: sourceMessage(second) }));
  };
  pair('MSG', {}, { content: 'e0'.repeat(32) });
  pair('UETR', {}, { sha256: SHA('again') });
  pair('REUSED', {}, { sha256: SHA('other amount'), content: 'ee'.repeat(32) });
  pair('TWIN', { uetr: undefined }, { sha256: SHA('stripped'), uetr: UETR[1] });
  pair('UNDATED', { uetr: undefined, valueDate: undefined }, { sha256: SHA('undated again'), uetr: undefined, valueDate: undefined });

  const ciphertext = 'eyJhbGciOiJFQ0RILUVTIiwiZW5jIjoiQTI1NkdDTSJ9..b1-iv.b1-ciphertext.b1-tag';
  const digest = sha256hex(Buffer.from('b1 ivms101'));
  const assertion = (over = {}, who = 'bank') => {
    const payload = plain({ payment_id: PAY, required_fields_present: true, ivms101_digest: digest, ciphertext_sha256: sha256hex(Buffer.from(ciphertext, 'utf8')), ...over });
    return { payload, sig: sign(payload, who) };
  };

  // Evidence: the elements every party signs, as the partner simulators sign them (apps/core/test/remit.test.ts, "gold path").
  const deposit = `0x${'ab'.repeat(20)}`;
  const travelRule = { protocol: 'IVMS101/JWE', ivms101Digest: 'c'.repeat(64), originatingVasp: SETTLE.id, beneficiaryVasp: BFI.id, approvalStatus: 'APPROVED',
    approvalDigest: 'd'.repeat(64), approvedAt: iso(10_000), approvedBeneficiaryAddress: deposit };
  const chainTransfer = { chain: 'eip155:31337', asset: 'USDC', amount: '10000.00', currency: 'USDC', fromAddress: `0x${'cd'.repeat(20)}`, toAddress: deposit,
    txRef: `0x${'ef'.repeat(32)}`, settlementIdMemo: PAY, confirmations: 1, observedAt: iso(20_000) };
  const receipt = (over = {}) => ({ ref: `${PAY}/FAST-20261119-0001`, amount: '10000.00', currency: 'USD', paidAt: iso(30_000), local_amount: '13350.00',
    local_currency: 'SGD', local_rate_pair: 'USD/SGD', local_rate: '1.3350', quote_ref: 'QT-B1-GOOD', bank_reference: 'FAST-20261119-0001', evidence_level: 'L3', ...over });
  const by = (who, core) => finish(core, pem[who === 'bfi' ? 'bfi' : who === 'settle' ? 'settle' : who], who === 'bfi' ? BFI.id : who === 'settle' ? SETTLE.id : who === 'stranger' ? BFI.id : BANK.id,
    who === 'bfi' || who === 'stranger' ? BFI.name : who === 'settle' ? SETTLE.name : BANK.name);
  const wrongDigest = (() => { const core = instructionCore(); return signEvidenceElement({ ...core, digest: 'f'.repeat(64) }, bankKey, BANK.id, BANK.name); })();
  const noDigest = signEvidenceElement(instructionCore(), bankKey, BANK.id, BANK.name);
  const unsignedReceipt = { ...plain(receipt({ evidence_level: 'L1' })), digest: elementDigest(plain(receipt({ evidence_level: 'L1' }))), signature: { status: 'ABSENT' } };
  const evidence = {
    bankInstruction: instructions.base, bankApproval: el(approvalCore), commercialDocs: el(docsCore),
    travelRule: by('bfi', travelRule), chainTransfer: by('settle', chainTransfer), receipt: by('bfi', receipt()),
    receiptOtherAmount: by('bfi', receipt({ amount: '10100.00' })), receiptByStranger: by('stranger', receipt()), receiptUnsigned: unsignedReceipt,
    receiptL2: by('bfi', receipt({ evidence_level: 'L2', bank_reference: undefined })),
    instructionWrongDigest: wrongDigest, instructionNoDigest: noDigest,
  };
  const keySample = (() => {
    const km = JSON.parse(readFileSync(KEY_MATERIALS, 'utf8'));
    const k = createPrivateKey({ key: Buffer.from(km.private.p256Pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = { payment_id: PAY, note: 'signed with the P-256 key of key-materials.json' };
    return { payload, sig: signEvent(payload, k, 'KEY-SAMPLE', 'Key sample') };
  })();
  return {
    note: 'Made once by apps/core-java/tools/make-remit-b1-vectors.mjs and kept: keys and signatures are random. Test keys; the private halves here protect nothing.',
    pem, encryption: generateEncryptionKey().publicJwk,
    authorization: { payload: authorization, sig: sign(authorization), sigByBank2: sign(authorization, 'bank2') },
    instructions, approval: el(approvalCore), docs: el(docsCore),
    modeB: { ciphertext, digest, good: assertion(), otherPayment: assertion({ payment_id: 'PAY-B1-9999' }), notPresent: assertion({ required_fields_present: 'true' }),
      otherDigest: assertion({ ivms101_digest: 'a'.repeat(64) }), otherCiphertext: assertion({ ciphertext_sha256: 'b'.repeat(64) }), noCiphertextHash: assertion({ ciphertext_sha256: undefined }),
      byBank2: assertion({}, 'bank2'), extraMembers: assertion({ note: 'further members change nothing', fields: ['originator.name'] }) },
    evidence, keySample,
  };
}
let M;
if (existsSync(MATERIALS)) M = JSON.parse(readFileSync(MATERIALS, 'utf8'));
else {
  if (check) { console.error('remit-b1-materials.json is missing — run without --check once'); process.exit(1); }
  M = makeMaterials();
  writeFileSync(MATERIALS, `${JSON.stringify(M, null, 1)}\n`);
}
const SPKI = Object.fromEntries(Object.entries(M.pem).map(([k, v]) => [k, spkiOf(v)]));

// ── quotes ──────────────────────────────────────────────────────────────────────────────────────────────────────
const decimals = ['0', '0.0', '1', '1.5', '10000', '10000.00', '007.50', '0.005', '0.0049', '0.015', '1.005', '2.5', '999.995', '0.05', '25380', '1.3350', '25.00',
  '123456789012345678901234567890.123456789012345678901234567890', '0.000000000000000001', '', '.5', '5.', '+1', '-1', '1e3', ' 1', '1 ', '1,5', '１', '1\n', 'abc', '1.2.3', '0x10'];
const mul = [];
for (const a of decimals) for (const [b, scale] of [['1', 2], ['1', 0], ['25380', 0], ['1.3350', 2], ['0.5', 0], ['0.005', 2], ['1', 18]]) mul.push({ a, b, scale, answer: answer(() => mulDecimal(a, b, scale)) });
for (const b of ['', 'x', '1.', '-2']) mul.push({ a: '10', b, scale: 2, answer: answer(() => mulDecimal('10', b, 2)) });
const add = [];
for (const a of ['0', '10000', '10000.00', '0.005', '0.004', '1.005', '999.995', '', 'x', '1e2']) for (const [b, scale] of [['25.00', 2], ['25', 2], ['0.005', 2], ['0', 0], ['0.5', 0], ['abc', 2]]) add.push({ a, b, scale, answer: answer(() => addDecimal(a, b, scale)) });

const QUOTE_NOW = new RealDate('2026-11-19T02:30:00.000Z');
const quoteCfg = (over = {}) => ({ rates: { usdVnd: '25380', usdSgd: '1.3350' }, feeUsd: '25.00', ttlMs: 600_000, chainLabel: 'eip155:31337', ...over });
const goodQuoteRequest = { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '10000' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } };
const quoteRequests = [
  ['a plain request', goodQuoteRequest],
  ['with a beneficiary institution and members nobody reads', { ...goodQuoteRequest, beneficiary_institution: 'SG-BFI-B1', extra: [1, { a: null }] }],
  ...['0', '0.00', '1', '1.005', '0.005', '0.0049', '999.995', '10000.00', '007.50', '123456789012345678901234567890.12', '1e3', '-5', '', ' 1', '1 ', '1\n', '１', '.5', '5.']
    .map((amount) => [`amount ${JSON.stringify(amount)}`, { ...goodQuoteRequest, trade: { currency: 'USD', amount } }]),
  ['amount that is a number', { ...goodQuoteRequest, trade: { currency: 'USD', amount: 10000 } }],
  ['amount that is a fraction as a number', { ...goodQuoteRequest, trade: { currency: 'USD', amount: 10.5 } }],
  ['amount that is a list of one text', { ...goodQuoteRequest, trade: { currency: 'USD', amount: ['100'] } }],
  ['amount that is null', { ...goodQuoteRequest, trade: { currency: 'USD', amount: null } }],
  ['amount that is true', { ...goodQuoteRequest, trade: { currency: 'USD', amount: true } }],
  ['amount that is an object', { ...goodQuoteRequest, trade: { currency: 'USD', amount: {} } }],
  ['no amount', { ...goodQuoteRequest, trade: { currency: 'USD' } }],
  ['an empty object', {}],
  ['a list', []], ['text', 'quote'], ['a number', 7], ['true', true],
  ['no corridor', { ...goodQuoteRequest, corridor: undefined }],
  ['a corridor that is text', { ...goodQuoteRequest, corridor: 'VN-SG' }],
  ['a corridor the other way', { ...goodQuoteRequest, corridor: { origin: 'SG', destination: 'VN' } }],
  ['a corridor in lower case', { ...goodQuoteRequest, corridor: { origin: 'vn', destination: 'sg' } }],
  ['a corridor with only an origin', { ...goodQuoteRequest, corridor: { origin: 'VN' } }],
  ['no trade', { ...goodQuoteRequest, trade: undefined }],
  ['a trade in EUR', { ...goodQuoteRequest, trade: { currency: 'EUR', amount: '10000' } }],
  ['a trade that is null', { ...goodQuoteRequest, trade: null }],
  ['collecting USD', { ...goodQuoteRequest, collect: { currency: 'USD' } }],
  ['paying out VND', { ...goodQuoteRequest, payout: { currency: 'VND' } }],
  ['no collect', { ...goodQuoteRequest, collect: undefined }],
  ['no payout', { ...goodQuoteRequest, payout: undefined }],
  // The order: a request wrong in several ways is answered with the first.
  ['wrong corridor, currency, legs and amount', { corridor: { origin: 'XX' }, trade: { currency: 'EUR', amount: 'x' }, collect: { currency: 'USD' }, payout: { currency: 'USD' } }],
  ['wrong currency, legs and amount', { ...goodQuoteRequest, trade: { currency: 'EUR', amount: 'x' }, collect: { currency: 'USD' } }],
  ['wrong legs and amount', { ...goodQuoteRequest, trade: { currency: 'USD', amount: 'x' }, collect: { currency: 'USD' } }],
];
const quoteCfgs = [['the defaults', quoteCfg()], ['a rate with decimals', quoteCfg({ rates: { usdVnd: '25380.5', usdSgd: '1.3' } })], ['no fee', quoteCfg({ feeUsd: '0' })],
  ['a fee of three decimals', quoteCfg({ feeUsd: '25.005' })], ['a fee without decimals', quoteCfg({ feeUsd: '25' })], ['a rate that is no number', quoteCfg({ rates: { usdVnd: 'abc', usdSgd: '1.3350' } })],
  ['a fee that is no number', quoteCfg({ feeUsd: 'free' })], ['a payout rate that is no number', quoteCfg({ rates: { usdVnd: '25380', usdSgd: '' } })], ['another chain, no time to live', quoteCfg({ chainLabel: 'eip155:1', ttlMs: 0 })]];
const build = [];
for (const [name, request] of quoteRequests) {
  for (const [cfgName, cfg] of name === 'a plain request' || name.startsWith('amount "1.005"') || name.startsWith('amount "0.005"') ? quoteCfgs : quoteCfgs.slice(0, 1)) {
    const requestJson = JSON.stringify(request);
    const a = answer(() => buildQuote(JSON.parse(requestJson), cfg, QUOTE_NOW));
    if (a.value) a.value = { ...a.value, quote_id: 'QT-<id>' };
    build.push({ name: `${name}, ${cfgName}`, requestJson, cfg: { rateUsdVnd: cfg.rates.usdVnd, rateUsdSgd: cfg.rates.usdSgd, feeUsd: cfg.feeUsd, ttlMs: cfg.ttlMs, chainLabel: cfg.chainLabel },
      now: QUOTE_NOW.getTime(), answer: a });
  }
}

// ── the source reference ────────────────────────────────────────────────────────────────────────────────────────
const full = sourceMessage();
const sourceCases = [
  full, { ...full, index: 3 }, { ...full, index: 0 }, { ...full, index: -0 }, { ...full, index: 1e3 }, { ...full, index: 5.0 }, { ...full, index: 1000000 }, { ...full, index: 1000001 },
  { ...full, index: 0.5 }, { ...full, index: -1 }, { ...full, index: '0' }, { ...full, index: true }, { ...full, index: [] }, { ...full, index: null },
  { ...full, uetr: undefined, type: 'pacs.008.001.08', sha256: 'ef'.repeat(32), messageId: 'Z9', index: 4 }, { ...full, valueDate: '2026-11-20' }, { ...full, content: 'ee'.repeat(32) },
  { ...full, endToEndId: 'PO-2' }, { ...full, content: undefined }, { ...full, content: null },
  { ...full, uetr: UETR[0].toUpperCase(), sha256: SHA('base').toUpperCase(), content: 'CD'.repeat(32) }, { ...full, instructionId: ' I-1 ', endToEndId: 'E-1\t' },
  ...['NOTPROVIDED', 'notprovided', ' NONREF ', 'NoRef', '', '   ', 'NOTPROVIDED.', 'NONE'].map((endToEndId) => ({ ...full, instructionId: undefined, endToEndId })),
  { ...full, endToEndId: undefined }, { ...full, instructionId: undefined, endToEndId: undefined },
  { ...full, instructionId: undefined, endToEndId: 'NOTPROVIDED', type: 'pain.001.001.09', messageId: 'FILE-7' },
  { ...full, instructionId: undefined, endToEndId: 'NOTPROVIDED', type: 'pain.001.001.09', messageId: ' FILE-7 ', sha256: 'ef'.repeat(32), uetr: undefined },
  { ...full, instructionId: undefined, endToEndId: undefined, messageId: undefined }, { ...full, instructionId: '', endToEndId: '', messageId: '' },
  { ...full, valueDate: undefined }, { ...full, valueDate: null },
  // identifiers that JSON writes with escapes, and what trimming takes off
  ...['a"b', 'a\\b', 'a/b', 'tab\there', 'line\nbreak', '\u0000', '\u001f', '\u007f', ' ', 'é', '안녕', '😀', '\ud83d', '\ude00', '\ude00\ud83d',
    ' pad ', '﻿pad﻿', ' pad ', '　pad ', '\u0085pad\u0085', '​pad​', '᠎pad', '\u001cpad\u001f'].map((instructionId) => ({ ...full, instructionId })),
  { ...full, type: 'MT"103' }, { ...full, type: 'x'.repeat(40) }, { ...full, type: 'x'.repeat(41) }, { ...full, messageId: 'm'.repeat(256), instructionId: undefined, endToEndId: undefined },
  { ...full, messageId: 'm'.repeat(257) }, { ...full, instructionId: `${'😀'.repeat(128)}` }, { ...full, instructionId: `${'😀'.repeat(128)}x` },
  // refused
  { ...full, uetr: `${UETR[0]} ` }, { ...full, uetr: 'B4D9E7A15C364F82A1D06E9F3C2B8A57' }, { ...full, uetr: 7 }, { ...full, uetr: '' }, { ...full, uetr: `${UETR[0]}\n` },
  { ...full, content: 'cd' }, { ...full, content: '' }, { ...full, content: `${'cd'.repeat(32)}\n` }, { ...full, sha256: undefined }, { ...full, sha256: 'zz'.repeat(32) }, { ...full, sha256: 5 },
  { ...full, type: '' }, { ...full, type: undefined }, { ...full, type: 5 }, { ...full, instructionId: ['I-1'] }, { ...full, endToEndId: 'x'.repeat(300) }, { ...full, messageId: 7 },
  { ...full, valueDate: '20261119' }, { ...full, valueDate: '2026-11-19T00:00:00Z' }, { ...full, valueDate: ' 2026-11-19' }, { ...full, valueDate: '19/11/2026' }, { ...full, valueDate: '2026-02-31' },
  { ...full, valueDate: '2026-02-29' }, { ...full, valueDate: '2028-02-29' }, { ...full, valueDate: '2026-13-01' }, { ...full, valueDate: '2026-00-10' }, { ...full, valueDate: '2026-01-00' },
  { ...full, valueDate: '0099-01-01' }, { ...full, valueDate: '0100-01-01' }, { ...full, valueDate: '0000-01-01' }, { ...full, valueDate: '9999-12-31' }, { ...full, valueDate: '2026-11-19\n' },
  { ...full, valueDate: '' }, { ...full, valueDate: '２０２６-11-19' }, { ...full, valueDate: 20261119 },
  { type: 'MT103' }, { sha256: SHA('base') }, {},
].map((v) => JSON.stringify(v)).concat(['"MT103"', `[${JSON.stringify(full)}]`, '7', 'true', 'null', '""', '0', 'false']);
const sourceRefs = sourceCases.map((json) => ({ json, answer: answer(() => sourceRefOf(JSON.parse(json))) }));

// ── request hashes ──────────────────────────────────────────────────────────────────────────────────────────────
const bodies = ['{}', '{"a":1,"b":2}', '{"b":2,"a":1}', '{ "a" : 1 , "b" : [ 1 , 2 ] }', '{"b":1,"2":0,"10":0,"a":1,"1":7}', '{"a":1,"a":2,"b":3}', '{"__proto__":{"x":1},"y":2}',
  '{"n":1.0}', '{"n":1e3}', '{"n":-0}', '{"n":1e21}', '{"n":0.1}', '{"n":1e-7}', '{"n":123456789012345680000}', '{"n":0.30000000000000004}', '{"n":9007199254740993}',
  '{"s":"\\u00e9"}', '{"s":"é"}', '{"s":"\\/"}', '{"s":"\\ud83d"}', '{"s":"\\ud83d\\ude00"}', '{"s":"\\u2028"}', '{"s":"\\u0000\\u001f\\"\\\\"}', '{"s":"line\\nbreak\\ttab"}', '{"s":"\\u007f"}',
  '[]', '[1,"2",null,true,{"a":[]}]', '"text"', '7', 'true', 'null', '{"a":{"b":{"c":{"d":[{"e":null}]}}}}', '{"payment_id":"PAY-1","quote_id":"QT-1","amount":{"collected":{"currency":"VND","value":"1"}}}',
  '\n {"a":1}\n', '{"한글":"값","emoji":"😀"}', '{"":""}', '{"a":[1,2,3,],"b":1}'.replace(',]', ']')];
const requestHashes = bodies.map((text) => ({ text, hash: sha256hex(JSON.stringify(JSON.parse(text))) }));

// ── a reference store of its own, in memory ─────────────────────────────────────────────────────────────────────
mkdirSync(TMP, { recursive: true });
const platformPem = path.join(TMP, 'platform.pem');
writeFileSync(platformPem, M.pem.platform);
const platform = loadOrCreatePlatformKey(platformPem);
const log = () => {};
const basePayment = (org, id, quoteId) => ({ id, org_id: org, quote_id: quoteId, corridor_origin: 'VN', corridor_destination: 'SG', trade_currency: 'USD', trade_amount: '10000.00',
  collect_currency: 'VND', collect_amount: '254434500', usdc_amount: '10000.00', payout_currency: 'SGD', payout_amount: '13350.00', beneficiary_institution: BFI.id, request_body: '{}' });
const goodQuote = { ...buildQuote(JSON.parse(JSON.stringify(goodQuoteRequest)), quoteCfg(), QUOTE_NOW), quote_id: 'QT-B1-GOOD' };
const FAR = '2099-01-01T00:00:00.000Z';

async function world() {
  const db = await openDb(':memory:');
  for (const o of ['o1', 'o2']) await db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?,?,?,?)').run(o, o, o.toUpperCase(), '2026-01-01T00:00:00.000Z');
  const registry = new Registry(db);
  const store = new RemitStore(db);
  await registry.upsert({ id: BANK.id, role: 'COLLECTION_BANK', name: BANK.name, country: 'VN', org_id: 'o1', signing_spki: SPKI.bank,
    authority: ['FIAT_FUNDS_RECEIVED', 'PAYMENT_RELEASE_AUTHORIZED', 'bankInstruction', 'bankApproval', 'commercialDocs'] });
  await registry.subscribe('o1', 'remit', { institution_id: BANK.id });
  await registry.upsert({ id: BFI.id, role: 'BENEFICIARY_FI', name: BFI.name, country: 'SG', signing_spki: SPKI.bfi, encryption_jwk: M.encryption, authority: ['PAYOUT_ACCEPTED'] });
  await registry.upsert({ id: 'SG-BFI-NOENC', role: 'BENEFICIARY_FI', name: 'No encryption key', country: 'SG', signing_spki: SPKI.bfi });
  await registry.upsert({ id: 'SG-BFI-NULLENC', role: 'BENEFICIARY_FI', name: 'An encryption key that is null', signing_spki: SPKI.bfi, encryption_jwk: null });
  await registry.upsert({ id: 'SG-PAYBANK-B1', role: 'LOCAL_PAYOUT_BANK', name: 'Not a beneficiary institution', encryption_jwk: M.encryption });
  await registry.upsert({ id: SETTLE.id, role: 'SETTLEMENT_ENTITY', name: SETTLE.name, signing_spki: SPKI.settle });
  await store.saveQuote('o1', 'QT-B1-GOOD', 'VN', 'SG', goodQuoteRequest, goodQuote, FAR);
  await store.saveQuote('o1', 'QT-B1-EXPIRED', 'VN', 'SG', goodQuoteRequest, { ...goodQuote, quote_id: 'QT-B1-EXPIRED' }, '2020-01-01T00:00:00.000Z');
  await store.saveQuote('o2', 'QT-B1-OTHER', 'VN', 'SG', goodQuoteRequest, { ...goodQuote, quote_id: 'QT-B1-OTHER' }, FAR);
  await store.saveQuote('o1', 'QT-B1-BROKEN', 'VN', 'SG', {}, {}, FAR);
  await store.saveQuote('o1', 'QT-B1-NULL', 'VN', 'SG', {}, null, FAR);
  await store.create(basePayment('o1', 'PAY-B1-TAKEN', 'QT-B1-GOOD'));
  await store.create(basePayment('o2', 'PAY-B1-OTHERS', 'QT-B1-OTHER'));
  const outbox = new WebhookOutbox(db, platform, 5, log);
  const never = () => new Promise(() => {});
  const orchestrator = new RemitOrchestrator({ store, registry, svc: {}, bfi: { sendTravelRule: never }, wallet: {}, outbox, platform, acceptDemoFinality: true, chainLabel: 'eip155:31337', log });
  orchestrator.advance = async () => {};   // nothing runs after the answer: these vectors are about acceptance alone
  const handlers = new Map();
  registerRemitRoutes({ get: (p, h) => handlers.set(`GET ${p}`, h), post: (p, h) => handlers.set(`POST ${p}`, h) }, {
    cfg: { remit: { adminToken: 'b1-admin', explorerTxUrl: '', chainRpc: '', chainLabel: 'eip155:31337' }, console: { monthlyQuota: 1000 }, pricing: {} },
    db, svc: {}, remit: { store, registry, orchestrator, platform, quoteCfg: quoteCfg() },
    requireAuth: async (ctx) => ctx.org, requireSession: async () => { throw new HttpError(401, 'unauthorized', 'a console session is required'); },
  });
  const call = async (route, { org = 'o1', headers = {}, bodyJson = '{}', query = '', params = {} } = {}) => {
    try {
      const out = await handlers.get(route)({ org, req: { headers }, params, query: new URLSearchParams(query), body: async () => JSON.parse(bodyJson) });
      return out instanceof HttpResult ? { status: out.status, body: out.body } : { status: 200, body: out };
    } catch (e) { return refusal(e); }
  };
  return { db, store, registry, call };
}

/** What the Java check reads, as rows: the same three questions the reference asked its store. */
const snapshotOf = async (w) => ({
  quotes: Object.fromEntries((await w.db.prepare('SELECT id, org_id, response, expires_at FROM remit_quotes ORDER BY id').all()).map((q) => [q.id, { org: q.org_id, response: q.response, expires_at: q.expires_at }])),
  institutions: Object.fromEntries((await w.registry.list()).map((i) => [i.id, i])),
  payments: (await w.db.prepare('SELECT id FROM remit_payments ORDER BY id').all()).map((p) => p.id),
});

// ── acceptance ──────────────────────────────────────────────────────────────────────────────────────────────────
const compliance = { originator: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi, Ho Chi Minh City', registration_number: '0312345678' },
  beneficiary: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: '123-456-789', bank: 'Demo Payout Bank' }, purpose_code: 'GDI' };
const baseRequest = (over = {}) => ({
  request_id: 'REQ-B1-0001', payment_id: PAY, quote_id: 'QT-B1-GOOD', corridor: { origin: 'VN', destination: 'SG' },
  amount: { collected: { currency: 'VND', value: goodQuote.collect.amount }, payout: { currency: 'SGD', value: goodQuote.payout.amount } },
  bank_authorization: M.authorization.payload, bank_signature: M.authorization.sig,
  commercial_reference: { invoice_ref: 'INV-B1-0001' }, beneficiary: { institution_id: BFI.id, beneficiary_ref: 'BEN-1' },
  compliance_payload: compliance,
  evidence_elements: { bankInstruction: M.instructions.base, bankApproval: M.approval, commercialDocs: M.docs },
  ...over,
});
const withInstruction = (name, over = {}) => baseRequest({ evidence_elements: { bankInstruction: M.instructions[name], bankApproval: M.approval, commercialDocs: M.docs }, ...over });
const modeB = (assertion, over = {}) => baseRequest({ compliance_payload: { mode: 'B', ciphertext: M.modeB.ciphertext, ivms101_digest: M.modeB.digest, ...(assertion ? { fields_assertion: assertion } : {}), ...over } });
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
const tampered = (el, over) => ({ ...el, ...over });
const acceptCases = [
  // accepted
  ['an instruction made from the bank\'s own data', baseRequest()],
  ['mode B', modeB(M.modeB.good)],
  ['mode B with further members in the statement', modeB(M.modeB.extraMembers)],
  ['made from a message, every reference given', withInstruction('srcFull')],
  ['made from a message, type and digest only', withInstruction('srcBare')],
  ['a source reference that is null', withInstruction('srcNull')],
  ['no request id', without(baseRequest(), 'request_id')],
  ['a request id that is a number', baseRequest({ request_id: 77 })],
  ['members nobody reads, and one named like the stored plaintext', baseRequest({ note: { a: [1, 2] }, compliance_plaintext: 'the client\'s own member of that name', 7: 'seven' })],
  ['an element whose unsigned members were changed', baseRequest({ evidence_elements: { bankInstruction: M.instructions.base, bankApproval: M.approval, commercialDocs: tampered(M.docs, { attached: [], citedOnly: ['invoice'] }) } })],
  ['a beneficiary institution whose encryption key is the JSON null', baseRequest({ beneficiary: { institution_id: 'SG-BFI-NULLENC' } })],
  ['the shortest payment id', withInstruction('ref:ABCD', { payment_id: 'ABCD' })],
  ['the longest payment id', withInstruction(`ref:P${'9'.repeat(63)}`, { payment_id: `P${'9'.repeat(63)}` })],
  // the payment id
  ['no payment id', without(baseRequest(), 'payment_id')],
  ...['', 'abc', `P${'9'.repeat(64)}`, 'reconcile', 'bundle', 'PAY 1', `${PAY}\n`, '-PAY-1', '_PAY1', 'PAY.B1', 'ＰＡＹ１'].map((id) => [`payment id ${JSON.stringify(id)}`, baseRequest({ payment_id: id })]),
  ['payment id null', baseRequest({ payment_id: null })],
  ['payment id that is an object', baseRequest({ payment_id: {} })],
  ['payment id that is a number', baseRequest({ payment_id: 12345 }), D18],
  ['payment id that is true', baseRequest({ payment_id: true }), D18],
  ['payment id that is a list of one text', baseRequest({ payment_id: [PAY] }), D18],
  // an id that is taken comes before the quote, a missing quote id before that
  ['a payment id that is taken', withInstruction('ref:PAY-B1-TAKEN', { payment_id: 'PAY-B1-TAKEN' })],
  ['a payment id that is another organisation\'s', withInstruction('ref:PAY-B1-OTHERS', { payment_id: 'PAY-B1-OTHERS' })],
  ['a payment id that is taken, and a quote nobody has', withInstruction('ref:PAY-B1-TAKEN', { payment_id: 'PAY-B1-TAKEN', quote_id: 'QT-NOBODY' })],
  ['a payment id that is taken, and no quote id', without(withInstruction('ref:PAY-B1-TAKEN', { payment_id: 'PAY-B1-TAKEN' }), 'quote_id')],
  // the quote
  ['no quote id', without(baseRequest(), 'quote_id')],
  ['an empty quote id', baseRequest({ quote_id: '' })],
  ['a quote id that is null', baseRequest({ quote_id: null })],
  ['a quote nobody has', baseRequest({ quote_id: 'QT-NOBODY' })],
  ['another organisation\'s quote', baseRequest({ quote_id: 'QT-B1-OTHER' })],
  ['an expired quote', baseRequest({ quote_id: 'QT-B1-EXPIRED' })],
  ['an expired quote and wrong amounts', baseRequest({ quote_id: 'QT-B1-EXPIRED', amount: {} })],
  ['a stored quote that is an empty object', baseRequest({ quote_id: 'QT-B1-BROKEN' })],
  ['a stored quote that is null', baseRequest({ quote_id: 'QT-B1-NULL' })],
  // the amounts
  ['no amount', without(baseRequest(), 'amount')],
  ['an amount that is text', baseRequest({ amount: 'much' })],
  ['collected in another currency', baseRequest({ amount: { collected: { currency: 'USD', value: goodQuote.collect.amount }, payout: { currency: 'SGD', value: goodQuote.payout.amount } } })],
  ['another collected value', baseRequest({ amount: { collected: { currency: 'VND', value: '254434501' }, payout: { currency: 'SGD', value: goodQuote.payout.amount } } })],
  ['a collected value that is a number', baseRequest({ amount: { collected: { currency: 'VND', value: Number(goodQuote.collect.amount) }, payout: { currency: 'SGD', value: goodQuote.payout.amount } } })],
  ['another payout value', baseRequest({ amount: { collected: { currency: 'VND', value: goodQuote.collect.amount }, payout: { currency: 'SGD', value: '13350.0' } } })],
  ['no payout', baseRequest({ amount: { collected: { currency: 'VND', value: goodQuote.collect.amount } } })],
  ['both legs wrong', baseRequest({ amount: { collected: { currency: 'VND', value: '1' }, payout: { currency: 'SGD', value: '1' } } })],
  // the receiving institution
  ['no beneficiary', without(baseRequest(), 'beneficiary')],
  ['a beneficiary that is text', baseRequest({ beneficiary: BFI.id })],
  ['an empty institution id', baseRequest({ beneficiary: { institution_id: '' } })],
  ['an institution nobody registered', baseRequest({ beneficiary: { institution_id: 'SG-BFI-NOBODY' } })],
  ['an institution in another role', baseRequest({ beneficiary: { institution_id: 'SG-PAYBANK-B1' } })],
  ['the bank itself as the beneficiary institution', baseRequest({ beneficiary: { institution_id: BANK.id } })],
  ['an institution without an encryption key', baseRequest({ beneficiary: { institution_id: 'SG-BFI-NOENC' } })],
  ['wrong amounts and no beneficiary', baseRequest({ amount: {}, beneficiary: undefined })],
  // the bank's authorisation
  ['no authorisation', without(baseRequest(), 'bank_authorization')],
  ['an authorisation that is text', baseRequest({ bank_authorization: 'yes' })],
  ['an authorisation that is a list', baseRequest({ bank_authorization: [M.authorization.payload] })],
  ['no signature', without(baseRequest(), 'bank_signature')],
  ['a signature that is an empty object', baseRequest({ bank_signature: {} })],
  ['a signature that is text', baseRequest({ bank_signature: M.authorization.sig.sig })],
  ['a signature with an empty sig', baseRequest({ bank_signature: { ...M.authorization.sig, sig: '' } })],
  ['a signature of another bank', baseRequest({ bank_signature: M.authorization.sigByBank2 })],
  ['an authorisation changed after it was signed', baseRequest({ bank_authorization: { ...M.authorization.payload, amount: '10000.01' } })],
  ['an authorisation with a fraction in it', baseRequest({ bank_authorization: { ...M.authorization.payload, rate: 1.5 } })],
  ['a signature under another algorithm name', baseRequest({ bank_signature: { ...M.authorization.sig, alg: 'RS256' } })],
  ['a signature whose sig is a number', baseRequest({ bank_signature: { ...M.authorization.sig, sig: 5 } })],
  ['no authorisation and no beneficiary', without(baseRequest(), 'bank_authorization', 'beneficiary')],
  // travel rule, mode A
  ['no compliance payload', without(baseRequest(), 'compliance_payload')],
  ['a compliance payload that is null', baseRequest({ compliance_payload: null })],
  ['a compliance payload that is text', baseRequest({ compliance_payload: 'kyc done' })],
  ['a compliance payload that is a list', baseRequest({ compliance_payload: [compliance] })],
  ...['originator.name', 'originator.country', 'originator.address', 'originator.registration_number', 'beneficiary.name', 'beneficiary.country', 'beneficiary.account', 'beneficiary.bank'].map((f) => {
    const [a, b] = f.split('.');
    return [`compliance payload without ${f}`, baseRequest({ compliance_payload: { ...compliance, [a]: without(compliance[a], b) } })];
  }),
  ['a blank originator name and an account that is a number', baseRequest({ compliance_payload: { ...compliance, originator: { ...compliance.originator, name: ' \t' }, beneficiary: { ...compliance.beneficiary, account: 123456789 } } })],
  ['an originator that is text', baseRequest({ compliance_payload: { ...compliance, originator: 'Vina Trading' } })],
  ['mode b in lower case is mode A', baseRequest({ compliance_payload: { ...compliance, mode: 'b' } })],
  ['mode A written out', baseRequest({ compliance_payload: { ...compliance, mode: 'A' } })],
  ['no compliance payload and a bad signature', without(baseRequest({ bank_signature: M.authorization.sigByBank2 }), 'compliance_payload')],
  // travel rule, mode B
  ['mode B without a statement', modeB(null)],
  ['mode B without ciphertext', modeB(M.modeB.good, { ciphertext: undefined })],
  ['mode B with an empty ciphertext', modeB(M.modeB.good, { ciphertext: '' })],
  ['mode B without a digest', modeB(M.modeB.good, { ivms101_digest: undefined })],
  ['mode B with a digest in capitals', modeB(M.modeB.good, { ivms101_digest: M.modeB.digest.toUpperCase() })],
  ['mode B with a digest that is a list of one text', modeB(M.modeB.good, { ivms101_digest: [M.modeB.digest] })],
  ['mode B with a statement about another payment', modeB(M.modeB.otherPayment)],
  ['mode B with a statement that says "true" as text', modeB(M.modeB.notPresent)],
  ['mode B with a statement about another digest', modeB(M.modeB.otherDigest)],
  ['mode B with a statement about another ciphertext', modeB(M.modeB.otherCiphertext)],
  ['mode B with a statement that names no ciphertext', modeB(M.modeB.noCiphertextHash)],
  ['mode B with a statement another bank signed', modeB(M.modeB.byBank2)],
  ['mode B with a statement without its signature', modeB({ payload: M.modeB.good.payload })],
  ['mode B with a statement without its payload', modeB({ sig: M.modeB.good.sig })],
  ['mode B with a statement that is text', modeB('signed')],
  ['mode B with another ciphertext than the one vouched for', modeB(M.modeB.good, { ciphertext: `${M.modeB.ciphertext}x` })],
  ['mode B with a ciphertext that is a number', modeB(M.modeB.good, { ciphertext: 5 })],
  ['mode B with a ciphertext that is a list', modeB(M.modeB.good, { ciphertext: [1, 2, 3] })],
  // the evidence elements
  ['no evidence elements', without(baseRequest(), 'evidence_elements')],
  ['evidence elements that are text', baseRequest({ evidence_elements: 'attached' })],
  ...['bankInstruction', 'bankApproval', 'commercialDocs'].map((k) => [`no ${k}`, baseRequest({ evidence_elements: without({ bankInstruction: M.instructions.base, bankApproval: M.approval, commercialDocs: M.docs }, k) })]),
  ['an instruction that is text', baseRequest({ evidence_elements: { bankInstruction: 'signed', bankApproval: M.approval, commercialDocs: M.docs } })],
  ['an instruction changed after it was signed', baseRequest({ evidence_elements: { bankInstruction: tampered(M.instructions.base, { amount: '10000.01' }), bankApproval: M.approval, commercialDocs: M.docs } })],
  ['an instruction another bank signed', withInstruction('byBank2')],
  ['an instruction without its signature', baseRequest({ evidence_elements: { bankInstruction: without(M.instructions.base, 'signature'), bankApproval: M.approval, commercialDocs: M.docs } })],
  ['an approval whose signature value is a number', baseRequest({ evidence_elements: { bankInstruction: M.instructions.base, bankApproval: { ...M.approval, signature: { ...M.approval.signature, value: 5 } }, commercialDocs: M.docs } })],
  ['documents changed after they were signed, and no approval', baseRequest({ evidence_elements: { bankInstruction: M.instructions.base, commercialDocs: tampered(M.docs, { amount: '1.00' }) } })],
  // the instruction against the quote and the id
  ['an instruction for another amount', withInstruction('amount9999')],
  ['an instruction whose amount is a number', withInstruction('amountNumber')],
  ['an instruction in another currency', withInstruction('eur')],
  ['an instruction that names another payment', withInstruction('otherRef')],
  // the reference to the bank's message
  ['a source reference with a UETR that is none', withInstruction('srcBadUetr')],
  ['a source reference that is text', withInstruction('srcText')],
];
const accept = [];
let acceptWorld = null;
for (const [name, request, java] of acceptCases) {
  const w = await world();
  if (!acceptWorld) acceptWorld = await snapshotOf(w);
  const bodyJson = JSON.stringify(request);
  const res = await w.call('POST /v1/settlements', { headers: { 'idempotency-key': `b1-key-${accept.length}` }, bodyJson });
  const c = { name, bodyJson, answer: res };
  if (res.status === 202) {
    c.answer = { status: 202, body: { ...res.body, accepted_at: '<time>' } };
    const p = await w.store.get(res.body.payment_id);
    const blank = (payload) => { const o = JSON.parse(payload); for (const k of ['accepted_at', 'verified_at']) if (k in o) o[k] = '<time>'; return JSON.stringify(o); };
    c.stored = {
      payment: Object.fromEntries(Object.entries(p).filter(([k]) => !['created_at', 'updated_at'].includes(k))),
      events: (await w.store.events(p.id)).map((e) => ({ seq: e.seq, type: e.type, issuer: e.issuer, payload: blank(e.payload), signed: e.sig !== null })),
      sourceRef: (await w.db.prepare('SELECT payment_id, org_id, message_type, sha256, idx, uetr, value_date, content, twin_key FROM remit_source_refs WHERE payment_id = ?').get(p.id)) ?? null,
      idempotency: await w.store.idempotencyHit('o1', `b1-key-${accept.length}`),
    };
    c.stored.idempotency.response_body = JSON.stringify({ ...JSON.parse(c.stored.idempotency.response_body), accepted_at: '<time>' });
  }
  if (java) { c.java = { status: 400, body: { error: 'invalid_payment_id', message: 'payment_id must be 4–64 chars of [A-Za-z0-9_-] and not a reserved word' } }; c.why = java; }
  accept.push(c);
  await w.db.close();
}
// What happens inside the transaction, where the Java check has already passed: recorded, and held by the store tests.
const inTransaction = [];
for (const [name, request] of [['a request id that is a fraction', baseRequest({ request_id: 1.5 })], ['a signature envelope with a fraction in it', baseRequest({ bank_signature: { ...M.authorization.sig, weight: 0.5 } })]]) {
  const w = await world();
  const bodyJson = JSON.stringify(request);
  const res = await w.call('POST /v1/settlements', { headers: { 'idempotency-key': 'b1-key-tx' }, bodyJson });
  inTransaction.push({ name, bodyJson, answer: res, left: { payments: (await snapshotOf(w)).payments.includes(PAY), events: (await w.store.events(PAY)).length } });
  await w.db.close();
}
// The request's own layer: the key, its stored answer, and the id — through the same handler.
const route = [];
{
  const w = await world();
  const ok = JSON.stringify(baseRequest());
  const post = async (name, headers, bodyJson) => { route.push({ name, headers, bodyJson, answer: await w.call('POST /v1/settlements', { headers, bodyJson }) }); };
  await post('no key', {}, ok);
  await post('a key of seven characters', { 'idempotency-key': '1234567' }, ok);
  await post('a key of seven characters and a body that could not be accepted', { 'idempotency-key': '1234567' }, '{}');
  await post('accepted', { 'idempotency-key': 'b1-route-1' }, ok);
  await post('the same key and the same body again', { 'idempotency-key': 'b1-route-1' }, ok);
  await post('the same key, the same members in another order', { 'idempotency-key': 'b1-route-1' }, JSON.stringify(Object.fromEntries(Object.entries(baseRequest()).reverse())));
  await post('the same key, a body that could not be accepted', { 'idempotency-key': 'b1-route-1' }, '{}');
  await post('another key, the same body', { 'idempotency-key': 'b1-route-2' }, ok);
  await post('a refusal', { 'idempotency-key': 'b1-route-3' }, JSON.stringify(baseRequest({ quote_id: 'QT-NOBODY', payment_id: 'PAY-B1-0002' })));
  await post('the refused key again, with another body', { 'idempotency-key': 'b1-route-3' }, JSON.stringify(baseRequest({ quote_id: 'QT-STILL-NOBODY', payment_id: 'PAY-B1-0002' })));
  for (const r of route) if (r.answer.status === 202) r.answer.body = { ...r.answer.body, accepted_at: '<time>' };
  await w.db.close();
}

// ── the refusal of a second settlement for a message ────────────────────────────────────────────────────────────
const conflicts = [];
for (const name of ['MSG', 'UETR', 'REUSED', 'TWIN', 'UNDATED']) {
  const w = await world();
  const send = (which, n) => w.call('POST /v1/settlements', { headers: { 'idempotency-key': `b1-conflict-${name}-${n}` },
    bodyJson: JSON.stringify(withInstruction(`${name}:${which}`, { payment_id: `PAY-B1-${name}-${n}` })) });
  const first = await send('first', 1);
  if (first.status !== 202) throw new Error(`conflict ${name}: the first settlement was not accepted: ${JSON.stringify(first)}`);
  const second = await send('second', 2);
  conflicts.push({ name, sourceMessageJson: JSON.stringify(M.instructions[`${name}:second`].sourceMessage), answer: second,
    recognitions: await w.db.prepare('SELECT sha256, idx, payment_id FROM remit_source_matches ORDER BY sha256, idx').all(),
    uetrOfFirst: (await w.db.prepare('SELECT uetr FROM remit_source_refs WHERE payment_id = ?').get(`PAY-B1-${name}-1`)).uetr,
    secondExists: !!(await w.store.get(`PAY-B1-${name}-2`)) });
  await w.db.close();
}

// ── the bank's statement in mode B ──────────────────────────────────────────────────────────────────────────────
const expectB = { paymentId: PAY, ivms101Digest: M.modeB.digest, ciphertext: M.modeB.ciphertext, bankSpki: SPKI.bank };
const assertionCases = [
  ['the statement as it should be', M.modeB.good, {}], ['further members', M.modeB.extraMembers, {}], ['none', undefined, {}], ['null', null, {}], ['text', 'signed', {}],
  ['no payload', { sig: M.modeB.good.sig }, {}], ['no signature', { payload: M.modeB.good.payload }, {}], ['a payload changed after it was signed', { payload: { ...M.modeB.good.payload, note: 1 }, sig: M.modeB.good.sig }, {}],
  ['signed by another bank', M.modeB.byBank2, {}], ['the right statement under another bank\'s key', M.modeB.good, { bankSpki: SPKI.bank2 }], ['another payment', M.modeB.otherPayment, {}],
  ['the statement for another payment id', M.modeB.good, { paymentId: 'PAY-B1-9999' }], ['"true" as text', M.modeB.notPresent, {}], ['another digest', M.modeB.otherDigest, {}],
  ['the digest in capitals expected', M.modeB.good, { ivms101Digest: M.modeB.digest.toUpperCase() }], ['another ciphertext hash', M.modeB.otherCiphertext, {}], ['no ciphertext hash', M.modeB.noCiphertextHash, {}],
  ['another ciphertext submitted', M.modeB.good, { ciphertext: `${M.modeB.ciphertext} ` }], ['a ciphertext with half a surrogate pair', M.modeB.good, { ciphertext: 'jwe\ud83d' }],
  ['a signature under another algorithm name', { payload: M.modeB.good.payload, sig: { ...M.modeB.good.sig, alg: 'ES384' } }, {}], ['a payload that is a number', { payload: 5, sig: M.modeB.good.sig }, {}],
];
const fieldsAssertion = assertionCases.map(([name, assertion, over]) => {
  const expect = { ...expectB, ...over };
  return { name, assertionJson: assertion === undefined ? null : JSON.stringify(assertion), ...expect, answer: answer(() => fieldsAssertionProblem(assertion, expect)) };
});

// ── cursors ─────────────────────────────────────────────────────────────────────────────────────────────────────
const cursors = { issued: [], read: [] };
{
  const w = await world();
  const rows = [['PAY-CUR-1', '2026-11-18T06:00:00.000Z'], ['PAY-CUR-2', '2026-11-18T06:00:00.000Z'], ['PAY-CUR-3', '2026-11-18T06:00:00.001Z'], ['PAY_CUR-é', '2026-11-18T06:00:01.000Z']];
  await w.db.prepare("DELETE FROM remit_payments WHERE org_id = 'o1'").run();
  for (const [id, at] of rows) {
    await w.store.create(basePayment('o1', id, 'QT-B1-GOOD'));
    await w.db.prepare('UPDATE remit_payments SET created_at = ? WHERE id = ?').run(at, id);
  }
  let cursor;
  for (;;) {
    const page = await w.store.search('o1', { limit: 1, ...(cursor ? { cursor } : {}) });
    if (!page.nextCursor) break;
    cursors.issued.push({ c: page.items[0].created_at, i: page.items[0].id, cursor: page.nextCursor });
    cursor = page.nextCursor;
  }
  const good = cursors.issued[0].cursor;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
  for (const text of [good, `${good}==`, good.replace(/-/g, '+').replace(/_/g, '/'), ` ${good} `, `${good.slice(0, 10)}\n${good.slice(10)}`, `${good}!`, good.slice(0, -3), 'not a cursor', 'AAAA',
    b64('null'), b64('[]'), b64('"text"'), b64('7'), b64('{}'), b64('{"c":"2026"}'), b64('{"i":"PAY-1"}'), b64('{"c":1,"i":"PAY-1"}'), b64('{"c":"2026","i":2}'), b64('{"c":"2026","i":"PAY-1","x":1}'),
    b64('{"c":"","i":""}'), b64('{"c":"2026","i":"PAY-1"} trailing'), b64('{"i":"PAY-1","c":"2026"}'), b64('{"c":null,"i":null}'), Buffer.from('{"c":"2026","i":"PAY-1"}').toString('base64')]) {
    const res = await answerAsync(() => w.store.search('o1', { cursor: text }));
    cursors.read.push({ cursor: text, refused: !res.value, ...(res.value ? {} : { answer: res }) });
  }
  await w.db.close();
}

// ── keys ────────────────────────────────────────────────────────────────────────────────────────────────────────
const km = JSON.parse(readFileSync(KEY_MATERIALS, 'utf8'));
const p256 = km.spki.p256;
const der = (b) => Buffer.from(b, 'base64');
const compressed = (() => {
  const d = der(p256); const point = d.subarray(d.length - 65);
  return Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([point[64] & 1 ? 0x03 : 0x02]), point.subarray(1, 33)]).toString('base64');
})();
const offCurve = (() => { const d = Buffer.from(der(p256)); d[d.length - 1] ^= 0x01; return d.toString('base64'); })();
const p256Forms = [['as issued', p256], ['in base64url', p256.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')], ['with line breaks', p256.replace(/(.{20})/g, '$1\n')],
  ['with spaces around', `  ${p256}  `], ['without its padding', p256.replace(/=+$/, '')], ['with one byte more', Buffer.concat([der(p256), Buffer.from([0])]).toString('base64')],
  ['twice', Buffer.concat([der(p256), der(p256)]).toString('base64')], ['compressed point', compressed], ['a point off the curve', offCurve], ['with a comment', `${p256} # production key`],
  ['mentioning PRIVATE KEY', `${p256} PRIVATE KEY`], ['cut short', p256.slice(0, 60)]];
const keyTexts = [...Object.entries(km.spki).map(([k, v]) => [`SPKI ${k}`, v]), ...Object.entries(km.private).map(([k, v]) => [`private ${k}`, v]), ['PEM public key (SPKI)', km.pem.p256Public],
  ['RSA public key as PKCS#1 DER', km.other.rsaPublicPkcs1], ...p256Forms.map(([n, v]) => [`P-256 ${n}`, v]), ['empty', ''], ['the sign-up placeholder', 'DEMO-PUBLIC-KEY-PLACEHOLDER'], ['AAAA', 'AAAA'],
  ['not base64 at all', '!!! not a key !!!'], ['a JWK', '{"kty":"EC","crv":"P-256"}'], ['a DER sequence of nothing', 'MAA=']];
const converts = (text) => { try { spkiToJwk(text); return true; } catch { return false; } };
const keys = {
  converts: keyTexts.map(([name, text]) => ({ name, text, converts: converts(text) })),
  verify: { payload: M.keySample.payload, sig: M.keySample.sig, forms: [...p256Forms, ['another P-256 key', SPKI.bank], ['an RSA key', km.spki.rsa], ['P-384', km.spki.p384], ['explicit parameters of another key', km.spki.p256Explicit]]
    .map(([name, text]) => ({ name, text, verifies: verifyEvent(M.keySample.payload, M.keySample.sig, text) })) },
  platform: { pem: M.pem.platform, spki: platform.publicSpkiBase64, keyId: platform.keyId },
};

// ── the registry: snapshot and keyring of its rows ──────────────────────────────────────────────────────────────
const registry = [];
{
  const w = await world();
  const record = async (name) => {
    const errors = []; const original = console.error; console.error = (...a) => errors.push(a.map(String).join(' '));
    let ring; try { ring = [...(await w.registry.keyring()).keys()]; } finally { console.error = original; }
    const snapshot = await w.registry.snapshot();
    registry.push({ name, rows: await w.registry.list(), keyring: ring, leftOut: errors, snapshot: { ...snapshot, taken_at: '<time>' } });
  };
  await record('the world of the acceptance cases');
  await w.registry.upsert({ id: 'KR-BANK-PLACEHOLDER', role: 'COLLECTION_BANK', name: 'Another tenant', org_id: null, signing_spki: 'DEMO-PUBLIC-KEY-PLACEHOLDER' });
  await w.registry.upsert({ id: 'KR-EX-BRAINPOOL', role: 'EXCHANGE', name: 'A third tenant', signing_spki: km.spki.brainpoolP256r1 });
  await w.registry.upsert({ id: 'KR-EX-RSA', role: 'EXCHANGE', name: 'An RSA key converts and verifies nothing', signing_spki: km.spki.rsa });
  await w.registry.upsert({ id: 'KR-EX-PSS', role: 'EXCHANGE', name: 'RSA-PSS does not convert', signing_spki: km.spki.rsaPss });
  await w.registry.upsert({ id: 'KR-NOKEY', role: 'LOCAL_PAYOUT_BANK', name: 'No key at all', country: 'KR', authority: ['x'] });
  await w.registry.upsert({ id: 'STONEHASH', role: 'STONEHASH', name: 'StoneHash (platform)', signing_spki: platform.publicSpkiBase64,
    authority: ['REQUEST_ACCEPTED', 'BANK_AUTHORIZATION_VERIFIED', 'TRAVEL_RULE_SENT', 'SETTLEMENT_INSTRUCTED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'EVIDENCE_ANCHORED', 'webhook'] });
  await record('with keys that do not convert, a key that converts and is no P-256 key, and the platform');
  // upsert: what is not given stays, what is given replaces
  await w.registry.upsert({ id: BFI.id, role: 'BENEFICIARY_FI', name: 'Renamed' });
  await w.registry.upsert({ id: BANK.id, role: 'COLLECTION_BANK', name: BANK.name, country: 'VN', signing_spki: SPKI.bank2, encryption_jwk: { kty: 'none' } });
  await record('after registering two of them again with fewer members');
  await w.db.close();
}

// ── evidence ────────────────────────────────────────────────────────────────────────────────────────────────────
const NONCE = 'ab'.repeat(32);
const evidenceCases = [];
async function evidenceCase(name, { receipt = 'receipt', instruction = 'bankInstruction', chain = true, completions, extraRows = false, bankSpki = SPKI.bank, level = 'L3' } = {}) {
  const w = await world();
  await w.registry.upsert({ id: BANK.id, role: 'COLLECTION_BANK', name: BANK.name, country: 'VN', org_id: 'o1', signing_spki: bankSpki, authority: ['bankInstruction', 'bankApproval', 'commercialDocs'] });
  if (extraRows) {
    await w.registry.upsert({ id: 'KR-BANK-PLACEHOLDER', role: 'COLLECTION_BANK', name: 'Another tenant', signing_spki: 'DEMO-PUBLIC-KEY-PLACEHOLDER' });
    await w.registry.upsert({ id: 'KR-EX-BRAINPOOL', role: 'EXCHANGE', name: 'A third tenant', signing_spki: km.spki.brainpoolP256r1 });
    await w.registry.upsert({ id: 'KR-EX-RSA', role: 'EXCHANGE', name: 'An RSA key', signing_spki: km.spki.rsa });
  }
  await w.store.create(basePayment('o1', PAY, 'QT-B1-GOOD'));
  const E = M.evidence;
  await w.store.appendEvent(PAY, 'REQUEST_ACCEPTED', 'STONEHASH', { payment_id: PAY, request_id: null, quote_id: 'QT-B1-GOOD', accepted_at: iso(0) }, { alg: 'ES256', key_id: platform.keyId, issuer: 'STONEHASH', sig: 'c2lnbmF0dXJl' });
  await w.store.appendEvent(PAY, 'BANK_EVIDENCE_SUBMITTED', BANK.id, { bankInstruction: E[instruction], bankApproval: E.bankApproval, commercialDocs: E.commercialDocs });
  await w.store.appendEvent(PAY, 'PAYOUT_ACCEPTED', BFI.id, { payment_id: PAY, deposit_address: E.travelRule.approvedBeneficiaryAddress, travel_rule_element: E.travelRule });
  if (chain) await w.store.appendEvent(PAY, 'USDC_TRANSFER_CONFIRMED', SETTLE.id, { payment_id: PAY, tx_hash: E.chainTransfer.txRef, block: 12, chain_transfer_element: E.chainTransfer });
  for (const r of completions ?? [receipt]) {
    await w.store.appendEvent(PAY, 'PAYOUT_COMPLETED', BFI.id, { payment_id: PAY, ...(E[r].bank_reference ? { bank_reference: E[r].bank_reference } : {}), evidence_level: E[r].evidence_level, payout_receipt_element: E[r] });
  }
  for (const s of ['BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED']) await w.store.transition(PAY, s);
  await w.store.patch(PAY, { evidence_level: level, deposit_address: E.travelRule.approvedBeneficiaryAddress, chain_tx: E.chainTransfer.txRef });
  const p = await w.store.get(PAY);
  const events = (await w.store.events(PAY)).map(({ id, ...e }) => e);
  const institutions = await w.registry.list();
  const original = console.error; console.error = () => {};
  const out = { name, payment: p, events, institutions, collected: JSON.stringify(collectElements(await w.store.events(PAY))), outcomes: [] };
  try {
    for (const acceptDemoFinality of [true, false]) {
      const res = await answerAsync(() => reconcilePayment(p, w.store, w.registry, acceptDemoFinality));
      if (!res.value) { out.outcomes.push({ acceptDemoFinality, answer: res }); continue; }
      const o = res.value;
      const outcome = { acceptDemoFinality, pass: o.pass, reasons: o.reasons, evidence: JSON.stringify(o.evidence), verdict: JSON.stringify(o.verdict) };
      // A package is assembled for a settlement that passed, and for no other: that is the only place the reference does it.
      if (o.pass) {
        const pkg = await assemblePackage(p, w.store, w.registry, o.evidence, o.verdict);
        outcome.package = { takenAt: pkg.trust_registry.taken_at, generatedAt: pkg.generated_at, text: JSON.stringify(pkg), nonce: NONCE, commitment: packageCommitment(pkg, NONCE) };
      }
      out.outcomes.push(outcome);
    }
  } finally { console.error = original; }
  evidenceCases.push(out);
  await w.db.close();
}
await evidenceCase('every element as its party signs it');
await evidenceCase('a receipt for another amount', { receipt: 'receiptOtherAmount' });
await evidenceCase('a receipt nobody signed', { receipt: 'receiptUnsigned', level: 'L1' });
await evidenceCase('a receipt signed with a key the registry does not hold for that name', { receipt: 'receiptByStranger' });
await evidenceCase('a signed receipt without a bank reference', { receipt: 'receiptL2', level: 'L2' });
await evidenceCase('an instruction whose declared digest is another', { instruction: 'instructionWrongDigest' });
await evidenceCase('an instruction that declares no digest', { instruction: 'instructionNoDigest' });
await evidenceCase('no transfer on the chain', { chain: false });
await evidenceCase('two completions: the first one is read', { completions: ['receiptUnsigned', 'receipt'] });
await evidenceCase('a registry with keys that do not convert', { extraRows: true });
await evidenceCase('the bank registered under another key', { bankSpki: SPKI.bank2 });
await evidenceCase('the bank\'s key registered in base64url with line breaks', { bankSpki: SPKI.bank.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').replace(/(.{30})/g, '$1\n') });

// ── chain status ────────────────────────────────────────────────────────────────────────────────────────────────
const HASH = `0x${'ef'.repeat(32)}`;
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a) => `0x${'0'.repeat(24)}${a.repeat(20)}`;
const transferLog = (over = {}) => ({ address: '0x5fbdb2315678afecb367f032d93f642f64180aa3', topics: [TOPIC, topic('cd'), topic('ab')], data: `0x${(10000_000000n).toString(16).padStart(64, '0')}`, ...over });
const ok = (result) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
const mined = (over = {}) => ({
  eth_getTransactionByHash: ok({ blockNumber: '0xc', from: `0x${'cd'.repeat(20)}`, to: '0x5fbdb2315678afecb367f032d93f642f64180aa3' }),
  eth_getTransactionReceipt: ok({ blockNumber: '0xc', status: '0x1', logs: [transferLog()] }),
  eth_blockNumber: ok('0xe'), eth_getBlockByNumber: ok({ timestamp: '0x691d2f00' }), ...over,
});
const receiptWith = (over) => ok({ blockNumber: '0xc', status: '0x1', logs: [transferLog()], ...over });
const chainScripts = [
  ['confirmed, with its transfer', HASH, 'set', mined()],
  ['not a hash', '0x1234', 'set', {}], ['a hash and a line feed', `${HASH}\n`, 'set', {}], ['63 digits', HASH.slice(0, -1), 'set', {}], ['no prefix', HASH.slice(2), 'set', {}], ['capitals', HASH.toUpperCase().replace('0X', '0x'), 'set', mined()],
  ['no node configured', HASH, 'none', {}],
  ['a transaction the node does not know', HASH, 'set', { eth_getTransactionByHash: ok(null) }],
  ['an answer without a result', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: '{"jsonrpc":"2.0","id":1}' } }],
  ['a result that is false', HASH, 'set', { eth_getTransactionByHash: ok(false) }],
  ['in the pool', HASH, 'set', { eth_getTransactionByHash: ok({ blockNumber: null }) }],
  ['a transaction that is text', HASH, 'set', { eth_getTransactionByHash: ok('0xabc') }],
  ['in a block, no receipt yet', HASH, 'set', mined({ eth_getTransactionReceipt: ok(null) })],
  ['reverted', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ status: '0x0' }) })],
  ['status 0x00 is not a revert', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ status: '0x00' }) })],
  ['no status at all', HASH, 'set', mined({ eth_getTransactionReceipt: ok({ blockNumber: '0xc', logs: [transferLog()] }) })],
  ['no logs', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [] }) })],
  ['logs missing', HASH, 'set', mined({ eth_getTransactionReceipt: ok({ blockNumber: '0xc', status: '0x1' }) })],
  ['logs that are text', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: 'none' }) })],
  ['a log of two topics, then the transfer', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [TOPIC, topic('cd')] }), transferLog({ address: '0xsecond' })] }) })],
  ['only logs of other events', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [`0x${'11'.repeat(32)}`, topic('cd'), topic('ab')] }), transferLog({ topics: [] })] }) })],
  ['the topic in capitals', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [TOPIC.toUpperCase().replace('0X', '0x'), topic('cd'), topic('ab')] })] }) })],
  ['a first topic that is a number', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [5, topic('cd'), topic('ab')] })] }) })],
  ['a log that is null', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [null] }) })],
  ['a log without topics', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [{ address: '0x1' }] }) })],
  ['topics that are text', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [{ topics: TOPIC }, transferLog()] }) })],
  ['short topics', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [TOPIC, '0xcd', 'ab'] })] }) })],
  ['a topic that is a number', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ topics: [TOPIC, 7, topic('ab')] })] }) })],
  ...[['0x', 'no data'], ['0x0', 'zero'], ['', 'empty text'], ['123', 'decimal text'], [' 0x10 ', 'hex with spaces'], ['-5', 'a negative'], ['0b101', 'binary'], ['words', 'words'], ['0x1g', 'bad hex'], [5, 'a number'],
    [1.5, 'a fraction'], [true, 'true'], [null, 'null'], [['0x10'], 'a list'], [{}, 'an object'], ['1e3', 'an exponent']].map(([data, n]) =>
    [`transfer data: ${n}`, HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [transferLog({ data })] }) })]),
  ['transfer data absent', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [(() => { const l = transferLog(); delete l.data; return l; })()] }) })],
  ['a token address that is absent', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ logs: [(() => { const l = transferLog(); delete l.address; return l; })()] }) })],
  ['no block', HASH, 'set', mined({ eth_getBlockByNumber: ok(null) })],
  ['a block without a time', HASH, 'set', mined({ eth_getBlockByNumber: ok({}) })],
  ['a time beyond what a date holds', HASH, 'set', mined({ eth_getBlockByNumber: ok({ timestamp: '0xffffffffffffff' }) })],
  ['a time in the year 10000 and after', HASH, 'set', mined({ eth_getBlockByNumber: ok({ timestamp: '0x3b9aca0000' }) })],
  ['a block that is a number', HASH, 'set', mined({ eth_getBlockByNumber: ok(5) })],
  ['a block number that is 0x', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ blockNumber: '0x' }) })],
  ['a block number that is words', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ blockNumber: 'latest' }) })],
  ['a block number that is a number', HASH, 'set', mined({ eth_getTransactionReceipt: receiptWith({ blockNumber: 12 }) })],
  ['a block number that is absent', HASH, 'set', mined({ eth_getTransactionReceipt: ok({ status: '0x1', logs: [] }) })],
  ['the head behind the receipt', HASH, 'set', mined({ eth_blockNumber: ok('0x1') })],
  ['the head at the receipt', HASH, 'set', mined({ eth_blockNumber: ok('0xc') })],
  ['a head that is words', HASH, 'set', mined({ eth_blockNumber: ok('pending') })],
  ['a head that is null', HASH, 'set', mined({ eth_blockNumber: ok(null) })],
  ['HTTP 500 at the first read', HASH, 'set', { eth_getTransactionByHash: { status: 500, body: '{"error":"internal"}' } }],
  ['HTTP 404', HASH, 'set', { eth_getTransactionByHash: { status: 404, body: 'not here' } }],
  ['a page of HTML', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: '<html><body>gateway</body></html>' } }],
  ['an empty answer', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: '' } }],
  ['JSON null', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: 'null' } }],
  ['an RPC error', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"http://user:secret@node.example refused"}}' } }],
  ['an RPC error that is false, beside a result', HASH, 'set', { eth_getTransactionByHash: { status: 200, body: '{"error":false,"result":null}' } }],
  ['HTTP 201', HASH, 'set', mined({ eth_getTransactionByHash: { status: 201, body: JSON.stringify({ result: { blockNumber: '0xc' } }) } })],
  ['HTTP 500 at the receipt', HASH, 'set', mined({ eth_getTransactionReceipt: { status: 500, body: '{}' } })],
  ['HTTP 500 at the head', HASH, 'set', mined({ eth_blockNumber: { status: 500, body: '{}' } })],
  ['HTTP 500 at the block', HASH, 'set', mined({ eth_getBlockByNumber: { status: 500, body: '{}' } })],
  ['the connection fails', HASH, 'set', { eth_getTransactionByHash: { fails: true } }],
];
const chain = [];
const realFetch = globalThis.fetch;
for (const [name, txHash, rpc, script] of chainScripts) {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    asked.push({ method: req.method, body: init.body });
    const a = script[req.method];
    if (!a || a.fails) throw new TypeError('fetch failed');
    return new Response(a.body, { status: a.status });
  };
  const original = console.error; console.error = () => {};
  let status;
  try { status = await chainTxStatus(rpc === 'set' ? 'http://node.invalid/' : '', 'eip155:31337', txHash); } finally { console.error = original; globalThis.fetch = realFetch; }
  chain.push({ name, txHash, rpc, script, answerJson: JSON.stringify(status), asked: asked.map((a) => a.body).sort() });
}

rmSync(TMP, { recursive: true, force: true });

// ── write, or compare ───────────────────────────────────────────────────────────────────────────────────────────
const texts = {
  policy: `${JSON.stringify({
    note: 'Generated by apps/core-java/tools/make-remit-b1-vectors.mjs from apps/core/src/remit/evidence.ts (REMIT_POLICY). Do not edit by hand: the policy is written into every evidence package and committed to with it.',
    policy: REMIT_POLICY }, null, 1)}\n`,
  vectors: `${JSON.stringify({
    note: 'Generated by apps/core-java/tools/make-remit-b1-vectors.mjs from apps/core/src/remit. Do not edit by hand.',
    quotes: { mul, add, build }, sourceRefs, requestHashes, cursors, keys, registry,
    accept: { now: T0, bank: acceptWorld.institutions[BANK.id], org: 'o1', world: acceptWorld, cases: accept, inTransaction, route },
    conflicts, fieldsAssertion, evidence: evidenceCases, chain,
  }, null, 1)}\n`,
};
if (check) {
  let stale = 0;
  for (const [name, file] of Object.entries(FILES)) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== texts[name]) { console.error(`${path.basename(file)} differs from what the reference answers now — run without --check and review the change`); stale++; }
  }
  if (stale) process.exit(1);
}
else for (const [name, file] of Object.entries(FILES)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, texts[name]); }
console.log(`${check ? 'current' : 'wrote'}: remit-b1.json — quotes ${mul.length} products, ${add.length} sums, ${build.length} requests; ${sourceRefs.length} source references; ${requestHashes.length} request hashes; `
  + `cursors ${cursors.issued.length} issued, ${cursors.read.length} read; keys ${keys.converts.length} offered, ${keys.verify.forms.length} forms; ${registry.length} registries; `
  + `acceptance ${accept.length} requests (${accept.filter((c) => c.answer.status === 202).length} accepted), ${inTransaction.length} in the transaction, ${route.length} at the route; ${conflicts.length} conflicts; `
  + `${fieldsAssertion.length} statements; evidence ${evidenceCases.length} logs; chain ${chain.length} scripts — and corridor-policy.json`);
