/**
 * The settlement rail, what a counterparty and an operator see: the public registry, and the two routes behind the
 * operator's token.
 *
 *   GET  /v1/remit/meta                         the platform's key and every institution, in the order registered
 *   POST /v1/remit/registry/institutions        register or change an institution
 *   POST /v1/remit/registry/deactivate          switch an organisation's products off, by its account's address
 *
 * The registration writes the registry both services read their keyring from, so every change is followed by the
 * list. An institution is given an id of this file's own (`RA-…`); the seeded partners are never changed. The
 * deactivation is of the seeded organisation made for it (`parity-remit-deact`): product by product, then all of
 * them — and afterwards what that organisation may still do. Its subscriptions stay off for the files that follow
 * (remit-b asks what becomes of its settlements under way).
 *
 * The token is read from the two servers' settings files (run.mjs --ref-env / --java-env) and written nowhere.
 */
import { generateKeyPairSync } from 'node:crypto';
import { remitKit, ISSUED } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-02: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, J, key, jkey, admin, TOKEN } = k;
  const cases = [];
  const add = (name, c) => cases.push({ name, ...c });
  const META = '/v1/remit/meta';
  const meta = (name, more = {}) => add(name, { target: META, blur: ISSUED, ...more });

  // ── the public registry ──────────────────────────────────────────────────────────────────────────────────────
  meta('meta, to anyone', { expect: { '$.platform_signer.key_id': R.platform.key_id, '$.platform_signer.spki': R.platform.spki, '$.platform_signer.algorithm': 'ES256', '$.mode': 'sandbox' } });
  meta('meta, with a key', { headers: key(O.rail) });
  meta('meta, with a key that is no key', { headers: { Authorization: 'Bearer nothing' } });
  add('meta, with a query', { target: `${META}?institutions=none&x=1`, blur: ISSUED });
  add('meta, by HEAD', { method: 'HEAD', target: META });
  add('meta, by POST', { method: 'POST', target: META, headers: J, body: {} });
  add('meta with a slash after it', { target: `${META}/`, blur: ISSUED });
  add('a path under meta', { target: `${META}/platform_signer` });

  // ── registering an institution ───────────────────────────────────────────────────────────────────────────────
  const I = '/v1/remit/registry/institutions';
  const spki = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const jwk = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const first = { id: 'RA-BFI-ONE', role: 'BENEFICIARY_FI', name: 'Registered by remit-a', country: 'SG', signing_spki: spki(), encryption_jwk: jwk(), authority: ['PAYOUT_ACCEPTED', 'TRAVEL_RULE_RECEIVED', 'travelRule'] };
  const post = (name, headers, body, more = {}) => add(`register: ${name}`, { method: 'POST', target: I, headers, body, ...more });

  post('no token', J, first);
  post('a wrong token', { ...J, 'X-Admin-Token': `${TOKEN}x` }, first);
  post('the token in another case', { ...J, 'X-Admin-Token': TOKEN.toUpperCase() === TOKEN ? TOKEN.toLowerCase() : TOKEN.toUpperCase() }, first);
  post('an empty token', { ...J, 'X-Admin-Token': '' }, first);
  post('the token with a space before it', { ...J, 'X-Admin-Token': ` ${TOKEN}` }, { id: 'RA-SPACE', role: 'BENEFICIARY_FI', name: 'a token with white space around it' });
  post('the token sent twice', { ...J, 'X-Admin-Token': TOKEN, 'x-admin-token': TOKEN }, first);
  post('the token as a bearer key', { ...J, Authorization: `Bearer ${TOKEN}` }, first);
  post('an API key and no token', jkey(O.rail), first);
  post('no token and a body that is no JSON: the token first', J, '{');
  post('the token and a body that is no JSON', admin, '{"id":');
  post('a body that is null', admin, 'null');
  post('a body that is a list', admin, '[]');
  post('a body that is text', admin, '"RA-BFI-ONE"');
  post('an empty body', admin, {});
  add('register: no body at all', { method: 'POST', target: I, headers: { 'X-Admin-Token': TOKEN } });
  post('no id', admin, { role: 'BENEFICIARY_FI', name: 'x' });
  post('no role', admin, { id: 'RA-X', name: 'x' });
  post('no name', admin, { id: 'RA-X', role: 'BENEFICIARY_FI' });
  post('an empty id', admin, { id: '', role: 'BENEFICIARY_FI', name: 'x' });
  post('an empty name', admin, { id: 'RA-X', role: 'BENEFICIARY_FI', name: '' });
  post('an id that is null', admin, { id: null, role: 'BENEFICIARY_FI', name: 'x' });
  meta('meta: nothing was registered by the refused requests');

  post('a new institution', admin, first, { expect: { '$.id': 'RA-BFI-ONE' } });
  meta('meta lists it last, with both keys');
  post('the same again, to the letter', admin, first);
  meta('meta: nothing changed');
  post('again with another name and nothing else: the keys stay, the country and the authority do not', admin, { id: first.id, role: 'BENEFICIARY_FI', name: 'Registered by remit-a, renamed' });
  meta('meta after the renaming');
  post('again with another role', admin, { id: first.id, role: 'LOCAL_PAYOUT_BANK', name: 'Registered by remit-a, renamed', country: 'SG', authority: ['LOCAL_CREDIT_CONFIRMED'] });
  post('again with another signing key', admin, { ...first, signing_spki: spki() });
  post('again with an encryption key that is null', admin, { ...first, encryption_jwk: null });
  meta('meta: an encryption key of null is stored as the word, and listed as null');
  post('again with an encryption key that is false', admin, { id: first.id, role: first.role, name: first.name, encryption_jwk: false });
  meta('meta: an encryption key of false');
  post('again with an encryption key that is a number', admin, { id: first.id, role: first.role, name: first.name, encryption_jwk: 7 });
  post('again with an encryption key that is text', admin, { id: first.id, role: first.role, name: first.name, encryption_jwk: 'a key' });
  meta('meta: an encryption key that is text');
  post('again with an empty signing key and an empty country: both read as not given', admin, { ...first, signing_spki: '', country: '' });
  post('again with an authority that is empty', admin, { ...first, authority: [] });
  post('again with an authority that is text', admin, { id: first.id, role: first.role, name: first.name, authority: 'PAYOUT_ACCEPTED' });
  meta('meta: an authority that is text');
  post('again as it was first', admin, first);

  post('a role nobody knows', admin, { id: 'RA-ROLE', role: 'CENTRAL_BANK', name: 'A role of its own' });
  post('a role in lower case', admin, { id: 'RA-ROLE-LOWER', role: 'beneficiary_fi', name: 'A role in lower case' });
  post('members nobody reads', admin, { id: 'RA-MORE', role: 'SETTLEMENT_ENTITY_CANDIDATE', name: 'More than is read', org_id: O.b.id, console_spki: 'x', created_at: '2020-01-01T00:00:00.000Z', extra: { a: [1, 2] } });
  post('an id in lower case with a space', admin, { id: 'ra lower', role: 'BENEFICIARY_FI', name: 'An id nobody would issue' });
  post('an id of 64 characters', admin, { id: `RA-${'L'.repeat(61)}`, role: 'BENEFICIARY_FI', name: 'As long as the column' });
  post('an id of 65 characters: one more than the column holds', admin, { id: `RA-${'L'.repeat(62)}`, role: 'BENEFICIARY_FI', name: 'Longer than the column' });
  post('a role of 33 characters: one more than the column holds', admin, { id: 'RA-LONG-ROLE', role: 'R'.repeat(33), name: 'A role longer than the column' });
  post('a name of 2,000 characters', admin, { id: 'RA-LONG-NAME', role: 'BENEFICIARY_FI', name: 'n'.repeat(2000) });
  post('a name that is not ASCII', admin, { id: 'RA-NAME', role: 'BENEFICIARY_FI', name: '수취기관 — «Bénéficiaire» 😀', country: 'KR' });
  post('a country of five letters', admin, { id: 'RA-COUNTRY', role: 'BENEFICIARY_FI', name: 'A long country', country: 'KOREA' });
  // A key that is no key is stored as written: nothing here checks it. Both services leave such a row out of the
  // keyring and list it all the same. It is given a real key again below — a package made while it stands lists a
  // key the bank's SDK cannot read.
  post('a signing key that is no key', admin, { id: 'RA-NO-KEY', role: 'LOCAL_PAYOUT_BANK', name: 'A key that is none', signing_spki: 'not a key at all' });
  meta('meta lists the key as written');
  post('that institution given a key', admin, { id: 'RA-NO-KEY', role: 'LOCAL_PAYOUT_BANK', name: 'A key that is none', signing_spki: spki() });
  meta('meta after all registrations');

  // ── switching an organisation's products off ─────────────────────────────────────────────────────────────────
  const D = '/v1/remit/registry/deactivate';
  const mail = O.deact.account.email;
  const off = (name, headers, body, more = {}) => add(`deactivate: ${name}`, { method: 'POST', target: D, headers, body, ...more });
  const aQuote = { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '100.00' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } };
  const NEWQ = ['$.quote_id', '$.quoted_at', '$.expires_at'];
  off('no token', J, { email: mail });
  off('a wrong token', { ...J, 'X-Admin-Token': 'remit-admin' }, { email: mail });
  off('an API key of that organisation and no token', jkey(O.deact), { email: mail });
  off('no token and a body that is no JSON', J, '{');
  off('a body that is no JSON', admin, '{');
  off('a body that is null', admin, 'null');
  off('an empty body', admin, {});
  off('an empty address', admin, { email: '' });
  off('an address nobody has', admin, { email: 'nobody-at-all@parity-remit.example' });
  off('an address nobody has, and products that are no list', admin, { email: 'nobody-at-all@parity-remit.example', products: 'remit' });
  off('an address that is a number', admin, { email: 20261119 });
  off('an address that is a list', admin, { email: [mail] });
  off('an address with a space after it', admin, { email: `${mail} ` });
  add('before anything is switched off: a quote of that organisation', { method: 'POST', target: '/v1/quotes', headers: jkey(O.deact), body: aQuote, volatile: NEWQ });
  off('products that are an empty list: nothing is switched off', admin, { email: mail, products: [] });
  off('a product nobody offers', admin, { email: mail, products: ['settlement'] });
  off('one product', admin, { email: mail, products: ['por'] }, { expect: { '$.results.por': 'inactive' } });
  off('the same product again', admin, { email: mail, products: ['por'] });
  add('with the reserve product off: a quote is still given', { method: 'POST', target: '/v1/quotes', headers: jkey(O.deact), body: aQuote, volatile: NEWQ });
  off('a product twice, one nobody offers, and the rail', admin, { email: mail, products: ['por', 'nothing', 'remit', 'por'] }, { expect: { '$.results.remit': 'inactive', '$.results.nothing': 'not_subscribed' } });
  add('with the rail off: a quote is refused', { method: 'POST', target: '/v1/quotes', headers: jkey(O.deact), body: aQuote, expect: { '$.error': 'subscription_required' } });
  add('with the rail off: an instruction is refused before its key header is looked at', { method: 'POST', target: '/v1/settlements', headers: jkey(O.deact), body: {} });
  add('with the rail off: a manifest is refused', { method: 'POST', target: '/v1/manifests/daily', headers: jkey(O.deact), body: {} });
  add('with the rail off: the ledger is still read', { target: '/v1/settlements', headers: key(O.deact) });
  add('with the rail off: a settlement is still read', { target: `/v1/settlements/${R.settlements.deact.onchain.id}`, headers: key(O.deact) });
  add('with the rail off: its chain is still read', { target: `/v1/settlements/${R.settlements.deact.onchain.id}/chain`, headers: key(O.deact) });
  add('with the rail off: the manifests are still read', { target: '/v1/manifests/daily', headers: key(O.deact) });
  off('the address in capitals, every product', admin, { email: mail.toUpperCase() }, { expect: { '$.results.attest': 'inactive', '$.results.remit': 'inactive', '$.results.por': 'inactive' } });
  off('every product again, and members nobody reads', admin, { email: mail, org_id: O.rail.id, product: 'remit' });
  off('products that are text: its characters, one by one', admin, { email: mail, products: 'por' });
  meta('meta: its institutions are still listed');
  return cases;
};
