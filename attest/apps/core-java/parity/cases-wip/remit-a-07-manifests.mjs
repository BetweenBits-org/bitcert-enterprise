/**
 * The settlement rail, the day's manifest: `POST /v1/manifests/daily`, `GET /v1/manifests/daily`.
 *
 * The bank signs the list of what it instructed on a day; the platform compares it with its own ledger both ways
 * (what the bank left out, what the platform never saw), signs the outcome, commits it and anchors the commitment
 * — one row per organisation and day, replaced when the day is sent again.
 *
 * Written as the seeded organisation without a webhook address (its ledger: one settlement on the seed's first
 * day, three on the day the seed was made), so that the manifests of the organisations other files read stay as
 * seeded. The reads are of the organisation no case writes to.
 *
 * New on every run, and named so: when the comparison was made (`verdict.checked_at`), the platform's signature
 * over it, the commitment (it covers that time) and the id of its anchor record. The verdict itself — the status,
 * the two counts, the two lists in their order — is compared to the letter.
 */
import { generateKeyPairSync } from 'node:crypto';
import { signEvent } from '../../../../packages/attest-remit/src/index.ts';
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-07: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, key, jkey, sign } = k;
  const cases = [];
  const M = '/v1/manifests/daily';
  const W = 'nohook';
  const bank = O[W].bank;
  const NEW = ['$.verdict.checked_at', '$.platform_signature.sig', '$.commitment', '$.attestation_id'];
  const ROW = (n) => [`$.data[${n}].commitment`, `$.data[${n}].attestation.id`, `$.data[${n}].created_at`, `$.data[${n}].verdict.checked_at`];
  const manifest = (date, payment_ids, more = {}) => ({ date, institution_id: bank.id, payment_ids, count: payment_ids.length, ...more });
  const signed = (m) => ({ manifest: m, sig: sign(W, m) });
  const submit = (name, body, more = {}, o = O[W]) => cases.push({ name: `manifest: ${name}`, method: 'POST', target: M, headers: jkey(o), body, ...more });
  const read = (name, query, more = {}, o = O.read) => cases.push({ name: `manifests: ${name}`, target: `${M}${query}`, headers: key(o), ...more });
  const days = Object.keys(R.by_day[W]).sort();
  const [first, recent] = [days[0], days[days.length - 1]];
  const firstIds = R.by_day[W][first];
  const recentIds = R.by_day[W][recent];
  const others = R.settlements.read['anchored-a'].id;

  // ── the seeded manifests, read ───────────────────────────────────────────────────────────────────────────────
  read('the newest of the read organisation', '', { expect: { '$.data[0].date': '2026-10-07', '$.data[2].date': '2026-10-05' } });
  for (const [date, m] of Object.entries(R.manifests)) read(`of ${date} (${m.status}${m.attestation_id ? '' : ', no anchor record'})`, `?date=${date}`, { expect: { '$.data[0].verdict.status': m.status } });
  read('of a day without one', '?date=2020-01-01');
  read('of a day that is no day', '?date=yesterday');
  read('of a day with a time', '?date=2026-10-05T00:00:00.000Z');
  read('of an empty day: all of them', '?date=');
  read('of a day given twice: the first', '?date=2026-10-06&date=2026-10-05');
  read('with a limit and a cursor nobody reads', '?limit=1&cursor=x');
  read('of the organisation that writes below: none yet', '', {}, O[W]);
  read('of an organisation without a subscription: none, and no refusal', '', {}, O.nosub);
  read('a seeded day, asked for by another organisation', '?date=2026-10-05', {}, O.b);

  // ── refused, in the order the checks are made ────────────────────────────────────────────────────────────────
  submit('an empty body', {}, { expect: { '$.error': 'invalid_manifest' } });
  submit('a body that is null', 'null');
  submit('a body that is a list', '[]', { expect: { '$.error': 'invalid_manifest' } });
  submit('a body that is no JSON', '{', { expect: { '$.error': 'invalid_json' } });
  submit('a manifest that is text', { manifest: '2026-10-05', sig: sign(W, '2026-10-05') }, { expect: { '$.error': 'invalid_manifest' } });
  submit('no date', signed({ institution_id: bank.id, payment_ids: [], count: 0 }), { expect: { '$.error': 'invalid_manifest' } });
  for (const date of ['05-10-2026', '2026/10/05', '20261005', '2026-10-5', '2026-10-05T00:00:00Z', ' 2026-10-05', '2026-10-05 ', '2026-10-05\n', '２０２６-10-05', '']) {
    submit(`a date written ${JSON.stringify(date)}`, signed(manifest(date, [])), { expect: { '$.error': 'invalid_manifest' } });
  }
  submit('a date that is a number', signed(manifest(20261005, [])));
  // Not sent: a date that is a list of one date. The reference's pattern takes it for the date it holds and hands the list to its store.
  submit('ids that are text', signed({ date: first, institution_id: bank.id, payment_ids: firstIds[0], count: 1 }), { expect: { '$.error': 'invalid_manifest' } });
  submit('ids that are an object', signed({ date: first, institution_id: bank.id, payment_ids: { 0: firstIds[0] }, count: 1 }), { expect: { '$.error': 'invalid_manifest' } });
  submit('no ids', signed({ date: first, institution_id: bank.id, count: 0 }), { expect: { '$.error': 'invalid_manifest' } });
  submit('a count one more than the ids', signed({ date: first, institution_id: bank.id, payment_ids: firstIds, count: firstIds.length + 1 }), { expect: { '$.error': 'invalid_manifest' } });
  submit('a count that is text', signed({ date: first, institution_id: bank.id, payment_ids: firstIds, count: String(firstIds.length) }), { expect: { '$.error': 'invalid_manifest' } });
  submit('no count', signed({ date: first, institution_id: bank.id, payment_ids: [] }), { expect: { '$.error': 'invalid_manifest' } });
  submit('a wrong date and a wrong count and no signature: the date', { manifest: { date: 'today', payment_ids: [], count: 3 } }, { expect: { '$.error': 'invalid_manifest', '$.message': 'manifest.date must be YYYY-MM-DD' } });
  submit('a wrong count and no signature: the count', { manifest: { date: first, payment_ids: [], count: 3 } }, { expect: { '$.error': 'invalid_manifest', '$.message': 'payment_ids[] and a matching count are required' } });
  submit('no signature', { manifest: manifest(first, firstIds) }, { expect: { '$.error': 'invalid_signature' } });
  submit('a signature that is null', { manifest: manifest(first, firstIds), sig: null }, { expect: { '$.error': 'invalid_signature' } });
  submit('a signature that is text', { manifest: manifest(first, firstIds), sig: 'signed' }, { expect: { '$.error': 'invalid_signature' } });
  submit('a signature of another key under the bank\'s name', { manifest: manifest(first, firstIds), sig: signEvent(manifest(first, firstIds), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, bank.id, bank.name) }, { expect: { '$.error': 'invalid_signature' } });
  submit('a signature of another organisation\'s bank', { manifest: manifest(first, firstIds), sig: sign('rail', manifest(first, firstIds)) }, { expect: { '$.error': 'invalid_signature' } });
  submit('a manifest changed after it was signed', { manifest: manifest(first, [...firstIds, 'PAY-ADDED-LATER']), sig: sign(W, manifest(first, firstIds)) }, { expect: { '$.error': 'invalid_signature' } });
  submit('a manifest with a fraction in it: nothing the bank could have signed', { manifest: manifest(first, firstIds, { weight: 0.5 }), sig: sign(W, manifest(first, firstIds)) }, { expect: { '$.error': 'invalid_signature' } });
  submit('a signature over the list instead of the manifest', { manifest: manifest(first, firstIds), sig: sign(W, firstIds) }, { expect: { '$.error': 'invalid_signature' } });
  submit('another organisation\'s manifest, signed by its own bank, sent with this key', { manifest: manifest(first, firstIds), sig: sign('rail', manifest(first, firstIds)) }, { expect: { '$.error': 'invalid_signature' } });
  read('nothing was stored by the refused ones', '', {}, O[W]);

  // ── compared with the ledger, both ways ──────────────────────────────────────────────────────────────────────
  const OK = (status, platform, count) => ({ '$.verdict.status': status, '$.verdict.platform_count': platform, '$.verdict.manifest_count': count });
  submit(`everything of ${first}`, signed(manifest(first, firstIds)), { volatile: NEW, capture: { m1: '$.attestation_id' }, expect: OK('MATCHED', firstIds.length, firstIds.length) });
  read('the day now has one', `?date=${first}`, { volatile: ROW(0), expect: { '$.data[0].verdict.status': 'MATCHED', '$.data[0].attestation.status': 'accepted' } }, O[W]);
  cases.push({ name: 'manifest: its anchor record, read through the document route', target: '/v1/attestations/{m1}', headers: key(O[W]), volatile: ['$.id', '$.leaf_bytes', '$.created_at'] });
  cases.push({ name: 'manifest: the bundle of its anchor record, which is in no batch yet', target: '/v1/attestations/{m1}/bundle', headers: key(O[W]) });
  cases.push({ name: 'manifest: its anchor record, asked for by another organisation', target: '/v1/attestations/{m1}', headers: key(O.read), blur: [[/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, '<id>']] });
  submit(`${first} again with nothing in it: the settlement is missing`, signed(manifest(first, [])), { volatile: NEW, expect: { ...OK('DISCREPANT', firstIds.length, 0), '$.verdict.missing_in_manifest[0]': firstIds[0] } });
  read('the day\'s manifest was replaced', `?date=${first}`, { volatile: ROW(0), expect: { '$.data[0].verdict.status': 'DISCREPANT' } }, O[W]);
  submit(`${first} with ids the platform never saw, one twice, one of another organisation, one that is no text`, signed(manifest(first, [...firstIds, 'PAY-NOBODY-KNOWS', 'PAY-NOBODY-KNOWS', others, 7, ''])),
    { volatile: NEW, expect: { ...OK('DISCREPANT', firstIds.length, firstIds.length + 5), '$.verdict.unknown_to_platform[0]': 'PAY-NOBODY-KNOWS', '$.verdict.unknown_to_platform[2]': others } });
  submit(`${first} with its settlement named twice`, signed(manifest(first, [...firstIds, ...firstIds])), { volatile: NEW, expect: OK('MATCHED', firstIds.length, firstIds.length * 2) });
  submit(`${first} with members nobody reads, and another bank named in it`, signed(manifest(first, firstIds, { institution_id: 'SOMEBODY-ELSE', note: 'sent again', currency: 'USD' })), { volatile: NEW, expect: OK('MATCHED', firstIds.length, firstIds.length) });
  submit(`everything of ${recent}, the other way round`, signed(manifest(recent, [...recentIds].reverse())), { volatile: NEW, expect: OK('MATCHED', recentIds.length, recentIds.length) });
  submit(`${recent} with its first settlement left out and one nobody knows`, signed(manifest(recent, [...recentIds.slice(1), 'PAY-NOBODY-KNOWS'])),
    { volatile: NEW, expect: { ...OK('DISCREPANT', recentIds.length, recentIds.length), '$.verdict.missing_in_manifest[0]': recentIds[0], '$.verdict.unknown_to_platform[0]': 'PAY-NOBODY-KNOWS' } });
  submit(`${recent} with its ids in lower case: other ids`, signed(manifest(recent, recentIds.map((id) => id.toLowerCase()))), { volatile: NEW, expect: OK('DISCREPANT', recentIds.length, recentIds.length) });
  submit('a day nothing was instructed on, with nothing', signed(manifest('2020-01-01', [])), { volatile: NEW, expect: OK('MATCHED', 0, 0) });
  submit('a day nothing was instructed on, with something', signed(manifest('2020-01-02', [firstIds[0]])), { volatile: NEW, expect: OK('DISCREPANT', 0, 1) });
  submit('a day the calendar has not', signed(manifest('2026-02-31', [])), { volatile: NEW, expect: OK('MATCHED', 0, 0) });
  submit('a day far ahead', signed(manifest('9999-12-31', [])), { volatile: NEW, expect: OK('MATCHED', 0, 0) });
  submit('a hundred ids nobody knows', signed(manifest('2020-01-03', Array.from({ length: 100 }, (_, i) => `PAY-BULK-${String(i).padStart(3, '0')}`))), { volatile: NEW, expect: OK('DISCREPANT', 0, 100) });
  submit('the same manifest, the same bytes, again', signed(manifest('2020-01-01', [])), { volatile: NEW, expect: OK('MATCHED', 0, 0) });

  // ── what is there afterwards ─────────────────────────────────────────────────────────────────────────────────
  const made = 7; // days: first, recent, 2020-01-01, 2020-01-02, 2020-01-03, 2026-02-31, 9999-12-31
  read('all of them, newest day first', '', { volatile: Array.from({ length: made }, (_, n) => ROW(n)).flat(), expect: { '$.data[0].date': '9999-12-31', [`$.data[${made - 1}].date`]: '2020-01-01' } }, O[W]);
  read('one of them by its day', '?date=2020-01-03', { volatile: ROW(0) }, O[W]);
  read('the read organisation\'s are as they were', '', { expect: { '$.data[0].date': '2026-10-07' } });
  cases.push({ name: 'manifest: by PUT', method: 'PUT', target: M, headers: jkey(O[W]), body: {} });
  cases.push({ name: 'manifest: by DELETE', method: 'DELETE', target: `${M}?date=${first}`, headers: key(O[W]) });
  return cases;
};
