/**
 * What holds the Java evaluation sandbox and the two stateless settlement-evidence routes to the reference:
 *
 *   material    the sandbox's starting documents and its catalogue, and the demonstration issuers' public keys —
 *               written into the Java service's own resources, because there they are data and not code:
 *                 src/main/resources/sandbox/material.json           packages/attest-rules/src/{samples,scenarios}.ts, apps/core/src/http/sandbox.ts (TAMPERS)
 *                 src/main/resources/evidence/demo-issuer-keys.json  packages/attest-rules/src/demo-keys.ts
 *   vectors     src/test/resources/vectors/sandbox.json — what the reference's own handlers answer:
 *                 apps/core/src/http/sandbox.ts    catalogue, evidence (scenarios, tampers), package, package/verify
 *                 apps/core/src/http/evidence.ts   reconcile, bundle (the archive: every member, the ZIP around them)
 *                 packages/attest-evidence/src     writeZip, crc32, renderPdf, toLatin1
 *
 *   node apps/core-java/tools/make-sandbox-vectors.mjs          write the three files
 *   node apps/core-java/tools/make-sandbox-vectors.mjs --check  fail when a file on disk differs
 *
 * The handlers are called as the router calls them, with the body a request would carry (as JSON text, read with
 * JSON.parse). The clock and the random id are fixed for the run, so that the two answers that hold them (a
 * package's `generatedAt`, an archive made without `bundleId` / `generatedAt`) are the same every time.
 *
 * An answer is one of:
 *   { status: 200, sha256 }                  SHA-256 of the answer as the server writes it (JSON, two spaces)
 *   { status: 200, archive: { … } }          the archive: its members with their digests, the ZIP's own fields, the headers
 *   { status, error, message }               a refusal the reference states (HttpError)
 *   { status: 500, plain: sentence }         a failure in the reference's own words (a plain Error): answered 500 `internal` with it
 *   { status: 500, engine: sentence }        the JavaScript engine's complaint: answered 500 with it by the reference, and by the
 *                                            Java service with a fixed sentence (docs/JAVA-INTENDED-DIFFERENCES.md, D-01)
 *   engineWorded: true                       a 400 whose message is the engine's complaint; the Java service says its own (D-03)
 *
 * Where the Java service answers differently on purpose, the case says so (`java`), with the row of
 * docs/JAVA-INTENDED-DIFFERENCES.md that says why (`why`).
 *
 * Besides the named cases there is a table (`table`): each place in the sample evidence replaced by each of a list of
 * values nobody would send on purpose — a number where an object belongs, a list where text was meant — and each
 * route's answer to it. That is where a port goes wrong, and the reference's answer there was never written down
 * anywhere but in its behaviour. One answer per cell, in a short form (see `short`).
 */
import { execFileSync } from 'node:child_process';
import crypto, { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { sandboxRoutes, TAMPERS } from '../../core/src/http/sandbox.ts';
import { bundle, reconcile } from '../../core/src/http/evidence.ts';
import { HttpError } from '../../core/src/http/server.ts';
import {
  DEMO_ISSUER_KEYS, DEMO_KEYRING, SAMPLE_POLICY, SAMPLE_SETTLEMENT, SCENARIOS, evaluate, validatePolicy, verifyEvidenceSignatures,
} from '../../../packages/attest-rules/src/index.ts';
import { crc32, renderPdf, toLatin1, writeZip } from '../../../packages/attest-evidence/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  material: path.resolve(HERE, '../src/main/resources/sandbox/material.json'),
  keys: path.resolve(HERE, '../src/main/resources/evidence/demo-issuer-keys.json'),
  vectors: path.resolve(HERE, '../src/test/resources/vectors/sandbox.json'),
};
const check = process.argv.includes('--check');

// ── a fixed clock and a fixed random id ──────────────────────────────────────

const NOW = Date.parse('2026-11-18T09:30:15.250Z');
const UUID = '5e1f0c2a-7b3d-4e6f-8a9b-0c1d2e3f4a5b';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
};
crypto.randomUUID = () => UUID;
syncBuiltinESMExports();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pretty = (v) => JSON.stringify(v, null, 2);
const clone = (v) => structuredClone(v);

// ── answers ──────────────────────────────────────────────────────────────────

const sbx = sandboxRoutes(() => {});
const ROUTES = {
  evidence: (b) => sbx.evidence({ body: async () => b }),
  package: (b) => sbx.pack({ body: async () => b }),
  verify: (b) => sbx.verifyPackage({ body: async () => b }),
  reconcile: (b) => reconcile({ body: async () => b }),
  bundle: (b) => bundle({ body: async () => b }),
};

/** The archive a bundle answer carries, read back out of the ZIP: every member inflated, every header field. */
function archiveOf(result) {
  const zip = Buffer.from(result.body);
  const members = [];
  let off = 0;
  let dosTime; let dosDate;
  while (zip.readUInt32LE(off) === 0x04034b50) {
    const method = zip.readUInt16LE(off + 8);
    dosTime = zip.readUInt16LE(off + 10); dosDate = zip.readUInt16LE(off + 12);
    const crc = zip.readUInt32LE(off + 14); const packed = zip.readUInt32LE(off + 18); const size = zip.readUInt32LE(off + 22);
    const nameLength = zip.readUInt16LE(off + 26);
    const name = zip.subarray(off + 30, off + 30 + nameLength).toString('utf8');
    const data = zip.subarray(off + 30 + nameLength, off + 30 + nameLength + packed);
    const bytes = method === 8 ? inflateRawSync(data) : data;
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`the reference's own archive does not read back: ${name}`);
    members.push({ path: name, bytes: size, sha256: sha256(bytes), crc32: crc });
    off += 30 + nameLength + packed;
  }
  if (sha256(zip) !== result.headers['x-evidence-sha256']) throw new Error('x-evidence-sha256 is not the digest of the archive');
  return {
    members, dosTime, dosDate,
    contentType: result.headers['content-type'], disposition: result.headers['content-disposition'], bundleId: result.headers['x-evidence-bundle-id'],
  };
}

/** Was this refusal worded by the JavaScript engine (a TypeError the route caught) rather than by the reference? */
async function engineWorded(route, body, error) {
  const said = async (fn) => { try { await fn(); return false; } catch (e) { return e?.constructor !== Error; } };
  const o = body !== null && typeof body === 'object' ? body : {};
  if (error === 'invalid_policy') return said(() => validatePolicy(o.policy));
  if (error === 'invalid_evidence' && (route === 'reconcile' || route === 'bundle')) {
    return said(async () => evaluate(await verifyEvidenceSignatures(o.evidence, DEMO_KEYRING), o.policy));
  }
  return false;
}

async function answer(route, text) {
  const body = JSON.parse(text);
  try {
    const out = await ROUTES[route](body);
    if (route === 'bundle') return { status: out.status, archive: archiveOf(out) };
    return { status: 200, sha256: sha256(Buffer.from(pretty(out), 'utf8')) };
  } catch (e) {
    if (e instanceof HttpError) {
      const refusal = { status: e.status, error: e.code, message: e.message };
      return (await engineWorded(route, body, e.code)) ? { ...refusal, engineWorded: true } : refusal;
    }
    if (e?.constructor === Error) return { status: 500, plain: e.message };
    return { status: 500, engine: `${e?.constructor?.name}: ${e?.message}` };
  }
}

/** One answer of the table in few characters: the same facts, for thousands of cells. */
const short = (a) => (a.sha256 ? `=${a.sha256.slice(0, 16)}`
  : a.archive ? `=${sha256(Buffer.from(JSON.stringify(a.archive), 'utf8')).slice(0, 16)}`
    : a.plain !== undefined ? `P:${a.plain}` : a.engine !== undefined ? 'E'
      : a.engineWorded ? `${a.status}:${a.error}:~` : `${a.status}:${a.error}:${a.message}`);

// One mode of this script runs a single case in a process of its own and prints its answer: for the cases after
// which the reference's process is no longer what it was (see `alone` below).
if (process.argv.includes('--alone')) {
  const [route, text] = JSON.parse(process.argv[process.argv.indexOf('--alone') + 1]);
  process.stdout.write(JSON.stringify(await answer(route, text)));
  process.exit(0);
}
const alone = (route, text) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--alone', JSON.stringify([route, text])], { encoding: 'utf8' }));

// ── the starting documents ───────────────────────────────────────────────────

const S = SAMPLE_SETTLEMENT;
const P = SAMPLE_POLICY;
const material = {
  note: 'Generated by apps/core-java/tools/make-sandbox-vectors.mjs from packages/attest-rules/src/{samples,scenarios}.ts and apps/core/src/http/sandbox.ts. '
    + 'The evaluation sandbox\'s starting documents and its catalogue. Synthetic data: no payment, no institution.',
  settlement: S,
  policy: P,
  scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, teaches: s.teaches })),
  tampers: TAMPERS,
};
const keys = {
  note: 'Generated by apps/core-java/tools/make-sandbox-vectors.mjs from packages/attest-rules/src/demo-keys.ts. The demonstration issuers\' keys, '
    + 'public halves only. Their private halves are published, so a signature from one of them proves nothing about who signed: trust level DEMO.',
  keys: DEMO_ISSUER_KEYS,
};

// ── named cases ──────────────────────────────────────────────────────────────

const cases = [];
const text = (v) => (typeof v === 'string' && v.startsWith('json:') ? v.slice(5) : JSON.stringify(v));
/**
 * Most bodies carry the sample documents, whole or nearly. Written out each time they would be most of the file, so
 * a body is kept with each of those documents replaced by a name (`parts`: name → the JSON text it stands for); a
 * reader puts them back, text for text, before parsing.
 */
const parts = {};
const part = (name, value) => { parts[`"@@${name}"`] = JSON.stringify(value); };
const shrink = (t) => Object.entries(parts).reduce((s, [name, json]) => s.split(json).join(name), t);
/** A case: `body` is a value, or `json:…` for JSON text that a value cannot spell (a member named __proto__, -0). */
async function add(route, name, body, extra = {}) {
  const t = text(body);
  cases.push({ name: `${route}: ${name}`, route, body: shrink(t), answer: extra.alone ? alone(route, t) : await answer(route, t), ...(extra.java ? { java: extra.java, why: extra.why } : {}) });
}
part('S', S); part('S.elements', S.elements);
for (const name of Object.keys(S.elements)) part(`S.${name}`, S.elements[name]);
part('P', P);
const withElement = (name, change) => ({ ...clone(S), elements: { ...clone(S.elements), [name]: change(clone(S.elements[name])) } });
const D06 = 'D-06: a body that is JSON null has no fields, so the route answers as it does for an empty object; the reference fails inside the engine (a 500)';
const D04 = 'D-04: a time that is not written the ISO 8601 way is not a valid instant here; the reference took whatever the JavaScript engine reads';

// The evidence route: a scenario, then tampers in order, then the signatures checked.
for (const s of SCENARIOS) await add('evidence', `scenario ${s.id}`, { scenario: s.id });
await add('evidence', 'no body at all is scenario A', {});
await add('evidence', 'a scenario that is null is scenario A', { scenario: null });
await add('evidence', 'a body that is text has no fields', 'abc');
await add('evidence', 'a body that is a list has no fields', [1, 2]);
await add('evidence', 'a body that is null', null, { java: await answer('evidence', '{}'), why: D06 });
for (const bad of ['Z', 'a', '', 7, true, [], ['A'], {}, { toString: 1 }]) await add('evidence', `no such scenario: ${JSON.stringify(bad)}`, { scenario: bad });
for (const t of TAMPERS) {
  const base = t.id === 'amount' ? { id: t.id, amount: '48000.00' } : { id: t.id };
  await add('evidence', `tamper ${t.id}, nothing else said`, { tampers: [base] });
  for (const target of t.needs.target ?? []) await add('evidence', `tamper ${t.id} on ${target}`, { tampers: [{ ...base, target }] });
  for (const document of t.needs.document ?? []) await add('evidence', `tamper ${t.id}: ${document}`, { tampers: [{ ...base, document }] });
}
await add('evidence', 'a document that is not in the catalogue', { tampers: [{ id: 'document', document: 'customs-declaration' }] });
await add('evidence', 'a document named with capitals: Commercial INVOICE', { tampers: [{ id: 'document', document: 'Commercial INVOICE' }] });
await add('evidence', 'a document nobody attached', { tampers: [{ id: 'document', document: 'certificate of origin — 원산지' }] });
await add('evidence', 'two amounts changed: the scenario lists both', { tampers: [{ id: 'amount', amount: '1.00' }, { id: 'amount', target: 'payoutReceipt', amount: '2' }] });
await add('evidence', 'every tamper at once', { scenario: 'B', tampers: [{ id: 'signature' }, { id: 'digest' }, { id: 'document' }, { id: 'duplicate' }, { id: 'amount', amount: '0' }] });
await add('evidence', 'a signature corrupted twice comes back to a third value', { tampers: [{ id: 'signature' }, { id: 'signature' }] });
await add('evidence', 'the invoice removed twice', { tampers: [{ id: 'document' }, { id: 'document' }] });
await add('evidence', 'a duplicate of a duplicate', { tampers: [{ id: 'duplicate' }, { id: 'duplicate' }] });
await add('evidence', 'split payment, then the first half corrupted', { scenario: 'E', tampers: [{ id: 'signature' }] });
await add('evidence', 'an amount that is not a decimal is written as given', { tampers: [{ id: 'amount', amount: 'fifty thousand €' }] });
await add('evidence', 'an amount on a target the catalogue does not list: only the scenario says so', { tampers: [{ id: 'amount', target: 'nothing', amount: '3' }] });
await add('evidence', 'an amount change without an amount', { tampers: [{ id: 'amount' }] });
await add('evidence', 'an amount change with an empty amount', { tampers: [{ id: 'amount', amount: '' }] });
await add('evidence', 'an amount that is a number is no amount', { tampers: [{ id: 'amount', amount: 48000 }] });
await add('evidence', 'a target that is not text is the default target', { tampers: [{ id: 'signature', target: 7 }, { id: 'digest', target: ['commercialDocs'] }, { id: 'document', document: null }] });
await add('evidence', 'a signature on an element that is not there', { tampers: [{ id: 'signature', target: 'travelRule' }] });
await add('evidence', 'a digest on an element that is not there', { tampers: [{ id: 'digest', target: 'bankApproval' }] });
await add('evidence', 'a signature on an element that carries none: the chain transfer of scenario A has a status and no value', { tampers: [{ id: 'signature', target: 'chainTransfer' }] });
await add('evidence', 'a signature on scenario D, whose invoice signature was voided', { scenario: 'D', tampers: [{ id: 'signature', target: 'commercialDocs' }] });
for (const bad of ['amount', {}, [], 7, null]) await add('evidence', `tampers that are not a list: ${JSON.stringify(bad)}`, { tampers: bad });
for (const bad of [null, 'amount', 7, [], {}, { id: 5 }, { id: 'nope' }, { id: null }, { id: ['amount'] }, { id: { toString: 1 } }, { ID: 'amount' }]) {
  await add('evidence', `no such tamper: ${JSON.stringify(bad)}`, { tampers: [bad] });
}
await add('evidence', 'a bad tamper after a good one: nothing is applied', { tampers: [{ id: 'duplicate' }, { id: 'nope' }] });
await add('evidence', 'evidence of the caller\'s own, untouched', { evidence: S });
await add('evidence', 'evidence of the caller\'s own, with a tamper', { evidence: S, tampers: [{ id: 'amount', target: 'bankInstruction', amount: '49999.99' }] });
await add('evidence', 'evidence given, and a scenario that would not exist: the scenario is not looked at', { evidence: S, scenario: 'Z' });
for (const bad of [null, 7, 'text', true]) await add('evidence', `evidence that is not an object: ${JSON.stringify(bad)}`, { evidence: bad });
await add('evidence', 'evidence that is a list', { evidence: [] });
await add('evidence', 'evidence with no elements', { evidence: { scenario: 'mine' } });
await add('evidence', 'evidence whose elements are a number: nothing to check, nothing wrong', { evidence: { scenario: 'mine', elements: 5 } });
await add('evidence', 'evidence with no scenario cannot be tampered with', { evidence: { elements: clone(S.elements) }, tampers: [{ id: 'duplicate' }] });
await add('evidence', 'evidence whose scenario is a list', { evidence: { ...clone(S), scenario: ['mine', ' + tampered:'] }, tampers: [{ id: 'duplicate' }, { id: 'digest' }] });
await add('evidence', 'a signature under a key nobody holds', { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { ...e.signature, keyId: 'someone-else' } })) });
await add('evidence', 'a signature under a key that is a number', { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { ...e.signature, keyId: 7 } })) });
await add('evidence', 'a signature that claims VALID and carries no value', { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { status: 'VALID', keyId: 'demo-bank-key-01', trustLevel: 'ACCREDITED' } })) });
await add('evidence', 'a signed element with a number in it', { evidence: withElement('bankInstruction', (e) => ({ ...e, sequence: 1.50, big: 1e21, small: 1e-7, negativeZero: -0 })) });
await add('evidence', 'members named like numbers keep the order the engine gives them', 'json:{"evidence":{"scenario":"s","10":"ten","9":"nine","elements":{"b":1,"2":"two","a":2,"1":"one"}}}');
await add('evidence', 'a member named __proto__ is a member', 'json:{"evidence":{"scenario":"s","__proto__":{"x":1},"elements":{"__proto__":{"signature":{"value":"AAAA"}}}},"tampers":[{"id":"signature","target":"__proto__"}]}');
// A target that names a member every JavaScript object has is not an element of the document: the tamper finds
// nothing of that name, in the reference as here. Until 2026-11-18 the reference read such a name off the engine's
// own objects — the signature tamper said the engine's object carried no signature, and the digest tamper wrote
// `digestVerified` onto it, onto every object of the process from then on (D-13, closed by the fix in
// packages/attest-rules/src/tamper.ts). The digest cases still run in a process of their own: should that ever come
// back, it must not reach the other cases of this run.
for (const target of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
  await add('evidence', `a signature on a target named ${target}`, { tampers: [{ id: 'signature', target }] });
  await add('evidence', `a digest on a target named ${target}`, { tampers: [{ id: 'digest', target }] }, { alone: true });
}

// The package route: the evidence checked, the verdict, and a digest over all of it.
await add('package', 'the sample', { evidence: S });
await add('package', 'the sample under a name of the caller\'s', { evidence: S, bundleId: 'CASE-2026-0042 / 검토' });
await add('package', 'an empty name is a name', { evidence: S, bundleId: '' });
await add('package', 'a name that is not text is made from the evidence', { evidence: S, bundleId: 42 });
for (const s of SCENARIOS) await add('package', `scenario ${s.id}`, { evidence: (await sbx.evidence({ body: async () => ({ scenario: s.id }) })).evidence });
await add('package', 'a policy of the caller\'s', { evidence: S, policy: { ...P, policyVersion: 'house-rules-7', amountTolerance: '2500.00', sourceTrustLevel: 'DEMO' } });
await add('package', 'a policy with members of its own, some named like numbers', { evidence: S, policy: { ...P, 10: 'a', 9: 'b', note: { z: 1, a: [3, 2, { y: 1, x: 2 }] } } });
await add('package', 'a policy whose trust level is a member every engine object has', { evidence: S, policy: { ...P, sourceTrustLevel: 'toString' } });
await add('package', 'a policy with numbers written other ways', 'json:{"evidence":' + JSON.stringify(S) + ',"policy":' + JSON.stringify(P).replace('"amountToleranceBps":0', '"amountToleranceBps":0.0e0').replace('"maxBps":0', '"maxBps":-0') + '}');
for (const bad of [null, 7, 'text', true]) await add('package', `a policy that is not an object: ${JSON.stringify(bad)}`, { evidence: S, policy: bad });
await add('package', 'a policy that is a list', { evidence: S, policy: [] });
await add('package', 'no evidence', {});
for (const bad of [null, 7, 'text']) await add('package', `evidence that is not an object: ${JSON.stringify(bad)}`, { evidence: bad });
await add('package', 'a body that is null', null, { java: await answer('package', '{}'), why: D06 });
await add('package', 'evidence with no elements', { evidence: {} });
await add('package', 'evidence that is a list', { evidence: [] });
await add('package', 'an amount that is a number', { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 50000 })) });
await add('package', 'an amount that is not a plain decimal', { evidence: withElement('bankInstruction', (e) => ({ ...e, amount: '50,000.00' })) });
await add('package', 'evidence of two members', { evidence: { scenario: 'bare', elements: {} } });

// The verify route: is the file the one that was issued, and does the policy still give that verdict.
const sealed = await sbx.pack({ body: async () => ({ evidence: clone(S), bundleId: 'EV-SEALED' }) });
const sealedB = await sbx.pack({ body: async () => ({ evidence: (await sbx.evidence({ body: async () => ({ scenario: 'B' }) })).evidence }) });
part('sealed', sealed); part('sealed.evidence', sealed.evidence); part('sealed.verdict', sealed.verdict); part('sealed.axes', sealed.verdict.axes); part('sealed.material', sealed.verificationMaterial);
const edit = (pkg, change) => { const p = clone(pkg); change(p); return p; };
await add('verify', 'a package as it was issued', { package: sealed });
await add('verify', 'the same, sent bare', sealed);
await add('verify', 'scenario B as it was issued', { package: sealedB });
await add('verify', 'a member added that the digest does not cover', { package: edit(sealed, (p) => { p.note = 'reviewed'; }) });
await add('verify', 'a digest that was edited', { package: edit(sealed, (p) => { p.digest = '0'.repeat(64); }) });
await add('verify', 'an amount edited after sealing', { package: edit(sealed, (p) => { p.evidence.elements.chainTransfer.amount = '48000.00'; }) });
await add('verify', 'a verdict edited after sealing', { package: edit(sealed, (p) => { p.verdict.axes.matching.state = 'MATCH'; p.verdict.axes.issuer.state = 'VALID'; }) });
await add('verify', 'a policy edited after sealing', { package: edit(sealed, (p) => { p.policy.amountTolerance = '5000.00'; }) });
await add('verify', 'a verdict with an axis missing', { package: edit(sealed, (p) => { delete p.verdict.axes.integrity; }) });
await add('verify', 'a verdict whose axis has no state', { package: edit(sealed, (p) => { delete p.verdict.axes.integrity.state; p.verdict.axes.issuer.state = null; p.verdict.axes.matching = 'MISMATCH'; }) });
await add('verify', 'a verdict whose axes are a list', { package: edit(sealed, (p) => { p.verdict.axes = ['VALID']; }) });
await add('verify', 'a verdict with no axes', { package: edit(sealed, (p) => { delete p.verdict.axes; }) });
await add('verify', 'a verdict that is text', { package: edit(sealed, (p) => { p.verdict = 'MATCH'; }) });
await add('verify', 'a verdict that is a list', { package: edit(sealed, (p) => { p.verdict = [1]; }) });
await add('verify', 'a policy that is text', { package: edit(sealed, (p) => { p.policy = 'settlement-match-v1'; }) });
await add('verify', 'a policy that is not valid', { package: edit(sealed, (p) => { p.policy.partyIDMatch = 'loose'; }) });
await add('verify', 'evidence that is text', { package: edit(sealed, (p) => { p.evidence = 'evidence'; }) });
await add('verify', 'evidence that is a number', { package: edit(sealed, (p) => { p.evidence = 7; }) });
await add('verify', 'evidence with an amount that is not a decimal', { package: edit(sealed, (p) => { p.evidence.elements.chainTransfer.amount = 'lots'; }) });
await add('verify', 'what the digest covers: other members, odd numbers, odd names',
  `json:{"package":${JSON.stringify(sealed).slice(0, -1)},"zz":[1.50,1e21,1e-7,-0,0.1,123456789012345680000,null,true,"\\ud83d","é\\u2028\\"\\\\"],"10":1,"9":2,"é":{"b":[],"a":{}},"":"","__proto__":{"k":1}}}`);
await add('verify', 'a package member that is null is not a package', { package: null, digest: sealed.digest });
for (const bad of [{}, [], 'text', 7, true, { package: 7 }, { package: 'x' }, { package: [] }, { package: {} }]) await add('verify', `not a package: ${JSON.stringify(bad)}`, bad);
for (const member of ['digest', 'evidence', 'policy', 'verdict']) await add('verify', `a package without its ${member}`, { package: edit(sealed, (p) => { delete p[member]; }) });
await add('verify', 'a digest that is not text', { package: edit(sealed, (p) => { p.digest = 5; }) });
for (const member of ['evidence', 'policy', 'verdict']) await add('verify', `a package whose ${member} is empty text`, { package: edit(sealed, (p) => { p[member] = ''; }) });
await add('verify', 'a body that is null', null, { java: await answer('verify', '{}'), why: D06 });

// Reconciliation: the verdict, as data.
await add('reconcile', 'the sample', { evidence: S, policy: P });
for (const s of SCENARIOS) await add('reconcile', `scenario ${s.id}`, { evidence: (await sbx.evidence({ body: async () => ({ scenario: s.id }) })).evidence, policy: P });
await add('reconcile', 'what the document says of its signatures carries no weight', { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { ...e.signature, status: 'VALID', trustLevel: 'ACCREDITED', issuer: 'A REAL BANK' } })), policy: P });
await add('reconcile', 'a looser policy', { evidence: (await sbx.evidence({ body: async () => ({ scenario: 'B' }) })).evidence, policy: { ...P, policyVersion: 'loose', amountTolerance: '2000.00', sourceTrustLevel: 'DEMO' } });
await add('reconcile', 'a body that is null has no evidence', null);
for (const bad of [{}, [], 'text', 7]) await add('reconcile', `nothing to reconcile: ${JSON.stringify(bad)}`, bad);
for (const bad of [null, 0, '', 'text', 7, true]) await add('reconcile', `evidence that is not an object: ${JSON.stringify(bad)}`, { evidence: bad, policy: P });
for (const bad of [null, 0, '', 'text', 7, true]) await add('reconcile', `a policy that is not an object: ${JSON.stringify(bad)}`, { evidence: S, policy: bad });
await add('reconcile', 'no policy: there is no default', { evidence: S });
const badPolicies = {
  'no version': { policyVersion: undefined }, 'an empty version': { policyVersion: '' }, 'a version that is a number': { policyVersion: 1 },
  'no currencies': { currencies: [] }, 'currencies that are text': { currencies: 'USD' },
  'groups that are not lists': { unitOfAccountGroups: ['USD'] }, 'an empty group': { unitOfAccountGroups: [[]] }, 'no groups': { unitOfAccountGroups: undefined },
  'a currency in two groups': { unitOfAccountGroups: [['USD', 'USDC'], ['USD']] }, 'a group naming a currency the policy does not have': { unitOfAccountGroups: [['USD', 'EUR']] },
  'a tolerance that is a number': { amountTolerance: 0 }, 'a tolerance that is not a decimal': { amountTolerance: '1e3' }, 'no tolerance': { amountTolerance: undefined },
  'basis points that are a fraction': { amountToleranceBps: 0.5 }, 'basis points below zero': { amountToleranceBps: -1 }, 'basis points that are text': { amountToleranceBps: '0' },
  'an FX reference that is a number': { fxReference: 7 }, 'no FX reference': { fxReference: undefined },
  'a window in months': { settlementWindow: 'P1M' }, 'a window that is a number': { settlementWindow: 3 }, 'a window that is a list': { settlementWindow: ['P3D'] },
  'a window that is an object': { settlementWindow: { days: 3 } }, 'a window that is an object with a member named toString': { settlementWindow: { toString: 1 } }, 'no window': { settlementWindow: undefined },
  'fees that are text': { fees: 'none' }, 'fees without deductible': { fees: { maxBps: 0 } }, 'fees with a negative cap': { fees: { deductible: true, maxBps: -5 } }, 'no fees': { fees: null },
  'split payments that are a boolean': { splitPayments: true }, 'split payments without aggregate': { splitPayments: { allowed: true } },
  'a party match nobody defined': { partyIDMatch: 'fuzzy' },
  'a trust level nobody defined': { sourceTrustLevel: 'TRUSTED' }, 'a trust level in lower case': { sourceTrustLevel: 'demo' }, 'a trust level that is a number': { sourceTrustLevel: 1 }, 'no trust level': { sourceTrustLevel: undefined },
  'required elements that are text': { requiredElements: 'all' }, 'signature elements that are an object': { signatureRequiredElements: {} },
  'a signature required of an element that is not required': { signatureRequiredElements: ['travelRule'] },
  'no Travel Rule switch': { requireTravelRulePreflight: undefined }, 'a Travel Rule switch that is text': { requireTravelRulePreflight: 'false' },
  'an FX window switch that is a number': { enforceFxQuoteWindow: 0 }, 'settlement id places that are null': { settlementIdRequiredIn: null },
  'regulatory fields that are text': { regulatoryFields: 'all' },
};
for (const [name, change] of Object.entries(badPolicies)) await add('reconcile', `a policy the engine cannot evaluate: ${name}`, { evidence: S, policy: { ...P, ...change } });
await add('reconcile', 'a policy that is a list', { evidence: S, policy: [] });
await add('reconcile', 'a policy whose trust level is a member every engine object has', { evidence: S, policy: { ...P, sourceTrustLevel: 'constructor' } });
await add('reconcile', 'evidence with no elements', { evidence: {}, policy: P });
await add('reconcile', 'evidence that is a list', { evidence: [], policy: P });
await add('reconcile', 'evidence whose elements are null', { evidence: { elements: null }, policy: P });
await add('reconcile', 'evidence whose elements are a number', { evidence: { elements: 5 }, policy: P });
await add('reconcile', 'evidence of nothing but empty elements', { evidence: { elements: {} }, policy: P });
await add('reconcile', 'an amount that is a number', { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 50000 })), policy: P });
await add('reconcile', 'an amount with a thousands separator', { evidence: withElement('commercialDocs', (e) => ({ ...e, amount: '50,000.00' })), policy: P });
await add('reconcile', 'an amount that is null', { evidence: withElement('bankInstruction', (e) => ({ ...e, amount: null })), policy: P });
await add('reconcile', 'a settlement three days and a second after approval', { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-01T09:01:59Z' })), policy: P });
await add('reconcile', 'a settlement before its approval', { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-05T00:00:00+07:00' })), policy: P });
await add('reconcile', 'times written the ISO 8601 way in other forms', { evidence: { ...withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-03 11:40' })), elements: { ...withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-03 11:40' })).elements, payoutReceipts: [{ ...clone(S.elements.payoutReceipts[0]), paidAt: '2026-03-04t09:02:00.000+0000' }] } }, policy: P });
await add('reconcile', 'a time that is not a time', { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: 'yesterday' })), policy: P });
// A time only the JavaScript engine reads: the reference measures the settlement window against it; the Java service
// says the timestamp is unparseable (D-12). Both answers are kept — the reference's here, the Java service's in `java`.
const TIME_FINDING = /TIMESTAMP|SETTLEMENT_BEFORE_APPROVAL|SETTLEMENT_WINDOW_EXCEEDED/;
const D12 = 'D-12: a time that is not written the ISO 8601 way is not read; the reference measured against whatever the JavaScript engine made of it';
for (const [name, approvedAt, observedAt] of [
  ['an approval written "Mar 1, 2026 09:00 UTC", within the window', 'Mar 1, 2026 09:00 UTC', undefined],
  ['an approval written "Feb 28, 2026 09:00 UTC", past the window', 'Feb 28, 2026 09:00 UTC', undefined],
  ['a settlement before an approval written "2026/03/05"', '2026/03/05', undefined],
  ['a transfer observed "4 March 2026 08:15 GMT", within the window', undefined, '4 March 2026 08:15 GMT'],
  ['an approval that is a number', 1, undefined],
]) {
  const evidence = { ...withElement('bankInstruction', (e) => ({ ...e, ...(approvedAt ? { approvedAt } : {}) })) };
  if (observedAt) evidence.elements.chainTransfer = { ...clone(S.elements.chainTransfer), observedAt };
  const body = JSON.stringify({ evidence, policy: P });
  // `timeFindings`: the codes of the findings about time, in the order the rules ran — the reference's, and what the Java service reports instead.
  cases.push({ name: `reconcile: ${name}`, route: 'reconcile', body: shrink(body), answer: await answer('reconcile', body),
    timeFindings: (await reconcile({ body: async () => JSON.parse(body) })).findings.map((f) => f.code).filter((code) => TIME_FINDING.test(code)),
    java: { status: 200, timeFindings: ['TIMESTAMP_UNPARSEABLE'] }, why: D12 });
}

// The archive.
const FIXED = { bundleId: 'EV-2026-0001', generatedAt: '2026-11-18T10:00:00.000Z' };
// An object with a member named toString, where the rules write a value into a sentence: the reference's engine cannot
// turn it into text and fails. So do the SDK's rules since its release of 2026-11-19 (this was D-14 until then): the
// same refusal on both sides, each in its own sentence (D-03).
const odd = withElement('chainTransfer', (e) => ({ ...e, currency: { toString: 1 } }));
await add('reconcile', 'a currency that is an object with a member named toString', { evidence: odd, policy: P });
await add('package', 'a currency that is an object with a member named toString', { evidence: odd });
await add('bundle', 'a currency that is an object with a member named toString', { evidence: odd, policy: P, ...FIXED });
await add('bundle', 'the sample, with the id and the time the caller gave', { evidence: S, policy: P, ...FIXED });
for (const s of SCENARIOS) await add('bundle', `scenario ${s.id}`, { evidence: (await sbx.evidence({ body: async () => ({ scenario: s.id }) })).evidence, policy: P, ...FIXED });
await add('bundle', 'no id and no time: a random id, the clock', { evidence: S, policy: P });
await add('bundle', 'an empty id is no id', { evidence: S, policy: P, bundleId: '', generatedAt: FIXED.generatedAt });
await add('bundle', 'an id that is a number is no id', { evidence: S, policy: P, bundleId: 42, generatedAt: FIXED.generatedAt });
await add('bundle', 'an id with characters a file name and a PDF have to carry', { evidence: S, policy: P, bundleId: 'CASE (2026) \\ 0042 "A" é — 검토 😀', generatedAt: FIXED.generatedAt });
await add('bundle', 'evidence that is not synthetic says so nowhere', { evidence: { ...clone(S), dataMode: 'LIVE', notRealPayment: false }, policy: P, ...FIXED });
await add('bundle', 'evidence without notRealPayment, purpose or jurisdiction', { evidence: { schemaVersion: S.schemaVersion, scenario: 'bare', dataMode: 'SYNTHETIC', elements: clone(S.elements) }, policy: P, ...FIXED });
await add('bundle', 'text in other scripts: whole in the JSON, transliterated in the PDF', { evidence: { ...clone(S), scenario: '정상 무역 결제 — “VN→SG” ✓ … naïve café ①②③④⑤⑥ ‘x’ •·–↑↓←✗', purpose: '수입 대금 😀 \ud83d half', jurisdiction: { from: 'Việt Nam', to: 'シンガポール' } }, policy: P, ...FIXED });
await add('bundle', 'a long scenario wraps, a long token is cut by the character', { evidence: { ...clone(S), scenario: `${'word '.repeat(60)}${'0123456789abcdef'.repeat(12)} ${'W'.repeat(140)}`, purpose: `  leading and trailing spaces,\ttabs\nand line breaks ${'x'.repeat(200)}  ` }, policy: P, ...FIXED });
await add('bundle', 'enough findings for a second page', { evidence: (await sbx.evidence({ body: async () => ({ scenario: 'F', tampers: [{ id: 'signature' }, { id: 'digest' }, { id: 'document' }, { id: 'amount', amount: '1' }, { id: 'amount', target: 'bankInstruction', amount: '2' }, { id: 'signature', target: 'bankInstruction' }, { id: 'digest', target: 'commercialDocs' }] }) })).evidence, policy: P, ...FIXED });
await add('bundle', 'receipts, ten and more: the names sort as text', { evidence: { ...clone(S), elements: { ...clone(S.elements), payoutReceipts: Array.from({ length: 12 }, (_, n) => ({ ...clone(S.elements.payoutReceipts[0]), ref: `PAY-${n}`, amount: n === 0 ? '49989.00' : '1.00', digestVerified: n % 3 === 0 ? true : n % 3 === 1 ? false : undefined })) } }, policy: P, ...FIXED });
await add('bundle', 'elements that are not objects are in neither list', { evidence: { ...clone(S), elements: { chainTransfer: 'tx', payoutReceipts: ['r', 7, null, [], { digest: 5 }, { signature: null }], bankInstruction: [], commercialDocs: { digest: null, digestVerified: null, signature: 'signed' } } }, policy: P, ...FIXED });
await add('bundle', 'a scenario that is a list of text', { evidence: { ...clone(S), scenario: ['ab', 'ç한', '—', '', '한ab'], purpose: ['p'] }, policy: P, ...FIXED });
await add('bundle', 'a jurisdiction that is text, a purpose that is a list', { evidence: { ...clone(S), jurisdiction: 'VN', purpose: ['a', 'b'] }, policy: P, ...FIXED });
await add('bundle', 'a jurisdiction of numbers and lists', { evidence: { ...clone(S), jurisdiction: { from: 84, to: ['SG', null, [1.5, 'x']] } }, policy: P, ...FIXED });
for (const [name, change] of [['no scenario', { scenario: undefined }], ['a scenario that is a number', { scenario: 7 }], ['no data mode', { dataMode: undefined }], ['a purpose that is a number', { purpose: 7 }],
  ['a purpose that is an object', { purpose: {} }], ['a scenario that is a list holding a number', { scenario: ['a', 7] }], ['a jurisdiction with a member named toString', { jurisdiction: { from: { toString: 1 }, to: 'SG' } }]]) {
  await add('bundle', `the summary cannot be written: ${name}`, { evidence: { ...clone(S), ...change }, policy: P, ...FIXED });
}
await add('bundle', 'receipts that are text cannot be listed', { evidence: { ...clone(S), elements: { ...clone(S.elements), payoutReceipts: 'PAY-REF-01' } }, policy: P, ...FIXED });
await add('bundle', 'receipts that are an object cannot be listed', { evidence: { ...clone(S), elements: { ...clone(S.elements), payoutReceipts: { 0: clone(S.elements.payoutReceipts[0]) } } }, policy: P, ...FIXED });
for (const [name, generatedAt] of [['a date alone', '2026-11-18'], ['a month', '2026-11'], ['a year', '2026'], ['with an offset', '2026-11-18T19:00:00+09:00'], ['with an offset and no colon', '2026-11-18T19:00:00.5+0900'],
  ['a space for the T', '2026-11-18 10:00'], ['no zone: UTC, as the machine is', '2026-11-18T10:00:00'], ['an odd second', '2026-11-18T10:00:01Z'], ['the last second of a day', '2099-12-31T23:59:59.999Z'],
  ['the first second ZIP can hold', '1980-01-01T00:00:00Z'], ['a year ZIP cannot hold in sixteen bits', '2108-01-01T00:00:00Z'], ['a year of six digits', '+010000-01-01T00:00:00Z'],
  ['milliseconds as a number', 1795000000000], ['a number with a fraction', 1795000000000.9], ['the last instant a date can be', 8.64e15], ['a list of one text', ['2026-11-18T10:00:00Z']], ['a list of one number', [2026]]]) {
  await add('bundle', `a time: ${name}`, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt });
}
for (const [name, generatedAt] of [['a second before 1980', '1979-12-31T23:59:59Z'], ['true is one millisecond', true], ['one', 1], ['a year before 1970', '0001-01-01']]) {
  await add('bundle', `a time ZIP cannot write: ${name}`, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt });
}
for (const [name, generatedAt] of [['nothing given: null', null], ['zero', 0], ['empty text', ''], ['false', false]]) await add('bundle', `no time at all is the clock: ${name}`, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt });
for (const [name, generatedAt] of [['words', 'yesterday'], ['an object', {}], ['an empty list', []], ['past the last instant', 8.64e15 + 2], ['a month that does not exist', '2026-13-01'], ['an hour that does not exist', '2026-11-18T25:00:00Z'],
  ['thirteen digits as text', '1795000000000'], ['an object with a member named valueOf', { valueOf: 1 }]]) {
  await add('bundle', `not a time: ${name}`, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt });
}
await add('bundle', 'not a time: an object with a member named toString', { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: { toString: 1 } });
for (const generatedAt of ['Nov 18, 2026', '2026/11/18', '18 Nov 2026 10:00 GMT', '2026-11-8', 'Wed, 18 Nov 2026 10:00:00 GMT', [2026, 11]]) {
  await add('bundle', `a time only the engine reads: ${JSON.stringify(generatedAt)}`, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt },
    { java: { status: 400, error: 'invalid_timestamp', message: `"generatedAt" is not a valid instant: ${generatedAt}` }, why: D04 });
}
await add('bundle', 'refusals come in order: the policy before the time', { evidence: S, policy: {}, generatedAt: 'yesterday' });
await add('bundle', 'refusals come in order: the time before the evidence', { evidence: {}, policy: P, generatedAt: 'yesterday' });
await add('bundle', 'refusals come in order: the evidence before the archive', { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 1 })), policy: P, generatedAt: '1970-01-01' });
await add('bundle', 'no evidence', { policy: P });
await add('bundle', 'no policy', { evidence: S });
await add('bundle', 'a body that is null has no evidence', null);

// ── the table: each place in the evidence, each odd value, each route ─────────

const VALUES = [undefined, null, true, false, 0, 7, -1, 1.5, 1e21, '', 'x', 'ABAB', 'A', 'invoice', '48000.00', [], ['a'], ['A', 'A'], [null], [7], [{}], [[]], {}, { 0: 'z' }, { value: 'AAAA' },
  { status: 'DEMO_VALID', value: 'AAAA', keyId: 'demo-bank-key-01' }, { toString: 1 }, { length: 2, 0: 'A', 1: 'B' }, '\ud83d', '😀é—·'];
const NODES = [['scenario'], ['dataMode'], ['purpose'], ['jurisdiction'], ['jurisdiction', 'from'], ['notRealPayment'], ['elements'],
  ['elements', 'chainTransfer'], ['elements', 'chainTransfer', 'amount'], ['elements', 'chainTransfer', 'currency'], ['elements', 'chainTransfer', 'signature'], ['elements', 'chainTransfer', 'digest'],
  ['elements', 'chainTransfer', 'digestVerified'], ['elements', 'chainTransfer', 'confirmations'], ['elements', 'chainTransfer', 'txRef'],
  ['elements', 'payoutReceipts'], ['elements', 'payoutReceipts', 0], ['elements', 'payoutReceipts', 0, 'ref'], ['elements', 'payoutReceipts', 0, 'amount'], ['elements', 'payoutReceipts', 0, 'signature'],
  ['elements', 'payoutReceipts', 0, 'signature', 'value'], ['elements', 'payoutReceipts', 0, 'signature', 'keyId'], ['elements', 'payoutReceipts', 0, 'signature', 'status'],
  ['elements', 'bankInstruction'], ['elements', 'bankInstruction', 'debtor'], ['elements', 'bankInstruction', 'iso20022Fields'], ['elements', 'bankInstruction', 'ref'],
  ['elements', 'commercialDocs'], ['elements', 'commercialDocs', 'attached'], ['elements', 'commercialDocs', 'citedOnly'], ['elements', 'commercialDocs', 'signature'],
  ['elements', 'commercialDocs', 'signature', 'value'], ['elements', 'commercialDocs', 'amount'], ['elements', 'commercialDocs', 'invoiceRef'], ['elements', 'commercialDocs', 'buyer'],
  ['elements', 'travelRule'], ['elements', 'bankApproval'], ['elements', 'fxQuote']];
/** The tampers the table runs on the evidence route, and the places each one reads. */
const E = (...p) => ['elements', ...p];
const STEPS = [
  { steps: [], at: NODES },
  { steps: [{ id: 'amount', amount: '1.00' }], at: [['scenario'], E(), E('chainTransfer'), E('chainTransfer', 'amount')] },
  { steps: [{ id: 'amount', target: 'payoutReceipt', amount: '1.00' }], at: [E(), E('payoutReceipts'), E('payoutReceipts', 0)] },
  { steps: [{ id: 'amount', target: 'commercialDocs', amount: '1.00' }], at: [E('commercialDocs')] },
  { steps: [{ id: 'signature' }], at: [['scenario'], E(), E('payoutReceipts'), E('payoutReceipts', 0), E('payoutReceipts', 0, 'signature'), E('payoutReceipts', 0, 'signature', 'value')] },
  { steps: [{ id: 'signature', target: 'commercialDocs' }], at: [E(), E('commercialDocs'), E('commercialDocs', 'signature'), E('commercialDocs', 'signature', 'value')] },
  { steps: [{ id: 'document' }], at: [['scenario'], E(), E('commercialDocs'), E('commercialDocs', 'attached'), E('commercialDocs', 'citedOnly'), E('commercialDocs', 'signature'), E('commercialDocs', 'amount')] },
  { steps: [{ id: 'document', document: 'contract' }, { id: 'document', document: 'a' }], at: [E('commercialDocs'), E('commercialDocs', 'attached'), E('commercialDocs', 'citedOnly')] },
  { steps: [{ id: 'digest' }], at: [['scenario'], E(), E('payoutReceipts'), E('payoutReceipts', 0)] },
  { steps: [{ id: 'digest', target: 'bankInstruction' }], at: [E(), E('bankInstruction')] },
  { steps: [{ id: 'duplicate' }], at: [['scenario'], E(), E('payoutReceipts'), E('payoutReceipts', 0), E('payoutReceipts', 0, 'ref')] },
  { steps: [{ id: 'duplicate' }, { id: 'signature' }, { id: 'digest' }], at: [E('payoutReceipts'), E('payoutReceipts', 0), E('payoutReceipts', 0, 'signature')] },
];
/** The body of one cell: the base body of the route with one place of its evidence replaced (or removed). */
function cellBody(base, where, value) {
  const body = clone(base);
  let at = body;
  for (const step of where.slice(0, -1)) at = at[step];
  const last = where[where.length - 1];
  if (value === undefined) { if (Array.isArray(at)) at.splice(last, 1); else delete at[last]; } else at[last] = clone(value);
  return body;
}
const BASES = {
  evidence: { evidence: S },
  reconcile: { evidence: S, policy: P },
  bundle: { evidence: S, policy: P, ...FIXED },
  package: { evidence: S, policy: P, bundleId: 'EV-TABLE' },
  verify: { package: sealed },
};
const table = { values: VALUES.map((v) => (v === undefined ? null : JSON.stringify(v))), nodes: NODES, bases: Object.fromEntries(Object.entries(BASES).map(([k, v]) => [k, shrink(JSON.stringify(v))])), rows: [] };
const nodeIndex = (where) => NODES.findIndex((n) => JSON.stringify(n) === JSON.stringify(where));
for (const { steps, at } of STEPS) {
  for (const where of at) {
    const answers = [];
    for (const v of VALUES) answers.push(short(await answer('evidence', JSON.stringify({ ...cellBody(BASES.evidence, ['evidence', ...where], v), ...(steps.length ? { tampers: steps } : {}) }))));
    table.rows.push({ route: 'evidence', steps, node: nodeIndex(where), answers });
  }
}
for (const route of ['reconcile', 'bundle', 'package']) {
  for (const where of NODES) {
    const answers = [];
    for (const v of VALUES) answers.push(short(await answer(route, JSON.stringify(cellBody(BASES[route], ['evidence', ...where], v)))));
    table.rows.push({ route, node: nodeIndex(where), answers });
  }
}
// The cells this service answers differently on purpose: `java` is the kind of answer it gives there ("=": an
// answer, where the reference refused or failed; "E": the 500 with the fixed sentence, where the reference refused).
// None at present: the nine cells that were here (an object with a member named toString where the rules read text,
// D-14) are answered as the reference answers them since the SDK release of 2026-11-19.
table.onPurpose = [];
// The verify route's own places: the members of a package, and of the verdict it carries.
const PACKAGE_NODES = [['digest'], ['evidence'], ['policy'], ['verdict'], ['verdict', 'axes'], ['verdict', 'axes', 'matching'], ['verdict', 'axes', 'matching', 'state'], ['verdict', 'axes', 'issuer', 'state'],
  ['verdict', 'policyDigest'], ['verdict', 'findings'], ['schema'], ['generatedAt'], ['verificationMaterial'], ['extra'], ['evidence', 'elements', 'chainTransfer', 'amount'], ['policy', 'amountTolerance']];
table.packageNodes = PACKAGE_NODES;
for (const [n, where] of PACKAGE_NODES.entries()) {
  const answers = [];
  for (const v of VALUES) answers.push(short(await answer('verify', JSON.stringify(cellBody(BASES.verify, ['package', ...where], v)))));
  table.rows.push({ route: 'verify', packageNode: n, answers });
}

// ── the ZIP around the members, and the PDF among them ───────────────────────

const hex = (b) => Buffer.from(b).toString('hex');
const utf16 = (s) => Buffer.from(s, 'utf16le').swap16().toString('hex');
const zip = { crc32: [], stored: [], deflated: [] };
for (const data of [Buffer.alloc(0), Buffer.from('a'), Buffer.from('123456789'), Buffer.from('The quick brown fox jumps over the lazy dog'), Buffer.alloc(1000, 0xff), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
  zip.crc32.push({ hex: hex(data), crc32: crc32(data) });
}
const ENTRY_SETS = {
  'one member': [{ path: 'a.txt', data: 'hello' }],
  'an empty member': [{ path: 'empty', data: '' }],
  'three members, in the order given': [{ path: 'z.json', data: '{"z":1}\n' }, { path: 'a/b/c.txt', data: 'nested' }, { path: 'm.bin', data: '\u0000\u0001\u0002ÿ' }],
  'names that are not ASCII': [{ path: '증빙/evidence — é.json', data: '{}' }, { path: '😀.txt', data: 'x' }],
  'text that compresses': [{ path: 'long.txt', data: 'settlement evidence '.repeat(400) }, { path: 'short.txt', data: 'ab' }],
};
const asEntries = (set) => set.map((e) => ({ path: e.path, data: new Uint8Array(Buffer.from(e.data, 'latin1')) }));
const DATES = ['2026-11-18T10:00:00.000Z', '1980-01-01T00:00:00.000Z', '2026-11-18T23:59:59.999Z', '2107-12-31T23:59:58.000Z', '2108-01-01T00:00:00.000Z', '9999-12-31T23:59:59.000Z'];
for (const [name, set] of Object.entries(ENTRY_SETS)) {
  for (const at of name === 'one member' ? DATES : DATES.slice(0, 1)) {
    const bytes = await writeZip(asEntries(set), { modifiedAt: new Date(at), compress: false });
    zip.stored.push({ name: `${name}, ${at}`, entries: set.map((e) => ({ path: e.path, hex: hex(Buffer.from(e.data, 'latin1')) })), modifiedAt: Date.parse(at), bytes: bytes.length, sha256: sha256(bytes), hex: bytes.length <= 400 ? hex(bytes) : undefined });
  }
  // Compressed: the bytes of the deflate stream are the runtime's, so what is kept is everything around it.
  const packed = Buffer.from(await writeZip(asEntries(set), { modifiedAt: new Date(DATES[0]) }));
  const methods = []; let off = 0;
  while (packed.readUInt32LE(off) === 0x04034b50) { methods.push(packed.readUInt16LE(off + 8)); off += 30 + packed.readUInt16LE(off + 26) + packed.readUInt32LE(off + 18); }
  zip.deflated.push({ name, entries: set.map((e) => ({ path: e.path, hex: hex(Buffer.from(e.data, 'latin1')) })), modifiedAt: Date.parse(DATES[0]), methods });
}
zip.refused = [];
for (const [name, set, at] of [['no members', [], DATES[0]], ['a path from the root', [{ path: '/etc/passwd', data: 'x' }], DATES[0]], ['a path that climbs', [{ path: 'a/../b', data: 'x' }], DATES[0]],
  ['two dots anywhere in a name', [{ path: 'report..final.pdf', data: 'x' }], DATES[0]], ['a name twice', [{ path: 'a', data: '1' }, { path: 'a', data: '2' }], DATES[0]],
  ['a date before 1980', [{ path: 'a', data: '1' }], '1979-12-31T23:59:59.999Z'], ['a name with a quote in it, from the root', [{ path: '/a"b\\c', data: 'x' }], DATES[0]]]) {
  let said;
  try { await writeZip(asEntries(set), { modifiedAt: new Date(at), compress: false }); said = null; } catch (e) { said = e.message; }
  zip.refused.push({ name, entries: set.map((e) => ({ path: e.path, hex: hex(Buffer.from(e.data, 'latin1')) })), modifiedAt: Date.parse(at), message: said });
}

const pdf = { latin1: [], documents: [] };
const LATIN1 = ['', 'plain ASCII ~ text', '‘single’ “double” – — …  nbsp', '→ ← ↑ ↓ ✓ ✗ · •', '① ② ③ ④ ⑤ ⑥ ⑦', 'naïve café ÿ þ \u0080 ÿ Ā', '한국어 text 日本語', '😀 astral, \ud83d half, \ude00 other half',
  'tabs\tand\nbreaks\r\n\u000b\u000c', '\\ ( ) are escaped later', ['ab', 'cd'], ['—', '…', '①'], ['é한', '한é', ''], [['—'], ['…']], [], ['a', 7], ['a', null], [{}], [['x']], ['a', { toString: 1 }], 7, null, true, {}, { 0: 'a', length: 1 }];
for (const value of LATIN1) {
  let out;
  try { out = { text: utf16(toLatin1(value)) }; } catch (e) { out = { engine: `${e?.constructor?.name}: ${e?.message}` }; }
  pdf.latin1.push({ value: JSON.stringify(value), ...out });
}
const DOCUMENTS = {
  'one line': { runs: [{ text: 'Hello' }], title: 'T', footer: 'F' },
  'no runs at all': { runs: [], title: 'Empty', footer: undefined },
  'every font and size, a rule, an indent, space before': { runs: [{ text: 'Heading', font: 'Helvetica-Bold', size: 17 }, { text: 'Body text under a rule', font: 'Helvetica', size: 9.5, spaceBefore: 2, rule: true },
    { text: '0123456789abcdef', font: 'Courier', size: 8.5, indent: 12 }, { text: 'Label', font: 'Helvetica-Bold', size: 9, spaceBefore: 6.25 }, { text: 'default font and size' }, { text: '', rule: true }], title: 'Fonts (and) \\ parentheses', footer: 'StoneHash Attest  ·  EV-1  ·  policy v1' },
  'a paragraph that wraps in each font': { runs: ['Helvetica', 'Helvetica-Bold', 'Courier'].map((font) => ({ text: 'The verdict above is reproducible only against the exact rules that produced it. '.repeat(4), font, size: 9.5 })), title: 'Wrap', footer: 'f' },
  'a token longer than the line, in each font': { runs: ['Helvetica', 'Helvetica-Bold', 'Courier'].map((font) => ({ text: `digest ${'0123456789abcdef'.repeat(16)} end`, font, size: 8.5, indent: 12 })), title: 'Digest', footer: 'f' },
  'wide and narrow letters at the edge of a line': { runs: [{ text: 'W'.repeat(80) }, { text: 'i'.repeat(400) }, { text: 'M W m w I J i j l t . , : ; ! | '.repeat(12) }, { text: `${'@%&'.repeat(30)} ${'~^_`{}[]<>=+*#$"\'/\\?'.repeat(8)}` }], title: 'Widths', footer: 'f' },
  'spaces of every kind': { runs: [{ text: `  two leading ${'and  double   inner '.repeat(10)} and trailing  ` }, { text: `tab\tnewline\nreturn\rvertical\u000bform\u000cnbsp end ${'word '.repeat(40)}` }, { text: ' ' }, { text: '   ' }, { text: ` ${'x'.repeat(120)}` }], title: 'Spaces', footer: 'f' },
  'more lines than a page holds': { runs: Array.from({ length: 130 }, (_, n) => ({ text: `line ${n + 1}`, ...(n % 10 === 0 ? { rule: true, spaceBefore: 4 } : {}) })), title: 'Pages', footer: 'StoneHash Attest  ·  three pages' },
  'a tall line at the foot of a page': { runs: [...Array.from({ length: 48 }, (_, n) => ({ text: `line ${n + 1}` })), { text: 'tall', size: 40 }, { text: 'after' }], title: 'Tall', footer: 'f' },
  'text outside Latin-1, and the punctuation that is mapped': { runs: [{ text: '‘quoted’ “double” – — … → ← ↑ ↓ ✓ ✗ · • ① ② ③ ④ ⑤ ⑥' }, { text: 'naïve café — 한국어 日本語 😀' }, { text: 'é'.repeat(200) }, { text: 'þÿ\u0080ÿ', font: 'Courier' }],
    title: 'Título — 제목', footer: 'pie — 바닥글 · é' },
  'text that is a list': { runs: [{ text: ['ab', 'ç한', '—', '', '한ab'] }, { text: [`${'한'.repeat(3)}`, 'é'.repeat(150)], font: 'Courier' }], title: 'List', footer: 'f' },
  'an indent wider than the page': { runs: [{ text: 'cannot fit', indent: 600 }, { text: '', indent: 600 }, { text: 'after' }], title: 'Indent', footer: 'f' },
  'parentheses and backslashes': { runs: [{ text: 'a (b) c \\ d ((nested)) \\( \\\\' }], title: '(title)', footer: '(footer) \\' },
};
for (const [name, d] of Object.entries(DOCUMENTS)) {
  for (const createdAt of name === 'one line' ? ['2026-11-18T10:00:00.000Z', '2026-01-02T03:04:05.678Z', '+275760-09-13T00:00:00.000Z', '-000001-12-31T23:59:59.999Z'] : ['2026-11-18T10:00:00.000Z']) {
    const bytes = renderPdf(d.runs, { title: d.title, createdAt: new Date(createdAt), ...(d.footer !== undefined ? { footer: d.footer } : {}) });
    pdf.documents.push({ name: `${name}, ${createdAt}`, runs: d.runs, title: d.title, footer: d.footer ?? null, createdAt: Date.parse(createdAt), bytes: bytes.length, sha256: sha256(bytes),
      latin1: bytes.length <= 1400 ? Buffer.from(bytes).toString('latin1') : undefined });
  }
}

// A header the server may write, as Node decides it: what the archive route puts into `content-disposition`.
const headers = [];
for (const value of ['EV-2026-0001', 'a b\tc', 'quote " and \\ backslash', 'é ÿ \u0080', '', 'line\nbreak', 'return\r', 'null\u0000', 'del\u007f', 'unit separator\u001f', '한국어', '😀', 'é', 'Ā', '\ud83d']) {
  let valid = true;
  try { validateHeaderValue('content-disposition', value); } catch { valid = false; }
  headers.push({ value: utf16(value), valid });
}

// ── write, or compare ────────────────────────────────────────────────────────

const catalogue = await sbx.catalogue({});
const out = {
  material: `${JSON.stringify(material, null, 1)}\n`,
  keys: `${JSON.stringify(keys, null, 1)}\n`,
  vectors: `${JSON.stringify({
    note: 'Generated by apps/core-java/tools/make-sandbox-vectors.mjs from apps/core/src/http/{sandbox,evidence}.ts and packages/attest-evidence/src. Do not edit by hand. '
      + 'Every answer is the reference\'s; where the Java service answers differently on purpose the case says so (java, why).',
    clock: NOW, uuid: UUID,
    catalogue,
    parts, cases, table, zip, pdf, headers,
  }, null, 1)}\n`,
};
const cells = table.rows.reduce((n, r) => n + r.answers.length, 0);
const counts = `${cases.length} named cases, ${cells} cells of the table (${table.rows.length} rows × ${VALUES.length} values), ${zip.crc32.length + zip.stored.length + zip.deflated.length + zip.refused.length} ZIP, `
  + `${pdf.latin1.length + pdf.documents.length} PDF, ${headers.length} header values`;
if (check) {
  const stale = Object.keys(FILES).filter((k) => !existsSync(FILES[k]) || readFileSync(FILES[k], 'utf8') !== out[k]);
  if (stale.length > 0) {
    console.error(`${stale.map((k) => path.basename(FILES[k])).join(', ')} differ${stale.length === 1 ? 's' : ''} from what the reference answers now — run without --check and review the change`);
    process.exit(1);
  }
  console.log(`material.json, demo-issuer-keys.json and sandbox.json are current (${counts})`);
} else {
  for (const k of Object.keys(FILES)) { mkdirSync(path.dirname(FILES[k]), { recursive: true }); writeFileSync(FILES[k], out[k]); }
  console.log(`wrote ${Object.values(FILES).map((f) => path.relative(process.cwd(), f)).join(', ')} — ${counts}`);
  const kinds = {};
  for (const c of cases) { const k = c.answer.sha256 || c.answer.archive ? '200' : c.answer.plain !== undefined ? '500 in its own words' : c.answer.engine !== undefined ? '500 from the engine' : `${c.answer.status} ${c.answer.error}${c.answer.engineWorded ? ' (engine-worded)' : ''}`; kinds[k] = (kinds[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(kinds).sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`  ${cases.filter((c) => 'java' in c).length} named cases where the Java service answers differently on purpose`);
}
