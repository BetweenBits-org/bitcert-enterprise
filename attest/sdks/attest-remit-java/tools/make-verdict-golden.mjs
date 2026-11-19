/**
 * Writes the vectors the Java SDK's six-axis re-evaluation (`VerdictEngine`)
 * is held to: what the reference — `evaluate` and `verifyEvidenceSignatures`
 * of `packages/attest-rules`, and `verifyEvidencePackage` of
 * `packages/attest-remit`, read here and never written — answers.
 *
 *   node sdks/attest-remit-java/tools/make-verdict-golden.mjs          write src/test/resources/golden/verdict.json
 *   node sdks/attest-remit-java/tools/make-verdict-golden.mjs --check  fail when the file on disk differs
 *
 * Nothing here signs anything, so the output is the same on every run: the
 * signatures in the vectors are the ones the rules package's fixtures and a
 * sandbox evidence package already carry (all of it synthetic).
 *
 * A case is a base document and a list of changes to it — `{ at: [path], set }`
 * or `{ at: [path], unset: true }`, applied in order — so that what a case is
 * about can be read off the file. The sections:
 *
 *   engine      { evidence, policy } → the six axis states and every finding
 *               as "axis:code:severity", in order — or `threw`
 *   signatures  { evidence, registry } → the signature of every signable
 *               element after the signature pass — or `threw`
 *   packages    an evidence response → the reference verifier's `signatures`
 *               and `verdict` checks, `{ ok, detail }` — or `threw`
 *   dates       text → Date.parse, with the form it is written in
 *   parties     two names → equal under "normalized" matching, or not
 */
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORRIDOR_SCENARIOS, DEMO_KEYRING, SCENARIOS, evaluate, keyring, partyEquals, verifyEvidenceSignatures,
} from '../../../packages/attest-rules/src/index.ts';
import { verifyEvidencePackage } from '../../../packages/attest-remit/src/verify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(HERE, '../../../packages/attest-rules');
const OUT = path.resolve(HERE, '../src/test/resources/golden/verdict.json');
const check = process.argv.includes('--check');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** One change to a document: put a value at a path, or take the member there away. */
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

// ── The base documents ─────────────────────────────────────────────────────

const sandbox = read(path.resolve(HERE, '../src/test/resources/evidence/sandbox-anchored.json'));
/** The registry, cut down to the institutions whose keys this package's signatures name. */
const signers = new Set(Object.values(sandbox.package.evidence.elements)
  .flatMap((v) => (Array.isArray(v) ? v : [v])).map((x) => x.signature?.keyId).filter(Boolean));
const registry = sandbox.package.trust_registry.institutions.filter((i) => signers.has(i.id))
  .map(({ id, name, signing_spki }) => ({ id, name, signing_spki }));
if (registry.length !== signers.size) throw new Error('the sandbox package names a signer its registry does not hold');

const bases = {
  // A real settlement of the sandbox corridor: six elements, every signature valid, every control on.
  sandbox: { evidence: sandbox.package.evidence, policy: sandbox.package.policy, registry },
  // The same as an evidence response, without what the two checks do not read.
  response: {
    package: {
      schema: sandbox.package.schema, payment_id: sandbox.package.payment_id,
      evidence: sandbox.package.evidence, policy: sandbox.package.policy, verdict: sandbox.package.verdict,
      trust_registry: { institutions: registry },
    },
    commitment: sandbox.commitment,
    attestation: null,
  },
};

// ── engine ─────────────────────────────────────────────────────────────────

const stateOf = (r) => ({
  states: Object.fromEntries(Object.entries(r.axes).map(([k, v]) => [k, v.state])),
  findings: r.findings.map((f) => `${f.axis}:${f.code}:${f.severity}`),
});
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const engine = [];
function engineCase(name, base, ops = []) {
  unique('engine', name);
  const doc = apply(base, ops);
  engine.push({ name, ...(typeof base.name === 'string' ? { base: base.name, ops } : { evidence: doc.evidence, policy: doc.policy }),
    expected: attempt(() => stateOf(evaluate(doc.evidence, doc.policy))) });
}

// The rules package's own scenarios, signatures verified against its demonstration keys.
const tradeBase = read(path.join(RULES, 'fixtures/a-normal-trade-payment.json'));
const tradePolicy = read(path.join(RULES, 'policies/settlement-match-v1.json'));
for (const s of SCENARIOS) {
  engineCase(`trade scenario ${s.id}: ${s.title}`,
    { evidence: await verifyEvidenceSignatures(s.derive(tradeBase), DEMO_KEYRING), policy: tradePolicy });
}
engineCase('trade scenario A, its signatures never verified', { evidence: tradeBase, policy: tradePolicy });
const corridorBase = read(path.join(RULES, 'fixtures/corridor-vn-sg-normal.json'));
const corridorPolicy = read(path.join(RULES, 'policies/corridor-vn-sg-v1.json'));
for (const s of CORRIDOR_SCENARIOS) {
  engineCase(`corridor scenario ${s.id}: ${s.title}`,
    { evidence: await verifyEvidenceSignatures(s.derive(corridorBase), DEMO_KEYRING), policy: corridorPolicy });
}

// The sandbox settlement, and one thing changed at a time.
const SB = { name: 'sandbox', ...bases.sandbox };
const ev = (...p) => ['evidence', ...p];
const el = (...p) => ['evidence', 'elements', ...p];
const pol = (...p) => ['policy', ...p];
const sbx = (name, ...ops) => engineCase(name, SB, ops);
const live = set(ev('dataMode'), 'LIVE');
const E = bases.sandbox.evidence.elements;
const receipt0 = E.payoutReceipts[0];

sbx('the sandbox settlement as the platform evaluated it');

// Completeness
for (const k of Object.keys(E)) sbx(`no ${k}`, unset(el(k)));
sbx('payoutReceipts is an empty list', set(el('payoutReceipts'), []));
sbx('an element that is null', set(el('travelRule'), null));
sbx('a document cited but not attached', set(el('commercialDocs', 'citedOnly'), ['invoice']));
sbx('two documents cited but not attached', set(el('commercialDocs', 'citedOnly'), ['invoice', 'contract']));
sbx('citedOnly as text', set(el('commercialDocs', 'citedOnly'), 'ab'));
sbx('citedOnly as a number', set(el('commercialDocs', 'citedOnly'), 5));
sbx('citedOnly null', set(el('commercialDocs', 'citedOnly'), null));
sbx('nothing is required', set(pol('requiredElements'), []), set(pol('signatureRequiredElements'), []), unset(el('travelRule')));
sbx('an element is required that nobody knows', set(pol('requiredElements'), [...bases.sandbox.policy.requiredElements, 'customsDeclaration']));
sbx('a required element that is not a name', set(pol('requiredElements'), [...bases.sandbox.policy.requiredElements, 7]));
sbx('no elements at all', unset(ev('elements')));
sbx('elements null', set(ev('elements'), null));

// Integrity
sbx('a digest that does not match', set(el('bankInstruction', 'digestVerified'), false));
sbx('two digests that do not match', set(el('bankInstruction', 'digestVerified'), false), set(el('payoutReceipts', 0, 'digestVerified'), false));
sbx('a digest nobody checked', unset(el('commercialDocs', 'digestVerified')));
sbx('a digest declared null and not checked', unset(el('commercialDocs', 'digestVerified')), set(el('commercialDocs', 'digest'), null));
sbx('digestVerified as text', set(el('commercialDocs', 'digestVerified'), 'true'));
sbx('nothing was checked', ...Object.keys(E).flatMap((k) => (Array.isArray(E[k])
  ? E[k].map((_, i) => unset(el(k, i, 'digestVerified'))) : [unset(el(k, 'digestVerified'))])));
sbx('nothing was checked and nothing declares a digest', ...Object.keys(E).flatMap((k) => (Array.isArray(E[k])
  ? E[k].flatMap((_, i) => [unset(el(k, i, 'digestVerified')), unset(el(k, i, 'digest'))]) : [unset(el(k, 'digestVerified')), unset(el(k, 'digest'))])));

// Issuer
sbx('a signature that is not there', unset(el('bankInstruction', 'signature')));
sbx('a signature that is not there, on an element that need not be signed',
  unset(el('bankInstruction', 'signature')), set(pol('signatureRequiredElements'), ['payoutReceipts']));
sbx('a signature declared absent', set(el('bankInstruction', 'signature'), { status: 'ABSENT', checked: true }));
sbx('a signature that is null', set(el('bankInstruction', 'signature'), null));
sbx('a signature that is text', set(el('bankInstruction', 'signature'), 'signed'));
sbx('a signature nobody verified', unset(el('bankInstruction', 'signature', 'checked')));
sbx('checked as text', set(el('bankInstruction', 'signature', 'checked'), 'true'));
sbx('a signature under a key nobody holds', set(el('travelRule', 'signature', 'status'), 'UNKNOWN_KEY'), unset(el('travelRule', 'signature', 'trustLevel')));
sbx('a signature that does not verify', set(el('chainTransfer', 'signature', 'status'), 'INVALID'));
sbx('a signature that verifies under a demonstration key', set(el('commercialDocs', 'signature', 'status'), 'DEMO_VALID'), set(el('commercialDocs', 'signature', 'trustLevel'), 'DEMO'));
sbx('a trust level nobody knows', set(el('commercialDocs', 'signature', 'trustLevel'), 'PLATINUM'));
sbx('no trust level', unset(el('commercialDocs', 'signature', 'trustLevel')));
sbx('the policy asks for accredited issuers', set(pol('sourceTrustLevel'), 'ACCREDITED'));
sbx('the policy asks for accredited issuers, and they are', set(pol('sourceTrustLevel'), 'ACCREDITED'),
  ...Object.keys(E).flatMap((k) => (Array.isArray(E[k]) ? E[k].map((_, i) => set(el(k, i, 'signature', 'trustLevel'), 'ACCREDITED'))
    : [set(el(k, 'signature', 'trustLevel'), 'ACCREDITED')])));
sbx('the policy takes demonstration issuers', set(pol('sourceTrustLevel'), 'DEMO'));
sbx('no signature anywhere, and none required', set(pol('signatureRequiredElements'), []),
  ...Object.keys(E).flatMap((k) => (Array.isArray(E[k]) ? E[k].map((_, i) => unset(el(k, i, 'signature'))) : [unset(el(k, 'signature'))])));
sbx('a status nobody knows, verified', set(el('commercialDocs', 'signature', 'status'), 'FINE'));

// Matching — amounts
sbx('no bank instruction', unset(el('bankInstruction')));
sbx('no bank instruction, and receipts that are not a list', unset(el('bankInstruction')), set(el('payoutReceipts'), { ref: 'x' }));
sbx('no bank instruction, and receipts that are text', unset(el('bankInstruction')), set(el('payoutReceipts'), 'receipts'));
sbx('receipts that are not a list', set(el('payoutReceipts'), { ref: 'x' }));
sbx('the chain transfer is a cent short', set(el('chainTransfer', 'amount'), '2499.99'));
sbx('a cent short, within an absolute tolerance', set(el('chainTransfer', 'amount'), '2499.99'), set(pol('amountTolerance'), '0.01'));
sbx('a cent short, with a tolerance a hair too small', set(el('chainTransfer', 'amount'), '2499.99'), set(pol('amountTolerance'), '0.009'));
sbx('a quarter short, within one basis point', set(el('chainTransfer', 'amount'), '2499.75'), set(pol('amountToleranceBps'), 1));
sbx('26 cents short, outside one basis point', set(el('chainTransfer', 'amount'), '2499.74'), set(pol('amountToleranceBps'), 1));
sbx('one basis point of an amount that does not divide: rounded up', set(el('bankInstruction', 'amount'), '2500.01'),
  set(el('chainTransfer', 'amount'), '2499.75'), set(el('payoutReceipts', 0, 'amount'), '2500.01'), set(el('commercialDocs', 'amount'), '2500.01'), set(pol('amountToleranceBps'), 1));
sbx('the same, a cent further out', set(el('bankInstruction', 'amount'), '2500.01'),
  set(el('chainTransfer', 'amount'), '2499.74'), set(el('payoutReceipts', 0, 'amount'), '2500.01'), set(el('commercialDocs', 'amount'), '2500.01'), set(pol('amountToleranceBps'), 1));
sbx('short by a fee the policy lets be deducted', set(el('payoutReceipts', 0, 'amount'), '2497.50'), set(pol('fees'), { deductible: true, maxBps: 10 }));
sbx('short by more than that fee', set(el('payoutReceipts', 0, 'amount'), '2497.49'), set(pol('fees'), { deductible: true, maxBps: 10 }));
sbx('a fee cap that is not deductible widens nothing', set(el('payoutReceipts', 0, 'amount'), '2497.50'), set(pol('fees'), { deductible: false, maxBps: 10 }));
sbx('tolerance and fee together', set(el('payoutReceipts', 0, 'amount'), '2497.00'), set(pol('amountTolerance'), '0.5'), set(pol('fees'), { deductible: true, maxBps: 10 }));
sbx('the receipt differs', set(el('payoutReceipts', 0, 'amount'), '2500.10'));
sbx('the invoice differs', set(el('commercialDocs', 'amount'), '2400.00'));
sbx('the invoice states no amount', unset(el('commercialDocs', 'amount')));
sbx('the same amount written three ways', set(el('chainTransfer', 'amount'), '2500'), set(el('payoutReceipts', 0, 'amount'), '2500.0'), set(el('commercialDocs', 'amount'), '2500.000'));
sbx('an amount with spaces and a plus sign', set(el('chainTransfer', 'amount'), ' +2500.00\n'), set(el('commercialDocs', 'amount'), ' 2500.00﻿'));
sbx('a negative amount', set(el('chainTransfer', 'amount'), '-2500.00'));
sbx('an amount with a thousands separator', set(el('chainTransfer', 'amount'), '2,500.00'));
sbx('an amount in exponent notation', set(el('chainTransfer', 'amount'), '2.5e3'));
sbx('an amount that is a number', set(el('bankInstruction', 'amount'), 2500));
sbx('an amount that is null', set(el('commercialDocs', 'amount'), null));
sbx('an empty amount', set(el('payoutReceipts', 0, 'amount'), ''));
sbx('an amount with digits of another script', set(el('chainTransfer', 'amount'), '٢٥٠٠.00'));
sbx('an amount followed by a line break and more', set(el('chainTransfer', 'amount'), '2500.00\n1'));
sbx('very many decimals', set(el('chainTransfer', 'amount'), '2500.000000000000000000000000000001'));
sbx('very many decimals, exactly equal', set(el('chainTransfer', 'amount'), '2500.000000000000000000000000000000'));

// Matching — currencies
sbx('a currency the policy does not permit', set(el('payoutReceipts', 0, 'currency'), 'EUR'));
sbx('a currency that is not stated', unset(el('chainTransfer', 'currency')));
sbx('two units of account and no FX reference', set(pol('unitOfAccountGroups'), []), set(pol('fxReference'), null));
sbx('two units of account and an FX reference', set(pol('unitOfAccountGroups'), []));
sbx('one unit of account, each code in its own group', set(pol('unitOfAccountGroups'), [['USD'], ['USDC']]), set(pol('fxReference'), null));
sbx('everything in one currency, no groups needed', set(pol('unitOfAccountGroups'), []), set(pol('fxReference'), null), set(el('chainTransfer', 'currency'), 'USD'));

// Matching — receipts
const second = { ...receipt0, ref: `${receipt0.ref}-2`, amount: '1000.00' };
sbx('two receipts where the policy allows none', set(el('payoutReceipts', 0, 'amount'), '1500.00'), set(el('payoutReceipts', 1), second));
sbx('two receipts, allowed but not added up', set(el('payoutReceipts', 0, 'amount'), '1500.00'), set(el('payoutReceipts', 1), second),
  set(pol('splitPayments'), { allowed: true, aggregate: false }));
sbx('two receipts that add up', set(el('payoutReceipts', 0, 'amount'), '1500.00'), set(el('payoutReceipts', 1), second),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('two receipts that do not add up', set(el('payoutReceipts', 0, 'amount'), '1500.01'), set(el('payoutReceipts', 1), second),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('two receipts, one not a decimal, where splits are not allowed', set(el('payoutReceipts', 1), { ...second, amount: 'n/a' }));
sbx('two receipts, one not a decimal, where they are added up', set(el('payoutReceipts', 1), { ...second, amount: 'n/a' }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('the same receipt twice', set(el('payoutReceipts', 1), receipt0));
sbx('the same receipt twice, where splits are added up', set(el('payoutReceipts', 1), receipt0), set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('the same receipt three times', set(el('payoutReceipts', 1), receipt0), set(el('payoutReceipts', 2), receipt0));
sbx('two receipts without a reference', set(el('payoutReceipts', 0, 'ref'), ''), set(el('payoutReceipts', 1), { ...receipt0, ref: '' }),
  set(pol('splitPayments'), { allowed: true, aggregate: true }));
sbx('a receipt that is null', set(el('payoutReceipts', 0), null));
sbx('a receipt that is text', set(el('payoutReceipts', 0), 'paid'));

// Matching — references and parties
sbx('the instruction does not cite the invoice', set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('the instruction is the invoice by reference', set(el('commercialDocs', 'invoiceRef'), E.bankInstruction.ref), set(el('bankInstruction', 'iso20022Fields'), []));
sbx('no invoice reference', unset(el('commercialDocs', 'invoiceRef')));
sbx('no instruction reference', unset(el('bankInstruction', 'ref')));
sbx('no ISO field names, and another invoice', unset(el('bankInstruction', 'iso20022Fields')), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('ISO field names that are text', set(el('bankInstruction', 'iso20022Fields'), 'Dbtr Cdtr'), set(el('commercialDocs', 'invoiceRef'), 'INV-OTHER'));
sbx('the buyer is someone else', set(el('commercialDocs', 'buyer'), 'Hanoi Export Co., Ltd.'));
sbx('the seller is someone else', set(el('commercialDocs', 'seller'), 'Lion City Imports Pte. Ltd.'));
sbx('the same parties, written another way', set(el('commercialDocs', 'buyer'), 'SAIGON IMPORT COMPANY LIMITED'.replace('COMPANY LIMITED', 'co ltd')),
  set(el('commercialDocs', 'seller'), '  Lion City Exports   (PTE) LIMITED '));
sbx('the same parties written another way, matched exactly', set(pol('partyIDMatch'), 'exact'),
  set(el('commercialDocs', 'buyer'), 'Saigon Import Co Ltd'));
sbx('no parties on the instruction', unset(el('bankInstruction', 'debtor')), unset(el('bankInstruction', 'creditor')));
sbx('a party that is not text', set(el('commercialDocs', 'buyer'), 7));
sbx('a party that is not text, matched exactly', set(el('commercialDocs', 'buyer'), 7), set(pol('partyIDMatch'), 'exact'));

// Matching — the settlement window
const approved = E.bankInstruction.approvedAt;
const at = (ms) => new Date(Date.parse(approved) + ms).toISOString();
sbx('the funds moved before the instruction was approved', set(el('chainTransfer', 'observedAt'), at(-1)));
sbx('the funds moved at the moment of approval', set(el('chainTransfer', 'observedAt'), at(0)), set(el('travelRule', 'approvedAt'), at(0)));
sbx('settled exactly at the end of the window', set(el('chainTransfer', 'observedAt'), at(2 * 86400000)), set(pol('enforceFxQuoteWindow'), false));
sbx('settled a millisecond past the window', set(el('chainTransfer', 'observedAt'), at(2 * 86400000 + 1)), set(pol('enforceFxQuoteWindow'), false));
sbx('a window of an hour and a half', set(pol('settlementWindow'), 'PT90M'), set(el('chainTransfer', 'observedAt'), at(90 * 60000 + 1)), set(pol('enforceFxQuoteWindow'), false));
sbx('a window of a day and twelve hours and thirty seconds', set(pol('settlementWindow'), 'P1DT12H30S'), set(el('chainTransfer', 'observedAt'), at(36 * 3600000 + 30000)), set(pol('enforceFxQuoteWindow'), false));
sbx('a window of no time at all', set(pol('settlementWindow'), 'P'));
sbx('no approval time', unset(el('bankInstruction', 'approvedAt')));
sbx('no transfer time, and the receipt has one', unset(el('chainTransfer', 'observedAt')));
sbx('a transfer time that is null, and the receipt has one', set(el('chainTransfer', 'observedAt'), null));
sbx('an empty transfer time', set(el('chainTransfer', 'observedAt'), ''));
sbx('no times at all', unset(el('chainTransfer', 'observedAt')), unset(el('payoutReceipts', 0, 'paidAt')));
sbx('no times and no chain transfer', unset(el('chainTransfer')), unset(el('payoutReceipts', 0, 'paidAt')));
sbx('a time that is no date', set(el('chainTransfer', 'observedAt'), 'not-a-date'));
sbx('an approval time that is no date', set(el('bankInstruction', 'approvedAt'), 'soon'));
sbx('times as dates alone', set(el('bankInstruction', 'approvedAt'), '2026-11-17'), set(el('chainTransfer', 'observedAt'), '2026-11-18'),
  set(el('travelRule', 'approvedAt'), '2026-11-17'), set(pol('enforceFxQuoteWindow'), false));
sbx('a time in another zone', set(el('chainTransfer', 'observedAt'), new Date(Date.parse(E.chainTransfer.observedAt)).toISOString().replace('Z', '+00:00')));
sbx('a day past the end of its month', set(el('bankInstruction', 'approvedAt'), '2026-02-30T00:00:00Z'), set(el('chainTransfer', 'observedAt'), '2026-03-03T00:00:00Z'),
  set(el('travelRule', 'approvedAt'), '2026-03-02T00:00:00Z'), set(pol('enforceFxQuoteWindow'), false), set(pol('settlementWindow'), 'P1D'));
sbx('a second that does not exist', set(el('chainTransfer', 'observedAt'), '2026-11-18T03:03:60Z'));

// Corridor — one id across every layer
sbx('no settlement id', unset(ev('settlementId')));
sbx('an empty settlement id', set(ev('settlementId'), ''));
sbx('no settlement id, and none asked for', unset(ev('settlementId')), set(pol('settlementIdRequiredIn'), []));
sbx('the instruction does not cite the id', set(el('bankInstruction', 'ref'), 'OUT-1'));
sbx('the chain carries the id in its transaction reference', unset(el('chainTransfer', 'settlementIdMemo')),
  set(el('chainTransfer', 'txRef'), `0xabc-${bases.sandbox.evidence.settlementId}`));
sbx('the chain does not carry the id', unset(el('chainTransfer', 'settlementIdMemo')));
sbx('the id is asked of the invoice and the Travel Rule too', set(pol('settlementIdRequiredIn'), [...bases.sandbox.policy.settlementIdRequiredIn, 'commercialDocs', 'travelRule']));
sbx('the id is asked of a name every object answers to', set(pol('settlementIdRequiredIn'), ['constructor']));
sbx('a reference that is a number where the id is looked for', set(el('bankApproval', 'approvalRef'), 12));
sbx('no receipt to cite the id', set(el('payoutReceipts'), []));

// Corridor — Travel Rule
sbx('no Travel Rule exchange, and none asked for', unset(el('travelRule')), set(pol('requireTravelRulePreflight'), false),
  set(pol('requiredElements'), bases.sandbox.policy.requiredElements.filter((k) => k !== 'travelRule')),
  set(pol('signatureRequiredElements'), bases.sandbox.policy.signatureRequiredElements.filter((k) => k !== 'travelRule')));
sbx('the Travel Rule exchange is pending', set(el('travelRule', 'approvalStatus'), 'PENDING'), unset(el('travelRule', 'approvalDigest')), unset(el('travelRule', 'approvedAt')));
sbx('the Travel Rule exchange was rejected', set(el('travelRule', 'approvalStatus'), 'REJECTED'));
sbx('an approval with no signed callback', unset(el('travelRule', 'approvalDigest')));
sbx('the funds moved before the approval', set(el('travelRule', 'approvedAt'), at(10 * 60000)));
sbx('an approval with no time', unset(el('travelRule', 'approvedAt')));
sbx('a Travel Rule approval time that is no date', set(el('travelRule', 'approvedAt'), 'soon'));
sbx('paid to an address the counterparty did not approve', set(el('travelRule', 'approvedBeneficiaryAddress'), '0x0000000000000000000000000000000000000001'));
sbx('the approved address in another case', set(el('travelRule', 'approvedBeneficiaryAddress'), E.travelRule.approvedBeneficiaryAddress.toUpperCase()));
sbx('no approved address', unset(el('travelRule', 'approvedBeneficiaryAddress')));
sbx('a Travel Rule exchange that is text', set(el('travelRule'), 'exchanged'));

// Corridor — the FX quote window
sbx('settled after the quote expired', set(el('bankApproval', 'fxQuote', 'validUntil'), at(1)));
sbx('settled at the moment the quote expires', set(el('bankApproval', 'fxQuote', 'validUntil'), E.chainTransfer.observedAt));
sbx('a quote made after the transfer it priced', set(el('bankApproval', 'fxQuote', 'quotedAt'), at(3600000)));
sbx('the quote window is not enforced', set(el('bankApproval', 'fxQuote', 'validUntil'), at(1)), set(pol('enforceFxQuoteWindow'), false));
sbx('no FX quote', unset(el('bankApproval', 'fxQuote')));
sbx('a quote with no expiry', unset(el('bankApproval', 'fxQuote', 'validUntil')));
sbx('a quote whose expiry is no date', set(el('bankApproval', 'fxQuote', 'validUntil'), 'later'));
sbx('a quote, and a transfer time that is no date', set(el('chainTransfer', 'observedAt'), 'not-a-date'), set(el('bankApproval', 'fxQuote', 'validUntil'), 'later'));

// Corridor — refunds
sbx('a refund with no original', set(ev('refundReasonCode'), 'DOCS_INSUFFICIENT'));
sbx('pointing at an original, with no reason', set(ev('relatedSettlementId'), 'PAY-20261117-0000000001'));
sbx('a refund with its original and its reason', set(ev('refundReasonCode'), 'DOCS_INSUFFICIENT'), set(ev('relatedSettlementId'), 'PAY-20261117-0000000001'));

// Regulatory mapping and business finality — only real data can satisfy them
sbx('live data, everything supplied', live);
sbx('live data, no purpose', live, unset(ev('purpose')));
sbx('live data, an empty purpose and no jurisdiction', live, set(ev('purpose'), ''), unset(ev('jurisdiction')));
sbx('live data, a checklist of nothing', live, set(pol('regulatoryFields'), []));
sbx('live data, a checklist asking for more', live, set(pol('regulatoryFields'), [...bases.sandbox.policy.regulatoryFields, 'lei', 3]));
sbx('live data, no ISO field names', live, set(el('bankInstruction', 'iso20022Fields'), []));
sbx('live data, a receipt whose signature does not verify', live, set(el('payoutReceipts', 0, 'signature', 'status'), 'INVALID'));
sbx('live data, a receipt signed under a demonstration key', live, set(el('payoutReceipts', 0, 'signature', 'status'), 'DEMO_VALID'), set(el('payoutReceipts', 0, 'signature', 'trustLevel'), 'DEMO'));
sbx('live data, a receipt nobody verified', live, unset(el('payoutReceipts', 0, 'signature', 'checked')));
sbx('live data, no receipt', live, set(el('payoutReceipts'), []));
sbx('live data, an unsigned receipt', live, unset(el('payoutReceipts', 0, 'signature')));
sbx('a data mode nobody knows', set(ev('dataMode'), 'TEST'));

// Policies the engine refuses to run
const badPolicy = (name, ...ops) => sbx(`policy: ${name}`, ...ops);
badPolicy('no version', set(pol('policyVersion'), ''));
badPolicy('no currencies', set(pol('currencies'), []));
badPolicy('a currency in two groups', set(pol('unitOfAccountGroups'), [['USD', 'USDC'], ['USD']]));
badPolicy('a group naming a currency that is not permitted', set(pol('unitOfAccountGroups'), [['USD', 'EUR']]));
badPolicy('an empty group', set(pol('unitOfAccountGroups'), [[]]));
badPolicy('a tolerance that is not a decimal', set(pol('amountTolerance'), 'none'));
badPolicy('a tolerance that is a number', set(pol('amountTolerance'), 0));
badPolicy('negative basis points', set(pol('amountToleranceBps'), -1));
badPolicy('half a basis point', set(pol('amountToleranceBps'), 0.5));
badPolicy('basis points as text', set(pol('amountToleranceBps'), '1'));
badPolicy('no FX reference member', unset(pol('fxReference')));
badPolicy('a window in months', set(pol('settlementWindow'), 'P1M'));
badPolicy('a window in words', set(pol('settlementWindow'), '2 days'));
badPolicy('a window followed by a line break', set(pol('settlementWindow'), 'P2D\n'));
badPolicy('no fees', unset(pol('fees')));
badPolicy('a fee cap that is not whole', set(pol('fees'), { deductible: true, maxBps: 2.5 }));
badPolicy('no split rule', unset(pol('splitPayments')));
badPolicy('a split rule without aggregate', set(pol('splitPayments'), { allowed: true }));
badPolicy('a party match nobody knows', set(pol('partyIDMatch'), 'fuzzy'));
badPolicy('a trust level nobody knows', set(pol('sourceTrustLevel'), 'HIGH'));
badPolicy('required elements that are not a list', set(pol('requiredElements'), 'all'));
badPolicy('an element to be signed that need not be supplied', set(pol('requiredElements'), ['bankInstruction']));
badPolicy('no Travel Rule switch', unset(pol('requireTravelRulePreflight')));
badPolicy('a quote-window switch that is text', set(pol('enforceFxQuoteWindow'), 'true'));
badPolicy('no list of where the id is carried', unset(pol('settlementIdRequiredIn')));
badPolicy('no checklist', unset(pol('regulatoryFields')));
sbx('policy: none at all', unset(['policy']));
sbx('basis points written with a decimal point', set(pol('amountToleranceBps'), 1.0), set(el('chainTransfer', 'amount'), '2499.75'));

// ── signatures ─────────────────────────────────────────────────────────────

/** The keyring the reference verifier makes of a package's registry (verify.ts). */
const ringOf = (institutions) => keyring(institutions.filter((i) => i.signing_spki).map((i) => ({
  keyId: i.id, issuer: i.name, trustLevel: 'ATTESTED',
  publicKeyJwk: createPublicKey({ key: Buffer.from(i.signing_spki, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' }),
})));
const signaturesOf = (evidence) => Object.fromEntries(Object.entries(evidence.elements)
  .map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' && 'signature' in x ? x.signature : 'none'))]));
const signatures = [];
const SG = { name: 'sandbox', evidence: bases.sandbox.evidence, registry: bases.sandbox.registry };
async function sig(name, ...ops) {
  unique('signatures', name);
  const doc = apply(SG, ops);
  let expected;
  try { expected = { signatures: signaturesOf(await verifyEvidenceSignatures(doc.evidence, ringOf(doc.registry))) }; }
  catch (e) { expected = { threw: String(e?.message ?? e) }; }
  signatures.push({ name, base: 'sandbox', ops, expected });
}
const reg = (...p) => ['registry', ...p];
const bankKey = E.bankInstruction.signature.keyId;
const bankAt = registry.findIndex((i) => i.id === bankKey);
const value = E.bankInstruction.signature.value;
const standard = Buffer.from(value, 'base64url').toString('base64');     // the same bytes in the standard alphabet, padded
const P384 = 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEtBTz2MUAjVytNNvkDFEzfnN2NP3F52CG/esSlte0EEcZoB9zJ1CJkW13ZZ5oJw77Nc1gavdpo/2XMC6IL2Hh7s1ihdcuGmHhpdLJwZagUzLiCGeegc61fNvmLvyYOvhw';
const P256K = 'MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEyaeLzYRedlLh+3gTPXeNlulEtNvuFksCGevL+lXWqIA5rz+bwVecJvDBHYbqsFPLTLHqQVKEVmegoZ6XWfiBVg==';
const ED25519 = 'MCowBQYDK2VwAyEAY0FGd1FX6rrwLDNTz52DSxMa7cvoJBeucGzr99R3/V4=';

await sig('every signature as issued');
await sig('what the document says of its signatures carries no weight',
  set(el('bankInstruction', 'signature', 'status'), 'INVALID'), set(el('bankInstruction', 'signature', 'trustLevel'), 'ACCREDITED'),
  set(el('bankInstruction', 'signature', 'issuer'), 'Somebody Else'), unset(el('bankInstruction', 'signature', 'checked')),
  set(el('commercialDocs', 'signature', 'algorithm'), 'RS256'));
await sig('the amount changed after signing', set(el('bankInstruction', 'amount'), '9999999.00'));
await sig('a member added after signing', set(el('bankInstruction', 'note'), 'urgent'));
await sig('the members outside the signature changed', set(el('commercialDocs', 'attached'), []), set(el('commercialDocs', 'citedOnly'), ['invoice']),
  set(el('commercialDocs', 'digestVerified'), false));
await sig('the digest changed after signing', set(el('commercialDocs', 'digest'), '0'.repeat(64)));
await sig('one character of the signature changed', set(el('bankInstruction', 'signature', 'value'), (value[10] === 'A' ? 'B' : 'A').padStart(11, value.slice(0, 10)) + value.slice(11)));
await sig('the signature in the standard alphabet, padded', set(el('bankInstruction', 'signature', 'value'), standard));
await sig('the signature with padding it does not need', set(el('bankInstruction', 'signature', 'value'), `${value}==`));
await sig('the signature with one padding character too many', set(el('bankInstruction', 'signature', 'value'), `${value}===`));
await sig('the signature with a line break in it', set(el('bankInstruction', 'signature', 'value'), `${value.slice(0, 44)}\n${value.slice(44)}`));
await sig('the signature with a space at the end', set(el('bankInstruction', 'signature', 'value'), `${value} `));
await sig('the signature cut short', set(el('bankInstruction', 'signature', 'value'), value.slice(0, -4)));
await sig('the signature twice over', set(el('bankInstruction', 'signature', 'value'), value + value));
await sig('a signature that is not base64', set(el('bankInstruction', 'signature', 'value'), '*'.repeat(86)));
await sig('a signature of one character', set(el('bankInstruction', 'signature', 'value'), 'A'));
await sig('an empty signature', set(el('bankInstruction', 'signature', 'value'), ''));
await sig('no signature bytes', unset(el('bankInstruction', 'signature', 'value')));
await sig('signature bytes that are null', set(el('bankInstruction', 'signature', 'value'), null));
await sig('signature bytes that are a number', set(el('bankInstruction', 'signature', 'value'), 12345));
await sig('declared absent, bytes and all', set(el('bankInstruction', 'signature', 'status'), 'ABSENT'));
await sig('no key named', unset(el('bankInstruction', 'signature', 'keyId')));
await sig('no key named and no bytes', unset(el('bankInstruction', 'signature', 'keyId')), unset(el('bankInstruction', 'signature', 'value')));
await sig('a key nobody holds', set(el('bankInstruction', 'signature', 'keyId'), 'VN-BANK-NOBODY'));
await sig('a key id that is a number', set(el('bankInstruction', 'signature', 'keyId'), 7));
await sig('a key id that is a number, and no bytes', set(el('bankInstruction', 'signature', 'keyId'), 7), unset(el('bankInstruction', 'signature', 'value')));
await sig('another institution named as the signer', set(el('bankInstruction', 'signature', 'keyId'), E.travelRule.signature.keyId));
await sig('a signature that is null', set(el('bankInstruction', 'signature'), null));
await sig('a signature that is text', set(el('bankInstruction', 'signature'), 'signed'));
await sig('a signature that is a list', set(el('bankInstruction', 'signature'), []));
await sig('a signature that is a number', set(el('bankInstruction', 'signature'), 1));
await sig('an element with no signature member', unset(el('bankInstruction', 'signature')));
await sig('an element that is not one', set(el('bankInstruction'), 'instruction'));
await sig('an element that is null', set(el('travelRule'), null));
await sig('a second receipt, changed', set(el('payoutReceipts', 1), { ...receipt0, amount: '1.00' }));
await sig('a receipt that is null, and one that is text', set(el('payoutReceipts', 1), null), set(el('payoutReceipts', 2), 'paid'));
await sig('an element nobody knows, claiming a valid signature', set(el('customsDeclaration'), { ref: 'CD-1', signature: { status: 'VALID', keyId: bankKey, value } }));
await sig('the bank is not in the registry', unset(reg(bankAt)));
await sig('the bank has no key in the registry', set(reg(bankAt, 'signing_spki'), null));
await sig('the registry holds another key for the bank', set(reg(bankAt, 'signing_spki'), registry[(bankAt + 1) % registry.length].signing_spki));
await sig('the registry holds a P-384 key for the bank', set(reg(bankAt, 'signing_spki'), P384));
await sig('the registry holds a secp256k1 key for the bank', set(reg(bankAt, 'signing_spki'), P256K));
await sig('the registry holds an Ed25519 key for the bank', set(reg(bankAt, 'signing_spki'), ED25519));
await sig('the registry holds something that is no key', set(reg(bankAt, 'signing_spki'), 'AAAA'));
await sig('the registry key with line breaks in it', set(reg(bankAt, 'signing_spki'), registry[bankAt].signing_spki.replace(/(.{40})/g, '$1\n')));
await sig('the registry key in the URL-safe alphabet', set(reg(bankAt, 'signing_spki'), Buffer.from(registry[bankAt].signing_spki, 'base64').toString('base64url')));
await sig('the bank twice in the registry', set(reg(registry.length), registry[bankAt]));
await sig('an empty registry', set(['registry'], []));
await sig('no elements', unset(ev('elements')));

// ── packages: the reference verifier's two checks ──────────────────────────

const packages = [];
async function pkg(name, ...ops) {
  unique('packages', name);
  const doc = apply({ response: bases.response }, ops);
  let expected;
  try {
    const report = await verifyEvidencePackage(doc.response);
    expected = Object.fromEntries(report.checks.filter((c) => c.name === 'signatures' || c.name === 'verdict').map((c) => [c.name, { ok: c.ok, detail: c.detail }]));
  } catch (e) { expected = { threw: String(e?.message ?? e) }; }
  packages.push({ name, ops, expected });
}
const P = (...p) => ['response', 'package', ...p];
const PE = (...p) => ['response', 'package', 'evidence', 'elements', ...p];
await pkg('the package as the platform issued it');
await pkg('an amount changed in the package', set(PE('bankInstruction', 'amount'), '9999999.00'));
await pkg('a receipt changed in the package', set(PE('payoutReceipts', 0, 'amount'), '2499.00'));
await pkg('the platform verdict says something else', set(P('verdict', 'axes', 'matching', 'state'), 'MISMATCH'));
// The two verdicts are compared axis by axis: the same axes, each with the same state. The order the package lists
// them in is not compared — the commitment is over a canonical form that sorts members, so a file a tool has
// re-serialised, or a JSON column has stored, is the same package.
const AXES = sandbox.package.verdict.axes;
const reversed = Object.fromEntries(Object.entries(AXES).reverse());
const shuffled = Object.fromEntries(['matching', 'businessFinality', 'integrity', 'regulatoryMapping', 'issuer', 'completeness'].map((k) => [k, AXES[k]]));
if (Object.keys(shuffled).sort().join() !== Object.keys(AXES).sort().join()) throw new Error('the shuffled verdict does not name the axes of the sandbox verdict');
const stating = (state) => ({ state, findings: [] });
await pkg('the platform verdict lists its axes in another order', set(P('verdict', 'axes'), reversed));
await pkg('the platform verdict lists its axes in no order at all', set(P('verdict', 'axes'), shuffled));
await pkg('axes in another order, and one says something else', set(P('verdict', 'axes'), { ...reversed, matching: stating('MISMATCH') }));
await pkg('axes in another order, and one more', set(P('verdict', 'axes'), { extra: stating('VALID'), ...reversed }));
await pkg('axes in another order, and one less', set(P('verdict', 'axes'), Object.fromEntries(Object.entries(reversed).filter(([k]) => k !== 'issuer'))));
await pkg('axes in another order, and one without a state', set(P('verdict', 'axes'), { ...reversed, issuer: { findings: [] } }));
await pkg('the platform verdict has an axis more', set(P('verdict', 'axes', 'extra'), { state: 'VALID', findings: [] }));
await pkg('the platform verdict has an axis less', unset(P('verdict', 'axes', 'businessFinality')));
// Axes only the package has, named so that every way of putting text in order would list them differently: whole
// numbers (which an object lists first, by value), capitals, and characters on either side of the surrogates.
await pkg('axes more, of every kind of name', set(P('verdict', 'axes'), { zeta: stating('VALID'), '\uff21': stating('VALID'), '😀': stating('VALID'),
  Alpha: stating('VALID'), 10: stating('VALID'), 9: stating('VALID'), '': stating('VALID'), 'a"b\\c\n': stating('VALID'), ...reversed }));
await pkg('an axis more that states nothing', set(P('verdict', 'axes', 'extra'), { findings: [] }));
await pkg('an axis more that is text', set(P('verdict', 'axes', 'note'), 'for the record'));
await pkg('an axis more that is a list', set(P('verdict', 'axes', 'extra'), [stating('VALID')]));
await pkg('an axis more that is a number', set(P('verdict', 'axes', 'extra'), 0));
await pkg('axes more that state nothing, beside one that does, in another order', set(P('verdict', 'axes'), { zeta: {}, extra: stating('VALID'), 10: 'x', Alpha: [], ...reversed }));
await pkg('an axis more that states nothing, and one of the six without a state', set(P('verdict', 'axes', 'extra'), {}), unset(P('verdict', 'axes', 'issuer', 'state')));
// Named in the order of the names themselves, not of the names as JSON writes them (a line break sorts before a space; its escape does not).
await pkg('axes more that state nothing, named with a space and with a line break', set(P('verdict', 'axes', ' '), {}), set(P('verdict', 'axes', '\n'), {}), set(P('verdict', 'axes', '"'), {}));
await pkg('axes more that state something, named with a space and with a line break', set(P('verdict', 'axes', ' '), stating('VALID')), set(P('verdict', 'axes', '\n'), stating('VALID')),
  set(P('verdict', 'axes', '"'), stating('VALID')), set(P('verdict', 'axes', '\\'), stating('VALID')));
await pkg('an axis without a state', unset(P('verdict', 'axes', 'issuer', 'state')));
await pkg('an axis whose state is null', set(P('verdict', 'axes', 'issuer', 'state'), null));
await pkg('an axis that is text', set(P('verdict', 'axes', 'issuer'), 'VALID'));
await pkg('an axis that is a list', set(P('verdict', 'axes', 'issuer'), [stating('VALID')]));
await pkg('an axis that is null', set(P('verdict', 'axes', 'issuer'), null));
await pkg('an axis more that is null', set(P('verdict', 'axes', 'extra'), null));
// A state of another kind than text is no state the engine gives: shown as the JSON it is.
for (const [name, state] of [['a number', 7], ['a number with a fraction', 1.50], ['a very large number', 1e21], ['zero', 0], ['true', true], ['false', false],
  ['a list', ['VALID']], ['an empty list', []], ['an object', { b: 1, a: [1, { d: 1, c: 2 }], 10: 'x', 9: 'y' }], ['an empty object', {}], ['empty text', ''],
  ['the right word in lower case', 'valid'], ['the right word with a space after it', 'VALID '], ['text with characters JSON escapes', 'VA"LID\\ \n\u0001\u2028 \ud83d é 😀']]) {
  await pkg(`a state that is ${name}`, set(P('verdict', 'axes', 'issuer', 'state'), state));
}
await pkg('two states of another kind, in another order', set(P('verdict', 'axes'), { ...reversed, issuer: stating(-7), integrity: stating(null) }));
await pkg('a state that is the largest whole number a package can hold', set(P('verdict', 'axes', 'issuer', 'state'), 9007199254740991));
// Names that look like an axis and are not it.
await pkg('an axis named with a space after it, beside the real one', set(P('verdict', 'axes', 'issuer '), stating('VALID')));
await pkg('an axis named in capitals, in place of the real one', unset(P('verdict', 'axes', 'issuer')), set(P('verdict', 'axes', 'Issuer'), stating('VALID')));
await pkg('an axis named with an invisible character in it, in place of the real one', unset(P('verdict', 'axes', 'issuer')), set(P('verdict', 'axes', 'iss\u200buer'), stating('VALID')));
await pkg('two axes more whose names are one letter written two ways', set(P('verdict', 'axes', '\u00e9'), stating('VALID')), set(P('verdict', 'axes', 'e\u0301'), stating('VALID')));
await pkg('an axis named __proto__', set(P('verdict', 'axes'), JSON.parse(`{"__proto__":{"state":"VALID","findings":[]},${JSON.stringify(AXES).slice(1)}`)));
await pkg('an axis named __proto__ that states nothing', set(P('verdict', 'axes'), JSON.parse(`{"__proto__":{"findings":[]},${JSON.stringify(AXES).slice(1)}`)));
await pkg('axes named like the things every object has', set(P('verdict', 'axes', 'constructor'), stating('VALID')), set(P('verdict', 'axes', 'toString'), stating('VALID')));
await pkg('no verdict', unset(P('verdict')));
await pkg('a verdict without axes', unset(P('verdict', 'axes')));
await pkg('no policy', unset(P('policy')));
await pkg('a policy the engine refuses', set(P('policy', 'settlementWindow'), 'P1M'));
await pkg('a looser policy than the one the platform ran', set(P('policy', 'requireTravelRulePreflight'), false), unset(PE('travelRule', 'approvalDigest')));
await pkg('a signature that no longer verifies', set(PE('travelRule', 'approvalStatus'), 'PENDING'));
await pkg('the signer is gone from the registry', unset(P('trust_registry', 'institutions', bankAt)));
await pkg('the registry holds a P-384 key for the bank', set(P('trust_registry', 'institutions', bankAt, 'signing_spki'), P384));
await pkg('the registry holds something that is no key', set(P('trust_registry', 'institutions', bankAt, 'signing_spki'), 'AAAA'));
await pkg('the bank twice in the registry', set(P('trust_registry', 'institutions', registry.length), registry[bankAt]));
await pkg('no registry', unset(P('trust_registry')));
await pkg('a registry that is not a list', set(P('trust_registry', 'institutions'), {}));
await pkg('an element with no signature', unset(PE('commercialDocs', 'signature')));
await pkg('an element nobody knows, claiming a valid signature', set(PE('customsDeclaration'), { ref: 'CD-1', signature: { status: 'VALID', keyId: bankKey, value } }));
await pkg('no elements', set(PE(), {}));
await pkg('no evidence', unset(P('evidence')));
await pkg('a timestamp without a zone', set(PE('chainTransfer', 'observedAt'), E.chainTransfer.observedAt.replace('Z', '')));
await pkg('live data', set(P('evidence', 'dataMode'), 'LIVE'));
// A value the engine can make no text of — an object with a member of its own named toString, or a list holding
// one: the re-evaluation gives up there, as it does on anything it cannot read. (A member named valueOf alone is
// harmless; the rules vectors hold the whole table.)
await pkg('a currency that is an object with a member named toString', set(PE('chainTransfer', 'currency'), { toString: 1 }));
await pkg('a receipt currency that is a list holding such an object', set(PE('payoutReceipts', 0, 'currency'), ['USD', { toString: null }]));
await pkg('an invoice reference that is an object with members named toString and valueOf', set(PE('commercialDocs', 'invoiceRef'), { toString: 'x', valueOf: 2 }));
await pkg('a key id that is an object with a member named toString', set(PE('travelRule', 'signature', 'keyId'), { toString: 1 }));
await pkg('a settlement window that is an object with a member named toString', set(P('policy', 'settlementWindow'), { toString: 1 }));

// ── dates ──────────────────────────────────────────────────────────────────

const STANDARD = /^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const dates = [
  '2026-11-18T03:03:48.308Z', '2026-11-18T03:03:48Z', '2026-11-18T03:03Z', '2026-11-18T03:03:48.3Z', '2026-11-18T03:03:48.30Z',
  '2026-11-18T03:03:48.3089Z', '2026-11-18T03:03:48.123456789Z', '2026-11-18T10:03:48.308+07:00', '2026-11-17T20:03:48-07:00',
  '2026-11-18T03:03:48+00:00', '2026-11-18T03:03:48-00:00', '2026-11-18T03:03:48+23:59', '2026-11-18T03:03:48+24:00', '2026-11-18T03:03:48+07:60',
  '2026-11-18', '2026-11', '2026', '2026-02-29', '2026-02-30', '2024-02-29', '2026-04-31', '2026-12-31', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-32',
  '2026-11-17T24:00:00Z', '2026-11-17T24:00:00.000Z', '2026-11-17T24:00:00.001Z', '2026-11-17T24:00:01Z', '2026-11-17T24:01Z', '2026-11-17T25:00:00Z',
  '2026-11-17T23:59:59.999Z', '2026-11-17T23:59:60Z', '2026-11-17T23:60:00Z',
  '0000-01-01', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z', '+002026-11-18T03:03:48Z', '-000001-01-01T00:00:00Z', '-000000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00Z', '-271821-04-19T23:59:59.999Z', '+999999-12-31T00:00:00Z',
  '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.999Z',
  // a time without a zone is local time to the reference; these the Java SDK refuses to read
  '2026-11-18T03:03:48', '2026-11-18T03:03', '2026-11-18T03:03:48.308',
  // other spellings: the reference reads some of them with a parser of its own; the Java SDK refuses them all
  '2026-11-18 03:03:48Z', '2026-11-18t03:03:48z', '2026-11-18T03:03:48+0700', '20261118', '2026-11-18T03Z', '2026-11-18T03:03:48.Z', '2026-11-18T3:03:48Z',
  ' 2026-11-18T03:03:48Z', '2026-11-18T03:03:48Z ', '18 Nov 2026 03:03:48 GMT', 'Wed, 18 Nov 2026 03:03:48 GMT', '11/18/2026', '1794971028308', '275760-09-13', '2026-1-1',
  // no date at all
  '', 'not-a-date', 'soon', 'later', 'Z', 'T', 'null', 'undefined', '—',
].map((text) => {
  const m = STANDARD.exec(text);
  const form = m ? (m[4] !== undefined && m[8] === undefined ? 'local' : 'standard') : (/[0-9]/.test(text) ? 'other' : 'none');
  const ms = Date.parse(text);
  if (form === 'none' && !Number.isNaN(ms)) throw new Error(`"${text}" has no digit and is a date to the reference: the Java rule is wrong`);
  return { text, form, ms: Number.isNaN(ms) ? null : ms };
});

// ── parties ────────────────────────────────────────────────────────────────

const parties = [
  ['Acme Trading Co., Ltd.', 'Acme Trading Corporation'], ['Pacific Supply Pte Ltd', 'Pacific Supply Pte. Ltd.'], ['ACME corp.', 'acme'],
  ['Saigon Import Co., Ltd.', 'SAIGON IMPORT COMPANY LIMITED'], ['Lion City Exports Pte. Ltd.', '  lion   city exports (pte) limited '],
  ['Costco', 'Co'], ['Incorporated Goods', 'Goods'], ['Sa Pa Travel', 'Pa Travel'], ['Nova SA', 'Nova S.A.'], ['Nova S.A.', 'Nova'],
  ['Cô Ba Trading', 'Ba Trading'], ['Société Générale SA', 'Société Générale'], ['Größe AG', 'größe'], ['GROSSE AG', 'Größe AG'],
  ['İstanbul Ltd', 'i̇stanbul'], ['ΟΔΟΣ Ltd', 'οδος'], ['Acme Trading', 'Acme Trading'], ['Acme Trading', 'Acme Trading'], ['Acme﻿Trading', 'Acme Trading'],
  ['Acme​Trading', 'Acme Trading'], ['Acme_Co', 'Acme'], ['Acme-Co', 'Acme-'], ['Acme Co2', 'Acme'], ['Acme "Best" (HK) Ltd', "acme best hk"],
  ['A.B.C. Ltd', 'a b c'], ['', ''], ['Ltd', ''], ['co co co', ''], ['Công ty TNHH Sài Gòn', 'công ty tnhh sài gòn'], ['株式会社サイゴン', '株式会社サイゴン'],
  ['Acme\tTrading\nCo', 'acme trading'], ['pte', 'pty'], ['Acme LLC.', 'Acme, L.L.C.'], ['Acme PLC', 'Acme plc'], ['Acme GmbH', 'Acme Gmbh & Co'],
].map(([a, b]) => ({ a, b, equal: partyEquals(a, b, 'normalized') }));

// ── Write, or compare ──────────────────────────────────────────────────────

const text = `${JSON.stringify({
  note: 'Generated by tools/make-verdict-golden.mjs from the reference engine and verifier. Do not edit by hand.',
  bases, engine, signatures, packages, dates, parties,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('verdict.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`verdict.json is current (${engine.length} engine, ${signatures.length} signature, ${packages.length} package cases)`);
} else {
  writeFileSync(OUT, text);
  const threw = (list) => list.filter((c) => c.expected.threw).length;
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${(text.length / 1000).toFixed(0)} kB`);
  console.log(`  engine ${engine.length} (${threw(engine)} refused), signatures ${signatures.length} (${threw(signatures)} refused), `
    + `packages ${packages.length} (${threw(packages)} refused), dates ${dates.length}, parties ${parties.length}`);
  const seen = new Map();
  for (const c of engine) for (const f of c.expected.findings ?? []) seen.set(f, (seen.get(f) ?? 0) + 1);
  console.log(`  ${seen.size} distinct findings: ${[...seen.keys()].map((k) => k.split(':')[1]).sort().join(' ')}`);
  const states = new Map();
  for (const c of engine) for (const [k, v] of Object.entries(c.expected.states ?? {})) states.set(`${k}=${v}`, (states.get(`${k}=${v}`) ?? 0) + 1);
  console.log(`  states: ${[...states.entries()].map(([k, n]) => `${k}×${n}`).join(' ')}`);
}
