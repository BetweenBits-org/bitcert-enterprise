/**
 * Remit rail smoke — plays the bank end-to-end against a running stack
 * (core :8787, partners :3300, anvil, bitcoind regtest):
 *
 *   subscribe → quote → sign evidence + authorization → POST /v1/settlements
 *   → poll to BENEFICIARY_CREDIT_CONFIRMED → EVIDENCE_ANCHORED
 *   → fetch the package → re-derive the commitment → verify the anchor bundle.
 *
 * Uses the demo bank's own provisioned identity (state.json + HSM PEM); reads
 * the key with node crypto here because this is a test harness — the demo
 * bank app itself keeps signing inside openssl.
 */
import { readFileSync } from 'node:fs';
import { randomUUID, createPrivateKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  signEvent, signEvidenceElement, elementDigest, sha256hex,
} from '../apps/core/src/remit/sign.ts';
import { packageCommitment } from '../apps/core/src/remit/evidence.ts';
import { verifyBundle } from '../../attest/packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const BANK_DIR = path.resolve(HERE, '../../demo-bank');
const bankState = JSON.parse(readFileSync(path.join(BANK_DIR, 'state.json'), 'utf8'));
const hsmKey = createPrivateKey(readFileSync(path.join(BANK_DIR, 'hsm', 'bank-hsm.key'), 'utf8'));

const INSTITUTION = 'VN-BANK-001';
const BANK_NAME = '데모은행 (가상)';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const step = (msg) => console.log(`— ${msg}`);
const jfetch = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
};

// ── 1. console session + remit subscription ────────────────────────────────
const login = await jfetch(`${CORE}/v1/console/login`, {
  method: 'POST', body: JSON.stringify({ email: bankState.email, password: bankState.password }),
});
if (login.status !== 200) fail(`console login: ${login.status} ${JSON.stringify(login.body)}`);
const cookie = login.headers.get('set-cookie').split(';')[0];
step('console session opened');

const keys = await jfetch(`${CORE}/v1/console/issuer-keys`, { headers: { cookie } });
const issuerKey = (keys.body.data ?? keys.body.keys ?? keys.body).find?.((k) => k.public_key === bankState.issuerKey.spkiBase64)
  ?? (Array.isArray(keys.body) ? null : undefined);
if (!issuerKey) fail(`issuer key not found in console list: ${JSON.stringify(keys.body).slice(0, 300)}`);

// Keep the bank demo's webhook registration intact when the smoke re-subscribes.
const webhookUrl = process.env.REMIT_WEBHOOK_URL ?? 'http://127.0.0.1:3200/api/remit/webhook';
const sub = await jfetch(`${CORE}/v1/console/products`, {
  method: 'POST', headers: { cookie },
  body: JSON.stringify({
    product: 'remit',
    institution: { id: INSTITUTION, name: BANK_NAME, country: 'VN' },
    issuer_key_id: issuerKey.id,
    ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
  }),
});
if (sub.status !== 201) fail(`subscription: ${sub.status} ${JSON.stringify(sub.body)}`);
step(`subscribed: ${sub.body.institution_id} → ${sub.body.settlement_endpoint}`);

// ── 2. quote ────────────────────────────────────────────────────────────────
const auth = { authorization: `Bearer ${bankState.apiKey}` };
const tradeAmount = process.env.REMIT_SMOKE_AMOUNT ?? '10000.00';
const q = await jfetch(`${CORE}/v1/quotes`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    corridor: { origin: 'VN', destination: 'SG' },
    trade: { currency: 'USD', amount: tradeAmount },
    collect: { currency: 'VND' }, payout: { currency: 'SGD' },
  }),
});
if (q.status !== 201) fail(`quote: ${q.status} ${JSON.stringify(q.body)}`);
const quote = q.body;
step(`quote ${quote.quote_id}: collect ${quote.collect.amount} VND → ${quote.settlement.amount} USDC → pay ${quote.payout.amount} SGD`);

// ── 3. the bank signs its evidence and its authorization ───────────────────
const paymentId = `PAY-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6)}`;
const invoiceRef = `INV-2026-${randomUUID().slice(0, 4).toUpperCase()}`;
const now = new Date().toISOString();
const finish = (core) => {
  const withDigest = { ...core, digest: elementDigest(core) };
  return signEvidenceElement(withDigest, hsmKey, INSTITUTION, BANK_NAME);
};

const evidence_elements = {
  bankInstruction: finish({
    ref: paymentId, amount: quote.trade.amount, currency: 'USD',
    debtor: 'Vina Trading Co., Ltd.', creditor: 'Pacific Supply Pte Ltd',
    approvedAt: now,
    iso20022Fields: ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf', invoiceRef],
  }),
  bankApproval: finish({
    approvalRef: `APPR-${paymentId}`,
    regulatorReportRef: 'VN-SBV-C27-DEMO',
    approvedByRole: 'FX Compliance Officer',
    approvedAt: now,
    fxQuote: { pair: 'USD/VND', rate: quote.collect.rate, quotedAt: quote.quoted_at, validUntil: quote.expires_at },
  }),
  commercialDocs: finish({
    invoiceRef, amount: quote.trade.amount, currency: 'USD',
    buyer: 'Vina Trading Co., Ltd.', seller: 'Pacific Supply Pte Ltd',
    attached: ['invoice'], citedOnly: [],
  }),
};

const bank_authorization = {
  bank_id: INSTITUTION,
  instruction_ref: `BANK-INST-${paymentId}`,
  fiat_received_ref: `BANK-RCPT-${paymentId}`,
  kyb_status: 'VERIFIED', kyb_policy_version: '2026.3',
  trade_review: 'APPROVED', purpose_code: 'GOODS_PAYMENT',
  payment_release: 'AUTHORIZED',
  approved_at: now,
};
const bank_signature = signEvent(bank_authorization, hsmKey, INSTITUTION, BANK_NAME);

// ── 4. settle ───────────────────────────────────────────────────────────────
const settle = await jfetch(`${CORE}/v1/settlements`, {
  method: 'POST', headers: { ...auth, 'idempotency-key': `smoke-${paymentId}` },
  body: JSON.stringify({
    request_id: `REQ-${paymentId}`,
    payment_id: paymentId,
    quote_id: quote.quote_id,
    corridor: { origin: 'VN', destination: 'SG' },
    amount: {
      collected: { currency: 'VND', value: quote.collect.amount },
      payout: { currency: 'SGD', value: quote.payout.amount },
    },
    bank_authorization, bank_signature,
    commercial_reference: {
      invoice_ref: invoiceRef,
      invoice_commitment: sha256hex(`${invoiceRef}|${quote.trade.amount} USD|demo`),
    },
    beneficiary: { institution_id: 'SG-BFI-001', beneficiary_ref: 'BEN-0001' },
    compliance_payload: {
      format: 'IVMS101-2023', mode: 'A',
      originator: {
        name: 'Vina Trading Co., Ltd.', country: 'VN',
        address: '12 Le Loi Blvd, District 1, Ho Chi Minh City',
        registration_number: 'VN-0312345678', account: 'VN-ACC-000777',
      },
      beneficiary: {
        name: 'Pacific Supply Pte Ltd', country: 'SG',
        account: 'SG-ACC-000009', bank: 'DBS (sim)',
      },
      purpose_code: 'GOODS_PAYMENT',
    },
    evidence_elements,
  }),
});
if (settle.status !== 202) fail(`settlement: ${settle.status} ${JSON.stringify(settle.body)}`);
step(`settlement accepted: ${settle.body.payment_id} @ ${settle.body.state}`);

// ── 5. poll the state machine ───────────────────────────────────────────────
let last = '';
let finalView = null;
const target = process.env.REMIT_SMOKE_TARGET ?? 'EVIDENCE_ANCHORED';
for (let i = 0; i < 120; i++) {
  const view = await jfetch(`${CORE}/v1/settlements/${paymentId}`, { headers: auth });
  if (view.status !== 200) fail(`status poll: ${view.status}`);
  if (view.body.state !== last) {
    last = view.body.state;
    console.log(`  state → ${last}`);
  }
  if (last === target) { finalView = view.body; break; }
  if (['CANCELLED', 'EXCEPTION', 'RETURNED'].includes(last)) {
    console.error(JSON.stringify(view.body.events.at(-1), null, 2));
    fail(`terminal state ${last}`);
  }
  await new Promise((ok) => setTimeout(ok, 1500));
}
if (!finalView) fail(`did not reach ${target} in time`);
step(`reached ${target}; chain tx ${finalView.chain_tx}`);

// ── 6. evidence: re-derive the commitment, verify the anchor ───────────────
const ev = await jfetch(`${CORE}/v1/settlements/${paymentId}/evidence`, { headers: auth });
if (ev.status !== 200) fail(`evidence: ${ev.status} ${JSON.stringify(ev.body).slice(0, 300)}`);
const { package: pkg, commitment, attestation } = ev.body;

const recomputed = packageCommitment(pkg, commitment.nonce);
if (recomputed !== commitment.value) fail('commitment recomputation mismatch');
step('package commitment re-derived locally: match');

if (pkg.verdict.axes.matching.state !== 'MATCH') fail(`matching axis: ${pkg.verdict.axes.matching.state}`);
if (pkg.verdict.axes.issuer.state !== 'VALID') fail(`issuer axis: ${pkg.verdict.axes.issuer.state}`);
step(`six-axis verdict: integrity=${pkg.verdict.axes.integrity.state} issuer=${pkg.verdict.axes.issuer.state} matching=${pkg.verdict.axes.matching.state} finality=${pkg.verdict.axes.businessFinality.state}`);

if (!attestation?.bundle) fail('no anchor bundle in evidence response');
if (attestation.bundle.record?.leaf_bytes !== commitment.value) fail('anchored leaf is not the package commitment');
const verdict = await verifyBundle(attestation.bundle, {});
if (verdict.verified !== true) fail(`bundle verification failed: ${JSON.stringify(verdict.checks)}`);
step(`anchor bundle independently verified (${verdict.checks.length} checks) — regtest txid ${(attestation.bundle.anchor?.txid ?? attestation.bundle.anchor?.reveal_txid ?? '').slice(0, 16)}…`);

const receipt = pkg.events.find((e) => e.type === 'PAYOUT_COMPLETED');
console.log(`\n✓ smoke passed: ${paymentId}`);
console.log(`  L${''}evel ${receipt.payload.evidence_level} · FAST ref ${receipt.payload.bank_reference}`);
console.log(`  VND ${pkg.amounts.collected.value} → USDC ${pkg.amounts.settled.value} → SGD ${pkg.amounts.paid.value}`);
