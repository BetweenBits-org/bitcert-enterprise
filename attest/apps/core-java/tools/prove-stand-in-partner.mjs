/**
 * The partner stand-in, proved against the reference alone: one reference
 * core on a schema of the reference-harness's own, its partner address at a
 * stand-in listener, its chain address at the stand-in node — and a table of
 * scripted payments, each with the outcome the reference's code says it has.
 *
 *   node apps/core-java/tools/prove-stand-in-partner.mjs --env apps/core-java/.env.rref-a [--seed <seed file>]
 *        [--logs <dir>] [--only <text>] [--slow] [--workers] [--json <file>]
 *
 * It starts three processes — the stand-in chain node, the partner stand-in
 * and the reference core — on the ports the env file names (PORT, the port
 * of REMIT_PARTNERS_BASE, the port of REMIT_CHAIN_RPC), refuses when one of
 * them is taken, and stops what it started, by process id, however it ends.
 * The env file has to be safe for a test server (tools/check-test-env.mjs)
 * and its schema one of the harness's own (stonehash_test_remit…), seeded
 * (tools/seed-remit.mjs or tools/seed-reference.mjs): the bank is the seeded
 * organisation `rail`, with the key the seed file holds.
 *
 * The bank's side is the published SDK (packages/attest-remit). Every
 * scenario makes payments of its own (ids `PAY-PRF-<run>-…`); a few carry
 * seeded ones on, which is why the schema is to be seeded again afterwards.
 *
 * What it prints is the table for the notes: scenario → final state → events
 * → what was checked. `--slow` adds the scenarios that wait out the
 * reference's 20-second limit. `--workers` is for an env file with the
 * workers on, and runs one scenario instead of the table: the remit worker
 * promotes the seeded settlement whose anchor record is confirmed and
 * delivers the seeded webhooks to the stand-in's receiver, which is scripted
 * to refuse the first two. Exit status 0 when every expectation held.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RemitApiError, RemitClient, signEvent, verifyEvent, verifyEvidencePackage } from '../../../packages/attest-remit/src/index.ts';
import { problems, readEnvFile } from './check-test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const envFile = opt('--env');
if (!envFile) { console.error('usage: node prove-stand-in-partner.mjs --env <env file> [--seed <seed file>] [--logs <dir>] [--only <text>] [--slow] [--json <file>]'); process.exit(2); }
const env = readEnvFile(envFile);
const unsafe = problems(env);
const schema = new URL(env.STONEHASH_DB_URL ?? 'mysql://x/').pathname.replace(/^\//, '');
if (unsafe.length > 0 || !/^stonehash_test_remit[a-z0-9_]*$/.test(schema)) {
  for (const p of unsafe) console.error(`refusing: ${p}`);
  if (unsafe.length === 0) console.error('refusing: the proof runs on a stonehash_test_remit… schema only');
  process.exit(1);
}
const seedFile = path.resolve(opt('--seed', path.join(HERE, '../parity/seed.json')));
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')).remit;
if (!seed?.orgs?.rail) { console.error(`refusing: ${seedFile} holds no rail seed`); process.exit(1); }
const logs = path.resolve(opt('--logs', fs.mkdtempSync(path.join(os.tmpdir(), 'stand-in-proof-'))));
fs.mkdirSync(logs, { recursive: true });
const only = opt('--only');
const slow = args.includes('--slow');
const workers = args.includes('--workers');
if (workers !== (Number(env.WORKER_TICK_MS ?? '2000') > 0)) {
  console.error(workers ? 'refusing: --workers needs an env file with the workers on (WORKER_TICK_MS above 0)' : 'refusing: the scenario table is for a core without workers (WORKER_TICK_MS=0); with them on, use --workers');
  process.exit(1);
}
const CORE = `http://127.0.0.1:${env.PORT}`;
const PARTNER = env.REMIT_PARTNERS_BASE.replace(/\/+$/, '');
const partnerPort = Number(new URL(PARTNER).port);
const chainPort = Number(new URL(env.REMIT_CHAIN_RPC).port);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ── the three processes ──────────────────────────────────────────────────────
const taken = (port) => new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
for (const port of [Number(env.PORT), partnerPort, chainPort]) {
  if (await taken(port)) { console.error(`port ${port} is taken — another run is in progress, or a process was left behind`); process.exit(2); }
}
const children = [];
function start(name, file, argv) {
  const out = fs.openSync(path.join(logs, `${name}.log`), 'w');
  const child = spawn(process.execPath, [path.join(HERE, file), ...argv], { stdio: ['ignore', out, out], cwd: path.resolve(HERE, '../../..') });
  children.push({ name, child });
  return child;
}
async function stopAll() {
  for (const { child } of [...children].reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  const until = Date.now() + 8000;
  while (children.some(({ child }) => child.exitCode === null && child.signalCode === null) && Date.now() < until) await sleep(100);
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await sleep(150);
}
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { if (stopping) return; stopping = true; await stopAll(); process.exit(130); });

const results = [];
let failures = 0;
try {
  const up = async (what, ready) => {
    for (let i = 0; i < 150 && !(await ready().catch(() => false)); i++) {
      const dead = children.find(({ child }) => child.exitCode !== null);
      if (dead) throw new Error(`${dead.name} ended at once — see ${path.join(logs, `${dead.name}.log`)}`);
      await sleep(200);
    }
    if (!(await ready().catch(() => false))) throw new Error(`${what} did not come up — see ${logs}`);
  };
  start('chain', 'stand-in-eth-rpc.mjs', ['--port', String(chainPort)]);
  start('partner', 'stand-in-partner.mjs', ['--listen', `${partnerPort}=${CORE}`, '--seed', seedFile]);
  await up('the stand-ins', async () => (await fetch(`${PARTNER}/healthz`)).ok && (await fetch(`http://127.0.0.1:${chainPort}/log/summary`)).ok);
  if (workers) {
    // Before the core is up and its worker starts delivering: the receiver of the read organisation answers 500 twice, then 200.
    await fetch(`${PARTNER}/control/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: seed.orgs.read.webhook.name, answers: [{ status: 500 }, { status: 500 }] }) });
  }
  start('core', 'run-reference-core.mjs', [path.resolve(envFile)]);
  await up('the reference core', async () => (await fetch(`${CORE}/healthz`)).ok);

  // ── the bank, the partner's controls ───────────────────────────────────────
  const rail = seed.orgs.rail;
  const bankKey = createPrivateKey(rail.bank.pem);
  const bank = new RemitClient({ core: CORE, apiKey: rail.key, institutionId: rail.bank.id, institutionName: rail.bank.name, key: bankKey });
  const ctl = async (method, target, body) => {
    const res = await fetch(`${PARTNER}${target}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return res.json();
  };
  {
    // Is the seed file this schema's? Its key has to open the ledger, and the registry has to hold the stand-in's keys.
    const opens = await fetch(`${CORE}/v1/settlements?limit=1`, { headers: { authorization: `Bearer ${rail.key}` } });
    const meta = await (await fetch(`${CORE}/v1/remit/meta`)).json();
    const partnerKeys = (await ctl('GET', '/control/status')).institutions;
    const registered = Object.values(seed.partner.institutions).filter((i) => i.registered).every((i) => meta.institutions.some((m) => m.id === i.id && m.signing_spki === i.spki));
    if (opens.status !== 200 || !registered || !partnerKeys?.bfi) throw new Error(`${path.basename(seedFile)} does not belong to the schema of ${path.basename(envFile)} (the seeded key opens the ledger: ${opens.status === 200}; the registry holds the seed's partner keys: ${registered}) — seed that schema, and name its seed file with --seed`);
  }
  const run = Date.now().toString(36).slice(-5).toUpperCase();
  let serial = 0;
  const newId = (word) => `PAY-PRF-${run}-${String(++serial).padStart(2, '0')}-${word}`.slice(0, 60);
  const view = (id) => bank.status(id);
  const types = (v) => v.events.map((e) => e.type);
  const lastOf = (v, type) => [...v.events].reverse().find((e) => e.type === type);
  /** Polls the settlement until `ok(view)` — and until the partner has no callbacks under way. */
  async function until(id, ok, what, timeout = 12_000) {
    const end = Date.now() + timeout;
    let v;
    for (;;) {
      v = await view(id);
      if (ok(v) && (await ctl('GET', `/control/idle?payment_id=${encodeURIComponent(id)}&timeout=10`)).idle) return v;
      if (Date.now() > end) throw new Error(`${id} did not come to ${what} in ${timeout} ms: it is ${v.state} after ${types(v).slice(3).join(', ')}`);
      await sleep(60);
    }
  }
  const rests = (state, lastType) => (v) => v.state === state && (lastType === undefined || types(v).at(-1) === lastType);
  /** A payment of the seeded bank: its plan is given to the partner first, then it is quoted, signed and submitted. */
  async function submit(word, { amount = '1200.00', mode = 'A', plan, creditor, bfi } = {}) {
    const id = newId(word);
    if (plan) await ctl('POST', '/control/plan', { payment_id: id, ...plan });
    const quote = await bank.quote(amount);
    const parties = { debtor: seed.parties.debtor, creditor: { ...seed.parties.creditor, ...(creditor ?? {}) } };
    const opts = { paymentId: id, invoiceRef: `INV-${id}`, beneficiaryInstitution: seed.partner.institutions[bfi ?? 'bfi'].id, ...(mode === 'B' ? { travelRule: 'B' } : {}) };
    const built = mode === 'B' ? await bank.buildInstructionAsync(quote, parties, opts) : bank.buildInstruction(quote, parties, opts);
    const accepted = await bank.submit(built.body);
    if (accepted.state !== 'BANK_AUTHORIZED') throw new Error(`${id}: accepted as ${accepted.state}`);
    return id;
  }
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { if (e instanceof RemitApiError) return { status: e.status, code: e.code, message: e.message }; throw e; } };
  const callback = (id, spec) => ctl('POST', '/control/callback', { payment_id: id, ...(typeof spec === 'string' ? { type: spec } : spec) });
  const arrived = async (id, step, n = 1) => { const r = await ctl('GET', `/control/wait?payment_id=${encodeURIComponent(id)}&step=${step}&n=${n}&timeout=8000`); if (!r.arrived) throw new Error(`${id}: the ${step} call never arrived at the partner`); return r.entry; };
  const partnerSaw = async (id) => (await ctl('GET', `/log?payment_id=${encodeURIComponent(id)}`)).entries.map((e) => `${e.dir === 'out' ? '→' : ''}${e.dir === 'out' ? e.type : e.step}${e.answer?.status ? `:${e.answer.status}` : e.answer?.cut ? ':cut' : ''}`);
  const NORMAL = ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'PAYOUT_ACCEPTED', 'SETTLEMENT_INSTRUCTED', 'USDC_TRANSFER_CONFIRMED', 'USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED'];
  const OPENING = ['REQUEST_ACCEPTED', 'BANK_EVIDENCE_SUBMITTED', 'BANK_AUTHORIZATION_VERIFIED'];
  const exceptionOf = (v) => JSON.stringify(lastOf(v, 'EXCEPTION')?.payload ?? null);

  // ── the scenarios ──────────────────────────────────────────────────────────
  // Each returns { id, view, checks: [[what, held?]…], note? }; `expect` is the final state and the events after the three opening ones.
  const scenarios = [];
  const scenario = (name, expect, fn, { slow: isSlow = false } = {}) => scenarios.push({ name, expect, fn, slow: isSlow });
  const simple = (word, opts, state, lastType, timeout) => async () => { const id = await submit(word, opts); return { id, view: await until(id, rests(state, lastType), state, timeout) }; };
  const fails = (word, plan, at, sentence, timeout) => async () => {
    const id = await submit(word, { plan });
    const v = await until(id, rests('EXCEPTION', 'EXCEPTION'), 'EXCEPTION', timeout);
    const got = lastOf(v, 'EXCEPTION').payload;
    return { id, view: v, checks: [[`at_state ${at}`, got.at_state === at], [`error: ${typeof sentence === 'string' ? sentence : sentence.source}`, typeof sentence === 'string' ? got.error === sentence : sentence.test(got.error)]], note: got.error };
  };
  const refused = (path2, status, message) => `${path2} → HTTP ${status}: ${message}`;
  const unreachable = (path2) => `${path2}: partner simulator not reachable at ${PARTNER} — is demo-partners running? (fetch failed)`;

  scenario('normal flow, mode A', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('NORMAL-A');
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed with the evidence committed');
    const ev = await bank.evidence(id);
    const report = await verifyEvidencePackage(ev);
    const recon = lastOf(v, 'SETTLEMENT_RECONCILED').payload;
    const meta = await (await fetch(`${CORE}/v1/remit/meta`)).json();
    const signed = v.events.filter((e) => e.sig && e.issuer === 'STONEHASH' && e.type !== 'SETTLEMENT_INSTRUCTED').every((e) => verifyEvent(e.payload, e.sig, meta.platform_signer.spki));
    return { id, view: v, checks: [['the six axes: VALID VALID MATCH COMPLETE REVIEW_REQUIRED DEMO_ONLY', JSON.stringify(Object.values(recon.axes)) === JSON.stringify(['VALID', 'VALID', 'MATCH', 'COMPLETE', 'REVIEW_REQUIRED', 'DEMO_ONLY']) && recon.pass === true],
      [`the SDK's re-verification holds in everything but the anchor, which is still pending (failed: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 'nothing'})`,
        report.checks.length >= 4 && report.checks.every((c) => c.ok === (c.name !== 'anchor'))], ['evidence level L3, a bank reference', v.evidence_level === 'L3' && /^FAST-\d{8}-\d{4}$/.test(lastOf(v, 'PAYOUT_COMPLETED').payload.bank_reference)],
      ['the platform\'s event signatures verify with the key of /v1/remit/meta', signed], ['the partner was sent travel-rule, payout-approval, transfer, settlement-notice and sent three callbacks',
        JSON.stringify(await partnerSaw(id)) === JSON.stringify(['travel-rule:200', 'payout-approval:200', 'transfer:200', 'settlement-notice:202', '→USDC_RECEIVED:200', '→PAYOUT_SUBMITTED:200', '→PAYOUT_COMPLETED:200'])]] };
  });
  scenario('normal flow, mode B (the bank\'s ciphertext)', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('NORMAL-B', { mode: 'B' });
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['TRAVEL_RULE_SENT says mode B', lastOf(v, 'TRAVEL_RULE_SENT').payload.mode === 'B']] };
  });
  scenario('second beneficiary institution (bfi2)', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('BFI2', { bfi: 'bfi2' });
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['the acknowledgement is signed by SG-BFI-002', lastOf(v, 'TRAVEL_RULE_RECEIVED').sig.key_id === 'SG-BFI-002']] };
  });
  scenario('trade of USD 20,000 or more: RFI, answered, accepted', ['BENEFICIARY_CREDIT_CONFIRMED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', ...NORMAL.slice(1)]], async () => {
    const id = await submit('RFI-OK', { amount: '25000.00' });
    const open = await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const rfi = lastOf(open, 'TRAVEL_RULE_RFI').payload;
    const answered = await bank.answerRfi(id, seed.rfi_answers);
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [[`rfi id RFI-<payment id>, two questions`, rfi.rfi_id === `RFI-${id}` && rfi.questions.length === 2], ['the answer is taken: 200 TRAVEL_RULE_PENDING', answered.state === 'TRAVEL_RULE_PENDING']] };
  });
  scenario('RFI, every answer empty: rejected', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_REJECTED']], async () => {
    const id = await submit('RFI-EMPTY', { amount: '25000.00' });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const answered = await bank.answerRfi(id, { purpose: '  ', shipping_reference: '' });
    const v = await until(id, rests('CANCELLED'), 'CANCELLED');
    return { id, view: v, checks: [['200 CANCELLED', answered.state === 'CANCELLED'], ['reason "RFI answers were empty"', lastOf(v, 'TRAVEL_RULE_REJECTED').payload.reason === 'RFI answers were empty']] };
  });
  scenario('RFI, the partner answers 409 to the answer, then accepts it', ['BENEFICIARY_CREDIT_CONFIRMED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', ...NORMAL.slice(1)]], async () => {
    const id = await submit('RFI-409', { amount: '25000.00', plan: { steps: { 'travel-rule-response': [{ do: 'refuse', status: 409, message: 'the compliance desk is closed' }] } } });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const first = await refusal(() => bank.answerRfi(id, seed.rfi_answers));
    const still = await view(id);
    await bank.answerRfi(id, seed.rfi_answers);
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['first answer: 502 partner_error, the sentence of the partner', first?.status === 502 && first.code === 'partner_error' && first.message === refused('/bfi/travel-rule-response', 409, 'the compliance desk is closed')],
      ['the RFI stayed open, nothing written', still.state === 'TRAVEL_RULE_PENDING' && types(still).at(-1) === 'TRAVEL_RULE_RFI']] };
  });
  scenario('RFI answer: an acknowledgement by an unregistered key', ['TRAVEL_RULE_PENDING', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI']], async () => {
    const id = await submit('RFI-STRANGER', { amount: '25000.00', plan: { steps: { 'travel-rule-response': { do: 'ack', signedBy: 'stranger' } } } });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const r = await refusal(() => bank.answerRfi(id, seed.rfi_answers));
    return { id, view: await view(id), checks: [['400 unknown_signer to the bank; the RFI stays open', r?.status === 400 && r.code === 'unknown_signer' && r.message === 'signature names unregistered key SG-BFI-UNREGISTERED']] };
  });
  scenario('RFI answer: status RFI with a signed acknowledgement (taken as acceptance)', ['TRAVEL_RULE_PENDING', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED']], async () => {
    const id = await submit('RFI-STATUS', { amount: '25000.00', plan: { steps: { 'travel-rule-response': { do: 'ack', top: { status: 'RFI' } }, 'payout-approval': { do: 'hold' } } } });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const r = await bank.answerRfi(id, seed.rfi_answers);
    await arrived(id, 'payout-approval');
    return { id, view: await view(id), checks: [['200 TRAVEL_RULE_PENDING', r.state === 'TRAVEL_RULE_PENDING']], note: 'the approval request is held at the partner (left so)' };
  });
  scenario('RFI as a bare reason, the partner remembers it: answered, accepted', ['BENEFICIARY_CREDIT_CONFIRMED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', ...NORMAL.slice(1)]], async () => {
    const id = await submit('RFI-BARE', { plan: { steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment', remember: true } } } });
    const open = await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const rfi = lastOf(open, 'TRAVEL_RULE_RFI').payload;
    await bank.answerRfi(id, seed.rfi_answers);
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['the reference makes the id and takes the reason as the question', rfi.rfi_id === `RFI-${id}` && JSON.stringify(rfi.questions) === JSON.stringify(['please state the purpose of the payment'])]] };
  });
  scenario('RFI as a bare reason, nothing remembered (the simulator\'s way): the answer cannot verify there', ['TRAVEL_RULE_PENDING', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI']], async () => {
    const id = await submit('RFI-BARE-LOST', { plan: { steps: { 'travel-rule': { do: 'rfi-bare' } } } });
    const open = await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const r = await refusal(() => bank.answerRfi(id, seed.rfi_answers));
    return { id, view: await view(id), checks: [['the question is the reference\'s own default', JSON.stringify(lastOf(open, 'TRAVEL_RULE_RFI').payload.questions) === JSON.stringify(['additional information requested'])],
      ['502 partner_error: the sender check fails at the partner', r?.status === 502 && r.message === refused('/bfi/travel-rule-response', 400, 'sender signature does not verify against the platform key')]] };
  });
  scenario('beneficiary name contains SANCTIONED: rejected', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_REJECTED']], async () => {
    const id = await submit('SANCTIONED', { creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } });
    const v = await until(id, rests('CANCELLED', 'TRAVEL_RULE_REJECTED'), 'CANCELLED');
    return { id, view: v, checks: [['the partner\'s reason', lastOf(v, 'TRAVEL_RULE_REJECTED').payload.reason === 'beneficiary failed sanctions screening (demo list)'], ['the event is unsigned', lastOf(v, 'TRAVEL_RULE_REJECTED').sig === null]] };
  });
  scenario('travel rule rejected, no reason given', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_REJECTED']], async () => {
    const id = await submit('REJECT-BARE', { plan: { steps: { 'travel-rule': { do: 'reject' } } } });
    const v = await until(id, rests('CANCELLED', 'TRAVEL_RULE_REJECTED'), 'CANCELLED');
    return { id, view: v, checks: [['the event\'s reason is "rejected"', lastOf(v, 'TRAVEL_RULE_REJECTED').payload.reason === 'rejected']] };
  });
  scenario('trade amount ends in .13: payout fails, USDC returned', ['RETURNED', [...NORMAL.slice(0, 7), 'PAYOUT_FAILED', 'USDC_RETURNED']], simple('FAIL-13', { amount: '1000.13' }, 'RETURNED', 'USDC_RETURNED'));
  scenario('trade amount ends in .01: completion at L1, held', ['PAYOUT_IN_PROGRESS', [...NORMAL.slice(0, 8), 'EVIDENCE_INSUFFICIENT']], async () => {
    const id = await submit('L1', { amount: '1000.01' });
    const v = await until(id, rests('PAYOUT_IN_PROGRESS', 'EVIDENCE_INSUFFICIENT'), 'the L1 hold');
    const receipt = lastOf(v, 'PAYOUT_COMPLETED').payload;
    return { id, view: v, checks: [['evidence level L1, an unsigned receipt, no bank reference', v.evidence_level === 'L1' && receipt.payout_receipt_element.signature.status === 'ABSENT' && receipt.bank_reference === undefined]] };
  });
  scenario('trade amount ends in .02: completion at L2 (no bank reference)', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('L2', { amount: '1000.02' });
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['evidence level L2, no bank reference', v.evidence_level === 'L2' && lastOf(v, 'PAYOUT_COMPLETED').payload.bank_reference === undefined]] };
  });
  scenario('completion with no level stated (read as L2)', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('NO-LEVEL', { plan: { callbacks: { level: 'none' } } });
    const v = await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed');
    return { id, view: v, checks: [['evidence level L2 in the settlement, none in the callback', v.evidence_level === 'L2' && lastOf(v, 'PAYOUT_COMPLETED').payload.evidence_level === undefined]] };
  });
  scenario('the receipt states another amount: reconciliation fails', ['EXCEPTION', [...NORMAL.slice(0, 9)]], async () => {
    const id = await submit('MISMATCH', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { with: { amount: '9999.99' } } }] } } });
    const v = await until(id, rests('EXCEPTION', 'SETTLEMENT_RECONCILED'), 'EXCEPTION');
    const recon = lastOf(v, 'SETTLEMENT_RECONCILED').payload;
    return { id, view: v, checks: [['pass false, matching MISMATCH, no EXCEPTION event', recon.pass === false && recon.axes.matching === 'MISMATCH' && !types(v).includes('EXCEPTION')]] };
  });
  scenario('L1, then a signed completion (the reference reconciles the first receipt)', ['EXCEPTION', [...NORMAL.slice(0, 8), 'EVIDENCE_INSUFFICIENT', 'PAYOUT_COMPLETED', 'SETTLEMENT_RECONCILED']], async () => {
    const id = await submit('L1-THEN-L3', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'PAYOUT_COMPLETED', level: 'L3' }] } } });
    const v = await until(id, rests('EXCEPTION', 'SETTLEMENT_RECONCILED'), 'EXCEPTION');
    return { id, view: v, checks: [['issuer UNKNOWN_ISSUER', lastOf(v, 'SETTLEMENT_RECONCILED').payload.axes.issuer === 'UNKNOWN_ISSUER']], note: 'design 13: the Java service reconciles the notice that asked for it and confirms' };
  });
  scenario('USDC returned with no failure reported', ['RETURNED', [...NORMAL.slice(0, 6), 'USDC_RETURNED']], async () => {
    const id = await submit('RETURN-BARE', { plan: { callbacks: 'manual' } });
    await until(id, rests('ONCHAIN_SETTLED', 'USDC_TRANSFER_CONFIRMED'), 'ONCHAIN_SETTLED');
    await arrived(id, 'settlement-notice');
    const a = await callback(id, 'USDC_RECEIVED'); const b = await callback(id, 'USDC_RETURNED');
    return { id, view: await until(id, rests('RETURNED'), 'RETURNED'), checks: [['both callbacks 200 { accepted: true }', a.answer.status === 200 && b.answer.status === 200 && b.answer.body.accepted === true]] };
  });

  // What each partner call can be answered with.
  scenario('travel rule: 422 with a message', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-422', { steps: { 'travel-rule': { do: 'refuse', status: 422, message: 'not today' } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/travel-rule', 422, 'not today')));
  scenario('travel rule: 400 with only `error`', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-400-ERR', { steps: { 'travel-rule': { do: 'refuse', status: 400, body: { error: 'bad_request' } } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/travel-rule', 400, 'bad_request')));
  scenario('travel rule: 404 with an empty body', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-404-EMPTY', { steps: { 'travel-rule': { do: 'refuse', status: 404, raw: '' } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/travel-rule', 404, 'partner error')));
  scenario('travel rule: 500', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-500', { steps: { 'travel-rule': { do: 'fail', status: 500, message: 'boom' } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/travel-rule', 500, 'boom')));
  scenario('travel rule: the connection is dropped', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-DROP', { steps: { 'travel-rule': 'drop' } }, 'TRAVEL_RULE_PENDING', unreachable('/bfi/travel-rule')));
  scenario('travel rule: a page of HTML under 200', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-HTML', { steps: { 'travel-rule': 'html' } }, 'TRAVEL_RULE_PENDING', 'unexpected travel-rule response: undefined'));
  scenario('travel rule: an unexpected status', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-MAYBE', { steps: { 'travel-rule': { do: 'ack', top: { status: 'MAYBE' } } } }, 'TRAVEL_RULE_PENDING', 'unexpected travel-rule response: MAYBE'));
  scenario('travel rule: ACK without an acknowledgement', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-NO-ACK', { steps: { 'travel-rule': { do: 'ack', omit: ['ack'] } } }, 'TRAVEL_RULE_PENDING', 'unexpected travel-rule response: ACK'));
  scenario('travel rule: acknowledged by an unregistered key', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-STRANGER', { steps: { 'travel-rule': { signedBy: 'stranger' } } }, 'TRAVEL_RULE_PENDING', 'signature names unregistered key SG-BFI-UNREGISTERED'));
  scenario('travel rule: acknowledged by an institution of another role', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-ROLE', { steps: { 'travel-rule': { signedBy: 'wallet' } } }, 'TRAVEL_RULE_PENDING', 'SETTLE-ENTITY-001 holds role SETTLEMENT_ENTITY, which may not assert BENEFICIARY_FI facts'));
  scenario('travel rule: an acknowledgement whose signature is broken', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-BROKEN', { steps: { 'travel-rule': { breakSignature: true } } }, 'TRAVEL_RULE_PENDING', 'signature by SG-BFI-001 does not verify'));
  scenario('approval: 409 (the simulator\'s own refusal)', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-409', { steps: { 'payout-approval': { do: 'refuse', status: 409, message: 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)' } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/payout-approval', 409, 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)')));
  scenario('approval: 503', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-503', { steps: { 'payout-approval': { do: 'fail', status: 503, message: 'maintenance' } } }, 'TRAVEL_RULE_PENDING', refused('/bfi/payout-approval', 503, 'maintenance')));
  scenario('approval: for another amount', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-AMOUNT', { steps: { 'payout-approval': { with: { usdc_amount: '1.00' } } } }, 'TRAVEL_RULE_PENDING', 'payout approval does not restate the payment it approves'));
  scenario('approval: for another payment', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-OTHER', { steps: { 'payout-approval': { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } } }, 'TRAVEL_RULE_PENDING', 'payout approval does not restate the payment it approves'));
  scenario('approval: a page of HTML under 200', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-HTML', { steps: { 'payout-approval': 'html' } }, 'TRAVEL_RULE_PENDING', "Cannot read properties of undefined (reading 'payload')"));
  scenario('approval: signed by the settlement entity', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'EXCEPTION']], fails('AP-ROLE', { steps: { 'payout-approval': { signedBy: 'wallet' } } }, 'TRAVEL_RULE_PENDING', 'SETTLE-ENTITY-001 holds role SETTLEMENT_ENTITY, which may not assert BENEFICIARY_FI facts'));
  const INSTRUCTED = ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'PAYOUT_ACCEPTED', 'SETTLEMENT_INSTRUCTED', 'EXCEPTION'];
  scenario('transfer: 403 (the wallet refuses)', ['EXCEPTION', INSTRUCTED], fails('TX-403', { steps: { transfer: { do: 'refuse', status: 403, message: 'per-payment cap exceeded (sandbox: 50,000 mUSDC)' } } }, 'PAYOUT_PRE_APPROVED', refused('/wallet/transfer', 403, 'per-payment cap exceeded (sandbox: 50,000 mUSDC)')));
  scenario('transfer: above 50,000.00 (the simulator\'s own cap)', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'PAYOUT_ACCEPTED', 'SETTLEMENT_INSTRUCTED', 'EXCEPTION']], async () => {
    const id = await submit('TX-CAP', { amount: '60000.00' });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    await bank.answerRfi(id, seed.rfi_answers);
    const v = await until(id, rests('EXCEPTION', 'EXCEPTION'), 'EXCEPTION');
    return { id, view: v, checks: [['the wallet\'s sentence', lastOf(v, 'EXCEPTION').payload.error === refused('/wallet/transfer', 403, 'per-payment cap exceeded (sandbox: 50,000 mUSDC)')]] };
  });
  scenario('transfer: the wallet moves the funds and answers 500', ['EXCEPTION', INSTRUCTED], async () => {
    const r = await fails('TX-500-AFTER', { steps: { transfer: { do: 'fail-after', status: 500 } } }, 'PAYOUT_PRE_APPROVED', refused('/wallet/transfer', 500, 'the stand-in did the work and failed on purpose'))();
    const rec = (await ctl('GET', `/control/ledger?payment_id=${encodeURIComponent(r.id)}`)).record;
    r.checks.push(['the partner holds the funds as moved (FUNDS_IN_FLIGHT) and knows the transaction', rec.state === 'FUNDS_IN_FLIGHT' && /^0x10/.test(rec.tx_hash)], ['chain_tx of the settlement is empty', r.view.chain_tx === null]);
    return r;
  });
  scenario('transfer: the connection is dropped after the work', ['EXCEPTION', INSTRUCTED], fails('TX-DROP-AFTER', { steps: { transfer: 'drop-after' } }, 'PAYOUT_PRE_APPROVED', unreachable('/wallet/transfer')));
  scenario('transfer: the result names another payment', ['EXCEPTION', INSTRUCTED], fails('TX-OTHER', { steps: { transfer: { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } } }, 'PAYOUT_PRE_APPROVED', 'wallet result names a different payment'));
  scenario('transfer: the result is signed by the beneficiary institution', ['EXCEPTION', INSTRUCTED], fails('TX-ROLE', { steps: { transfer: { signedBy: 'bfi' } } }, 'PAYOUT_PRE_APPROVED', 'SG-BFI-001 holds role BENEFICIARY_FI, which may not assert SETTLEMENT_ENTITY facts'));
  scenario('transfer: a page of HTML under 200', ['EXCEPTION', INSTRUCTED], fails('TX-HTML', { steps: { transfer: 'html' } }, 'PAYOUT_PRE_APPROVED', "Cannot read properties of undefined (reading 'payload')"));
  scenario('settlement notice: 404', ['EXCEPTION', [...NORMAL.slice(0, 5), 'EXCEPTION']], fails('SN-404', { steps: { 'settlement-notice': { do: 'refuse', status: 404, message: 'unknown payment' } } }, 'ONCHAIN_SETTLED', refused('/bfi/settlement-notice', 404, 'unknown payment')));
  scenario('settlement notice: a page of HTML under 200 (taken as answered)', ['ONCHAIN_SETTLED', NORMAL.slice(0, 5)], async () => {
    const id = await submit('SN-HTML', { plan: { steps: { 'settlement-notice': 'html' } } });
    await arrived(id, 'settlement-notice');
    await sleep(400);
    return { id, view: await until(id, rests('ONCHAIN_SETTLED', 'USDC_TRANSFER_CONFIRMED'), 'ONCHAIN_SETTLED'), note: 'finding 1.5: the reference does not read this answer; the partner (which answered a page) sends no callback' };
  });
  scenario('settlement notice: the partner takes it and answers 500; its callbacks come all the same', ['EXCEPTION', [...NORMAL.slice(0, 5), 'EXCEPTION', 'USDC_RECEIVED']], async () => {
    // The callbacks start half a second later: sent at once they meet the reference while it is still writing its EXCEPTION, and
    // its event numbers collide (the reference's known race — not something to expect an outcome of).
    const id = await submit('SN-500-AFTER', { plan: { steps: { 'settlement-notice': { do: 'fail-after', status: 500 } }, callbacks: { delay: 500 } } });
    await until(id, (x) => types(x).includes('EXCEPTION'), 'EXCEPTION');
    await arrived(id, 'settlement-notice');
    const sentOne = await ctl('GET', `/control/wait?payment_id=${encodeURIComponent(id)}&dir=out&answered=1&timeout=8000`);
    await ctl('GET', `/control/idle?payment_id=${encodeURIComponent(id)}&timeout=5000`);
    const after = await view(id);
    const sent = (await partnerSaw(id)).filter((x) => x.startsWith('→'));
    return { id, view: after, checks: [['the first callback is answered 500 invalid_transition, and the partner stops as the simulator does', JSON.stringify(sent) === JSON.stringify(['→USDC_RECEIVED:500']) && sentOne.entry?.answer?.body?.error === 'invalid_transition'
      && sentOne.entry.answer.body.message === `payment ${id} is terminal (EXCEPTION); corrections are new events, not transitions`]],
      note: 'the reference appends the callback\'s event before its transition refuses (design 13: the Java service answers 409 and writes nothing)' };
  });

  // Holding a call, and what a cancel does meanwhile.
  scenario('travel rule held, then released', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('HOLD-TR', { plan: { steps: { 'travel-rule': { do: 'hold' } } } });
    await arrived(id, 'travel-rule');
    const during = await view(id);
    const held = (await ctl('GET', '/control/held')).held.filter((h) => h.payment_id === id);
    await ctl('POST', '/control/release', { payment_id: id });
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed'), checks: [['while held: TRAVEL_RULE_PENDING after TRAVEL_RULE_SENT, one held request', during.state === 'TRAVEL_RULE_PENDING' && types(during).at(-1) === 'TRAVEL_RULE_SENT' && held.length === 1]] };
  });
  scenario('travel rule held; cancelled; then acknowledged', ['CANCELLED', ['TRAVEL_RULE_SENT', 'CANCEL_REQUESTED', 'TRAVEL_RULE_RECEIVED']], async () => {
    const id = await submit('HOLD-TR-CANCEL', { plan: { steps: { 'travel-rule': { do: 'hold' } } } });
    await arrived(id, 'travel-rule');
    const c = await bank.cancel(id, 'changed our mind');
    await arrived(id, 'cancel');
    await ctl('POST', '/control/release', { payment_id: id });
    await sleep(500);
    const v = await until(id, rests('CANCELLED'), 'CANCELLED');
    return { id, view: v, checks: [['cancel: 200 CANCELLED', c.state === 'CANCELLED'], ['no approval was asked for', !(await partnerSaw(id)).some((x) => x.startsWith('payout-approval'))]],
      note: 'the reference appends TRAVEL_RULE_RECEIVED after the cancellation (design T3 forbids it)' };
  });
  scenario('approval request held; cancelled; then looked at: the partner, told of the cancel, refuses it', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'CANCEL_REQUESTED']], async () => {
    const id = await submit('HOLD-AP-CANCEL', { plan: { steps: { 'payout-approval': { do: 'hold' } } } });
    await arrived(id, 'payout-approval');
    const c = await bank.cancel(id, 'changed our mind');
    await ctl('POST', '/control/release', { payment_id: id });
    await ctl('GET', `/control/wait?payment_id=${encodeURIComponent(id)}&step=payout-approval&answered=1&timeout=8000`);
    await sleep(400);
    const v = await until(id, rests('CANCELLED'), 'CANCELLED');
    const saw = await partnerSaw(id);
    return { id, view: v, checks: [['cancel: 200 CANCELLED', c.state === 'CANCELLED'], ['the approval is refused 409, as the simulator refuses a cancelled payment', saw.includes('payout-approval:409')], ['no transfer was asked for, no EXCEPTION written', !saw.some((x) => x.startsWith('transfer')) && !types(v).includes('EXCEPTION')]] };
  });
  scenario('approval given, its answer kept back; cancelled; then the answer arrives', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'CANCEL_REQUESTED', 'PAYOUT_ACCEPTED']], async () => {
    const id = await submit('LATE-AP-CANCEL', { plan: { steps: { 'payout-approval': { do: 'hold-after' } } } });
    await arrived(id, 'payout-approval');
    const c = await bank.cancel(id, 'changed our mind');
    await ctl('POST', '/control/release', { payment_id: id });
    await ctl('GET', `/control/wait?payment_id=${encodeURIComponent(id)}&step=payout-approval&answered=1&timeout=8000`);
    await sleep(400);
    const v = await until(id, rests('CANCELLED', 'PAYOUT_ACCEPTED'), 'CANCELLED with the approval appended');
    return { id, view: v, checks: [['cancel: 200 CANCELLED', c.state === 'CANCELLED'], ['no transfer was asked for', !(await partnerSaw(id)).some((x) => x.startsWith('transfer'))], ['the deposit address was stored all the same', typeof v.deposit_address === 'string']],
      note: 'the reference appends PAYOUT_ACCEPTED and stores the address before its transition refuses (design T7 writes nothing)' };
  });
  scenario('transfer held; cancel refused; released', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await submit('HOLD-TX-CANCEL', { plan: { steps: { transfer: { do: 'hold' } } } });
    await arrived(id, 'transfer');
    const c = await refusal(() => bank.cancel(id, 'too late'));
    await ctl('POST', '/control/release', { payment_id: id });
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed'),
      checks: [['cancel: 409 not_cancellable', c?.status === 409 && c.code === 'not_cancellable' && c.message === 'payment is PAYOUT_PRE_APPROVED; cancellation is only possible before payout pre-approval']] };
  });
  scenario('cancel while an RFI is open; the cancel notice answered 500', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'CANCEL_REQUESTED']], async () => {
    const id = await submit('CANCEL-RFI', { amount: '25000.00', plan: { steps: { cancel: { do: 'fail', status: 500 } } } });
    await until(id, rests('TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'), 'an open RFI');
    const c = await bank.cancel(id, 'the importer withdrew');
    const saw = await partnerSaw(id);
    const v = await view(id);
    return { id, view: v, checks: [['200 CANCELLED although the notice failed', c.state === 'CANCELLED'], ['the partner was sent /bfi/cancel', saw.includes('cancel:500')], ['the event keeps the bank\'s signature', lastOf(v, 'CANCEL_REQUESTED').sig.key_id === rail.bank.id]] };
  });

  // Callbacks by hand.
  scenario('callbacks by hand: twice, out of order, of unknown kinds, by the wrong signers', ['BENEFICIARY_CREDIT_CONFIRMED', [...NORMAL.slice(0, 5), 'USDC_RECEIVED', 'USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'USDC_RECEIVED']], async () => {
    const id = await submit('MANUAL', { plan: { callbacks: 'manual' } });
    await until(id, rests('ONCHAIN_SETTLED', 'USDC_TRANSFER_CONFIRMED'), 'ONCHAIN_SETTLED');
    await arrived(id, 'settlement-notice');
    const quiet = (await partnerSaw(id)).filter((x) => x.startsWith('→')).length === 0;
    const unknownType = await callback(id, { type: 'SOMETHING_ELSE' });
    const stranger = await callback(id, { type: 'USDC_RECEIVED', signedBy: 'stranger' });
    const wrongRole = await callback(id, { type: 'USDC_RECEIVED', signedBy: 'wallet' });
    const broken = await callback(id, { type: 'USDC_RECEIVED', breakSignature: true });
    const nobody = await callback('PAY-NOBODY-HAS-THIS', { type: 'USDC_RECEIVED' });
    const before = await view(id);
    const first = await callback(id, 'USDC_RECEIVED');
    const sameBytes = await callback(id, { type: 'USDC_RECEIVED', again: 'bytes' });
    const byOther = await callback(id, { type: 'PAYOUT_SUBMITTED', signedBy: 'bfi2' });
    const resigned = await callback(id, { type: 'PAYOUT_SUBMITTED', again: 'resign' });
    const completed = await callback(id, { type: 'PAYOUT_COMPLETED' });
    const late = await callback(id, 'USDC_RECEIVED');
    const v = await view(id);
    const said = (r, status, code) => r.answer.status === status && r.answer.body.error === code;
    return { id, view: v, checks: [['nothing is sent until asked', quiet], ['unknown type: 400 unknown_callback_type', said(unknownType, 400, 'unknown_callback_type')], ['an unregistered key: 400 unknown_signer', said(stranger, 400, 'unknown_signer')],
      ['the settlement entity\'s key: 400 role_mismatch', said(wrongRole, 400, 'role_mismatch')], ['a broken signature: 400 invalid_signature', said(broken, 400, 'invalid_signature')], ['an unknown payment: 404 payment_not_found', said(nobody, 404, 'payment_not_found')],
      ['none of those wrote anything', types(before).at(-1) === 'USDC_TRANSFER_CONFIRMED' && before.state === 'ONCHAIN_SETTLED'],
      ['the same bytes again: 200, and a second event (the reference keeps no duplicates apart)', first.answer.status === 200 && sameBytes.answer.status === 200 && JSON.stringify(sameBytes.sent) === JSON.stringify(first.sent)],
      ['the second beneficiary institution\'s signature is taken: 200', byOther.answer.status === 200], ['the same payload signed anew: 200, another signature', resigned.answer.status === 200 && JSON.stringify(resigned.sent.payload) === JSON.stringify(byOther.sent.payload) && resigned.sent.sig.sig !== byOther.sent.sig.sig],
      ['completion: 200', completed.answer.status === 200], ['a late USDC_RECEIVED: 500 invalid_transition, its event appended all the same', said(late, 500, 'invalid_transition') && late.answer.body.message === `cannot move payment ${id} from BENEFICIARY_CREDIT_CONFIRMED to PAYOUT_IN_PROGRESS: states only advance`]],
      note: 'design 13: the Java service answers a repeated callback 200 without writing, and one outside its state 409 wrong_state' };
  });
  scenario('completion before receipt (out of order)', ['BENEFICIARY_CREDIT_CONFIRMED', [...NORMAL.slice(0, 5), 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED']], async () => {
    const id = await submit('ORDER', { plan: { callbacks: { sequence: ['PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED'] } } });
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed') };
  });
  scenario('the wallet\'s chain element states the amount as a number: reconciliation throws', ['PAYOUT_IN_PROGRESS', [...NORMAL.slice(0, 8)]], async () => {
    const id = await submit('RECON-THROWS', { plan: { steps: { transfer: { element: { with: { amount: 1200 } } } } } });
    const v = await until(id, rests('PAYOUT_IN_PROGRESS', 'PAYOUT_COMPLETED'), 'PAYOUT_IN_PROGRESS');
    await ctl('GET', `/control/idle?payment_id=${encodeURIComponent(id)}&timeout=5000`);
    const sent = (await partnerSaw(id)).filter((x) => x.startsWith('→'));
    return { id, view: v, checks: [['the completion callback is answered 500', sent.at(-1) === '→PAYOUT_COMPLETED:500']], note: 'design 13 (finding 1.4): the Java service answers 200 and tries again' };
  });

  // Seeded payments carried on by a listener that never saw them. Each run uses up one of a kind: the first that is still as seeded.
  const seeded = async (prefix, lastType, also = () => true) => {
    for (const [name, s2] of Object.entries(seed.settlements.rail)) {
      if (!name.startsWith(prefix) || !also(s2)) continue;
      const v = await view(s2.id);
      if (v.state === s2.state && types(v).at(-1) === lastType) return s2.id;
    }
    throw new Error(`no seeded settlement "${prefix}…" is left as seeded — seed the schema again`);
  };
  scenario('a seeded open RFI, answered through this listener', ['BENEFICIARY_CREDIT_CONFIRMED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', ...NORMAL.slice(1)]], async () => {
    const id = await seeded('rfi-0', 'TRAVEL_RULE_RFI', (x) => x.mode === 'A');
    await bank.answerRfi(id, seed.rfi_answers);
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed'), note: 'the partner knew the payment from the seed file' };
  });
  scenario('a seeded settlement on chain, its callbacks sent by this listener', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await seeded('onchain-', 'USDC_TRANSFER_CONFIRMED', (x) => x.mode === 'A');
    for (const type of ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED']) { const r = await callback(id, type); if (r.answer.status !== 200) throw new Error(`${type}: ${r.answer.status} ${JSON.stringify(r.answer.body)}`); }
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed') };
  });
  scenario('a seeded settlement in mode B on chain, completed at L2 by this listener', ['BENEFICIARY_CREDIT_CONFIRMED', NORMAL], async () => {
    const id = await seeded('onchain-', 'USDC_TRANSFER_CONFIRMED', (x) => x.mode === 'B');
    for (const spec of ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L2' }]) { const r = await callback(id, spec); if (r.answer.status !== 200) throw new Error(`${JSON.stringify(spec)}: ${r.answer.status} ${JSON.stringify(r.answer.body)}`); }
    return { id, view: await until(id, rests('BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'), 'credit confirmed') };
  });
  scenario('a seeded open RFI, cancelled', ['CANCELLED', ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RFI', 'CANCEL_REQUESTED']], async () => {
    const id = await seeded('cancellable-rfi-', 'TRAVEL_RULE_RFI');
    await bank.cancel(id, 'cancelled by the proof run');
    const rec = (await ctl('GET', `/control/ledger?payment_id=${encodeURIComponent(id)}`)).record;
    return { id, view: await view(id), checks: [['the partner dropped its record (CANCELLED)', rec?.state === 'CANCELLED']] };
  });

  // The reads beside the flows.
  scenario('the chain route, for seeded settlements of each kind', null, async () => {
    const readKey = seed.orgs.read.key;
    const ask = async (id) => (await fetch(`${CORE}/v1/settlements/${id}/chain`, { headers: { authorization: `Bearer ${readKey}` } })).json();
    const got = {};
    for (const kind of ['confirmed', 'failed', 'pool', 'noReceipt', 'unknown', 'confirmed/tx/error', 'confirmed/head/empty', 'not a hash']) got[kind] = await ask(seed.chain[kind]);
    const states = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.state]));
    return { id: '(seeded)', view: null, checks: [['confirmed / failed / pending / pending / not_found / unreachable / confirmed / not_found', JSON.stringify(Object.values(states)) === JSON.stringify(['confirmed', 'failed', 'pending', 'pending', 'not_found', 'unreachable', 'confirmed', 'not_found'])],
      ['a confirmed one carries its transfer and the explorer link', typeof got.confirmed.transfer?.amount === 'string' && got.confirmed.confirmations > 0 && (got.confirmed.explorer_url === null || got.confirmed.explorer_url.includes(got.confirmed.tx_hash))],
      ['the head answered without a result: confirmations null', got['confirmed/head/empty'].confirmations === null]], note: JSON.stringify(states) };
  });
  scenario('what the partner listener logged, in comparable form', null, async () => {
    const summary = await ctl('GET', '/log/summary');
    const one = Object.values(summary.by_payment).find((list) => list.length >= 7);
    const text = JSON.stringify(one);
    return { id: '(log)', view: null, checks: [['times, signatures and ciphertext are reduced to their kind', text.includes('"<time>"') && text.includes('"<signature>"') && text.includes('"plaintext_sha256"') && !/"sig":"[A-Za-z0-9_-]{86}"/.test(text)],
      ['the travel-rule message was opened and its digest matched', one[0].opened?.digest_matches === true], ['no Idempotency-Key from the reference', one.every((e) => e.dir !== 'in' || e.headers['idempotency-key'] === null)], ['every sender signature verified', one.every((e) => e.dir !== 'in' || e.sender === 'valid')]],
      note: `${summary.requests} entries for ${Object.keys(summary.by_payment).length} payments` };
  });
  // Waiting out the reference's limit (20 s per call).
  scenario('travel rule: no answer for 21 s', ['EXCEPTION', ['TRAVEL_RULE_SENT', 'EXCEPTION']], fails('TR-SLOW', { steps: { 'travel-rule': { do: 'hold', ms: 21_000, then: 'drop' } } }, 'TRAVEL_RULE_PENDING', /^\/bfi\/travel-rule: partner simulator not reachable at .* \(The operation was aborted due to timeout\)$/, 26_000), { slow: true });
  scenario('transfer: no answer for 21 s, then the wallet does the work', ['EXCEPTION', INSTRUCTED], async () => {
    const r = await fails('TX-SLOW', { steps: { transfer: { do: 'hold', ms: 21_000 } } }, 'PAYOUT_PRE_APPROVED', /^\/wallet\/transfer: partner simulator not reachable at .* \(The operation was aborted due to timeout\)$/, 26_000)();
    await sleep(2500);
    const rec = (await ctl('GET', `/control/ledger?payment_id=${encodeURIComponent(r.id)}`)).record;
    const calls = (await partnerSaw(r.id)).filter((x) => x.startsWith('transfer')).length;
    r.checks.push(['the wallet moved the funds after the reference gave up; exactly one transfer call', rec.state === 'FUNDS_IN_FLIGHT' && calls === 1]);
    return r;
  }, { slow: true });

  // With the workers on there is one scenario, and it replaces the table: what the remit worker does with a seeded schema.
  if (workers) {
    scenarios.length = 0;
    scenario('the remit worker on a seeded schema: anchored evidence promoted, webhooks delivered to the stand-in receiver', null, async () => {
      const read = seed.orgs.read;
      const hookName = read.webhook.name;
      const waiting = seed.settlements.read['confirmed-anchor-confirmed'];
      const readView = async (id) => (await fetch(`${CORE}/v1/settlements/${id}`, { headers: { authorization: `Bearer ${read.key}` } })).json();
      let v; let got = [];
      for (let i = 0; i < 100; i++) {
        v = await readView(waiting.id);
        got = (await ctl('GET', `/hooks/${hookName}`)).deliveries;
        // The two refused deliveries come again 2 s later, behind the next batches: wait for both.
        const again = got.slice(0, 2).every((d) => got.filter((x) => x.body?.envelope?.event_id === d.body?.envelope?.event_id).length >= 2);
        if (v.state === 'EVIDENCE_ANCHORED' && got.length >= 22 && again) break;
        await sleep(250);
      }
      const meta = await (await fetch(`${CORE}/v1/remit/meta`)).json();
      const first = got.slice(0, 2);
      const repeats = first.map((d) => got.filter((x) => x.body?.envelope?.event_id === d.body?.envelope?.event_id));
      const sameBytes = repeats.every((list) => list.length >= 2 && list.every((x) => x.raw === list[0].raw));
      const verified = got.length > 0 && got.every((d) => d.body?.envelope && d.body.signature && verifyEvent(d.body.envelope, d.body.signature, meta.platform_signer.spki));
      const sdkTakes = (await bank.verifyWebhook(got[2]?.body)).valid === true;
      const summary = (await ctl('GET', `/hooks/${hookName}?summary=1`)).deliveries[2];
      return { id: waiting.id, view: null, checks: [['the seeded settlement whose anchor record was confirmed is EVIDENCE_ANCHORED, by an EVIDENCE_ANCHORED event', v.state === 'EVIDENCE_ANCHORED' && v.events.at(-1).type === 'EVIDENCE_ANCHORED'],
        [`the receiver got the seeded deliveries (${got.length} so far), each { envelope, signature } verifying with the platform key`, verified], ['the SDK\'s verifyWebhook takes one', sdkTakes],
        ['the first two were answered 500 as scripted, the third 200', got[0]?.answered === 500 && got[1]?.answered === 500 && got[2]?.answered === 200],
        ['the two refused ones were sent again, the same bytes', sameBytes],
        ['a delivery is to the address of this core\'s own stand-in, oldest first', got[0]?.body?.envelope?.payment_id === seed.by_day.read[seed.fixed_days[0]][0]],
        ['the comparable form reduces the event id, the time and the signature', summary?.body?.envelope?.event_id === '<id>' && summary.body.envelope.occurred_at === '<time>' && summary.body.signature.sig === '<signature>']],
        note: `first delivery: ${got[0]?.body?.envelope?.type} #${got[0]?.body?.envelope?.sequence} of ${got[0]?.body?.envelope?.payment_id}` };
    });
  }

  // ── run them ───────────────────────────────────────────────────────────────
  for (const sc of scenarios) {
    if ((only && !sc.name.includes(only)) || (sc.slow && !slow)) continue;
    const r = { scenario: sc.name, ok: true, state: null, events: null, checks: [], note: null, id: null };
    try {
      const out = await sc.fn();
      r.id = out.id; r.note = out.note ?? null;
      const expect = out.expectOverride ?? sc.expect;
      if (out.view) {
        r.state = out.view.state; r.events = types(out.view).slice(3);
        if (JSON.stringify(types(out.view).slice(0, 3)) !== JSON.stringify(OPENING)) r.checks.push(['the three opening events', false]);
        if (expect) { r.checks.push([`final state ${expect[0]}`, out.view.state === expect[0]]); r.checks.push(['the events, in order', JSON.stringify(r.events) === JSON.stringify(expect[1])]); }
      }
      for (const c of out.checks ?? []) r.checks.push(c);
      if (r.checks.some(([, held]) => !held)) { r.ok = false; r.expected = expect ?? undefined; }
    } catch (e) {
      r.ok = false; r.error = String(e.message ?? e);
    }
    if (!r.ok) failures++;
    results.push(r);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.scenario}\n       ${r.state ?? '-'}${r.events ? `  ←  ${r.events.join(', ')}` : ''}`);
    for (const [what, held] of r.checks) if (!held) console.log(`       NOT HELD: ${what}`);
    if (r.error) console.log(`       ${r.error}`);
    if (!r.ok && r.expected) console.log(`       expected: ${r.expected[0]}  ←  ${r.expected[1].join(', ')}`);
    if (r.note) console.log(`       (${r.note})`);
  }
  const status = await ctl('GET', '/control/status');
  console.log(`\n${results.length} scenarios, ${failures} failed; the listener holds ${status.held} request(s) on purpose, ${status.requests} log entries; logs in ${logs}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify({ run, core: CORE, partner: PARTNER, results }, null, 1)}\n`);
} catch (e) {
  failures++;
  console.error(`the proof could not run: ${e.message ?? e}`);
} finally {
  await stopAll();
  const left = [];
  for (const port of [Number(env.PORT), partnerPort, chainPort]) if (await taken(port)) left.push(port);
  console.log(left.length === 0 ? `stopped what was started; ports ${env.PORT}, ${partnerPort}, ${chainPort} are free` : `STILL LISTENING: ${left.join(', ')}`);
  if (left.length > 0) failures++;
}
process.exit(failures === 0 ? 0 : 1);
