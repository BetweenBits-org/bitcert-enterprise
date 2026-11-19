/**
 * Settlement evidence without a record: the evaluation sandbox's material
 * (scenarios, tampers, packages) and the two stateless endpoints it feeds —
 * the verdict as data, and the evidence archive.
 *
 * Nothing here is stored, so the order matters only where one answer goes
 * into the next request: the evidence a scenario gives is reconciled and
 * archived, a package one service seals is verified by the other.
 *
 * The starting documents are the Java service's own
 * (src/main/resources/sandbox/material.json, which tools/make-sandbox-vectors.mjs
 * writes from the reference's); the sealed package is the one the reference
 * sealed for the vectors, so that both services are sent the same bytes.
 *
 * A tamper on a target named like a member every JavaScript object has
 * (`__proto__`, `constructor`) finds no element of that name, in both
 * services. Until 2026-11-18 the reference wrote onto its own engine's
 * objects there, and every answer of that process was different from then on
 * (docs/JAVA-INTENDED-DIFFERENCES.md, D-13 — closed by a fix in the
 * reference). The digest cases are sent last among the evidence cases: if
 * that defect ever came back, the cases after them would say so.
 *
 * No request of this file reaches a wallet, a chain or the store.
 */
import { readFileSync } from 'node:fs';

const material = JSON.parse(readFileSync(new URL('../../src/main/resources/sandbox/material.json', import.meta.url), 'utf8'));
const vectors = JSON.parse(readFileSync(new URL('../../src/test/resources/vectors/sandbox.json', import.meta.url), 'utf8'));
const S = material.settlement;
const P = material.policy;
const sealed = JSON.parse(vectors.parts['"@@sealed"']);
const J = { 'Content-Type': 'application/json' };
const clone = (v) => structuredClone(v);
const edit = (v, change) => { const c = clone(v); change(c); return c; };
const withElement = (name, change) => edit(S, (e) => { e.elements[name] = change(e.elements[name]); });

export default ({ seed }) => {
  const C = seed.console;
  const key = { Authorization: `Bearer ${C.keys.primary.secret}` };
  const main = { Cookie: `stonehash_session=${C.sessions.main}` };
  const cases = [];
  const add = (...c) => cases.push(...c);
  /** A request as the organisation's key, unless `as` says who else. */
  const post = (name, target, body, { as = key, ...extra } = {}) => ({ name, method: 'POST', target, headers: { ...J, ...as }, body, ...extra });
  const get = (name, target, as = key, extra = {}) => ({ name, target, headers: as, ...extra });

  const sb = '/v1/console/sandbox';
  const ev = `${sb}/evidence`;
  const pk = `${sb}/package`;
  const vf = `${sb}/package/verify`;
  const rc = '/v1/settlements/reconcile';
  const bn = '/v1/settlements/bundle';

  // ── who is let in ─────────────────────────────────────────────────────────
  // A key, or — in the sandbox — the console's session. The same door on all six.
  for (const [method, target] of [['GET', sb], ['POST', ev], ['POST', pk], ['POST', vf], ['POST', rc], ['POST', bn]]) {
    const base = { method, target, ...(method === 'POST' ? { body: {} } : {}) };
    const h = method === 'POST' ? J : {};
    add(
      { name: `${method} ${target} without a key`, ...base, headers: h },
      { name: `${method} ${target} with a revoked key`, ...base, headers: { ...h, Authorization: `Bearer ${C.keys.revoked.secret}` } },
      { name: `${method} ${target} with a key nobody issued`, ...base, headers: { ...h, Authorization: 'Bearer sk_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
      { name: `${method} ${target} with an expired session`, ...base, headers: { ...h, Cookie: `stonehash_session=${C.sessions.expired}` } },
      { name: `${method} ${target} with a session`, ...base, headers: { ...h, ...main } },
      { name: `${method} ${target} with a key`, ...base, headers: { ...h, ...key } },
    );
  }
  add(
    { name: 'the catalogue asked for with POST', method: 'POST', target: sb, headers: { ...J, ...key }, body: {} },
    { name: 'the catalogue with a slash after it', target: `${sb}/`, headers: key },
    { name: 'the catalogue as HEAD', method: 'HEAD', target: sb, headers: key },
    { name: 'sandbox evidence read as a record', target: ev, headers: key },
    { name: 'reconciling with PUT', method: 'PUT', target: rc, headers: { ...J, ...key }, body: {} },
    { name: 'an archive asked for with DELETE', method: 'DELETE', target: bn, headers: key },
    { name: 'reconciling, two slashes in the path', method: 'POST', target: '/v1//settlements/reconcile', headers: { ...J, ...key }, body: {} },
    { name: 'reconciling with a body that is not JSON, without a key', method: 'POST', target: rc, headers: J, body: '{' },
  );
  for (const [name, target] of [['sandbox evidence', ev], ['a package', pk], ['verifying a package', vf], ['reconciling', rc], ['an archive', bn]]) {
    add(
      { name: `${name}: a body that is not JSON`, method: 'POST', target, headers: { ...J, ...key }, body: '{' },
      { name: `${name}: a body over 1 MiB`, method: 'POST', target, headers: { ...J, ...key }, body: `{"pad":"${'a'.repeat(1 << 20)}"}` },
      { name: `${name}: no body at all`, method: 'POST', target, headers: key },
      { name: `${name}: a body that is a list`, method: 'POST', target, headers: { ...J, ...key }, body: '[]' },
      { name: `${name}: a body that is text`, method: 'POST', target, headers: { ...J, ...key }, body: '"evidence"' },
      { name: `${name}: a body that is null`, method: 'POST', target, headers: { ...J, ...key }, body: 'null' },
    );
  }

  // ── the sandbox: scenarios and tampers ────────────────────────────────────
  for (const s of material.scenarios) {
    add(post(`scenario ${s.id}`, ev, { scenario: s.id }, { capture: { [`ev${s.id}`]: '$.evidence' } }));
  }
  add(
    post('a scenario that is null is scenario A', ev, { scenario: null }, { as: main }),
    post('no such scenario', ev, { scenario: 'Z' }),
    post('a scenario that is a number', ev, { scenario: 7 }),
    post('a scenario that is a list', ev, { scenario: ['A'] }),
  );
  for (const t of material.tampers) {
    const base = t.id === 'amount' ? { id: t.id, amount: '48000.00' } : { id: t.id };
    add(post(`tamper ${t.id}`, ev, { tampers: [base] }));
    for (const target of t.needs.target ?? []) add(post(`tamper ${t.id} on ${target}`, ev, { tampers: [{ ...base, target }] }));
    for (const document of t.needs.document ?? []) add(post(`tamper ${t.id}: ${document}`, ev, { tampers: [{ ...base, document }] }));
  }
  add(
    post('every tamper at once, on scenario B', ev, { scenario: 'B', tampers: [{ id: 'signature' }, { id: 'digest' }, { id: 'document' }, { id: 'duplicate' }, { id: 'amount', amount: '0' }] }, { capture: { evAll: '$.evidence' } }),
    post('two amounts changed', ev, { tampers: [{ id: 'amount', amount: '1.00' }, { id: 'amount', target: 'payoutReceipt', amount: '2' }] }),
    post('a signature corrupted twice comes to a third value', ev, { tampers: [{ id: 'signature' }, { id: 'signature' }] }),
    post('a document nobody attached, in another script', ev, { tampers: [{ id: 'document', document: 'certificate of origin — 원산지' }] }),
    post('an amount that is half a character', ev, { tampers: [{ id: 'amount', amount: 'half \ud83d' }] }),
    post('an amount on a target the catalogue does not list', ev, { tampers: [{ id: 'amount', target: 'nothing', amount: '3' }] }),
    post('an amount change without an amount', ev, { tampers: [{ id: 'amount' }] }),
    post('an amount that is a number', ev, { tampers: [{ id: 'amount', amount: 48000 }] }),
    post('a signature on an element that is not there', ev, { tampers: [{ id: 'signature', target: 'travelRule' }] }),
    post('a digest on an element that is not there', ev, { tampers: [{ id: 'digest', target: 'bankApproval' }] }),
    post('a signature on an element that carries none', ev, { tampers: [{ id: 'signature', target: 'chainTransfer' }] }),
    post('tampers that are not a list', ev, { tampers: 'amount' }),
    post('a tamper that is null', ev, { tampers: [null] }),
    post('a tamper nobody defined', ev, { tampers: [{ id: 'nope' }] }),
    post('a tamper whose id is a number', ev, { tampers: [{ id: 5 }] }),
    post('a bad tamper after a good one', ev, { tampers: [{ id: 'duplicate' }, { id: 'nope' }] }),
    post('evidence of the caller\'s own', ev, { evidence: S }, { as: main }),
    post('evidence of the caller\'s own, with a tamper', ev, { evidence: S, tampers: [{ id: 'amount', target: 'bankInstruction', amount: '49999.99' }] }),
    post('evidence that is not an object', ev, { evidence: 7 }),
    post('evidence whose elements are a number', ev, { evidence: { scenario: 'mine', elements: 5 } }),
    post('a signature under a key nobody holds', ev, { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { ...e.signature, keyId: 'someone-else' } })) }),
    post('a signed element with numbers in it', ev, { evidence: withElement('bankInstruction', (e) => ({ ...e, sequence: 1.5, big: 1e21, small: 1e-7 })) }),
    // The previous service failed inside its runtime here, and answered with the runtime's words (D-01).
    post('where the engine gave up: evidence with no elements', ev, { evidence: { scenario: 'mine' } }),
    post('where the engine gave up: evidence that is a list', ev, { evidence: [] }),
    post('where the engine gave up: a tamper on evidence with no scenario', ev, { evidence: { elements: clone(S.elements) }, tampers: [{ id: 'duplicate' }] }),
    post('where the engine gave up: a scenario with a member named toString', ev, { scenario: { toString: 1 } }),
    // A target named like a member every JavaScript object has: no element of that name (see the head of this file).
    post('a signature on a target named constructor', ev, { tampers: [{ id: 'signature', target: 'constructor' }] }),
    post('a signature on a target named __proto__', ev, { tampers: [{ id: 'signature', target: '__proto__' }] }),
    post('a digest on a target named constructor', ev, { tampers: [{ id: 'digest', target: 'constructor' }] }),
    post('a digest on a target named __proto__', ev, { tampers: [{ id: 'digest', target: '__proto__' }] }),
    post('a digest on a target named toString', ev, { tampers: [{ id: 'digest', target: 'toString' }] }),
    // …and nothing was written anywhere: the sample still answers as it did before those three.
    post('scenario A again, after the tampers on inherited names', ev, { scenario: 'A' }),
  );

  // ── the sandbox: a package, sealed and re-checked ─────────────────────────
  const SEALED = { volatile: ['$.generatedAt', '$.digest'] };
  const CHECKED = { volatile: ['$.recordedDigest', '$.recomputedDigest'] };
  // The file is the one that was issued, and the policy still gives that verdict: said outright, because two services
  // that seal wrongly the same way would agree with each other about each other's packages.
  const SOUND = { expect: { '$.digestOk': true, '$.policyUnchanged': true, '$.reproduced': true } };
  add(
    post('a package of the sample', pk, { evidence: S }, { ...SEALED, capture: { pkg: '$' } }),
    post('a package under a name of the caller\'s', pk, { evidence: S, bundleId: 'CASE-2026-0042 / 검토' }, { ...SEALED, as: main }),
    post('a package with an empty name', pk, { evidence: S, bundleId: '' }, SEALED),
    post('a package of scenario B as the sandbox gave it', pk, { evidence: '{evB}' }, { ...SEALED, capture: { pkgB: '$' } }),
    post('a package of every tamper at once', pk, { evidence: '{evAll}' }, SEALED),
    post('a package under a policy of the caller\'s', pk, { evidence: S, policy: { ...P, policyVersion: 'house-rules-7', amountTolerance: '2500.00', sourceTrustLevel: 'DEMO' } }, SEALED),
    post('a package under a policy with members of its own', pk, { evidence: S, policy: { ...P, 10: 'a', 9: 'b', note: { z: 1, a: [3, 2, { y: 1, x: 2 }] } } }, SEALED),
    post('a package under a policy that is not an object', pk, { evidence: S, policy: 7 }),
    post('a package under a policy that is null', pk, { evidence: S, policy: null }),
    post('a package under a policy the engine cannot evaluate', pk, { evidence: S, policy: { ...P, settlementWindow: 'P1M' } }),
    post('a package of no evidence', pk, {}),
    post('a package of evidence that is not an object', pk, { evidence: 'text' }),
    post('a package of evidence with an amount that is a number', pk, { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 50000 })) }),
    post('where the engine gave up: a package of evidence with no elements', pk, { evidence: {} }),

    post('verifying the package this service sealed', vf, { package: '{pkg}' }, { ...CHECKED, ...SOUND }),
    post('verifying it sent bare', vf, '{pkg}', { ...CHECKED, ...SOUND }),
    post('verifying the package the other service sealed', vf, { package: '{pkg}' }, { ...CHECKED, ...SOUND, swap: true }),
    post('verifying scenario B as the other service sealed it', vf, { package: '{pkgB}' }, { ...CHECKED, ...SOUND, swap: true, as: main }),
    post('verifying a package as the reference sealed it for the vectors', vf, { package: sealed }, SOUND),
    post('verifying a package with a member the digest does not cover', vf, { package: edit(sealed, (p) => { p.note = 'reviewed'; }) }),
    post('verifying a package whose digest was edited', vf, { package: edit(sealed, (p) => { p.digest = '0'.repeat(64); }) }),
    post('verifying a package whose amount was edited', vf, { package: edit(sealed, (p) => { p.evidence.elements.chainTransfer.amount = '48000.00'; }) }),
    post('verifying a package whose verdict was edited', vf, { package: edit(sealed, (p) => { p.verdict.axes.matching.state = 'MATCH'; p.verdict.axes.issuer.state = 'VALID'; }) }),
    post('verifying a package whose policy was edited', vf, { package: edit(sealed, (p) => { p.policy.amountTolerance = '5000.00'; }) }),
    post('verifying a package whose verdict lacks an axis', vf, { package: edit(sealed, (p) => { delete p.verdict.axes.integrity; }) }),
    post('verifying a package whose policy is not valid', vf, { package: edit(sealed, (p) => { p.policy.partyIDMatch = 'loose'; }) }),
    post('verifying a package without its digest', vf, { package: edit(sealed, (p) => { delete p.digest; }) }),
    post('verifying a package without its verdict', vf, { package: edit(sealed, (p) => { delete p.verdict; }) }),
    post('verifying what is no package', vf, { package: 7 }),
    post('where the engine gave up: verifying a package whose verdict has no axes', vf, { package: edit(sealed, (p) => { delete p.verdict.axes; }) }),
    post('where the engine gave up: verifying a package whose evidence is text', vf, { package: edit(sealed, (p) => { p.evidence = 'evidence'; }) }),
  );

  // ── reconciliation: the verdict, as data ──────────────────────────────────
  add(post('reconciling the sample', rc, { evidence: S, policy: P }), post('reconciling the sample, as the console does', rc, { evidence: S, policy: P }, { as: main }));
  for (const s of material.scenarios) add(post(`reconciling scenario ${s.id} as the sandbox gave it`, rc, { evidence: `{ev${s.id}}`, policy: P }));
  add(
    post('reconciling every tamper at once', rc, { evidence: '{evAll}', policy: P }),
    post('reconciling under a looser policy', rc, { evidence: '{evB}', policy: { ...P, policyVersion: 'loose', amountTolerance: '2000.00', sourceTrustLevel: 'DEMO' } }),
    post('what the document says of its signatures carries no weight', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, signature: { ...e.signature, status: 'VALID', trustLevel: 'ACCREDITED', issuer: 'A REAL BANK' } })), policy: P }),
    post('reconciling no evidence', rc, { policy: P }),
    post('reconciling evidence that is text', rc, { evidence: 'text', policy: P }),
    post('reconciling without a policy', rc, { evidence: S }),
    post('reconciling under a policy that is a number', rc, { evidence: S, policy: 7 }),
  );
  for (const [name, change] of [['no version', { policyVersion: undefined }], ['currencies that are text', { currencies: 'USD' }], ['a currency in two groups', { unitOfAccountGroups: [['USD', 'USDC'], ['USD']] }],
    ['a tolerance that is a number', { amountTolerance: 0 }], ['basis points that are a fraction', { amountToleranceBps: 0.5 }], ['a window in months', { settlementWindow: 'P1M' }], ['a window that is a list', { settlementWindow: ['P3D'] }],
    ['fees that are text', { fees: 'none' }], ['a party match nobody defined', { partyIDMatch: 'fuzzy' }], ['a trust level nobody defined', { sourceTrustLevel: 'TRUSTED' }],
    ['a signature required of an element that is not required', { signatureRequiredElements: ['travelRule'] }], ['no Travel Rule switch', { requireTravelRulePreflight: undefined }]]) {
    add(post(`a policy the engine cannot evaluate: ${name}`, rc, { evidence: S, policy: { ...P, ...change } }));
  }
  add(
    post('a policy that is a list', rc, { evidence: S, policy: [] }),
    post('a policy whose trust level is a member every engine object has', rc, { evidence: S, policy: { ...P, sourceTrustLevel: 'constructor' } }),
    post('reconciling evidence whose elements are a number', rc, { evidence: { elements: 5 }, policy: P }),
    post('reconciling evidence of nothing but empty elements', rc, { evidence: { elements: {} }, policy: P }),
    post('reconciling an amount that is a number', rc, { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 50000 })), policy: P }),
    post('reconciling an amount with a thousands separator', rc, { evidence: withElement('commercialDocs', (e) => ({ ...e, amount: '50,000.00' })), policy: P }),
    post('a settlement three days and a second after approval', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-01T09:01:59Z' })), policy: P }),
    post('a settlement before its approval', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026-03-05T00:00:00+07:00' })), policy: P }),
    post('a time that is not a time', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: 'yesterday' })), policy: P }),
    // The refusal is worded by the previous runtime there; here, by this service (D-03).
    post('worded by the engine: evidence with no elements', rc, { evidence: {}, policy: P }),
    post('worded by the engine: evidence that is a list', rc, { evidence: [], policy: P }),
    post('worded by the engine: a window that is an object with a member named toString', rc, { evidence: S, policy: { ...P, settlementWindow: { toString: 1 } } }),
    // A time only the JavaScript engine reads (D-12): the reference measures against it, this service reports it unparseable.
    post('a settlement time only the engine reads: an approval written "Mar 1, 2026 09:00 UTC", within the window', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: 'Mar 1, 2026 09:00 UTC' })), policy: P }),
    post('a settlement time only the engine reads: an approval written "Feb 28, 2026 09:00 UTC", past the window', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: 'Feb 28, 2026 09:00 UTC' })), policy: P }),
    post('a settlement time only the engine reads: an approval written "2026/03/05", after the funds moved', rc, { evidence: withElement('bankInstruction', (e) => ({ ...e, approvedAt: '2026/03/05' })), policy: P }),
    post('a settlement time only the engine reads: a transfer observed "4 March 2026 08:15 GMT", within the window', rc, { evidence: withElement('chainTransfer', (e) => ({ ...e, observedAt: '4 March 2026 08:15 GMT' })), policy: P }),
    // An object with a member named toString where the rules write a value into a sentence (D-14).
    post('a currency that is an object with a member named toString', rc, { evidence: withElement('chainTransfer', (e) => ({ ...e, currency: { toString: 1 } })), policy: P }),
  );

  // ── the archive ───────────────────────────────────────────────────────────
  const FIXED = { bundleId: 'EV-2026-0001', generatedAt: '2026-11-18T10:00:00.000Z' };
  add(post('an archive: the sample', bn, { evidence: S, policy: P, ...FIXED }), post('an archive: the sample, as the console asks', bn, { evidence: S, policy: P, ...FIXED }, { as: main }));
  for (const s of material.scenarios) add(post(`an archive: scenario ${s.id} as the sandbox gave it`, bn, { evidence: `{ev${s.id}}`, policy: P, ...FIXED }));
  add(
    post('an archive: every tamper at once', bn, { evidence: '{evAll}', policy: P, ...FIXED }),
    post('an archive: under a policy of the caller\'s', bn, { evidence: S, policy: { ...P, policyVersion: 'house-rules-7', amountTolerance: '2500.00', 10: 'a', 9: 'b' }, ...FIXED }),
    post('an archive: an id with a quote, a backslash and Latin-1 in it', bn, { evidence: S, policy: P, bundleId: 'CASE (2026) \\ 0042 "A" é ÿ', generatedAt: FIXED.generatedAt }),
    post('an archive: evidence that is not synthetic', bn, { evidence: { ...clone(S), dataMode: 'LIVE', notRealPayment: false }, policy: P, ...FIXED }),
    post('an archive: text in other scripts', bn, { evidence: { ...clone(S), scenario: '정상 무역 결제 — “VN→SG” ✓ … naïve café ①②③ ‘x’ •·–', purpose: '수입 대금 😀 \ud83d half', jurisdiction: { from: 'Việt Nam', to: 'シンガポール' } }, policy: P, ...FIXED }),
    post('an archive: a long scenario and a long token', bn, { evidence: { ...clone(S), scenario: `${'word '.repeat(60)}${'0123456789abcdef'.repeat(12)} ${'W'.repeat(140)}`, purpose: `  spaces,\ttabs\nand breaks ${'x'.repeat(200)}  ` }, policy: P, ...FIXED }),
    post('an archive: twelve receipts', bn, { evidence: edit(S, (e) => { e.elements.payoutReceipts = Array.from({ length: 12 }, (_, n) => ({ ...clone(S.elements.payoutReceipts[0]), ref: `PAY-${n}`, amount: n === 0 ? '49989.00' : '1.00' })); }), policy: P, ...FIXED }),
    post('an archive: a scenario that is a list of text', bn, { evidence: { ...clone(S), scenario: ['ab', 'ç한', '—', ''], purpose: ['p'] }, policy: P, ...FIXED }),
  );
  for (const [name, generatedAt] of [['a date alone', '2026-11-18'], ['an offset', '2026-11-18T19:00:00+09:00'], ['a space for the T and no zone', '2026-11-18 10:00'], ['an odd second', '2026-11-18T10:00:01Z'],
    ['the first second ZIP can hold', '1980-01-01T00:00:00Z'], ['a year ZIP cannot hold in sixteen bits', '2108-01-01T00:00:00Z'], ['milliseconds as a number', 1795000000000], ['a list of one text', ['2026-11-18T10:00:00Z']]]) {
    add(post(`an archive: a time given as ${name}`, bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt }));
  }
  // No id, no time: a random id and the clock. The two archives are then two different archives: compared as what kind of thing each is.
  const RANDOM = { looseArchive: true, blurHeaders: [[/EV-[0-9A-F]{8}/g, 'EV-<id>']] };
  add(
    post('an archive of its own id and time: nothing given', bn, { evidence: S, policy: P }, RANDOM),
    post('an archive of its own id and time: an empty id, a time that is null', bn, { evidence: S, policy: P, bundleId: '', generatedAt: null }, RANDOM),
    post('an archive of its own id and time: an id that is a number, a time of zero', bn, { evidence: S, policy: P, bundleId: 42, generatedAt: 0 }, RANDOM),
  );
  add(
    // An id that no header can carry: the archive is made, and sending it fails.
    post('an archive whose id no header can carry: another script', bn, { evidence: S, policy: P, bundleId: '검토 2026', generatedAt: FIXED.generatedAt }),
    post('an archive whose id no header can carry: a line break', bn, { evidence: S, policy: P, bundleId: 'EV-1\r\nX-Injected: 1', generatedAt: FIXED.generatedAt }),
    post('an archive whose id no header can carry: half a character', bn, { evidence: S, policy: P, bundleId: 'EV-\ud83d', generatedAt: FIXED.generatedAt }),
    post('a time ZIP cannot write: a second before 1980', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: '1979-12-31T23:59:59Z' }),
    post('a time ZIP cannot write: true is one millisecond', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: true }),
    post('not a time: words', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: 'yesterday' }),
    post('not a time: an object', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: {} }),
    post('not a time: an empty list', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: [] }),
    post('not a time: a month that does not exist', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: '2026-13-01' }),
    post('refusals in order: the policy before the time', bn, { evidence: S, policy: {}, generatedAt: 'yesterday' }),
    post('refusals in order: the time before the evidence', bn, { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 1 })), policy: P, generatedAt: 'yesterday' }),
    post('refusals in order: the evidence before the archive', bn, { evidence: withElement('chainTransfer', (e) => ({ ...e, amount: 1 })), policy: P, generatedAt: '1970-01-01' }),
    post('an archive of no evidence', bn, { policy: P }),
    post('an archive without a policy', bn, { evidence: S }),
    post('where the engine gave up: an archive of evidence that names no scenario', bn, { evidence: { dataMode: 'SYNTHETIC', elements: clone(S.elements) }, policy: P, ...FIXED }),
    post('where the engine gave up: a time that is an object with a member named toString', bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt: { toString: 1 } }),
    post('worded by the engine: an archive of evidence with no elements', bn, { evidence: {}, policy: P, ...FIXED }),
    post('worded by the engine: an archive of receipts that are text', bn, { evidence: edit(S, (e) => { e.elements.payoutReceipts = 'PAY-REF-01'; }), policy: P, ...FIXED }),
  );
  // A time only the JavaScript engine reads (D-04): an archive there, a refusal here.
  for (const generatedAt of ['Nov 18, 2026', '2026/11/18', '2026-11-8', [2026, 11]]) {
    add(post(`an archive time only the engine reads: ${JSON.stringify(generatedAt)}`, bn, { evidence: S, policy: P, bundleId: FIXED.bundleId, generatedAt }));
  }
  return cases;
};
