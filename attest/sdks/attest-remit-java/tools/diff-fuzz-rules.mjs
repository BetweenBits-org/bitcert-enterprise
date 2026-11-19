/**
 * Differential test of the six-axis rules: the same evidence, policy, keyring
 * and timestamp through the reference (`packages/attest-rules`) and through
 * the Java SDK's `Rules`, and every place the two answers differ.
 *
 * The golden vectors hold `Rules` to the cases somebody thought of. This
 * holds it to the ones nobody did: real settlements — the sandbox settlement
 * and the rules package's scenarios — with a few things in them changed at
 * random into values no producer writes (a number where a name belongs, a
 * list where one text was meant, a member gone, a subtree moved). The changes
 * come from a seeded generator, so a run is repeatable.
 *
 *   ./run-tests.sh                                    (builds the jar and the test classes)
 *   node tools/diff-fuzz-rules.mjs [count] [seed] [java]      3000 cases of seed 1 on `java` by default
 *
 * The Java side answers every case twice: once with its numbers as this SDK's
 * own JSON reader holds them, once with every number held as a double — which
 * is how the platform's reader hands numbers over. Both have to be the
 * reference's answer.
 *
 * An answer is compared as text, written as JavaScript writes JSON. Where the
 * reference fails inside its engine the Java SDK has to refuse
 * (`unreadable_…`); where it refuses in its own words the Java SDK has to
 * refuse in the same words. A timestamp is read by the reference the way
 * `Rules` reads it — the ISO 8601 form and the forms close to it as the
 * engine reads them, any other spelling as no date — as in
 * `make-rules-golden.mjs`. Nothing is written; exits non-zero on a difference.
 */
process.env.TZ = 'UTC';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORRIDOR_SCENARIOS, DEMO_KEYRING, SCENARIOS, evaluate, keyring, validatePolicy, verifyEvidenceSignatures,
} from '../../../packages/attest-rules/src/index.ts';
import { canonicalPolicy, policyDigest } from '../../../packages/attest-rules/src/policy.ts';
import { createPublicKey } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, '..');
const RULES = path.resolve(HERE, '../../../packages/attest-rules');
const [countArg = '3000', seedArg = '1', java = 'java'] = process.argv.slice(2);
const COUNT = Number(countArg);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// xorshift32: the same sequence on every run for a given seed.
let state = (Number(seedArg) >>> 0) || 1;
const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0x100000000; };
const int = (n) => Math.floor(rnd() * n);
const pick = (list) => list[int(list.length)];

const SHAPE = new RegExp(read(path.join(SDK, 'src/test/resources/golden/rules.json')).shape);
const engineParse = Date.parse;
Date.parse = (v) => { const t = String(v); return SHAPE.test(t) ? engineParse(t) : NaN; };

// ── the settlements the cases start from ───────────────────────────────────

const sandbox = read(path.join(SDK, 'src/test/resources/golden/verdict.json')).bases.sandbox;
const jwkOfSpki = (spki) => createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
const sandboxRing = sandbox.registry.map((i) => ({ keyId: i.id, issuer: i.name, trustLevel: 'ATTESTED', publicKeySpki: i.signing_spki }));
const demoRing = [...DEMO_KEYRING.values()].map((k) => clone(k));
const referenceRing = (entries) => keyring(entries.map(({ publicKeySpki, ...rest }) => (publicKeySpki === undefined || 'publicKeyJwk' in rest ? rest : { ...rest, publicKeyJwk: jwkOfSpki(publicKeySpki) })));
const tradeBase = read(path.join(RULES, 'fixtures/a-normal-trade-payment.json'));
const tradePolicy = read(path.join(RULES, 'policies/settlement-match-v1.json'));
const corridorBase = read(path.join(RULES, 'fixtures/corridor-vn-sg-normal.json'));
const corridorPolicy = read(path.join(RULES, 'policies/corridor-vn-sg-v1.json'));
const seeds = [];
for (const s of SCENARIOS) seeds.push({ evidence: clone(s.derive(tradeBase)), policy: tradePolicy, ring: demoRing });
for (const s of CORRIDOR_SCENARIOS) seeds.push({ evidence: clone(s.derive(corridorBase)), policy: corridorPolicy, ring: demoRing });
// Half of the cases start from the sandbox settlement: every control on, every signature verified under an attested key.
for (let n = seeds.length; n > 0; n--) seeds.push({ evidence: sandbox.evidence, policy: sandbox.policy, ring: sandboxRing });

// ── changes ────────────────────────────────────────────────────────────────

const ODD = [null, null, true, false, 0, 1, -1, 7, 1.5, 1e21, 1e-7, 2026, '', ' ', 'x', '0', '7', '2500.00', '2500', ' 2500.00 ', '2,500', 'USD', 'USDC', 'EUR', 'VALID', 'INVALID', 'ABSENT', 'UNKNOWN_KEY',
  'DEMO_VALID', 'DEMO', 'ATTESTED', 'ACCREDITED', 'APPROVED', 'PENDING', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'length', 'chainTransfer', 'payoutReceipts', 'bankInstruction',
  'travelRule', 'exact', 'normalized', 'P2D', 'PT1S', 'P', 'P1M', 'LIVE', 'SYNTHETIC', '2026-11-18', '2026-11-18T03:03:48Z', '2026-11-18 03:03:48', '2026-11-18t03:03:48.5+0700', '0005-11 03:03',
  '2026-11-18T24:00:00', '2026-11-19 03:03:48+24:00', '2027', 'Nov 18, 2026', '2026/11/18', 'soon', [], [null], ['x'], ['USD'], [[]], ['2026-11-18'], [1, 2], ['chainTransfer'], ['ATTESTED'], {},
  { length: 1 }, { length: '2' }, { 0: 'x' }, { status: 'VALID', checked: true, trustLevel: 'ATTESTED' }, { status: 'VALID' }, { status: 'INVALID', checked: true, keyId: 7 },
  { status: 'UNKNOWN_KEY', checked: true }, { ref: 'R', amount: '1.00', currency: 'USD' }, '\ud83d', 'é😀', 'Saigon Import Co Ltd', 'SAIGON IMPORT COMPANY LIMITED',
  // Values the engine can make no text and no number of (an object with a member of its own named toString, alone or in a list) — and the look-alikes it can.
  { toString: 1 }, { toString: null }, { toString: 'x', valueOf: 2 }, [{ toString: 1 }], ['x', { toString: {} }], { valueOf: 1 }, [{ valueOf: [] }], { length: { toString: 1 } }, { status: { toString: 1 }, checked: true }];
const NAMES = ['signature', 'digest', 'digestVerified', 'citedOnly', 'attached', 'settlementId', 'refundReasonCode', 'relatedSettlementId', 'purpose', 'jurisdiction', 'length', 'ref', 'amount',
  'currency', 'iso20022Fields', 'fxQuote', 'approvedAt', 'observedAt', 'paidAt', 'status', 'checked', 'keyId', 'trustLevel', 'value', 'dataMode', 'scenario', 'elements', 'approvalStatus',
  'approvalDigest', 'approvedBeneficiaryAddress', 'toAddress', 'txRef', 'settlementIdMemo', 'invoiceRef', 'buyer', 'seller', 'debtor', 'creditor', 'validUntil', 'quotedAt', 'pair', 'rate', '0', '__proto__',
  'chainTransfer', 'payoutReceipts', 'bankInstruction', 'commercialDocs', 'travelRule', 'bankApproval', 'policyVersion', 'currencies', 'unitOfAccountGroups', 'amountTolerance', 'amountToleranceBps',
  'fxReference', 'settlementWindow', 'fees', 'splitPayments', 'partyIDMatch', 'sourceTrustLevel', 'requiredElements', 'signatureRequiredElements', 'regulatoryFields', 'requireTravelRulePreflight',
  'enforceFxQuoteWindow', 'settlementIdRequiredIn', 'deductible', 'maxBps', 'allowed', 'aggregate'];
/** Every place in a document: the path to each member of each object and each item of each list. */
function places(v, at = [], out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => { out.push([...at, i]); places(x, [...at, i], out); });
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { out.push([...at, k]); places(v[k], [...at, k], out); }
  return out;
}
const get = (doc, at) => at.reduce((v, k) => v?.[k], doc);
function put(doc, at, value) {
  const parent = get(doc, at.slice(0, -1));
  const last = at[at.length - 1];
  // Defined as an own member, whatever its name: an assignment to "__proto__" would be something else.
  if (Array.isArray(parent)) parent[last] = value; else Object.defineProperty(parent, last, { value, writable: true, enumerable: true, configurable: true });
}
/** The members a rule turns on: a change lands on one of them more often than chance would have it. */
const TURNS_ON = new Set(['sourceTrustLevel', 'trustLevel', 'settlementWindow', 'settlementId', 'settlementIdRequiredIn', 'approvedAt', 'observedAt', 'paidAt', 'validUntil', 'quotedAt', 'iso20022Fields',
  'ref', 'payoutReceipts', 'citedOnly', 'keyId', 'status', 'checked', 'amount', 'currency', 'invoiceRef', 'approvalRef', 'txRef', 'settlementIdMemo', 'debtor', 'creditor', 'buyer', 'seller',
  'requiredElements', 'signatureRequiredElements', 'regulatoryFields', 'fxQuote', 'partyIDMatch', 'amountTolerance', 'amountToleranceBps', 'fees', 'splitPayments', 'currencies', 'unitOfAccountGroups',
  'fxReference', 'approvalStatus', 'approvalDigest', 'approvedBeneficiaryAddress', 'toAddress', 'digest', 'digestVerified', 'signature', 'value', 'dataMode', 'jurisdiction', 'purpose']);
function change(doc) {
  const all = places(doc);
  const turning = all.filter((p) => TURNS_ON.has(p[p.length - 1]) || TURNS_ON.has(p[p.length - 2]));
  const at = turning.length && rnd() < 0.5 ? pick(turning) : pick(all);
  const parent = get(doc, at.slice(0, -1));
  const last = at[at.length - 1];
  const value = get(doc, at);
  switch (int(10)) {
    case 0: case 1: case 2: put(doc, at, clone(pick(ODD))); break;
    case 3: if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last]; break;
    case 4: put(doc, at, clone(get(doc, pick(all)) ?? null)); break;                                    // something from elsewhere in the document
    case 5: put(doc, at, rnd() < 0.5 ? [clone(value)] : [clone(value), clone(value)]); break;
    case 6: {                                                                                           // a member more
      const objects = all.filter((p) => { const v = get(doc, p); return v && typeof v === 'object' && !Array.isArray(v); });
      if (objects.length) put(doc, [...pick(objects), pick(NAMES)], clone(pick(ODD)));
      break;
    }
    case 7: {
      const lists = all.filter((p) => Array.isArray(get(doc, p)));
      if (lists.length) { const list = get(doc, pick(lists)); if (rnd() < 0.6) list.push(clone(list.length && rnd() < 0.7 ? pick(list) : pick(ODD))); else list.reverse(); }
      break;
    }
    case 8:
      // Text in another spelling — or the same text where JavaScript would still read it: alone in a list.
      if (typeof value === 'string') put(doc, at, pick([value + 'x', ` ${value} `, value.toUpperCase(), value.toLowerCase(), value.slice(1), value.replace('T', ' '), value.replace('Z', ''), `${value}\n`, [value], [value], [[value]]]));
      else if (typeof value === 'number') put(doc, at, pick([value + 1, -value, value + 0.5, String(value), value * 1e21]));
      else if (typeof value === 'boolean') put(doc, at, pick([!value, String(value), value ? 1 : 0]));
      else put(doc, at, clone(pick(ODD)));
      break;
    default: put(doc, at, null);
  }
}

// ── cases, and what the reference answers ──────────────────────────────────

const OWN = [/^policy: /, /^policy\.amountTolerance: /, /: expected a decimal string, got /, /: not a plain decimal string: /, /^unsupported duration: /, /^duplicate keyId in keyring: /];
const thrown = (e) => {
  const message = String(e?.message ?? e);
  const engine = e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError;
  if (engine === OWN.some((re) => re.test(message))) throw new Error(`a refusal that is neither the reference's own nor its engine's: ${message}`);
  return { threw: { message, engine } };
};
const cases = [];
const wanted = [];
const add = (c, want) => { cases.push(c); wanted.push(want); };
const years = ['2026', '0005', '0049', '0099', '+002026', '-000001', '-000000', '9999'];
const digits = () => String(int(100)).padStart(2, '0');
while (cases.length < COUNT) {
  const seed = pick(seeds);
  const doc = { evidence: clone(seed.evidence), policy: clone(seed.policy) };
  // Mostly the evidence; sometimes the policy; and the whole document now and then.
  const target = rnd() < 0.7 ? doc.evidence : rnd() < 0.85 ? doc.policy : doc;
  for (let n = 1 + int(3); n > 0; n--) change(target === doc ? doc : target);
  if (doc.evidence === undefined || doc.policy === undefined) continue;
  // The signature pass, the verdict on what it leaves, and the verdict on the evidence as it came.
  let checked;
  try { checked = clone(await verifyEvidenceSignatures(doc.evidence, referenceRing(seed.ring))); add({ evidence: doc.evidence, keyring: seed.ring }, { evidence: checked }); }
  catch (e) { add({ evidence: doc.evidence, keyring: seed.ring }, thrown(e)); }
  for (const evidence of checked === undefined ? [doc.evidence] : [checked, doc.evidence]) {
    try { add({ evidence, policy: doc.policy }, { result: clone(evaluate(evidence, doc.policy)) }); } catch (e) { add({ evidence, policy: doc.policy }, thrown(e)); }
  }
  let problem = null;
  try { validatePolicy(doc.policy); } catch (e) { problem = thrown(e).threw; }
  add({ policy: doc.policy }, { problem, canonical: canonicalPolicy(doc.policy), digest: policyDigest(doc.policy) });
  // And a timestamp of the shape `Rules` reads, its parts at random.
  const time = `${pick(years)}${rnd() < 0.8 ? `-${digits()}` : ''}${rnd() < 0.7 ? `-${digits()}` : ''}`.replace(/^(\S+?)-(\d\d)$/, rnd() < 0.9 ? '$1-$2' : '$1')
    + (rnd() < 0.85 ? `${pick(['T', 't', ' '])}${digits()}:${digits()}${rnd() < 0.7 ? `:${digits()}${rnd() < 0.5 ? `.${String(int(1e9)).slice(0, 1 + int(12)).padStart(1 + int(4), '0')}` : ''}` : ''}`
      + pick(['', '', 'Z', 'z', `+${digits()}:${digits()}`, `-${digits()}${digits()}`, `-${digits()}:${digits()}`, `+${digits()}${digits()}`]) : '');
  if (SHAPE.test(time)) { const ms = engineParse(time); add({ time }, { ms: Number.isNaN(ms) ? null : ms }); }
}

// ── what the Java SDK answers ──────────────────────────────────────────────

const classpath = `${path.join(SDK, 'dist/stonehash-attest-remit-0.1.0.jar')}:${path.join(SDK, 'build/test-classes')}`;
const input = `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`;
const count = { verdicts: 0, passes: 0, policies: 0, times: 0, refusedInItsWords: 0, whereItsEngineFails: 0, differences: 0, crashes: 0 };
const shown = [];
for (const held of ['as read', 'as doubles']) {
  const run = spawnSync(java, ['-cp', classpath, 'com.stonehash.attest.remit.PlatformProbe', 'rules', ...(held === 'as doubles' ? ['doubles'] : [])], { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0) { console.error(run.stderr.slice(0, 4000)); process.exit(2); }
  const answers = run.stdout.trim().split('\n');
  if (answers.length !== cases.length) { console.error(`java answered ${answers.length} of ${cases.length} cases`); process.exit(2); }
  for (let i = 0; i < cases.length; i++) {
    const want = wanted[i];
    const got = JSON.parse(answers[i]);
    const counted = held === 'as read';
    let same;
    if (got.crash) { count.crashes++; same = false; }
    else if (want.threw) {
      same = Boolean(got.threw) && (want.threw.engine ? got.threw.code.startsWith('unreadable_')
        : ['invalid_policy', 'invalid_amount', 'invalid_keyring'].includes(got.threw.code) && got.threw.message === want.threw.message);
      if (counted) count[want.threw.engine ? 'whereItsEngineFails' : 'refusedInItsWords']++;
    } else if ('problem' in want) {
      if (counted) count.policies++;
      same = got.canonical === want.canonical && got.digest === want.digest && (want.problem === null ? got.problem === null
        : got.problem !== null && (want.problem.engine ? got.problem.code === 'unreadable_policy' : got.problem.code === 'invalid_policy' && got.problem.message === want.problem.message));
    } else {
      if (counted) count['result' in want ? 'verdicts' : 'evidence' in want ? 'passes' : 'times']++;
      same = JSON.stringify(want) === answers[i];
    }
    if (!same) {
      count.differences++;
      if (shown.length < 8) shown.push({ i, held, case: JSON.stringify(cases[i]).slice(0, 4000), want: JSON.stringify(want), got: answers[i] });
    }
  }
}
console.log(`cases ${cases.length} (seed ${seedArg}, ${java}), each put to the Java SDK twice — numbers as read, and as doubles: ${count.verdicts} verdicts, ${count.passes} signature passes, ${count.policies} policies, ${count.times} timestamps; `
  + `${count.refusedInItsWords} refused in the reference's words, ${count.whereItsEngineFails} where its engine fails`);
console.log(`differences ${count.differences}, crashes ${count.crashes}`);
for (const d of shown) {
  let at = 0;
  while (at < d.want.length && at < d.got.length && d.want[at] === d.got[at]) at++;
  console.log(`#${d.i}, numbers ${d.held}\n  case      ${d.case.slice(0, 1500)}\n  reference …${d.want.slice(Math.max(0, at - 80), at + 300)}\n  java      …${d.got.slice(Math.max(0, at - 80), at + 300)}`);
}
process.exit(count.differences ? 1 : 0);
