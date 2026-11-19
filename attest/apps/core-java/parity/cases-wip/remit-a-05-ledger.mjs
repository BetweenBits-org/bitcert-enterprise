/**
 * The settlement rail, the ledger: `GET /v1/settlements` on the seeded organisation that no case writes to.
 *
 * Every filter by itself, together, and wrong: `q` (the one box an operator types a reference into), the exact
 * lookups by the bank's own message (`source_uetr`, `source_content`, `source_value_date`), `state`, `from` / `to`,
 * `limit`, `cursor`. Whole answers are compared: the rows are seeded and are the same in both stores, so nothing
 * here is new from run to run.
 *
 * What the search finds is the store's doing, not the service's: a reference is looked for in the JSON text of the
 * field it stands in (quotes and escapes included), the needle is put in capitals by the service and the field by
 * the store, and `%`, `_` and `!` are taken literally. The needles below are chosen for where two implementations
 * part ways: a quote, a backslash, a tab, a sharp s, a word that is JSON's own (`null`, `true`), a name of a member.
 *
 * A cursor is each server's own text for "after this row"; pages are walked with each server's own cursor and —
 * `swap` — with the other server's, which has to mean the same place.
 */
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-05: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, key } = k;
  const cases = [];
  const L = '/v1/settlements';
  const ledger = (name, query, more = {}, o = O.read) => cases.push({ name: `ledger: ${name}`, target: `${L}${query}`, headers: key(o), ...more });
  const enc = encodeURIComponent;
  const total = R.paging.total;

  ledger('the newest page', '', { expect: { '$.page.total': total, '$.page.returned': 25 } });
  ledger('of an organisation without a settlement', '', { expect: { '$.page.total': 0, '$.page.next_cursor': null } }, O.nosub);
  ledger('of another organisation: its own two', '', { expect: { '$.page.total': 2 } }, O.b);

  // ── limit ────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const limit of ['1', '2', '24', '25', '26', '100', '101', '500', '0', '-1', '-0', '1.9', '2.5', '1e1', '0x10', ' 7', '7 ', '+7', 'abc', '', 'null', 'Infinity', '99999999999999999999']) {
    ledger(`limit=${JSON.stringify(limit)}`, `?limit=${enc(limit)}`);
  }
  ledger('limit given twice', '?limit=2&limit=3');

  // ── pages: every row once, in order, whoever's cursor it is ──────────────────────────────────────────────────
  for (const size of [50, 7]) {
    const pages = Math.ceil(total / size);
    ledger(`pages of ${size}: page 1`, `?limit=${size}`, { capture: { [`c${size}`]: '$.page.next_cursor' } });
    for (let p = 2; p <= pages; p++) {
      ledger(`pages of ${size}: page ${p}${p === pages ? ', the last' : ''}`, `?limit=${size}&cursor={c${size}}`, p === pages ? { expect: { '$.page.next_cursor': null, '$.page.total': total } } : { capture: { [`c${size}`]: '$.page.next_cursor' } });
    }
  }
  // The other server's cursor: page 1 of each, then page 2 by the cursor the other one gave, and on from there.
  ledger('by the other server\'s cursor: page 1', '?limit=40', { capture: { cx: '$.page.next_cursor' } });
  ledger('by the other server\'s cursor: page 2', '?limit=40&cursor={cx}', { swap: true, capture: { cx: '$.page.next_cursor' } });
  ledger('by the other server\'s cursor: page 3', '?limit=40&cursor={cx}', { swap: true, capture: { cx: '$.page.next_cursor' } });
  ledger('by the other server\'s cursor: page 4, the last', '?limit=40&cursor={cx}', { swap: true, expect: { '$.page.next_cursor': null } });
  // The six settlements of one millisecond: a page boundary among them falls back on the id.
  const six = R.paging.same_millisecond;
  ledger('the six of one millisecond, two at a time: page 1', `?limit=2&q=${enc('PAY-SEED-PAGE-03')}`, { capture: { c6: '$.page.next_cursor' } });
  for (let p = 2; p <= 5; p++) ledger(`the six of one millisecond, two at a time: page ${p}${p === 5 ? ', the last' : ''}`, `?limit=2&q=${enc('PAY-SEED-PAGE-03')}&cursor={c6}`, p === 5 ? { expect: { '$.page.next_cursor': null, '$.page.total': 10 } } : { capture: { c6: '$.page.next_cursor' } });
  ledger('the six of one millisecond, all at once', `?limit=100&from=${enc(R.settlements.read['page-031'].created_at)}&to=${enc(R.settlements.read['page-031'].created_at)}`, { expect: { '$.page.total': six.length } });
  ledger('a cursor under a filter: page 1', '?limit=3&state=ONCHAIN_SETTLED', { capture: { cs: '$.page.next_cursor' } });
  ledger('a cursor under a filter: page 2', '?limit=3&state=ONCHAIN_SETTLED&cursor={cs}', { capture: { cs2: '$.page.next_cursor' } });
  ledger('that cursor under another filter: the same place in another list', '?limit=3&state=CANCELLED&cursor={cs}');
  ledger('that cursor with no filter', '?limit=3&cursor={cs}');
  ledger('that cursor as another organisation: its own rows after that place', '?limit=3&cursor={cs}', {}, O.b);

  // ── cursors that are none ────────────────────────────────────────────────────────────────────────────────────
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const cursors = [['a word', 'next'], ['one character', 'x'], ['an empty object', b64({})], ['a time and no id', b64({ c: '2026-10-05T00:00:00.000Z' })], ['an id and no time', b64({ i: 'PAY-SEED-ANCHORED-A' })],
    ['a time that is a number', b64({ c: 5, i: 'PAY-SEED-ANCHORED-A' })], ['an id that is a number', b64({ c: '2026-10-05T00:00:00.000Z', i: 6 })], ['a list', b64([])], ['null', b64('null')], ['text', b64('"cursor"')], ['a number', b64('7')],
    ['JSON and something after it', b64('{"c":"a","i":"b"}x')], ['not JSON', b64('{c:1}')], ['a dot', '.'], ['a percent sign', '%25'], ['a space', '%20'], ['a place nobody is at', b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-NOWHERE' })],
    ['a place before everything', b64({ c: '2000-01-01T00:00:00.000Z', i: '' })], ['a place after everything', b64({ c: '2999-01-01T00:00:00.000Z', i: 'z' })], ['a place whose time is no time', b64({ c: 'yesterday', i: 'PAY-SEED-ANCHORED-A' })],
    ['members more than two', b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-SEED', x: 1 })], ['the members the other way round', b64({ i: 'PAY-SEED', c: '2026-10-07T12:00:00.000Z' })],
    ['the standard alphabet with padding', Buffer.from(JSON.stringify({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-SEED?>' })).toString('base64')], ['base64url with padding', `${b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY' })}==`],
    ['white space inside', `${b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-SEED' }).slice(0, 10)}%20${b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-SEED' }).slice(10)}`],
    ['characters outside the alphabet', `${b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY-SEED' })}*!`], ['bytes that are no UTF-8', Buffer.from([0x7b, 0x22, 0x63, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x2c, 0x22, 0x69, 0x22, 0x3a, 0x22, 0x61, 0x22, 0x7d]).toString('base64url')]];
  for (const [what, cursor] of cursors) ledger(`a cursor that is ${what}`, `?limit=2&cursor=${cursor.includes('%') ? cursor : enc(cursor)}`);
  ledger('an empty cursor: none', '?limit=2&cursor=');
  ledger('a cursor given twice', `?limit=2&cursor=${b64({ c: '2026-10-07T12:00:00.000Z', i: 'PAY' })}&cursor=x`);

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────
  const STATES = ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED', 'CANCELLED', 'RETURNED', 'EXCEPTION'];
  for (const state of STATES) ledger(`state=${state}`, `?limit=100&state=${state}`);
  for (const state of ['CANCELLED,RETURNED,EXCEPTION', 'EVIDENCE_ANCHORED,BENEFICIARY_CREDIT_CONFIRMED', ' EVIDENCE_ANCHORED , CANCELLED ', 'CANCELLED,,RETURNED,', ',CANCELLED', 'CANCELLED,CANCELLED', STATES.join(','),
    'PAID', 'CANCELLED,PAID', 'PAID,CANCELLED', 'cancelled', 'Cancelled', 'CANCELLED;RETURNED', 'CANCELLED RETURNED', 'CANCELLED%', "CANCELLED'", '*', ' ']) {
    ledger(`state=${JSON.stringify(state)}`, `?limit=100&state=${enc(state)}`);
  }
  ledger('state that is empty: no filter', '?limit=3&state=');
  ledger('state given twice: the first', '?limit=100&state=RETURNED&state=CANCELLED');
  // `state=,` names no state at all. The reference then writes `state IN ()` and answers with the store's complaint; listed for the Java service (D-01).
  ledger('state that is a comma', '?limit=3&state=%2C');

  // ── from, to ─────────────────────────────────────────────────────────────────────────────────────────────────
  for (const [from, to] of [['2026-10-05', ''], ['2026-10-06', ''], ['', '2026-10-05'], ['', '2026-10-05T23:59:59.999Z'], ['2026-10-06', '2026-10-08'], ['2026-10-07T00:00:00.000Z', '2026-10-07T23:59:59.999Z'],
    ['2026-10-08T08:00:00.000Z', '2026-10-08T08:03:00.000Z'], ['2026-10-10', '2026-10-05'], ['2027', ''], ['', '2020'], ['2026', '2026-11'], ['tomorrow', 'yesterday'], ['2026-10-07t00:00:00.000z', ''], [' 2026-10-07', ''],
    ['2026-10-05T00:00:00+09:00', ''], ['1759622400000', ''], [R.recent.from, R.recent.to], [R.paging.ids.length ? '2026-10-09T06:00:00.000Z' : '', '2026-10-09T06:00:00.999Z']]) {
    ledger(`from ${JSON.stringify(from)} to ${JSON.stringify(to)}`, `?limit=100${from ? `&from=${enc(from)}` : ''}${to ? `&to=${enc(to)}` : ''}`);
  }
  ledger('from and to that are empty: no filter', '?limit=2&from=&to=');

  // ── q: one box, every reference ──────────────────────────────────────────────────────────────────────────────
  let n = 0;
  for (const s of R.search) {
    const o = O[s.org];
    const v = String(s.value);
    n++;
    ledger(`q ${String(n).padStart(2, '0')}: by ${s.where}`, `?limit=100&q=${enc(v)}`, {}, o);
    if (n <= 30) {
      const part = v.slice(1, -1);
      ledger(`q ${String(n).padStart(2, '0')}: a part of it, in the other case`, `?limit=100&q=${enc(part.toLowerCase() === part ? part.toUpperCase() : part.toLowerCase())}`, {}, o);
    }
  }
  for (const q of ['PAY-SEED', 'pay-seed-page', 'Pay-Seed-Anchored', 'QT-', 'qt-', '0x', '0X10', 'FAST-', 'fast-', 'APPR-', 'appr-pay-seed-anchored-a', 'INST-', 'RCPT-', 'INV-', 'REQ-', 'BEN-', 'PO-78', 'OUT-2026', 'VINATRD',
    '_', '%', '!', '!%', '!_', '!!', '%%', '_%_', '\\', '\\\\', '"', '""', '"INST', '0401"', '\\"', "'", '`', ';', '--', '/*', ' ', '  ', '\t', '\n', 'INST-TAB\there', 'INST-TAB\\there', 'INST-TAB\\Tthere',
    'quoted', '"quoted"', '\\"quoted\\"', 'back\\slash', 'back\\\\slash', 'INST\\back', 'ß', 'SS', 'ss', 'straße', 'STRASSE', 'Straße', 'réf', 'RÉF', 'REF', 'é', 'É', '지시', '😀', 'İ', 'ı', 'ǆ', 'ŉ',
    'null', 'NULL', 'nul', 'true', 'TRUE', 'ru', 'false', 'payment_id', 'bank_reference', 'sourceMessage', 'instruction_ref', 'bankInstruction', 'uetr', 'A', 'a', 'x'.repeat(60), 'x'.repeat(61), 'x'.repeat(300),
    'no such thing anywhere', 'PAY-SEED-ANCHORED-A PAY', '3f1c9a52', '3F1C9A52-7B0E', '7d4c2b1a', 'SG-BFI-001', 'VN-BANK-READ', 'USDC', '1200.00', 'BENEFICIARY_CREDIT_CONFIRMED', 'STONEHASH', '0', '00', '2026-10-05']) {
    ledger(`q=${JSON.stringify(q.length > 40 ? `${q.slice(0, 6)}… (${q.length})` : q)}`, `?limit=100&q=${enc(q)}`);
  }
  ledger('q that is empty: no filter', '?limit=2&q=');
  ledger('q given twice: the first', `?limit=100&q=${enc('PAY-SEED-ANCHORED-A')}&q=nothing`);
  ledger('q with a plus sign: a space', '?limit=100&q=INST+0409');
  ledger('q with a byte that is no UTF-8', '?limit=100&q=%FF%FE');
  ledger('q with a malformed escape', '?limit=100&q=%E0%A4%A');
  ledger('q as another organisation: its own rows only', `?limit=100&q=${enc('PAY-')}`, {}, O.b);
  ledger('q for another organisation\'s reference', `?limit=100&q=${enc('PAY-SEED-ANCHORED-A')}`, { expect: { '$.page.total': 0 } }, O.b);

  // ── the exact lookups: the bank's question before it sends ───────────────────────────────────────────────────
  for (const [file, held] of Object.entries(R.source)) {
    const src = held.source;
    if (src.uetr) {
      ledger(`by the UETR of ${file}`, `?source_uetr=${src.uetr}`);
      ledger(`by the UETR of ${file}, in capitals`, `?source_uetr=${src.uetr.toUpperCase()}`);
      ledger(`by the UETR of ${file}, as another organisation`, `?source_uetr=${src.uetr}`, { expect: { '$.page.total': 0 } }, O.rail);
      ledger(`by the UETR of ${file} and a state it is not in`, `?source_uetr=${src.uetr}&state=CANCELLED`);
      ledger(`by the UETR of ${file} and a part of its id`, `?source_uetr=${src.uetr}&q=${enc(held.payment_id ?? held.of).slice(0, 8)}`);
    }
    ledger(`by the content of ${file}`, `?source_content=${src.content}`);
    ledger(`by the content of ${file}, in capitals`, `?source_content=${src.content.toUpperCase()}`);
    ledger(`by the content and the value date of ${file}`, `?source_content=${src.content}&source_value_date=${src.valueDate}`);
    ledger(`by the content of ${file} and another value date`, `?source_content=${src.content}&source_value_date=2020-01-01`);
    if (src.uetr) ledger(`by the UETR and the content of ${file}`, `?source_uetr=${src.uetr}&source_content=${src.content}`);
  }
  const digest = 'ab'.repeat(32);
  ledger('by a UETR no settlement has', '?source_uetr=00000000-0000-4000-8000-000000000000', { expect: { '$.page.total': 0 } });
  ledger('by a content no settlement has', `?source_content=${digest}`, { expect: { '$.page.total': 0 } });
  for (const [what, query, error] of [['a UETR that is no UUID', '?source_uetr=nope', 'invalid_source_lookup'], ['a UETR without hyphens', '?source_uetr=3f1c9a527b0e4d6a9c1f2e8b5a7d4c10', 'invalid_source_lookup'],
    ['an empty UETR', '?source_uetr=', 'invalid_source_lookup'], ['a UETR with a space after it', '?source_uetr=3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10%20', 'invalid_source_lookup'],
    ['a UETR with a line feed after it', '?source_uetr=3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10%0A', 'invalid_source_lookup'],
    ['a content that is no digest', '?source_content=abc', 'invalid_source_lookup'], ['an empty content', '?source_content=', 'invalid_source_lookup'], ['a content of 65 characters', `?source_content=${digest}a`, 'invalid_source_lookup'],
    ['a value date alone', '?source_value_date=2026-11-17', 'invalid_source_lookup'], ['a value date with a UETR and no content', '?source_uetr=3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10&source_value_date=2026-11-17', 'invalid_source_lookup'],
    ['a value date that is no day', `?source_content=${digest}&source_value_date=17-11-2026`, 'invalid_source_lookup'], ['an empty value date', `?source_content=${digest}&source_value_date=`, 'invalid_source_lookup'],
    ['a value date with a line feed after it', `?source_content=${digest}&source_value_date=2026-11-17%0A`, 'invalid_source_lookup']]) {
    ledger(`by ${what}`, query, { expect: { '$.error': error } });
  }
  ledger('by a value date the calendar has not: well formed, and nothing found', `?source_content=${digest}&source_value_date=2026-02-31`, { expect: { '$.page.total': 0 } });

  // ── several things wrong at once: which one is answered ──────────────────────────────────────────────────────
  ledger('a lookup, a state and a cursor that are none: the lookup', '?source_uetr=nope&state=PAID&cursor=x', { expect: { '$.error': 'invalid_source_lookup' } });
  ledger('a state and a cursor that are none: the state', '?state=PAID&cursor=x', { expect: { '$.error': 'invalid_state' } });
  ledger('a cursor that is none, and everything else right', '?state=CANCELLED&q=PAY&from=2026-10-01&cursor=x', { expect: { '$.error': 'invalid_cursor' } });
  ledger('a cursor that is none and a limit that is none: the cursor', '?cursor=x&limit=abc', { expect: { '$.error': 'invalid_cursor' } });
  ledger('everything at once: page 1', '?limit=5&q=pay-seed&state=ONCHAIN_SETTLED,EVIDENCE_ANCHORED&from=2026-10-01&to=2027-01-01', { capture: { call: '$.page.next_cursor' } });
  ledger('everything at once: page 2', '?limit=5&q=pay-seed&state=ONCHAIN_SETTLED,EVIDENCE_ANCHORED&from=2026-10-01&to=2027-01-01&cursor={call}');
  ledger('filters nobody knows', '?limit=2&status=CANCELLED&page=3&offset=40&order=asc&org_id=x');
  return cases;
};
