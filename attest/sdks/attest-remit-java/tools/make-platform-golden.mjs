/**
 * Writes the vectors the Java SDK's `Conventions` and the public half of
 * `TravelRule` are held to: what the platform's own code — `apps/core/src/remit`
 * and `packages/attest-rules`, read here and never written — produces for the
 * same inputs.
 *
 *   node sdks/attest-remit-java/tools/make-platform-golden.mjs          write golden/conventions.json and golden/travel-rule.json
 *   node sdks/attest-remit-java/tools/make-platform-golden.mjs --check  fail when a file on disk differs
 *
 * The output is a function of the platform's source and the cases below.
 * The one thing that cannot be reproduced — a signature — is kept from the
 * file already there as long as the platform still verifies it, so a second
 * run writes the same bytes. The signing key is the test key of
 * `golden/signing.json` (written by `make-golden.mjs`, which is run first).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64Url, keyring, signedBytes, signedDigest, toBase64Url, verifyEvidenceSignatures, SIGNATURE_DOMAIN } from '../../../packages/attest-rules/src/index.ts';
import {
  DIGEST_DOMAIN, EVENT_DOMAIN, elementDigest, eventSigningBytes, signEvent, signEvidenceElement, spkiToJwk, verifyEvent,
} from '../../../apps/core/src/remit/sign.ts';
import { EVIDENCE_COMMIT_DOMAIN, packageCommitment } from '../../../apps/core/src/remit/evidence.ts';
import { REQUIRED_TRAVEL_RULE_FIELDS, buildIvms101, missingTravelRuleFields } from '../../../apps/core/src/remit/ivms101.ts';
import { concatKdf } from '../../../apps/core/src/remit/jwe.ts';
import { jcs } from '../../../packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, '../src/test/resources/golden');
const check = process.argv.includes('--check');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const names = new Set();
const unique = (section, name) => {
  if (names.has(`${section}:${name}`)) throw new Error(`${section}: two cases are named ${name}`);
  names.add(`${section}:${name}`);
};

const signing = read(path.join(GOLDEN, 'signing.json'));
const sandbox = read(path.resolve(HERE, '../src/test/resources/evidence/sandbox-anchored.json'));
const testKey = createPrivateKey(signing.testKey.pkcs8Pem);
const { spkiBase64, keyId, issuer } = signing.testKey;
const before = { conventions: null, travelRule: null };
for (const [k, file] of [['conventions', 'conventions.json'], ['travelRule', 'travel-rule.json']]) {
  if (existsSync(path.join(GOLDEN, file))) before[k] = read(path.join(GOLDEN, file));
}

// ═══ conventions.json ═══════════════════════════════════════════════════════

// ── what is signed, and what is hashed ─────────────────────────────────────

const E = sandbox.package.evidence.elements;
const plain = { ref: 'PAY-1', amount: '2500.00', currency: 'USD' };
const events = [];
function eventCase(name, payload) {
  unique('events', name);
  const bytes = attempt(() => eventSigningBytes(payload));
  events.push({ name, payload, ...(bytes.threw ? { threw: bytes.threw } : { signingBytesHex: hex(bytes), signingDigest: sha256(bytes) }) });
}
eventCase('an authorisation', { payment_id: 'PAY-20261118-6f1e6bf387', instruction_ref: 'OUT-1', amount: '2500.00', currency: 'USD', at: '2026-11-18T03:03:48.052Z' });
eventCase('members in another order', { at: '2026-11-18T03:03:48.052Z', currency: 'USD', amount: '2500.00', instruction_ref: 'OUT-1', payment_id: 'PAY-20261118-6f1e6bf387' });
eventCase('nested, with a list and whole numbers', { payment_id: 'PAY-1', answers: [{ q: 1, a: 'yes' }, { q: 2, a: null }], n: 9007199254740991, ok: true, none: false });
eventCase('text that needs escaping, and text outside the basic plane', { note: 'line\nbreak "quoted" back\\slash \u0001 é 한 😀  ', '': 'empty name', 'é': 1, 'z': 2, 'a': 3 });
eventCase('names that sort by code unit, not by code point', { '': 1, '😀': 2, '퟿': 3, 10: 'ten', 9: 'nine' });
eventCase('an empty object', {});
eventCase('a list', [1, 'two', null]);
eventCase('text', 'webhook');
eventCase('null', null);
eventCase('a number that is not whole', { rate: 1.5 });
eventCase('a whole number too large', { n: 9007199254740992 });

const elements = [];
function elementCase(name, element) {
  unique('elements', name);
  const bytes = attempt(() => signedBytes(element));
  const digest = attempt(() => elementDigest(element));
  elements.push({ name, element, ...(bytes.threw ? { signingThrew: bytes.threw } : { signingBytesHex: hex(bytes), signingDigest: signedDigest(element) }),
    ...(digest.threw ? { digestThrew: digest.threw } : { contentDigest: digest }) });
}
elementCase('a plain element', plain);
for (const [k, v] of Object.entries(E)) elementCase(`the sandbox settlement's ${k}`, Array.isArray(v) ? v[0] : v);
elementCase('with every member that is outside the signature', { ...plain, signature: { status: 'VALID', value: 'AAAA' }, digestVerified: true, attached: ['invoice'], citedOnly: [] });
elementCase('with a digest, which the signature covers and the digest itself does not', { ...plain, digest: 'a'.repeat(64) });
elementCase('with a digest that is not text', { ...plain, digest: null });
elementCase('with nested members named like the excluded ones', { ...plain, inner: { signature: 'kept', digest: 'kept', attached: 'kept', citedOnly: 'kept', digestVerified: 'kept' } });
elementCase('nothing but excluded members', { signature: {}, digest: 'x', digestVerified: false, attached: [], citedOnly: [] });
elementCase('empty', {});
elementCase('with a number that is not whole', { ...plain, rate: 1.335 });
elementCase('with text outside the basic plane and names that need sorting', { z: '😀', a: 'é', '': 1, '😀': 2, B: [3, { y: 1, x: 2 }] });

// ── signatures made by the platform, which the Java SDK must verify ────────

/** A signature made on an earlier run is kept while the platform still verifies it: a new one would be other bytes. */
const kept = (section, name, stillGood) => {
  const old = before.conventions?.signedByPlatform?.[section]?.find((c) => c.name === name);
  return old && stillGood(old) ? old : null;
};
const signedEvents = [];
for (const c of events.filter((e) => !e.threw)) {
  const old = kept('events', c.name, (o) => JSON.stringify(o.payload) === JSON.stringify(c.payload) && verifyEvent(o.payload, o.sig, spkiBase64));
  signedEvents.push(old ?? { name: c.name, payload: c.payload, sig: signEvent(c.payload, testKey, keyId, issuer) });
}
const ring = keyring([{ keyId, issuer, trustLevel: 'ATTESTED', publicKeyJwk: spkiToJwk(spkiBase64) }]);
const verifiesAsElement = async (element) => {
  const out = await verifyEvidenceSignatures({ elements: { bankInstruction: element } }, ring);
  return out.elements.bankInstruction.signature.status === 'VALID';
};
const signedElements = [];
for (const c of elements.filter((e) => !e.signingThrew)) {
  let old = kept('elements', c.name, (o) => JSON.stringify({ ...o.signed, signature: undefined }) === JSON.stringify({ ...c.element, signature: undefined }));
  if (old && !(await verifiesAsElement(old.signed))) old = null;
  // As the platform signs: over the element as it stands — no digest is added, and one it carries is covered.
  signedElements.push(old ?? { name: c.name, signed: signEvidenceElement(c.element, testKey, keyId, issuer) });
}

// ── verifyEvent: what the platform takes for a valid envelope ──────────────

const payload = events[0].payload;
const good = signedEvents[0].sig;
const raw = Buffer.from(fromBase64Url(good.sig));
/** A key and a signature of another kind, kept from the last run as long as the platform still takes it for an event signature. */
let rsa = before.conventions?.otherKey;
if (!rsa || !verifyEvent(payload, { alg: 'ES256', sig: rsa.sig }, rsa.spkiBase64)) {
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsa = { note: 'an RSA key and its PKCS#1 v1.5 signature over the first event\'s signing bytes', spkiBase64: kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sig: toBase64Url(new Uint8Array(nodeSign('sha256', eventSigningBytes(payload), kp.privateKey))) };
}
const otherSpki = sandbox.package.trust_registry.institutions.find((i) => i.signing_spki).signing_spki;
const verifications = [];
function verifyCase(name, p, sig, spki, java) {
  unique('verifyEvent', name);
  const expected = attempt(() => verifyEvent(p, sig, spki));
  // `java` is stated only where the Java SDK answers otherwise, on purpose.
  verifications.push({ name, payload: p, sig, spki, ...(expected?.threw ? { threw: expected.threw } : { expected }), ...(java === undefined ? {} : { java }) });
}
verifyCase('as signed', payload, good, spkiBase64);
verifyCase('the envelope with its members in another order, and one more', payload, { sig: good.sig, note: 'x', issuer: 'Somebody Else', key_id: 'other', alg: 'ES256' }, spkiBase64);
verifyCase('the envelope with nothing but alg and sig', payload, { alg: 'ES256', sig: good.sig }, spkiBase64);
verifyCase('the payload with its members in another order', Object.fromEntries(Object.entries(payload).reverse()), good, spkiBase64);
verifyCase('the payload changed', { ...payload, amount: '2500.01' }, good, spkiBase64);
verifyCase('the payload with a member more', { ...payload, note: '' }, good, spkiBase64);
verifyCase('another payload altogether', events[2].payload, good, spkiBase64);
verifyCase('a payload with no canonical form', { rate: 1.5 }, good, spkiBase64);
verifyCase('another key', payload, good, otherSpki);
verifyCase('another algorithm named', payload, { ...good, alg: 'ES384' }, spkiBase64);
verifyCase('the algorithm in lower case', payload, { ...good, alg: 'es256' }, spkiBase64);
verifyCase('no algorithm named', payload, { sig: good.sig }, spkiBase64);
verifyCase('an algorithm that is a list', payload, { ...good, alg: ['ES256'] }, spkiBase64);
verifyCase('no signature', payload, { alg: 'ES256' }, spkiBase64);
verifyCase('an empty signature', payload, { alg: 'ES256', sig: '' }, spkiBase64);
verifyCase('a signature that is null', payload, { alg: 'ES256', sig: null }, spkiBase64);
verifyCase('a signature that is a number', payload, { alg: 'ES256', sig: 12345 }, spkiBase64);
verifyCase('a signature that is a list', payload, { alg: 'ES256', sig: [good.sig] }, spkiBase64);
verifyCase('the signature in the standard alphabet, padded', payload, { ...good, sig: raw.toString('base64') }, spkiBase64);
verifyCase('the signature with padding it does not need', payload, { ...good, sig: `${good.sig}==` }, spkiBase64);
verifyCase('the signature with one padding character too many', payload, { ...good, sig: `${good.sig}===` }, spkiBase64);
verifyCase('the signature with a line break in it', payload, { ...good, sig: `${good.sig.slice(0, 40)}\r\n${good.sig.slice(40)}` }, spkiBase64);
verifyCase('the signature with spaces around it', payload, { ...good, sig: ` ${good.sig}\t` }, spkiBase64);
verifyCase('the signature with a non-breaking space after it', payload, { ...good, sig: `${good.sig} ` }, spkiBase64);
verifyCase('the signature cut short', payload, { ...good, sig: good.sig.slice(0, -2) }, spkiBase64);
verifyCase('the signature twice over', payload, { ...good, sig: good.sig + good.sig }, spkiBase64);
verifyCase('the signature with one byte changed', payload, { ...good, sig: toBase64Url(Uint8Array.from(raw, (b, i) => (i === 5 ? b ^ 1 : b))) }, spkiBase64);
verifyCase('the signature as DER', payload, { ...good, sig: derOf(raw) }, spkiBase64);
verifyCase('a signature of zeros', payload, { ...good, sig: toBase64Url(new Uint8Array(64)) }, spkiBase64);
verifyCase('a signature that is not base64', payload, { ...good, sig: '*'.repeat(86) }, spkiBase64);
verifyCase('the key with line breaks in it', payload, good, spkiBase64.replace(/(.{32})/g, '$1\n'));
verifyCase('the key in the URL-safe alphabet, without padding', payload, good, Buffer.from(spkiBase64, 'base64').toString('base64url'));
verifyCase('the key as a PEM block', payload, good, createPublicKey(testKey).export({ format: 'pem', type: 'spki' }));
verifyCase('the key with something after its padding', payload, good, `${spkiBase64}AAAA`);
verifyCase('a key that is no key', payload, good, 'AAAA');
verifyCase('an empty key', payload, good, '');
verifyCase('a key that is null', payload, good, null);
verifyCase('a key that is a number', payload, good, 7);
verifyCase('an envelope that is null', payload, null, spkiBase64, false);
verifyCase('an envelope that is text', payload, 'signed', spkiBase64);
verifyCase('an envelope that is a list', payload, [good], spkiBase64);
verifyCase('a P-384 key', payload, good, 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEtBTz2MUAjVytNNvkDFEzfnN2NP3F52CG/esSlte0EEcZoB9zJ1CJkW13ZZ5oJw77Nc1gavdpo/2XMC6IL2Hh7s1ihdcuGmHhpdLJwZagUzLiCGeegc61fNvmLvyYOvhw');
verifyCase('an Ed25519 key', payload, good, 'MCowBQYDK2VwAyEAY0FGd1FX6rrwLDNTz52DSxMa7cvoJBeucGzr99R3/V4=');
// The one place the Java SDK is stricter on purpose: ES256 is ECDSA on P-256, and a key of another kind verifies nothing —
// where the platform's runtime checks a signature of whatever kind the key is.
verifyCase('an RSA key, and an RSA signature over the same bytes', payload, { alg: 'ES256', sig: rsa.sig }, rsa.spkiBase64, false);

/** r ‖ s as the DER a general-purpose signer returns, base64url: not what travels, and not taken. */
function derOf(rs) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const v = b.subarray(i); return Buffer.concat([Buffer.from([2, v.length + (v[0] & 0x80 ? 1 : 0)]), v[0] & 0x80 ? Buffer.from([0]) : Buffer.alloc(0), v]); };
  const body = Buffer.concat([int(rs.subarray(0, 32)), int(rs.subarray(32))]);
  return toBase64Url(new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body])));
}

// ── the evidence-package commitment ────────────────────────────────────────

const commitments = [];
function commitmentCase(name, pkg, nonce, java) {
  unique('commitments', name);
  const value = attempt(() => packageCommitment(pkg, nonce));
  commitments.push({ name, package: pkg, nonce, ...(value?.threw ? { threw: value.threw } : { value }), ...(java === undefined ? {} : { java }) });
}
commitmentCase('the sandbox settlement\'s package, under its own nonce', sandbox.package, sandbox.commitment.nonce);
if (commitments[0].value !== sandbox.commitment.value) throw new Error('the platform no longer commits to the sandbox package as it did');
commitmentCase('a small package', { schema: 'x', payment_id: 'PAY-1', evidence: { elements: {} } }, 'ab'.repeat(32));
commitmentCase('the same package, its members in another order', { evidence: { elements: {} }, payment_id: 'PAY-1', schema: 'x' }, 'ab'.repeat(32));
commitmentCase('the same package under another nonce', { schema: 'x', payment_id: 'PAY-1', evidence: { elements: {} } }, 'cd'.repeat(32));
commitmentCase('a nonce in capitals', { schema: 'x' }, 'AB'.repeat(32));
commitmentCase('a short nonce', { schema: 'x' }, '00');
commitmentCase('an empty nonce', { schema: 'x' }, '');
commitmentCase('a package that is a list', [1, 2], 'ab'.repeat(32));
commitmentCase('a package that is null', null, 'ab'.repeat(32));
commitmentCase('a package with no canonical form', { rate: 1.5 }, 'ab'.repeat(32));
// A nonce that is not hex: the platform's runtime uses the part of it that is, without saying so; the Java SDK refuses.
commitmentCase('a nonce with an odd number of digits', { schema: 'x' }, 'abc', 'invalid_nonce');
commitmentCase('a nonce that stops being hex', { schema: 'x' }, 'abzz', 'invalid_nonce');
commitmentCase('a nonce with a space in it', { schema: 'x' }, 'ab cd', 'invalid_nonce');

// ── base64 ─────────────────────────────────────────────────────────────────

const bytes64 = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
const b64u = bytes64.toString('base64url');
const base64 = ['', 'A', 'AA', 'AAA', 'AAAA', 'AAAAA', 'AQ', 'AQ=', 'AQ==', 'AQ===', 'AQI', 'AQI=', 'AQID', 'AQID=', '-_-_', '+/+/', '-_+/', 'A-_A', ' AQID', 'AQID ', 'AQ ID', 'AQ\nID', 'AQ\tID', 'AQ\r\nID',
  'AQ\fID', 'AQ\u000bID', 'AQ ID', 'AQ=ID', 'A=QID', '=AQID', 'AQ==AQID', '*', 'AQ*D', 'AQI*', 'é', 'AQIé', '한글', 'AQID😀', '....', 'AQ.ID', 'AB', 'AB==', 'AC', 'AR', 'AQJ', 'AQK',
  b64u, `${b64u}=`, `${b64u}==`, bytes64.toString('base64'), bytes64.toString('base64').replace(/(.{20})/g, '$1\n'), b64u.slice(0, -1), b64u.slice(0, -2), b64u.slice(0, -3),
  `-----BEGIN PUBLIC KEY-----\n${spkiBase64}\n-----END PUBLIC KEY-----\n`, spkiBase64, `${spkiBase64}\n`, spkiBase64.replace(/=+$/, '')];
const base64Cases = base64.map((text) => {
  const forgiving = attempt(() => hex(fromBase64Url(text)));
  return { text, forgiving: forgiving.threw ? null : forgiving, lenient: Buffer.from(text, 'base64').toString('hex') };
});
const encodings = [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xfb, 0xff]), Buffer.from([0xfb, 0xff, 0xbf]), Buffer.from([1, 2, 3, 4]), bytes64, Buffer.from('한글 😀', 'utf8')]
  .map((b) => ({ hex: hex(b), base64url: toBase64Url(new Uint8Array(b)) }));

const conventions = {
  note: 'Generated by tools/make-platform-golden.mjs from the platform\'s own code (apps/core/src/remit, packages/attest-rules). Do not edit by hand.',
  domains: { event: EVENT_DOMAIN, elementSignature: SIGNATURE_DOMAIN, elementDigest: DIGEST_DOMAIN, commitment: EVIDENCE_COMMIT_DOMAIN },
  events,
  elements,
  signedByPlatform: { key: { spkiBase64, keyId, issuer }, events: signedEvents, elements: signedElements },
  otherKey: rsa,
  verifyEvent: verifications,
  commitments,
  base64: { decode: base64Cases, encode: encodings },
};

// ═══ travel-rule.json ═══════════════════════════════════════════════════════

const originator = { name: 'Saigon Import Co., Ltd.', country: 'VN', address: '12 Le Loi, Ho Chi Minh City', registration_number: '0312345678', account: 'VN-ACC-1' };
const beneficiary = { name: 'Lion City Exports Pte. Ltd.', country: 'SG', account: 'SG-ACC-9', bank: 'Demo Payout Bank' };
const context = {
  paymentId: 'PAY-20261118-6f1e6bf387', tradeAmount: '2500.00', tradeCurrency: 'USD',
  originatingInstitution: { id: 'VN-BANK-001', name: 'Vietnam Commercial Bank (sim)', country: 'VN' },
  beneficiaryInstitution: { id: 'SG-BFI-001', name: 'Triple-A profile BFI (sim)', country: 'SG' },
  settlementEntity: { id: 'SETTLE-ENTITY-001', name: 'Licensed Settlement Entity (sim)' },
  usdcAmount: '2500.00',
};
const partyData = [
  ['what a bank submits', { format: 'IVMS101', mode: 'A', originator, beneficiary, purpose_code: 'TRADE' }],
  ['no purpose code', { originator, beneficiary }],
  ['an empty purpose code', { originator, beneficiary, purpose_code: '' }],
  ['a purpose code that is a number', { originator, beneficiary, purpose_code: 310 }],
  ['a purpose code that is zero', { originator, beneficiary, purpose_code: 0 }],
  ['an LEI for a registration number', { originator: { ...originator, registration_number: '5493001KJTIIGC8Y1R12' }, beneficiary: { ...beneficiary, registration_number: '529900T8BM49AURSDO55' } }],
  ['registration numbers that are nearly LEIs', { originator: { ...originator, registration_number: '5493001KJTIIGC8Y1R1' }, beneficiary: { ...beneficiary, registration_number: '5493001kjtiigc8y1r12' } }],
  ['a registration number that is an LEI and a line break', { originator: { ...originator, registration_number: '5493001KJTIIGC8Y1R12\n' }, beneficiary }],
  ['a registration number that is a number of twenty digits', { originator: { ...originator, registration_number: 12345678901234567000 }, beneficiary }],
  ['a registration number that is a list', { originator: { ...originator, registration_number: ['5493001KJTIIGC8Y1R12'] }, beneficiary }],
  // The reference tests a registration number as text. An object with a member of its own named toString — or a list
  // holding one — is a value its engine can make no text of: it fails there. A member named valueOf alone is harmless.
  ['a registration number that is an object with a member named toString', { originator: { ...originator, registration_number: { toString: 1 } }, beneficiary }],
  ['a registration number that is an object whose toString is null', { originator, beneficiary: { ...beneficiary, registration_number: { toString: null } } }],
  ['a registration number that is a list holding such an object', { originator, beneficiary: { ...beneficiary, registration_number: ['x', { toString: 'y', valueOf: 2 }] } }],
  ['a registration number that is an object with a member named valueOf', { originator: { ...originator, registration_number: { valueOf: 1 } }, beneficiary }],
  ['a registration number that is a list holding an object with a member named valueOf', { originator: { ...originator, registration_number: [{ valueOf: 1 }] }, beneficiary }],
  ['every other field an object with a member named toString', { originator: { ...originator, name: { toString: 1 }, country: { toString: 1 }, address: { toString: 1 }, account: { toString: 1 } },
    beneficiary: { name: { toString: 1 }, country: { toString: 1 }, account: { toString: 1 }, bank: { toString: 1 } }, purpose_code: { toString: 1 } }],
  ['no originator', { beneficiary }],
  ['no beneficiary', { originator }],
  ['neither', {}],
  ['parties that are null', { originator: null, beneficiary: null }],
  ['parties that are text', { originator: 'Saigon Import', beneficiary: 'Lion City' }],
  ['parties that are lists', { originator: [originator], beneficiary: [beneficiary] }],
  ['parties that are numbers', { originator: 7, beneficiary: 0 }],
  ['parties that are empty', { originator: {}, beneficiary: {} }],
  ['every field empty', { originator: { name: '', country: '', address: '', registration_number: '', account: '' }, beneficiary: { name: '', country: '', account: '', bank: '' } }],
  ['every field white space', { originator: { name: ' ', country: '\t', address: '\n', registration_number: ' ', account: '　' }, beneficiary: { name: '﻿', country: ' \r\n', account: ' ', bank: '​' } }],
  ['every field null', { originator: { name: null, country: null, address: null, registration_number: null, account: null }, beneficiary: { name: null, country: null, account: null, bank: null } }],
  ['fields that are numbers', { originator: { name: 7, country: 704, address: 12, registration_number: 312345678, account: 1 }, beneficiary: { name: 0, country: 0, account: 0, bank: 0 } }],
  ['fields that are true, lists and objects', { originator: { name: true, country: ['VN'], address: { line: '12 Le Loi' }, registration_number: [], account: {} }, beneficiary: { name: [], country: {}, account: false, bank: true } }],
  ['an address without a country', { originator: { name: 'Saigon Import', address: '12 Le Loi' }, beneficiary }],
  ['an address with a country that is null', { originator: { name: 'Saigon Import', address: '12 Le Loi', country: null }, beneficiary }],
  ['an address with a country that is zero', { originator: { name: 'Saigon Import', address: '12 Le Loi', country: 0 }, beneficiary }],
  ['a beneficiary bank that is empty', { originator, beneficiary: { ...beneficiary, bank: '' } }],
  ['a beneficiary bank that is null', { originator, beneficiary: { ...beneficiary, bank: null } }],
  ['a beneficiary bank that is not text', { originator, beneficiary: { ...beneficiary, bank: { bic: 'DEMOSGSG' } } }],
  ['members nobody asked for, and the asked-for ones in another order', { beneficiary: { bank: 'Demo Payout Bank', swift: 'x', account: 'SG-ACC-9', country: 'SG', name: 'Lion City Exports Pte. Ltd.' }, originator: { ...originator, lei: 'x' }, extra: 1 }],
  ['names outside the basic plane', { originator: { ...originator, name: 'Công ty TNHH Sài Gòn 😀', address: '東京都 "quoted" \\  ' }, beneficiary }],
  ['an amount of another kind in the context', { originator, beneficiary }, { ...context, tradeAmount: 2500, usdcAmount: null }],
  ['a context that leaves things out', { originator, beneficiary }, { paymentId: 'PAY-1', originatingInstitution: { id: 'VN-BANK-001' }, beneficiaryInstitution: {}, settlementEntity: { name: 'Settlement' } }],
  ['compliance that is text', 'IVMS101'],
  ['compliance that is a list', [{ originator, beneficiary }]],
  ['compliance that is a number', 7],
  ['compliance that is null', null],
];
const messages = [];
const missing = [];
for (const [name, compliance, ctx = context] of partyData) {
  unique('travelRule', name);
  const absent = attempt(() => missingTravelRuleFields(compliance));
  missing.push({ name, compliance, ...(absent?.threw ? { threw: absent.threw } : { missing: absent }) });
  const message = attempt(() => clone(buildIvms101(compliance, ctx)));
  if (message?.threw) { messages.push({ name, compliance, context: ctx, threw: message.threw }); continue; }
  // What the platform encrypts is the message as JSON text; what the evidence carries is the digest of its canonical form.
  const digest = attempt(() => sha256(Buffer.from(jcs(message))));
  messages.push({ name, compliance, context: ctx, message, json: JSON.stringify(message), ...(digest?.threw ? { digestThrew: digest.threw } : { digest }) });
}

const z = Buffer.from([158, 86, 217, 29, 129, 113, 53, 211, 114, 131, 66, 131, 191, 132, 38, 156, 251, 49, 110, 163, 218, 128, 106, 72, 246, 218, 167, 121, 140, 254, 144, 196]);
const kdf = [];
function kdfCase(name, secret, bits, alg, apu = '', apv = '') {
  unique('kdf', name);
  kdf.push({ name, z: hex(secret), bits, alg, apu, apv, key: hex(concatKdf(secret, bits, alg, apu, apv)) });
}
kdfCase('the vector of RFC 7518, Appendix C', z, 128, 'A128GCM', 'Alice', 'Bob');
if (Buffer.from(kdf[0].key, 'hex').toString('base64url') !== 'VqqN6vgjbSBcIijNcacQGg') throw new Error('the platform no longer derives the RFC 7518 Appendix C key');
kdfCase('the key a Travel Rule message is encrypted with', z, 256, 'A256GCM');
kdfCase('192 bits', z, 192, 'A192GCM');
kdfCase('more than one block', z, 512, 'A256CBC-HS512');
kdfCase('three blocks, and a little more', z, 776, 'X');
kdfCase('eight bits', z, 8, 'A256GCM');
kdfCase('party infos outside ASCII', z, 256, 'A256GCM', 'Công ty', '한글 😀');
kdfCase('an empty algorithm id', z, 256, '');
kdfCase('a secret of one byte', Buffer.from([7]), 256, 'A256GCM');
kdfCase('an empty secret', Buffer.alloc(0), 256, 'A256GCM');
kdfCase('a secret of zeros', Buffer.alloc(32), 256, 'A256GCM');
kdfCase('a long secret', Buffer.from(Array.from({ length: 200 }, (_, i) => i)), 256, 'A256GCM');

const travelRule = {
  note: 'Generated by tools/make-platform-golden.mjs from the platform\'s own code (apps/core/src/remit). Do not edit by hand.',
  required: [...REQUIRED_TRAVEL_RULE_FIELDS],
  // The key a Travel Rule message is encrypted to in the tests: the public half of the test key of signing.json.
  recipient: { keyId: 'SG-BFI-001-ENC', publicJwk: createPublicKey(testKey).export({ format: 'jwk' }) },
  missing,
  messages,
  kdf,
};

// ── Write, or compare ──────────────────────────────────────────────────────

const lines = (list) => `[\n${list.map((c) => `   ${JSON.stringify(c)}`).join(',\n')}\n  ]`;
/** Top-level members one to a line, a list one case to a line. */
const write = (doc) => `{\n${Object.entries(doc).map(([k, v]) => ` ${JSON.stringify(k)}: ${Array.isArray(v) && v.length && typeof v[0] === 'object' ? lines(v)
  : v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(Array.isArray)
    ? `{\n${Object.entries(v).map(([k2, v2]) => `  ${JSON.stringify(k2)}: ${Array.isArray(v2) ? lines(v2) : JSON.stringify(v2)}`).join(',\n')}\n }`
    : JSON.stringify(v)}`).join(',\n')}\n}\n`;
let stale = false;
for (const [file, doc] of [['conventions.json', conventions], ['travel-rule.json', travelRule]]) {
  const text = write(doc);
  JSON.parse(text);
  const out = path.join(GOLDEN, file);
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== text) {
      console.error(`${file} differs from what the platform's code answers now — run without --check and review the change`);
      stale = true;
    }
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${path.relative(process.cwd(), out)} — ${(text.length / 1000).toFixed(0)} kB`);
  }
}
if (stale) process.exit(1);
const refused = (list, key = 'threw') => list.filter((c) => c[key]).length;
console.log(`${check ? 'conventions.json is current' : ' '} — events ${events.length} (${refused(events)} with no canonical form), elements ${elements.length} (${refused(elements, 'signingThrew')}), `
  + `signed by the platform ${signedEvents.length} events and ${signedElements.length} elements, verifyEvent ${verifications.length} `
  + `(${verifications.filter((c) => c.expected === true).length} taken, ${refused(verifications)} where the platform's engine fails, ${verifications.filter((c) => c.java !== undefined).length} the Java SDK answers otherwise), `
  + `commitments ${commitments.length} (${refused(commitments)} refused, ${commitments.filter((c) => c.java).length} the Java SDK refuses), `
  + `base64 ${base64Cases.length} to decode (${base64Cases.filter((c) => c.forgiving === null).length} not base64) and ${encodings.length} to encode`);
console.log(`${check ? 'travel-rule.json is current' : ' '} — ${missing.length} payloads checked for required fields (${refused(missing)} where the platform's engine fails), `
  + `${messages.length} messages (${refused(messages)} where it fails, ${refused(messages, 'digestThrew')} with no canonical form), ${kdf.length} derived keys`);
