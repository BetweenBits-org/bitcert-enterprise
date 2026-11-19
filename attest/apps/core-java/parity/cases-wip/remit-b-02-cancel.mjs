/**
 * The settlement rail, cancelling: `POST /v1/settlements/:id/cancel`.
 *
 * The bank may cancel until the receiving institution has pre-approved the payout — while the settlement is
 * REQUEST_ACCEPTED, BANK_AUTHORIZED or TRAVEL_RULE_PENDING — and signs the cancellation: `{ payment_id, reason }`,
 * with the reason it sends or, when it sends none, the platform's default sentence. The checks come in one order
 * (apps/core/src/remit/orchestrator.ts `cancel`): the door (key, subscription, bank) — the body — the settlement
 * (404, also for another organisation's) — its state (409, the sentence names it) — the signature (400).
 *
 * A cancellation is told to the receiving institution; the reference answers the bank after that notice came
 * back, whatever it came back with. So each success here also looks at what the stand-in was asked.
 *
 * The seeded settlements used up here are the write organisation's "cancellable" ones (and one that had its
 * travel rule acknowledged with nothing after it); the refusals are asked of settlements other files carry on,
 * which a refusal leaves as they are.
 */
import { generateKeyPairSync } from 'node:crypto';
import { signEvent } from '../../../../packages/attest-remit/src/index.ts';
import { remitKit, LEDGER_ROWS } from '../remit-kit.mjs';

export default async (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-b-02: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, S, J, key, jkey, admin, sign, build, partner, flow, REST, seededEvents, quotes } = k;
  const cases = [];
  const add = (c) => cases.push(c);
  const rail = R.settlements.rail;
  const q = quotes('rail');
  const DEFAULT = 'cancelled by instructing bank';
  const signed = (org, id, reason) => (reason === undefined ? { sig: sign(org, { payment_id: id, reason: DEFAULT }) } : { reason, sig: sign(org, { payment_id: id, reason }) });
  const cancel = (name, org, id, body, more = {}) => add({ name: `cancel: ${name}`, method: 'POST', target: `${S}/${id}/cancel`, headers: jkey(O[org]), body, ...more });
  const CANCELLED = { '$.state': 'CANCELLED' };
  const seeded = async (name, id, more = {}, org = 'rail') => add(flow.seeded(`cancel: ${name}`, org, id, await seededEvents(org, id), more));

  // The organisation whose subscription the operator switches off (remit-a-02 does the same; again here, so that this file stands alone).
  add({ name: 'cancel: the operator switches one organisation\'s rail off', method: 'POST', target: '/v1/remit/registry/deactivate', headers: admin, body: { email: O.deact.account.email, products: ['remit'] }, expect: { '$.results.remit': 'inactive' } });

  // ── the door ─────────────────────────────────────────────────────────────────────────────────────────────────
  const target = rail['cancellable-authorized-0'].id;
  const NOT_JSON = '{"reason":';
  for (const [who, headers, error] of [['no key', {}, 'unauthorized'], ['a key that is no key', { Authorization: 'Bearer sk_test_nothing' }, 'unauthorized'], ['a revoked key', { Authorization: `Bearer ${ctx.seed.keys.aRevoked}` }, 'unauthorized'],
    ['the operator\'s token instead of a key', { 'X-Admin-Token': k.TOKEN }, 'unauthorized']]) {
    add({ name: `cancel: with ${who}`, method: 'POST', target: `${S}/${target}/cancel`, headers: { ...J, ...headers }, body: NOT_JSON, expect: { '$.error': error } });
  }
  for (const [name, why, error] of [['nosub', 'has no subscription', 'subscription_required'], ['off', 'has its subscription switched off', 'subscription_required'], ['deact', 'was switched off by the operator', 'subscription_required'],
    ['nobank', 'has no bank', 'institution_unregistered'], ['nokey', 'has a bank without a key', 'institution_unregistered']]) {
    const own = Object.values(R.settlements[name] ?? {})[0]?.id ?? target;
    cancel(`of an organisation that ${why}: refused before the body is read`, name, own, NOT_JSON, { expect: { '$.error': error } });
  }
  cancel('a body that is no JSON, for a settlement that does not exist: the body is read first', 'rail', 'PAY-NO-SUCH', NOT_JSON, { expect: { '$.error': 'invalid_json' } });
  cancel('a body over one megabyte', 'rail', target, `{"reason":"${'r'.repeat(1 << 20)}"}`, { expect: { '$.error': 'payload_too_large' } });

  // ── the settlement, then its state, then the signature ───────────────────────────────────────────────────────
  cancel('a settlement that does not exist', 'rail', 'PAY-NO-SUCH', signed('rail', 'PAY-NO-SUCH', 'x'), { expect: { '$.error': 'payment_not_found' } });
  cancel('a settlement that does not exist, and a body that is null', 'rail', 'PAY-NO-SUCH', 'null', { expect: { '$.error': 'payment_not_found' } });
  cancel('a settlement that does not exist, and no body', 'rail', 'PAY-NO-SUCH', {}, { expect: { '$.error': 'payment_not_found' } });
  cancel('another organisation\'s settlement: as if it did not exist', 'rail', R.settlements.b['waiting-rfi'].id, signed('rail', R.settlements.b['waiting-rfi'].id, 'x'), { expect: { '$.error': 'payment_not_found' } });
  cancel('another organisation\'s settlement, signed by that organisation\'s bank, sent with this key', 'rail', R.settlements.b['waiting-rfi'].id, signed('b', R.settlements.b['waiting-rfi'].id, 'x'), { expect: { '$.error': 'payment_not_found' } });
  cancel('the id in lower case: another id', 'rail', target.toLowerCase(), signed('rail', target.toLowerCase(), 'x'), { expect: { '$.error': 'payment_not_found' } });
  cancel('"reconcile": no settlement of that name', 'rail', 'reconcile', signed('rail', 'reconcile', 'x'), { expect: { '$.error': 'payment_not_found' } });
  for (const name of ['pre-approved-0', 'instructed', 'onchain-11', 'in-progress-5', 'submitted-1', 'l1-3', 'failed-1', 'confirmed-0', 'terminal-anchored', 'terminal-cancelled', 'terminal-returned', 'terminal-exception']) {
    const s = rail[name];
    cancel(`too late — ${name} (${s.state}), properly signed`, 'rail', s.id, signed('rail', s.id, 'changed our mind'), { expect: { '$.error': 'not_cancellable', '$.message': `payment is ${s.state}; cancellation is only possible before payout pre-approval` } });
  }
  cancel('too late and unsigned: the state is answered, not the signature', 'rail', rail['onchain-11'].id, {}, { expect: { '$.error': 'not_cancellable' } });
  cancel('too late and a body that is null: the state is answered', 'rail', rail['onchain-11'].id, 'null', { expect: { '$.error': 'not_cancellable' } });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const bank = O.rail.bank;
  cancel('in time, and no signature', 'rail', target, { reason: 'x' }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and an empty body', 'rail', target, {}, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a body that is a list', 'rail', target, '[]', { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a body that is null', 'rail', target, 'null', { expect: { '$.error': 'internal' } });
  cancel('in time, and a signature that is null', 'rail', target, { reason: 'x', sig: null }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature that is text', 'rail', target, { reason: 'x', sig: 'signed' }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature of another key under the bank\'s name', 'rail', target, { reason: 'x', sig: signEvent({ payment_id: target, reason: 'x' }, other, bank.id, bank.name) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature of another organisation\'s bank', 'rail', target, { reason: 'x', sig: sign('b', { payment_id: target, reason: 'x' }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature over another reason', 'rail', target, { reason: 'x', sig: sign('rail', { payment_id: target, reason: 'y' }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature over another settlement', 'rail', target, { reason: 'x', sig: sign('rail', { payment_id: rail['cancellable-authorized-1'].id, reason: 'x' }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, no reason sent, and a signature over a reason of the bank\'s own: the default is what must be signed', 'rail', target, { sig: sign('rail', { payment_id: target, reason: 'our own reason' }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, a reason sent, and a signature over the default', 'rail', target, { reason: 'x', sig: sign('rail', { payment_id: target, reason: DEFAULT }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a signature over the reason with more signed than is sent', 'rail', target, { reason: 'x', sig: sign('rail', { payment_id: target, reason: 'x', at: '2026-11-19' }) }, { expect: { '$.error': 'invalid_signature' } });
  cancel('in time, and a reason that is a fraction: nothing a bank could have signed', 'rail', target, { reason: 0.5, sig: sign('rail', { payment_id: target, reason: 'x' }) }, { expect: { '$.error': 'invalid_signature' } });
  await seeded('nothing was cancelled by the refused ones', target, { expect: { '$.state': 'BANK_AUTHORIZED' } });

  // ── cancelled, from each state it may be cancelled in ────────────────────────────────────────────────────────
  const ok = async (name, id, body, more = {}, org = 'rail') => {
    const from = await seededEvents(org, id);
    cancel(name, org, id, body, { expect: CANCELLED, ...more });
    add(partner.arrived(`cancel: ${name} — the institution was told`, id, 'cancel', { answered: 1 }));
    add(flow.seeded(`cancel: ${name} — the settlement`, org, id, from, { expect: CANCELLED }));
  };
  await ok('a settlement that was accepted and nothing more (no event yet), with a reason', rail['cancellable-accepted-0'].id, signed('rail', rail['cancellable-accepted-0'].id, 'the importer withdrew the order'));
  await ok('another such, with no reason: the default sentence', rail['cancellable-accepted-1'].id, signed('rail', rail['cancellable-accepted-1'].id, undefined));
  await ok('an authorised one, before its travel rule went out', target, signed('rail', target, 'cancelled before the travel rule'));
  await ok('an authorised one, with an empty reason: the empty text is the reason', rail['cancellable-authorized-1'].id, signed('rail', rail['cancellable-authorized-1'].id, ''));
  { // A reason that is null reads as none; members nobody reads; a signature named otherwise than the bank.
    const id = rail['cancellable-authorized-2'].id;
    const sig = sign('rail', { payment_id: id, reason: DEFAULT });
    await ok('an authorised one, with a reason of null, members nobody reads and a signature under another name', id, { reason: null, payment_id: 'PAY-SOMETHING-ELSE', note: 'x', sig: { ...sig, key_id: 'SOMEBODY', issuer: 'Somebody', more: 1 } });
  }
  await ok('one with an open question', rail['cancellable-rfi-0'].id, signed('rail', rail['cancellable-rfi-0'].id, '주문 취소 — «annulé» 😀'));
  add(partner.ledger('cancel: one with an open question — the institution dropped its record', rail['cancellable-rfi-0'].id));
  { // The notice fails: the cancellation stands all the same.
    const id = rail['cancellable-rfi-1'].id;
    add(partner.plan('cancel: the notice will be answered 500: the plan', { payment_id: id, steps: { cancel: { do: 'fail', status: 500, message: 'the desk is closed' } } }));
    await ok('one with an open question, the institution answering 500 to the notice', id, signed('rail', id, 'x'.repeat(2000)));
  }
  { // The notice is refused with a page: the same.
    const id = rail['cancellable-rfi-2'].id;
    add(partner.plan('cancel: the notice will be answered with a page under 404: the plan', { payment_id: id, steps: { cancel: { do: 'html', status: 404 } } }));
    await ok('one with an open question, the institution answering a page', id, signed('rail', id, 'a reason with "quotes" and a \\ backslash'));
  }
  await ok('one whose travel rule is out and unanswered', rail['cancellable-in-call'].id, signed('rail', rail['cancellable-in-call'].id, 'cancelled while the travel rule was on its way'));
  await ok('one whose travel rule was acknowledged, before any approval', rail['received-0'].id, signed('rail', rail['received-0'].id, 'cancelled after the acknowledgement'));
  { // Of the organisation without a webhook address: one made in this run, asked a question by plan.
    const id = 'PAY-PC-NOHOOK';
    add(partner.plan('cancel: of the organisation without a webhook address — the plan: a question', { payment_id: id, steps: { 'travel-rule': { do: 'rfi' } } }));
    add(flow.accept('cancel: of the organisation without a webhook address — accepted', 'nohook', id, build('nohook', quotes('nohook')[1], id), REST.rfi));
    cancel('of the organisation without a webhook address', 'nohook', id, signed('nohook', id, 'no webhook to tell'), { expect: CANCELLED });
    add(flow.view('cancel: of the organisation without a webhook address — the settlement', 'nohook', id, 0, { expect: CANCELLED }));
  }

  // ── afterwards ───────────────────────────────────────────────────────────────────────────────────────────────
  cancel('again, the same bytes: it is cancelled already', 'rail', target, signed('rail', target, 'cancelled before the travel rule'), { expect: { '$.error': 'not_cancellable', '$.message': 'payment is CANCELLED; cancellation is only possible before payout pre-approval' } });
  cancel('again, unsigned: the state is answered', 'rail', target, {}, { expect: { '$.error': 'not_cancellable' } });
  // One made in this run, cancelled while its question is open — with a reason that is a number, which is what gets signed.
  const N = 'PAY-PC-NUMBER';
  add(flow.accept('cancel: a settlement of this run, asked a question: accepted', 'rail', N, build('rail', q[13], N), REST.rfi));
  cancel('with a reason that is a number', 'rail', N, signed('rail', N, 20261119), { expect: CANCELLED });
  add(flow.view('cancel: with a reason that is a number — the settlement', 'rail', N, 0, { expect: CANCELLED }));
  const L2 = 'PAY-PC-LIST';
  add(flow.accept('cancel: another of this run: accepted', 'rail', L2, build('rail', q[13], L2), REST.rfi));
  cancel('with a reason that is a list of reasons', 'rail', L2, signed('rail', L2, ['first', 'second', { third: true }]), { expect: CANCELLED });
  add(flow.view('cancel: with a reason that is a list — the settlement', 'rail', L2, 0, { expect: CANCELLED }));
  add(partner.ledger('cancel: with a reason that is a list — what the institution kept', L2));
  // The cancelled settlements in the ledger; evidence and chain of one.
  add({ name: 'cancel: the ledger of what was cancelled', target: `${S}?limit=100&state=CANCELLED&q=PAY-RAIL-CANCELLABLE`, headers: key(O.rail), volatile: LEDGER_ROWS, expect: { '$.page.total': 9 } });
  add(flow.evidence('cancel: a cancelled settlement has no evidence', 'rail', target, 0, { expect: { '$.error': 'evidence_not_ready' } }));
  add(flow.chain('cancel: a cancelled settlement has no chain', 'rail', target, { expect: { '$.error': 'no_chain_tx' } }));
  add({ name: 'cancel: by GET', target: `${S}/${target}/cancel`, headers: key(O.rail) });
  add({ name: 'cancel: by PUT', method: 'PUT', target: `${S}/${target}/cancel`, headers: jkey(O.rail), body: {} });
  add({ name: 'cancel: with a slash after it', method: 'POST', target: `${S}/${target}/cancel/`, headers: jkey(O.rail), body: {}, expect: { '$.error': 'not_cancellable' } });
  return cases;
};
