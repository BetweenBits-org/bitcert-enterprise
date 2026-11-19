/**
 * demo-partners — the receiving-side estate, one process, three keys.
 *
 *   [key 1] SG-BFI-001         Triple-A profile BFI (SG MPI sim): decrypts the
 *           Travel Rule JWE, screens, pre-approves payouts, watches the chain,
 *           runs FX, instructs the local bank, signs PAYOUT_COMPLETED (L3).
 *   [key 2] SG-PAYBANK-001     FAST payout bank sim: beneficiary ledger,
 *           credit references, its own signed credit confirmations.
 *   [key 3] SETTLE-ENTITY-001  licensed settlement entity sim: policy-checks
 *           the platform's instruction, moves mUSDC on the chain.
 *
 * One process for operability; three private keys so no institution can sign
 * another's facts — the separation the evidence model rests on is enforced by
 * which PEM each code path can reach, which is the honest sandbox version of
 * "separate HSMs".
 *
 * Everything here is synthetic. The names Triple-A and FAST identify the
 * *profile* being simulated, not a live integration.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decryptJwe, finishElement, elementDigest, signPayload, verifyEvent, privateKeyFromPem,
  sha256hex, jcs,
} from './lib/crypto.mjs';
import { AnvilChain, MockChain, usdcUnits, unitsToUsdc } from './chain/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3300);
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const BACKEND = process.env.CHAIN_BACKEND ?? 'anvil';
const ANVIL_URL = process.env.ANVIL_URL ?? 'http://127.0.0.1:8545';
const EVIDENCE_LEVEL = process.env.PARTNERS_EVIDENCE_LEVEL ?? 'L3';
const USD_SGD = process.env.PARTNERS_RATE_USD_SGD ?? '1.3350';

const state = JSON.parse(readFileSync(path.join(HERE, 'state.json'), 'utf8'));
const KEYS = {
  bfi: readFileSync(path.join(HERE, 'keys', 'bfi.key'), 'utf8'),
  sgbank: readFileSync(path.join(HERE, 'keys', 'sgbank.key'), 'utf8'),
  wallet: readFileSync(path.join(HERE, 'keys', 'wallet.key'), 'utf8'),
  bfiEnc: readFileSync(path.join(HERE, 'keys', 'bfi-enc.key'), 'utf8'),
};
const BFI = 'SG-BFI-001';
const SGBANK = 'SG-PAYBANK-001';
const WALLET = 'SETTLE-ENTITY-001';
const BFI_NAME = 'Triple-A profile BFI (sim)';
const SGBANK_NAME = 'SG Payout Bank (FAST sim)';
const WALLET_NAME = 'Licensed Settlement Entity (sim)';

// ── Durable partner-side books ─────────────────────────────────────────────
const LEDGER_FILE = path.join(HERE, 'data', 'bfi-ledger.json');
const ACCOUNTS_FILE = path.join(HERE, 'data', 'sg-accounts.json');
/** BFI's own record per payment — its evidence source, not the platform's. */
const ledger = existsSync(LEDGER_FILE) ? JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) : {};
/** The payout bank's beneficiary accounts, keyed by account id. */
const accounts = existsSync(ACCOUNTS_FILE) ? JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) : {};
let fastSeq = Object.values(accounts).reduce((n, a) => n + a.entries.length, 0);

function persist(file, obj) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}
const saveLedger = () => persist(LEDGER_FILE, ledger);
const saveAccounts = () => persist(ACCOUNTS_FILE, accounts);

// ── Platform key (verified against /v1/remit/meta) ─────────────────────────
let platformSpki = null;
async function platformKey() {
  if (platformSpki) return platformSpki;
  const res = await fetch(`${CORE}/v1/remit/meta`, { signal: AbortSignal.timeout(5000) });
  const meta = await res.json();
  platformSpki = meta.platform_signer?.spki;
  if (!platformSpki) throw new Error('core /v1/remit/meta has no platform signer');
  return platformSpki;
}
async function requirePlatformSig(payload, sig) {
  if (!sig) throw httpErr(400, 'missing sender signature');
  const ok = verifyEvent(payload, sig, await platformKey());
  if (!ok) {
    platformSpki = null; // key may have rotated — refetch next time
    throw httpErr(400, 'sender signature does not verify against the platform key');
  }
}

// ── Chain ──────────────────────────────────────────────────────────────────
const chain = BACKEND === 'mock'
  ? new MockChain()
  : new AnvilChain(ANVIL_URL, path.join(HERE, 'data', 'chain-state.json'));
let depositCounter = Object.keys(ledger).length;

// ── BFI: travel rule ───────────────────────────────────────────────────────
function screenBeneficiary(name) {
  // Demo sanctions list: any beneficiary whose legal name contains the
  // trigger word fails screening. Visible, deterministic, obviously fake.
  return /SANCTIONED/i.test(name) ? 'HIT' : 'CLEAR';
}

async function handleTravelRule(body) {
  const { payment_id, jwe, ivms101_digest, sender } = body;
  if (!payment_id || !jwe) throw httpErr(400, 'payment_id and jwe are required');
  await requirePlatformSig({ payment_id, ivms101_digest }, sender);

  let ivms;
  try {
    ivms = JSON.parse(decryptJwe(jwe, privateKeyFromPem(KEYS.bfiEnc)).toString('utf8'));
  } catch (e) {
    throw httpErr(400, `JWE does not decrypt with this institution's key: ${e.message}`);
  }
  // The digest commitment the platform recorded must match what was sent.
  const localDigest = sha256hex(Buffer.from(jcs(ivms)));
  if (localDigest !== ivms101_digest) {
    throw httpErr(400, 'ivms101_digest does not match the decrypted message');
  }

  const up = ivms.underlyingPayment ?? {};
  const originatorName = up.originator?.originatorPersons?.[0]?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? '';
  const beneficiaryName = up.beneficiary?.beneficiaryPersons?.[0]?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? '';
  const beneficiaryAccount = up.beneficiary?.beneficiaryPersons?.[0]?.accountNumber?.[0] ?? '';
  if (!originatorName || !beneficiaryName || !beneficiaryAccount) {
    return { status: 'RFI', reason: 'originator name, beneficiary name and beneficiary account are required' };
  }
  const screening = screenBeneficiary(beneficiaryName);
  if (screening === 'HIT') {
    return { status: 'REJECTED', reason: 'beneficiary failed sanctions screening (demo list)' };
  }

  // Enhanced-due-diligence trigger (demo): trades of USD 20,000 and above
  // get an RFI before acceptance — the corridor's pre-flight gate pausing,
  // not failing.
  const tradeAmt = Number(up.transaction?.amount ?? '0');
  if (tradeAmt >= 20000 && !ledger[payment_id]?.rfi_answered) {
    const rfi_id = `RFI-${payment_id}`;
    ledger[payment_id] = {
      payment_id,
      state: 'TR_RFI',
      rfi_id,
      received_at: new Date().toISOString(),
      ivms101_digest,
      screening,
      beneficiary: { name: beneficiaryName, account: beneficiaryAccount, bank: up.beneficiaryLocalBank ?? 'DBS (sim)' },
      originator_masked: originatorName.slice(0, 2) + '***',
      trade: { amount: up.transaction?.amount ?? '', currency: up.transaction?.currency ?? '' },
    };
    saveLedger();
    return {
      status: 'RFI',
      rfi: {
        id: rfi_id,
        questions: [
          '지급 목적과 기초 무역거래의 성격을 상술해 주십시오 (EDD — USD 20,000 이상).',
          '인보이스에 대응하는 선적서류(B/L 등) 참조번호를 제시해 주십시오.',
        ],
      },
    };
  }

  const received_at = new Date().toISOString();
  const ackPayload = { payment_id, ivms101_digest, status: 'ACCEPTED', received_at };
  const ack = { payload: ackPayload, sig: signPayload(ackPayload, KEYS.bfi, BFI, BFI_NAME) };

  // What the BFI keeps is its own compliance record; the platform never sees
  // this object — only the signed ack above.
  ledger[payment_id] = {
    payment_id,
    state: 'TR_ACCEPTED',
    received_at,
    ivms101_digest,
    ack_digest: sha256hex(Buffer.from(jcs(ackPayload))),
    screening,
    beneficiary: { name: beneficiaryName, account: beneficiaryAccount, bank: up.beneficiaryLocalBank ?? 'DBS (sim)' },
    originator_masked: originatorName.slice(0, 2) + '***',
    trade: { amount: up.transaction?.amount ?? '', currency: up.transaction?.currency ?? '' },
  };
  saveLedger();
  return { status: 'ACK', ack };
}

// ── BFI: RFI answers ───────────────────────────────────────────────────────
async function handleTravelRuleResponse(body) {
  const { payment_id, jwe, answers_digest, sender } = body;
  await requirePlatformSig({ payment_id, rfi_id: ledger[payment_id]?.rfi_id ?? '', answers_digest }, sender);
  const rec = ledger[payment_id];
  if (!rec || rec.state !== 'TR_RFI') throw httpErr(409, 'no outstanding RFI for this payment');

  let message;
  try {
    message = JSON.parse(decryptJwe(jwe, privateKeyFromPem(KEYS.bfiEnc)).toString('utf8'));
  } catch (e) {
    throw httpErr(400, `answers JWE does not decrypt: ${e.message}`);
  }
  if (sha256hex(Buffer.from(jcs(message))) !== answers_digest) {
    throw httpErr(400, 'answers_digest does not match the decrypted answers');
  }
  const answers = message.answers ?? {};
  if (Object.values(answers).every((v) => !String(v ?? '').trim())) {
    return { status: 'REJECTED', reason: 'RFI answers were empty' };
  }

  const received_at = new Date().toISOString();
  const ackPayload = {
    payment_id,
    ivms101_digest: rec.ivms101_digest,
    status: 'ACCEPTED',
    via: 'RFI_RESOLVED',
    rfi_id: rec.rfi_id,
    received_at,
  };
  rec.state = 'TR_ACCEPTED';
  rec.rfi_answered = true;
  rec.ack_digest = sha256hex(Buffer.from(jcs(ackPayload)));
  saveLedger();
  return { status: 'ACK', ack: { payload: ackPayload, sig: signPayload(ackPayload, KEYS.bfi, BFI, BFI_NAME) } };
}

async function handleCancel(body) {
  const { payment_id, reason, sender } = body;
  await requirePlatformSig({ payment_id, reason }, sender);
  const rec = ledger[payment_id];
  if (rec && rec.state !== 'PAID_OUT') {
    rec.state = 'CANCELLED';
    rec.cancel_reason = reason;
    saveLedger();
  }
  return { acknowledged: true };
}

// ── BFI: payout pre-approval ───────────────────────────────────────────────
async function handlePayoutApproval(body) {
  const { sender, ...payload } = body;
  await requirePlatformSig(payload, sender);
  const { payment_id, usdc_amount, trade, payout, quote_id } = payload;
  const rec = ledger[payment_id];
  if (!rec || rec.state !== 'TR_ACCEPTED') {
    throw httpErr(409, 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)');
  }

  const deposit_address = chain.depositAddressFor(depositCounter++);
  const approved_at = new Date().toISOString();
  const valid_until = new Date(Date.now() + 15 * 60_000).toISOString();

  // The BFI's signed assertion of the whole exchange, in the evidence
  // vocabulary the six-axis engine evaluates.
  const travelRuleCore = {
    protocol: 'IVMS101/JWE',
    ivms101Digest: rec.ivms101_digest,
    originatingVasp: WALLET,
    beneficiaryVasp: BFI,
    approvalStatus: 'APPROVED',
    approvalDigest: rec.ack_digest,
    approvedAt: approved_at,
    approvedBeneficiaryAddress: deposit_address,
  };
  const travel_rule_element = finishElement(travelRuleCore, KEYS.bfi, BFI, BFI_NAME);

  const approvalPayload = {
    payment_id,
    deposit_address,
    chain: `eip155:${chain.chainId ?? 31337}`,
    asset: 'USDC',
    usdc_amount,
    approved_at,
    valid_until,
    travel_rule_element,
  };
  Object.assign(rec, {
    state: 'PRE_APPROVED',
    deposit_address, approved_at, valid_until,
    usdc_amount,
    trade, payout, quote_id: quote_id ?? null,
    watch_from_block: await chain.blockNumber(),
  });
  saveLedger();
  return { approval: { payload: approvalPayload, sig: signPayload(approvalPayload, KEYS.bfi, BFI, BFI_NAME) } };
}

// ── Settlement wallet (key 3) ──────────────────────────────────────────────
async function handleWalletTransfer(body) {
  const { instruction } = body;
  if (!instruction?.payload || !instruction.sig) throw httpErr(400, 'instruction {payload, sig} required');
  await requirePlatformSig(instruction.payload, instruction.sig);
  const { payment_id, to_address, usdc_amount } = instruction.payload;

  // Policy check — the settlement entity's own, not the platform's: the
  // destination must be an address the BFI pre-approved for exactly this
  // payment, inside its validity window, and under the per-payment cap.
  const rec = ledger[payment_id];
  if (!rec || rec.state !== 'PRE_APPROVED') throw httpErr(403, 'no pre-approved payout for this payment');
  if (rec.deposit_address !== to_address) throw httpErr(403, 'destination is not the approved deposit address');
  if (rec.usdc_amount !== usdc_amount) throw httpErr(403, 'amount differs from the approved amount');
  if (Date.parse(rec.valid_until) < Date.now()) throw httpErr(403, 'approval validity window has passed');
  if (usdcUnits(usdc_amount) > usdcUnits('50000.00')) throw httpErr(403, 'per-payment cap exceeded (sandbox: 50,000 mUSDC)');

  const sent = await chain.transferFromTreasury(to_address, usdc_amount);
  const observed_at = new Date().toISOString();

  const chainTransferCore = {
    chain: `eip155:${chain.chainId ?? 31337}`,
    asset: 'USDC',
    amount: usdc_amount,
    currency: 'USDC',
    fromAddress: sent.from,
    toAddress: to_address,
    txRef: sent.txHash,
    settlementIdMemo: payment_id,
    confirmations: 1,
    observedAt: observed_at,
  };
  const chain_transfer_element = finishElement(chainTransferCore, KEYS.wallet, WALLET, WALLET_NAME);

  const resultPayload = {
    payment_id,
    tx_hash: sent.txHash,
    block: sent.block,
    from_address: sent.from,
    to_address,
    usdc_amount,
    observed_at,
    chain_transfer_element,
  };
  rec.state = 'FUNDS_IN_FLIGHT';
  rec.tx_hash = sent.txHash;
  saveLedger();
  return { result: { payload: resultPayload, sig: signPayload(resultPayload, KEYS.wallet, WALLET, WALLET_NAME) } };
}

// ── BFI: settlement notice → watch → FX → payout → callbacks ──────────────
async function callbackCore(type, payload) {
  const body = { type, payload, sig: signPayload(payload, KEYS.bfi, BFI, BFI_NAME) };
  const res = await fetch(`${CORE}/v1/remit/callbacks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 400) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`core callback ${type} → ${res.status}: ${j.message ?? j.error ?? ''}`);
  }
}

async function handleSettlementNotice(body) {
  const { payment_id, tx_hash, sender } = body;
  await requirePlatformSig({ payment_id, tx_hash }, sender);
  const rec = ledger[payment_id];
  if (!rec) throw httpErr(404, 'unknown payment');
  // Watching is asynchronous — the notice is acknowledged, the receipt is
  // reported through callbacks once the BFI sees the funds itself.
  void watchAndPayout(payment_id).catch((e) => {
    rec.state = 'ERROR';
    rec.error = String(e.message ?? e);
    saveLedger();
    console.error(`[bfi] ${payment_id}:`, e.message);
  });
  return { acknowledged: true };
}

/**
 * Demo levers, all driven by the trade amount's cent digits so a reviewer
 * can trigger them from the bank screen without touching this process:
 *   *.13  local payout fails → USDC returned to the settlement entity
 *   *.01  completion reported at L1 (unsigned message — no credit confirm)
 *   *.02  completion reported at L2 (signed, no local bank reference)
 */
function evidenceLevelFor(rec) {
  const a = String(rec.trade?.amount ?? '');
  if (a.endsWith('.01')) return 'L1';
  if (a.endsWith('.02')) return 'L2';
  return EVIDENCE_LEVEL;
}
const payoutShouldFail = (rec) => String(rec.trade?.amount ?? '').endsWith('.13');

async function watchAndPayout(paymentId) {
  const rec = ledger[paymentId];
  const expected = usdcUnits(rec.usdc_amount);

  // 1 — the BFI trusts its own chain read, not the platform's word.
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) {
    const transfers = await chain.transfersTo(rec.deposit_address, rec.watch_from_block ?? 0);
    seen = transfers.find((t) => t.units >= expected) ?? null;
    if (!seen) await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (!seen) throw new Error('USDC not observed at the deposit address within 60s');

  rec.state = 'USDC_RECEIVED';
  rec.received_tx = seen.txHash;
  saveLedger();
  await callbackCore('USDC_RECEIVED', {
    payment_id: paymentId,
    tx_hash: seen.txHash,
    block: seen.block,
    amount: unitsToUsdc(seen.units),
    observed_at: new Date().toISOString(),
  });

  // 2 — FX and local payout over FAST (sim).
  await callbackCore('PAYOUT_SUBMITTED', {
    payment_id: paymentId,
    local_rail: 'FAST',
    submitted_at: new Date().toISOString(),
  });

  if (payoutShouldFail(rec)) {
    // The local rail refused. The BFI reports the failure, then returns the
    // USDC to the settlement entity from the deposit address it controls —
    // both facts signed, both on chain (§8-2 row seven).
    await callbackCore('PAYOUT_FAILED', {
      payment_id: paymentId,
      reason: '수취계좌 지급 불능 — FAST 거절 (데모 트리거 *.13)',
      failed_at: new Date().toISOString(),
    });
    const refund = await chain.transferToken(rec.deposit_address, chain.treasury, rec.usdc_amount);
    rec.state = 'REFUNDED';
    rec.refund_tx = refund.txHash;
    saveLedger();
    await callbackCore('USDC_RETURNED', {
      payment_id: paymentId,
      tx_hash: refund.txHash,
      block: refund.block,
      amount: rec.usdc_amount,
      returned_to: chain.treasury,
      returned_at: new Date().toISOString(),
    });
    return;
  }

  const credit = creditBeneficiary(rec);
  rec.state = 'PAID_OUT';
  rec.bank_reference = credit.reference;
  saveLedger();

  // 3 — the L3 completion: the receipt element carries the local bank's own
  // signed credit confirmation nested inside the BFI's signature.
  const paidAt = credit.credited_at;
  const level = evidenceLevelFor(rec);
  const receiptCore = {
    ref: `${paymentId}/${credit.reference}`,
    amount: rec.trade?.amount ?? rec.usdc_amount,
    currency: 'USD',
    paidAt,
    local_amount: rec.payout?.amount ?? '',
    local_currency: 'SGD',
    local_rate_pair: 'USD/SGD',
    local_rate: USD_SGD,
    quote_ref: rec.quote_id ?? '',
    evidence_level: level,
    beneficiary_bank: rec.beneficiary.bank,
    // L3 carries the local bank's reference and its own signed confirmation;
    // L2 is the BFI's signature alone; L1 is an unsigned message.
    ...(level === 'L3' ? { bank_reference: credit.reference, local_credit_confirmation: credit.confirmation } : {}),
  };
  const payout_receipt_element = level === 'L1'
    ? { ...receiptCore, digest: elementDigest(receiptCore), signature: { status: 'ABSENT' } }
    : finishElement(receiptCore, KEYS.bfi, BFI, BFI_NAME);

  rec.evidence_level = level;
  saveLedger();
  await callbackCore('PAYOUT_COMPLETED', {
    payment_id: paymentId,
    ...(level === 'L3' ? { bank_reference: credit.reference } : {}),
    credited_at: paidAt,
    evidence_level: level,
    payout_receipt_element,
  });
}

// ── SG payout bank (key 2) ─────────────────────────────────────────────────
function creditBeneficiary(rec) {
  const acctId = rec.beneficiary.account;
  if (!accounts[acctId]) {
    accounts[acctId] = {
      account: acctId,
      name: rec.beneficiary.name,
      bank: rec.beneficiary.bank,
      currency: 'SGD',
      balance: '0.00',
      entries: [],
    };
  }
  const acct = accounts[acctId];
  const amount = rec.payout?.amount ?? '0.00';
  fastSeq += 1;
  const reference = `FAST-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(fastSeq).padStart(4, '0')}`;
  const credited_at = new Date().toISOString();

  const cents = (s) => BigInt(String(s).replace('.', '').padStart(3, '0'));
  const toS = (c) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
  acct.balance = toS(cents(acct.balance) + cents(amount));
  const entry = {
    reference, credited_at, amount, currency: 'SGD',
    description: `Inward FAST credit · trade payment ${rec.payment_id}`,
    sender: `${BFI_NAME} (on behalf of ${rec.originator_masked})`,
  };
  acct.entries.unshift(entry);
  saveAccounts();

  // The bank's own signature over its own credit record — this is what makes
  // L3 "the local bank's confirmation" rather than the BFI's retelling.
  const confirmationPayload = {
    bank: SGBANK, reference, account: acctId, amount, currency: 'SGD', credited_at,
  };
  return {
    reference, credited_at,
    confirmation: {
      payload: confirmationPayload,
      sig: signPayload(confirmationPayload, KEYS.sgbank, SGBANK, SGBANK_NAME),
    },
  };
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > (1 << 20)) throw httpErr(413, 'body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (url.pathname === '/bfi/travel-rule') return json(res, 200, await handleTravelRule(body));
      if (url.pathname === '/bfi/travel-rule-response') return json(res, 200, await handleTravelRuleResponse(body));
      if (url.pathname === '/bfi/cancel') return json(res, 200, await handleCancel(body));
      if (url.pathname === '/bfi/payout-approval') return json(res, 200, await handlePayoutApproval(body));
      if (url.pathname === '/bfi/settlement-notice') return json(res, 202, await handleSettlementNotice(body));
      if (url.pathname === '/wallet/transfer') return json(res, 200, await handleWalletTransfer(body));
    }
    if (req.method === 'GET') {
      if (url.pathname === '/bfi/state') {
        return json(res, 200, {
          institution: { id: BFI, name: BFI_NAME, evidence_level: EVIDENCE_LEVEL },
          payments: Object.values(ledger).map((r) => ({
            payment_id: r.payment_id, state: r.state, screening: r.screening,
            beneficiary: r.beneficiary?.name, deposit_address: r.deposit_address ?? null,
            usdc_amount: r.usdc_amount ?? null, bank_reference: r.bank_reference ?? null,
            received_at: r.received_at, error: r.error ?? null,
          })).reverse(),
        });
      }
      if (url.pathname === '/sgbank/accounts') {
        return json(res, 200, {
          institution: { id: SGBANK, name: SGBANK_NAME, rail: 'FAST (sim)' },
          accounts: Object.values(accounts),
        });
      }
      if (url.pathname === '/wallet/state') {
        const bal = await chain.balanceOf(chain.treasury).catch(() => null);
        return json(res, 200, {
          institution: { id: WALLET, name: WALLET_NAME },
          chain: { backend: chain.kind, chain_id: chain.chainId ?? 31337, usdc: chain.usdc ?? null },
          treasury: { address: chain.treasury, balance_musdc: bal === null ? null : unitsToUsdc(bal) },
        });
      }
      if (url.pathname === '/healthz') return json(res, 200, { status: 'ok', chain: chain.kind });
      // static UI
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const target = path.normalize(path.join(HERE, 'public', file));
      if (target.startsWith(path.join(HERE, 'public')) && existsSync(target)) {
        res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(readFileSync(target));
      }
    }
    json(res, 404, { error: 'not_found' });
  } catch (e) {
    json(res, e.status ?? 500, { error: e.status ? 'request_error' : 'internal', message: String(e.message ?? e) });
  }
});

await chain.init();
server.listen(PORT, () => {
  console.log(`demo-partners on :${PORT} — chain=${chain.kind} usdc=${chain.usdc ?? 'n/a'} treasury=${chain.treasury}`);
});
