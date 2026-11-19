/**
 * The settlement rail, answering the receiving institution's question: `POST /v1/settlements/:id/rfi-response`.
 *
 * A settlement whose travel rule was answered with a question waits, TRAVEL_RULE_PENDING, until the bank answers.
 * The answers are signed by the bank (`{ payment_id, answers }`), encrypted to the institution and sent on inside
 * the request; what the institution says decides (apps/core/src/remit/orchestrator.ts `respondRfi`):
 *
 *   a signed acknowledgement, whatever status stands beside it     200 TRAVEL_RULE_PENDING, and the pipeline goes on
 *   REJECTED, or no acknowledgement at all                         200 CANCELLED
 *   an acknowledgement that does not verify                        400 to the bank (unknown_signer, role_mismatch,
 *                                                                  invalid_signature); nothing written, the question stays open
 *   the institution refuses, fails or cannot be reached            502 (partner_error, partner_unreachable); nothing written
 *
 * The checks before that, in order: the door — the body — the settlement (404) — its state (409 wrong_state) — a
 * question at all (409 no_rfi) — still open (409 already_resolved) — answers (400 missing_field) — the signature
 * (400 invalid_signature).
 *
 * The seeded open questions of the write organisation are answered here, one way each; what each stand-in says to
 * an answer is planned for that payment on both stand-ins first.
 */
import { generateKeyPairSync } from 'node:crypto';
import { signEvent } from '../../../../packages/attest-remit/src/index.ts';
import { remitKit, PARTNER_ADDRESS } from '../remit-kit.mjs';

export default async (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-b-03: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, S, J, key, jkey, admin, sign, build, partner, flow, REST, seededEvents, quotes } = k;
  const cases = [];
  const add = (c) => cases.push(c);
  const rail = R.settlements.rail;
  const q = quotes('rail');
  const ANSWERS = R.rfi_answers;
  const signed = (org, id, answers = ANSWERS) => ({ answers, sig: sign(org, { payment_id: id, answers }) });
  const answer = (name, org, id, body, more = {}) => add({ name: `answer: ${name}`, method: 'POST', target: `${S}/${id}/rfi-response`, headers: jkey(O[org]), body, blur: PARTNER_ADDRESS, ...more });
  const PENDING = { '$.state': 'TRAVEL_RULE_PENDING' };
  const CANCELLED = { '$.state': 'CANCELLED' };

  add({ name: 'answer: the operator switches one organisation\'s rail off', method: 'POST', target: '/v1/remit/registry/deactivate', headers: admin, body: { email: O.deact.account.email, products: ['remit'] }, expect: { '$.results.remit': 'inactive' } });

  // ── the door ─────────────────────────────────────────────────────────────────────────────────────────────────
  const open = rail['rfi-00'].id;
  const NOT_JSON = '{"answers":';
  for (const [who, headers] of [['no key', {}], ['a key that is no key', { Authorization: 'Bearer sk_test_nothing' }], ['a revoked key', { Authorization: `Bearer ${ctx.seed.keys.aRevoked}` }]]) {
    add({ name: `answer: with ${who}`, method: 'POST', target: `${S}/${open}/rfi-response`, headers: { ...J, ...headers }, body: NOT_JSON, expect: { '$.error': 'unauthorized' } });
  }
  for (const [name, why, error] of [['nosub', 'has no subscription', 'subscription_required'], ['off', 'has its subscription switched off', 'subscription_required'], ['deact', 'was switched off by the operator, with a question of its own open', 'subscription_required'],
    ['nobank', 'has no bank', 'institution_unregistered'], ['nokey', 'has a bank without a key', 'institution_unregistered']]) {
    const own = R.settlements[name]?.rfi?.id ?? Object.values(R.settlements[name] ?? {})[0]?.id ?? open;
    answer(`of an organisation that ${why}: refused before the body is read`, name, own, NOT_JSON, { expect: { '$.error': error } });
  }
  answer('a body that is no JSON, for a settlement that does not exist: the body is read first', 'rail', 'PAY-NO-SUCH', NOT_JSON, { expect: { '$.error': 'invalid_json' } });

  // ── the settlement, its state, the question, the answers, the signature ──────────────────────────────────────
  answer('a settlement that does not exist', 'rail', 'PAY-NO-SUCH', signed('rail', 'PAY-NO-SUCH'), { expect: { '$.error': 'payment_not_found' } });
  answer('a settlement that does not exist, and a body that is null', 'rail', 'PAY-NO-SUCH', 'null', { expect: { '$.error': 'payment_not_found' } });
  answer('another organisation\'s open question: as if it did not exist', 'rail', R.settlements.b['waiting-rfi'].id, signed('rail', R.settlements.b['waiting-rfi'].id), { expect: { '$.error': 'payment_not_found' } });
  for (const name of ['pre-approved-1', 'instructed', 'onchain-11', 'in-progress-5', 'l1-3', 'confirmed-0', 'terminal-anchored', 'terminal-cancelled', 'terminal-returned', 'terminal-exception']) {
    const s = rail[name];
    answer(`${name} (${s.state}): no question is answered in that state`, 'rail', s.id, signed('rail', s.id), { expect: { '$.error': 'wrong_state', '$.message': `payment is ${s.state}; RFI answers apply while TRAVEL_RULE_PENDING` } });
  }
  answer('a settlement in another state, unsigned and without answers: the state is answered', 'rail', rail['onchain-11'].id, {}, { expect: { '$.error': 'wrong_state' } });
  answer('one whose travel rule was acknowledged without a question', 'rail', rail['received-1'].id, signed('rail', rail['received-1'].id), { expect: { '$.error': 'no_rfi', '$.message': 'no outstanding RFI on this payment' } });
  answer('one whose travel rule was acknowledged without a question, and a body that is null', 'rail', rail['received-1'].id, 'null', { expect: { '$.error': 'no_rfi' } });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const bank = O.rail.bank;
  answer('an open question, and no answers', 'rail', open, { sig: sign('rail', { payment_id: open }) }, { expect: { '$.error': 'missing_field', '$.message': 'answers is required' } });
  answer('an open question, and answers that are an empty object', 'rail', open, signed('rail', open, {}), { expect: { '$.error': 'missing_field' } });
  answer('an open question, and answers that are null', 'rail', open, { answers: null, sig: sign('rail', { payment_id: open, answers: null }) }, { expect: { '$.error': 'missing_field' } });
  answer('an open question, and answers that are an empty list', 'rail', open, signed('rail', open, []), { expect: { '$.error': 'missing_field' } });
  answer('an open question, and answers that are an empty text', 'rail', open, signed('rail', open, ''), { expect: { '$.error': 'missing_field' } });
  answer('an open question, and an empty body', 'rail', open, {}, { expect: { '$.error': 'missing_field' } });
  answer('an open question, and a body that is null', 'rail', open, 'null', { expect: { '$.error': 'internal' } });
  answer('an open question, answers, and no signature', 'rail', open, { answers: ANSWERS }, { expect: { '$.error': 'invalid_signature', '$.message': 'sig must cover {payment_id, answers} with the bank key' } });
  answer('an open question, answers, and a signature that is text', 'rail', open, { answers: ANSWERS, sig: 'signed' }, { expect: { '$.error': 'invalid_signature' } });
  answer('an open question, and a signature of another key under the bank\'s name', 'rail', open, { answers: ANSWERS, sig: signEvent({ payment_id: open, answers: ANSWERS }, other, bank.id, bank.name) }, { expect: { '$.error': 'invalid_signature' } });
  answer('an open question, and a signature of another organisation\'s bank', 'rail', open, { answers: ANSWERS, sig: sign('b', { payment_id: open, answers: ANSWERS }) }, { expect: { '$.error': 'invalid_signature' } });
  answer('an open question, and a signature over other answers', 'rail', open, { answers: ANSWERS, sig: sign('rail', { payment_id: open, answers: { ...ANSWERS, purpose: 'something else' } }) }, { expect: { '$.error': 'invalid_signature' } });
  answer('an open question, and a signature over another settlement\'s question', 'rail', open, { answers: ANSWERS, sig: sign('rail', { payment_id: rail['rfi-01'].id, answers: ANSWERS }) }, { expect: { '$.error': 'invalid_signature' } });
  answer('an open question, and answers with a fraction in them: nothing a bank could have signed', 'rail', open, { answers: { ...ANSWERS, weight: 0.5 }, sig: sign('rail', { payment_id: open, answers: ANSWERS }) }, { expect: { '$.error': 'invalid_signature' } });
  add(flow.seeded('answer: the question is still open after the refused answers', 'rail', open, await seededEvents('rail', open), { expect: PENDING }));
  add(partner.ledger('answer: and the institution was asked nothing', open));

  // ── what the institution says to an answer ───────────────────────────────────────────────────────────────────
  /** Plans the stand-in, sends the answer, and looks at where the settlement rests. */
  const outcome = async (name, id, { plan, body, expect, rest, org = 'rail', again } = {}) => {
    const from = await seededEvents(org, id);
    if (plan) add(partner.plan(`answer: ${name} — the plan`, { payment_id: id, ...plan }));
    answer(name, org, id, body ?? signed(org, id), { expect, ...(rest ? { settle: { target: `${S}/${id}`, headers: key(O[org]), until: rest, idle: id } } : {}) });
    for (const [what, more] of again ?? []) answer(`${name} — ${what}`, org, id, body ?? signed(org, id), more);
    add(flow.seeded(`answer: ${name} — the settlement`, org, id, from));
  };
  await outcome('accepted: the pipeline goes on to the end', open, { expect: PENDING, rest: REST.confirmed });
  add(flow.evidence('answer: accepted — its evidence', 'rail', open, await seededEvents('rail', open)));
  answer('accepted — answered again afterwards: no longer in that state', 'rail', open, signed('rail', open), { expect: { '$.error': 'wrong_state' } });
  await outcome('every answer blank: the institution rejects it', rail['rfi-01'].id, { body: signed('rail', rail['rfi-01'].id, { purpose: '  ', shipping_reference: '' }), expect: CANCELLED });
  answer('every answer blank — answered again: it is cancelled', 'rail', rail['rfi-01'].id, signed('rail', rail['rfi-01'].id), { expect: { '$.error': 'wrong_state', '$.message': 'payment is CANCELLED; RFI answers apply while TRAVEL_RULE_PENDING' } });
  await outcome('rejected with a reason', rail['rfi-02'].id, { plan: { steps: { 'travel-rule-response': { do: 'reject', reason: 'the documents do not support the stated purpose' } } }, expect: CANCELLED });
  await outcome('rejected with no reason given', rail['rfi-03'].id, { plan: { steps: { 'travel-rule-response': { do: 'reject' } } }, expect: CANCELLED });
  await outcome('ACK and no acknowledgement: read as a rejection', rail['rfi-04'].id, { plan: { steps: { 'travel-rule-response': { do: 'ack', omit: ['ack'] } } }, expect: CANCELLED });
  await outcome('a page of HTML under 200: read as a rejection', rail['rfi-05'].id, { plan: { steps: { 'travel-rule-response': 'html' } }, expect: CANCELLED });
  await outcome('a status of RFI beside a signed acknowledgement: read as accepted', rail['rfi-06'].id, { plan: { steps: { 'travel-rule-response': { do: 'ack', top: { status: 'RFI' } } } }, expect: PENDING, rest: REST.confirmed });
  await outcome('acknowledged by a key nobody registered: the bank is told, the question stays open — and the institution has closed it', rail['rfi-07'].id, {
    plan: { steps: { 'travel-rule-response': [{ do: 'ack', signedBy: 'stranger' }] } }, expect: { '$.error': 'unknown_signer', '$.message': 'signature names unregistered key SG-BFI-UNREGISTERED' },
    again: [['answered again: the institution has no question open any more', { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 409: no outstanding RFI for this payment' } }]] });
  // The two mode-B questions.
  await outcome('acknowledged by the settlement entity: the bank is told', rail['rfi-08'].id, { plan: { steps: { 'travel-rule-response': [{ do: 'ack', signedBy: 'wallet' }] } }, expect: { '$.error': 'role_mismatch' } });
  await outcome('an acknowledgement whose signature is broken: the bank is told', rail['rfi-09'].id, { plan: { steps: { 'travel-rule-response': [{ do: 'ack', breakSignature: true }] } }, expect: { '$.error': 'invalid_signature', '$.message': 'signature by SG-BFI-001 does not verify' } });
  await outcome('a question given as a bare reason, which the institution remembers: accepted', rail['rfi-bare-remembered'].id, { expect: PENDING, rest: REST.confirmed });
  await outcome('a question given as a bare reason, of which the institution kept nothing: its check of the sender fails', rail['rfi-bare'].id, { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 400: sender signature does not verify against the platform key' } });

  // ── more questions, made in this run: the institution refusing, failing, out of reach, and then answering ────
  const fresh = async (name, id, quote, { plan, steps, mode } = {}) => {
    if (plan) add(partner.plan(`answer: ${name} — the plan`, { payment_id: id, ...plan }));
    add(flow.accept(`answer: ${name} — a settlement of this run, asked a question`, 'rail', id, mode === 'B' ? await k.buildB('rail', quote, id) : build('rail', quote, id), REST.rfi));
    for (const [what, body, more] of steps) answer(`${name} — ${what}`, 'rail', id, body ?? signed('rail', id), more);
    add(flow.view(`answer: ${name} — the settlement`, 'rail', id));
  };
  await fresh('the institution refuses, fails, then accepts', 'PAY-PR-RETRY', q[12], { plan: { steps: { 'travel-rule-response': [{ do: 'refuse', status: 409, message: 'the compliance desk is closed' }, { do: 'refuse', status: 422, body: { error: 'unprocessable' } },
    { do: 'fail', status: 500, message: 'boom' }, { do: 'fail', status: 503, raw: 'Service Unavailable' }] } },
    steps: [['refused with 409 and a message', null, { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 409: the compliance desk is closed' } }],
      ['refused with 422 and a code alone', null, { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 422: unprocessable' } }],
      ['failed with 500', null, { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 500: boom' } }],
      ['failed with 503 and a body that is no JSON', null, { expect: { '$.error': 'partner_error', '$.message': '/bfi/travel-rule-response → HTTP 503: partner error' } }],
      ['and then answered', null, { expect: PENDING, settle: { target: `${S}/PAY-PR-RETRY`, headers: key(O.rail), until: REST.confirmed, idle: 'PAY-PR-RETRY' } }]] });
  await fresh('the connection to the institution is dropped, then it answers', 'PAY-PR-DROP', q[13], { plan: { steps: { 'travel-rule-response': ['drop'] } },
    steps: [['dropped: not reachable, says the platform', null, { expect: { '$.error': 'partner_unreachable' } }],
      ['and then answered', null, { expect: PENDING, settle: { target: `${S}/PAY-PR-DROP`, headers: key(O.rail), until: REST.confirmed, idle: 'PAY-PR-DROP' } }]] });
  await fresh('answers that are no text', 'PAY-PR-TYPES', q[14], {
    steps: [['numbers, a list and an object as answers: signed as they are, and taken', signed('rail', 'PAY-PR-TYPES', { purpose: 7, shipping_reference: ['B/L', 118822], more: { nested: true }, blank: '' }),
      { expect: PENDING, settle: { target: `${S}/PAY-PR-TYPES`, headers: key(O.rail), until: REST.confirmed, idle: 'PAY-PR-TYPES' } }]] });
  await fresh('in mode B', 'PAY-PR-MODE-B', q[15], { mode: 'B',
    steps: [['answered', null, { expect: PENDING, settle: { target: `${S}/PAY-PR-MODE-B`, headers: key(O.rail), until: REST.confirmed, idle: 'PAY-PR-MODE-B' } }]] });
  // Above the wallet's cap: the answer is taken, and the transfer is refused by the wallet.
  await fresh('a payment above the settlement wallet\'s cap', 'PAY-PR-CAP', q[23], {
    steps: [['answered: accepted — and the transfer is then refused', null, { expect: PENDING, settle: { target: `${S}/PAY-PR-CAP`, headers: key(O.rail), until: REST.exception, idle: 'PAY-PR-CAP' } }]] });
  await fresh('a payment at the settlement wallet\'s cap', 'PAY-PR-AT-CAP', q[22], {
    steps: [['answered: accepted, and transferred', null, { expect: PENDING, settle: { target: `${S}/PAY-PR-AT-CAP`, headers: key(O.rail), until: REST.confirmed, idle: 'PAY-PR-AT-CAP' } }]] });
  // The approval is held at the institution after an accepted answer: asked again meanwhile, the question is resolved already.
  const H = 'PAY-PR-RESOLVED';
  add(partner.plan('answer: resolved already — the plan: the approval will be held', { payment_id: H, steps: { 'payout-approval': { do: 'hold' } } }));
  add(flow.accept('answer: resolved already — a settlement of this run, asked a question', 'rail', H, build('rail', q[12], H), REST.rfi));
  answer('resolved already — the answer is taken', 'rail', H, signed('rail', H), { expect: PENDING });
  add(partner.arrived('answer: resolved already — the approval request has arrived and is held', H, 'payout-approval'));
  answer('resolved already — answered again while the approval is awaited', 'rail', H, signed('rail', H), { expect: { '$.error': 'already_resolved', '$.message': 'this RFI was already resolved' } });
  answer('resolved already — answered again, unsigned: that it is resolved is answered first', 'rail', H, {}, { expect: { '$.error': 'already_resolved' } });
  add({ ...partner.release('answer: resolved already — the approval is let go', H), settle: { target: `${S}/${H}`, headers: key(O.rail), until: REST.confirmed, idle: H } });
  add(flow.view('answer: resolved already — the settlement', 'rail', H));
  // The answers of an organisation without a webhook address.
  { // Of the organisation without a webhook address: one made in this run, asked a question by plan.
    const id = 'PAY-PR-NOHOOK';
    add(partner.plan('answer: of the organisation without a webhook address — the plan: a question', { payment_id: id, steps: { 'travel-rule': { do: 'rfi' } } }));
    add(flow.accept('answer: of the organisation without a webhook address — accepted', 'nohook', id, build('nohook', quotes('nohook')[2], id), REST.rfi));
    answer('of the organisation without a webhook address', 'nohook', id, signed('nohook', id), { expect: PENDING, settle: { target: `${S}/${id}`, headers: key(O.nohook), until: REST.confirmed, idle: id } });
    add(flow.view('answer: of the organisation without a webhook address — the settlement', 'nohook', id));
  }
  add({ name: 'answer: by GET', target: `${S}/${open}/rfi-response`, headers: key(O.rail) });
  add({ name: 'answer: by PUT', method: 'PUT', target: `${S}/${open}/rfi-response`, headers: jkey(O.rail), body: {} });
  return cases;
};
