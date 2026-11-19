/**
 * A stand-in for the receiving side of the settlement rail — the beneficiary
 * institution, its payout bank and the settlement wallet — that a test
 * controls: what each call is answered with, and which callbacks come back.
 *
 *   node apps/core-java/tools/stand-in-partner.mjs --listen 3301=http://127.0.0.1:8790 --listen 3302=http://127.0.0.1:8791
 *        [--keys <file>] [--seed <file>] [--sender enforce|record]
 *
 * One listener per core (`<port>=<that core's address>`), each with a state,
 * a log and a webhook receiver of its own, each sending its callbacks to its
 * own core and to nothing else. A test server's `REMIT_PARTNERS_BASE` names
 * its listener. Loopback only; no chain, no file written but the key file.
 *
 * What it stands in for is demo-partners/server.mjs, and where nothing is
 * scripted it answers as that simulator does: the same routes, the same
 * shapes, the same signatures (made with the reference's own `sign.ts`), the
 * same refusals in the same words, the same triggers:
 *
 *   beneficiary name contains SANCTIONED            travel rule REJECTED
 *   trade of USD 20,000 or more, not yet answered   RFI with two questions (id `RFI-<payment id>`)
 *   a party name or the beneficiary account empty   RFI as a bare reason, nothing remembered
 *   every RFI answer empty                          REJECTED ("RFI answers were empty")
 *   trade amount ends in .13                        payout fails, USDC returned
 *   trade amount ends in .01 / .02                  completion at L1 (unsigned) / L2 (no bank reference); otherwise L3
 *   approval without an accepted travel rule        409;  transfer without a pre-approval, to another address, of another
 *   amount, after the approval's 15 minutes, or above 50,000.00: 403;  settlement notice for an unknown payment: 404
 *
 * Where it differs from the simulator, on purpose:
 *   - what the simulator takes from a counter, a clock's date or a chain is a function of the payment id here
 *     (deposit address, transaction hashes and blocks — hashes the stand-in chain node knows —, bank reference),
 *     so two cores running the same payment are told the same. Times are the clock's.
 *   - it watches no chain: the callbacks follow the settlement notice at once (a notice for a payment the wallet
 *     never moved is acknowledged and followed by nothing, where the simulator would give up after 60 s).
 *   - a payment it has never heard of is looked up in the seed file (`remit.partner.ledger` of parity/seed.json):
 *     what the partner remembered of the seeded payments, so that a seeded payment can be carried on.
 *
 * Scripting, per payment id or per prefix of one — `POST /control/plan`:
 *
 *   { "payment_id": "PAY-1" | "prefix": "PAY-X-" | "all": true,
 *     "steps": { "<step>": <behaviour> | [<behaviour>, …] },      an array is used up one request at a time, payment by payment
 *     "callbacks": "auto" | "manual" | { "mode": "auto", "level": "L1"|"L2"|"L3"|"none", "fail": true, "sequence": [<callback>, …],
 *                   "delay": ms before the first, "gap": ms between them },
 *     "sender": "enforce" | "record" }
 *
 *   steps        travel-rule, travel-rule-response, payout-approval, transfer, settlement-notice, cancel
 *   behaviour    "normal" (the rules above) or { "do": … } with
 *     ack | rfi {id, questions} | rfi-bare {reason, remember} | reject {reason}      the travel-rule answers, whatever the rules say
 *     refuse {status, message | body | raw}       a 4xx and nothing done
 *     fail {status, message}                      a 5xx and nothing done
 *     fail-after {status}                         the work done, then a 5xx
 *     hold {ms, then}                             no answer until POST /control/release, or for `ms`; then `then` (default normal)
 *     hold-after {ms}                             the work done at once, the answer kept back until released, or for `ms`
 *     drop | drop-after                           the connection closed without an answer (before / after the work)
 *     html | raw {status, contentType, body}      something that is no JSON
 *   and, on any behaviour that answers:  signedBy (bfi, bfi2, sgbank, wallet, stranger), breakSignature,
 *     with {…} (members of the signed payload: payment_id, usdc_amount, tx_hash, …), top {…} / omit […] (members of
 *     the answer around it: status, ack, …), element { with, omit, after, signedBy, unsigned, breakSignature, breakDigest }
 *     (the evidence element inside), tx (a kind of the stand-in chain node, for the transfer), delay, thenClose (ms
 *     for which this listener refuses connections after the answer).
 *   callback     "USDC_RECEIVED" | { "type", "level", "with", "omit", "element", "signedBy", "breakSignature", "payload",
 *                "again": "bytes" | "resign" }
 *
 *   POST /control/callback {payment_id, …callback}   send one now; answers with what was sent and what the core said
 *   POST /control/release  {id | payment_id, step, answer}      GET /control/held
 *   GET  /control/wait?payment_id=&step=&dir=&type=&n=&timeout=  returns when the n-th such request has arrived
 *   GET  /control/idle?payment_id=&timeout=          returns when no automatic callbacks are under way
 *   POST /control/remember {payment_id, record}      GET /control/ledger?payment_id=
 *   POST /control/close {ms}                         refuse connections for a while (the answer goes out first)
 *   POST /control/hook {name, answers: [{status} | {hold: ms}, …]}   script the webhook receiver
 *   POST /control/reset                              GET /control/plan   GET /control/status
 *
 *   GET  /log[?listener=&payment_id=]   every request received and every callback sent, with the answer given / got
 *   GET  /log/summary                   the same with what differs from run to run reduced to its kind — comparable
 *   GET  /log/compare?with=<listener>   are two listeners' summaries the same? (what was asked, answered and sent; request
 *                                       headers and the cores' answers to callbacks are reported apart)
 *   POST /log/clear
 *   POST /hooks/<name>                  a webhook receiver: records the delivery, answers 200 unless scripted
 *   GET  /hooks/<name>[?summary=1]      what it received
 *
 * Also a module: `loadPartnerKeys`, `createStandIn` (the same engine without a socket — the seed tool uses it),
 * `listen`, and the functions of a payment id (`depositAddressOf`, `transferTxOf`, …).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { elementDigest, sha256hex, signEvent, signEvidenceElement, spkiFromPublicKey, verifyEvent } from '../../core/src/remit/sign.ts';
import { decryptJwe, generateEncryptionKey } from '../../core/src/remit/jwe.ts';
import { jcs } from '../../../packages/attest-verify/src/index.ts';
import { txFacts, txHash } from './stand-in-eth-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEYS_FILE = path.resolve(HERE, '../parity/partner-keys.json');
export const SEED_FILE = path.resolve(HERE, '../parity/seed.json');

// ── the institutions ─────────────────────────────────────────────────────────

const BFI_AUTHORITY = ['TRAVEL_RULE_RECEIVED', 'PAYOUT_ACCEPTED', 'USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED', 'travelRule', 'payoutReceipts'];
/**
 * Who the stand-in is. The first three are the simulator's institutions under the simulator's ids and names
 * (demo-partners/setup.mjs); `bfi2` is a second beneficiary institution, `stranger` a key nobody registers.
 */
export const INSTITUTIONS = {
  bfi: { id: 'SG-BFI-001', role: 'BENEFICIARY_FI', country: 'SG', name: 'Triple-A profile BFI (sim)', authority: BFI_AUTHORITY, encrypts: true, registered: true },
  sgbank: { id: 'SG-PAYBANK-001', role: 'LOCAL_PAYOUT_BANK', country: 'SG', name: 'SG Payout Bank (FAST sim)', authority: ['LOCAL_CREDIT_CONFIRMED'], encrypts: false, registered: true },
  wallet: { id: 'SETTLE-ENTITY-001', role: 'SETTLEMENT_ENTITY', country: 'SG', name: 'Licensed Settlement Entity (sim)', authority: ['USDC_TRANSFER_CONFIRMED', 'chainTransfer'], encrypts: false, registered: true },
  bfi2: { id: 'SG-BFI-002', role: 'BENEFICIARY_FI', country: 'SG', name: 'Second beneficiary FI (stand-in)', authority: BFI_AUTHORITY, encrypts: true, registered: true },
  stranger: { id: 'SG-BFI-UNREGISTERED', role: 'BENEFICIARY_FI', country: 'SG', name: 'Nobody registered (stand-in)', authority: [], encrypts: false, registered: false },
};

/**
 * The stand-in's keys: read from `file`, made once when the file is not there. Test keys of throw-away schemas,
 * kept readable by their owner alone; nothing of them is ever printed. Two processes that start together agree:
 * the file is put in place in one step, and whoever loses reads the winner's.
 */
export function loadPartnerKeys(file = KEYS_FILE) {
  if (!fs.existsSync(file)) {
    const made = { note: 'Written by tools/stand-in-partner.mjs. Test keys of the partner stand-in; the seeds register their public halves. Never a live key.', made_at: new Date().toISOString(), institutions: {} };
    for (const [slug, inst] of Object.entries(INSTITUTIONS)) {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      made.institutions[slug] = { id: inst.id, signing: { pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), spki: spkiFromPublicKey(pair.publicKey) } };
      if (inst.encrypts) { const enc = generateEncryptionKey(); made.institutions[slug].encryption = { pem: enc.privatePem, jwk: enc.publicJwk }; }
    }
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(made, null, 1)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { fs.unlinkSync(tmp); }
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const institutions = {};
  for (const [slug, inst] of Object.entries(INSTITUTIONS)) {
    const k = stored.institutions?.[slug];
    if (!k?.signing?.pem || k.id !== inst.id) throw new Error(`${path.basename(file)} holds no key for ${slug} (${inst.id}) — remove the file to have it made again, then seed again`);
    const key = createPrivateKey(k.signing.pem);
    const spki = spkiFromPublicKey(createPublicKey(key));
    if (spki !== k.signing.spki) throw new Error(`${path.basename(file)}: the public half stored for ${slug} is not that of its key`);
    institutions[slug] = { slug, ...inst, key, spki };
    if (inst.encrypts) {
      if (!k.encryption?.pem) throw new Error(`${path.basename(file)} holds no encryption key for ${slug}`);
      institutions[slug].enc = { key: createPrivateKey(k.encryption.pem), jwk: k.encryption.jwk };
    }
  }
  return { file, institutions };
}

/** What each registered institution is registered with — the bodies demo-partners/setup.mjs sends, in its order, then `bfi2`. */
export function registrations(keys) {
  return ['bfi', 'sgbank', 'wallet', 'bfi2'].map((slug) => {
    const i = keys.institutions[slug];
    return { slug, body: { id: i.id, role: i.role, name: i.name, country: i.country, signing_spki: i.spki, authority: i.authority, ...(i.enc ? { encryption_jwk: i.enc.jwk } : {}) } };
  });
}

// ── what is a function of the payment id ─────────────────────────────────────

const of = (what, paymentId) => sha256hex(`stand-in partner ${what}\n${paymentId}`);
const digits = (hexText, n) => (BigInt(`0x${hexText}`) % (10n ** BigInt(n))).toString().padStart(n, '0');
export const CHAIN_LABEL = 'eip155:31337';
/** The settlement entity's treasury: the mock chain's second account. */
export const TREASURY = `0x${'11'.repeat(20)}`;
export const depositAddressOf = (paymentId) => `0x${of('deposit address', paymentId).slice(0, 40)}`;
export const rfiIdOf = (paymentId) => `RFI-${paymentId}`;
export const bankReferenceOf = (paymentId) => { const h = of('bank reference', paymentId); return `FAST-${digits(h.slice(0, 16), 8)}-${digits(h.slice(16, 32), 4)}`; };
/** The transfer's transaction: a hash the stand-in chain node knows, of the given kind (`confirmed` unless said). */
export const transferTxOf = (paymentId, kind = 'confirmed', fault = null) => txHash(kind, `transfer of ${paymentId}`, fault);
export const refundTxOf = (paymentId) => txHash('confirmed', `refund of ${paymentId}`);
export const RFI_QUESTIONS = [
  '지급 목적과 기초 무역거래의 성격을 상술해 주십시오 (EDD — USD 20,000 이상).',
  '인보이스에 대응하는 선적서류(B/L 등) 참조번호를 제시해 주십시오.',
];
export const PAYOUT_FAILURE_REASON = '수취계좌 지급 불능 — FAST 거절 (데모 트리거 *.13)';
const USD_SGD = '1.3350';
const STEPS = {
  '/bfi/travel-rule': 'travel-rule', '/bfi/travel-rule-response': 'travel-rule-response', '/bfi/payout-approval': 'payout-approval',
  '/wallet/transfer': 'transfer', '/bfi/settlement-notice': 'settlement-notice', '/bfi/cancel': 'cancel',
};
export const STEP_NAMES = Object.values(STEPS);

/** '10000.00' → 10000000000n (six decimals), as the simulator's chain client reads an amount. */
function usdcUnits(amount) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!m) throw new Error(`not a USDC amount: ${amount}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}
function unitsToUsdc(units) {
  const s = units.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6, -4)}`;
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const normal = (b) => (b === undefined || b === null ? { do: 'normal' } : typeof b === 'string' ? { do: b } : { do: 'normal', ...b });
/** One character of a base64url (or hex) text changed: a signature or a digest that no longer holds. */
const flip = (text) => `${text[0] === 'A' ? 'B' : text[0] === '0' ? '1' : text[0] === 'a' ? 'b' : 'A'}${text.slice(1)}`;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Every listener of this process, by name — so that one can show or compare another's log. */
const LISTENERS = new Map();

/**
 * One partner: the engine behind a listener, or — given `deliver` and `platformSpki` — a partner inside the
 * caller's own process.
 *
 *   name          what the log calls it (a listener's port)
 *   core          the one address it may call (`/v1/remit/meta`, `/v1/remit/callbacks`), or null with `deliver`
 *   keys          `loadPartnerKeys()`
 *   platformSpki  the platform's key, where it need not be asked for
 *   deliver       `async (text) => ({ status, body })`: hands a callback over without a socket
 *   seedLedger    `(paymentId) => record | null`: what the partner remembered of a seeded payment
 *   senderCheck   'enforce' (refuse a request whose sender does not verify, as the simulator does) or 'record'
 */
export function createStandIn(opts) {
  const name = String(opts.name ?? 'stand-in');
  const core = opts.core ? String(opts.core).replace(/\/+$/, '') : null;
  const K = opts.keys.institutions;
  const s = {
    ledger: new Map(), plans: { ids: new Map(), prefixes: new Map(), all: null, taken: new Map() }, log: [], held: new Map(), sent: [], runs: new Set(),
    hooks: new Map(), hookScripts: new Map(), waiters: [], n: 0, heldN: 0, platformSpki: opts.platformSpki ?? null,
  };

  // ── the partner's memory ───────────────────────────────────────────────────
  function recOf(paymentId) {
    if (typeof paymentId !== 'string') return undefined;
    if (!s.ledger.has(paymentId)) {
      const seeded = opts.seedLedger?.(paymentId);
      if (seeded) s.ledger.set(paymentId, clone(seeded));
    }
    return s.ledger.get(paymentId);
  }

  // ── plans ──────────────────────────────────────────────────────────────────
  function planFor(paymentId) {
    if (typeof paymentId !== 'string') return s.plans.all ?? {};
    if (s.plans.ids.has(paymentId)) return s.plans.ids.get(paymentId);
    if (s.plans.taken.has(paymentId)) return s.plans.taken.get(paymentId);
    let best = null;
    for (const [prefix, plan] of s.plans.prefixes) if (paymentId.startsWith(prefix) && (best === null || prefix.length > best[0].length)) best = [prefix, plan];
    const shared = best ? best[1] : s.plans.all;
    if (!shared) return {};
    // A plan for many payments is each payment's own from that payment's first request on: a list in it is used up per payment.
    const own = clone(shared);
    s.plans.taken.set(paymentId, own);
    return own;
  }
  function setPlan(p) {
    if (p.reset) { s.plans.ids.clear(); s.plans.prefixes.clear(); s.plans.all = null; s.plans.taken.clear(); }
    const plan = { steps: clone(p.steps) ?? {}, callbacks: clone(p.callbacks), sender: p.sender };
    const where = typeof p.payment_id === 'string' ? [s.plans.ids, p.payment_id] : typeof p.prefix === 'string' ? [s.plans.prefixes, p.prefix] : null;
    for (const step of Object.keys(plan.steps)) if (!STEP_NAMES.includes(step)) throw httpErr(400, `no such step: ${step} (steps: ${STEP_NAMES.join(', ')})`);
    if (where) { if (p.clear) where[0].delete(where[1]); else where[0].set(where[1], plan); } else if (p.all) s.plans.all = p.clear ? null : plan;
    else if (!p.reset) throw httpErr(400, 'a plan names a payment_id, a prefix, or all: true');
    // A plan for many payments, set or cleared, starts afresh for every payment it is for.
    if (where?.[0] !== s.plans.ids) s.plans.taken.clear();
    return { plans: s.plans.ids.size + s.plans.prefixes.size + (s.plans.all ? 1 : 0) };
  }
  /** The behaviour of this request: a list in a plan is used up one request at a time, then the rules apply again. */
  function behaviourOf(plan, step) {
    const b = plan.steps?.[step];
    if (Array.isArray(b)) return normal(b.length > 0 ? b.shift() : 'normal');
    return normal(b);
  }
  const showPlans = () => ({ payments: Object.fromEntries(s.plans.ids), prefixes: Object.fromEntries(s.plans.prefixes), all: s.plans.all });

  // ── the log, and waiting for something to arrive in it ─────────────────────
  function record(entry) {
    const e = { n: ++s.n, at: new Date().toISOString(), listener: name, ...entry };
    s.log.push(e);
    for (const w of [...s.waiters]) w.look();
    return e;
  }
  const matches = (e, f) => (f.dir === undefined || e.dir === f.dir) && (f.step === undefined || e.step === f.step) && (f.path === undefined || e.path === f.path)
    && (f.payment_id === undefined || e.payment_id === f.payment_id) && (f.type === undefined || e.type === f.type) && (!f.answered || e.answer !== null);
  /** Resolves with the n-th entry that matches, as soon as it is there; with null after `timeout` ms. */
  function waitFor(filter, n = 1, timeout = 15_000) {
    return new Promise((resolve) => {
      const w = { look() { const found = s.log.filter((e) => matches(e, filter)); if (found.length >= n) { done(found[n - 1]); } } };
      const timer = setTimeout(() => done(null), timeout);
      function done(v) { clearTimeout(timer); s.waiters = s.waiters.filter((x) => x !== w); resolve(v); }
      s.waiters.push(w);
      w.look();
    });
  }
  const changed = () => { for (const w of [...s.waiters]) w.look(); };

  // ── signing ────────────────────────────────────────────────────────────────
  function signAs(payload, slug, b) {
    const who = K[b?.signedBy ?? slug];
    if (!who) throw httpErr(400, `no such signer: ${b?.signedBy}`);
    const sig = signEvent(payload, who.key, who.id, who.name);
    return b?.breakSignature ? { ...sig, sig: flip(sig.sig) } : sig;
  }
  /** Digest, then sign — the order every issuer follows; `e` says what is to be wrong with the element, if anything. */
  function finish(coreIn, slug, e) {
    const c = { ...coreIn, ...(e?.with ?? {}) };
    for (const k of e?.omit ?? []) delete c[k];
    if (e?.unsigned) return { ...c, digest: elementDigest(c), signature: { status: 'ABSENT' } };
    const who = K[e?.signedBy ?? slug];
    if (!who) throw httpErr(400, `no such signer: ${e?.signedBy}`);
    let el = signEvidenceElement({ ...c, digest: elementDigest(c) }, who.key, who.id, who.name);
    if (e?.breakDigest) el = { ...el, digest: flip(el.digest) };
    if (e?.breakSignature) el = { ...el, signature: { ...el.signature, value: flip(el.signature.value) } };
    if (e?.after) el = { ...el, ...e.after };
    return el;
  }
  const change = (payload, b) => { const out = { ...payload, ...(b?.with ?? {}) }; return out; };

  // ── the platform's key, and the sender check ───────────────────────────────
  async function platformKey() {
    if (s.platformSpki) return s.platformSpki;
    if (!core) throw new Error('the stand-in was given neither the platform key nor a core to ask for it');
    const res = await fetch(`${core}/v1/remit/meta`, { signal: AbortSignal.timeout(5000) });
    const meta = await res.json();
    s.platformSpki = meta.platform_signer?.spki;
    if (!s.platformSpki) throw new Error('core /v1/remit/meta has no platform signer');
    return s.platformSpki;
  }
  async function checkSender(payload, sig, entry, plan) {
    const enforce = (plan.sender ?? opts.senderCheck ?? 'enforce') !== 'record';
    if (!sig) { entry.sender = 'absent'; if (enforce) throw httpErr(400, 'missing sender signature'); return; }
    let spki;
    try { spki = await platformKey(); } catch (e) { entry.sender = 'not checked: the platform key could not be read'; if (enforce) throw e; return; }
    const ok = typeof sig === 'object' && verifyEvent(payload, sig, spki);
    entry.sender = ok ? 'valid' : 'invalid';
    if (!ok) {
      if (!opts.platformSpki) s.platformSpki = null; // the key may have changed: ask again next time
      if (enforce) throw httpErr(400, 'sender signature does not verify against the platform key');
    }
  }

  // ── opening what was encrypted to an institution of ours ───────────────────
  function openJwe(compact, prefer) {
    let kid = null;
    try { kid = JSON.parse(Buffer.from(String(compact).split('.')[0], 'base64url').toString('utf8')).kid ?? null; } catch { /* decided below */ }
    const named = Object.values(K).find((i) => i.enc && `${i.id}-ENC` === kid);
    const order = [...new Set([named?.slug, prefer, 'bfi', 'bfi2'].filter(Boolean))];
    let failure;
    for (const slug of order) {
      try { return { text: decryptJwe(compact, K[slug].enc.key).toString('utf8'), slug }; } catch (e) { failure ??= e; }
    }
    throw failure;
  }

  // ── the six calls ──────────────────────────────────────────────────────────
  async function travelRule(body, b, entry, plan) {
    const { payment_id, jwe, ivms101_digest, sender } = body;
    if (!payment_id || !jwe) throw httpErr(400, 'payment_id and jwe are required');
    await checkSender({ payment_id, ivms101_digest }, sender, entry, plan);
    let ivms; let slug;
    try { const opened = openJwe(jwe); slug = opened.slug; ivms = JSON.parse(opened.text); } catch (e) { throw httpErr(400, `JWE does not decrypt with this institution's key: ${e.message}`); }
    if (sha256hex(Buffer.from(jcs(ivms))) !== ivms101_digest) throw httpErr(400, 'ivms101_digest does not match the decrypted message');
    entry.opened = { by: K[slug].id, plaintext_sha256: sha256hex(Buffer.from(JSON.stringify(ivms), 'utf8')), digest_matches: true };

    const up = ivms.underlyingPayment ?? {};
    const originatorName = up.originator?.originatorPersons?.[0]?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? '';
    const beneficiaryName = up.beneficiary?.beneficiaryPersons?.[0]?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? '';
    const beneficiaryAccount = up.beneficiary?.beneficiaryPersons?.[0]?.accountNumber?.[0] ?? '';
    const screening = /SANCTIONED/i.test(beneficiaryName) ? 'HIT' : 'CLEAR';
    let what = ['ack', 'rfi', 'rfi-bare', 'reject'].includes(b.do) ? b.do : null;
    let reason = b.reason;
    const forced = what !== null;
    if (!forced) {
      if (!originatorName || !beneficiaryName || !beneficiaryAccount) { what = 'rfi-bare'; reason = 'originator name, beneficiary name and beneficiary account are required'; }
      else if (screening === 'HIT') { what = 'reject'; reason = 'beneficiary failed sanctions screening (demo list)'; }
      else if (Number(up.transaction?.amount ?? '0') >= 20000 && !recOf(payment_id)?.rfi_answered) what = 'rfi';
      else what = 'ack';
    }
    const remembered = {
      payment_id, bfi: slug, ivms101_digest, screening,
      beneficiary: { name: beneficiaryName, account: beneficiaryAccount, bank: up.beneficiaryLocalBank ?? 'DBS (sim)' },
      originator_masked: `${originatorName.slice(0, 2)}***`,
      trade: { amount: up.transaction?.amount ?? '', currency: up.transaction?.currency ?? '' },
    };
    if (what === 'reject') return { status: 200, body: { status: 'REJECTED', ...(typeof reason === 'string' ? { reason } : {}) } };
    if (what === 'rfi-bare') {
      // The simulator keeps nothing of such a request, so an answer to it cannot verify there. `remember` keeps it.
      if (forced && b.remember) s.ledger.set(payment_id, { ...remembered, state: 'TR_RFI', rfi_id: rfiIdOf(payment_id), received_at: new Date().toISOString() });
      return { status: 200, body: { status: 'RFI', ...(typeof reason === 'string' ? { reason } : {}) } };
    }
    if (what === 'rfi') {
      const rfi_id = b.id ?? rfiIdOf(payment_id);
      s.ledger.set(payment_id, { ...remembered, state: 'TR_RFI', rfi_id, received_at: new Date().toISOString() });
      return { status: 200, body: { status: 'RFI', rfi: { id: rfi_id, questions: b.questions ?? RFI_QUESTIONS } } };
    }
    const received_at = new Date().toISOString();
    const ackPayload = change({ payment_id, ivms101_digest, status: 'ACCEPTED', received_at }, b);
    const ack = { payload: ackPayload, sig: signAs(ackPayload, slug, b) };
    s.ledger.set(payment_id, { ...(recOf(payment_id) ?? {}), ...remembered, state: 'TR_ACCEPTED', received_at, ack_digest: sha256hex(Buffer.from(jcs(ackPayload))) });
    return { status: 200, body: { status: 'ACK', ack } };
  }

  async function travelRuleResponse(body, b, entry, plan) {
    const { payment_id, jwe, answers_digest, sender } = body;
    const rec = recOf(payment_id);
    await checkSender({ payment_id, rfi_id: rec?.rfi_id ?? '', answers_digest }, sender, entry, plan);
    if (!rec || rec.state !== 'TR_RFI') throw httpErr(409, 'no outstanding RFI for this payment');
    let message;
    try { message = JSON.parse(openJwe(jwe, rec.bfi).text); } catch (e) { throw httpErr(400, `answers JWE does not decrypt: ${e.message}`); }
    if (sha256hex(Buffer.from(jcs(message))) !== answers_digest) throw httpErr(400, 'answers_digest does not match the decrypted answers');
    entry.opened = { by: K[rec.bfi ?? 'bfi'].id, plaintext_sha256: sha256hex(Buffer.from(JSON.stringify(message), 'utf8')), digest_matches: true };
    const answers = message.answers ?? {};
    let what = ['ack', 'reject'].includes(b.do) ? b.do : null;
    let reason = b.reason;
    if (!what) {
      if (Object.values(answers).every((v) => !String(v ?? '').trim())) { what = 'reject'; reason = 'RFI answers were empty'; } else what = 'ack';
    }
    if (what === 'reject') return { status: 200, body: { status: 'REJECTED', ...(typeof reason === 'string' ? { reason } : {}) } };
    const received_at = new Date().toISOString();
    const ackPayload = change({ payment_id, ivms101_digest: rec.ivms101_digest, status: 'ACCEPTED', via: 'RFI_RESOLVED', rfi_id: rec.rfi_id, received_at }, b);
    rec.state = 'TR_ACCEPTED';
    rec.rfi_answered = true;
    rec.ack_digest = sha256hex(Buffer.from(jcs(ackPayload)));
    return { status: 200, body: { status: 'ACK', ack: { payload: ackPayload, sig: signAs(ackPayload, rec.bfi ?? 'bfi', b) } } };
  }

  async function cancel(body, b, entry, plan) {
    const { payment_id, reason, sender } = body;
    await checkSender({ payment_id, reason }, sender, entry, plan);
    const rec = recOf(payment_id);
    if (rec && rec.state !== 'PAID_OUT') { rec.state = 'CANCELLED'; rec.cancel_reason = reason; }
    return { status: 200, body: { acknowledged: true } };
  }

  async function payoutApproval(body, b, entry, plan) {
    const { sender, ...payload } = body;
    await checkSender(payload, sender, entry, plan);
    const { payment_id, usdc_amount, trade, payout, quote_id } = payload;
    const rec = recOf(payment_id);
    if (!rec || rec.state !== 'TR_ACCEPTED') throw httpErr(409, 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)');
    const slug = rec.bfi ?? 'bfi';
    const deposit_address = depositAddressOf(payment_id);
    const approved_at = new Date().toISOString();
    const valid_until = new Date(Date.now() + 15 * 60_000).toISOString();
    const travel_rule_element = finish({
      protocol: 'IVMS101/JWE', ivms101Digest: rec.ivms101_digest, originatingVasp: K.wallet.id, beneficiaryVasp: K[slug].id,
      approvalStatus: 'APPROVED', approvalDigest: rec.ack_digest, approvedAt: approved_at, approvedBeneficiaryAddress: deposit_address,
    }, slug, b.element);
    const approvalPayload = change({ payment_id, deposit_address, chain: CHAIN_LABEL, asset: 'USDC', usdc_amount, approved_at, valid_until, travel_rule_element }, b);
    Object.assign(rec, { state: 'PRE_APPROVED', deposit_address, approved_at, valid_until, usdc_amount, trade, payout, quote_id: quote_id ?? null });
    return { status: 200, body: { approval: { payload: approvalPayload, sig: signAs(approvalPayload, slug, b) } } };
  }

  async function transfer(body, b, entry, plan) {
    const { instruction } = body;
    if (!instruction?.payload || !instruction.sig) throw httpErr(400, 'instruction {payload, sig} required');
    await checkSender(instruction.payload, instruction.sig, entry, plan);
    const { payment_id, to_address, usdc_amount } = instruction.payload;
    const rec = recOf(payment_id);
    if (!rec || rec.state !== 'PRE_APPROVED') throw httpErr(403, 'no pre-approved payout for this payment');
    if (rec.deposit_address !== to_address) throw httpErr(403, 'destination is not the approved deposit address');
    if (rec.usdc_amount !== usdc_amount) throw httpErr(403, 'amount differs from the approved amount');
    if (Date.parse(rec.valid_until) < Date.now()) throw httpErr(403, 'approval validity window has passed');
    if (usdcUnits(usdc_amount) > usdcUnits('50000.00')) throw httpErr(403, 'per-payment cap exceeded (sandbox: 50,000 mUSDC)');
    const kind = typeof b.tx === 'string' ? [b.tx, null] : b.tx ? [b.tx.kind ?? 'confirmed', b.tx.fault ?? null] : ['confirmed', null];
    const tx_hash = typeof b.with?.tx_hash === 'string' ? b.with.tx_hash : transferTxOf(payment_id, kind[0], kind[1]);
    const block = txFacts(tx_hash)?.block ?? 0;
    const observed_at = new Date().toISOString();
    const chain_transfer_element = finish({
      chain: CHAIN_LABEL, asset: 'USDC', amount: usdc_amount, currency: 'USDC', fromAddress: TREASURY, toAddress: to_address,
      txRef: tx_hash, settlementIdMemo: payment_id, confirmations: 1, observedAt: observed_at,
    }, 'wallet', b.element);
    const resultPayload = change({ payment_id, tx_hash, block, from_address: TREASURY, to_address, usdc_amount, observed_at, chain_transfer_element }, b);
    rec.state = 'FUNDS_IN_FLIGHT';
    rec.tx_hash = tx_hash;
    return { status: 200, body: { result: { payload: resultPayload, sig: signAs(resultPayload, 'wallet', b) } } };
  }

  async function settlementNotice(body, b, entry, plan) {
    const { payment_id, tx_hash, sender } = body;
    await checkSender({ payment_id, tx_hash }, sender, entry, plan);
    const rec = recOf(payment_id);
    if (!rec) throw httpErr(404, 'unknown payment');
    // The notice is acknowledged; what the institution saw is reported through callbacks, once the answer is out.
    return { status: 202, body: { acknowledged: true }, after: () => { startRun(payment_id, plan); } };
  }
  const WORK = { 'travel-rule': travelRule, 'travel-rule-response': travelRuleResponse, cancel, 'payout-approval': payoutApproval, transfer, 'settlement-notice': settlementNotice };

  // ── callbacks ──────────────────────────────────────────────────────────────
  const levelOf = (rec) => { const a = String(rec?.trade?.amount ?? ''); return a.endsWith('.01') ? 'L1' : a.endsWith('.02') ? 'L2' : 'L3'; };
  const failsOf = (rec) => String(rec?.trade?.amount ?? '').endsWith('.13');
  function callbackPlan(plan) {
    const c = plan.callbacks;
    if (c === undefined || c === null || c === 'auto') return { mode: 'auto' };
    if (typeof c === 'string') return { mode: c };
    return { mode: 'auto', ...c };
  }
  /** What the simulator sends after a settlement notice, in its order. */
  function sequenceOf(rec, c) {
    if (Array.isArray(c.sequence)) return c.sequence;
    const fail = c.fail ?? failsOf(rec);
    return ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', ...(fail ? ['PAYOUT_FAILED', 'USDC_RETURNED'] : [{ type: 'PAYOUT_COMPLETED', ...(c.level ? { level: c.level } : {}) }])];
  }
  function startRun(paymentId, plan) {
    const c = callbackPlan(plan);
    if (c.mode !== 'auto') return null;
    const run = { payment_id: paymentId, done: null };
    run.done = (async () => {
      const rec = recOf(paymentId);
      if (!rec) return;
      if (!rec.tx_hash) { rec.state = 'ERROR'; rec.error = 'USDC not observed at the deposit address'; return; }
      if (typeof c.delay === 'number') await sleep(c.delay);
      for (const [i, spec] of sequenceOf(rec, c).entries()) {
        if (i > 0 && typeof c.gap === 'number') await sleep(c.gap);
        const r = await callback({ ...(typeof spec === 'string' ? { type: spec } : spec), payment_id: paymentId });
        if (r.answer.error !== undefined || r.answer.status >= 400) {
          // As the simulator: a refused callback ends the run. Nothing is sent again.
          rec.state = 'ERROR';
          rec.error = r.answer.error !== undefined ? `core callback ${r.sent.type}: ${r.answer.error}`
            : `core callback ${r.sent.type} → ${r.answer.status}: ${r.answer.body?.message ?? r.answer.body?.error ?? ''}`;
          return;
        }
      }
    })().catch((e) => { const rec = recOf(paymentId); if (rec) { rec.state = 'ERROR'; rec.error = String(e.message ?? e); } }).finally(() => { s.runs.delete(run); changed(); });
    s.runs.add(run);
    return run;
  }
  /** Resolves when no automatic callbacks are under way (for one payment, or at all). */
  async function idle(paymentId, timeout = 15_000) {
    const until = Date.now() + timeout;
    for (;;) {
      const open = [...s.runs].filter((r) => paymentId === undefined || r.payment_id === paymentId);
      if (open.length === 0) return true;
      if (Date.now() > until) return false;
      await Promise.race([Promise.all(open.map((r) => r.done)), sleep(Math.max(1, until - Date.now()))]);
    }
  }

  /** The payload of one callback, as the simulator words it, from what the partner remembers of the payment. */
  function payloadOf(type, paymentId, rec, spec) {
    const now = new Date().toISOString();
    switch (type) {
      case 'USDC_RECEIVED': {
        const tx = rec?.tx_hash ?? transferTxOf(paymentId);
        if (rec) { rec.state = 'USDC_RECEIVED'; rec.received_tx = tx; }
        return { payment_id: paymentId, tx_hash: tx, block: txFacts(tx)?.block ?? 0, amount: unitsToUsdc(usdcUnits(rec?.usdc_amount ?? '0')), observed_at: now };
      }
      case 'PAYOUT_SUBMITTED': return { payment_id: paymentId, local_rail: 'FAST', submitted_at: now };
      case 'PAYOUT_FAILED': return { payment_id: paymentId, reason: PAYOUT_FAILURE_REASON, failed_at: now };
      case 'USDC_RETURNED': {
        const tx = refundTxOf(paymentId);
        if (rec) { rec.state = 'REFUNDED'; rec.refund_tx = tx; }
        return { payment_id: paymentId, tx_hash: tx, block: txFacts(tx).block, amount: rec?.usdc_amount ?? '0.00', returned_to: TREASURY, returned_at: now };
      }
      case 'PAYOUT_COMPLETED': {
        const stated = spec.level ?? levelOf(rec);
        const level = stated === 'none' ? 'L2' : stated; // nothing stated: the element is the signed one without a bank reference
        const reference = bankReferenceOf(paymentId);
        const credited_at = now;
        const amount = rec?.payout?.amount ?? '0.00';
        const slug = rec?.bfi ?? 'bfi';
        const confirmationPayload = { bank: K.sgbank.id, reference, account: rec?.beneficiary?.account ?? '', amount, currency: 'SGD', credited_at };
        const receiptCore = {
          ref: `${paymentId}/${reference}`, amount: rec?.trade?.amount ?? rec?.usdc_amount ?? '0.00', currency: 'USD', paidAt: credited_at,
          local_amount: rec?.payout?.amount ?? '', local_currency: 'SGD', local_rate_pair: 'USD/SGD', local_rate: USD_SGD, quote_ref: rec?.quote_id ?? '',
          ...(stated === 'none' ? {} : { evidence_level: level }), beneficiary_bank: rec?.beneficiary?.bank ?? 'DBS (sim)',
          // L3 carries the local bank's reference and its own signed confirmation; L2 is the institution's signature alone; L1 is unsigned.
          ...(level === 'L3' ? { bank_reference: reference, local_credit_confirmation: { payload: confirmationPayload, sig: signAs(confirmationPayload, 'sgbank', spec.confirmation) } } : {}),
        };
        const payout_receipt_element = finish(receiptCore, slug, { ...(level === 'L1' ? { unsigned: true } : {}), ...(spec.element ?? {}) });
        if (rec) { rec.state = 'PAID_OUT'; rec.bank_reference = reference; rec.evidence_level = level; }
        return { payment_id: paymentId, ...(level === 'L3' ? { bank_reference: reference } : {}), credited_at, ...(stated === 'none' ? {} : { evidence_level: level }), payout_receipt_element };
      }
      default: return { payment_id: paymentId, noted_at: now };
    }
  }

  /** Signs one callback and hands it to the core; answers with what was sent and what the core said. */
  async function callback(specIn) {
    const spec = typeof specIn === 'string' ? { type: specIn } : { ...specIn };
    const paymentId = spec.payment_id;
    const rec = recOf(paymentId);
    let body; let text; let signer = spec.signedBy ?? rec?.bfi ?? 'bfi';
    if (spec.again) {
      const earlier = [...s.sent].reverse().find((c) => c.payment_id === paymentId && (spec.type === undefined || c.type === spec.type));
      if (!earlier) throw httpErr(409, 'no earlier callback of that kind was sent for this payment');
      if (spec.again === 'bytes') { body = earlier.body; text = earlier.text; } else {
        signer = spec.signedBy ?? earlier.signer;
        body = { type: earlier.body.type, payload: earlier.body.payload, sig: signAs(earlier.body.payload, signer, spec) };
      }
    } else {
      if (typeof spec.type !== 'string' && spec.payload === undefined) throw httpErr(400, 'a callback names its type');
      let payload = spec.payload !== undefined ? clone(spec.payload) : payloadOf(spec.type, paymentId, rec, spec);
      if (payload !== null && typeof payload === 'object') { payload = { ...payload, ...(spec.with ?? {}) }; for (const k of spec.omit ?? []) delete payload[k]; }
      body = { type: spec.type, payload, sig: signAs(payload, signer, spec) };
      for (const k of spec.drop ?? []) delete body[k];
      if (spec.top) Object.assign(body, spec.top);
    }
    text ??= JSON.stringify(body);
    const sentRecord = { payment_id: paymentId, type: body.type, body, text, signer };
    s.sent.push(sentRecord);
    const entry = record({ dir: 'out', method: 'POST', path: '/v1/remit/callbacks', step: 'callback', type: body.type ?? null, payment_id: paymentId ?? null, signed_by: K[signer]?.id ?? null, again: spec.again ?? null, body, answer: null });
    let answer;
    try {
      if (opts.deliver) answer = await opts.deliver(text);
      else {
        const res = await fetch(`${core}/v1/remit/callbacks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(10_000) });
        const got = await res.text();
        let parsed; try { parsed = JSON.parse(got); } catch { parsed = got; }
        answer = { status: res.status, body: parsed };
      }
    } catch (e) {
      answer = { error: String(e.message ?? e) };
    }
    entry.answer = answer;
    changed();
    return { sent: body, answer };
  }

  // ── the webhook receiver ───────────────────────────────────────────────────
  async function hook(hookName, h, text) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* kept as text */ }
    const list = s.hooks.get(hookName) ?? [];
    s.hooks.set(hookName, list);
    const delivery = { n: list.length + 1, at: new Date().toISOString(), headers: { 'content-type': h['content-type'] ?? null, 'user-agent': h['user-agent'] ?? null }, raw: text, body: parsed, answered: null };
    list.push(delivery);
    changed();
    const script = s.hookScripts.get(hookName);
    const step = Array.isArray(script) ? (script.length > 0 ? script.shift() : null) : script ?? null;
    if (step?.hold) await sleep(step.hold);
    delivery.answered = step?.status ?? 200;
    return json(delivery.answered, delivery.answered < 300 ? { received: true } : { error: 'scripted', message: 'the stand-in receiver was told to answer so' });
  }
  const reduceHook = (d) => ({ n: d.n, headers: { 'content-type': d.headers['content-type'] }, body: reduce(d.body), answered: d.answered });

  // ── what a comparison of two listeners looks at ────────────────────────────
  /** A value with what differs from run to run reduced to its kind: times, signatures, digests over times, ciphertext. */
  function reduce(v, key) {
    if (typeof v === 'string') {
      if (ISO_TIME.test(v)) return '<time>';
      if ((key === 'sig' || key === 'value') && /^[A-Za-z0-9_-]{86}$/.test(v)) return '<signature>';
      // Digests over something that holds a time, and what a core makes up (ids, a commitment over a nonce).
      if ((key === 'digest' || key === 'approvalDigest' || key === 'commitment') && /^[0-9a-f]{64}$/.test(v)) return '<digest>';
      if ((key === 'event_id' || key === 'attestation_id') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return '<id>';
      if ((key === 'jwe' || key === 'ciphertext') && v.split('.').length === 5) {
        let header = null; try { header = JSON.parse(Buffer.from(v.split('.')[0], 'base64url').toString('utf8')); } catch { /* shown as null */ }
        let opened = null;
        try { const o = openJwe(v); opened = { by: K[o.slug].id, plaintext_sha256: sha256hex(Buffer.from(o.text, 'utf8')) }; } catch { /* not ours to open */ }
        return { jwe: { parts: 5, header: header ? { ...header, ...(header.epk ? { epk: '<key>' } : {}) } : null, opened } };
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => reduce(x));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reduce(x, k)]));
    return v;
  }
  function summary() {
    const entries = s.log.map((e) => ({
      dir: e.dir, path: e.path, step: e.step, ...(e.type !== undefined ? { type: e.type } : {}), payment_id: e.payment_id,
      ...(e.dir === 'in' ? { headers: { 'idempotency-key': e.headers['idempotency-key'], 'content-type': e.headers['content-type'] }, sender: e.sender, behaviour: e.behaviour } : { signed_by: e.signed_by, again: e.again }),
      body: reduce(e.body), ...(e.opened ? { opened: e.opened } : {}), answer: e.answer === null ? null : reduce(e.answer),
    }));
    const by_payment = {};
    const other = [];
    for (const e of entries) { if (typeof e.payment_id === 'string') (by_payment[e.payment_id] ??= []).push(e); else other.push(e); }
    return { listener: name, core, requests: entries.length, by_payment, other, hooks: Object.fromEntries([...s.hooks].map(([k, list]) => [k, list.map(reduceHook)])) };
  }
  /** The two summaries side by side: equal apart from the headers? and what differs first. */
  function compareWith(other) {
    const [a, b] = [summary(), other.summary()];
    // Compared: what each partner was asked (the bodies, in order, payment by payment), what it answered, and the callbacks
    // it sent. Set apart: the request headers (one core sends an Idempotency-Key, the other none) and what the cores
    // answered to callbacks — those are the cores' own responses, which the response comparison looks at.
    const strip = (e) => JSON.parse(JSON.stringify({ ...e, ...(e.dir === 'out' ? { answer: undefined } : {}) }, (k, v) => (k === 'headers' ? undefined : v)));
    const differences = [];
    const ids = [...new Set([...Object.keys(a.by_payment), ...Object.keys(b.by_payment)])].sort();
    let headersDiffer = false; let callbackAnswersDiffer = false;
    for (const id of ids) {
      const [x, y] = [a.by_payment[id] ?? [], b.by_payment[id] ?? []];
      if (x.length !== y.length) { differences.push(`${id}: ${x.length} entries here (${x.map((e) => e.step).join(' ')}), ${y.length} there (${y.map((e) => e.step).join(' ')})`); continue; }
      for (const [i, e] of x.entries()) {
        if (JSON.stringify(strip(e)) !== JSON.stringify(strip(y[i]))) differences.push(`${id} #${i + 1} (${e.dir === 'out' ? `callback ${e.type}` : e.path}): differs`);
        else {
          if (JSON.stringify(e.headers) !== JSON.stringify(y[i].headers)) headersDiffer = true;
          if (e.dir === 'out' && JSON.stringify(e.answer) !== JSON.stringify(y[i].answer)) callbackAnswersDiffer = true;
        }
      }
    }
    if (JSON.stringify(a.other.map(strip)) !== JSON.stringify(b.other.map(strip))) differences.push('the requests that name no payment differ');
    if (JSON.stringify(a.hooks) !== JSON.stringify(b.hooks)) differences.push('what the webhook receivers got differs');
    return { listeners: [a.listener, b.listener], requests: [a.requests, b.requests], payments: ids.length, same: differences.length === 0, headers_differ: headersDiffer,
      callback_answers_differ: callbackAnswersDiffer, differences: differences.slice(0, 40) };
  }

  // ── answers ────────────────────────────────────────────────────────────────
  // As the simulator writes them: two spaces, and these two headers.
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' }, body: JSON.stringify(body, null, 2) });
  function refusal(status, kind, message, b) {
    if (b?.raw !== undefined) return { status, headers: { 'content-type': b.contentType ?? 'text/plain; charset=utf-8' }, body: String(b.raw) };
    if (b?.body !== undefined) return json(status, b.body);
    return json(status, { error: kind, message });
  }
  function settle(entry, outcome) {
    if (outcome.cut) entry.answer = { cut: true };
    else { let parsed; try { parsed = JSON.parse(outcome.body); } catch { parsed = outcome.body; } entry.answer = { status: outcome.status, body: parsed }; }
    changed();
    return outcome;
  }

  /** A request held back: answered when released, or when its time is up. */
  function hold(entry, b) {
    return new Promise((resolve) => {
      const item = { id: ++s.heldN, step: entry.step, payment_id: entry.payment_id, since: Date.now(), n: entry.n, then: normal(b.then), timer: null };
      item.release = (answer) => { clearTimeout(item.timer); s.held.delete(item.id); entry.held_ms = Date.now() - item.since; resolve(answer === undefined ? item.then : normal(answer)); };
      if (typeof b.ms === 'number') item.timer = setTimeout(() => item.release(), b.ms);
      s.held.set(item.id, item);
      entry.held = item.id;
      changed();
    });
  }
  function release(q) {
    const which = [...s.held.values()].filter((i) => (q.id === undefined || i.id === q.id) && (q.payment_id === undefined || i.payment_id === q.payment_id) && (q.step === undefined || i.step === q.step));
    for (const i of which) i.release(q.answer);
    return { released: which.length };
  }

  async function partnerCall(step, p, h, text) {
    let body; let unreadable = null;
    try { body = text.length > 0 ? JSON.parse(text) : {}; } catch (e) { unreadable = e; }
    const paymentId = unreadable ? null : step === 'transfer' ? body?.instruction?.payload?.payment_id : body?.payment_id;
    const entry = record({
      dir: 'in', method: 'POST', path: p, step, payment_id: typeof paymentId === 'string' ? paymentId : null,
      headers: { 'idempotency-key': h['idempotency-key'] ?? null, 'content-type': h['content-type'] ?? null, 'user-agent': h['user-agent'] ?? null },
      body: unreadable ? text : body, sender: null, behaviour: null, answer: null,
    });
    // The simulator parses the body before anything else and answers its engine's complaint under 500.
    if (unreadable) return settle(entry, json(500, { error: 'internal', message: String(unreadable.message) }));
    const plan = planFor(entry.payment_id);
    let b = behaviourOf(plan, step);
    entry.behaviour = b.do;
    if (b.do === 'hold') { b = await hold(entry, b); entry.behaviour = `hold, then ${b.do}`; }
    if (typeof b.delay === 'number') await sleep(b.delay);
    let outcome;
    if (b.do === 'drop') outcome = { cut: true };
    else if (b.do === 'refuse') outcome = refusal(b.status ?? 400, 'request_error', b.message ?? 'refused by the stand-in', b);
    else if (b.do === 'fail') outcome = refusal(b.status ?? 500, 'internal', b.message ?? 'the stand-in failed on purpose', b);
    else if (b.do === 'html') outcome = { status: b.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><body>stand-in partner: a page where JSON belongs</body></html>' };
    else if (b.do === 'raw') outcome = { status: b.status ?? 200, headers: { 'content-type': b.contentType ?? 'text/plain; charset=utf-8' }, body: String(b.body ?? '') };
    else {
      try {
        const done = await WORK[step](body ?? {}, b, entry, plan);
        if (b.do === 'fail-after') outcome = { ...refusal(b.status ?? 500, 'internal', b.message ?? 'the stand-in did the work and failed on purpose', b), after: done.after };
        else if (b.do === 'drop-after') outcome = { cut: true, after: done.after };
        else {
          const answer = { ...done.body, ...(b.top ?? {}) };
          for (const k of b.omit ?? []) delete answer[k];
          outcome = { ...json(b.http ?? done.status, answer), after: done.after };
          if (b.do === 'hold-after') {
            // The work is done and the partner's memory says so; the answer waits. Released with "drop", it is never given.
            const released = await hold(entry, { ms: b.ms });
            if (released.do === 'drop') outcome = { cut: true, after: done.after };
          }
        }
      } catch (e) {
        // The simulator's own error mapping: a refusal it worded keeps its status; anything else is a 500 with the complaint.
        outcome = json(e.status ?? 500, { error: e.status ? 'request_error' : 'internal', message: String(e.message ?? e) });
      }
    }
    if (typeof b.thenClose === 'number') outcome.close = b.thenClose;
    return settle(entry, outcome);
  }

  // ── the control API ────────────────────────────────────────────────────────
  async function control(method, p, query, text) {
    let body = {};
    if (method === 'POST' && text.length > 0) { try { body = JSON.parse(text); } catch { return json(400, { error: 'invalid_json', message: 'the control request is not JSON' }); } }
    const num = (k, d) => (query.get(k) === null ? d : Number(query.get(k)));
    const filterOf = () => ({ ...(query.get('payment_id') !== null ? { payment_id: query.get('payment_id') } : {}), ...(query.get('step') !== null ? { step: query.get('step') } : {}),
      ...(query.get('dir') !== null ? { dir: query.get('dir') } : {}), ...(query.get('type') !== null ? { type: query.get('type') } : {}), ...(query.get('answered') === '1' ? { answered: true } : {}) });
    try {
      if (method === 'POST' && p === '/control/plan') return json(200, setPlan(body));
      if (method === 'GET' && p === '/control/plan') return json(200, showPlans());
      if (method === 'GET' && p === '/control/held') return json(200, { held: [...s.held.values()].map((i) => ({ id: i.id, step: i.step, payment_id: i.payment_id, since: new Date(i.since).toISOString(), then: i.then.do })) });
      if (method === 'POST' && p === '/control/release') return json(200, release(body));
      if (method === 'GET' && p === '/control/wait') { const e = await waitFor(filterOf(), num('n', 1), num('timeout', 15_000)); return json(200, { arrived: e !== null, entry: e }); }
      if (method === 'GET' && p === '/control/idle') return json(200, { idle: await idle(query.get('payment_id') ?? undefined, num('timeout', 15_000)) });
      if (method === 'POST' && p === '/control/callback') return json(200, await callback(body));
      if (method === 'POST' && p === '/control/remember') { if (typeof body.payment_id !== 'string' || typeof body.record !== 'object') throw httpErr(400, 'payment_id and record are required'); s.ledger.set(body.payment_id, { payment_id: body.payment_id, ...clone(body.record) }); return json(200, { remembered: body.payment_id }); }
      if (method === 'GET' && p === '/control/ledger') return json(200, query.get('payment_id') !== null ? { record: recOf(query.get('payment_id')) ?? null } : { ledger: Object.fromEntries(s.ledger) });
      if (method === 'POST' && p === '/control/hook') {
        if (typeof body.name !== 'string') throw httpErr(400, 'name is required');
        if (body.clear) { s.hooks.delete(body.name); s.hookScripts.delete(body.name); } else s.hookScripts.set(body.name, Array.isArray(body.answers) ? clone(body.answers) : body.answer ? clone(body.answer) : null);
        return json(200, { hook: body.name });
      }
      if (method === 'POST' && p === '/control/close') { if (typeof body.ms !== 'number') throw httpErr(400, 'ms is required'); return { ...json(200, { closing_for_ms: body.ms }), close: body.ms }; }
      if (method === 'POST' && p === '/control/reset') { reset(); return json(200, { reset: true }); }
      if (method === 'GET' && p === '/control/status') {
        return json(200, { listener: name, core, institutions: Object.fromEntries(Object.values(K).map((i) => [i.slug, { id: i.id, role: i.role, registered: i.registered, key_sha256: sha256hex(i.spki).slice(0, 16) }])),
          payments: s.ledger.size, requests: s.log.length, held: s.held.size, callbacks_under_way: s.runs.size });
      }
    } catch (e) {
      return json(e.status ?? 500, { error: e.status ? 'request_error' : 'internal', message: String(e.message ?? e) });
    }
    return json(404, { error: 'not_found' });
  }
  function reset() {
    for (const i of [...s.held.values()]) i.release('drop');
    s.ledger.clear(); s.plans.ids.clear(); s.plans.prefixes.clear(); s.plans.all = null; s.plans.taken.clear(); s.log.length = 0; s.sent.length = 0; s.hooks.clear(); s.hookScripts.clear();
  }

  /**
   * One request. Answers `{ status, headers, body }` — or `{ cut: true }` for a connection to be closed without an
   * answer — with, where there is something to do once the answer is out, `after` (a function) and `close` (ms for
   * which the listener is to refuse connections).
   */
  async function handle({ method = 'GET', path: target = '/', headers = {}, body = '' }) {
    const url = new URL(target, 'http://stand-in.invalid');
    const p = url.pathname;
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    if (method === 'POST' && STEPS[p]) return partnerCall(STEPS[p], p, h, text);
    if (method === 'GET' && p === '/healthz') return json(200, { status: 'ok', chain: 'stand-in', listener: name, core });
    if (p.startsWith('/hooks/')) {
      const hookName = decodeURIComponent(p.slice('/hooks/'.length));
      if (method === 'POST') return hook(hookName, h, text);
      if (method === 'GET') { const list = s.hooks.get(hookName) ?? []; return json(200, { name: hookName, deliveries: url.searchParams.get('summary') === '1' ? list.map(reduceHook) : list }); }
    }
    if (method === 'GET' && p === '/hooks') return json(200, { hooks: Object.fromEntries([...s.hooks].map(([k, list]) => [k, list.length])) });
    if (p === '/log' || p.startsWith('/log/')) {
      const which = url.searchParams.get('listener');
      const target2 = which === null || which === name ? api : LISTENERS.get(which);
      if (!target2) return json(404, { error: 'not_found', message: `no listener ${which} in this process` });
      if (method === 'GET' && p === '/log') { const id = url.searchParams.get('payment_id'); return json(200, { listener: target2.name, core: target2.core, entries: target2.entries(id === null ? {} : { payment_id: id }) }); }
      if (method === 'GET' && p === '/log/summary') return json(200, target2.summary());
      if (method === 'GET' && p === '/log/compare') { const other = LISTENERS.get(url.searchParams.get('with') ?? ''); if (!other) return json(404, { error: 'not_found', message: 'compare?with=<a listener of this process>' }); return json(200, target2.compareWith(other)); }
      if (method === 'POST' && p === '/log/clear') { target2.clearLog(); return json(200, { cleared: true }); }
    }
    if (p.startsWith('/control/')) return control(method, p, url.searchParams, text);
    return json(404, { error: 'not_found' });
  }

  const api = {
    name, core, handle, plan: setPlan, plans: showPlans, callback, release, waitFor, idle, reset, summary, compareWith,
    entries: (filter = {}) => s.log.filter((e) => matches(e, filter)),
    clearLog: () => { s.log.length = 0; s.sent.length = 0; },
    held: () => [...s.held.values()].map((i) => ({ id: i.id, step: i.step, payment_id: i.payment_id })),
    /** How many automatic callback runs are under way (for one payment, or at all). */
    running: (paymentId) => [...s.runs].filter((r) => paymentId === undefined || r.payment_id === paymentId).length,
    record: recOf,
    remember: (paymentId, rec) => { s.ledger.set(paymentId, { payment_id: paymentId, ...clone(rec) }); },
    /** What the partner remembers, payment by payment — what a seed writes down for the listeners that come after it. */
    ledger: () => Object.fromEntries([...s.ledger].map(([k, v]) => [k, clone(v)])),
    hooks: (hookName) => s.hooks.get(hookName) ?? [],
  };
  return api;
}

/** A partner inside the caller's process, as a `fetch`: for a connector that is given `base` as its address. */
export function asFetch(standIn, base) {
  const root = String(base).replace(/\/+$/, '');
  return async (input, init = {}) => {
    const address = String(input);
    if (!address.startsWith(`${root}/`)) throw new TypeError(`fetch failed (the stand-in partner is not at ${address})`);
    const out = await standIn.handle({ method: init.method ?? 'GET', path: address.slice(root.length), headers: init.headers ?? {}, body: init.body ?? '' });
    if (out.after) setImmediate(out.after);
    if (out.cut) throw new TypeError('fetch failed');
    return new Response(out.status === 204 ? null : out.body, { status: out.status, headers: out.headers });
  };
}

// ── a listener: the engine behind a socket on 127.0.0.1 ──────────────────────

/** Ports something live listens on here (tools/check-test-env.mjs): never a listener's, never a core's. */
const LIVE_PORTS = new Set([8787, 3100, 3200, 3300, 3400, 3500, 5106, 8545, 18443]);
const MAX_BODY = 1 << 20;

/** Starts one listener on 127.0.0.1:`port` for the core at `coreAddress`. Resolves with `{ port, standIn, close }`. */
export function listen(port, coreAddress, opts) {
  const core = new URL(coreAddress);
  if (!['127.0.0.1', 'localhost'].includes(core.hostname)) throw new Error(`refusing: the core of listener ${port} is not on this machine`);
  if (LIVE_PORTS.has(Number(core.port)) || LIVE_PORTS.has(Number(port))) throw new Error(`refusing: ${LIVE_PORTS.has(Number(port)) ? `port ${port}` : `the core's port ${core.port}`} is a live one`);
  const standIn = createStandIn({ ...opts, name: String(port), core: core.origin });
  LISTENERS.set(String(port), standIn);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0; let tooLarge = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) tooLarge = true; else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', async () => {
      let out;
      try {
        out = tooLarge ? { status: 413, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: 'request_error', message: 'body too large' }, null, 2) }
          : await standIn.handle({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      } catch (e) {
        out = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: 'internal', message: String(e.message ?? e) }, null, 2) };
      }
      const afterwards = () => {
        if (out.after) setImmediate(out.after);
        if (typeof out.close === 'number') closeFor(out.close);
      };
      if (out.cut) { req.socket.destroy(); afterwards(); return; }
      if (res.destroyed || !res.socket || res.socket.destroyed) { afterwards(); return; }
      res.writeHead(out.status, { ...out.headers, 'content-length': Buffer.byteLength(out.body), ...(typeof out.close === 'number' ? { connection: 'close' } : {}) });
      res.end(out.body, afterwards);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let reopen = null; let closedSince = null;
  /** Refuses connections for `ms`: the socket is closed, and every connection kept open with it. Then it listens again. */
  function closeFor(ms) {
    if (closedSince !== null) return;
    closedSince = Date.now();
    server.close(() => { reopen = setTimeout(() => { reopen = null; closedSince = null; server.listen(port, '127.0.0.1'); }, Math.max(0, ms - (Date.now() - closedSince))); });
    server.closeIdleConnections();
    // The answer that asked for this is on its way out; whatever is still open a moment later is cut.
    setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 40);
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (e) => console.error(JSON.stringify({ msg: 'stand-in partner listener failed', port, error: String(e.message ?? e) })));
      resolve({ port, standIn, close: () => new Promise((ok) => { clearTimeout(reopen); standIn.reset(); server.close(() => ok()); for (const socket of sockets) socket.destroy(); LISTENERS.delete(String(port)); }) });
    });
  });
}

/** The partner's memory of the seeded payments, read from the seed file when a payment is not known — and again when the file has changed. */
export function seedLedgerFrom(file) {
  let stamp = null; let ledger = {};
  return (paymentId) => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== stamp) { stamp = st.mtimeMs; ledger = JSON.parse(fs.readFileSync(file, 'utf8')).remit?.partner?.ledger ?? {}; }
    } catch { return null; }
    return ledger[paymentId] ?? null;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const all = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const one = (flag, dflt) => all(flag)[0] ?? dflt;
  const pairs = all('--listen').map((v) => { const i = String(v).indexOf('='); return [Number(String(v).slice(0, i)), String(v).slice(i + 1)]; });
  if (pairs.length === 0 || pairs.some(([port, coreAddress]) => !Number.isInteger(port) || port < 1024 || !/^https?:\/\//.test(coreAddress))) {
    console.error('usage: node stand-in-partner.mjs --listen <port>=<core address> [--listen …] [--keys <file>] [--seed <file>] [--sender enforce|record]');
    process.exit(2);
  }
  const keys = loadPartnerKeys(one('--keys', KEYS_FILE));
  const seedFile = path.resolve(one('--seed', SEED_FILE));
  const seedLedger = seedLedgerFrom(seedFile);
  // The seeds register these keys' public halves. A seed file made with other keys means the cores hold other keys for
  // the partner than this process signs with: every signature of the stand-in would be refused. Said once, at the start.
  try {
    const registered = JSON.parse(fs.readFileSync(seedFile, 'utf8')).remit?.partner?.institutions ?? {};
    const other = Object.values(keys.institutions).filter((i) => registered[i.slug] && registered[i.slug].spki !== i.spki).map((i) => i.id);
    if (other.length > 0) console.error(JSON.stringify({ msg: 'WARNING: the seed file was made with other partner keys than this stand-in holds — seed again', institutions: other }));
  } catch { /* no seed file yet: nothing to compare with */ }
  const started = [];
  try {
    for (const [port, coreAddress] of pairs) started.push(await listen(port, coreAddress, { keys, seedLedger, senderCheck: one('--sender', 'enforce') }));
  } catch (e) {
    console.error(String(e.message ?? e));
    for (const l of started) await l.close();
    process.exit(1);
  }
  console.log(JSON.stringify({ msg: 'stand-in partner listening', listeners: started.map((l) => ({ port: l.port, core: l.standIn.core })) }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { Promise.all(started.map((l) => l.close())).then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
