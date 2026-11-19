/**
 * 데모은행 — 국경간 송금(무역대금) 모듈. Bank Adapter 레퍼런스 구현.
 *
 * What a bank's own integration holds, and nothing more:
 *   - its HSM (openssl; the key never enters this process)
 *   - its console credentials and bearer API key (state.json)
 *   - the platform's published REST surface and signing conventions
 *   - the vendored verifier packages, for checking everything it receives
 *
 * Signing conventions implemented from the spec (not imported from the
 * platform): JCS canonical bytes under two domain separators —
 *   events    "stonehash:remit:event:v1\n"  + JCS(payload)
 *   elements  "stonehash:evidence:sig:v1\n" + JCS(element − unsigned fields)
 * with ECDSA P-256 raw r‖s, base64url. The E2E flow against the live sandbox
 * is what keeps this independent copy honest.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync,
  randomBytes, randomUUID, verify as cryptoVerify,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcs, jcsString, verifyBundle } from './vendor/attest/packages/attest-verify/src/index.ts';
import {
  evaluate, keyring, verifyEvidenceSignatures,
} from './vendor/attest/packages/attest-rules/src/index.ts';

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const SELF = process.env.BANK_PUBLIC_BASE ?? 'http://127.0.0.1:3200';
const HSM_KEY = path.join(HERE, 'hsm', 'bank-hsm.key');
const CASES_FILE = path.join(HERE, 'data', 'remit-cases.json');
const REMIT_STATE_FILE = path.join(HERE, 'data', 'remit-state.json');

const state = JSON.parse(readFileSync(path.join(HERE, 'state.json'), 'utf8'));
const INSTITUTION = 'VN-BANK-001';
const BANK_NAME = '데모은행 (가상)';

// 데모 거래처 마스터 (은행이 이미 KYB를 마친 고객·수취처라는 전제)
export const IMPORTER = {
  name: 'Vina Trading Co., Ltd.', name_ko: '비나무역',
  country: 'VN', registration_number: 'VN-0312345678',
  address: '12 Le Loi Blvd, District 1, Ho Chi Minh City',
  account: 'VN-ACC-000777', kyb_status: 'VERIFIED (2026.3 정책)',
};
export const BENEFICIARY = {
  name: 'Pacific Supply Pte Ltd', country: 'SG',
  account: 'SG-ACC-000009', bank: 'DBS (sim)',
};

let cases = existsSync(CASES_FILE) ? JSON.parse(readFileSync(CASES_FILE, 'utf8')) : [];
let remitState = existsSync(REMIT_STATE_FILE) ? JSON.parse(readFileSync(REMIT_STATE_FILE, 'utf8')) : { subscribed: false };

function save() {
  const tmp = `${CASES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cases, null, 2));
  renameSync(tmp, CASES_FILE);
}
function saveRemitState() {
  writeFileSync(REMIT_STATE_FILE, JSON.stringify(remitState, null, 2));
}
const byId = (id) => cases.find((c) => c.id === id);
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ── HSM 서명 (openssl — 개인키는 이 프로세스에 들어오지 않음) ────────────────
const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';
const SIG_DOMAIN = 'stonehash:evidence:sig:v1\n';
const DIGEST_DOMAIN = 'stonehash:evidence:digest:v1\n';
const UNSIGNED_FIELDS = ['signature', 'digestVerified', 'attached', 'citedOnly'];

/** openssl의 DER ECDSA 서명 → JWS식 raw r‖s 64바이트. */
function derToRawP256(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad DER');
  let seqLen = der[i++];
  if (seqLen & 0x80) { const n = seqLen & 0x7f; seqLen = 0; for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++]; }
  const int = () => {
    if (der[i++] !== 0x02) throw new Error('bad DER int');
    let len = der[i++];
    let start = i;
    i += len;
    while (len > 32 && der[start] === 0) { start++; len--; }
    if (len > 32) throw new Error('integer too long');
    const out = Buffer.alloc(32);
    Buffer.from(der.subarray(start, start + len)).copy(out, 32 - len);
    return out;
  };
  const r = int(); const s = int();
  return Buffer.concat([r, s]);
}

async function hsmSign(bytes, workDir, label) {
  mkdirSync(workDir, { recursive: true });
  const inFile = path.join(workDir, `${label}.bin`);
  const sigFile = path.join(workDir, `${label}.der`);
  writeFileSync(inFile, bytes);
  await execFile('openssl', ['dgst', '-sha256', '-sign', HSM_KEY, '-out', sigFile, inFile]);
  return derToRawP256(readFileSync(sigFile));
}

async function signEventPayload(payload, workDir, label) {
  const bytes = Buffer.concat([Buffer.from(EVENT_DOMAIN, 'utf8'), Buffer.from(jcs(payload))]);
  const raw = await hsmSign(bytes, workDir, label);
  return { alg: 'ES256', key_id: INSTITUTION, issuer: BANK_NAME, sig: b64u(raw) };
}

async function finishElement(core, workDir, label) {
  const digestCore = { ...core };
  for (const f of [...UNSIGNED_FIELDS, 'digest']) delete digestCore[f];
  const digest = sha256hex(Buffer.concat([Buffer.from(DIGEST_DOMAIN, 'utf8'), Buffer.from(jcs(digestCore))]));
  const el = { ...core, digest };
  const signCore = { ...el };
  for (const f of UNSIGNED_FIELDS) delete signCore[f];
  const bytes = Buffer.concat([Buffer.from(SIG_DOMAIN, 'utf8'), Buffer.from(jcs(signCore))]);
  const raw = await hsmSign(bytes, workDir, label);
  return {
    ...el,
    signature: {
      status: 'VALID', keyId: INSTITUTION, algorithm: 'ES256',
      issuer: BANK_NAME, trustLevel: 'ATTESTED', value: b64u(raw),
    },
  };
}

// ── 모드 B: 은행측 IVMS101 구성 + JWE 암호화 (스펙 재구현 — 레퍼런스) ───────
function concatKdf(z, bits, alg) {
  const len = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); };
  const supPub = Buffer.alloc(4); supPub.writeUInt32BE(bits, 0);
  const otherInfo = Buffer.concat([len(Buffer.from(alg)), len(Buffer.alloc(0)), len(Buffer.alloc(0)), supPub]);
  const counter = Buffer.from([0, 0, 0, 1]);
  return createHash('sha256').update(Buffer.concat([counter, z, otherInfo])).digest().subarray(0, bits / 8);
}

/** RFC 7516 compact, ECDH-ES + A256GCM — 플랫폼 공개 규격과 동일 프로파일. */
function encryptJweForBfi(plaintext, recipientJwk, kid) {
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const recipient = createPublicKey({ key: recipientJwk, format: 'jwk' });
  const cek = concatKdf(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), 256, 'A256GCM');
  const epk = ephemeral.publicKey.export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({
    alg: 'ECDH-ES', enc: 'A256GCM', epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y },
    ...(kid ? { kid } : {}),
  })).toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${header}..${iv.toString('base64url')}.${ct.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function legalPerson(p) {
  return {
    legalPerson: {
      name: { nameIdentifier: [{ legalPersonName: p.name ?? '', legalPersonNameIdentifierType: 'LEGL' }] },
      ...(p.address ? { geographicAddress: [{ addressType: 'GEOG', addressLine: [p.address], country: p.country ?? '' }] } : {}),
      // LEI는 LEIX로 표기합니다 — 플랫폼(모드 A)과 SDK(모드 B)가 쓰는 규칙과 같습니다.
      ...(p.registration_number ? { nationalIdentification: { nationalIdentifier: p.registration_number,
        nationalIdentifierType: /^[A-Z0-9]{18}[0-9]{2}$/.test(p.registration_number) ? 'LEIX' : 'RAID' } } : {}),
      ...(p.country ? { countryOfRegistration: p.country } : {}),
    },
    ...(p.account ? { accountNumber: [p.account] } : {}),
  };
}

/** 공개 스키마(IVMS101-2023, 2계층)를 은행이 직접 구성 — 모드 B의 요체. */
function buildIvmsAtBank(c, q, meta) {
  const bfi = meta.institutions.find((i) => i.role === 'BENEFICIARY_FI');
  const settle = meta.institutions.find((i) => i.role === 'SETTLEMENT_ENTITY');
  return {
    schema: 'IVMS101-2023',
    payment_id: c.pending_payment_id,
    underlyingPayment: {
      originator: { originatorPersons: [legalPerson({ ...IMPORTER })] },
      beneficiary: { beneficiaryPersons: [legalPerson({ name: c.beneficiary.name, country: c.beneficiary.country, account: c.beneficiary.account })] },
      originatingInstitution: { institutionId: INSTITUTION, name: BANK_NAME, country: 'VN' },
      beneficiaryLocalBank: c.beneficiary.bank,
      transaction: { amount: q.trade.amount, currency: 'USD', purposeCode: 'GOODS_PAYMENT' },
    },
    settlementLeg: {
      originatingVasp: { institutionId: settle?.id ?? 'SETTLE-ENTITY-001', name: settle?.name ?? '' },
      beneficiaryVasp: { institutionId: bfi?.id ?? 'SG-BFI-001', name: bfi?.name ?? '', country: bfi?.country ?? 'SG' },
      transaction: { amount: q.settlement.amount, currency: 'USDC' },
    },
  };
}

// ── 플랫폼 Webhook 서명 검증 ────────────────────────────────────────────────
let platformSpki = null;
async function platformKey() {
  if (platformSpki) return platformSpki;
  const meta = await (await fetch(`${CORE}/v1/remit/meta`)).json();
  platformSpki = meta.platform_signer?.spki ?? null;
  return platformSpki;
}
async function verifyPlatformEvent(payload, sig) {
  const spki = await platformKey();
  if (!spki || !sig?.sig) return false;
  const bytes = Buffer.concat([Buffer.from(EVENT_DOMAIN, 'utf8'), Buffer.from(jcs(payload))]);
  try {
    return cryptoVerify('sha256', bytes,
      { key: createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig.sig, 'base64url'));
  } catch { return false; }
}

// ── 플랫폼 API 헬퍼 ────────────────────────────────────────────────────────
const authHeaders = { authorization: `Bearer ${state.apiKey}`, 'content-type': 'application/json' };
async function platform(method, p, body, extra = {}) {
  const res = await fetch(`${CORE}${p}`, {
    method, headers: { ...authHeaders, ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ── 구독 (은행 ops가 콘솔에서 하는 일을 API로) ──────────────────────────────
export async function subscribe() {
  const login = await fetch(`${CORE}/v1/console/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  if (login.status !== 200) throw new Error(`콘솔 로그인 실패 (${login.status})`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const keysRes = await (await fetch(`${CORE}/v1/console/issuer-keys`, { headers: { cookie } })).json();
  const list = keysRes.data ?? keysRes.keys ?? keysRes;
  const issuerKey = (Array.isArray(list) ? list : []).find((k) => k.public_key === state.issuerKey.spkiBase64);
  if (!issuerKey) throw new Error('콘솔에 등록된 발행인 키를 찾지 못했습니다');

  const res = await fetch(`${CORE}/v1/console/products`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      product: 'remit',
      institution: { id: INSTITUTION, name: BANK_NAME, country: 'VN' },
      issuer_key_id: issuerKey.id,
      webhook_url: `${SELF}/api/remit/webhook`,
    }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`구독 실패 (${res.status}): ${body.message ?? body.error}`);
  remitState = {
    subscribed: true, institution_id: INSTITUTION,
    webhook_url: `${SELF}/api/remit/webhook`, subscribed_at: new Date().toISOString(),
  };
  saveRemitState();
  return remitState;
}

// ── 케이스 파이프라인 ──────────────────────────────────────────────────────
function step(c, key, title) {
  const s = { key, title, state: 'run', startedAt: Date.now(), ms: null, detail: {} };
  c.steps.push(s);
  save();
  return {
    ok(detail) { s.state = 'ok'; s.ms = Date.now() - s.startedAt; Object.assign(s.detail, detail ?? {}); save(); },
    fail(message) { s.state = 'fail'; s.ms = Date.now() - s.startedAt; s.detail.error = message; save(); },
  };
}

/**
 * 데모 시나리오는 전부 "데이터"로 유도한다 — 금액의 센트 자리와 수취인명이
 * 수취측 모의 기관의 트리거이지, 플랫폼에 숨은 스위치가 있는 게 아니다.
 * (제재: 수취인명에 SANCTIONED · RFI: ≥USD 20,000 · 반환: *.13 · L1: *.01 · L2: *.02)
 */
export const SCENARIOS = {
  normal:     { label: '정상 거래 (L3)', amount: null, note: null },
  rfi:        { label: 'EDD·RFI — 고액 (≥ USD 20,000)', amount: '25000.00', note: '수취측이 추가정보를 요구하고, 답변 후 재개됩니다' },
  sanctioned: { label: '제재 적중 — 거절', amount: null, beneficiary_suffix: ' (SANCTIONED TEST)', note: '수취측 제재검사에서 거절되어 취소됩니다' },
  fail:       { label: '현지 지급실패 — USDC 반환', amount_suffix: '.13', note: 'FAST 거절 후 USDC가 정산주체로 반환됩니다' },
  l1:         { label: 'L1 증거등급 — 확정 보류', amount_suffix: '.01', note: '무서명 통보만 와서 입금확정이 선언되지 않습니다' },
  l2:         { label: 'L2 증거등급 — 참조번호 없음', amount_suffix: '.02', note: 'BFI 서명은 있으나 현지은행 참조가 없습니다' },
};

export function createCase(invoice, scenario = 'normal', mode = 'A') {
  if (!invoice?.ref || !/^\d+(\.\d{1,2})?$/.test(invoice.amount_usd ?? '')) {
    throw Object.assign(new Error('인보이스 번호와 USD 금액을 입력하세요'), { status: 400 });
  }
  const sc = SCENARIOS[scenario] ?? SCENARIOS.normal;
  let amount = Number(invoice.amount_usd).toFixed(2);
  if (sc.amount) amount = sc.amount;
  if (sc.amount_suffix) amount = amount.slice(0, -3) + sc.amount_suffix;
  const beneficiary = sc.beneficiary_suffix
    ? { ...BENEFICIARY, name: BENEFICIARY.name + sc.beneficiary_suffix }
    : BENEFICIARY;
  const c = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    importer: IMPORTER, beneficiary,
    invoice: { ref: invoice.ref, amount_usd: amount },
    scenario, scenario_label: sc.label, scenario_note: sc.note ?? null,
    travel_rule_mode: mode === 'B' ? 'B' : 'A',
    status: 'REQUESTED',           // 은행 내부 상태 (플랫폼 상태와 구분)
    quote: null, payment_id: null,
    checks: { kyb: false, trade: false, fx: false },
    steps: [], timeline: [], platform: null, verification: null,
    error: null,
  };
  cases.unshift(c);
  save();
  return c;
}

export async function quoteCase(id) {
  const c = byId(id);
  if (!c) throw Object.assign(new Error('not found'), { status: 404 });
  const res = await platform('POST', '/v1/quotes', {
    corridor: { origin: 'VN', destination: 'SG' },
    trade: { currency: 'USD', amount: c.invoice.amount_usd },
    collect: { currency: 'VND' }, payout: { currency: 'SGD' },
  });
  if (res.status !== 201) throw Object.assign(new Error(res.body.message ?? '견적 실패'), { status: 502 });
  c.quote = res.body;
  c.status = 'QUOTED';
  save();
  return c;
}

export function reviewCase(id, checks) {
  const c = byId(id);
  if (!c) throw Object.assign(new Error('not found'), { status: 404 });
  c.checks = { kyb: !!checks?.kyb, trade: !!checks?.trade, fx: !!checks?.fx };
  save();
  return c;
}

export async function approveCase(id) {
  const c = byId(id);
  if (!c) throw Object.assign(new Error('not found'), { status: 404 });
  if (!remitState.subscribed) throw Object.assign(new Error('먼저 송금 상품을 구독하세요'), { status: 409 });
  if (!c.quote) throw Object.assign(new Error('먼저 견적을 받으세요'), { status: 409 });
  if (Date.parse(c.quote.expires_at) < Date.now()) {
    c.status = 'QUOTE_EXPIRED'; save();
    throw Object.assign(new Error('견적이 만료되었습니다 — 재견적이 필요합니다'), { status: 409 });
  }
  if (!c.checks.kyb || !c.checks.trade || !c.checks.fx) {
    throw Object.assign(new Error('KYB·무역서류·외환심사 체크리스트를 먼저 완료하세요'), { status: 409 });
  }
  if (c.payment_id) throw Object.assign(new Error('이미 제출된 건입니다'), { status: 409 });

  c.status = 'SUBMITTING';
  const workDir = path.join(HERE, 'work', 'remit', c.id);
  const paymentId = `PAY-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${c.id.slice(0, 6)}`;
  c.pending_payment_id = paymentId;
  const now = new Date().toISOString();
  const q = c.quote;

  try {
    // 1 — VND 수납 기록 (고객 원화(동) 계좌 차기 → 은행 수납 전표)
    let s = step(c, 'collect', 'VND 수납 기록 (고객계좌 출금 전표)');
    const fiatRef = `BANK-RCPT-${paymentId}`;
    s.ok({
      수납전표: fiatRef,
      수납액: `${Number(q.collect.amount).toLocaleString()} VND`,
      적용환율: `USD/VND ${q.collect.rate} (견적 ${q.quote_id} 고정)`,
      note: '법화 수납이 완료되어야 지급 승인이 가능합니다 (아키텍처 §3 단계 3).',
    });

    // 2 — 증거요소 3건을 HSM으로 서명 (은행이 확인한 사실에만 서명)
    s = step(c, 'sign-elements', '증거요소 서명 — 지급지시·외환승인·상업서류 (HSM, ES256)');
    const bankInstruction = await finishElement({
      ref: paymentId, amount: q.trade.amount, currency: 'USD',
      debtor: IMPORTER.name, creditor: c.beneficiary.name,
      approvedAt: now,
      iso20022Fields: ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf', c.invoice.ref],
    }, workDir, 'instruction');
    const bankApproval = await finishElement({
      approvalRef: `APPR-${paymentId}`,
      regulatorReportRef: 'VN-SBV-C27-DEMO',
      approvedByRole: 'FX Compliance Officer',
      approvedAt: now,
      fxQuote: { pair: 'USD/VND', rate: q.collect.rate, quotedAt: q.quoted_at, validUntil: q.expires_at },
    }, workDir, 'approval');
    const commercialDocs = await finishElement({
      invoiceRef: c.invoice.ref, amount: q.trade.amount, currency: 'USD',
      buyer: IMPORTER.name, seller: c.beneficiary.name,
      attached: ['invoice'], citedOnly: [],
    }, workDir, 'docs');
    s.ok({
      서명방식: "openssl dgst -sha256 -sign <은행HSM키> — 개인키는 은행 밖으로 나가지 않습니다",
      bankInstruction: { digest: bankInstruction.digest, sig: `${bankInstruction.signature.value.slice(0, 24)}…` },
      bankApproval: { digest: bankApproval.digest, sig: `${bankApproval.signature.value.slice(0, 24)}…` },
      commercialDocs: { digest: commercialDocs.digest, sig: `${commercialDocs.signature.value.slice(0, 24)}…` },
    });

    // 3 — 지급 승인 전문 서명
    s = step(c, 'sign-auth', '지급승인(bank_authorization) 서명 (HSM)');
    const bank_authorization = {
      bank_id: INSTITUTION,
      instruction_ref: `BANK-INST-${paymentId}`,
      fiat_received_ref: fiatRef,
      kyb_status: 'VERIFIED', kyb_policy_version: '2026.3',
      trade_review: 'APPROVED', purpose_code: 'GOODS_PAYMENT',
      payment_release: 'AUTHORIZED',
      approved_at: now,
    };
    const bank_signature = await signEventPayload(bank_authorization, workDir, 'authorization');
    s.ok({
      서명대상: 'bank_authorization (JCS 정규화 바이트)',
      도메인: EVENT_DOMAIN.trim(),
      bank_signature: { ...bank_signature, sig: `${bank_signature.sig.slice(0, 24)}…` },
    });

    // 3.5 — 트래블룰 페이로드 준비 (모드 A: 평문 제출 / 모드 B: 은행측 암호화)
    let compliance_payload;
    if (c.travel_rule_mode === 'B') {
      s = step(c, 'encrypt', '트래블룰 은행측 암호화 (모드 B — IVMS101 구성 → BFI 공개키 JWE)');
      const meta = await (await fetch(`${CORE}/v1/remit/meta`)).json();
      const bfi = meta.institutions.find((i) => i.role === 'BENEFICIARY_FI');
      if (!bfi?.encryption_jwk) throw new Error('BFI 암호화 공개키를 meta에서 찾지 못했습니다');
      const ivms = buildIvmsAtBank(c, q, meta);
      const ivmsDigest = sha256hex(Buffer.from(jcs(ivms)));
      const ciphertext = encryptJweForBfi(Buffer.from(JSON.stringify(ivms)), bfi.encryption_jwk, `${bfi.id}-ENC`);
      // 은행이 서명하는 진술은 "필수 필드가 있다"에 그치지 않고 어느 메시지에 대한 것인지를
      // 함께 담습니다(메시지 다이제스트 + 암호문 해시). 중계 구간에서 암호문이 바뀌면
      // 플랫폼이 접수 단계에서 거절합니다.
      const assertionPayload = {
        payment_id: paymentId,
        required_fields_present: true,
        field_count: 8,
        schema: 'IVMS101-2023',
        ivms101_digest: ivmsDigest,
        ciphertext_sha256: sha256hex(Buffer.from(ciphertext, 'utf8')),
      };
      const assertionSig = await signEventPayload(assertionPayload, workDir, 'fields-assertion');
      compliance_payload = {
        format: 'IVMS101-2023', mode: 'B',
        ciphertext, ivms101_digest: ivmsDigest,
        fields_assertion: { payload: assertionPayload, sig: assertionSig },
      };
      s.ok({
        모드: 'B — 평문 PII가 은행 밖으로 나가지 않습니다 (플랫폼은 암호문 중계만)',
        ivms101_digest: ivmsDigest,
        ciphertext_길이: ciphertext.length,
        필수필드_어설션: { ...assertionPayload, 서명: `${assertionSig.sig.slice(0, 24)}…` },
      });
    } else {
      compliance_payload = {
        format: 'IVMS101-2023', mode: 'A',
        originator: {
          name: IMPORTER.name, country: IMPORTER.country, address: IMPORTER.address,
          registration_number: IMPORTER.registration_number, account: IMPORTER.account,
        },
        beneficiary: {
          name: c.beneficiary.name, country: c.beneficiary.country,
          account: c.beneficiary.account, bank: c.beneficiary.bank,
        },
        purpose_code: 'GOODS_PAYMENT',
      };
    }

    // 4 — 플랫폼 제출
    s = step(c, 'submit', '지급지시 제출 (POST /v1/settlements)');
    const body = {
      request_id: `REQ-${paymentId}`,
      payment_id: paymentId,
      quote_id: q.quote_id,
      corridor: { origin: 'VN', destination: 'SG' },
      amount: {
        collected: { currency: 'VND', value: q.collect.amount },
        payout: { currency: 'SGD', value: q.payout.amount },
      },
      bank_authorization, bank_signature,
      commercial_reference: {
        invoice_ref: c.invoice.ref,
        invoice_commitment: sha256hex(`${c.invoice.ref}|${q.trade.amount} USD|${IMPORTER.name}`),
      },
      beneficiary: { institution_id: 'SG-BFI-001', beneficiary_ref: 'BEN-0001' },
      compliance_payload,
      evidence_elements: { bankInstruction, bankApproval, commercialDocs },
    };
    const res = await platform('POST', '/v1/settlements', body, { 'idempotency-key': `case-${c.id}` });
    if (res.status !== 202) throw new Error(`플랫폼 ${res.status}: ${res.body.message ?? res.body.error}`);
    c.payment_id = paymentId;
    c.status = 'SUBMITTED';
    s.ok({
      응답: res.body,
      멱등키: `case-${c.id}`,
      note: 'HTTP 202는 접수 확인일 뿐, 송금 성공이 아닙니다. 이후 결과는 Webhook + 폴링으로 추적합니다.',
    });
    save();
    return c;
  } catch (e) {
    const open = c.steps.find((x) => x.state === 'run');
    if (open) { open.state = 'fail'; open.detail.error = String(e.message ?? e); }
    c.status = 'FAILED';
    c.error = String(e.message ?? e);
    save();
    throw Object.assign(new Error(c.error), { status: 502 });
  }
}

// ── 취소 · RFI 응답 · 일별 Manifest ─────────────────────────────────────────
export async function cancelCase(id, reason) {
  const c = byId(id);
  if (!c?.payment_id) throw Object.assign(new Error('제출된 건이 아닙니다'), { status: 409 });
  const workDir = path.join(HERE, 'work', 'remit', c.id);
  const payload = { payment_id: c.payment_id, reason: reason || '고객 요청으로 취소' };
  const sig = await signEventPayload(payload, workDir, 'cancel');
  const res = await platform('POST', `/v1/settlements/${c.payment_id}/cancel`, { reason: payload.reason, sig });
  if (res.status >= 400) throw Object.assign(new Error(res.body.message ?? '취소 실패'), { status: res.status });
  c.status = 'CANCELLED';
  save();
  return res.body;
}

export async function answerRfi(id, answers) {
  const c = byId(id);
  if (!c?.payment_id) throw Object.assign(new Error('not found'), { status: 404 });
  if (!answers || Object.values(answers).every((v) => !String(v ?? '').trim())) {
    throw Object.assign(new Error('답변을 입력하세요'), { status: 400 });
  }
  const workDir = path.join(HERE, 'work', 'remit', c.id);
  const sig = await signEventPayload({ payment_id: c.payment_id, answers }, workDir, 'rfi-answers');
  const res = await platform('POST', `/v1/settlements/${c.payment_id}/rfi-response`, { answers, sig });
  if (res.status >= 400) throw Object.assign(new Error(res.body.message ?? 'RFI 응답 실패'), { status: res.status });
  save();
  return res.body;
}

/**
 * 일별 마감 대사 — 당행이 그날 지시한 payment_id 목록을 서명해 제출하고,
 * 플랫폼의 목록과 양방향으로 맞춰본다 (§7-4 완전성 통제). 데모 레버:
 * omit_one은 "은행이 한 건을 빠뜨린" 상황을 재현해 DISCREPANT를 보여준다.
 */
export async function submitManifest(date, omitOne = false) {
  const day = date || new Date().toISOString().slice(0, 10);
  // 당행이 그날 지시한 건 전부 — 이 화면(지점 업무 흐름)에서 낸 건과, 같은 은행
  // 계정으로 SDK·SWIFT 전문 채널(고객사이트 데모 :3400)에서 낸 건을 합친다.
  // Manifest는 "은행이 지시한 전체"의 선언이므로 한 채널만 적으면 그 자체가 누락이다.
  const sdkChannel = (() => {
    const book = path.join(HERE, '..', 'demo-customers', 'data', 'bank-payments.json');
    const marker = path.join(HERE, '..', 'demo-customers', 'data', 'bank-persona.json');
    try {
      if (JSON.parse(readFileSync(marker, 'utf8')).institution !== INSTITUTION) return [];
      return JSON.parse(readFileSync(book, 'utf8'))
        .filter((r) => r.paymentId && String(r.createdAt ?? '').slice(0, 10) === day)
        .map((r) => r.paymentId);
    } catch { return []; }
  })();
  // 세 번째 채널: 같은 은행 계정으로 Java SDK를 쓰는 Java 백엔드 데모(:3500).
  const javaChannel = (() => {
    if (INSTITUTION !== 'VN-BANK-001') return [];
    try {
      // `already`: 같은 전문을 다시 넣어 기존 지급을 찾은 기록 — 그날 지시한 건이 아니므로 뺀다.
      return JSON.parse(readFileSync(path.join(HERE, '..', 'demo-bank-java', 'data', 'payments.json'), 'utf8'))
        .filter((r) => r.paymentId && !r.already && String(r.createdAt ?? '').slice(0, 10) === day)
        .map((r) => r.paymentId);
    } catch { return []; }
  })();
  let ids = [...new Set([
    ...cases.filter((c) => c.payment_id && c.created_at.slice(0, 10) === day).map((c) => c.payment_id),
    ...sdkChannel,
    ...javaChannel,
  ])].sort();
  let omitted = null;
  if (omitOne && ids.length > 0) {
    omitted = ids[ids.length - 1];
    ids = ids.slice(0, -1);
  }
  const manifest = { date: day, institution_id: INSTITUTION, payment_ids: ids, count: ids.length };
  const workDir = path.join(HERE, 'work', 'remit', 'manifests');
  const sig = await signEventPayload(manifest, workDir, `manifest-${day}`);
  const res = await platform('POST', '/v1/manifests/daily', { manifest, sig });
  if (res.status >= 400) throw Object.assign(new Error(res.body.message ?? 'Manifest 제출 실패'), { status: res.status });
  return { ...res.body, submitted: manifest, ...(omitted ? { demo_omitted: omitted } : {}) };
}

// ── Webhook 수신 + 폴링 병합 ────────────────────────────────────────────────
export async function receiveWebhook(body) {
  const { envelope, signature } = body ?? {};
  if (!envelope || !signature) throw Object.assign(new Error('envelope/signature required'), { status: 400 });
  const ok = await verifyPlatformEvent(envelope, signature);
  const c = cases.find((x) => x.payment_id === envelope.payment_id);
  if (!c) return { accepted: false, reason: 'unknown payment' };
  if (c.timeline.some((t) => t.event_id === envelope.event_id)) return { accepted: true, dedup: true };
  c.timeline.push({
    at: envelope.occurred_at, source: 'webhook',
    type: envelope.type, state: envelope.state,
    sequence: envelope.sequence, event_id: envelope.event_id,
    data: envelope.data, signature_valid: ok,
  });
  c.timeline.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  save();
  return { accepted: true, signature_valid: ok };
}

/** 케이스 상세 = 은행 기록 + 플랫폼 폴링 뷰 (Webhook 유실 대비 이중화). */
export async function caseDetail(id) {
  const c = byId(id);
  if (!c) throw Object.assign(new Error('not found'), { status: 404 });
  if (c.payment_id) {
    const res = await platform('GET', `/v1/settlements/${c.payment_id}`);
    if (res.status === 200) {
      c.platform = {
        state: res.body.state,
        evidence_level: res.body.evidence_level,
        deposit_address: res.body.deposit_address,
        chain_tx: res.body.chain_tx,
        attestation: res.body.attestation,
        evidence_available: res.body.evidence_available,
        amounts: res.body.amounts,
        events: res.body.events.map((e) => ({ seq: e.seq, type: e.type, issuer: e.issuer, at: e.at })),
        polled_at: new Date().toISOString(),
      };
      save();
    }
  }
  return c;
}

// ── 증빙 수령 + 독립 검증 ──────────────────────────────────────────────────
export async function fetchEvidence(id) {
  const c = byId(id);
  if (!c?.payment_id) throw Object.assign(new Error('not found'), { status: 404 });
  const res = await platform('GET', `/v1/settlements/${c.payment_id}/evidence`);
  if (res.status !== 200) throw Object.assign(new Error(res.body.message ?? 'evidence not ready'), { status: res.status });
  const file = path.join(HERE, 'work', 'remit', c.id, 'evidence.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(res.body, null, 2));
  return res.body;
}

/**
 * 독립 검증 — StoneHash를 믿지 않고, 받은 패키지만으로 재검증한다.
 *  1. 커밋 재계산: SHA256(domain‖nonce‖JCS(package)) == 앵커된 leaf
 *  2. 증거요소 서명: 패키지 동봉 Trust Registry 공개키로 전부 재검증
 *  3. 6축 재판정: 벤더링된 동일 엔진으로 재실행, 플랫폼 verdict와 비교
 *  4. 앵커 번들: 벤더링된 attest-verify로 머클·체인 검증
 */
export async function verifyEvidence(id) {
  const c = byId(id);
  if (!c?.payment_id) throw Object.assign(new Error('not found'), { status: 404 });
  const ev = await fetchEvidence(id);
  const report = { checks: [], verified: false };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  // 1 — commitment
  const canonical = Buffer.from(jcsString(ev.package), 'utf8');
  const commit = sha256hex(Buffer.concat([
    Buffer.from('STONEHASH-EVIDENCE-V1', 'utf8'),
    Buffer.from(ev.commitment.nonce, 'hex'),
    canonical,
  ]));
  add('패키지 커밋 재계산', commit === ev.commitment.value,
    `SHA256(domain‖nonce‖JCS) = ${commit.slice(0, 16)}…`);

  // 2 — element signatures against the embedded registry snapshot
  const ring = keyring(ev.package.trust_registry.institutions
    .filter((i) => i.signing_spki)
    .map((i) => ({
      keyId: i.id, issuer: i.name, trustLevel: 'ATTESTED',
      publicKeyJwk: createPublicKey({ key: Buffer.from(i.signing_spki, 'base64'), format: 'der', type: 'spki' })
        .export({ format: 'jwk' }),
    })));
  const checked = await verifyEvidenceSignatures(ev.package.evidence, ring);
  const sigStates = Object.entries(checked.elements).flatMap(([k, v]) => {
    const items = Array.isArray(v) ? v : [v];
    return items.map((item) => `${k}:${item.signature?.status ?? 'ABSENT'}`);
  });
  const allValid = sigStates.every((s) => s.endsWith(':VALID'));
  add('증거요소 서명 재검증 (Trust Registry 공개키)', allValid, sigStates.join('  '));

  // 3 — re-run the six-axis engine (the same vendored code path)
  const verdict = evaluate(checked, ev.package.policy);
  const mine = Object.fromEntries(Object.entries(verdict.axes).map(([k, v]) => [k, v.state]));
  const theirs = Object.fromEntries(Object.entries(ev.package.verdict.axes).map(([k, v]) => [k, v.state]));
  const agree = JSON.stringify(mine) === JSON.stringify(theirs);
  add('6축 재판정 (벤더링 엔진 재실행)', agree,
    agree ? Object.entries(mine).map(([k, v]) => `${k}=${v}`).join(' ') : `은행 ${JSON.stringify(mine)} ≠ 플랫폼 ${JSON.stringify(theirs)}`);

  // 4 — anchor bundle
  let bundleOk = false; let bundleDetail = '앵커 번들 미수령 (앵커 대기 중)';
  if (ev.attestation?.bundle) {
    const leafOk = ev.attestation.bundle.record?.leaf_bytes === ev.commitment.value;
    const r = await verifyBundle(ev.attestation.bundle, {});
    bundleOk = leafOk && r.verified === true;
    bundleDetail = `leaf==commitment: ${leafOk} · ${r.checks.map((x) => `${x.id}:${x.state}`).join(' ')}`;
  }
  add('비트코인 앵커 번들 검증 (attest-verify)', bundleOk, bundleDetail);

  report.verified = report.checks.every((x) => x.ok);
  c.verification = { ...report, verified_at: new Date().toISOString() };
  save();
  return c.verification;
}

// ── 라우팅 (server.mjs에서 위임) ───────────────────────────────────────────
export async function handleRemit(req, res, url, readJson, json) {
  const m = (method, pattern) => {
    if (req.method !== method) return null;
    const match = url.pathname.match(pattern);
    return match;
  };
  let x;
  if (m('GET', /^\/api\/remit\/config$/)) {
    return json(res, 200, {
      subscribed: remitState.subscribed, institution: INSTITUTION,
      webhook_url: remitState.webhook_url ?? null,
      importer: IMPORTER, beneficiary: BENEFICIARY,
      scenarios: Object.entries(SCENARIOS).map(([k, v]) => ({ key: k, label: v.label, note: v.note ?? null })),
      // Partner UI as seen from the visitor's browser: same host the bank
      // demo is reached on, port 3300 — overridable for split deployments.
      partners_ui: process.env.PARTNERS_PUBLIC_BASE
        ?? `http://${new URL(process.env.ATTEST_PUBLIC_BASE ?? 'http://3.36.101.90:8787').hostname}:3300`,
    });
  }
  if (m('POST', /^\/api\/remit\/subscribe$/)) return json(res, 200, await subscribe());
  if (m('GET', /^\/api\/remit\/cases$/)) {
    return json(res, 200, {
      data: cases.map((c) => ({
        id: c.id, created_at: c.created_at, status: c.status,
        invoice: c.invoice, payment_id: c.payment_id,
        platform_state: c.platform?.state ?? null,
        importer: c.importer.name_ko, beneficiary: c.beneficiary.name,
      })),
    });
  }
  if (m('POST', /^\/api\/remit\/cases$/)) {
    const body = await readJson(req);
    return json(res, 201, createCase(body.invoice, body.scenario, body.travel_rule_mode));
  }
  if ((x = m('GET', /^\/api\/remit\/cases\/([0-9a-f-]+)$/))) return json(res, 200, await caseDetail(x[1]));
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/quote$/))) return json(res, 200, await quoteCase(x[1]));
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/review$/))) {
    const body = await readJson(req);
    return json(res, 200, reviewCase(x[1], body.checks));
  }
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/approve$/))) return json(res, 200, await approveCase(x[1]));
  if ((x = m('GET', /^\/api\/remit\/cases\/([0-9a-f-]+)\/evidence$/))) {
    const ev = await fetchEvidence(x[1]);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="evidence-${x[1]}.json"`,
    });
    return res.end(JSON.stringify(ev, null, 2));
  }
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/verify$/))) return json(res, 200, await verifyEvidence(x[1]));
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/cancel$/))) {
    const body = await readJson(req);
    return json(res, 200, await cancelCase(x[1], body.reason));
  }
  if ((x = m('POST', /^\/api\/remit\/cases\/([0-9a-f-]+)\/rfi$/))) {
    const body = await readJson(req);
    return json(res, 200, await answerRfi(x[1], body.answers));
  }
  if (m('POST', /^\/api\/remit\/manifest$/)) {
    const body = await readJson(req);
    return json(res, 200, await submitManifest(body.date, body.omit_one === true));
  }
  if (m('GET', /^\/api\/remit\/manifest$/)) {
    const res2 = await platform('GET', `/v1/manifests/daily${url.search}`);
    return json(res, res2.status, res2.body);
  }
  if (m('POST', /^\/api\/remit\/webhook$/)) {
    const body = await readJson(req);
    return json(res, 200, await receiveWebhook(body));
  }
  return false;
}
