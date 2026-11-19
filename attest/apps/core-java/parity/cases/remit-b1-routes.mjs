/**
 * The settlement rail, part 1: every route that needs no partner, on the
 * seeded ledger (tools/seed-remit.mjs) — and nothing that would make a
 * settlement.
 *
 *   GET  /v1/remit/meta                      POST /v1/remit/registry/institutions      POST /v1/remit/registry/deactivate
 *   POST /v1/quotes                          POST /v1/settlements (refusals only)
 *   GET  /v1/settlements                     GET  /v1/settlements/:id                  …/chain   …/evidence
 *   POST /v1/manifests/daily                 GET  /v1/manifests/daily
 *
 * **No request here is accepted as a settlement.** The Java service of this
 * part has no pipeline behind an acceptance yet (its executor does nothing;
 * part 2), while the reference would go on to its partner — the two partner
 * stand-ins would then have been asked different things, and
 * tools/run-parity.sh compares that. So `POST /v1/settlements` is sent only
 * what is refused: before anything is read, by each check of the ladder, and
 * — with an instruction that passes every check — by the transaction itself
 * (an id that exists, a message that already stands for a settlement). The
 * accepted path is held by the store tests (RemitAcceptanceIT) and the
 * vectors; the flows are part 2's and the other cases' (remit-a-*, remit-b-*).
 *
 * The bank's side is the deployed SDK (packages/attest-remit), as in the
 * seed: an instruction is built and signed with the seeded bank's key
 * (seed.json keeps it — a test key of two throw-away schemas). The admin
 * token is read from the Java server's settings file and never written
 * anywhere; both settings files have to carry the same one.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemitClient } from '../../../../packages/attest-remit/src/index.ts';
import { signEvent } from '../../../core/src/remit/sign.ts';
import { readEnvFile } from '../../tools/check-test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = { 'Content-Type': 'application/json' };

export default ({ seed }) => {
  const R = seed.remit;
  if (!R || R.skipped || !R.orgs) { console.log('remit-b1: the settlement rail is not seeded — no cases'); return []; }
  const envs = ['.env.parity', '.env.ref'].map((f) => readEnvFile(path.resolve(HERE, '../..', f)));
  if (envs[0].REMIT_ADMIN_TOKEN !== envs[1].REMIT_ADMIN_TOKEN) throw new Error('remit-b1: the two settings files do not carry the same REMIT_ADMIN_TOKEN');
  const TOKEN = envs[0].REMIT_ADMIN_TOKEN;

  const O = R.orgs;
  const key = (o) => ({ Authorization: `Bearer ${o.key}` });
  const jkey = (o) => ({ ...J, ...key(o) });
  const BFI = Object.values(R.partner.institutions).find((i) => i.role === 'BENEFICIARY_FI' && i.registered !== false && i.encryption_jwk);
  const bankKey = createPrivateKey(O.rail.bank.pem);
  const client = new RemitClient({ core: 'http://127.0.0.1:9', apiKey: O.rail.key, institutionId: O.rail.bank.id, institutionName: O.rail.bank.name, key: bankKey });
  const bankSig = (payload) => signEvent(payload, bankKey, O.rail.bank.id, O.rail.bank.name);
  const quotes = R.quotes.fresh.rail;
  const cases = [];
  const add = (name, c) => cases.push({ name, ...c });
  /** An institution id a server issued on the way (a product activated by an earlier case): country, role, six characters of its own. */
  const ISSUED = [[/-(BANK|EX)-[0-9A-F]{6}$/, '-$1-<id>']];

  // ── what a counterparty needs to verify the platform ─────────────────────────────────────────────────────────
  add('meta, to anyone', { target: '/v1/remit/meta', blur: ISSUED, expect: { '$.platform_signer.key_id': R.platform.key_id, '$.platform_signer.spki': R.platform.spki } });
  add('meta with a key that is no key', { target: '/v1/remit/meta', blur: ISSUED, headers: { Authorization: 'Bearer not-a-key' } });
  add('meta with a query', { target: '/v1/remit/meta?x=1', blur: ISSUED });
  add('meta by another method', { method: 'POST', target: '/v1/remit/meta', headers: J, body: {} });
  add('a path under meta', { target: '/v1/remit/meta/institutions' });

  // ── provisioning, behind the admin token ─────────────────────────────────────────────────────────────────────
  const I = '/v1/remit/registry/institutions';
  const admin = { ...J, 'X-Admin-Token': TOKEN };
  const spki = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const first = spki();
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const inst = { id: 'B1-PARITY-BFI', role: 'BENEFICIARY_FI', name: 'B1 parity institution', country: 'SG', signing_spki: first, encryption_jwk: jwk, authority: ['PAYOUT_ACCEPTED', 'TRAVEL_RULE_RECEIVED'] };
  const post = (name, headers, body) => add(name, { method: 'POST', target: I, headers, body });
  post('register without the token', J, inst);
  post('register with a wrong token', { ...J, 'X-Admin-Token': 'not-the-token' }, inst);
  post('register with an empty token', { ...J, 'X-Admin-Token': '' }, inst);
  post('register with the token sent twice', { ...J, 'X-Admin-Token': TOKEN, 'x-admin-token': TOKEN }, inst);
  post('register with an API key instead of the token', jkey(O.rail), inst);
  post('register: the token is looked at before the body', { ...J, 'X-Admin-Token': 'no' }, '{');
  post('register: a body that is not JSON', admin, '{');
  post('register: a body that is null', admin, 'null');
  post('register: a body that is a list', admin, '[]');
  post('register: nothing in the body', admin, {});
  post('register: no role', admin, { id: 'B1-PARITY-X', name: 'x' });
  post('register: no name', admin, { id: 'B1-PARITY-X', role: 'BENEFICIARY_FI' });
  post('register: an empty id', admin, { id: '', role: 'BENEFICIARY_FI', name: 'x' });
  post('register a new institution', admin, inst);
  add('meta lists it, with its keys', { target: '/v1/remit/meta', blur: ISSUED });
  post('register it again: another name, no keys, no country, no authority', admin, { id: inst.id, role: 'BENEFICIARY_FI', name: 'B1 parity institution, renamed' });
  add('its keys stayed, its country and authority did not', { target: '/v1/remit/meta', blur: ISSUED });
  post('register it again: another signing key and an encryption key that is null', admin, { ...inst, signing_spki: spki(), encryption_jwk: null });
  add('the key changed', { target: '/v1/remit/meta', blur: ISSUED });
  post('register: a key that is no key, an authority that is text', admin, { id: 'B1-PARITY-ODD', role: 'PAYOUT_BANK', name: 'B1 odd', signing_spki: 'not a key at all', authority: 'PAYOUT_COMPLETED', country: '' });
  post('register: members nobody reads', admin, { id: 'B1-PARITY-MORE', role: 'SETTLEMENT_ENTITY', name: 'B1 more', org_id: O.b.id, console_spki: 'x', created_at: '2020-01-01T00:00:00.000Z' });
  post('register: a role nobody knows', admin, { id: 'B1-PARITY-ROLE', role: 'CENTRAL_BANK', name: 'B1 role' });
  post('register: an id as long as the column', admin, { id: 'B'.repeat(64), role: 'BENEFICIARY_FI', name: 'B1 long' });
  add('meta after the registrations', { target: '/v1/remit/meta', blur: ISSUED });

  const D = '/v1/remit/registry/deactivate';
  const off = (name, headers, body, more = {}) => add(name, { method: 'POST', target: D, headers, body, ...more });
  off('deactivate without the token', J, { email: O.deact.account?.email ?? 'nobody@example.test' });
  off('deactivate with a wrong token', { ...J, 'X-Admin-Token': `${TOKEN}x` }, { email: 'nobody@example.test' });
  off('deactivate: no e-mail', admin, {});
  off('deactivate: an empty e-mail', admin, { email: '' });
  off('deactivate: a body that is null', admin, 'null');
  off('deactivate: nobody of that address', admin, { email: 'nobody-at-all@example.test' });
  off('deactivate: an address that is not text', admin, { email: 12 });
  off('deactivate: an address that is a list', admin, { email: ['a@example.test'] });
  off('deactivate: nobody, and products that are no list', admin, { email: 'nobody-at-all@example.test', products: 7 });

  // ── the gate ─────────────────────────────────────────────────────────────────────────────────────────────────
  const aQuote = { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '1200.00' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } };
  const NEWQ = ['$.quote_id', '$.quoted_at', '$.expires_at'];
  for (const [who, headers] of [['no key', J], ['a key that is no key', { ...J, Authorization: 'Bearer sk_test_nothing' }], ['a key of another scheme', { ...J, Authorization: `Basic ${O.rail.key}` }]]) {
    add(`a quote with ${who}`, { method: 'POST', target: '/v1/quotes', headers, body: aQuote });
    add(`an instruction with ${who}`, { method: 'POST', target: '/v1/settlements', headers: { ...headers, 'Idempotency-Key': 'b1-gate-key-1' }, body: {} });
    add(`the ledger with ${who}`, { target: '/v1/settlements', headers });
    add(`a settlement with ${who}`, { target: '/v1/settlements/PAY-SEED-ANCHORED-A', headers });
    add(`its chain with ${who}`, { target: '/v1/settlements/PAY-SEED-ANCHORED-A/chain', headers });
    add(`its evidence with ${who}`, { target: '/v1/settlements/PAY-SEED-ANCHORED-A/evidence', headers });
    add(`a manifest with ${who}`, { method: 'POST', target: '/v1/manifests/daily', headers, body: {} });
    add(`the manifests with ${who}`, { target: '/v1/manifests/daily', headers });
  }
  for (const name of ['off', 'nosub', 'nobank', 'nokey']) {
    const o = O[name];
    if (!o) continue;
    add(`a quote for an organisation that is ${name}`, { method: 'POST', target: '/v1/quotes', headers: jkey(o), body: aQuote });
    add(`a quote that could not be made, for an organisation that is ${name}`, { method: 'POST', target: '/v1/quotes', headers: jkey(o), body: {} });
    add(`an instruction of an organisation that is ${name}`, { method: 'POST', target: '/v1/settlements', headers: { ...jkey(o), 'Idempotency-Key': 'b1-gate-key-2' }, body: {} });
    add(`an instruction without a key header, of an organisation that is ${name}`, { method: 'POST', target: '/v1/settlements', headers: jkey(o), body: {} });
    add(`a manifest of an organisation that is ${name}`, { method: 'POST', target: '/v1/manifests/daily', headers: jkey(o), body: {} });
    // Reading needs a key and nothing more.
    add(`the ledger of an organisation that is ${name}`, { target: '/v1/settlements', headers: key(o) });
    add(`the manifests of an organisation that is ${name}`, { target: '/v1/manifests/daily', headers: key(o) });
  }

  // ── quotes ───────────────────────────────────────────────────────────────────────────────────────────────────
  const quote = (name, body, more = {}) => add(`quote: ${name}`, { method: 'POST', target: '/v1/quotes', headers: jkey(O.rail), body, ...more });
  quote('the corridor', aQuote, { volatile: NEWQ });
  quote('with more than is asked for', { ...aQuote, note: 'x', trade: { currency: 'USD', amount: '0.01', more: 1 } }, { volatile: NEWQ });
  for (const amount of ['1', '0', '0.005', '0.015', '1200.005', '999999999999999999999999.99', '00012.50', '1.', '.5', '-1', '+1', '1e3', ' 1', '1,000.00', '１２', '']) {
    quote(`amount ${JSON.stringify(amount)}`, { ...aQuote, trade: { currency: 'USD', amount } }, { volatile: NEWQ });
  }
  quote('an amount that is a number', { ...aQuote, trade: { currency: 'USD', amount: 1200 } }, { volatile: NEWQ });
  quote('an amount that is a fraction as a number', { ...aQuote, trade: { currency: 'USD', amount: 12.5 } }, { volatile: NEWQ });
  quote('an amount that is null', { ...aQuote, trade: { currency: 'USD', amount: null } });
  quote('an amount that is a list', { ...aQuote, trade: { currency: 'USD', amount: ['12.50'] } }, { volatile: NEWQ });
  quote('no amount', { ...aQuote, trade: { currency: 'USD' } });
  quote('another corridor', { ...aQuote, corridor: { origin: 'SG', destination: 'VN' } });
  quote('a corridor in lower case', { ...aQuote, corridor: { origin: 'vn', destination: 'sg' } });
  quote('no corridor', { trade: aQuote.trade, collect: aQuote.collect, payout: aQuote.payout });
  quote('a corridor that is null', { ...aQuote, corridor: null });
  quote('a trade in another currency', { ...aQuote, trade: { currency: 'EUR', amount: '10.00' } });
  quote('no trade', { corridor: aQuote.corridor, collect: aQuote.collect, payout: aQuote.payout });
  quote('collection in another currency', { ...aQuote, collect: { currency: 'USD' } });
  quote('payout in another currency', { ...aQuote, payout: { currency: 'USD' } });
  quote('no legs', { corridor: aQuote.corridor, trade: aQuote.trade });
  quote('an empty body', {});
  quote('a body that is null', 'null');
  quote('a body that is a list', '[]');
  quote('a body that is text', '"VN"');
  quote('a body that is not JSON', '{"corridor":');
  add('quote: no body at all', { method: 'POST', target: '/v1/quotes', headers: key(O.rail) });
  add('quote: by another method', { target: '/v1/quotes', headers: key(O.rail) });

  // ── instructions that are refused ────────────────────────────────────────────────────────────────────────────
  const S = '/v1/settlements';
  let n = 0;
  const send = (name, body, more = {}, headers = {}) => add(`instruction: ${name}`, { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `b1-refused-${String(++n).padStart(3, '0')}`, ...headers }, body, ...more });
  const build = (i, id, opts = {}) => client.buildInstruction(quotes[i], R.parties, { paymentId: id, beneficiaryInstitution: BFI.id, invoiceRef: `INV-${id}`, ...opts }).body;
  const good = () => build(0, 'PAY-B1-PARITY-REFUSED');

  // The key header first: before the body is read.
  add('instruction: no key header', { method: 'POST', target: S, headers: jkey(O.rail), body: good() });
  add('instruction: no key header and a body that is not JSON', { method: 'POST', target: S, headers: jkey(O.rail), body: '{' });
  add('instruction: a key of seven characters', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': '1234567' }, body: good() });
  add('instruction: an empty key', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': '' }, body: good() });
  add('instruction: two short keys that are long enough together', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': 'abcd', 'idempotency-key': 'efgh' }, body: {} });
  add('instruction: a key of 191 characters', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': 'k'.repeat(191) }, body: {} });
  add('instruction: a key of 192 characters', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': 'k'.repeat(192) }, body: {} });
  add('instruction: a key of 192 characters and a body that is not JSON', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': 'k'.repeat(192) }, body: '{' });
  send('a body that is not JSON', '{"payment_id":');
  send('a body that is null', 'null');
  send('a body that is a list', '[]');
  send('an empty body', {});
  add('instruction: no body at all', { method: 'POST', target: S, headers: { ...key(O.rail), 'Idempotency-Key': 'b1-refused-nobody' } });

  // The key of a seeded settlement with another body: a conflict before anything else is looked at.
  const seededOfRail = Object.values(R.settlements.rail ?? {})[0];
  if (seededOfRail) {
    add('instruction: the key of a seeded settlement with another body', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: {} });
    add('instruction: that key with a body that could be accepted', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: good() });
    send('the id of a seeded settlement', { ...good(), payment_id: seededOfRail.id });
    send('the id of a seeded settlement, and nothing else', { payment_id: seededOfRail.id, quote_id: 'QT-none' });
  }
  const others = Object.values(R.settlements.read ?? {})[0];
  if (others) send('the id of another organisation\'s settlement', { payment_id: others.id, quote_id: quotes[0].quote_id });

  // The payment id.
  for (const id of ['abc', 'a'.repeat(65), 'PAY B1', 'PAY/B1', '-PAY-B1', '_PAY_B1', 'reconcile', 'bundle', 'PAY-B1-ÅÄÖ', '', ' PAY-B1-0001']) {
    send(`payment id ${JSON.stringify(id.length > 20 ? `${id.slice(0, 8)}… (${id.length})` : id)}`, { ...good(), payment_id: id });
  }
  send('no payment id', (({ payment_id: _, ...rest }) => rest)(good()));
  send('a payment id that is null', { ...good(), payment_id: null });
  // An id that is not text (D-18). Only a list is sent: the reference binds what it is given into its statements, and a number
  // or `true` leaves the statement of that connection comparing ids as numbers from then on — every later lookup of a text id on
  // it finds some other row ("exists" for an id that does not; tools/probe-reference-id-binding.mjs shows it). That would spoil
  // every case after it, so those values are held by the vectors (RemitB1VectorsTest, RemitAcceptanceIT) and not sent here.
  send('a payment id that is a list of one id', { ...good(), payment_id: ['PAY-B1-PARITY-LIST'] });

  // The quote.
  send('no quote id', (({ quote_id: _, ...rest }) => rest)(good()));
  send('an empty quote id', { ...good(), quote_id: '' });
  send('a quote nobody made', { ...good(), quote_id: 'QT-00000000-0000' });
  send('a quote of another organisation', { ...good(), quote_id: R.quotes.fresh.b[0].quote_id });
  send('a quote that has expired', { ...good(), quote_id: R.quotes.expired.quote_id });
  // Not sent: a quote id or an institution id that is not text. A list of one id is read by the reference's database as that id
  // — and the instruction is then accepted, which this file must not cause (see the top); a number spoils the connection (above).
  // The vectors hold what the Java service answers there (400, D-18).

  // The amounts restate the quote.
  const withAmount = (leg, change) => { const b = good(); b.amount = { ...b.amount, [leg]: { ...b.amount[leg], ...change } }; return b; };
  send('another collected amount', withAmount('collected', { value: '1' }));
  send('the collected amount as a number', withAmount('collected', { value: Number(quotes[0].collect.amount) }));
  send('another collected currency', withAmount('collected', { currency: 'USD' }));
  send('another payout amount', withAmount('payout', { value: '1.00' }));
  send('the payout amount without its cents', withAmount('payout', { value: quotes[0].payout.amount.replace(/\.\d+$/, '') }));
  send('no amounts', (({ amount: _, ...rest }) => rest)(good()));
  send('amounts that are null', { ...good(), amount: null });
  send('amounts that are text', { ...good(), amount: 'all of it' });

  // The receiving institution.
  const toward = (institution_id) => { const b = good(); b.beneficiary = { ...b.beneficiary, institution_id }; return b; };
  send('no beneficiary', (({ beneficiary: _, ...rest }) => rest)(good()));
  send('no beneficiary institution', { ...good(), beneficiary: {} });
  send('an institution nobody registered', toward('SG-BFI-NOBODY'));
  send('an institution of another role', toward(O.rail.bank.id));
  send('the platform as the institution', toward('STONEHASH'));
  send('an institution without an encryption key', toward(R.institutions.noEnc ?? 'SG-BFI-NOENC'));

  // The bank's authorisation.
  send('no authorisation', (({ bank_authorization: _, ...rest }) => rest)(good()));
  send('an authorisation that is text', { ...good(), bank_authorization: 'yes' });
  send('an authorisation that is a list', { ...good(), bank_authorization: [] });
  send('no signature', (({ bank_signature: _, ...rest }) => rest)(good()));
  send('a signature without its value', { ...good(), bank_signature: { alg: 'ES256', key_id: O.rail.bank.id } });
  send('an authorisation changed after it was signed', (() => { const b = good(); b.bank_authorization = { ...b.bank_authorization, amount: '1.00' }; return b; })());
  send('a signature of another key', (() => { const b = good(); b.bank_signature = signEvent(b.bank_authorization, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, O.rail.bank.id, O.rail.bank.name); return b; })());
  send('a signature under another algorithm name', (() => { const b = good(); b.bank_signature = { ...b.bank_signature, alg: 'ES384' }; return b; })());
  send('a signature that is text', { ...good(), bank_signature: 'signed' });
  send('an authorisation with a fraction in it', (() => { const b = good(); b.bank_authorization = { ...b.bank_authorization, weight: 0.5 }; return b; })());

  // Travel-rule data.
  const comply = (change) => { const b = good(); b.compliance_payload = change(structuredClone(b.compliance_payload)); return b; };
  send('no compliance data', (({ compliance_payload: _, ...rest }) => rest)(good()));
  send('compliance data that is null', { ...good(), compliance_payload: null });
  send('no originator name', comply((c) => { delete c.originator.name; return c; }));
  send('no beneficiary account and no purpose', comply((c) => { delete c.beneficiary.account; delete c.purpose_code; return c; }));
  send('an empty originator', comply((c) => ({ ...c, originator: {} })));
  send('mode B with nothing', comply(() => ({ mode: 'B' })));
  send('mode B with a ciphertext and no digest', comply(() => ({ mode: 'B', ciphertext: 'a.b.c.d.e' })));
  send('mode B without a statement', comply(() => ({ mode: 'B', ciphertext: 'a.b.c.d.e', ivms101_digest: 'ab'.repeat(32) })));
  send('mode B with a statement about another message', comply(() => {
    const payload = { payment_id: 'PAY-B1-PARITY-REFUSED', required_fields_present: true, ivms101_digest: 'cd'.repeat(32), ciphertext_sha256: 'ef'.repeat(32) };
    return { mode: 'B', ciphertext: 'a.b.c.d.e', ivms101_digest: 'ab'.repeat(32), fields_assertion: { payload, sig: bankSig(payload) } };
  }));
  send('mode B with a statement that names another payment', comply(() => {
    const payload = { payment_id: 'PAY-B1-PARITY-OTHER', required_fields_present: true };
    return { mode: 'B', ciphertext: 'a.b.c.d.e', ivms101_digest: 'ab'.repeat(32), fields_assertion: { payload, sig: bankSig(payload) } };
  }));

  // The three evidence elements.
  const element = (name, change) => { const b = good(); b.evidence_elements = { ...b.evidence_elements, [name]: change(structuredClone(b.evidence_elements[name])) }; return b; };
  send('no evidence elements', (({ evidence_elements: _, ...rest }) => rest)(good()));
  send('evidence elements that are null', { ...good(), evidence_elements: null });
  for (const name of ['bankInstruction', 'bankApproval', 'commercialDocs']) {
    send(`no ${name}`, (() => { const b = good(); const { [name]: _, ...rest } = b.evidence_elements; b.evidence_elements = rest; return b; })());
    send(`${name} changed after it was signed`, element(name, (e) => ({ ...e, changed: 'afterwards' })));
    send(`${name} without its signature`, element(name, (e) => { delete e.signature; return e; }));
    send(`${name} that is text`, element(name, () => 'an element'));
  }
  send('an instruction element for another amount, signed', (() => { const b = build(8, 'PAY-B1-PARITY-REFUSED'); const a = good(); a.evidence_elements = { ...a.evidence_elements, bankInstruction: b.evidence_elements.bankInstruction }; return a; })());
  send('an instruction element with another reference, signed', (() => { const b = build(0, 'PAY-B1-PARITY-OTHERREF'); const a = good(); a.evidence_elements = { ...a.evidence_elements, bankInstruction: b.evidence_elements.bankInstruction }; return a; })());

  // The reference to the bank's message: signed, and still not what it claims to be.
  const from = (source) => build(0, 'PAY-B1-PARITY-REFUSED', { source });
  const msg = { type: 'pacs.008.001.08', sha256: 'ab'.repeat(32) };
  for (const [what, source] of [
    ['a UETR that is no UUID', { ...msg, uetr: 'not-a-uuid' }],
    ['a digest that is no digest', { ...msg, sha256: 'abc' }],
    ['a content digest that is no digest', { ...msg, content: 'xyz' }],
    ['a value date that is no day', { ...msg, valueDate: '2026-02-30' }],
    ['a value date of another shape', { ...msg, valueDate: '17.11.2026' }],
    ['a position that is negative', { ...msg, index: -1 }],
    ['a position that is a fraction', { ...msg, index: 1.5 }],
    ['no type', { sha256: msg.sha256 }],
    ['a type longer than its column', { ...msg, type: 't'.repeat(41) }],
    ['an identifier longer than its limit', { ...msg, instructionId: 'i'.repeat(257) }],
  ]) {
    // The SDK itself refuses some of these; then the element is signed here as the SDK signs it, around the reference as written.
    let body;
    try { body = from(source); } catch { body = null; }
    if (body) send(`made from a message with ${what}`, body);
  }

  // An instruction that passes every check, refused by the transaction: its message already stands for a settlement. Sent as the
  // organisation that holds the seeded messages (another organisation's message is no conflict), built from a quote each server
  // makes for it now — so each server is sent an instruction on its own quote, signed with the seeded bank's key.
  if (O.read.bank && quotes[8].trade.amount !== quotes[0].trade.amount) {
    const readClient = new RemitClient({ core: 'http://127.0.0.1:9', apiKey: O.read.key, institutionId: O.read.bank.id, institutionName: O.read.bank.name, key: createPrivateKey(O.read.bank.pem) });
    add('quote: one for the organisation that holds the seeded messages', { method: 'POST', target: '/v1/quotes', headers: jkey(O.read), body: aQuote, volatile: NEWQ, capture: { rq: '$' } });
    let k = 0;
    for (const [file, held] of Object.entries(R.source ?? {})) {
      const id = `PAY-B1-AGAIN-${++k}`;
      const body = (vars) => readClient.buildInstruction(vars.rq, R.parties, { paymentId: id, beneficiaryInstitution: BFI.id, source: held.source }).body;
      add(`instruction: the seeded message ${file} again, under another id`, { method: 'POST', target: S, headers: { ...jkey(O.read), 'Idempotency-Key': `b1-again-${k}` }, body,
        expect: { '$.error': file === 'reused' ? 'reference_reused' : 'duplicate_source_message' } });
      add(`instruction: and once more (${file})`, { method: 'POST', target: S, headers: { ...jkey(O.read), 'Idempotency-Key': `b1-again-${k}` }, body,
        expect: { '$.error': file === 'reused' ? 'reference_reused' : 'duplicate_source_message' } });
      add(`instruction: no settlement was made of it (${file})`, { target: `${S}/${id}`, headers: key(O.read) });
    }
  }

  // ── the ledger ───────────────────────────────────────────────────────────────────────────────────────────────
  const L = '/v1/settlements';
  const ledger = (name, query, more = {}, o = O.read) => add(`ledger: ${name}`, { target: `${L}${query}`, headers: key(o), ...more });
  ledger('the newest page', '');
  ledger('of an organisation with no settlement', '', {}, O.nosub ?? O.off);
  ledger('of the rail organisation', '', {}, O.rail);
  ledger('of another organisation', '?limit=100', {}, O.b);
  for (const limit of ['1', '2', '25', '100', '101', '1000', '0', '-1', '2.5', 'abc', '', ' 5']) ledger(`limit=${JSON.stringify(limit)}`, `?limit=${encodeURIComponent(limit)}`);
  // Every page of the organisation, by the cursor of the page before: 30 at a time, then 7 at a time across the six rows of one millisecond.
  const pages = Math.ceil(R.paging.total / 30);
  ledger('page 1 of 30', '?limit=30', { capture: { c30: '$.page.next_cursor' } });
  for (let p = 2; p <= pages; p++) ledger(`page ${p} of 30${p === pages ? ', the last' : ''}`, '?limit=30&cursor={c30}', p === pages ? { expect: { '$.page.next_cursor': null } } : { capture: { c30: '$.page.next_cursor' } });
  ledger('page 1 of 7', '?limit=7', { capture: { c7: '$.page.next_cursor' } });
  for (let p = 2; p <= Math.min(12, Math.ceil(R.paging.total / 7)); p++) ledger(`page ${p} of 7`, '?limit=7&cursor={c7}', { capture: { c7: '$.page.next_cursor' } });
  ledger('a cursor with a filter', '?limit=3&state=ONCHAIN_SETTLED', { capture: { cs: '$.page.next_cursor' } });
  ledger('the next page under that filter', '?limit=3&state=ONCHAIN_SETTLED&cursor={cs}');
  ledger('that cursor under another filter', '?limit=3&state=CANCELLED&cursor={cs}');
  let cursors = 0;
  for (const cursor of ['x', 'bm9wZQ', '%7B%7D', 'e30', 'eyJjIjoxfQ', '..', Buffer.from(JSON.stringify({ c: '2026-10-05T00:00:00.000Z', i: 'PAY-SEED' })).toString('base64url'),
    Buffer.from(JSON.stringify({ c: '2026-10-05T00:00:00.000Z' })).toString('base64url'), Buffer.from(JSON.stringify({ c: 5, i: 6 })).toString('base64url'), Buffer.from('[]').toString('base64url')]) {
    ledger(`cursor ${++cursors}: ${JSON.stringify(cursor.slice(0, 24))}`, `?cursor=${cursor}`);
  }
  ledger('an empty cursor', '?cursor=');
  for (const state of ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED', 'CANCELLED', 'RETURNED', 'EXCEPTION',
    'CANCELLED,RETURNED,EXCEPTION', ' EVIDENCE_ANCHORED , BENEFICIARY_CREDIT_CONFIRMED ', 'CANCELLED,,RETURNED,', 'PAID', 'CANCELLED,PAID', 'cancelled', 'EVIDENCE_ANCHORED,EVIDENCE_ANCHORED']) {
    ledger(`state=${JSON.stringify(state)}`, `?limit=100&state=${encodeURIComponent(state)}`);
  }
  ledger('state that is empty', '?state=');
  ledger('state that names none', '?state=%2C');
  let searches = 0;
  for (const s of (R.search ?? [])) {
    const o = O[s.org];
    searches++;
    ledger(`q ${searches} by ${s.where}`, `?limit=100&q=${encodeURIComponent(s.value)}`, {}, o);
    ledger(`q ${searches} by ${s.where}, in the other case and in part`, `?limit=100&q=${encodeURIComponent(String(s.value).slice(1, -1).toLowerCase() === String(s.value).slice(1, -1) ? String(s.value).slice(1, -1).toUpperCase() : String(s.value).slice(1, -1).toLowerCase())}`, {}, o);
  }
  for (const q of ['PAY-SEED', 'pay-seed-page', 'QT-', '0x', '_', '%', '!', '"', 'APPR-', 'INST-', 'RENT', 'no such thing anywhere', ' ', '한글', 'payment_id', 'bank_reference', 'sourceMessage']) ledger(`q=${JSON.stringify(q)}`, `?limit=100&q=${encodeURIComponent(q)}`);
  ledger('q that is empty', '?q=');
  for (const [file, held] of Object.entries(R.source ?? {})) {
    const src = held.source;
    if (src.uetr) {
      ledger(`by the UETR of ${file}`, `?source_uetr=${src.uetr}`);
      ledger(`by the UETR of ${file}, in capitals`, `?source_uetr=${src.uetr.toUpperCase()}`);
      ledger(`by the UETR of ${file}, as another organisation`, `?source_uetr=${src.uetr}`, {}, O.rail);
    }
    if (src.content) {
      ledger(`by the content of ${file}`, `?source_content=${src.content}`);
      ledger(`by the content of ${file}, in capitals`, `?source_content=${src.content.toUpperCase()}`);
      if (src.valueDate) ledger(`by the content and value date of ${file}`, `?source_content=${src.content}&source_value_date=${src.valueDate}`);
      ledger(`by the content of ${file} and another value date`, `?source_content=${src.content}&source_value_date=2020-01-01`);
      if (src.uetr) ledger(`by the UETR and the content of ${file}`, `?source_uetr=${src.uetr}&source_content=${src.content}&state=EVIDENCE_ANCHORED,ONCHAIN_SETTLED,BENEFICIARY_CREDIT_CONFIRMED,PAYOUT_IN_PROGRESS,BANK_AUTHORIZED,TRAVEL_RULE_PENDING`);
    }
  }
  ledger('by a UETR no settlement has', '?source_uetr=00000000-0000-4000-8000-000000000000');
  ledger('by a UETR that is no UUID', '?source_uetr=nope');
  ledger('by an empty UETR', '?source_uetr=');
  ledger('by a content that is no digest', '?source_content=abc');
  ledger('by a value date alone', '?source_value_date=2026-10-05');
  ledger('by a value date that is no day', `?source_content=${'ab'.repeat(32)}&source_value_date=5-10-2026`);
  ledger('by a value date the calendar has not', `?source_content=${'ab'.repeat(32)}&source_value_date=2026-02-31`);
  for (const [from, to] of [['2026-10-05', ''], ['', '2026-10-05T23:59:59.999Z'], ['2026-10-06', '2026-10-08'], ['2026-10-07T00:00:00.000Z', '2026-10-07T23:59:59.999Z'], ['2027', ''], ['', '2020'], ['tomorrow', 'yesterday'], [R.recent.from, R.recent.to]]) {
    ledger(`from ${JSON.stringify(from)} to ${JSON.stringify(to)}`, `?limit=100${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}`);
  }
  ledger('everything at once', `?limit=5&q=pay-seed&state=ONCHAIN_SETTLED,EVIDENCE_ANCHORED&from=2026-10-01&to=2027-01-01`, { capture: { call: '$.page.next_cursor' } });
  ledger('and its next page', `?limit=5&q=pay-seed&state=ONCHAIN_SETTLED,EVIDENCE_ANCHORED&from=2026-10-01&to=2027-01-01&cursor={call}`);
  add('ledger: by another method', { method: 'DELETE', target: L, headers: key(O.read) });

  // ── one settlement, its chain, its evidence ──────────────────────────────────────────────────────────────────
  const one = (name, target, more = {}, o = O.read) => add(name, { target, headers: key(o), ...more });
  /** The bundle of an anchored record says when it was put together: now, on each server. */
  const WHEN = ['$.attestation.bundle.generated_at'];
  for (const [name, s] of Object.entries(R.settlements.read ?? {})) {
    one(`settlement ${name} (${s.state})`, `${L}/${s.id}`);
    one(`evidence of ${name} (${s.packaged ? 'packaged' : 'no package'}${s.attestation ? `, anchor ${s.attestation.status}` : ''})`, `${L}/${s.id}/evidence`, { volatile: WHEN });
    if (!s.chain_tx) one(`chain of ${name}, which has no transfer`, `${L}/${s.id}/chain`);
  }
  for (const [kind, id] of Object.entries(R.chain ?? {})) one(`chain: ${kind}`, `${L}/${id}/chain`);
  for (const org of ['rail', 'b', 'nohook']) {
    for (const [name, s] of Object.entries(R.settlements[org] ?? {}).slice(0, 6)) {
      one(`settlement ${name} of ${org} (${s.state})`, `${L}/${s.id}`, {}, O[org]);
      one(`settlement ${name} of ${org}, asked for by another organisation`, `${L}/${s.id}`);
      one(`evidence of ${name} of ${org}, asked for by another organisation`, `${L}/${s.id}/evidence`);
      one(`chain of ${name} of ${org}, asked for by another organisation`, `${L}/${s.id}/chain`);
    }
  }
  for (const id of ['PAY-NO-SUCH', 'reconcile', 'bundle', 'pay-seed-anchored-a', 'PAY-SEED-ANCHORED-A%20', '%50AY-SEED-ANCHORED-A', 'PAY-SEED-ANCHORED-A/', '%', '%E0%A4%A', 'a'.repeat(200)]) {
    const shown = JSON.stringify(id.length > 30 ? `${id.slice(0, 8)}… (${id.length})` : id);
    one(`settlement ${shown}`, `${L}/${id}`);
    one(`chain of ${shown}`, `${L}/${id}/chain`);
    one(`evidence of ${shown}`, `${L}/${id}/evidence`, { volatile: WHEN });
  }
  one('a path under a settlement that is no route', `${L}/PAY-SEED-ANCHORED-A/events`);
  one('a settlement with a query', `${L}/PAY-SEED-ANCHORED-A?x=1`);
  add('a settlement by another method', { method: 'PUT', target: `${L}/PAY-SEED-ANCHORED-A`, headers: jkey(O.read), body: {} });

  // ── daily manifests ──────────────────────────────────────────────────────────────────────────────────────────
  const M = '/v1/manifests/daily';
  one('manifests: the newest', M);
  for (const date of Object.keys(R.manifests ?? {})) one(`manifests: of ${date}`, `${M}?date=${date}`);
  one('manifests: of a day without one', `${M}?date=2020-01-01`);
  one('manifests: of a day that is no day', `${M}?date=yesterday`);
  one('manifests: of an empty day', `${M}?date=`);
  one('manifests: of another organisation', M, {}, O.rail);
  const day = Object.keys(R.by_day?.rail ?? {}).sort()[0];
  const ids = day ? R.by_day.rail[day] : [];
  const manifest = (date, payment_ids, more = {}) => ({ date, institution_id: O.rail.bank.id, payment_ids, count: payment_ids.length, ...more });
  const signed = (m) => ({ manifest: m, sig: bankSig(m) });
  const NEWM = ['$.verdict.checked_at', '$.platform_signature.sig', '$.commitment', '$.attestation_id'];
  const submit = (name, body, more = {}) => add(`manifest: ${name}`, { method: 'POST', target: M, headers: jkey(O.rail), body, ...more });
  submit('an empty body', {});
  submit('a body that is null', 'null');
  submit('a body that is not JSON', '{');
  submit('no date', signed({ institution_id: O.rail.bank.id, payment_ids: [], count: 0 }));
  submit('a date of another shape', signed(manifest('05-10-2026', [])));
  submit('a date that is a number', signed(manifest(20261005, [])));
  submit('ids that are no list', signed({ date: '2026-10-05', payment_ids: 'PAY-1', count: 1 }));
  submit('a count that does not match', signed({ date: '2026-10-05', payment_ids: ['PAY-1'], count: 2 }));
  submit('a count that is text', signed({ date: '2026-10-05', payment_ids: ['PAY-1'], count: '1' }));
  submit('no count', signed({ date: '2026-10-05', payment_ids: [] }));
  submit('no signature', { manifest: manifest('2026-10-05', []) });
  submit('a signature of another key', { manifest: manifest('2026-10-05', []), sig: signEvent(manifest('2026-10-05', []), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, O.rail.bank.id, O.rail.bank.name) });
  submit('a manifest changed after it was signed', { manifest: manifest('2026-10-05', ['PAY-1']), sig: bankSig(manifest('2026-10-05', [])) });
  submit('a signature that is text', { manifest: manifest('2026-10-05', []), sig: 'signed' });
  submit('a manifest with a fraction in it', { manifest: manifest('2026-10-05', [], { weight: 0.5 }), sig: bankSig(manifest('2026-10-05', [])) });
  if (day) {
    submit(`everything of ${day}`, signed(manifest(day, ids)), { volatile: NEWM, capture: { m1: '$.attestation_id' }, expect: { '$.verdict.status': 'MATCHED' } });
    one('manifests: the day now has one', `${M}?date=${day}`, { volatile: ['$.data[0].commitment', '$.data[0].attestation.id', '$.data[0].created_at', '$.data[0].verdict.checked_at'] }, O.rail);
    one('manifests: its anchor record', '/v1/attestations/{m1}', { volatile: ['$.id', '$.leaf_bytes', '$.created_at'] }, O.rail);
    one('manifests: the bundle of its anchor record, which is in no batch yet', '/v1/attestations/{m1}/bundle', {}, O.rail);
    submit(`one of ${day} left out, one nobody knows, one of another organisation, one that is no text`, signed(manifest(day, [...ids.slice(1), 'PAY-B1-NOBODY-KNOWS', others?.id ?? 'PAY-X', 7])),
      { volatile: NEWM, expect: { '$.verdict.status': 'DISCREPANT' } });
    one('manifests: the day\'s manifest was replaced', `${M}?date=${day}`, { volatile: ['$.data[0].commitment', '$.data[0].attestation.id', '$.data[0].created_at', '$.data[0].verdict.checked_at'] }, O.rail);
    submit(`${day} with ids twice and members nobody reads`, signed(manifest(day, [...ids, ...ids], { note: 'sent again', institution_id: 'SOMEBODY-ELSE' })), { volatile: NEWM });
  }
  submit('a day nothing was instructed on, with nothing', signed(manifest('2020-01-01', [])), { volatile: NEWM, expect: { '$.verdict.status': 'MATCHED' } });
  submit('a day nothing was instructed on, with something', signed(manifest('2020-01-02', ['PAY-B1-NOBODY-KNOWS'])), { volatile: NEWM, expect: { '$.verdict.status': 'DISCREPANT' } });
  one('manifests: the newest, after these', M, { volatile: [/^\$\.data\[\d+\]\.(commitment|created_at)$/, /^\$\.data\[\d+\]\.attestation\.id$/, /^\$\.data\[\d+\]\.verdict\.checked_at$/] }, O.rail);
  add('manifest: by another method', { method: 'PUT', target: M, headers: jkey(O.rail), body: {} });
  return cases;
};
