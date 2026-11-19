/**
 * The settlement rail, acceptance: `POST /v1/settlements` — everything that is refused, and in what order.
 *
 * **Nothing here is accepted.** A request that is accepted starts the pipeline (remit-b-*); every case of this file
 * names the refusal it is about (`expect`), so one that was accepted after all shows as a difference on both sides.
 *
 * The order of the checks is the contract (docs/REMIT-HANDOVER.md 1.4, apps/core/src/remit/routes.ts and
 * orchestrator.ts `acceptSettlement`): the Idempotency-Key header — the body — a stored answer under that key — the
 * payment id — a settlement of that id — the quote — the two amounts — the receiving institution — the bank's
 * signature — the travel-rule data — the three evidence elements — their agreement with the quote and the id — the
 * reference to the bank's message — and only then the transaction. "The ladder" states it: request k is wrong in
 * check k and in every later one, and must be answered for k.
 *
 * The bank's side is the deployed SDK with the seeded key; what it would not sign itself (an element changed, a
 * reference that is none) is signed here the way it signs (`finishElement`). All requests are built once: the same
 * bytes go to both servers — except the few sent as the organisation that holds the seeded messages, which are
 * built on a quote each server gives for them.
 *
 * Not sent, here or anywhere: an id that is a number or `true`. The reference binds what it is given into its
 * prepared statements, and a number makes that connection compare ids as numbers from then on (the builder's
 * tools/probe-reference-id-binding.mjs); every later case would be answered for another settlement.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { RemitClient, finishElement, signEvent, sha256hex } from '../../../../packages/attest-remit/src/index.ts';
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-04: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, P, key, jkey, build, sign, quotes } = k;
  const cases = [];
  const add = (name, c) => cases.push({ name, ...c });
  const S = '/v1/settlements';
  const q = quotes('rail');
  const ID = 'PAY-PA-REFUSED';
  const bank = O.rail.bank;
  const bankKey = createPrivateKey(bank.pem);
  const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const good = (id = ID, opts = {}) => build('rail', q[0], id, opts);
  /** An evidence element signed as the SDK signs one: digest first, then the signature over it. */
  const element = (core, by = bankKey) => finishElement(core, by, bank.id, bank.name);
  const unsigned = ({ signature: _s, digest: _d, ...core }) => core;
  let n = 0;
  const send = (name, body, error, more = {}, headers = {}) => add(`instruction: ${name}`, { method: 'POST', target: S,
    headers: { ...jkey(O.rail), 'Idempotency-Key': `ra-refused-${String(++n).padStart(3, '0')}`, ...headers }, body, expect: { '$.error': error }, ...more });
  const change = (fn, id = ID) => { const b = good(id); return fn(b) ?? b; };

  // ── the key header, before the body is read ──────────────────────────────────────────────────────────────────
  const noKey = (name, headers, body, error = 'missing_idempotency_key') => add(`instruction: ${name}`, { method: 'POST', target: S, headers: { ...jkey(O.rail), ...headers }, body, expect: { '$.error': error } });
  noKey('no key header', {}, good());
  noKey('no key header, and a body that is no JSON', {}, '{');
  noKey('an empty key', { 'Idempotency-Key': '' }, good());
  noKey('a key of seven characters', { 'Idempotency-Key': 'seven-7' }, good());
  noKey('a key of seven characters and white space', { 'Idempotency-Key': '  seven-7  ' }, good());
  noKey('a key of eight characters: the body is read', { 'Idempotency-Key': 'eight--8' }, '{', 'invalid_json');
  noKey('two keys of four characters: read as one, joined', { 'Idempotency-Key': 'four', 'idempotency-key': 'more' }, {}, 'invalid_payment_id');
  noKey('a key that is not ASCII', { 'Idempotency-Key': 'schlüssel-8' }, {}, 'invalid_payment_id');
  noKey('a key of 191 characters', { 'Idempotency-Key': 'k'.repeat(191) }, {}, 'invalid_payment_id');
  // The column holds 191. The reference reads on and would fail only when it stores an accepted answer; the body here is refused first.
  noKey('a key of 192 characters, with a body that is refused anyway', { 'Idempotency-Key': 'k'.repeat(192) }, {}, 'invalid_payment_id');
  noKey('a key of 192 characters, with a body that is no JSON', { 'Idempotency-Key': 'k'.repeat(192) }, '{', 'invalid_json');
  noKey('a key of 4,000 characters', { 'Idempotency-Key': 'k'.repeat(4000) }, {}, 'invalid_payment_id');

  // ── the body ─────────────────────────────────────────────────────────────────────────────────────────────────
  send('a body that is no JSON', '{"payment_id":', 'invalid_json');
  send('a body that is JSON and something after it', `${JSON.stringify(good())}]`, 'invalid_json');
  send('a body that is null', 'null', 'internal');
  send('a body that is a list', '[]', 'invalid_payment_id');
  send('a body that is a list of an instruction', JSON.stringify([good()]), 'invalid_payment_id');
  send('a body that is text', '"PAY-PA-REFUSED"', 'invalid_payment_id');
  send('a body that is a number', '42', 'invalid_payment_id');
  send('a body that is true', 'true', 'invalid_payment_id');
  send('an empty body', {}, 'invalid_payment_id');
  add('instruction: no body at all', { method: 'POST', target: S, headers: { ...key(O.rail), 'Idempotency-Key': 'ra-refused-nobody' }, expect: { '$.error': 'invalid_payment_id' } });
  send('a body over one megabyte', `{"payment_id":"${ID}","pad":"${'a'.repeat(1 << 20)}"}`, 'payload_too_large');
  send('a body nested a thousand deep', `{"payment_id":"abc","deep":${'['.repeat(1001)}${']'.repeat(1001)}}`, 'invalid_payment_id');
  send('a body whose members are named twice: the last counts', `{"payment_id":"${ID}","payment_id":"abc"}`, 'invalid_payment_id');

  // ── a key that already stands for an answer ──────────────────────────────────────────────────────────────────
  const seededOfRail = R.settlements.rail['terminal-anchored'];
  add('instruction: the key of a seeded settlement with another body: a conflict before anything else is looked at', { method: 'POST', target: S,
    headers: { ...jkey(O.rail), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: {}, expect: { '$.error': 'idempotency_conflict' } });
  add('instruction: that key with a body that could be accepted', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: good(), expect: { '$.error': 'idempotency_conflict' } });
  add('instruction: that key with a body that is null', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: 'null', expect: { '$.error': 'idempotency_conflict' } });
  add('instruction: that key as another organisation: its own keys, no conflict', { method: 'POST', target: S, headers: { ...jkey(O.b), 'Idempotency-Key': `sdk-${seededOfRail.id}` }, body: {}, expect: { '$.error': 'invalid_payment_id' } });
  add('instruction: that key in capitals: another key', { method: 'POST', target: S, headers: { ...jkey(O.rail), 'Idempotency-Key': `SDK-${seededOfRail.id}` }, body: {}, expect: { '$.error': 'invalid_payment_id' } });

  // ── the ladder: wrong in check k and in every check after it ─────────────────────────────────────────────────
  const other = build('rail', q[8], 'PAY-PA-OTHER-REF'); // another amount and another reference, properly signed
  const badSource = { type: 'MT103', sha256: 'ab'.repeat(32), uetr: 'not-a-uuid' };
  const instructionOf = (amount, ref, source) => element({ ...unsigned(good().evidence_elements.bankInstruction), amount, ref, ...(source ? { sourceMessage: source } : {}) });
  const rungs = [
    // [the refusal, what is wrong, how the request is made wrong in this check — given the request and the rung's own number]
    ['invalid_payment_id', 'the payment id is no id', (b) => { b.payment_id = 'abc'; }],
    ['missing_field', 'no quote id', (b) => { b.quote_id = ''; }, 'quote_id is required'],
    ['duplicate_payment', 'the id of a settlement that exists', (b) => { b.payment_id = seededOfRail.id; }],
    ['quote_not_found', 'a quote nobody made', (b) => { b.quote_id = 'QT-00000000-0000'; }],
    ['quote_expired', 'a quote that has expired', (b) => { b.quote_id = R.quotes.expired.quote_id; }],
    ['amount_mismatch', 'another collected amount', (b) => { b.amount = { ...b.amount, collected: { currency: 'VND', value: '1' } }; }, `collected amount must restate the quote: ${q[0].collect.amount} VND`],
    ['amount_mismatch', 'another payout amount', (b) => { b.amount = { ...b.amount, payout: { currency: 'SGD', value: '1.00' } }; }, `payout amount must restate the quote: ${q[0].payout.amount} SGD`],
    ['missing_field', 'no receiving institution', (b) => { b.beneficiary = { beneficiary_ref: 'x' }; }, 'beneficiary.institution_id is required'],
    ['unknown_beneficiary_institution', 'an institution nobody registered', (b) => { b.beneficiary = { institution_id: 'SG-BFI-NOBODY' }; }],
    ['bfi_has_no_encryption_key', 'an institution without an encryption key', (b) => { b.beneficiary = { institution_id: R.institutions.noEnc }; }],
    ['missing_field', 'an authorisation that is text', (b) => { b.bank_authorization = 'authorised'; }, 'bank_authorization is required'],
    ['missing_field', 'no signature', (b) => { delete b.bank_signature; }, 'bank_signature is required'],
    ['invalid_signature', 'a signature of another key', (b) => { b.bank_signature = signEvent(b.bank_authorization, stranger, bank.id, bank.name); }],
    ['travel_rule_incomplete', 'no travel-rule data', (b) => { b.compliance_payload = { format: 'IVMS101-2023', mode: 'A' }; }],
    ['missing_evidence_element', 'no instruction element', (b) => { delete b.evidence_elements.bankInstruction; }, 'evidence_elements.bankInstruction is required'],
    ['invalid_evidence_signature', 'an instruction element changed after it was signed', (b) => { b.evidence_elements.bankInstruction = { ...other.evidence_elements.bankInstruction, sourceMessage: badSource }; }, 'evidence_elements.bankInstruction signature does not verify with the registered bank key'],
    ['missing_evidence_element', 'no approval element', (b) => { delete b.evidence_elements.bankApproval; }, 'evidence_elements.bankApproval is required'],
    ['invalid_evidence_signature', 'an approval element changed after it was signed', (b) => { b.evidence_elements.bankApproval = { ...good().evidence_elements.bankApproval, approvedByRole: 'somebody else' }; }, 'evidence_elements.bankApproval signature does not verify with the registered bank key'],
    ['missing_evidence_element', 'no documents element', (b) => { delete b.evidence_elements.commercialDocs; }, 'evidence_elements.commercialDocs is required'],
    ['invalid_evidence_signature', 'a documents element changed after it was signed', (b) => { b.evidence_elements.commercialDocs = { ...good().evidence_elements.commercialDocs, amount: '1.00' }; }, 'evidence_elements.commercialDocs signature does not verify with the registered bank key'],
    ['evidence_inconsistent', 'an instruction element for another amount', (b) => { b.evidence_elements.bankInstruction = instructionOf(q[8].trade.amount, 'PAY-PA-OTHER-REF', badSource); }, `bankInstruction must instruct the quoted trade amount ${q[0].trade.amount} USD`],
    ['evidence_inconsistent', 'an instruction element with another reference', (b) => { b.evidence_elements.bankInstruction = instructionOf(q[0].trade.amount, 'PAY-PA-OTHER-REF', badSource); }, 'bankInstruction.ref must carry the payment_id (the corridor settlement id)'],
    ['invalid_source_message', 'a reference to a message that is none', (b) => { b.evidence_elements.bankInstruction = instructionOf(q[0].trade.amount, ID, badSource); }, 'evidence_elements.bankInstruction.sourceMessage: uetr must be a UUID'],
  ];
  // Which member each rung touches: of several rungs on one member, the first one at or after k is the one applied.
  const member = ['payment_id', 'quote_id', 'payment_id', 'quote_id', 'quote_id', 'collected', 'payout', 'beneficiary', 'beneficiary', 'beneficiary', 'authorization', 'signature', 'signature', 'compliance',
    'instruction', 'instruction', 'approval', 'approval', 'documents', 'documents', 'instruction', 'instruction', 'instruction'];
  for (let i = 0; i < rungs.length; i++) {
    const b = good();
    const done = new Set();
    // Later checks first, so that what the earlier check needs is applied last — and one fault per member.
    const apply = [];
    for (let j = i; j < rungs.length; j++) { if (done.has(member[j])) continue; done.add(member[j]); apply.push(j); }
    for (const j of apply.reverse()) rungs[j][2](b);
    send(`the ladder, rung ${String(i + 1).padStart(2, '0')} — ${rungs[i][1]}, and everything after it wrong as well`, b, rungs[i][0], rungs[i][3] ? { expect: { '$.error': rungs[i][0], '$.message': rungs[i][3] } } : {});
  }

  // ── the payment id ───────────────────────────────────────────────────────────────────────────────────────────
  // An id that passes is shown to pass by the next thing that is wrong: the signed instruction names another id.
  for (const [id, error] of [['abc', 'invalid_payment_id'], ['abcd', 'evidence_inconsistent'], ['A'.repeat(64), 'evidence_inconsistent'], ['A'.repeat(65), 'invalid_payment_id'], ['PAY PA', 'invalid_payment_id'],
    ['PAY/PA', 'invalid_payment_id'], ['PAY.PA', 'invalid_payment_id'], ['-PAY-PA', 'invalid_payment_id'], ['_PAY_PA', 'invalid_payment_id'], ['9-PA', 'evidence_inconsistent'], ['pay_pa-0', 'evidence_inconsistent'],
    ['PAY-PA-ÅÄÖ', 'invalid_payment_id'], ['PAY-PA\n', 'invalid_payment_id'], ['\nPAY-PA', 'invalid_payment_id'], [' PAY-PA', 'invalid_payment_id'], ['PAY-PA ', 'invalid_payment_id'], ['', 'invalid_payment_id'],
    ['reconcile', 'invalid_payment_id'], ['bundle', 'invalid_payment_id'], ['Reconcile', 'evidence_inconsistent'], ['bundles', 'evidence_inconsistent'], ['PAY-ＰＡ', 'invalid_payment_id']]) {
    send(`payment id ${JSON.stringify(id.length > 24 ? `${id.slice(0, 6)}… (${id.length})` : id)}`, { ...good(), payment_id: id }, error);
  }
  send('no payment id', change((b) => { delete b.payment_id; }), 'invalid_payment_id');
  send('a payment id that is null', { ...good(), payment_id: null }, 'invalid_payment_id');
  send('the id of a seeded settlement', good(seededOfRail.id), 'duplicate_payment');
  send('the id of a seeded settlement, and nothing else right', { payment_id: seededOfRail.id, quote_id: 'QT-none' }, 'duplicate_payment');
  send('the id of another organisation\'s settlement: it exists, and that is said', good('PAY-SEED-ANCHORED-A'), 'duplicate_payment');
  send('the id of a seeded settlement in lower case: another id, and none that exists', { ...good(), payment_id: seededOfRail.id.toLowerCase() }, 'evidence_inconsistent');

  // ── the quote ────────────────────────────────────────────────────────────────────────────────────────────────
  send('no quote id', change((b) => { delete b.quote_id; }), 'missing_field');
  send('a quote id that is null', { ...good(), quote_id: null }, 'missing_field');
  send('a quote nobody made', { ...good(), quote_id: 'QT-00000000-0000' }, 'quote_not_found');
  send('a quote of another organisation', { ...good(), quote_id: R.quotes.fresh.b[0].quote_id }, 'quote_not_found');
  send('a quote id in another case', { ...good(), quote_id: q[0].quote_id.toUpperCase() }, 'quote_not_found');
  // Not sent: a quote id with a space after it. The store's collation pads with spaces, so the quote is found and the
  // instruction is accepted (found by this file's first run) — and this file accepts nothing.
  send('a quote that has expired', { ...good(), quote_id: R.quotes.expired.quote_id }, 'quote_expired');
  send('a quote whose stored text is no JSON', { ...good(), quote_id: R.quotes.broken }, 'internal');
  send('a quote for another amount than the instruction restates', { ...good(), quote_id: q[8].quote_id }, 'amount_mismatch');

  // ── the amounts restate the quote ────────────────────────────────────────────────────────────────────────────
  const withAmount = (leg, over) => change((b) => { b.amount = { ...b.amount, [leg]: { ...b.amount[leg], ...over } }; });
  send('another collected amount', withAmount('collected', { value: '1' }), 'amount_mismatch');
  send('the collected amount as a number', withAmount('collected', { value: Number(q[0].collect.amount) }), 'amount_mismatch');
  send('the collected amount with a space', withAmount('collected', { value: `${q[0].collect.amount} ` }), 'amount_mismatch');
  send('the collected amount with a zero before it', withAmount('collected', { value: `0${q[0].collect.amount}` }), 'amount_mismatch');
  send('the collected amount with decimals', withAmount('collected', { value: `${q[0].collect.amount}.00` }), 'amount_mismatch');
  send('another collected currency', withAmount('collected', { currency: 'USD' }), 'amount_mismatch');
  send('the collected currency in lower case', withAmount('collected', { currency: 'vnd' }), 'amount_mismatch');
  send('another payout amount', withAmount('payout', { value: '1.00' }), 'amount_mismatch');
  send('the payout amount without its cents', withAmount('payout', { value: q[0].payout.amount.replace(/\.\d+$/, '') }), 'amount_mismatch');
  send('the payout amount with a third decimal', withAmount('payout', { value: `${q[0].payout.amount}0` }), 'amount_mismatch');
  send('another payout currency', withAmount('payout', { currency: 'VND' }), 'amount_mismatch');
  send('no payout leg', change((b) => { b.amount = { collected: b.amount.collected }; }), 'amount_mismatch');
  send('the two legs changed over', change((b) => { b.amount = { collected: b.amount.payout, payout: b.amount.collected }; }), 'amount_mismatch');
  send('no amounts', change((b) => { delete b.amount; }), 'amount_mismatch');
  send('amounts that are null', { ...good(), amount: null }, 'amount_mismatch');
  send('amounts that are text', { ...good(), amount: 'as quoted' }, 'amount_mismatch');
  send('amounts that are a list', { ...good(), amount: [] }, 'amount_mismatch');

  // ── the receiving institution ────────────────────────────────────────────────────────────────────────────────
  const toward = (institution_id) => change((b) => { b.beneficiary = { ...b.beneficiary, institution_id }; });
  send('no beneficiary', change((b) => { delete b.beneficiary; }), 'missing_field');
  send('a beneficiary that is null', { ...good(), beneficiary: null }, 'missing_field');
  send('a beneficiary without an institution', { ...good(), beneficiary: { beneficiary_ref: 'BEN-1' } }, 'missing_field');
  send('an empty institution id', toward(''), 'missing_field');
  send('an institution nobody registered', toward('SG-BFI-NOBODY'), 'unknown_beneficiary_institution');
  send('the receiving institution\'s id in lower case', toward(P.bfi.id.toLowerCase()), 'unknown_beneficiary_institution');
  send('the bank itself as the receiving institution', toward(bank.id), 'unknown_beneficiary_institution');
  send('the settlement entity as the receiving institution', toward(P.wallet.id), 'unknown_beneficiary_institution');
  send('the payout bank as the receiving institution', toward(P.sgbank.id), 'unknown_beneficiary_institution');
  send('the platform as the receiving institution', toward('STONEHASH'), 'unknown_beneficiary_institution');
  send('a key nobody registered as the receiving institution', toward(P.stranger.id), 'unknown_beneficiary_institution');
  send('an institution without an encryption key', toward(R.institutions.noEnc), 'bfi_has_no_encryption_key');

  // ── the bank's authorisation and its signature ───────────────────────────────────────────────────────────────
  send('no authorisation', change((b) => { delete b.bank_authorization; }), 'missing_field');
  send('an authorisation that is null', { ...good(), bank_authorization: null }, 'missing_field');
  send('an authorisation that is text', { ...good(), bank_authorization: 'yes' }, 'missing_field');
  send('an authorisation that is zero', { ...good(), bank_authorization: 0 }, 'missing_field');
  send('an authorisation that is a list: an object, so its signature is looked at', { ...good(), bank_authorization: [] }, 'invalid_signature');
  send('an empty authorisation', { ...good(), bank_authorization: {} }, 'invalid_signature');
  send('no signature', change((b) => { delete b.bank_signature; }), 'missing_field');
  send('a signature that is null', { ...good(), bank_signature: null }, 'missing_field');
  send('a signature that is text', { ...good(), bank_signature: 'signed' }, 'missing_field');
  send('a signature without its value', change((b) => { b.bank_signature = { alg: 'ES256', key_id: bank.id, issuer: bank.name }; }), 'missing_field');
  send('a signature with an empty value', change((b) => { b.bank_signature = { ...b.bank_signature, sig: '' }; }), 'missing_field');
  send('an authorisation changed after it was signed', change((b) => { b.bank_authorization = { ...b.bank_authorization, payment_release: 'AUTHORIZED ' }; }), 'invalid_signature');
  send('an authorisation with a member more than was signed', change((b) => { b.bank_authorization = { ...b.bank_authorization, weight: 0.5 }; }), 'invalid_signature');
  send('a signature of another key under the bank\'s name', change((b) => { b.bank_signature = signEvent(b.bank_authorization, stranger, bank.id, bank.name); }), 'invalid_signature');
  send('a signature of another organisation\'s bank', change((b) => { b.bank_signature = sign('b', b.bank_authorization); }), 'invalid_signature');
  send('a signature under another algorithm\'s name', change((b) => { b.bank_signature = { ...b.bank_signature, alg: 'ES384' }; }), 'invalid_signature');
  send('a signature that is not base64url', change((b) => { b.bank_signature = { ...b.bank_signature, sig: '*'.repeat(86) }; }), 'invalid_signature');
  send('a signature cut short', change((b) => { b.bank_signature = { ...b.bank_signature, sig: b.bank_signature.sig.slice(0, 40) }; }), 'invalid_signature');
  send('a signature in the other encoding (DER)', change((b) => { b.bank_signature = { ...b.bank_signature, sig: 'MEUCIQ' + b.bank_signature.sig }; }), 'invalid_signature');
  send('a signature over the request instead of the authorisation', change((b) => { b.bank_signature = sign('rail', { payment_id: ID }); }), 'invalid_signature');

  // ── travel-rule data, the platform's to encrypt (mode A) ─────────────────────────────────────────────────────
  const comply = (fn) => change((b) => { const c = structuredClone(b.compliance_payload); b.compliance_payload = fn(c) ?? c; });
  send('no travel-rule data', change((b) => { delete b.compliance_payload; }), 'travel_rule_incomplete');
  send('travel-rule data that is null', { ...good(), compliance_payload: null }, 'travel_rule_incomplete');
  send('travel-rule data that is text', { ...good(), compliance_payload: 'see the instruction' }, 'travel_rule_incomplete');
  send('travel-rule data that is a list', { ...good(), compliance_payload: [] }, 'travel_rule_incomplete');
  for (const field of ['originator.name', 'originator.country', 'originator.address', 'originator.registration_number', 'beneficiary.name', 'beneficiary.country', 'beneficiary.account', 'beneficiary.bank']) {
    const [party, member2] = field.split('.');
    send(`travel-rule data without ${field}`, comply((c) => { delete c[party][member2]; }), 'travel_rule_incomplete');
  }
  send('an originator name that is empty', comply((c) => { c.originator.name = ''; }), 'travel_rule_incomplete');
  send('an originator name that is white space', comply((c) => { c.originator.name = ' \t '; }), 'travel_rule_incomplete');
  send('a beneficiary account that is a number', comply((c) => { c.beneficiary.account = 9; }), 'travel_rule_incomplete');
  send('a beneficiary country that is null', comply((c) => { c.beneficiary.country = null; }), 'travel_rule_incomplete');
  send('an originator that is text', comply((c) => { c.originator = 'Vina Trading'; }), 'travel_rule_incomplete');
  send('an originator that is a list of an originator', comply((c) => { c.originator = [c.originator]; }), 'travel_rule_incomplete');
  send('no parties at all', comply(() => ({ format: 'IVMS101-2023', mode: 'A', purpose_code: 'GOODS_PAYMENT' })), 'travel_rule_incomplete');
  send('the last field of each party missing: named in the fixed order', comply((c) => { delete c.beneficiary.bank; delete c.originator.registration_number; delete c.beneficiary.name; }), 'travel_rule_incomplete');

  // ── travel-rule data the bank encrypted (mode B): the platform cannot read it, so the bank's statement has to be about it ──
  const ciphertext = 'eyJhbGciOiJFQ0RILUVTIiwiZW5jIjoiQTI1NkdDTSJ9..aXY.Y2lwaGVydGV4dA.dGFn';
  const digest = sha256hex('the message this ciphertext is said to hold');
  const statement = (over = {}, by = (p) => sign('rail', p)) => { const payload = JSON.parse(JSON.stringify({ payment_id: ID, required_fields_present: true, field_count: 8, schema: 'IVMS101-2023', ivms101_digest: digest, ciphertext_sha256: sha256hex(ciphertext), ...over })); return { payload, sig: by(payload) }; };
  const modeB = (over) => ({ ...good(), compliance_payload: { format: 'IVMS101-2023', mode: 'B', ciphertext, ivms101_digest: digest, fields_assertion: statement(), ...over } });
  send('mode B with nothing', { ...good(), compliance_payload: { mode: 'B' } }, 'travel_rule_incomplete');
  send('mode B with a ciphertext and no digest', modeB({ ivms101_digest: undefined }), 'travel_rule_incomplete');
  send('mode B with a digest and no ciphertext', modeB({ ciphertext: undefined }), 'travel_rule_incomplete');
  send('mode B with an empty ciphertext', modeB({ ciphertext: '' }), 'travel_rule_incomplete');
  send('mode B with a digest in capitals', modeB({ ivms101_digest: digest.toUpperCase() }), 'travel_rule_incomplete');
  send('mode B with a digest of 63 characters', modeB({ ivms101_digest: digest.slice(1) }), 'travel_rule_incomplete');
  send('mode B with a digest and a line feed', modeB({ ivms101_digest: `${digest}\n` }), 'travel_rule_incomplete');
  send('mode B without the bank\'s statement', modeB({ fields_assertion: undefined }), 'invalid_fields_assertion');
  send('mode B with a statement that is text', modeB({ fields_assertion: 'all fields present' }), 'invalid_fields_assertion');
  send('mode B with a statement without its signature', modeB({ fields_assertion: { payload: statement().payload } }), 'invalid_fields_assertion');
  send('mode B with a statement signed by another key', modeB({ fields_assertion: statement({}, (p) => signEvent(p, stranger, bank.id, bank.name)) }), 'invalid_fields_assertion');
  send('mode B with a statement changed after it was signed', modeB({ fields_assertion: { ...statement(), payload: { ...statement().payload, field_count: 9 } } }), 'invalid_fields_assertion');
  send('mode B with a statement about another payment', modeB({ fields_assertion: statement({ payment_id: 'PAY-PA-ANOTHER' }) }), 'invalid_fields_assertion');
  send('mode B with a statement that says "true" in words', modeB({ fields_assertion: statement({ required_fields_present: 'true' }) }), 'invalid_fields_assertion');
  send('mode B with a statement that says the fields are not there', modeB({ fields_assertion: statement({ required_fields_present: false }) }), 'invalid_fields_assertion');
  send('mode B with a statement about another message', modeB({ fields_assertion: statement({ ivms101_digest: sha256hex('another message') }) }), 'invalid_fields_assertion');
  send('mode B with a statement about another ciphertext', modeB({ fields_assertion: statement({ ciphertext_sha256: sha256hex('another ciphertext') }) }), 'invalid_fields_assertion');
  send('mode B with a statement that names no ciphertext', modeB({ fields_assertion: statement({ ciphertext_sha256: undefined }) }), 'invalid_fields_assertion');
  send('mode B with a statement whose ciphertext digest is in capitals', modeB({ fields_assertion: statement({ ciphertext_sha256: sha256hex(ciphertext).toUpperCase() }) }), 'invalid_fields_assertion');
  send('mode B with a statement that says only that the fields are there', modeB({ fields_assertion: statement({ ivms101_digest: undefined, ciphertext_sha256: undefined }) }), 'invalid_fields_assertion');

  // ── the three evidence elements ──────────────────────────────────────────────────────────────────────────────
  const withElement = (name, fn) => change((b) => { b.evidence_elements = { ...b.evidence_elements, [name]: fn(structuredClone(b.evidence_elements[name])) }; });
  send('no evidence elements', change((b) => { delete b.evidence_elements; }), 'missing_evidence_element');
  send('evidence elements that are null', { ...good(), evidence_elements: null }, 'missing_evidence_element');
  send('evidence elements that are text', { ...good(), evidence_elements: 'attached' }, 'missing_evidence_element');
  send('evidence elements under another name', change((b) => { b.evidence_elements = { bank_instruction: b.evidence_elements.bankInstruction, bankApproval: b.evidence_elements.bankApproval, commercialDocs: b.evidence_elements.commercialDocs }; }), 'missing_evidence_element');
  for (const name of ['bankInstruction', 'bankApproval', 'commercialDocs']) {
    send(`no ${name}`, change((b) => { const { [name]: _gone, ...rest } = b.evidence_elements; b.evidence_elements = rest; }), 'missing_evidence_element');
    send(`${name} that is null`, withElement(name, () => null), 'missing_evidence_element');
    send(`${name} that is text`, withElement(name, () => 'an element'), 'invalid_evidence_signature');
    send(`${name} that is an empty object`, withElement(name, () => ({})), 'invalid_evidence_signature');
    send(`${name} with a member more than was signed`, withElement(name, (e) => ({ ...e, changed: 'afterwards' })), 'invalid_evidence_signature');
    send(`${name} without its signature`, withElement(name, (e) => { delete e.signature; return e; }), 'invalid_evidence_signature');
    send(`${name} with a signature that says VALID and has no value`, withElement(name, (e) => ({ ...e, signature: { status: 'VALID', keyId: bank.id, algorithm: 'ES256', issuer: bank.name, trustLevel: 'ATTESTED' } })), 'invalid_evidence_signature');
    send(`${name} signed by another key under the bank's name`, withElement(name, (e) => element(unsigned(e), stranger)), 'invalid_evidence_signature');
    send(`${name} with its digest changed: the digest is signed`, withElement(name, (e) => ({ ...e, digest: sha256hex('another digest') })), 'invalid_evidence_signature');
    send(`${name} without its digest`, withElement(name, (e) => { delete e.digest; return e; }), 'invalid_evidence_signature');
  }
  send('the approval element where the instruction belongs: signed, and no instruction', change((b) => { b.evidence_elements = { ...b.evidence_elements, bankInstruction: b.evidence_elements.bankApproval }; }), 'evidence_inconsistent');
  send('an instruction element for another amount, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), amount: '1.00' })), 'evidence_inconsistent');
  send('an instruction element for the amount without its cents, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), amount: q[0].trade.amount.replace(/\.00$/, '') })), 'evidence_inconsistent');
  send('an instruction element whose amount is a number, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), amount: Number(q[0].trade.amount) })), 'evidence_inconsistent');
  send('an instruction element in another currency, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), currency: 'USDC' })), 'evidence_inconsistent');
  send('an instruction element without a currency, signed', withElement('bankInstruction', (e) => { const { currency: _c, ...rest } = unsigned(e); return element(rest); }), 'evidence_inconsistent');
  send('an instruction element with another reference, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), ref: 'PAY-PA-OTHER-REF' })), 'evidence_inconsistent');
  send('an instruction element whose reference is the id in lower case, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), ref: ID.toLowerCase() })), 'evidence_inconsistent');
  send('an instruction element without a reference, signed', withElement('bankInstruction', (e) => { const { ref: _r, ...rest } = unsigned(e); return element(rest); }), 'evidence_inconsistent');

  // ── the reference to the bank's message: signed, and still not what it claims to be ──────────────────────────
  const msg = { type: 'pacs.008.001.08', sha256: sha256hex('ra: a file nobody sent'), uetr: 'c0ffee00-1111-4222-8333-444455556666', messageId: 'RA-MSG-1', instructionId: 'RA-INS-1', endToEndId: 'RA-E2E-1', valueDate: '2026-11-17', content: sha256hex('ra: content') };
  const from = (source) => withElement('bankInstruction', (e) => element({ ...unsigned(e), sourceMessage: source }));
  for (const [what, source] of [
    ['is text', 'MT103'], ['is a list', [msg]], ['is a number', 103], ['is true', true],
    ['has no type', { ...msg, type: undefined }], ['has an empty type', { ...msg, type: '' }], ['has a type of 41 characters', { ...msg, type: 't'.repeat(41) }], ['has a type that is a number', { ...msg, type: 103 }],
    ['has no file digest', { ...msg, sha256: undefined }], ['has a file digest that is no digest', { ...msg, sha256: 'zz'.repeat(32) }], ['has a file digest of 63 characters', { ...msg, sha256: msg.sha256.slice(1) }],
    ['has a file digest with a line feed', { ...msg, sha256: `${msg.sha256.slice(1)}\n` }], ['has a file digest that is a number', { ...msg, sha256: 5 }],
    ['has a position that is negative', { ...msg, index: -1 }], ['has a position that is text', { ...msg, index: '0' }], ['has a position above a million', { ...msg, index: 1000001 }],
    ['has a position that is true', { ...msg, index: true }],
    // (A position that is a fraction cannot be sent signed: the canonical form the bank signs has no fractions, so such an
    // element fails its signature check first. The vectors hold what the reference's reader says of one.)
    ['has a UETR that is no UUID', { ...msg, uetr: 'not-a-uuid' }], ['has a UETR without its hyphens', { ...msg, uetr: msg.uetr.replaceAll('-', '') }], ['has a UETR with a space after it', { ...msg, uetr: `${msg.uetr} ` }],
    ['has an empty UETR', { ...msg, uetr: '' }], ['has a UETR that is a number', { ...msg, uetr: 7 }],
    ['has a content digest that is no digest', { ...msg, content: 'cd' }], ['has an empty content digest', { ...msg, content: '' }],
    ['has a value date without hyphens', { ...msg, valueDate: '20261117' }], ['has a value date with a time', { ...msg, valueDate: '2026-11-17T00:00:00Z' }], ['has a value date the other way round', { ...msg, valueDate: '17/11/2026' }],
    ['has a value date the calendar has not', { ...msg, valueDate: '2026-02-30' }], ['has a value date in a month that is none', { ...msg, valueDate: '2026-13-01' }], ['has a value date with a line feed', { ...msg, valueDate: '2026-11-17\n' }],
    ['has a value date in the year 99', { ...msg, valueDate: '0099-01-01' }], ['has an empty value date', { ...msg, valueDate: '' }], ['has a value date that is a number', { ...msg, valueDate: 20261117 }],
    ['has an instruction id of 257 characters', { ...msg, instructionId: 'i'.repeat(257) }], ['has an end-to-end id that is a list', { ...msg, endToEndId: ['E2E'] }], ['has a message id that is a number', { ...msg, messageId: 7 }],
  ]) {
    send(`made from a message whose reference ${what}`, from(JSON.parse(JSON.stringify(source ?? null))), 'invalid_source_message');
  }

  // ── refused by the transaction: the message already stands for a settlement ──────────────────────────────────
  // Sent as the organisation that holds the seeded messages (another organisation's message is no conflict), on a quote
  // each server makes for it now. A recognition is written with the refusal: the same file again is then known as such.
  const aQuote = { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '1200.00' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } };
  const read = new RemitClient({ core: 'http://127.0.0.1:9', apiKey: O.read.key, institutionId: O.read.bank.id, institutionName: O.read.bank.name, key: createPrivateKey(O.read.bank.pem) });
  add('a quote for the organisation that holds the seeded messages', { method: 'POST', target: '/v1/quotes', headers: jkey(O.read), body: aQuote, volatile: ['$.quote_id', '$.quoted_at', '$.expires_at'], capture: { rq: '$' } });
  let m = 0;
  const again = (name, source, error, ground, existing) => {
    const id = `PAY-PA-AGAIN-${String(++m).padStart(2, '0')}`;
    add(`instruction: ${name}`, { method: 'POST', target: S, headers: { ...jkey(O.read), 'Idempotency-Key': `ra-again-${m}` },
      body: (vars) => read.buildInstruction(vars.rq, R.parties, { paymentId: id, beneficiaryInstitution: P.bfi.id, source: JSON.parse(JSON.stringify(source)) }).body,
      expect: { '$.error': error, '$.ground': ground, ...(existing ? { '$.existing_payment_id': existing } : {}) } });
    add(`instruction: nothing was made of it (${id})`, { target: `${S}/${id}`, headers: key(O.read), expect: { '$.error': 'not_found' } });
  };
  const src = R.source;
  const pacs = src['pacs008.sample.xml']; const pain = src['pain001.sample.xml']; const mt = src['mt103.sample.txt'];
  again('the seeded pacs.008 again, under another id: the same transaction of the same file', pacs.source, 'duplicate_source_message', 'message', pacs.payment_id);
  again('the same file with another content digest: still the same transaction', { ...pacs.source, content: sha256hex('another reading of the same bytes') }, 'duplicate_source_message', 'message', pacs.payment_id);
  again('its UETR in another file: the same payment', { ...pacs.source, sha256: sha256hex('ra: pacs.008 written out again') }, 'duplicate_source_message', 'uetr', pacs.payment_id);
  again('that other file once more: recognised before, and known as such now', { ...pacs.source, sha256: sha256hex('ra: pacs.008 written out again') }, 'duplicate_source_message', 'twin', pacs.payment_id);
  again('its UETR on other content: a reference used twice', { ...pacs.source, sha256: sha256hex('ra: pacs.008, another amount'), content: sha256hex('ra: other content') }, 'reference_reused', 'uetr', pacs.payment_id);
  again('its UETR on the next transaction of the same file', { ...pacs.source, index: 1 }, 'reference_reused', 'uetr', pacs.payment_id);
  again('the same payment in another file and without a UETR: its twin', { ...pacs.source, sha256: sha256hex('ra: pacs.008 without its UETR'), uetr: undefined }, 'duplicate_source_message', 'twin', pacs.payment_id);
  again('the seeded pain.001 again', pain.source, 'duplicate_source_message', 'message', pain.payment_id);
  again('the rendering of it that was recognised when the seed was made', src.twin.source, 'duplicate_source_message', 'twin', pain.payment_id);
  again('another rendering under the UETR it took then', { ...pain.source, sha256: sha256hex('ra: pain.001 a third time'), uetr: src.twin.inherited_uetr }, 'duplicate_source_message', 'uetr', pain.payment_id);
  again('the seeded MT103 again', mt.source, 'duplicate_source_message', 'message', mt.payment_id);
  again('the message refused as a reused reference when the seed was made', src.reused.source, 'reference_reused', 'uetr', mt.payment_id);
  return cases;
};
