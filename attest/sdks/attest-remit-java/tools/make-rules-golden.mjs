/**
 * Writes the vectors the Java SDK's `Rules` — the six-axis engine as the
 * platform's own back end runs it — is held to: what the reference
 * (`packages/attest-rules`, read here and never written) answers, whole.
 *
 *   node sdks/attest-remit-java/tools/make-rules-golden.mjs          write src/test/resources/golden/rules.json
 *   node sdks/attest-remit-java/tools/make-rules-golden.mjs --check  fail when the file on disk differs
 *
 * Nothing here signs anything, so the output is the same on every run. It
 * reads `golden/verdict.json` (written by `make-verdict-golden.mjs`, which is
 * run first): every engine case there is answered here in full, and the
 * cases added here are the ones a bank's re-evaluation refuses to read and a
 * producer has to answer.
 *
 * The sections:
 *
 *   engine      { evidence, policy } → the reference's whole MatchingResult, as
 *               JSON — or `threw`: its message, and whether it is the JavaScript
 *               engine's (`engine: true`: the Java SDK refuses in words of its
 *               own) or the reference's own sentence (the Java SDK's, to the letter)
 *   policies    a policy → what validatePolicy says of it, its canonical text
 *               and its digest
 *   signatures  { evidence, keyring } → the whole evidence after
 *               verifyEvidenceSignatures — or `threw`
 *   instants    text → Date.parse (the machine in UTC)
 *   table       values no text and no number can be made of — an object with a
 *               member of its own named toString, alone and inside lists, and
 *               the look-alikes that are harmless — put at every place a case
 *               of the other sections puts something: for the engine, for the
 *               policy checks and for the signature pass. A cell is the SHA-256
 *               of the reference's whole answer as JSON, or how it refuses.
 *               `--cell <table> <context> <position> <value>` prints one in full.
 *
 * One thing is not the reference's answer as it stands. The reference reads a
 * timestamp with the JavaScript engine's `Date.parse`, which also reads forms
 * the language standard leaves to each engine. `Rules` reads the ISO 8601 form
 * and the forms close to it (`SHAPE` below) exactly as that engine does, and
 * nothing else. So every case is evaluated twice — as the reference stands,
 * and with any other spelling unparseable — and where the two differ the case
 * carries both: `result` is what `Rules` must answer, `reference` what the
 * reference answers today.
 */
process.env.TZ = 'UTC';       // a time without a zone is local time to the engine; the platform's machines run in UTC

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORRIDOR_SCENARIOS, DEMO_KEYRING, SCENARIOS, evaluate, keyring, validatePolicy, verifyEvidenceSignatures,
} from '../../../packages/attest-rules/src/index.ts';
import { canonicalPolicy, policyDigest } from '../../../packages/attest-rules/src/policy.ts';

if (new Date(2026, 0, 1).getTimezoneOffset() !== 0 || new Date(2026, 6, 1).getTimezoneOffset() !== 0) {
  throw new Error('this machine does not run in UTC and TZ=UTC did not take: the instants would be another machine\'s');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(HERE, '../../../packages/attest-rules');
const GOLDEN = path.resolve(HERE, '../src/test/resources/golden');
const OUT = path.join(GOLDEN, 'rules.json');
const check = process.argv.includes('--check');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** One change to a document: put a value at a path, or take the member there away. (As in make-verdict-golden.mjs.) */
function apply(doc, ops) {
  const out = clone(doc);
  for (const op of ops) {
    let at = out;
    for (const key of op.at.slice(0, -1)) at = at[key];
    const last = op.at[op.at.length - 1];
    if (op.unset) {
      if (Array.isArray(at)) at.splice(last, 1); else delete at[last];
    } else {
      at[last] = clone(op.set);
    }
  }
  return out;
}
const set = (at, value) => ({ at, set: value });
const unset = (at) => ({ at, unset: true });
const names = new Set();
const unique = (section, name) => {
  if (names.has(`${section}:${name}`)) throw new Error(`${section}: two cases are named ${name}`);
  names.add(`${section}:${name}`);
};

const verdict = read(path.join(GOLDEN, 'verdict.json'));
const bases = verdict.bases;

// ── What the reference says, and in whose words ────────────────────────────

/** The reference's own refusals. Anything else it throws is the JavaScript engine speaking about the reference's source. */
const OWN = [/^policy: /, /^policy\.amountTolerance: /, /: expected a decimal string, got /, /: not a plain decimal string: /,
  /^unsupported duration: /, /^duplicate keyId in keyring: /];
function thrown(e) {
  const message = String(e?.message ?? e);
  const engine = e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError;
  if (!engine && !OWN.some((re) => re.test(message))) throw new Error(`a refusal nobody expected: ${message}`);
  if (engine && OWN.some((re) => re.test(message))) throw new Error(`an engine error that reads like a refusal: ${message}`);
  return { message, engine };
}

/**
 * The shape of a time `Rules` reads: the ISO 8601 date-time format of the
 * language standard, and the forms close to it that clients send — a `t` or
 * one space for the `T`, a lower-case `z`, a zone without its colon.
 */
const SHAPE = /^(?:[+-]\d{6}|\d{4})(?:-\d{2}(?:-\d{2})?)?(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
const engineParse = Date.parse;
const shapedParse = (v) => { const t = String(v); return SHAPE.test(t) ? engineParse(t) : NaN; };
function withShapedTimes(fn) {
  Date.parse = shapedParse;
  try { return fn(); } finally { Date.parse = engineParse; }
}

// ── engine ─────────────────────────────────────────────────────────────────

const answer = (fn) => { try { return { result: clone(fn()) }; } catch (e) { return { threw: thrown(e) }; } };
const engine = [];
let otherSpellings = 0;
function evaluated(evidence, policy) {
  const reference = answer(() => evaluate(evidence, policy));
  const expected = withShapedTimes(() => answer(() => evaluate(evidence, policy)));
  if (JSON.stringify(reference) === JSON.stringify(expected)) return expected;
  if (!reference.result || !expected.result) throw new Error('a spelling of a time decided whether the reference answers at all');
  otherSpellings++;
  return { ...expected, reference: reference.result };
}
for (const c of verdict.engine) {
  unique('engine', c.name);
  const doc = c.base ? apply(bases[c.base], c.ops) : c;
  engine.push({ name: c.name, from: 'verdict.json', ...evaluated(doc.evidence, doc.policy) });
}
const carried = engine.length;

const SB = bases.sandbox;
const E = SB.evidence.elements;
const ev = (...p) => ['evidence', ...p];
const el = (...p) => ['evidence', 'elements', ...p];
const pol = (...p) => ['policy', ...p];
/** A case of this file: the sandbox settlement with some things changed. */
function sbx(name, ...ops) {
  unique('engine', name);
  const doc = apply(SB, ops);
  engine.push({ name, base: 'sandbox', ops, ...evaluated(doc.evidence, doc.policy) });
}
/** A case of this file that is not a change to the sandbox settlement. */
function given(name, evidence, policy) {
  unique('engine', name);
  engine.push({ name, evidence, policy, ...evaluated(evidence, policy) });
}
const live = set(ev('dataMode'), 'LIVE');
const receipt0 = E.payoutReceipts[0];
const sid = SB.evidence.settlementId;

// Evidence that is not what it should be: the reference reads a member of anything, and finds none.
given('evidence that is text', 'evidence', SB.policy);
given('evidence that is a number', 7, SB.policy);
given('evidence that is true', true, SB.policy);
given('evidence that is a list', [SB.evidence], SB.policy);
given('evidence that is empty', {}, SB.policy);
given('evidence that is null', null, SB.policy);
given('evidence that is null, under a policy the engine refuses', null, { ...SB.policy, settlementWindow: 'P1M' });
sbx('elements that are text', set(ev('elements'), 'elements'));
sbx('elements that are a number', set(ev('elements'), 6));
sbx('elements that are a list', set(ev('elements'), [E.bankInstruction]));
sbx('elements that are false', set(ev('elements'), false));
sbx('a scenario and a data mode that are not text', set(ev('scenario'), { id: 7 }), set(ev('dataMode'), 1.50));
sbx('a scenario and a data mode that are null', set(ev('scenario'), null), set(ev('dataMode'), null));
sbx('no scenario and no data mode', unset(ev('scenario')), unset(ev('dataMode')));

// Elements of another kind than an object.
sbx('a bank instruction that is text', set(el('bankInstruction'), 'instruction'));
sbx('a bank instruction that is a list', set(el('bankInstruction'), [E.bankInstruction]));
sbx('a bank instruction that is zero', set(el('bankInstruction'), 0));
sbx('a bank instruction that is empty text', set(el('bankInstruction'), ''));
sbx('a bank instruction that is false', set(el('bankInstruction'), false));
sbx('a bank instruction that is true', set(el('bankInstruction'), true));
sbx('a chain transfer that is a list', set(el('chainTransfer'), [E.chainTransfer]));
sbx('a chain transfer that is text', set(el('chainTransfer'), 'moved'));
sbx('a chain transfer that is zero', set(el('chainTransfer'), 0));
sbx('a chain transfer that is false, under live data', live, set(el('chainTransfer'), false));
sbx('commercial documents that are text', set(el('commercialDocs'), 'invoice'));
sbx('commercial documents that are a list', set(el('commercialDocs'), [E.commercialDocs, E.commercialDocs]));
sbx('a bank approval that is a list of two', set(el('bankApproval'), [E.bankApproval, { ...E.bankApproval, digestVerified: false }]));
sbx('a bank approval that is a number', set(el('bankApproval'), 3));
sbx('a Travel Rule exchange that is true', set(el('travelRule'), true));
sbx('a Travel Rule exchange that is a number', set(el('travelRule'), 12));
sbx('a Travel Rule exchange that is a list', set(el('travelRule'), [E.travelRule]));
sbx('a Travel Rule exchange that is an empty list', set(el('travelRule'), []));
sbx('an element list holding nothing but null', set(el('bankApproval'), [null]));

// Completeness and integrity — what a finding says of a value it did not expect.
sbx('required elements that are not names', set(pol('requiredElements'), [...SB.policy.requiredElements, 7, null, true, ['travelRule'], { a: 1 }, 1e21, 0.1, 'constructor']),
  set(pol('signatureRequiredElements'), []));
sbx('documents cited: a number, null, a list, an object', set(el('commercialDocs', 'citedOnly'), [5, null, ['a', 'b'], { n: 1 }, true, '']));
sbx('citedOnly as text with a character outside the basic plane', set(el('commercialDocs', 'citedOnly'), 'a😀'));
sbx('citedOnly as empty text', set(el('commercialDocs', 'citedOnly'), ''));
sbx('citedOnly as an object', set(el('commercialDocs', 'citedOnly'), { 0: 'invoice' }));
sbx('citedOnly as true', set(el('commercialDocs', 'citedOnly'), true));
sbx('a digest that does not match and is not stated', set(el('bankInstruction', 'digestVerified'), false), unset(el('bankInstruction', 'digest')));
sbx('a digest that does not match and is null', set(el('bankInstruction', 'digestVerified'), false), set(el('bankInstruction', 'digest'), null));
sbx('a digest that does not match and is a number', set(el('bankInstruction', 'digestVerified'), false), set(el('bankInstruction', 'digest'), 1e21));
sbx('a digest that does not match and is an object', set(el('bankInstruction', 'digestVerified'), false), set(el('bankInstruction', 'digest'), { sha256: 'x', 10: 'a', 9: 'b' }));
sbx('digestVerified as a number', set(el('commercialDocs', 'digestVerified'), 1));
sbx('digestVerified null', set(el('commercialDocs', 'digestVerified'), null));

// Issuer — statuses, key ids and trust levels of every kind.
sbx('a signature that is true', set(el('bankInstruction', 'signature'), true));
sbx('a signature that is a number', set(el('bankInstruction', 'signature'), 1));
sbx('a signature that is a list', set(el('bankInstruction', 'signature'), [{ status: 'VALID', checked: true }]));
sbx('a signature that is empty', set(el('bankInstruction', 'signature'), {}));
sbx('a signature that is zero, where none is required', set(el('bankInstruction', 'signature'), 0), set(pol('signatureRequiredElements'), []));
sbx('an unverified signature whose status is not stated', unset(el('bankInstruction', 'signature', 'checked')), unset(el('bankInstruction', 'signature', 'status')));
sbx('an unverified signature whose status is null', unset(el('bankInstruction', 'signature', 'checked')), set(el('bankInstruction', 'signature', 'status'), null));
sbx('an unverified signature whose status is a number', unset(el('bankInstruction', 'signature', 'checked')), set(el('bankInstruction', 'signature', 'status'), 0.000001));
sbx('an unverified signature whose status is a list', unset(el('bankInstruction', 'signature', 'checked')), set(el('bankInstruction', 'signature', 'status'), ['VALID', null, ['x']]));
sbx('an unverified signature whose status is an object', unset(el('bankInstruction', 'signature', 'checked')), set(el('bankInstruction', 'signature', 'status'), { ok: true }));
sbx('checked as the number one', set(el('bankInstruction', 'signature', 'checked'), 1));
sbx('an unknown key that is not named', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), unset(el('travelRule', 'signature', 'keyId')));
sbx('an unknown key whose id is null', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), set(el('travelRule', 'signature', 'keyId'), null));
sbx('an unknown key whose id is a number', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), set(el('travelRule', 'signature', 'keyId'), 123456789012345680000));
sbx('an unknown key whose id is an object', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), set(el('travelRule', 'signature', 'keyId'), { kid: 'x' }));
sbx('an unknown key whose id is empty', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), set(el('travelRule', 'signature', 'keyId'), ''));
sbx('an invalid signature that names no key', set(el('chainTransfer', 'signature', 'status'), 'INVALID'), unset(el('chainTransfer', 'signature', 'keyId')));
sbx('an invalid signature whose key id is a list', set(el('chainTransfer', 'signature', 'status'), 'INVALID'), set(el('chainTransfer', 'signature', 'keyId'), ['a', 'b']));
for (const [name, level] of [['DEMO', 'DEMO'], ['ACCREDITED', 'ACCREDITED'], ['in lower case', 'attested'], ['empty', ''], ['null', null], ['the number one', 1], ['zero', 0],
  ['true', true], ['a list naming ATTESTED', ['ATTESTED']], ['a list naming DEMO', ['DEMO']], ['a list of two', ['ATTESTED', 'DEMO']], ['an object', { level: 'ATTESTED' }],
  ['a name every object answers to', 'constructor'], ['__proto__', '__proto__'], ['toString', 'toString']]) {
  sbx(`every signature at a trust level that is ${name}`, live,
    ...Object.keys(E).flatMap((k) => (Array.isArray(E[k]) ? E[k].map((_, i) => set(el(k, i, 'signature', 'trustLevel'), level)) : [set(el(k, 'signature', 'trustLevel'), level)])));
}
sbx('live data, a receipt at the level the policy asks, the policy asking for DEMO', live, set(pol('sourceTrustLevel'), 'DEMO'), set(el('payoutReceipts', 0, 'signature', 'trustLevel'), 'DEMO'));
sbx('live data, receipts of which the second is unsigned', live, set(el('payoutReceipts', 1), { ...receipt0, ref: `${receipt0.ref}-2`, signature: null }),
  set(pol('splitPayments'), { allowed: true, aggregate: false }));
sbx('live data, receipts of which the second is null', live, set(el('payoutReceipts', 0, 'signature'), { status: 'INVALID', checked: true }), set(el('payoutReceipts', 1), null));

// The policy read the way JavaScript reads it: a list is the text of its members, a name is any name.
sbx('a trust level asked for as a list', set(pol('sourceTrustLevel'), ['ATTESTED']));
sbx('a trust level asked for as a list, of ACCREDITED', live, set(pol('sourceTrustLevel'), ['ACCREDITED']));
sbx('a trust level asked for that is a name every object answers to', live, set(pol('sourceTrustLevel'), 'constructor'));
sbx('a trust level asked for that is __proto__', set(pol('sourceTrustLevel'), '__proto__'));
sbx('a trust level asked for that is hasOwnProperty', set(pol('sourceTrustLevel'), 'hasOwnProperty'));
sbx('a trust level asked for as a list naming a name every object answers to', set(pol('sourceTrustLevel'), [['valueOf']]));
sbx('a window written as a list', set(pol('settlementWindow'), ['P2D']), set(el('chainTransfer', 'observedAt'), '2026-11-21T03:03:48.052Z'), set(pol('enforceFxQuoteWindow'), false));
sbx('a window of very many days', set(pol('settlementWindow'), `P${'9'.repeat(400)}D`), set(el('chainTransfer', 'observedAt'), '9999-12-31T23:59:59.999Z'), set(pol('enforceFxQuoteWindow'), false));
sbx('a window of zero seconds, settled a millisecond later', set(pol('settlementWindow'), 'PT0S'), set(el('chainTransfer', 'observedAt'), '2026-11-18T03:03:48.053Z'),
  set(el('travelRule', 'approvedAt'), '2026-11-18T03:03:48.052Z'));
sbx('a window with leading zeros', set(pol('settlementWindow'), 'P0002DT0000H0000M0000S'));
sbx('a long settlement, rounded to hours', set(pol('settlementWindow'), 'PT1H'), set(el('chainTransfer', 'observedAt'), '2026-11-18T04:33:48.052Z'), set(pol('enforceFxQuoteWindow'), false));
sbx('a long settlement, half an hour over', set(pol('settlementWindow'), 'PT1H'), set(el('chainTransfer', 'observedAt'), '2026-11-18T05:33:48.051Z'), set(pol('enforceFxQuoteWindow'), false));
sbx('basis points too large for a whole number to hold exactly', set(pol('amountToleranceBps'), 9007199254740993), set(el('chainTransfer', 'amount'), '0.01'));
sbx('basis points written with an exponent', set(pol('amountToleranceBps'), 1e21), set(el('chainTransfer', 'amount'), '0.01'));
sbx('a fee cap written with a decimal point', set(pol('fees'), { deductible: true, maxBps: 10.0 }), set(el('payoutReceipts', 0, 'amount'), '2497.50'));
sbx('a tolerance with a sign and spaces', set(pol('amountTolerance'), ' +0.010 '), set(el('chainTransfer', 'amount'), '2499.99'));
sbx('a negative tolerance', set(pol('amountTolerance'), '-0.01'));
sbx('an FX reference that is empty text', set(pol('fxReference'), ''), set(pol('unitOfAccountGroups'), []));
sbx('currencies that are not text', set(pol('currencies'), ['USD', 'USDC', 840, null]), set(pol('unitOfAccountGroups'), [['USD', 'USDC', 840, null]]),
  set(el('payoutReceipts', 0, 'currency'), 840), set(el('chainTransfer', 'currency'), null));
sbx('a policy with members nobody asked for', set(pol('note'), 'draft'), set(pol('10'), 1), set(pol('9'), { b: 1, a: [3, { d: 1, c: 2 }] }));
given('a policy that is text', SB.evidence, 'remit-corridor-v1');
given('a policy that is a list', SB.evidence, [SB.policy]);
given('a policy that is a number', SB.evidence, 1);
given('a policy that is true', SB.evidence, true);
given('a policy that is null', SB.evidence, null);
given('a policy that is null, and no evidence', null, null);

// Currencies.
sbx('a currency that is a number', set(el('payoutReceipts', 0, 'currency'), 840));
sbx('a currency that is a large number', set(el('payoutReceipts', 0, 'currency'), 1e21));
sbx('a currency that is a small number', set(el('payoutReceipts', 0, 'currency'), 0.0000001));
sbx('a currency that is null', set(el('payoutReceipts', 0, 'currency'), null));
sbx('a currency that is a list', set(el('payoutReceipts', 0, 'currency'), ['USD']));
sbx('a currency that is an object', set(el('payoutReceipts', 0, 'currency'), { code: 'USD' }));
sbx('a currency that is half a character', set(el('payoutReceipts', 0, 'currency'), '\ud83d'));
sbx('a currency with a quote and a line break in it', set(el('payoutReceipts', 0, 'currency'), 'U"S\nD '));
sbx('no instruction currency', unset(el('bankInstruction', 'currency')));
sbx('three foreign currencies and no FX reference', set(pol('unitOfAccountGroups'), []), set(pol('fxReference'), null),
  set(el('payoutReceipts', 0, 'currency'), null), set(pol('currencies'), ['USD', 'USDC', null]));
sbx('two receipts in the same foreign currency', set(pol('unitOfAccountGroups'), []), set(el('payoutReceipts', 1), { ...receipt0, ref: 'R-2' }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));

// Amounts — the sentence for each kind of thing that is not a decimal.
for (const [name, value] of [['true', true], ['a list', ['2500.00']], ['an object', { value: '2500.00' }], ['null', null], ['a fraction', 2500.5]]) {
  sbx(`a transfer amount that is ${name}`, set(el('chainTransfer', 'amount'), value));
}
sbx('no transfer amount', unset(el('chainTransfer', 'amount')));
sbx('no instruction amount', unset(el('bankInstruction', 'amount')));
sbx('an instruction amount with a quote in it', set(el('bankInstruction', 'amount'), '25"00\\'));
sbx('an instruction amount that is half a character', set(el('bankInstruction', 'amount'), '\udc00'));
sbx('a receipt amount with a non-breaking space inside', set(el('payoutReceipts', 0, 'amount'), '2 500.00'));
sbx('an invoice amount with an invisible mark at the end', set(el('commercialDocs', 'amount'), '2500.00​'));
sbx('amounts with leading zeros and a minus zero', set(el('chainTransfer', 'amount'), '0002500.000'), set(el('commercialDocs', 'amount'), '-0'), set(pol('amountTolerance'), '2500'));
sbx('a mismatch of less than one, written out', set(el('chainTransfer', 'amount'), '2500.005'), set(el('commercialDocs', 'amount'), '2499.9999'), set(pol('amountTolerance'), '0.0001'));
sbx('a large mismatch against a large tolerance', set(el('chainTransfer', 'amount'), '99999999999999999999999999.99'), set(pol('amountTolerance'), '1000000000000000000000.5'));
sbx('a receipt far below the instruction', set(el('payoutReceipts', 0, 'amount'), '-0.001'));

// Receipts — a list, or whatever stands where the list belongs.
sbx('receipts that are empty text', set(el('payoutReceipts'), ''));
sbx('receipts that are one character', set(el('payoutReceipts'), 'r'));
sbx('receipts that are one character, and a transfer amount that is no decimal', set(el('payoutReceipts'), 'r'), set(el('chainTransfer', 'amount'), 'n/a'));
sbx('receipts that are two characters', set(el('payoutReceipts'), 'rr'));
sbx('receipts that are two characters, where splits are allowed', set(el('payoutReceipts'), 'rr'), set(pol('splitPayments'), { allowed: true, aggregate: false }));
sbx('receipts that are two characters, where splits are added up', set(el('payoutReceipts'), 'rr'), set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('receipts that are one character outside the basic plane', set(el('payoutReceipts'), '😀'));
sbx('receipts that are text, and an invoice amount that is no decimal', set(el('payoutReceipts'), 'rr'), set(el('commercialDocs', 'amount'), 'n/a'));
sbx('receipts that are a number', set(el('payoutReceipts'), 5));
sbx('receipts that are zero', set(el('payoutReceipts'), 0));
sbx('receipts that are true', set(el('payoutReceipts'), true));
sbx('receipts that are false', set(el('payoutReceipts'), false));
sbx('receipts that are an object with a length', set(el('payoutReceipts'), { length: 1, 0: receipt0 }));
sbx('receipts that are a number, and an instruction amount that is no decimal', set(el('payoutReceipts'), 5), set(el('bankInstruction', 'amount'), 'n/a'));
for (const [name, value] of [['a number', 5], ['zero', 0], ['true', true], ['false', false], ['empty text', ''], ['text', 'paid'], ['an object', { ref: `${sid}/R` }],
  ['an object with a length of zero', { length: 0 }], ['an object with a length', { length: 2 }], ['an object whose length is text', { length: '2' }],
  ['an object whose length is no number', { length: 'two' }], ['an object whose length is a list', { length: [3] }], ['an object whose length is null', { length: null }],
  ['an object whose length is true', { length: true }], ['an object whose length is negative', { length: -1 }],
  ['an object holding a first receipt', { 0: { ref: `${sid}/R-0` } }], ['an object whose first member is null', { 0: null }]]) {
  sbx(`no bank instruction, live data, and receipts that are ${name}`, live, unset(el('bankInstruction')), set(el('payoutReceipts'), value));
}
sbx('receipts whose references are the same number', set(el('payoutReceipts', 0, 'ref'), 7), set(el('payoutReceipts', 1), { ...receipt0, ref: 7 }));
sbx('receipts whose references are a number and the same digits as text', set(el('payoutReceipts', 0, 'ref'), 7), set(el('payoutReceipts', 1), { ...receipt0, ref: '7' }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('receipts whose references are both true', set(el('payoutReceipts', 0, 'ref'), true), set(el('payoutReceipts', 1), { ...receipt0, ref: true }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('receipts whose references are equal lists', set(el('payoutReceipts', 0, 'ref'), ['R']), set(el('payoutReceipts', 1), { ...receipt0, ref: ['R'] }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('receipts whose references are zero and null', set(el('payoutReceipts', 0, 'ref'), 0), set(el('payoutReceipts', 1), { ...receipt0, ref: null }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('three receipts, two of them twice', set(el('payoutReceipts', 1), { ...receipt0, ref: 'R-2' }), set(el('payoutReceipts', 2), receipt0), set(el('payoutReceipts', 3), { ...receipt0, ref: 'R-2' }),
  set(el('payoutReceipts', 4), { ...receipt0, ref: 'R-2' }), set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('a receipt that is a list', set(el('payoutReceipts', 0), [receipt0]));
sbx('a receipt that is a number', set(el('payoutReceipts', 0), 2500));
sbx('two receipts that are text, where they are added up', set(el('payoutReceipts'), ['paid', 'paid']), set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('twelve receipts where none are allowed', ...Array.from({ length: 11 }, (_, i) => set(el('payoutReceipts', i + 1), { ...receipt0, ref: `R-${i}` })));

// References and parties.
sbx('ISO field names as text that holds the invoice reference', set(el('bankInstruction', 'iso20022Fields'), 'RmtInf INV-OTHER-1'), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names as empty text, under live data', live, set(el('bankInstruction', 'iso20022Fields'), ''), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names as text, and an invoice reference that is a number', set(el('bankInstruction', 'iso20022Fields'), 'RmtInf 20260458'), set(el('commercialDocs', 'invoiceRef'), 20260458));
sbx('ISO field names as text, and an invoice reference that is null', set(el('bankInstruction', 'iso20022Fields'), 'the null reference'), set(el('commercialDocs', 'invoiceRef'), null));
sbx('ISO field names as text, and an invoice reference that is a list', set(el('bankInstruction', 'iso20022Fields'), 'INV,2026'), set(el('commercialDocs', 'invoiceRef'), ['INV', 2026]));
sbx('ISO field names as a number', set(el('bankInstruction', 'iso20022Fields'), 7), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names as a number, and the instruction is the invoice by reference', set(el('bankInstruction', 'iso20022Fields'), 7), set(el('commercialDocs', 'invoiceRef'), E.bankInstruction.ref));
sbx('ISO field names as true', set(el('bankInstruction', 'iso20022Fields'), true), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names as an object', set(el('bankInstruction', 'iso20022Fields'), { includes: true }), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names as null', set(el('bankInstruction', 'iso20022Fields'), null), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names holding the invoice reference as a number', set(el('bankInstruction', 'iso20022Fields'), ['Dbtr', 458]), set(el('commercialDocs', 'invoiceRef'), 458));
for (const [name, value] of [['with a length', { length: 1 }], ['with a length of zero', { length: 0 }], ['whose length is text', { length: '3' }], ['with no length', { names: 2 }]]) {
  sbx(`live data, ISO field names as an object ${name}, the instruction being the invoice by reference`, live,
    set(el('bankInstruction', 'iso20022Fields'), value), set(el('commercialDocs', 'invoiceRef'), E.bankInstruction.ref));
}
sbx('references that are not text and differ', set(el('bankInstruction', 'ref'), 458), set(el('commercialDocs', 'invoiceRef'), { no: 458 }), set(el('bankInstruction', 'iso20022Fields'), []));
sbx('references that are null and null', set(el('bankInstruction', 'ref'), null), set(el('commercialDocs', 'invoiceRef'), null));
sbx('parties that are lists, matched exactly', set(pol('partyIDMatch'), 'exact'), set(el('commercialDocs', 'buyer'), ['Saigon Import Co., Ltd.']), set(el('bankInstruction', 'creditor'), { name: 'Lion City' }));
sbx('parties that are numbers, matched exactly', set(pol('partyIDMatch'), 'exact'), set(el('commercialDocs', 'buyer'), 7), set(el('bankInstruction', 'debtor'), 7),
  set(el('commercialDocs', 'seller'), 1), set(el('bankInstruction', 'creditor'), true));
sbx('an instruction debtor that is not text', set(el('bankInstruction', 'debtor'), ['Saigon Import Co., Ltd.']));
sbx('an invoice seller that is true', set(el('commercialDocs', 'seller'), true));
sbx('a buyer that is zero', set(el('commercialDocs', 'buyer'), 0));
sbx('parties in capitals of another alphabet', set(el('commercialDocs', 'buyer'), 'ΟΔΟΣ İstanbul CO., LTD.'), set(el('bankInstruction', 'debtor'), 'οδος i̇stanbul'));

// One id across every layer.
sbx('a settlement id that is a number', set(ev('settlementId'), 20261118), set(el('bankInstruction', 'ref'), 'PAY-20261118-6f1e6bf387'));
sbx('a settlement id that is a number, the memo the same number', set(ev('settlementId'), 20261118), set(el('chainTransfer', 'settlementIdMemo'), 20261118));
sbx('a settlement id that is a list', set(ev('settlementId'), [sid]));
sbx('a settlement id that is an object', set(ev('settlementId'), { id: sid }), set(el('bankInstruction', 'ref'), 'see [object Object]'));
sbx('a settlement id that is true', set(ev('settlementId'), true), set(el('bankApproval', 'approvalRef'), 'it is true'));
sbx('a settlement id that is zero', set(ev('settlementId'), 0));
sbx('references that are lists where the id is looked for', set(el('bankInstruction', 'ref'), [sid, 'x']), set(el('bankApproval', 'approvalRef'), [`APPR-${sid}`]),
  set(el('commercialDocs', 'invoiceRef'), [sid, 'x']));
sbx('a reference that is true where the id is looked for', set(el('bankInstruction', 'ref'), true));
sbx('a reference that is an object where the id is looked for', set(el('chainTransfer', 'txRef'), { includes: 1 }));
sbx('a reference that is an object where the id is looked for, the memo carrying it', set(el('chainTransfer', 'txRef'), { hash: '0x' }));
sbx('a reference that is zero where the id is looked for', set(el('bankApproval', 'approvalRef'), 0));
sbx('a first receipt that is text where the id is looked for', set(el('payoutReceipts', 0), 'paid'), set(pol('splitPayments'), { allowed: true, aggregate: false }),
  set(el('payoutReceipts', 1), 'paid'));
sbx('the id asked of names that are not names', set(pol('settlementIdRequiredIn'), [7, null, true, ['chainTransfer'], ['bankInstruction'], { a: 1 }, '', 'travelRule', 'commercialDocs']));
sbx('the id asked of names that are not names, and no memo', set(pol('settlementIdRequiredIn'), [7, ['chainTransfer'], 'chainTransfer']), unset(el('chainTransfer', 'settlementIdMemo')));
for (const name of ['toString', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__']) sbx(`the id asked of ${name}`, set(pol('settlementIdRequiredIn'), ['bankInstruction', name]));
sbx('the id asked of a name every object answers to, and no id', unset(ev('settlementId')), set(pol('settlementIdRequiredIn'), ['constructor']));
sbx('a memo that is not text', set(el('chainTransfer', 'settlementIdMemo'), { memo: sid }), set(el('chainTransfer', 'txRef'), null));

// The Travel Rule gate and the FX quote, said of values nobody expected.
sbx('an approval status that is not stated', unset(el('travelRule', 'approvalStatus')));
sbx('an approval status that is null', set(el('travelRule', 'approvalStatus'), null));
sbx('an approval status that is a number', set(el('travelRule', 'approvalStatus'), 2));
sbx('an approval status in lower case', set(el('travelRule', 'approvalStatus'), 'approved'));
sbx('an approval digest that is zero', set(el('travelRule', 'approvalDigest'), 0));
sbx('addresses that are not text', set(el('travelRule', 'approvedBeneficiaryAddress'), ['0x14dc']), set(el('chainTransfer', 'toAddress'), ['0x14dc']));
sbx('an approved address that is a number, the paid one the same number', set(el('travelRule', 'approvedBeneficiaryAddress'), 14), set(el('chainTransfer', 'toAddress'), 14.0));
sbx('a quote that is text', set(el('bankApproval', 'fxQuote'), 'USD/VND 25380'));
sbx('a quote that is true', set(el('bankApproval', 'fxQuote'), true));
sbx('a quote that is zero', set(el('bankApproval', 'fxQuote'), 0));
sbx('an expired quote whose pair and rate are not text', set(el('bankApproval', 'fxQuote'), { pair: ['USD', 'VND'], rate: 25380.50, quotedAt: E.bankApproval.fxQuote.quotedAt, validUntil: '2026-11-18T03:03:48.307Z' }));
sbx('an expired quote that states no pair and no rate', set(el('bankApproval', 'fxQuote'), { validUntil: '2026-11-18T03:03:48.307Z' }));
sbx('an expired quote whose rate is very small and whose pair is null', set(el('bankApproval', 'fxQuote'), { pair: null, rate: 1e-7, quotedAt: null, validUntil: '2026-11-18' }));
sbx('refund members that are not text', set(ev('refundReasonCode'), 0), set(ev('relatedSettlementId'), ['PAY-1']));
sbx('a refund reason that is an object', set(ev('refundReasonCode'), {}));

// Regulatory mapping and business finality.
sbx('live data, a checklist of things that are not names', live, set(pol('regulatoryFields'), ['originator', 7, null, ['purpose'], { field: 'amount' }, true, 'constructor', '']));
sbx('live data, members that are zero and false', live, set(ev('purpose'), 0), set(ev('jurisdiction'), { from: false, to: null }), set(el('chainTransfer', 'txRef'), ''));
sbx('live data, a jurisdiction that is text', live, set(ev('jurisdiction'), 'VN-SG'));
sbx('live data, a jurisdiction that is a list', live, set(ev('jurisdiction'), ['VN', 'SG']));
sbx('live data, the checklist twice over', live, set(pol('regulatoryFields'), ['lei', 'lei', 'purpose']), unset(ev('purpose')));

// Times: every spelling `Rules` reads, where a rule turns on it.
const approvedAt = E.bankInstruction.approvedAt;
const times = (name, from, to, ...ops) => sbx(`times: ${name}`, set(el('bankInstruction', 'approvedAt'), from), set(el('chainTransfer', 'observedAt'), to), ...ops);
const quiet = [set(pol('enforceFxQuoteWindow'), false), set(pol('requireTravelRulePreflight'), false)];
times('without a zone, both', '2026-11-18T03:03:48.052', '2026-11-18T03:03:48.308');
times('without a zone, against one with', '2026-11-18T03:03:48.052', '2026-11-18T10:03:48.308+07:00');
times('a space for the T', '2026-11-18 03:03:48.052Z', '2026-11-18 03:03:48.308Z');
times('a space for the T and no zone', '2026-11-18 03:03:48', '2026-11-20 03:03:48', ...quiet);
times('a space for the T and no zone, a second past the window', '2026-11-18 03:03:48', '2026-11-20 03:03:49', ...quiet);
times('lower case', '2026-11-18t03:03:48.052z', '2026-11-18t03:03:48.308z');
times('a zone without its colon', '2026-11-18T10:03:48.052+0700', '2026-11-17T20:03:48.308-0700');
times('no seconds', '2026-11-18T03:03Z', '2026-11-18T03:04Z', ...quiet);
times('a year alone and a month alone', '2026', '2026-01', ...quiet);
times('a year alone, and two days and a second later', '2026', '2026-01-03T00:00:01', ...quiet);
times('the end of a day', '2026-11-17T24:00:00Z', '2026-11-18T00:00:00.000Z', ...quiet);
times('a day past the end of February, in a leap year and not', '2024-02-30', '2026-02-30', ...quiet);
times('six-digit years', '+002026-11-18T03:03:48.052Z', '+002026-11-18T03:03:48.308Z');
times('a long fraction', '2026-11-18T03:03:48.0529999Z', '2026-11-18T03:03:48.3089999Z');
times('a long fraction that starts with zeros', '2026-11-18T03:03:48.052Z', '2026-11-18T03:03:48.0003080000Z', ...quiet);
times('a year below a hundred after a space', '0026-11-18 03:03:48', '2026-11-18T03:03:49', ...quiet);
times('a year that reads as a month after a space', '0011-18-26 03:03:48', '2026-11-18T03:03:49', ...quiet);
times('a zone wider than a day after a space', '2026-11-19 03:03:48+24:00', '2026-11-18T03:03:49Z', ...quiet);
times('a second of sixty', '2026-11-18T03:03:60Z', '2026-11-18T03:04:00Z', ...quiet);
times('a month of thirteen', '2026-13-18', '2026-11-18', ...quiet);
times('an hour of twenty-five after a space', '2026-11-18 25:00', '2026-11-18', ...quiet);
times('a number that is a year', 2026, 2027, ...quiet);
times('a list holding a time', ['2026-11-18T03:03:48.052Z'], ['2026-11-18T03:03:48.308Z']);
times('true', true, '2026-11-18T03:03:48.308Z', ...quiet);
times('an object', { at: approvedAt }, '2026-11-18T03:03:48.308Z', ...quiet);
times('beyond what a date can hold', '+275760-09-13T00:00:00.001Z', '+275760-09-13T00:00:00Z', ...quiet);
times('a year written -000000, which the engine reads as 2001', '-000000-01-01', '2001-01-03T00:00:01', ...quiet);
// Spellings `Rules` does not read. The reference reads them, each engine in its own way: these cases carry both answers.
times('other spellings: a month by name', 'Nov 18, 2026 03:03:48 UTC', '18 Nov 2026 03:03:49 GMT', ...quiet);
times('other spellings: a month by name, the funds first', '18 Nov 2026 03:03:49 GMT', 'Nov 18, 2026 03:03:48 UTC', ...quiet);
times('other spellings: slashes, past the window', '2026/11/18', '2026/11/21', ...quiet);
times('other spellings: slashes, within the window', '2026/11/18', '2026/11/19', ...quiet);
times('other spellings: a bare number of milliseconds', 1794971028052, 1794971028308, ...quiet);
times('other spellings: a bare small number', 1, 99, ...quiet);
times('other spellings: one-digit month and day', '2026-1-8', '2026-1-9', ...quiet);
times('other spellings: a space before', ' 2026-11-18T03:03:48.052Z', '2026-11-18T03:03:48.308Z', ...quiet);
times('other spellings: two spaces for the T', '2026-11-18  03:03:48', '2026-11-18  03:03:49', ...quiet);
times('other spellings: a zone after a space', '2026-11-18 03:03:48 Z', '2026-11-18 03:03:49 +00:00', ...quiet);
times('other spellings: a zone of hours alone', '2026-11-18 03:03:48+07', '2026-11-18 03:03:49+07', ...quiet);
times('other spellings: one side only', 'Nov 18, 2026 03:03:48 UTC', '2026-11-18T03:03:49Z', ...quiet);
sbx('times: other spellings at the Travel Rule gate, the funds first', set(el('travelRule', 'approvedAt'), 'Nov 18, 2026 04:00:00 UTC'));
sbx('times: other spellings at the Travel Rule gate, the approval first', set(el('travelRule', 'approvedAt'), 'Nov 18, 2026 03:03:48 UTC'));
sbx('times: other spellings of a quote that expired', set(el('bankApproval', 'fxQuote', 'validUntil'), 'Nov 18, 2026 03:03:48 UTC'));
sbx('times: other spellings of a quote made after the transfer', set(el('bankApproval', 'fxQuote', 'quotedAt'), '2026/11/19'));
sbx('times: other spellings of the transfer, with a quote and the gate', set(el('chainTransfer', 'observedAt'), 'Nov 19, 2026 03:03:48 UTC'));
sbx('times: a quote made after a transfer, neither with a zone', set(el('chainTransfer', 'observedAt'), '2026-11-18 03:03:48.308'), set(el('bankApproval', 'fxQuote', 'quotedAt'), '2026-11-18 03:03:48.309'));
sbx('times: a quote made after a transfer, both as lists', set(el('chainTransfer', 'observedAt'), ['2026-11-18T03:03:48.308Z']), set(el('bankApproval', 'fxQuote', 'quotedAt'), ['2026-11-19']),
  set(el('bankApproval', 'fxQuote', 'validUntil'), ['2026-11-17']), set(el('bankApproval', 'fxQuote', 'pair'), 0), set(el('bankApproval', 'fxQuote', 'rate'), null));
sbx('times: a quote and a transfer without zones', set(el('chainTransfer', 'observedAt'), '2026-11-18T03:13:48.025'), set(el('bankApproval', 'fxQuote', 'validUntil'), '2026-11-18 03:13:48.024'));
sbx('times: a Travel Rule approval without a zone, after the funds', set(el('travelRule', 'approvedAt'), '2026-11-18 03:03:48.309'));
sbx('times: a receipt time read where there is no transfer time', unset(el('chainTransfer', 'observedAt')), set(el('payoutReceipts', 0, 'paidAt'), '2026-11-18 03:03:47'));
sbx('times: a receipt time that is a list', unset(el('chainTransfer', 'observedAt')), set(el('payoutReceipts', 0, 'paidAt'), ['2026-11-21']));

// ── the table: what no text and no number can be made of ───────────────────
//
// The engine turns a value into text wherever it writes it into a sentence, looks it up by name or matches it
// against a pattern, and into a number wherever it compares it. Of an object it asks its `toString`; the one every
// object inherits answers "[object Object]", and a member of the object's own by that name — which in a JSON
// document is never a function — stands in its way: TypeError, "Cannot convert object to primitive value". A member
// named `valueOf` alone changes nothing. A list is written as its members, so the same holds for what a list holds.
// So: each of these values, at every position a case above varies. `Rules` has to answer, or refuse, wherever the
// reference does — whichever rule happens to read the value first.
const UNWRITABLE = [
  ['an object with a member named toString', { toString: 1 }],
  ['an object whose toString is null', { toString: null }],
  ['an object with a member named valueOf', { valueOf: 1 }],
  ['an object with both', { toString: 'x', valueOf: 2 }],
  ['a list holding an object with a member named toString', [{ toString: 1 }]],
  ['a list holding an object with a member named valueOf', [{ valueOf: 1 }]],
  ['a list holding text and an object with both', ['a', { valueOf: [], toString: {} }]],
  ['a list in a list holding an object with a member named toString', [[{ toString: 1 }]]],
];
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** A cell: the digest of the answer, or the refusal — the engine's (`engine: …`) or the reference's own sentence (`refused: …`). */
const cell = (a) => (a.threw ? `${a.threw.engine ? 'engine' : 'refused'}: ${a.threw.message}` : sha(JSON.stringify(a.result)));
const pathKey = (at) => JSON.stringify(at);
const positionsOf = (cases, opsOf, keep) => {
  const seen = new Map();
  for (const c of cases) for (const op of opsOf(c) ?? []) if (keep(op.at) && !seen.has(pathKey(op.at))) seen.set(pathKey(op.at), op.at);
  return [...seen.values()];
};
// A receipt beyond the second has nothing before it to stand behind: the base holds one.
const within = (at) => !(at[0] === 'evidence' && at[2] === 'payoutReceipts' && typeof at[3] === 'number' && at[3] > 1);
const enginePositions = positionsOf(engine, (c) => (c.from === 'verdict.json' ? verdict.engine.find((x) => x.name === c.name)?.ops : c.ops), within);
const contexts = [
  ['as the sandbox issued it', []],
  ['under live data', [live]],
  ['under live data, where every switch of the policy is thrown the other way', [live, set(pol('splitPayments'), { allowed: true, aggregate: true }),
    set(el('payoutReceipts', 1), { ...receipt0, ref: `${receipt0.ref}-2` }), set(pol('partyIDMatch'), 'exact'), set(pol('unitOfAccountGroups'), []),
    set(pol('fxReference'), null), set(pol('enforceFxQuoteWindow'), false), set(pol('requireTravelRulePreflight'), false), set(pol('fees'), { deductible: true, maxBps: 50 })]],
];
const engineTable = contexts.map(([, ops]) => enginePositions.map((at) => UNWRITABLE.map(([, value]) => {
  const doc = apply(SB, [...ops, set(at, value)]);
  return cell(evaluated(doc.evidence, doc.policy));
})));

// ── policies ───────────────────────────────────────────────────────────────

const policies = [];
function policyCase(name, policy) {
  unique('policies', name);
  let problem = null;
  try { validatePolicy(policy); } catch (e) { problem = thrown(e); }
  policies.push({ name, policy, problem, canonical: canonicalPolicy(policy), digest: policyDigest(policy) });
}
policyCase('the sandbox corridor policy', SB.policy);
policyCase('the trade policy of the rules package', read(path.join(RULES, 'policies/settlement-match-v1.json')));
policyCase('the corridor policy of the rules package', read(path.join(RULES, 'policies/corridor-vn-sg-v1.json')));
policyCase('the sandbox policy, its members in reverse order', Object.fromEntries(Object.entries(SB.policy).reverse()));
policyCase('the sandbox policy, the members of its objects in reverse order', { ...SB.policy,
  fees: Object.fromEntries(Object.entries(SB.policy.fees).reverse()), splitPayments: Object.fromEntries(Object.entries(SB.policy.splitPayments).reverse()) });
policyCase('the sandbox policy, its lists in reverse order', { ...SB.policy, currencies: [...SB.policy.currencies].reverse(), requiredElements: [...SB.policy.requiredElements].reverse() });
// Every policy the verdict vectors put to the engine, the refused ones included.
for (const c of verdict.engine) {
  if (!c.base || !c.ops.some((op) => op.at[0] === 'policy')) continue;
  const doc = apply(bases[c.base], c.ops);
  if (doc.policy === undefined) continue;
  policyCase(`as in the engine case "${c.name}"`, doc.policy);
}
const P = (changes) => { const out = clone(SB.policy); for (const [k, v] of Object.entries(changes)) { if (v === undefined) delete out[k]; else out[k] = v; } return out; };
// Each check, in the order the reference makes them — and which one speaks when several fail.
policyCase('nothing in it', {});
policyCase('text', 'remit-corridor-v1');
policyCase('a list', [SB.policy]);
policyCase('a number', 1);
policyCase('false', false);
policyCase('null', null);
policyCase('a version that is a number', P({ policyVersion: 1 }));
policyCase('a version that is null', P({ policyVersion: null }));
policyCase('currencies that are text', P({ currencies: 'USD' }));
policyCase('currencies that are an object with a length', P({ currencies: { length: 2, 0: 'USD', 1: 'USDC' } }));
policyCase('no groups', P({ unitOfAccountGroups: undefined }));
policyCase('groups that are text', P({ unitOfAccountGroups: 'USD' }));
policyCase('a group that is text', P({ unitOfAccountGroups: [['USD'], 'USDC'] }));
policyCase('a group that is null', P({ unitOfAccountGroups: [null] }));
policyCase('a currency twice in one group', P({ unitOfAccountGroups: [['USD', 'USD']] }));
policyCase('a currency in two groups, and a group naming one that is not permitted', P({ unitOfAccountGroups: [['USD', 'EUR'], ['USD']] }));
policyCase('a group naming a number that is not permitted', P({ unitOfAccountGroups: [[840]] }));
policyCase('a group naming a number that is permitted, written another way', P({ currencies: ['USD', 'USDC', 840], unitOfAccountGroups: [[840.0, 'USD']] }));
policyCase('a group naming null twice', P({ currencies: ['USD', null], unitOfAccountGroups: [[null], [null]] }));
policyCase('a group naming a list', P({ unitOfAccountGroups: [[['USD', 'USDC']]] }));
policyCase('a group naming an object', P({ unitOfAccountGroups: [[{ code: 'USD' }]] }));
policyCase('a group naming a large number', P({ unitOfAccountGroups: [[1e21]] }));
policyCase('a group naming half a character', P({ unitOfAccountGroups: [['\ud83d']] }));
for (const [name, value] of [['is not stated', undefined], ['is null', null], ['is true', true], ['is a list', ['0.00']], ['is an object', { value: '0' }], ['is empty', ''],
  ['is only spaces', '   '], ['has an exponent', '1e2'], ['has two points', '1.0.0'], ['ends in a point', '1.'], ['starts with a point', '.5'], ['has a quote in it', '0"0'],
  ['has a sign alone', '+'], ['is hexadecimal', '0x10'], ['is Infinity', 'Infinity'], ['has a non-breaking space around it', ' 0.01 ']]) {
  policyCase(`a tolerance that ${name}`, P({ amountTolerance: value }));
}
for (const [name, value] of [['are not stated', undefined], ['are null', null], ['are a fraction', 1.5], ['are true', true], ['are a list', [1]], ['are too large to be finite', 1e400],
  ['are written with a decimal point', 5.0], ['are written with an exponent', 1e2], ['are minus zero', -0], ['are a very large whole number', 1e300]]) {
  policyCase(`basis points that ${name}`, P({ amountToleranceBps: value }));
}
policyCase('an FX reference that is a number', P({ fxReference: 0 }));
policyCase('an FX reference that is a list', P({ fxReference: [] }));
for (const [name, value] of [['is not stated', undefined], ['is null', null], ['is a number', 2], ['is true', true], ['is a list of one', ['P2D']], ['is a list of two', ['P2D', 'PT1H']],
  ['is an empty list', []], ['is an object', { days: 2 }], ['is empty', ''], ['is P alone', 'P'], ['is PT alone', 'PT'], ['has every part', 'P1DT2H3M4S'], ['is in weeks', 'P1W'],
  ['is in years', 'P1Y'], ['has a fraction', 'PT1.5S'], ['is in lower case', 'p2d'], ['has a space before', ' P2D'], ['has its parts out of order', 'PT1S2M'], ['is negative', '-P2D'],
  ['has a time part without the T', 'P1D2H'], ['has digits of another script', 'P٢D']]) {
  policyCase(`a window that ${name}`, P({ settlementWindow: value }));
}
policyCase('fees that are text', P({ fees: 'none' }));
policyCase('fees that are null', P({ fees: null }));
policyCase('fees that are a list', P({ fees: [false, 0] }));
policyCase('fees whose deductible is text', P({ fees: { deductible: 'no', maxBps: 0 } }));
policyCase('fees with no cap', P({ fees: { deductible: false } }));
policyCase('fees whose cap is negative', P({ fees: { deductible: false, maxBps: -1 } }));
policyCase('fees whose cap is text', P({ fees: { deductible: false, maxBps: '0' } }));
policyCase('a split rule that is true', P({ splitPayments: true }));
policyCase('a split rule whose allowed is a number', P({ splitPayments: { allowed: 1, aggregate: false } }));
policyCase('a split rule whose aggregate is null', P({ splitPayments: { allowed: true, aggregate: null } }));
policyCase('a party match in capitals', P({ partyIDMatch: 'EXACT' }));
policyCase('a party match that is a list', P({ partyIDMatch: ['exact'] }));
policyCase('no party match', P({ partyIDMatch: undefined }));
for (const [name, value] of [['is not stated', undefined], ['is null', null], ['is in lower case', 'attested'], ['is a number', 1], ['is a list naming one', ['DEMO']],
  ['is a list naming two', ['DEMO', 'ATTESTED']], ['is a list in a list', [['ACCREDITED']]], ['is an object', { level: 'DEMO' }], ['is true', true], ['is empty', ''],
  ['is constructor', 'constructor'], ['is toString', 'toString'], ['is __proto__', '__proto__'], ['is isPrototypeOf', 'isPrototypeOf'], ['is toLocaleString', 'toLocaleString'],
  ['is propertyIsEnumerable', 'propertyIsEnumerable'], ['is __lookupGetter__', '__lookupGetter__'], ['is prototype', 'prototype'], ['is length', 'length']]) {
  policyCase(`a trust level that ${name}`, P({ sourceTrustLevel: value }));
}
policyCase('required elements that are an object', P({ requiredElements: { 0: 'bankInstruction', length: 1 } }));
policyCase('elements to be signed that are null', P({ signatureRequiredElements: null }));
policyCase('a Travel Rule switch that is zero', P({ requireTravelRulePreflight: 0 }));
policyCase('a Travel Rule switch that is text', P({ requireTravelRulePreflight: 'false' }));
policyCase('no quote-window switch', P({ enforceFxQuoteWindow: undefined }));
policyCase('a list of where the id is carried that is text', P({ settlementIdRequiredIn: 'bankInstruction' }));
policyCase('elements to be signed that are not names', P({ signatureRequiredElements: [7] }));
policyCase('elements to be signed that are not names, and are required', P({ requiredElements: [...SB.policy.requiredElements, 7, null], signatureRequiredElements: [7, null] }));
policyCase('an element to be signed that is a list', P({ signatureRequiredElements: [['bankInstruction']] }));
policyCase('an element to be signed that is an object', P({ signatureRequiredElements: [{ name: 'bankInstruction' }] }));
policyCase('an element to be signed that is null', P({ signatureRequiredElements: [null] }));
policyCase('a checklist that is null', P({ regulatoryFields: null }));
policyCase('a checklist that is text, and elements to be signed that need not be supplied', P({ regulatoryFields: 'all', requiredElements: [] }));
policyCase('everything wrong at once', { policyVersion: '', currencies: [], unitOfAccountGroups: null });
policyCase('a version and nothing else', { policyVersion: 'v' });
// The canonical text: names, numbers and text as JavaScript writes them.
policyCase('members named by whole numbers', P({ 10: 'ten', 9: 'nine', '01': 'leading zero', 4294967294: 'the last index', 4294967295: 'one past it', '-1': 'negative', '1.5': 'a fraction', '': 'empty',
  nested: { b: 1, a: 2, 2: 'two', 1: 'one', B: 3, _: 4, é: 5, '😀': 6, '퟿': 7, '': 8 } }));
policyCase('numbers of every size', P({ numbers: [0, -0, 1, -1, 1.5, 0.1, 1e21, 1e-7, 123456789012345680000, 5e-324, 1.7976931348623157e308, 9007199254740993, 100, 0.000001, 1e300, 1e400, -1e400,
  0.30000000000000004, 2 ** 53, 2 ** 53 + 2, 1 / 3, 123456.789e3, 4.35, 0.1 + 0.7, 1e23, 1.2e-10] }));
policyCase('text of every kind', P({ note: 'tab\there "quoted" back\\slash \u0000 \u001f \u007f é     😀 \ud83d alone \udc00 alone', list: [null, true, false, '', [], {}, [[]], [{}]] }));
policyCase('a member named __proto__', JSON.parse(`${JSON.stringify(SB.policy).slice(0, -1)},"__proto__":{"policyVersion":"other"},"nested":{"__proto__":5,"a":1}}`));
policyCase('members named like the things every object has', P({ constructor: 1, toString: 'x', hasOwnProperty: null, valueOf: [] }));
// The table over the policy: every member of the sandbox policy, the members of its objects and the first member of
// each of its lists — and the policy itself. What the checks say of it, and the digest (which reads no value as text).
const policyPositions = [[], ...Object.keys(SB.policy).flatMap((k) => {
  const v = SB.policy[k];
  if (Array.isArray(v)) return [[k], [k, 0], ...(Array.isArray(v[0]) ? [[k, 0, 0]] : []), [k, v.length]];
  return v && typeof v === 'object' ? [[k], ...Object.keys(v).map((m) => [k, m])] : [[k]];
})];
const policyCell = (policy) => {
  let problem = null;
  try { validatePolicy(policy); } catch (e) { problem = thrown(e); }
  return `${policyDigest(policy)} ${problem === null ? 'taken' : `${problem.engine ? 'engine' : 'refused'}: ${problem.message}`}`;
};
const policyTable = policyPositions.map((at) => UNWRITABLE.map(([, value]) => policyCell(at.length === 0 ? clone(value) : apply({ policy: SB.policy }, [set(['policy', ...at], value)]).policy)));

// ── signatures ─────────────────────────────────────────────────────────────

const jwkOfSpki = (spki) => createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
/**
 * A keyring entry as `Rules.keyring` takes it → the reference's VerificationKey. A key held as SPKI is converted as the
 * platform's registry converts it; an entry that states a JWK is taken at that, whatever else it holds.
 */
const referenceKey = ({ publicKeySpki, ...rest }) => (publicKeySpki === undefined || 'publicKeyJwk' in rest ? rest : { ...rest, publicKeyJwk: jwkOfSpki(publicKeySpki) });
const signatures = [];
async function checked(name, inputs, evidence, entries) {
  unique('signatures', name);
  let expected;
  try {
    expected = { evidence: clone(await verifyEvidenceSignatures(evidence, keyring(entries.map(referenceKey)))) };
  } catch (e) { expected = { threw: thrown(e) }; }
  signatures.push({ name, ...inputs, keyring: entries, expected });
}
const attested = (institutions) => institutions.filter((i) => i.signing_spki)
  .map((i) => ({ keyId: i.id, ...(i.name === undefined ? {} : { issuer: i.name }), trustLevel: 'ATTESTED', publicKeySpki: i.signing_spki }));
const sandboxRing = attested(SB.registry);
// Every signature case of the verdict vectors, against the registry as a keyring — the whole evidence this time.
let registriesLeftOut = 0;
for (const c of verdict.signatures) {
  const doc = apply({ evidence: SB.evidence, registry: SB.registry }, c.ops);
  if (!Array.isArray(doc.registry)) { registriesLeftOut++; continue; }
  const entries = attested(doc.registry);
  // A registry key the platform's conversion refuses is left out of the keyring by the registry, before `Rules` is asked.
  try { entries.forEach(referenceKey); } catch { registriesLeftOut++; continue; }
  await checked(c.name, { from: 'verdict.json' }, doc.evidence, entries);
}
const demoRing = [...DEMO_KEYRING.values()].map((k) => clone(k));
const tradeBase = read(path.join(RULES, 'fixtures/a-normal-trade-payment.json'));
const corridorBase = read(path.join(RULES, 'fixtures/corridor-vn-sg-normal.json'));
for (const s of SCENARIOS) await checked(`trade scenario ${s.id}, under the demonstration keys`, { evidence: s.derive(tradeBase) }, s.derive(tradeBase), demoRing);
for (const s of CORRIDOR_SCENARIOS) await checked(`corridor scenario ${s.id}, under the demonstration keys`, { evidence: s.derive(corridorBase) }, s.derive(corridorBase), demoRing);
await checked('the trade payment under a keyring that holds none of its keys', { evidence: tradeBase }, tradeBase, sandboxRing);
await checked('the trade payment under an empty keyring', { evidence: tradeBase }, tradeBase, []);
/** The sandbox settlement under a keyring with something changed in it. */
const ring = async (name, change, ...ops) => {
  const doc = apply({ evidence: SB.evidence }, ops);
  await checked(name, { base: 'sandbox', ops }, doc.evidence, change(clone(sandboxRing)));
};
const bankKey = E.bankInstruction.signature.keyId;
const bankAt = sandboxRing.findIndex((k) => k.keyId === bankKey);
const bankJwk = jwkOfSpki(sandboxRing[bankAt].publicKeySpki);
const otherJwk = jwkOfSpki(sandboxRing[(bankAt + 1) % sandboxRing.length].publicKeySpki);
const withBank = (change) => (r) => { r[bankAt] = change(r[bankAt]); return r; };
const asJwk = (jwk) => ({ publicKeySpki, ...rest }) => ({ ...rest, publicKeyJwk: jwk });
// How far a key is trusted, and who it stands for, is the keyring's word.
for (const [name, level] of [['DEMO', 'DEMO'], ['ACCREDITED', 'ACCREDITED'], ['a level nobody knows', 'PLATINUM'], ['in lower case', 'demo'], ['null', null], ['a number', 2], ['a list', ['DEMO']]]) {
  await ring(`the bank's key trusted as ${name}`, withBank((k) => ({ ...k, trustLevel: level })));
}
await ring('the bank\'s key with no trust level', withBank(({ trustLevel, ...k }) => k));
await ring('every key a demonstration key', (r) => r.map((k) => ({ ...k, trustLevel: 'DEMO' })));
await ring('the bank\'s key with no issuer', withBank(({ issuer, ...k }) => k));
await ring('the bank\'s key with an issuer that is null', withBank((k) => ({ ...k, issuer: null })));
await ring('the bank\'s key with an issuer that is not text', withBank((k) => ({ ...k, issuer: { name: 'Bank', lei: 7 } })));
await ring('a demonstration key, and a signature that does not verify', withBank((k) => ({ ...k, trustLevel: 'DEMO' })), set(el('bankInstruction', 'amount'), '1.00'));
await ring('members of the entry in another order, and one more', withBank((k) => ({ note: 'x', publicKeySpki: k.publicKeySpki, trustLevel: k.trustLevel, issuer: k.issuer, keyId: k.keyId })));
// The key as a JWK, and what makes one unusable.
await ring('the bank\'s key as a JWK', withBank(asJwk(bankJwk)));
await ring('every key as a JWK', (r) => r.map((k) => asJwk(jwkOfSpki(k.publicKeySpki))(k)));
await ring('a JWK and an SPKI in one entry: the JWK is the key', withBank((k) => ({ ...k, publicKeyJwk: otherJwk })));
await ring('a JWK for signing', withBank(asJwk({ ...bankJwk, use: 'sig', alg: 'ES256', key_ops: ['verify'], kid: 'bank-1', ext: true })));
await ring('a JWK for encryption', withBank(asJwk({ ...bankJwk, use: 'enc' })));
await ring('a JWK whose use is null', withBank(asJwk({ ...bankJwk, use: null })));
await ring('a JWK for another algorithm', withBank(asJwk({ ...bankJwk, alg: 'ES384' })));
await ring('a JWK whose algorithm is null', withBank(asJwk({ ...bankJwk, alg: null })));
await ring('a JWK that may sign but not verify', withBank(asJwk({ ...bankJwk, key_ops: ['sign'] })));
await ring('a JWK that may verify, among other things', withBank(asJwk({ ...bankJwk, key_ops: ['sign', 'verify', 'somethingElse'] })));
await ring('a JWK that may verify, said twice', withBank(asJwk({ ...bankJwk, key_ops: ['verify', 'verify'] })));
await ring('a JWK with no operations', withBank(asJwk({ ...bankJwk, key_ops: [] })));
await ring('a JWK whose operations are text', withBank(asJwk({ ...bankJwk, key_ops: 'verify' })));
await ring('a JWK of another kind', withBank(asJwk({ ...bankJwk, kty: 'RSA' })));
await ring('a JWK with no kind', withBank(asJwk({ crv: bankJwk.crv, x: bankJwk.x, y: bankJwk.y })));
await ring('a JWK on another curve', withBank(asJwk({ ...bankJwk, crv: 'P-384' })));
await ring('a JWK with no curve', withBank(asJwk({ kty: 'EC', x: bankJwk.x, y: bankJwk.y })));
await ring('a JWK that is a private key', withBank(asJwk({ ...bankJwk, d: bankJwk.x })));
await ring('a JWK whose point is not on the curve', withBank(asJwk({ ...bankJwk, y: bankJwk.x })));
await ring('a JWK with the coordinates of another key', withBank(asJwk(otherJwk)));
await ring('a JWK with no y', withBank(asJwk({ kty: 'EC', crv: 'P-256', x: bankJwk.x })));
await ring('a JWK whose x is a number', withBank(asJwk({ ...bankJwk, x: 7 })));
await ring('a JWK whose x is empty', withBank(asJwk({ ...bankJwk, x: '' })));
await ring('a JWK that is null', withBank(asJwk(null)));
await ring('a JWK that is text', withBank(asJwk(JSON.stringify(bankJwk))));
await ring('a JWK that is empty', withBank(asJwk({})));
await ring('an entry with no key at all', withBank(({ publicKeySpki, ...k }) => k));
// Keys of other kinds, held as SPKI: each converts, and nothing verifies under it.
const P384 = 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEtBTz2MUAjVytNNvkDFEzfnN2NP3F52CG/esSlte0EEcZoB9zJ1CJkW13ZZ5oJw77Nc1gavdpo/2XMC6IL2Hh7s1ihdcuGmHhpdLJwZagUzLiCGeegc61fNvmLvyYOvhw';
const P256K = 'MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEyaeLzYRedlLh+3gTPXeNlulEtNvuFksCGevL+lXWqIA5rz+bwVecJvDBHYbqsFPLTLHqQVKEVmegoZ6XWfiBVg==';
const ED25519 = 'MCowBQYDK2VwAyEAY0FGd1FX6rrwLDNTz52DSxMa7cvoJBeucGzr99R3/V4=';
await ring('the bank\'s key held as a P-384 key', withBank((k) => ({ ...k, publicKeySpki: P384 })));
await ring('the bank\'s key held as a secp256k1 key', withBank((k) => ({ ...k, publicKeySpki: P256K })));
await ring('the bank\'s key held as an Ed25519 key', withBank((k) => ({ ...k, publicKeySpki: ED25519 })));
await ring('the bank\'s key held with line breaks in it', withBank((k) => ({ ...k, publicKeySpki: k.publicKeySpki.replace(/(.{40})/g, '$1\n') })));
await ring('the bank\'s key held in the URL-safe alphabet, without padding', withBank((k) => ({ ...k, publicKeySpki: Buffer.from(k.publicKeySpki, 'base64').toString('base64url') })));
// Keyrings.
await ring('the same key id twice', (r) => [...r, r[bankAt]]);
await ring('the same key id twice, the keys differing', (r) => [...r, { ...r[bankAt], publicKeySpki: r[(bankAt + 1) % r.length].publicKeySpki }]);
await ring('an empty key id', (r) => [...r, { ...r[bankAt], keyId: '' }], set(el('commercialDocs', 'signature', 'keyId'), ''));
// Evidence of every shape.
const shape = (name, evidence) => checked(name, { evidence }, evidence, sandboxRing);
await shape('evidence that is null', null);
await shape('evidence that is text', 'evidence');
await shape('evidence that is a number', 7);
await shape('evidence that is a list', [SB.evidence]);
await shape('evidence that is empty', {});
await shape('elements that are null', { elements: null, dataMode: 'LIVE' });
await shape('elements that are text', { elements: 'elements', scenario: 's' });
await shape('elements that are a number', { elements: 6 });
await shape('elements that are false', { elements: false });
await shape('elements that are zero', { elements: 0 });
await shape('elements that are empty text', { elements: '' });
await shape('elements that are a list', { elements: [E.bankInstruction] });
await shape('elements that are empty', { elements: {}, other: { signature: { status: 'VALID' } } });
await shape('elements that are zero, false, empty text and null', { elements: { payoutReceipts: 0, bankInstruction: false, commercialDocs: '', travelRule: null } });
await shape('elements that are text, a number and true', { elements: { payoutReceipts: 'receipts', bankInstruction: 7, commercialDocs: true } });
await shape('a list of receipts of every kind', { elements: { payoutReceipts: [receipt0, null, 'paid', 7, [receipt0], { ref: 'no signature member' }, { signature: null }, { signature: 'signed' },
  { signature: { status: 'VALID', value: 'AAAA' } }, { ...receipt0, amount: '1.00' }, true] } });
await shape('an element that is a list where one is expected', { elements: { bankInstruction: [E.bankInstruction, { ...E.bankInstruction, amount: '1.00' }] } });
await shape('signatures that state a status and nothing to check', { elements: {
  bankInstruction: { ref: 'a', signature: { status: 'VALID', keyId: bankKey } }, commercialDocs: { ref: 'b', signature: { status: 'ABSENT', keyId: bankKey, value: 'AAAA' } },
  travelRule: { ref: 'c', signature: { status: 'VALID', keyId: 0, value: 0 } }, bankApproval: { ref: 'd', signature: { keyId: ['k'] } },
  chainTransfer: { ref: 'e', signature: { status: null, value: '', keyId: '' } } } });
await shape('signatures whose key ids are not text', { elements: {
  bankInstruction: { ...E.bankInstruction, signature: { ...E.bankInstruction.signature, keyId: [bankKey] } },
  commercialDocs: { ...E.commercialDocs, signature: { ...E.commercialDocs.signature, keyId: { id: bankKey } } },
  travelRule: { ...E.travelRule, signature: { ...E.travelRule.signature, keyId: true } },
  bankApproval: { ...E.bankApproval, signature: { ...E.bankApproval.signature, keyId: 0 } } } });
await shape('signatures whose bytes are not text', { elements: {
  bankInstruction: { ...E.bankInstruction, signature: { ...E.bankInstruction.signature, value: [E.bankInstruction.signature.value] } },
  commercialDocs: { ...E.commercialDocs, signature: { ...E.commercialDocs.signature, value: { v: 1 } } },
  travelRule: { ...E.travelRule, signature: { ...E.travelRule.signature, value: true } } } });
await shape('a signature that states members nobody asked for, in another order', { elements: { bankInstruction: { ...E.bankInstruction,
  signature: { value: E.bankInstruction.signature.value, note: 'x', checked: false, status: 'INVALID', trustLevel: 'DEMO', algorithm: 'RS256', issuer: 'Nobody', keyId: bankKey } } } });
await shape('an element with a number that has no canonical form', { elements: { bankInstruction: { ...E.bankInstruction, weight: 1.5 } } });
await shape('an element that states a digest of another kind', { elements: { bankInstruction: { ...E.bankInstruction, digest: null, attached: 'x', citedOnly: 7, digestVerified: 'no' } } });
// The table over the signature pass: each element, its signature and what the pass reads of one, and a member the
// signature covers. The pass looks a key up by its id and never writes a value as text — so it answers everywhere.
const signaturePositions = [['evidence', 'elements'], el('payoutReceipts'), ...[['payoutReceipts', 0], ['bankInstruction'], ['commercialDocs'], ['travelRule'], ['bankApproval'], ['chainTransfer']]
  .flatMap((e) => [el(...e), el(...e, 'signature'), el(...e, 'signature', 'keyId'), el(...e, 'signature', 'value'), el(...e, 'signature', 'status'), el(...e, 'issuer'), el(...e, 'ref')])];
const signatureTable = [];
for (const at of signaturePositions) {
  const row = [];
  for (const [, value] of UNWRITABLE) {
    const doc = apply({ evidence: SB.evidence }, [set(at, value)]);
    try { row.push(sha(JSON.stringify(clone(await verifyEvidenceSignatures(doc.evidence, keyring(sandboxRing.map(referenceKey))))))); } catch (e) {
      const t = thrown(e);
      row.push(`${t.engine ? 'engine' : 'refused'}: ${t.message}`);
    }
  }
  signatureTable.push(row);
}

// ── instants ───────────────────────────────────────────────────────────────

/** A sequence that is the same on every run. */
let seed = 20261118;
const next = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return Math.floor((seed / 4294967296) * n); };
const pick = (list) => list[next(list.length)];
const years = ['2026', '2026', '2026', '1999', '0000', '0001', '0005', '0012', '0013', '0031', '0032', '0049', '0050', '0099', '0100', '1969', '1970', '9999', '+002026', '+000000', '+000005', '+000049',
  '+000050', '+000099', '+000100', '-000001', '-000005', '-000049', '-000050', '-000099', '-000100', '+010000', '+275760', '-271821', '+275761', '-271822', '-000000', '+999999', '-999999'];
const monthsAndDays = ['', '-01', '-11', '-00', '-13', '-31', '-60', '-99', '-11-18', '-11-18', '-11-18', '-02-28', '-02-29', '-02-30', '-02-31', '-04-31', '-12-31', '-11-00', '-11-32', '-11-60',
  '-11-99', '-13-05', '-00-05', '-31-99', '-13-49', '-09-13', '-09-14', '-04-19', '-04-20', '-04-21', '-01-01'];
const separators = ['T', 'T', 't', ' ', ' '];
const clockTimes = ['00:00', '03:03', '23:59', '24:00', '24:01', '25:00', '99:00', '23:60', '03:99', '03:03:48', '03:03:48', '00:00:00', '23:59:59', '23:59:60', '03:03:99', '03:60:10', '24:00:00',
  '24:00:01', '03:03:48.3', '03:03:48.30', '03:03:48.308', '03:03:48.308', '03:03:48.3089', '03:03:48.999', '03:03:48.9999', '03:03:48.000', '03:03:60.5', '03:03:99.999', '03:03:60.60',
  '03:03:60.0000000061', '24:00:00.0', '24:00:00.000', '24:00:00.0000000', '24:00:00.001', '24:00:00.0001', '24:00:00.0000000001', '24:00:00.000000001', '00:00:00.001', '23:59:59.999',
  '03:03:48.1234567890123', '03:03:48.0001234567890', '03:03:48.0123456789', '03:03:48.00000000001234', '03:03:48.001', '03:03:48.0019', '03:03:48.01', '03:03:48.0', '03:03:48.00',
  '03:03:48.0000', '03:03:48.000000000999', '03:03:48.0999999999999', '24:00:00.00000000000', '03:03:60.059', '03:03:60.0000000059', '03:03:60.59', '03:03:60.590'];
const zones = ['', '', 'Z', 'Z', 'z', '+00:00', '-00:00', '+07:00', '-07:00', '+0700', '-0700', '+23:59', '-23:59', '+2359', '-2359', '+24:00', '-24:00', '+2400', '-2400', '+23:60', '-23:60',
  '+2360', '-2360', '+00:60', '+0060', '+99:59', '+9999', '-9999', '+00:99', '-00:99', '+12:34', '-1234', '-0005', '-00:05', '-0959', '-09:59', '-0999'];
const texts = new Set();
// Each part varied on its own around a plain time, then every part at once, at random.
for (const y of years) for (const md of monthsAndDays) texts.add(y + md);
for (const y of years) for (const s of [...new Set(separators)]) for (const z of ['', 'Z', '+07:00', '-0700']) texts.add(`${y}-11-18${s}03:03:48.308${z}`).add(`${y}${s}03:03${z}`);
for (const md of monthsAndDays) for (const s of [...new Set(separators)]) for (const z of ['', 'Z']) texts.add(`2026${md}${s}03:03:48${z}`).add(`0005${md}${s}03:03:48${z}`);
for (const t of clockTimes) for (const s of [...new Set(separators)]) for (const z of ['', 'Z', '-07:00']) texts.add(`2026-11-18${s}${t}${z}`).add(`0005-11${s}${t}${z}`);
for (const z of zones) for (const s of [...new Set(separators)]) texts.add(`2026-11-18${s}03:03:48${z}`).add(`2026-11-18${s}03:03${z}`).add(`0005-11${s}03:60${z}`).add(`2026${s}03:03:60${z}`);
while (texts.size < 3600) texts.add(pick(years) + pick(monthsAndDays) + pick(separators) + pick(clockTimes) + pick(zones));
for (const t of texts) if (!SHAPE.test(t)) throw new Error(`"${t}" was meant to have the shape and has not`);
// And what has another shape: nothing of it is a time to `Rules`, whatever the engine makes of it.
const others = ['', ' ', 'not-a-date', 'soon', 'null', 'undefined', 'true', 'NaN', 'Z', 'T', '[object Object]', '—', 'Nov 18, 2026', 'Nov 18, 2026 03:03:48 UTC', '18 Nov 2026 03:03:48 GMT',
  'Wed, 18 Nov 2026 03:03:48 GMT', 'Wed Nov 18 2026 03:03:48 GMT+0000 (Coordinated Universal Time)', 'November 18, 2026', '2026/11/18', '2026/11/18 03:03:48', '11/18/2026', '18/11/2026', '11-18-2026',
  '2026.11.18', '20261118', '20261118T030348Z', '2026-11-18T030348Z', '2026-W47-3', '2026-322', '2026-1-8', '2026-11-8', '2026-1-18', '26-11-18', '026-11-18', '02026-11-18', '+2026-11-18', '+02026-11-18',
  '+0002026-11-18', '-2026-11-18', '1794971028308', '1794971028', '0', '1', '12', '99', '100', '999', '12345', '2026.5', '-1', '1e3', ' 2026-11-18', '2026-11-18 ', '\t2026-11-18', '2026-11-18\n',
  ' 2026-11-18T03:03:48Z', '2026-11-18T03:03:48Z ', '2026-11-18  03:03:48', '2026-11-18\t03:03:48', '2026-11-18\n03:03:48', '2026-11-18 03:03:48', '2026-11-18_03:03:48', '2026-11-18T 03:03:48',
  '2026-11-18T03:03:48 Z', '2026-11-18 03:03:48 Z', '2026-11-18 03:03:48 +07:00', '2026-11-18 03:03:48 UTC', '2026-11-18 03:03:48 GMT', '2026-11-18T03:03:48UTC', '2026-11-18 03:03:48GMT+7',
  '2026-11-18T03:03:48+07', '2026-11-18T03:03:48+7', '2026-11-18 03:03:48+07', '2026-11-18 03:03:48+7', '2026-11-18T03:03:48+070', '2026-11-18 03:03:48+070', '2026-11-18T03:03:48+07:0',
  '2026-11-18T03:03:48+07:000', '2026-11-18T03:03:48+07:00:00', '2026-11-18T03:03:48ZZ', '2026-11-18T03:03:48,308Z', '2026-11-18T03:03:48.Z', '2026-11-18T03:03:48.', '2026-11-18 03:03:48.',
  '2026-11-18T03:03.5', '2026-11-18T03', '2026-11-18T03Z', '2026-11-18 03', '2026-11-18T3:03', '2026-11-18 3:03', '2026-11-18 03:3', '2026-11-18 03:03:4', '2026-11-18T03:03:048', '2026-11-18T003:03',
  '2026-11-18T03:03:48 PM', '2026-11-18 03:03 pm', '2026-11-18T', '2026-11-18 T03:03', '2026-11-18TT03:03', '2026-11-18Z', '2026-11-18+07:00', '2026-11Z', '2026Z', 'T03:03:48Z', '03:03:48',
  '2026-11-18T03:03:48Z2026', '２０２６-11-18', '2026-11-18T０3:03', '٢٠٢٦-11-18', '2026−11−18', '2026‐11‐18', '275760-09-13', '-0000-01-01', '00000-01-01', '-00000-01-01', '+0000000-01-01'];
for (const t of others) { if (SHAPE.test(t)) throw new Error(`"${t}" was meant to have another shape`); }
const ms = (v) => (Number.isNaN(v) ? null : v);
const instants = {
  note: 'each entry is [text, what Date.parse answers with the machine in UTC (null: no date)]; `other` is text of another shape, which is no date to Rules whatever the engine answers',
  shaped: [...texts].map((t) => [t, ms(engineParse(t))]),
  other: others.map((t) => [t, ms(engineParse(t))]),
};

// ── Write, or compare ──────────────────────────────────────────────────────

if (process.argv.includes('--cell')) {
  // One cell of the table in full: node make-rules-golden.mjs --cell engine <context> <position> <value> (numbers, from 0),
  // or --cell policies <position> <value>.
  const [which, ...n] = process.argv.slice(process.argv.indexOf('--cell') + 1);
  const [a, b, c] = n.map(Number);
  if (which === 'engine') {
    const doc = apply(SB, [...contexts[a][1], set(enginePositions[b], UNWRITABLE[c][1])]);
    console.log(`${contexts[a][0]} · ${JSON.stringify(enginePositions[b])} · ${UNWRITABLE[c][0]}`);
    console.log(JSON.stringify(evaluated(doc.evidence, doc.policy), null, 1));
  } else if (which === 'policies') {
    console.log(`${JSON.stringify(policyPositions[a])} · ${UNWRITABLE[b][0]}`);
    console.log(policyCell(a === 0 ? clone(UNWRITABLE[b][1]) : apply({ policy: SB.policy }, [set(['policy', ...policyPositions[a]], UNWRITABLE[b][1])]).policy));
  } else {
    console.error('--cell engine <context> <position> <value> | --cell policies <position> <value>');
  }
  process.exit(0);
}

/** One case to a line: the file is large, and a change to one case should read as a change to one line. */
const lines = (list) => `[\n${list.map((c) => `  ${JSON.stringify(c)}`).join(',\n')}\n ]`;
const pairs = (list) => `[\n${Array.from({ length: Math.ceil(list.length / 6) }, (_, i) => `   ${list.slice(i * 6, i * 6 + 6).map((p) => JSON.stringify(p)).join(', ')}`).join(',\n')}\n  ]`;
const text = `{
 "note": "Generated by tools/make-rules-golden.mjs from the reference engine (packages/attest-rules). Do not edit by hand.",
 "shape": ${JSON.stringify(SHAPE.source)},
 "engine": ${lines(engine)},
 "policies": ${lines(policies)},
 "signatures": ${lines(signatures)},
 "instants": {
  "note": ${JSON.stringify(instants.note)},
  "shaped": ${pairs(instants.shaped)},
  "other": ${pairs(instants.other)}
 },
 "table": {
  "note": "each value at each position of the sandbox settlement. A cell is the SHA-256 of the reference's answer written as JSON (the whole result of evaluate; for policies the policy's digest, then what validatePolicy says; for signatures the whole evidence after the pass), or its refusal: 'engine: …' where the JavaScript engine fails (Rules refuses in words of its own), 'refused: …' where the reference refuses in its own sentence (Rules says the same)",
  "values": ${lines(UNWRITABLE.map(([name, value]) => ({ name, value })))},
  "engine": {
   "contexts": ${lines(contexts.map(([name, ops]) => ({ name, ops })))},
   "positions": ${lines(enginePositions)},
   "cells": [
${engineTable.map((rows) => `    ${lines(rows)}`).join(',\n')}
   ]
  },
  "policies": {
   "positions": ${lines(policyPositions)},
   "cells": ${lines(policyTable)}
  },
  "signatures": {
   "keyring": ${lines(sandboxRing)},
   "positions": ${lines(signaturePositions)},
   "cells": ${lines(signatureTable)}
  }
 }
}
`;
JSON.parse(text);

const CODES = ['ELEMENT_MISSING', 'DOCUMENT_CITED_NOT_ATTACHED', 'DIGEST_MISMATCH', 'DIGEST_NOT_CHECKED', 'SIGNATURE_ABSENT', 'SIGNATURE_NOT_CHECKED', 'SIGNATURE_UNKNOWN_KEY', 'SIGNATURE_INVALID',
  'ISSUER_TRUST_INSUFFICIENT', 'NO_REFERENCE_AMOUNT', 'CURRENCY_NOT_PERMITTED', 'CROSS_CURRENCY_WITHOUT_FX', 'FX_CONVERSION_REQUIRED', 'AMOUNT_MISMATCH', 'DUPLICATE_PAYOUT_REF', 'SPLIT_NOT_ALLOWED',
  'SPLIT_AGGREGATION_DISABLED', 'AGGREGATION_SKIPPED_DUPLICATE', 'REFERENCE_NOT_LINKED', 'PARTY_MISMATCH', 'TIMESTAMP_UNPARSEABLE', 'SETTLEMENT_BEFORE_APPROVAL', 'SETTLEMENT_WINDOW_EXCEEDED',
  'WINDOW_NOT_EVALUATED', 'SETTLEMENT_ID_MISSING', 'SETTLEMENT_ID_NOT_CARRIED', 'TRAVEL_RULE_MISSING', 'TRAVEL_RULE_NOT_APPROVED', 'TRAVEL_RULE_APPROVAL_UNSIGNED',
  'TRAVEL_RULE_TIMESTAMP_UNPARSEABLE', 'PREFLIGHT_VIOLATED', 'PREFLIGHT_NOT_EVALUATED', 'BENEFICIARY_ADDRESS_NOT_APPROVED', 'FX_QUOTE_EXPIRED', 'FX_QUOTE_AFTER_SETTLEMENT',
  'REFUND_WITHOUT_ORIGINAL', 'REFUND_WITHOUT_REASON', 'REGULATORY_FIELD_MISSING', 'SYNTHETIC_DATA', 'DEMO_ONLY', 'PAYOUT_UNCONFIRMED'];
const seen = new Map();
const members = new Map();
for (const c of engine) for (const f of c.result?.findings ?? []) {
  seen.set(f.code, (seen.get(f.code) ?? 0) + 1);
  const m = members.get(f.code) ?? new Set();
  m.add(Object.keys(f).slice(4).join('+') || '—');
  members.set(f.code, m);
}
const missing = CODES.filter((c) => !seen.has(c));
const unknown = [...seen.keys()].filter((c) => !CODES.includes(c));
if (missing.length || unknown.length) throw new Error(`findings the vectors do not make: ${missing.join(' ')}; findings nobody listed: ${unknown.join(' ')}`);
const statuses = new Map();
const levels = new Set();
for (const c of signatures) {
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.signature && typeof v.signature === 'object' && v.signature.checked === true) {
        statuses.set(v.signature.status, (statuses.get(v.signature.status) ?? 0) + 1);
        if ('trustLevel' in v.signature) levels.add(JSON.stringify(v.signature.trustLevel));
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(c.expected.evidence?.elements);
}

if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('rules.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`rules.json is current (${engine.length} engine, ${policies.length} policy, ${signatures.length} signature cases, ${instants.shaped.length + instants.other.length} instants, `
    + `${engineTable.flat(Infinity).length + policyTable.flat().length + signatureTable.flat().length} cells of the table)`);
} else {
  writeFileSync(OUT, text);
  const threw = (list, engineOnly) => list.filter((c) => (c.threw ?? c.expected?.threw ?? c.problem)?.engine === engineOnly).length;
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${(text.length / 1000).toFixed(0)} kB`);
  console.log(`  engine ${engine.length} (${carried} from verdict.json): ${threw(engine, false)} refused in the reference's words, ${threw(engine, true)} where its engine fails, `
    + `${otherSpellings} that turn on a spelling of a time Rules does not read`);
  console.log(`  policies ${policies.length}: ${policies.filter((p) => !p.problem).length} the engine takes, ${threw(policies, false)} it refuses, ${threw(policies, true)} where its engine fails; `
    + `${new Set(policies.map((p) => p.digest)).size} distinct digests, ${new Set(policies.filter((p) => p.problem && !p.problem.engine).map((p) => p.problem.message.replace(/(names|currency|got) .*?(, which| appears|$)/, '$1 …$2'))).size} distinct sentences`);
  console.log(`  signatures ${signatures.length} (${verdict.signatures.length - registriesLeftOut} from verdict.json, ${registriesLeftOut} left out: a registry the platform does not make a keyring of): `
    + `${threw(signatures, false)} refused, ${threw(signatures, true)} where the engine fails; statuses ${[...statuses.entries()].map(([k, n]) => `${k}×${n}`).join(' ')}; trust levels ${[...levels].join(' ')}`);
  console.log(`  instants ${instants.shaped.length} of the shape (${instants.shaped.filter((p) => p[1] === null).length} no date), ${instants.other.length} of another `
    + `(${instants.other.filter((p) => p[1] !== null).length} the engine reads all the same)`);
  const kinds = (cells) => { const all = cells.flat(Infinity); const n = (re) => all.filter((x) => re.test(x)).length;
    return `${all.length} cells: ${all.length - n(/^(engine|refused): /) - n(/ (engine|refused): /)} answered, ${n(/(^| )engine: Cannot convert object to primitive value$/)} where no text or number can be made of the value, `
      + `${n(/(^| )engine: /) - n(/(^| )engine: Cannot convert object to primitive value$/)} where the engine fails otherwise, ${n(/(^| )refused: /)} refused in the reference's words`; };
  console.log(`  table, ${UNWRITABLE.length} values — engine ${contexts.length} contexts × ${enginePositions.length} positions: ${kinds(engineTable)}`);
  console.log(`    by value: ${UNWRITABLE.map(([name], i) => `${name}: ${engineTable.flat().filter((row) => /^engine: Cannot convert/.test(row[i])).length}`).join('; ')}`);
  console.log(`  table — policies ${policyPositions.length} positions: ${kinds(policyTable)}`);
  console.log(`  table — signatures ${signaturePositions.length} positions: ${kinds(signatureTable)}`);
  console.log(`  every one of the ${CODES.length} findings is made; the members each is made with:`);
  for (const code of CODES) console.log(`    ${code} ×${seen.get(code)}: ${[...members.get(code)].join(' | ')}`);
  console.log('  cases that turn on a spelling of a time Rules does not read (reference → Rules):');
  for (const c of engine.filter((x) => x.reference)) {
    const codes = (r) => r.findings.map((f) => f.code);
    const gone = codes(c.reference).filter((x) => !codes(c.result).includes(x));
    const come = codes(c.result).filter((x) => !codes(c.reference).includes(x));
    console.log(`    ${c.name}: ${gone.join(', ') || '(nothing)'} → ${come.join(', ') || '(nothing)'}`);
  }
}
