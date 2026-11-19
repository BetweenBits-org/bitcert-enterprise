/**
 * The settlement rail, what the receiving institution reports: `POST /v1/remit/callbacks`.
 *
 * No key: the signature is the door. A callback is `{ type, payload, sig }`, signed by a registered beneficiary
 * institution over the payload; five types (USDC_RECEIVED, PAYOUT_SUBMITTED, PAYOUT_COMPLETED, PAYOUT_FAILED,
 * USDC_RETURNED). The checks, in order (apps/core/src/remit/orchestrator.ts `handleCallback`): type — payload and
 * signature — payload.payment_id — the settlement (404) — the signer (400 unknown_signer, role_mismatch,
 * invalid_signature) — the type (400 unknown_callback_type).
 *
 * Two ways of sending one. For the checks, callbacks signed here with the stand-in's own keys
 * (parity/partner-keys.json — test keys; the seeds register their public halves): the same bytes to both servers.
 * For the flows, each server's own stand-in is told to send (`POST /control/callback`): it words the payload as
 * the partner simulator does — the receipt element, the bank's own confirmation inside it — from what it remembers
 * of the payment, and answers with what it sent and what the server said.
 *
 * Three groups of cases are named for what the Java service does on purpose otherwise (docs/JAVA-REMIT-DESIGN.md
 * 5 and 13), so that the list of known differences can name them by their prefix:
 *   "outside its state: …"    a callback for a settlement that is not where that callback belongs
 *   "repeated: …"             the same callback again (the same bytes; the same payload signed anew)
 *   "L1, then signed: …"      a signed completion after an unsigned one
 * The reference writes the callback's event before it looks at the state; these cases state what it does then.
 */
import { generateKeyPairSync } from 'node:crypto';
import { signEvent } from '../../../../packages/attest-remit/src/index.ts';
import { loadPartnerKeys } from '../../tools/stand-in-partner.mjs';
import { remitKit, LEDGER_ROWS } from '../remit-kit.mjs';

export default async (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-b-04: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, S, J, key, admin, build, sign, partner, flow, REST, seededEvents, quotes } = k;
  const cases = [];
  const add = (c) => cases.push(c);
  const rail = R.settlements.rail;
  const q = quotes('rail');
  const K = loadPartnerKeys().institutions;
  const as = (slug, payload) => signEvent(payload, K[slug].key, K[slug].id, K[slug].name);
  const CB = '/v1/remit/callbacks';
  const cb = (name, body, more = {}) => add({ name: `callback: ${name}`, method: 'POST', target: CB, headers: J, body, ...more });
  const OK = { '$.answer.status': 200, '$.answer.body.accepted': true };
  const send = (name, id, spec, more = {}) => add(partner.callback(`callback: ${name}`, id, spec, { expect: OK, ...more }));
  const seeded = async (name, id, more = {}, org = 'rail') => add(flow.seeded(`callback: ${name}`, org, id, await seededEvents(org, id), more));

  add({ name: 'callback: the operator switches one organisation\'s rail off', method: 'POST', target: '/v1/remit/registry/deactivate', headers: admin, body: { email: O.deact.account.email, products: ['remit'] }, expect: { '$.results.remit': 'inactive' } });

  // ── the checks, in their order — on a seeded settlement that is on chain ─────────────────────────────────────
  const T = rail['onchain-10'].id;
  const received = { payment_id: T, tx_hash: rail['onchain-10'].chain_tx, block: 1234, amount: rail['onchain-10'].amount, observed_at: '2026-11-19T00:00:00.000Z' };
  const good = { type: 'USDC_RECEIVED', payload: received, sig: as('bfi', received) };
  const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  cb('an empty body', {}, { expect: { '$.error': 'missing_field', '$.message': 'type is required' } });
  cb('no body at all', null, { expect: { '$.error': 'missing_field' } });
  cb('a body that is a list', '[]', { expect: { '$.error': 'missing_field' } });
  cb('a body that is text', '"USDC_RECEIVED"', { expect: { '$.error': 'missing_field' } });
  cb('a body that is null', 'null', { expect: { '$.error': 'internal' } });
  cb('a body that is no JSON', '{"type":', { expect: { '$.error': 'invalid_json' } });
  cb('a body over one megabyte', `{"type":"USDC_RECEIVED","pad":"${'p'.repeat(1 << 20)}"}`, { expect: { '$.error': 'payload_too_large' } });
  cb('a type and nothing else', { type: 'USDC_RECEIVED' }, { expect: { '$.error': 'missing_field', '$.message': 'payload and sig are required' } });
  cb('an empty type', { ...good, type: '' }, { expect: { '$.error': 'missing_field', '$.message': 'type is required' } });
  cb('a type that is null', { ...good, type: null }, { expect: { '$.error': 'missing_field' } });
  cb('no payload', { type: good.type, sig: good.sig }, { expect: { '$.error': 'missing_field', '$.message': 'payload and sig are required' } });
  cb('no signature', { type: good.type, payload: good.payload }, { expect: { '$.error': 'missing_field', '$.message': 'payload and sig are required' } });
  cb('a payload that is null', { ...good, payload: null }, { expect: { '$.error': 'missing_field' } });
  cb('a payload without a payment id', { type: good.type, payload: { tx_hash: received.tx_hash }, sig: as('bfi', { tx_hash: received.tx_hash }) }, { expect: { '$.error': 'missing_field', '$.message': 'payload.payment_id is required' } });
  cb('a payload with an empty payment id', { type: good.type, payload: { ...received, payment_id: '' }, sig: as('bfi', { ...received, payment_id: '' }) }, { expect: { '$.error': 'missing_field' } });
  cb('a payload that is text', { type: good.type, payload: T, sig: as('bfi', T) }, { expect: { '$.error': 'missing_field' } });
  const forNobody = { ...received, payment_id: 'PAY-NOBODY-HAS-THIS' };
  cb('a settlement nobody has', { type: good.type, payload: forNobody, sig: as('bfi', forNobody) }, { expect: { '$.error': 'payment_not_found' } });
  cb('a settlement nobody has, a type nobody knows and a signature that is none: the settlement is answered first', { type: 'SOMETHING_ELSE', payload: forNobody, sig: { alg: 'ES256', key_id: 'NOBODY', issuer: 'x', sig: 'AAAA' } }, { expect: { '$.error': 'payment_not_found' } });
  cb('the id in lower case: a settlement nobody has', { type: good.type, payload: { ...received, payment_id: T.toLowerCase() }, sig: as('bfi', { ...received, payment_id: T.toLowerCase() }) }, { expect: { '$.error': 'payment_not_found' } });
  cb('signed by a key nobody registered', { ...good, sig: as('stranger', received) }, { expect: { '$.error': 'unknown_signer', '$.message': `signature names unregistered key ${K.stranger.id}` } });
  cb('signed under a name nobody registered', { ...good, sig: { ...good.sig, key_id: 'SG-BFI-NOBODY' } }, { expect: { '$.error': 'unknown_signer' } });
  cb('signed under the institution\'s name in lower case', { ...good, sig: { ...good.sig, key_id: K.bfi.id.toLowerCase() } }, { expect: { '$.error': 'unknown_signer' } });
  cb('signed with an empty key id', { ...good, sig: { ...good.sig, key_id: '' } }, { expect: { '$.error': 'unknown_signer' } });
  cb('signed by the settlement entity', { ...good, sig: as('wallet', received) }, { expect: { '$.error': 'role_mismatch', '$.message': `${K.wallet.id} holds role SETTLEMENT_ENTITY, which may not assert BENEFICIARY_FI facts` } });
  cb('signed by the payout bank', { ...good, sig: as('sgbank', received) }, { expect: { '$.error': 'role_mismatch', '$.message': `${K.sgbank.id} holds role LOCAL_PAYOUT_BANK, which may not assert BENEFICIARY_FI facts` } });
  cb('signed by the instructing bank', { ...good, sig: sign('rail', received) }, { expect: { '$.error': 'role_mismatch' } });
  cb('signed under the platform\'s name', { ...good, sig: { ...good.sig, key_id: 'STONEHASH' } }, { expect: { '$.error': 'role_mismatch' } });
  cb('signed under the name of an institution whose key nobody holds', { ...good, sig: { ...good.sig, key_id: R.institutions.noEnc } }, { expect: { '$.error': 'invalid_signature', '$.message': `signature by ${R.institutions.noEnc} does not verify` } });
  cb('signed by another key under the institution\'s name', { ...good, sig: signEvent(received, stranger, K.bfi.id, K.bfi.name) }, { expect: { '$.error': 'invalid_signature', '$.message': `signature by ${K.bfi.id} does not verify` } });
  cb('a payload changed after it was signed', { ...good, payload: { ...received, amount: '1.00' } }, { expect: { '$.error': 'invalid_signature' } });
  cb('a payload with a member more than was signed', { ...good, payload: { ...received, note: 'added' } }, { expect: { '$.error': 'invalid_signature' } });
  cb('a payload with a fraction in it', { ...good, payload: { ...received, weight: 0.5 } }, { expect: { '$.error': 'invalid_signature' } });
  cb('a signature under another algorithm\'s name', { ...good, sig: { ...good.sig, alg: 'ES384' } }, { expect: { '$.error': 'invalid_signature' } });
  cb('a signature without its value', { ...good, sig: { alg: 'ES256', key_id: K.bfi.id, issuer: K.bfi.name } }, { expect: { '$.error': 'invalid_signature' } });
  cb('a signature that is not base64url', { ...good, sig: { ...good.sig, sig: '%'.repeat(86) } }, { expect: { '$.error': 'invalid_signature' } });
  cb('the other institution\'s signature over another payload', { ...good, sig: as('bfi2', forNobody) }, { expect: { '$.error': 'invalid_signature' } });
  cb('a signature that is text: it names no key', { ...good, sig: 'signed' }, { expect: { '$.error': 'unknown_signer', '$.message': 'signature names unregistered key undefined' } });
  const typed = (type) => ({ type, payload: received, sig: as('bfi', received) });
  cb('a type nobody knows, properly signed', typed('SOMETHING_ELSE'), { expect: { '$.error': 'unknown_callback_type', '$.message': 'unsupported callback type SOMETHING_ELSE' } });
  cb('a type in lower case', typed('usdc_received'), { expect: { '$.error': 'unknown_callback_type' } });
  cb('a type with a space after it', typed('USDC_RECEIVED '), { expect: { '$.error': 'unknown_callback_type' } });
  cb('a type that is one of the platform\'s own events', typed('EVIDENCE_COMMITTED'), { expect: { '$.error': 'unknown_callback_type' } });
  cb('a type that is a number', typed(7), { expect: { '$.error': 'unknown_callback_type', '$.message': 'unsupported callback type 7' } });
  cb('a type that is a list of a type', typed(['USDC_RECEIVED']), { expect: { '$.error': 'unknown_callback_type' } });
  cb('a type nobody knows and a signature that does not verify: the signature is answered first', { ...typed('SOMETHING_ELSE'), sig: signEvent(received, stranger, K.bfi.id, K.bfi.name) }, { expect: { '$.error': 'invalid_signature' } });
  await seeded('nothing was written by the refused ones', T, { expect: { '$.state': 'ONCHAIN_SETTLED' } });
  // … and one that is in order, sent with a key header nobody asked for and members nobody reads.
  add({ name: 'callback: in order, signed here: the same bytes to both', method: 'POST', target: CB, headers: { ...J, Authorization: 'Bearer nothing', 'Idempotency-Key': 'callback-key-1' }, body: { ...good, note: 'x' }, expect: { '$.accepted': true } });
  await seeded('in order, signed here — the settlement', T, { expect: { '$.state': 'PAYOUT_IN_PROGRESS' } });
  cb('signed by the second institution, for a settlement addressed to the first: taken', { type: 'PAYOUT_SUBMITTED', payload: { payment_id: T, local_rail: 'GIRO', submitted_at: '2026-11-19T00:00:01.000Z' }, sig: as('bfi2', { payment_id: T, local_rail: 'GIRO', submitted_at: '2026-11-19T00:00:01.000Z' }) }, { expect: { '$.accepted': true } });
  cb('with a payload that says nothing but the payment: the defaults', { type: 'PAYOUT_FAILED', payload: { payment_id: T }, sig: as('bfi', { payment_id: T }) }, { expect: { '$.accepted': true } });
  // A return after a failure that gave no reason: the reference moves the settlement to RETURNED and then cannot sign the
  // webhook it wants to queue (its reason is `undefined`, which has no canonical form) — the institution is answered 500
  // for a callback that was applied. An organisation without a webhook address is answered 200. (Suspected defect; design 2.2
  // says the member is left out.)
  cb('a return whose payload says nothing but the payment, after a failure that gave no reason', { type: 'USDC_RETURNED', payload: { payment_id: T }, sig: as('bfi', { payment_id: T }) }, { expect: { '$.error': 'internal' } });
  await seeded('after those — the settlement: returned all the same', T, { expect: { '$.state': 'RETURNED' } });

  // ── each kind where it belongs: seeded settlements on chain, carried on by each server's own stand-in ────────
  const carry = async (name, id, specs, state, { org = 'rail', evidence = false } = {}) => {
    const from = await seededEvents(org, id);
    for (const spec of specs) {
      const type = typeof spec === 'string' ? spec : spec.type;
      const { expect, ...sent } = typeof spec === 'string' ? {} : spec;
      send(`${name} — ${type}${sent.level ? ` at ${sent.level}` : ''}`, id, { type, ...sent }, expect ? { expect } : {});
    }
    add(flow.seeded(`callback: ${name} — the settlement`, org, id, from, { expect: { '$.state': state } }));
    if (evidence) add({ ...flow.evidence(`callback: ${name} — its evidence`, org, id, from) });
  };
  const NORMAL = ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED'];
  const CONFIRMED = 'BENEFICIARY_CREDIT_CONFIRMED';
  await carry('received, submitted, completed with the bank\'s own confirmation (L3)', rail['onchain-00'].id, NORMAL, CONFIRMED, { evidence: true });
  await carry('completed at L2: the institution\'s signature, no bank reference', rail['onchain-01'].id, ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L2' }], CONFIRMED, { evidence: true });
  await carry('completed with no level stated: read as L2', rail['onchain-02'].id, ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'none' }], CONFIRMED);
  await carry('completed at L1: unsigned, so held', rail['onchain-03'].id, ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }], 'PAYOUT_IN_PROGRESS');
  await carry('payout failed, the USDC returned', rail['onchain-04'].id, ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_FAILED', 'USDC_RETURNED'], 'RETURNED');
  await carry('returned with no failure reported', rail['onchain-05'].id, ['USDC_RECEIVED', 'USDC_RETURNED'], 'RETURNED');
  await carry('a receipt that states another amount: reconciliation fails', rail['onchain-06'].id, ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { with: { amount: '9999.99' } } }], 'EXCEPTION');
  await carry('submitted and completed while still on chain: no receipt of the USDC was reported', rail['onchain-07'].id, ['PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED'], CONFIRMED);
  await carry('completed, reported by the second institution', rail['onchain-08'].id, ['USDC_RECEIVED', { type: 'PAYOUT_COMPLETED', signedBy: 'bfi2' }], CONFIRMED);
  await carry('a receipt signed by a key nobody registered: reconciliation fails', rail['onchain-09'].id, ['USDC_RECEIVED', { type: 'PAYOUT_COMPLETED', element: { signedBy: 'stranger' } }], 'EXCEPTION');
  await carry('mode B: received, submitted, completed', rail['onchain-12'].id, NORMAL, CONFIRMED, { evidence: true });
  await carry('mode B: a receipt whose digest is not that of its content', rail['onchain-13'].id, ['USDC_RECEIVED', { type: 'PAYOUT_COMPLETED', element: { after: { digest: 'f'.repeat(64) } } }], 'EXCEPTION');
  await carry('mode B: a receipt that says L3 and is unsigned', rail['onchain-14'].id, ['USDC_RECEIVED', { type: 'PAYOUT_COMPLETED', level: 'L3', element: { unsigned: true } }], 'EXCEPTION');
  await carry('mode B, the second institution: received, submitted, completed', rail['onchain-15'].id, NORMAL, CONFIRMED);
  await carry('in progress: submitted, completed', rail['in-progress-0'].id, ['PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED'], CONFIRMED);
  await carry('in progress: failed, returned', rail['in-progress-1'].id, ['PAYOUT_FAILED', 'USDC_RETURNED'], 'RETURNED');
  await carry('in progress: completed at once', rail['in-progress-2'].id, ['PAYOUT_COMPLETED'], CONFIRMED);
  await carry('in progress: returned at once', rail['in-progress-3'].id, ['USDC_RETURNED'], 'RETURNED');
  await carry('in progress: completed with a receipt whose bank confirmation is signed by a key nobody registered', rail['in-progress-4'].id, [{ type: 'PAYOUT_COMPLETED', confirmation: { signedBy: 'stranger' } }], CONFIRMED);
  await carry('in progress: a failure and then a completion all the same', rail['in-progress-5'].id, ['PAYOUT_FAILED', 'PAYOUT_COMPLETED'], CONFIRMED);
  await carry('submitted: completed', rail['submitted-0'].id, ['PAYOUT_COMPLETED'], CONFIRMED, { evidence: true });
  await carry('submitted: failed twice, returned', rail['submitted-1'].id, ['PAYOUT_FAILED', { type: 'PAYOUT_FAILED', with: { reason: 'a second reason' } }, 'USDC_RETURNED'], 'RETURNED');
  await carry('failed, waiting for the return: returned', rail['failed-0'].id, ['USDC_RETURNED'], 'RETURNED');
  await carry('failed, waiting for the return: completed after all', rail['failed-1'].id, ['PAYOUT_COMPLETED'], CONFIRMED);
  await carry('held at L1: completed at L1 once more', rail['l1-1'].id, [{ type: 'PAYOUT_COMPLETED', level: 'L1' }], 'PAYOUT_IN_PROGRESS');
  await carry('held at L1: returned', rail['l1-2'].id, ['USDC_RETURNED'], 'RETURNED');
  await carry('of an organisation whose subscription was switched off since: its callbacks are taken all the same', R.settlements.off.onchain.id, NORMAL, CONFIRMED, { org: 'off' });
  await carry('of an organisation the operator switched off: the same', R.settlements.deact.onchain.id, NORMAL, CONFIRMED, { org: 'deact', evidence: true });
  // Of the organisation without a webhook address: made in this run, its callbacks sent one by one.
  const manual = async (word, org, id, quote, specs, state) => {
    add(partner.plan(`callback: ${word} — the plan: no callback until asked`, { payment_id: id, callbacks: 'manual' }));
    add(flow.accept(`callback: ${word} — a settlement of this run, on chain`, org, id, build(org, quote, id), REST.onchain));
    add(partner.arrived(`callback: ${word} — the notice was answered`, id, 'settlement-notice', { answered: 1 }));
    for (const spec of specs) {
      const type = typeof spec === 'string' ? spec : spec.type;
      const { expect, ...sent } = typeof spec === 'string' ? {} : spec;
      send(`${word} — ${type}${sent.again ? ` again (${sent.again})` : ''}${sent.level ? ` at ${sent.level}` : ''}`, id, { type, ...sent }, expect ? { expect } : {});
    }
    add(flow.view(`callback: ${word} — the settlement`, org, id, 0, { expect: { '$.state': state } }));
  };
  await manual('of the organisation without a webhook address', 'nohook', 'PAY-PK-NOHOOK', quotes('nohook')[3], NORMAL, CONFIRMED);

  // ── L1, then signed ──────────────────────────────────────────────────────────────────────────────────────────
  // The reference reconciles the settlement's FIRST completion — the unsigned one — and so ends in EXCEPTION; the Java service
  // reconciles the completion that asked for it (design 9, 13).
  await carry('L1, then signed: a seeded settlement held at L1, completed with the bank\'s confirmation', rail['l1-0'].id, [{ type: 'PAYOUT_COMPLETED', level: 'L3' }], 'EXCEPTION');
  await manual('L1, then signed: both in this run, L1 and then L2', 'rail', 'PAY-PK-L1-L2', q[0], ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'PAYOUT_COMPLETED', level: 'L2' }], 'EXCEPTION');

  // ── repeated ─────────────────────────────────────────────────────────────────────────────────────────────────
  // The reference keeps no duplicate apart: each copy is another event (and another webhook).
  await manual('repeated: each callback twice, the same bytes', 'rail', 'PAY-PK-TWICE', q[0],
    ['USDC_RECEIVED', { type: 'USDC_RECEIVED', again: 'bytes' }, 'PAYOUT_SUBMITTED', { type: 'PAYOUT_SUBMITTED', again: 'bytes' }], 'PAYOUT_IN_PROGRESS');
  await manual('repeated: the same payload signed anew', 'rail', 'PAY-PK-RESIGNED', q[0],
    ['USDC_RECEIVED', { type: 'USDC_RECEIVED', again: 'resign' }, 'PAYOUT_SUBMITTED', { type: 'PAYOUT_SUBMITTED', again: 'resign' }, { type: 'PAYOUT_SUBMITTED', again: 'resign', signedBy: 'bfi2' }], 'PAYOUT_IN_PROGRESS');
  await manual('repeated: the completion twice, the same bytes', 'rail', 'PAY-PK-COMPLETED-TWICE', q[0], ['USDC_RECEIVED', 'PAYOUT_COMPLETED', { type: 'PAYOUT_COMPLETED', again: 'bytes' }], CONFIRMED);
  await manual('repeated: the return twice', 'rail', 'PAY-PK-RETURNED-TWICE', q[0], ['USDC_RECEIVED', 'USDC_RETURNED', { type: 'USDC_RETURNED', again: 'bytes' }], 'RETURNED');

  // ── outside its state ────────────────────────────────────────────────────────────────────────────────────────
  // Settlements of this run brought to each end, and then told something that belongs earlier, or to no settlement that has ended.
  const REFUSED = (id, state) => ({ '$.answer.status': 500, '$.answer.body.error': 'invalid_transition', '$.answer.body.message': `payment ${id} is terminal (${state}); corrections are new events, not transitions` });
  const BACK = (id, from, to) => ({ '$.answer.status': 500, '$.answer.body.error': 'invalid_transition', '$.answer.body.message': `cannot move payment ${id} from ${from} to ${to}: states only advance` });
  const late = async (word, id, make, specs, state) => {
    await make(id);
    for (const spec of specs) send(`outside its state: ${word} — ${spec.type}${spec.level ? ` at ${spec.level}` : ''}`, id, (({ expect: _e, ...rest }) => rest)(spec), { expect: spec.expect ?? OK });
    add(flow.view(`callback: outside its state: ${word} — the settlement`, 'rail', id, 0, { expect: { '$.state': state } }));
  };
  const confirmed = async (id) => { add(flow.accept(`callback: outside its state: ${id} — a settlement of this run, credited`, 'rail', id, build('rail', q[0], id), REST.confirmed)); };
  const cancelled = async (id) => { add(flow.accept(`callback: outside its state: ${id} — a settlement of this run, rejected`, 'rail', id, build('rail', q[4], id, { parties: { debtor: R.parties.debtor, creditor: { ...R.parties.creditor, name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } } }), REST.rejected)); };
  const returned = async (id) => { add(flow.accept(`callback: outside its state: ${id} — a settlement of this run, returned`, 'rail', id, build('rail', q[16], id), REST.returned)); };
  const failed = async (id) => {
    add(partner.plan(`callback: outside its state: ${id} — the plan: the approval is refused`, { payment_id: id, steps: { 'payout-approval': { do: 'refuse', status: 409, message: 'not today' } } }));
    add(flow.accept(`callback: outside its state: ${id} — a settlement of this run, stopped`, 'rail', id, build('rail', q[0], id), REST.exception));
  };
  const asked = async (id) => { add(flow.accept(`callback: outside its state: ${id} — a settlement of this run, asked a question`, 'rail', id, build('rail', q[12], id), REST.rfi)); };
  await late('credited, then the USDC is said to have arrived', 'PAY-PK-LATE-RECEIVED', confirmed, [{ type: 'USDC_RECEIVED', expect: BACK('PAY-PK-LATE-RECEIVED', 'BENEFICIARY_CREDIT_CONFIRMED', 'PAYOUT_IN_PROGRESS') }], CONFIRMED);
  await late('credited, then submitted and failed', 'PAY-PK-LATE-SUBMITTED', confirmed, [{ type: 'PAYOUT_SUBMITTED' }, { type: 'PAYOUT_FAILED' }], CONFIRMED);
  await late('credited, then completed once more with another receipt', 'PAY-PK-LATE-COMPLETED', confirmed, [{ type: 'PAYOUT_COMPLETED', level: 'L2' }], CONFIRMED);
  await late('credited, then completed at L1', 'PAY-PK-LATE-L1', confirmed, [{ type: 'PAYOUT_COMPLETED', level: 'L1' }], CONFIRMED);
  await late('credited, then the USDC is said to have come back', 'PAY-PK-LATE-RETURNED', confirmed, [{ type: 'USDC_RETURNED' }], 'RETURNED');
  await late('rejected by the institution, then each callback', 'PAY-PK-AFTER-REJECTED', cancelled, [{ type: 'USDC_RECEIVED', expect: REFUSED('PAY-PK-AFTER-REJECTED', 'CANCELLED') }, { type: 'PAYOUT_SUBMITTED' }, { type: 'PAYOUT_FAILED' },
    { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'USDC_RETURNED', expect: REFUSED('PAY-PK-AFTER-REJECTED', 'CANCELLED') }], 'CANCELLED');
  await late('returned, then received and returned again', 'PAY-PK-AFTER-RETURNED', returned, [{ type: 'USDC_RECEIVED', expect: REFUSED('PAY-PK-AFTER-RETURNED', 'RETURNED') }, { type: 'USDC_RETURNED' }], 'RETURNED');
  await late('stopped in EXCEPTION, then received and submitted', 'PAY-PK-AFTER-EXCEPTION', failed, [{ type: 'USDC_RECEIVED', expect: REFUSED('PAY-PK-AFTER-EXCEPTION', 'EXCEPTION') }, { type: 'PAYOUT_SUBMITTED' },
    { type: 'USDC_RETURNED', expect: REFUSED('PAY-PK-AFTER-EXCEPTION', 'EXCEPTION') }], 'EXCEPTION');
  await late('a question still open, then the USDC is said to have arrived: it jumps ahead', 'PAY-PK-EARLY-RECEIVED', asked, [{ type: 'USDC_RECEIVED' }], 'PAYOUT_IN_PROGRESS');
  await late('a question still open, then submitted and failed', 'PAY-PK-EARLY-SUBMITTED', asked, [{ type: 'PAYOUT_SUBMITTED' }, { type: 'PAYOUT_FAILED' }], 'TRAVEL_RULE_PENDING');
  await late('a question still open, then returned', 'PAY-PK-EARLY-RETURNED', asked, [{ type: 'USDC_RETURNED' }], 'RETURNED');
  // Seeded settlements that wait before the chain (their pipeline was stopped when the seed was made).
  await carry('outside its state: pre-approved, and the USDC is said to have arrived', rail['pre-approved-0'].id, ['USDC_RECEIVED'], 'PAYOUT_IN_PROGRESS');
  await carry('outside its state: pre-approved, and returned', rail['pre-approved-1'].id, ['USDC_RETURNED'], 'RETURNED');
  await carry('outside its state: instructed and not yet on chain, and submitted', rail.instructed.id, ['PAYOUT_SUBMITTED'], 'PAYOUT_PRE_APPROVED');
  await carry('outside its state: acknowledged and not yet approved, and failed', rail['received-1'].id, ['PAYOUT_FAILED'], 'TRAVEL_RULE_PENDING');

  // ── the ledger afterwards ────────────────────────────────────────────────────────────────────────────────────
  for (const state of ['BENEFICIARY_CREDIT_CONFIRMED', 'RETURNED', 'EXCEPTION', 'PAYOUT_IN_PROGRESS', 'ONCHAIN_SETTLED']) {
    add({ name: `callback: the ledger afterwards, ${state}`, target: `${S}?limit=100&state=${state}`, headers: key(O.rail), volatile: LEDGER_ROWS });
  }
  add({ name: 'callback: by GET', target: CB });
  add({ name: 'callback: by PUT', method: 'PUT', target: CB, headers: J, body: good });
  add({ name: 'callback: with a slash after it', method: 'POST', target: `${CB}/`, headers: J, body: {}, expect: { '$.error': 'missing_field' } });
  return cases;
};
