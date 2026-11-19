/**
 * The settlement rail, the pipeline: instructions that ARE accepted, and what becomes of them.
 *
 * An accepted instruction is answered at once (202) and carried on behind the answer: travel rule, the receiving
 * institution's approval, the transfer, the notice — partner calls, each answered by that server's own stand-in
 * (tools/stand-in-partner.mjs) — and then the institution's callbacks. So each acceptance here says where the
 * settlement comes to rest (`settle`), and the cases after it look at it only then: its whole event log, its
 * evidence, its chain, the ledger. What the stand-in does for a payment is its rule (the amount, the beneficiary's
 * name) or a plan set for that payment id on both stand-ins before the instruction goes out.
 *
 * Instructions are built and signed once, when this file loads, on the seeded quotes (the same in both stores): the
 * same bytes go to both servers, and the two stand-ins are asked the same.
 *
 * Here: each way a settlement ends by itself; the same request again; one message, one settlement; every partner
 * call failing in each way the reference tells apart; a call that is slow to answer. Cancelling, answering a
 * question and the callbacks one by one have files of their own (remit-b-02 … 04).
 */
import { sha256hex, signEvent } from '../../../../packages/attest-remit/src/index.ts';
import { generateKeyPairSync } from 'node:crypto';
import { remitKit, viewVolatile, LEDGER_ROWS, PARTNER_ADDRESS } from '../remit-kit.mjs';

export default async (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-b-01: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, P, S, J, key, jkey, admin, build, buildB, partner, flow, REST, quotes } = k;
  const cases = [];
  const add = (c) => cases.push(c);
  const q = quotes('rail');
  const look = (word, org, id, more = {}) => add(flow.view(`${word}: the settlement`, org, id, 0, more));

  // ── each way a settlement ends by itself ─────────────────────────────────────────────────────────────────────
  const A = 'PAY-PB-NORMAL-A';
  add(flow.accept('normal, mode A: accepted', 'rail', A, build('rail', q[0], A), REST.confirmed));
  look('normal, mode A', 'rail', A, { expect: { '$.state': 'BENEFICIARY_CREDIT_CONFIRMED', '$.evidence_level': 'L3', '$.evidence_available': true } });
  add(flow.evidence('normal, mode A: its evidence', 'rail', A));
  add(flow.chain('normal, mode A: its chain', 'rail', A, { expect: { '$.state': 'confirmed' } }));
  add(partner.ledger('normal, mode A: what the partner remembers', A));
  add({ name: 'normal, mode A: its anchor record is of the rail\'s product', target: `/v1/attestations?limit=1`, headers: key(O.rail), volatile: [/^\$\.data\[0\]\.(?:id|leaf_bytes|created_at)$/, '$.next_cursor'] });

  const B = 'PAY-PB-NORMAL-B';
  add(flow.accept('normal, mode B (the bank\'s own ciphertext): accepted', 'rail', B, await buildB('rail', q[1], B), REST.confirmed));
  look('normal, mode B', 'rail', B);
  add(flow.evidence('normal, mode B: its evidence', 'rail', B));

  const B2 = 'PAY-PB-BFI2';
  add(flow.accept('to the second receiving institution: accepted', 'rail', B2, build('rail', q[2], B2, { beneficiaryInstitution: P.bfi2.id }), REST.confirmed));
  look('to the second receiving institution', 'rail', B2, { expect: { '$.beneficiary_institution': P.bfi2.id } });
  const B2B = 'PAY-PB-BFI2-B';
  add(flow.accept('to the second receiving institution, mode B: accepted', 'rail', B2B, await buildB('rail', q[3], B2B, { beneficiaryInstitution: P.bfi2.id }), REST.confirmed));
  look('to the second receiving institution, mode B', 'rail', B2B);

  for (const [word, quote, rest, expect] of [
    ['completed at L2 (an amount ending in .02)', q[18], REST.confirmed, { '$.evidence_level': 'L2' }],
    ['completed at L1 and held (an amount ending in .01)', q[17], REST.l1, { '$.evidence_level': 'L1', '$.state': 'PAYOUT_IN_PROGRESS' }],
    ['the smallest amount, 0.01: held at L1 as well', q[20], REST.l1, { '$.amounts.settled.value': '0.01' }],
    ['payout failed and returned (an amount ending in .13)', q[16], REST.returned, { '$.state': 'RETURNED' }],
    ['a question from the receiving institution (USD 20,000 or more)', q[12], REST.rfi, { '$.state': 'TRAVEL_RULE_PENDING' }],
    ['a question, just under the wallet\'s cap', q[21], REST.rfi, {}],
    ['other amounts: 4300.00', q[8], REST.confirmed, {}], ['other amounts: 12500.00', q[10], REST.confirmed, {}], ['other amounts: 990.75', q[11], REST.confirmed, {}],
  ]) {
    const id = `PAY-PB-${sha256hex(word).slice(0, 8).toUpperCase()}`;
    add(flow.accept(`${word}: accepted`, 'rail', id, build('rail', quote, id), rest));
    look(word, 'rail', id, { expect });
    add(flow.evidence(`${word}: its evidence`, 'rail', id));
  }
  const SAN = 'PAY-PB-SANCTIONED';
  add(flow.accept('a beneficiary on the screening list: accepted, then rejected by the institution', 'rail', SAN, build('rail', q[4], SAN, { parties: { debtor: R.parties.debtor, creditor: { ...R.parties.creditor, name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } } }), REST.rejected));
  look('a beneficiary on the screening list', 'rail', SAN, { expect: { '$.state': 'CANCELLED' } });
  add(flow.evidence('a beneficiary on the screening list: no evidence', 'rail', SAN, 0, { expect: { '$.error': 'evidence_not_ready' } }));
  add(flow.chain('a beneficiary on the screening list: no chain', 'rail', SAN, { expect: { '$.error': 'no_chain_tx' } }));
  const REJ = 'PAY-PB-REJECTED-BARE';
  add(partner.plan('rejected with no reason given: the plan', { payment_id: REJ, steps: { 'travel-rule': { do: 'reject' } } }));
  add(flow.accept('rejected with no reason given: accepted', 'rail', REJ, build('rail', q[5], REJ), REST.rejected));
  look('rejected with no reason given', 'rail', REJ);
  const BARE = 'PAY-PB-RFI-BARE';
  add(partner.plan('a question given as a bare reason: the plan', { payment_id: BARE, steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment' } } }));
  add(flow.accept('a question given as a bare reason: accepted', 'rail', BARE, build('rail', q[5], BARE), REST.rfi));
  look('a question given as a bare reason', 'rail', BARE);
  const BARE0 = 'PAY-PB-RFI-NO-REASON';
  add(partner.plan('a question with neither an id nor a reason: the plan', { payment_id: BARE0, steps: { 'travel-rule': { do: 'rfi-bare' } } }));
  add(flow.accept('a question with neither an id nor a reason: accepted', 'rail', BARE0, build('rail', q[5], BARE0), REST.rfi));
  look('a question with neither an id nor a reason', 'rail', BARE0);
  const OWN = 'PAY-PB-RFI-OWN-ID';
  add(partner.plan('a question with an id and questions of the institution\'s own: the plan', { payment_id: OWN, steps: { 'travel-rule': { do: 'rfi', id: 'Q-2026-00042', questions: ['Who is the ultimate consignee?', '선적 서류 번호를 알려 주십시오.', ''] } } }));
  add(flow.accept('a question with an id and questions of the institution\'s own: accepted', 'rail', OWN, build('rail', q[6], OWN), REST.rfi));
  look('a question with an id and questions of the institution\'s own', 'rail', OWN);

  // ── organisations beside the one with a webhook ──────────────────────────────────────────────────────────────
  const NH = 'PAY-PB-NOHOOK';
  add(flow.accept('an organisation without a webhook address: accepted', 'nohook', NH, build('nohook', quotes('nohook')[0], NH), REST.confirmed));
  look('an organisation without a webhook address', 'nohook', NH);
  // (No settlement is made for the third seeded organisation, `b`: its ledger is compared whole by another file.)
  const OB = NH;
  for (const [who, org, id] of [['the rail organisation', 'rail', OB], ['the other organisation', 'nohook', A], ['a third organisation', 'b', A]]) {
    add({ name: `one organisation's settlement, asked for by ${who}`, target: `${S}/${id}`, headers: key(O[org]), expect: { '$.error': 'not_found' } });
    add({ name: `its evidence, asked for by ${who}`, target: `${S}/${id}/evidence`, headers: key(O[org]), expect: { '$.error': 'not_found' } });
    add({ name: `its chain, asked for by ${who}`, target: `${S}/${id}/chain`, headers: key(O[org]), expect: { '$.error': 'not_found' } });
  }

  // ── the same request again ───────────────────────────────────────────────────────────────────────────────────
  const first = build('rail', q[7], 'PAY-PB-AGAIN');
  const post = (name, body, idem, more = {}, org = 'rail') => add({ name, method: 'POST', target: S, headers: { ...jkey(O[org]), 'Idempotency-Key': idem }, body, ...more });
  add(flow.accept('to be sent again: accepted', 'rail', 'PAY-PB-AGAIN', first, REST.confirmed));
  post('the same bytes under the same key: the first answer again', first, 'rb-PAY-PB-AGAIN', { volatile: ['$.accepted_at'], expect: { '$.state': 'BANK_AUTHORIZED', '$.payment_id': 'PAY-PB-AGAIN' } });
  post('the same instruction, its members in another order, under the same key: another body', Object.fromEntries(Object.entries(first).reverse()), 'rb-PAY-PB-AGAIN', { expect: { '$.error': 'idempotency_conflict' } });
  post('the same instruction with white space in it, under the same key: the same body once parsed', JSON.stringify(first, null, 2), 'rb-PAY-PB-AGAIN', { volatile: ['$.accepted_at'], expect: { '$.state': 'BANK_AUTHORIZED' } });
  post('another body under the same key', { ...first, request_id: 'REQ-CHANGED' }, 'rb-PAY-PB-AGAIN', { expect: { '$.error': 'idempotency_conflict' } });
  post('an empty body under the same key', {}, 'rb-PAY-PB-AGAIN', { expect: { '$.error': 'idempotency_conflict' } });
  post('the same bytes under another key: the settlement exists', first, 'rb-PAY-PB-AGAIN-other-key', { expect: { '$.error': 'duplicate_payment' } });
  post('the same bytes under the same key, as another organisation: its own keys, and the id is taken', first, 'rb-PAY-PB-AGAIN', { expect: { '$.error': 'duplicate_payment' } }, 'b');
  post('another organisation\'s payment id: it exists, and that is said', build('rail', q[7], OB), 'rb-other-orgs-id', { expect: { '$.error': 'duplicate_payment' } });
  add(flow.view('to be sent again: one settlement, one set of events', 'rail', 'PAY-PB-AGAIN'));
  // A refusal is not remembered: the corrected request under the same key is looked at afresh.
  const fixed = build('rail', q[7], 'PAY-PB-FIXED');
  post('a request that is refused', { ...fixed, amount: { ...fixed.amount, payout: { currency: 'SGD', value: '1.00' } } }, 'rb-refused-then-fixed', { expect: { '$.error': 'amount_mismatch' } });
  post('the same refused request again under its key: refused again', { ...fixed, amount: { ...fixed.amount, payout: { currency: 'SGD', value: '1.00' } } }, 'rb-refused-then-fixed', { expect: { '$.error': 'amount_mismatch' } });
  add({ ...flow.accept('the corrected request under the same key: accepted', 'rail', 'PAY-PB-FIXED', fixed, REST.confirmed), headers: { ...jkey(O.rail), 'Idempotency-Key': 'rb-refused-then-fixed' } });
  // What a signature does not cover may differ and the instruction is still the bank's: who is named as signer, what was attached.
  const named = build('rail', q[7], 'PAY-PB-NAMED');
  named.bank_signature = { ...named.bank_signature, key_id: 'SOMEBODY-ELSE', issuer: 'Somebody Else' };
  add(flow.accept('a signature that verifies, under another name than the bank\'s: accepted', 'rail', 'PAY-PB-NAMED', named, REST.confirmed));
  look('a signature under another name', 'rail', 'PAY-PB-NAMED');
  const cited = build('rail', q[7], 'PAY-PB-CITED');
  cited.evidence_elements.commercialDocs = { ...cited.evidence_elements.commercialDocs, attached: ['invoice', 'packing-list'], citedOnly: ['bill-of-lading'] };
  add(flow.accept('documents attached and cited otherwise than when signed (neither is signed): accepted, and judged at reconciliation', 'rail', 'PAY-PB-CITED', cited, REST.mismatch));
  look('documents cited and not attached', 'rail', 'PAY-PB-CITED');
  // Members nobody reads, and a mode written in lower case (read as mode A: the fields are all there).
  const extra = build('rail', q[7], 'PAY-PB-EXTRA');
  add(flow.accept('members nobody reads, and "mode": "a": accepted', 'rail', 'PAY-PB-EXTRA', { ...extra, note: 'for the attention of nobody', corridor: { origin: 'XX', destination: 'YY' }, compliance_payload: { ...extra.compliance_payload, mode: 'a', remark: [1, { deep: null }] } }, REST.confirmed));
  look('members nobody reads', 'rail', 'PAY-PB-EXTRA', { expect: { '$.corridor.origin': 'VN' } });

  // ── one message, one settlement ──────────────────────────────────────────────────────────────────────────────
  // Settlements made from the bank's own messages; the stand-in asks a question of each (a plan for the id's prefix), so that
  // each rests at once. A refusal names the settlement that stands for the message, and on what ground.
  add(partner.plan('from messages: every one of them is asked a question', { prefix: 'PAY-PB-SRC-', steps: { 'travel-rule': { do: 'rfi' } } }));
  const file = (label) => sha256hex(`remit-b: ${label}`);
  const U = ['a1a1a1a1-1111-4111-8111-aaaaaaaaaaa1', 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbb2', 'c3c3c3c3-3333-4333-8333-ccccccccccc3', 'd4d4d4d4-4444-4444-8444-ddddddddddd4'];
  const base = { type: 'pacs.008.001.08', sha256: file('F1'), uetr: U[0], messageId: 'RB-MSG-1', instructionId: 'RB-INS-1', endToEndId: 'RB-E2E-1', valueDate: '2026-11-17', content: file('content 1') };
  let n = 0;
  const from = (name, id, source, outcome) => {
    const body = build('rail', q[0], id, { source: JSON.parse(JSON.stringify(source)) });
    if (outcome === 'accepted') add(flow.accept(`from a message: ${name}`, 'rail', id, body, REST.rfi));
    else post(`from a message: ${name}`, body, `rb-src-${++n}`, { expect: { '$.error': outcome[0], '$.ground': outcome[1], '$.existing_payment_id': outcome[2] } });
  };
  from('a first one, with a UETR', 'PAY-PB-SRC-1', base, 'accepted');
  from('the same transaction of the same file under another id', 'PAY-PB-SRC-1B', base, ['duplicate_source_message', 'message', 'PAY-PB-SRC-1']);
  from('the same file read to another content digest', 'PAY-PB-SRC-1C', { ...base, content: file('another reading') }, ['duplicate_source_message', 'message', 'PAY-PB-SRC-1']);
  from('its UETR in another file', 'PAY-PB-SRC-1D', { ...base, sha256: file('F1 again') }, ['duplicate_source_message', 'uetr', 'PAY-PB-SRC-1']);
  from('that other file once more: recognised before', 'PAY-PB-SRC-1E', { ...base, sha256: file('F1 again') }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-1']);
  from('its UETR on other content', 'PAY-PB-SRC-1F', { ...base, sha256: file('F1 other amount'), content: file('content 2') }, ['reference_reused', 'uetr', 'PAY-PB-SRC-1']);
  from('its UETR on the next transaction of its file', 'PAY-PB-SRC-1G', { ...base, index: 1 }, ['reference_reused', 'uetr', 'PAY-PB-SRC-1']);
  from('the same payment without its UETR, in other bytes', 'PAY-PB-SRC-1H', { ...base, sha256: file('F1 stripped'), uetr: undefined }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-1']);
  from('the same identifiers and content under another UETR: another payment', 'PAY-PB-SRC-2', { ...base, sha256: file('F2'), uetr: U[1] }, 'accepted');
  from('the same identifiers on another day: another payment', 'PAY-PB-SRC-3', { ...base, sha256: file('F3'), uetr: undefined, valueDate: '2026-11-18' }, 'accepted');
  from('the id of a settlement that exists, with a message nobody sent: the id is answered first', 'PAY-PB-SRC-1', { ...base, sha256: file('new'), uetr: U[3], instructionId: 'RB-INS-NEW' }, ['duplicate_payment', undefined, undefined]);
  // A settlement without a UETR takes the UETR of the rendering it is recognised in.
  const h = { type: 'MT103', sha256: file('H bare'), messageId: 'RB-H', instructionId: 'RB-H', valueDate: '2026-11-17', content: file('content H') };
  from('one without a UETR', 'PAY-PB-SRC-H', h, 'accepted');
  from('the same payment with a UETR, in another file: recognised, and the UETR is the settlement\'s from now on', 'PAY-PB-SRC-H2', { ...h, sha256: file('H with a UETR'), uetr: U[2] }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-H']);
  add({ name: 'from a message: the settlement is found by the UETR it took', target: `${S}?source_uetr=${U[2]}`, headers: key(O.rail), volatile: LEDGER_ROWS, expect: { '$.page.total': 1, '$.data[0].payment_id': 'PAY-PB-SRC-H' } });
  from('a third file under that UETR', 'PAY-PB-SRC-H3', { ...h, sha256: file('H a third time'), uetr: U[2] }, ['duplicate_source_message', 'uetr', 'PAY-PB-SRC-H']);
  from('the same payment under another UETR: no longer its twin, a payment of its own', 'PAY-PB-SRC-H4', { ...h, sha256: file('H under another UETR'), uetr: U[3] }, 'accepted');
  // Two transactions of one file that read alike are two payments; written out again, each is the twin of one of them.
  const two = { type: 'pain.001.001.09', messageId: 'RB-BATCH', endToEndId: 'RENT', valueDate: '2026-11-17', content: file('content rent') };
  from('the first of two like transactions of one file', 'PAY-PB-SRC-T0', { ...two, sha256: file('T'), index: 0 }, 'accepted');
  from('the second of them', 'PAY-PB-SRC-T1', { ...two, sha256: file('T'), index: 1 }, 'accepted');
  from('the file written out again: its first transaction is the first settlement', 'PAY-PB-SRC-T0X', { ...two, messageId: 'RB-BATCH-R', sha256: file('T again'), index: 0 }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-T0']);
  from('and its second transaction is the second, not the first again', 'PAY-PB-SRC-T1X', { ...two, messageId: 'RB-BATCH-R', sha256: file('T again'), index: 1 }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-T1']);
  // No value date: nothing tells such a payment from the next one like it. Refused each time, and never recorded as recognised.
  const undated = { type: 'MT103', messageId: 'RB-U', instructionId: 'RB-U', content: file('content undated') };
  from('one that states no value date', 'PAY-PB-SRC-U', { ...undated, sha256: file('U') }, 'accepted');
  from('the same in other bytes, undated as well: cannot be told apart', 'PAY-PB-SRC-U2', { ...undated, sha256: file('U again') }, ['duplicate_source_message', 'twin_undated', 'PAY-PB-SRC-U']);
  from('and once more: still not recorded as that payment', 'PAY-PB-SRC-U3', { ...undated, sha256: file('U again') }, ['duplicate_source_message', 'twin_undated', 'PAY-PB-SRC-U']);
  // Known by nothing but the file's message id and its position (a pain.001 that says NOTPROVIDED).
  const plain = { type: 'pain.001.001.09', messageId: 'RB-FILE-7', endToEndId: 'NOTPROVIDED', valueDate: '2026-11-17', content: file('content plain') };
  from('one known only by its message id', 'PAY-PB-SRC-N', { ...plain, sha256: file('N') }, 'accepted');
  from('the file exported again, with white space around its ids and "nonref" for the same word', 'PAY-PB-SRC-N2', { ...plain, sha256: file('N again'), messageId: ' RB-FILE-7 ', endToEndId: 'nonref' }, ['duplicate_source_message', 'twin', 'PAY-PB-SRC-N']);
  from('under another message id: nothing says it is the same', 'PAY-PB-SRC-N3', { ...plain, sha256: file('N other id'), messageId: 'RB-FILE-8' }, 'accepted');
  from('another organisation sends the first message: its own ledger, no conflict — but the id is taken', 'PAY-PB-SRC-1', base, ['duplicate_payment', undefined, undefined]);
  add(flow.view('from a message: the first one, at rest with its question', 'rail', 'PAY-PB-SRC-1'));
  add({ name: 'from a message: found by a reference of its message', target: `${S}?limit=100&q=RB-INS-1`, headers: key(O.rail), volatile: LEDGER_ROWS });
  add({ name: 'from a message: found by its content', target: `${S}?source_content=${base.content}`, headers: key(O.rail), volatile: LEDGER_ROWS });
  add({ name: 'from a message: found by its content and its day', target: `${S}?source_content=${base.content}&source_value_date=2026-11-18`, headers: key(O.rail), volatile: LEDGER_ROWS, expect: { '$.data[0].payment_id': 'PAY-PB-SRC-3' } });

  // ── every partner call, failing in each way the reference tells apart ────────────────────────────────────────
  // A failed call ends the settlement in EXCEPTION, with an event that says where it stood and why — a sentence a bank's
  // system reads. (A sentence that quotes a server's own partner address is compared with the address taken out.)
  const fails = [
    ['travel rule: refused (422, a message)', { 'travel-rule': { do: 'refuse', status: 422, message: 'the receiving institution does not take this corridor today' } }, REST.exception],
    ['travel rule: refused (400, a code and no message)', { 'travel-rule': { do: 'refuse', status: 400, body: { error: 'bad_request' } } }, REST.exception],
    ['travel rule: refused (404, an empty body)', { 'travel-rule': { do: 'refuse', status: 404, raw: '' } }, REST.exception],
    ['travel rule: failed (500)', { 'travel-rule': { do: 'fail', status: 500, message: 'boom' } }, REST.exception],
    ['travel rule: a page of HTML under 200', { 'travel-rule': 'html' }, REST.exception],
    ['travel rule: a page of HTML under 502', { 'travel-rule': { do: 'html', status: 502 } }, REST.exception],
    ['travel rule: the connection is dropped', { 'travel-rule': 'drop' }, REST.exception],
    ['travel rule: a status nobody knows', { 'travel-rule': { do: 'ack', top: { status: 'MAYBE' } } }, REST.exception],
    ['travel rule: ACK and no acknowledgement', { 'travel-rule': { do: 'ack', omit: ['ack'] } }, REST.exception],
    ['travel rule: acknowledged by a key nobody registered', { 'travel-rule': { signedBy: 'stranger' } }, REST.exception],
    ['travel rule: acknowledged by the settlement entity', { 'travel-rule': { signedBy: 'wallet' } }, REST.exception],
    ['travel rule: an acknowledgement whose signature is broken', { 'travel-rule': { breakSignature: true } }, REST.exception],
    ['travel rule: acknowledged by the second institution, which is not the one addressed', { 'travel-rule': { signedBy: 'bfi2' } }, REST.confirmed],
    ['approval: refused (409)', { 'payout-approval': { do: 'refuse', status: 409, message: 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)' } }, REST.exception],
    ['approval: failed (503)', { 'payout-approval': { do: 'fail', status: 503, message: 'maintenance' } }, REST.exception],
    ['approval: a page of HTML under 200', { 'payout-approval': 'html' }, REST.exception],
    ['approval: the connection is dropped after the work', { 'payout-approval': 'drop-after' }, REST.exception],
    ['approval: for another amount', { 'payout-approval': { with: { usdc_amount: '1.00' } } }, REST.exception],
    ['approval: for another payment', { 'payout-approval': { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } }, REST.exception],
    ['approval: signed by a key nobody registered', { 'payout-approval': { signedBy: 'stranger' } }, REST.exception],
    ['approval: signed by the settlement entity', { 'payout-approval': { signedBy: 'wallet' } }, REST.exception],
    ['approval: a signature that is broken', { 'payout-approval': { breakSignature: true } }, REST.exception],
    ['transfer: refused (403)', { transfer: { do: 'refuse', status: 403, message: 'per-payment cap exceeded (sandbox: 50,000 mUSDC)' } }, REST.exception],
    ['transfer: the wallet moves the funds and answers 500', { transfer: { do: 'fail-after', status: 500 } }, REST.exception],
    ['transfer: the connection is dropped after the work', { transfer: 'drop-after' }, REST.exception],
    ['transfer: a page of HTML under 200', { transfer: 'html' }, REST.exception],
    ['transfer: the result names another payment', { transfer: { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } }, REST.exception],
    ['transfer: the result is signed by the receiving institution', { transfer: { signedBy: 'bfi' } }, REST.exception],
    ['transfer: the result is signed by a key nobody registered', { transfer: { signedBy: 'stranger' } }, REST.exception],
    ['transfer: a result whose signature is broken', { transfer: { breakSignature: true } }, REST.exception],
    ['settlement notice: refused (404)', { 'settlement-notice': { do: 'refuse', status: 404, message: 'unknown payment' } }, REST.exception],
    ['settlement notice: failed (500), nothing done', { 'settlement-notice': { do: 'fail', status: 500, message: 'notice desk down' } }, REST.exception],
    ['settlement notice: the connection is dropped', { 'settlement-notice': 'drop' }, REST.exception],
  ];
  for (const [word, steps, rest] of fails) {
    const id = `PAY-PB-F-${sha256hex(word).slice(0, 8).toUpperCase()}`;
    add(partner.plan(`${word}: the plan`, { payment_id: id, steps }));
    add(flow.accept(`${word}: accepted`, 'rail', id, build('rail', q[0], id), rest));
    look(word, 'rail', id, { expect: { '$.state': rest.state } });
  }
  // A notice answered with a page under 200 is taken as answered: the settlement waits on chain for callbacks that never come.
  const PAGE = 'PAY-PB-F-NOTICE-PAGE';
  add(partner.plan('settlement notice: a page of HTML under 200: the plan', { payment_id: PAGE, steps: { 'settlement-notice': 'html' } }));
  add(flow.accept('settlement notice: a page of HTML under 200: accepted', 'rail', PAGE, build('rail', q[0], PAGE), REST.onchain));
  add(partner.arrived('settlement notice: a page of HTML under 200: the notice was answered', PAGE, 'settlement-notice', { answered: 1 }));
  look('settlement notice: a page of HTML under 200', 'rail', PAGE, { expect: { '$.state': 'ONCHAIN_SETTLED' } });
  // A transfer above the wallet's cap: asked a question first (20,000 or more), so it rests there; the answer is in remit-b-03.
  // A transfer the chain node does not know: the settlement is on chain as far as the platform is told, and its chain route says otherwise.
  const UNK = 'PAY-PB-TX-UNKNOWN';
  add(partner.plan('a transfer the node has never seen: the plan', { payment_id: UNK, steps: { transfer: { tx: 'unknown' } }, callbacks: 'manual' }));
  add(flow.accept('a transfer the node has never seen: accepted', 'rail', UNK, build('rail', q[0], UNK), REST.onchain));
  add(partner.arrived('a transfer the node has never seen: the notice was answered', UNK, 'settlement-notice', { answered: 1 }));
  add(flow.chain('a transfer the node has never seen: its chain', 'rail', UNK, { expect: { '$.state': 'not_found' } }));

  // ── a call that is slow to answer, and a call held and let go ────────────────────────────────────────────────
  const SLOW = 'PAY-PB-SLOW';
  add(partner.plan('every call answered after a moment: the plan', { payment_id: SLOW, steps: { 'travel-rule': { delay: 300 }, 'payout-approval': { delay: 300 }, transfer: { delay: 300 }, 'settlement-notice': { delay: 300 } }, callbacks: { delay: 200, gap: 150 } }));
  add(flow.accept('every call answered after a moment: accepted', 'rail', SLOW, build('rail', q[0], SLOW), REST.confirmed));
  look('every call answered after a moment', 'rail', SLOW);
  for (const [word, step, state, last] of [['the travel rule', 'travel-rule', 'TRAVEL_RULE_PENDING', 'TRAVEL_RULE_SENT'], ['the approval', 'payout-approval', 'TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RECEIVED'], ['the transfer', 'transfer', 'PAYOUT_PRE_APPROVED', 'SETTLEMENT_INSTRUCTED']]) {
    const id = `PAY-PB-HELD-${step.toUpperCase()}`;
    add(partner.plan(`${word} held: the plan`, { payment_id: id, steps: { [step]: { do: 'hold' } } }));
    add({ ...flow.accept(`${word} held: accepted`, 'rail', id, build('rail', q[0], id), { state, last }), settle: undefined });
    add(partner.arrived(`${word} held: the call has arrived`, id, step));
    look(`${word} held: while it is held`, 'rail', id, { expect: { '$.state': state } });
    add({ ...partner.release(`${word} held: let go`, id), settle: { target: `${S}/${id}`, headers: key(O.rail), until: REST.confirmed, idle: id } });
    look(`${word} held: afterwards`, 'rail', id, { expect: { '$.state': 'BENEFICIARY_CREDIT_CONFIRMED' } });
  }

  // ── a registry row whose key is no key does not stop anybody else's settlement ───────────────────────────────
  const stranger = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  add({ name: 'a registry row with a key that is none: registered', method: 'POST', target: '/v1/remit/registry/institutions', headers: admin, body: { id: 'RB-NO-KEY', role: 'LOCAL_PAYOUT_BANK', name: 'A key that is none', signing_spki: 'not a key at all' } });
  const KR = 'PAY-PB-KEYRING';
  add(flow.accept('with that row in the registry: accepted, reconciled and packaged all the same', 'rail', KR, build('rail', q[0], KR), REST.confirmed));
  look('with that row in the registry', 'rail', KR);
  add(flow.evidence('with that row in the registry: the package lists the row as written', 'rail', KR));
  add({ name: 'a registry row with a key that is none: given a key', method: 'POST', target: '/v1/remit/registry/institutions', headers: admin, body: { id: 'RB-NO-KEY', role: 'LOCAL_PAYOUT_BANK', name: 'A key that is none', signing_spki: stranger() } });

  // ── the ledger of what this file made ────────────────────────────────────────────────────────────────────────
  const ledger = (name, query, more = {}) => add({ name: `the ledger afterwards: ${name}`, target: `${S}${query}`, headers: key(O.rail), volatile: LEDGER_ROWS, ...more });
  ledger('everything made here', '?limit=100&q=PAY-PB-');
  ledger('what ended in EXCEPTION', '?limit=100&q=PAY-PB-&state=EXCEPTION');
  ledger('what is credited', '?limit=100&q=PAY-PB-&state=BENEFICIARY_CREDIT_CONFIRMED');
  ledger('what waits for an answer or was cancelled', '?limit=100&q=PAY-PB-&state=TRAVEL_RULE_PENDING,CANCELLED');
  ledger('found by a bank reference of a completed payout', `?limit=100&q=FAST-`, {});
  ledger('found by the transaction hash of the first', '?limit=100&q=0x10', {});
  // A cursor names the place after a row by that row's time: for rows the run made, each server's own.
  ledger('two at a time: page 1', '?limit=2&q=PAY-PB-F-', { capture: { cb: '$.page.next_cursor' }, volatile: [...LEDGER_ROWS, '$.page.next_cursor'] });
  ledger('two at a time: page 2', '?limit=2&q=PAY-PB-F-&cursor={cb}', { volatile: [...LEDGER_ROWS, '$.page.next_cursor'] });
  void J; void signEvent; void viewVolatile; void PARTNER_ADDRESS;
  return cases;
};
