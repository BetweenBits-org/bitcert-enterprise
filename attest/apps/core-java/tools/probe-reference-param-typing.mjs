/**
 * What MySQL does with a parameter that is not text where a statement of the reference expects text — the
 * questions the two sweeps of the TypeScript core left open (2026-11-19), asked of the database itself.
 *
 *   node apps/core-java/tools/probe-reference-param-typing.mjs [<reference env file>]   (default: apps/core-java/.env.ref)
 *
 * On a `stonehash_test_` schema the reference has opened once (its tables must be there). The statements are the
 * reference's own texts, run the way its MySQL adapter runs them — `connection.execute(sql, params)`, a server-side
 * prepared statement, a boolean handed over as 1 or 0 — but on ONE connection of this tool's own and inside ONE
 * transaction that is rolled back. Nothing it writes stays, the rows it reads are its own, and the reference's code
 * is not called: the probe keeps saying what the database does whatever guards the reference has since been given.
 *
 * A prepared statement belongs to the connection that prepared it and is found again by its exact text, so
 * "the same statement, later" below is the same text on this connection, as it is for a pooled connection of the
 * running service.
 *
 * Prints what was observed, question by question. Exit status 0 when every experiment ran (whatever it found),
 * 2 when the schema is not one this tool may use or its tables are not there.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { problems, readEnvFile } from './check-test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(process.argv[2] ?? path.resolve(HERE, '../.env.ref'));
const env = readEnvFile(envFile);
const unsafe = problems(env);
if (unsafe.length) { for (const p of unsafe) console.error(`${path.basename(envFile)}: ${p}`); process.exit(2); }
const u = new URL(env.STONEHASH_DB_URL);
const schema = u.pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) { console.error(`refusing: ${schema} is not a stonehash_test_ schema`); process.exit(2); }

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
// The pool of the reference's adapter opens its connections like this (apps/core/src/db.ts, bootstrapMysql).
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: schema, charset: 'utf8mb4_bin' });

/** The adapter's own normalisation (db.ts `norm`): nothing → NULL, a boolean → 1 or 0, everything else as it is. */
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
const show = (v) => (v === undefined ? 'undefined' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
/** Run one statement; what came of it, never a throw. */
const run = async (sql, ...params) => {
  try {
    const [r] = await conn.execute(sql, norm(params));
    return Array.isArray(r) ? { rows: r } : { changed: r.affectedRows };
  } catch (e) {
    return { error: `${e.code ?? e.name} (${e.errno ?? '-'}): ${String(e.message).slice(0, 160)}` };
  }
};
const said = (r) => (r.error ? `REFUSED by the database — ${r.error}` : r.rows ? `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}` : `done, ${r.changed} row${r.changed === 1 ? '' : 's'} changed`);
const line = (label, text) => console.log(`  ${label.padEnd(58)} → ${text}`);
const head = (t) => console.log(`\n── ${t}`);
const findings = [];
const finding = (q, a) => { findings.push([q, a]); };

const need = ['orgs', 'remit_quotes', 'remit_payments', 'remit_events', 'institutions', 'subscriptions', 'attestations', 'remit_webhook_deliveries', 'por_snapshots'];
const [have] = await conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?', [schema]);
const missing = need.filter((t) => !have.some((h) => h.t === t));
if (missing.length) { console.error(`${schema} has no table ${missing.join(', ')}: let the reference open it once (tools/seed-reference.mjs)`); await conn.end(); process.exit(2); }

const T = '2026-11-19T00:00:00.000Z';
const ORG = 'probe-typing-org';
const OTHER = 'probe-typing-other';
try {
  await conn.beginTransaction();

  // ── 0. the server ────────────────────────────────────────────────────────────────────────────────────────────
  head('0. the server (shared by every schema on it, the live one included)');
  const [[facts]] = await conn.query('SELECT @@version AS version, @@session.sql_mode AS session_mode, @@global.sql_mode AS global_mode, @@max_prepared_stmt_count AS max_statements, @@transaction_isolation AS isolation');
  line('version', facts.version);
  line('sql_mode of this session (the adapter sets none)', facts.session_mode);
  line('the same as the server default', String(facts.session_mode === facts.global_mode));
  line('max_prepared_stmt_count (all connections together)', String(facts.max_statements));
  const strict = /STRICT_(TRANS|ALL)_TABLES/.test(facts.session_mode);
  finding('sql_mode', `${strict ? 'strict' : 'NOT strict'} (${facts.session_mode}); server ${facts.version}`);

  // rows of the probe's own
  await run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, 'probe', ?)", ORG, ORG, T);
  await run("INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, 'probe other', ?)", OTHER, OTHER, T);
  for (const [org, q] of [[ORG, 'QT-PROBE-1'], [ORG, 'QT-PROBE-2'], [OTHER, 'QT-PROBE-9']]) {
    await run("INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at) VALUES (?, ?, 'VN', 'SG', '{}', '{}', ?, ?)", q, org, T, T);
  }
  const INSERT_PAYMENT = `INSERT INTO remit_payments
         (id, org_id, quote_id, state, corridor_origin, corridor_destination,
          trade_currency, trade_amount, collect_currency, collect_amount, usdc_amount,
          payout_currency, payout_amount, beneficiary_institution, request_body,
          created_at, updated_at)
       VALUES (?, ?, ?, 'REQUEST_ACCEPTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const payment = (id, org, quote) => [id, org, quote, 'VN', 'SG', 'USD', '10.00', 'VND', '1', '10.00', 'SGD', '13.35', 'SG-BFI-001', '{}', T, T];
  const made = [];
  for (const [id, org, q] of [['PAY-PROBE-A', ORG, 'QT-PROBE-1'], ['PAY-PROBE-B', OTHER, 'QT-PROBE-9'], ['77PAY-PROBE', ORG, 'QT-PROBE-1']]) made.push(said(await run(INSERT_PAYMENT, ...payment(id, org, q))));
  if (made.some((m) => !m.startsWith('done, 1'))) throw new Error(`the probe could not make its own rows: ${made.join(' | ')}`);
  const [[{ n: others }]] = await conn.query("SELECT COUNT(*) AS n FROM remit_payments WHERE id NOT LIKE '%PROBE%'");
  console.log(`  (the schema holds ${others} settlements besides the probe's three)`);

  // ── 1. a comparison: WHERE id = ? ────────────────────────────────────────────────────────────────────────────
  head('1. SELECT * FROM remit_payments WHERE id = ?   (RemitStore.get — every lookup of a settlement)');
  const GET = 'SELECT * FROM remit_payments WHERE id = ?';
  const ABSENT = 'PAY-NO-SETTLEMENT-HAS-THIS-ID';
  const ids = (r) => (r.error ? said(r) : r.rows.length === 0 ? 'nothing' : `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}: ${r.rows.slice(0, 3).map((x) => x.id).join(', ')}${r.rows.length > 3 ? ', …' : ''}`);
  line(`text ${show(ABSENT)}`, ids(await run(GET, ABSENT)));
  line('text "PAY-PROBE-A"', ids(await run(GET, 'PAY-PROBE-A')));
  const listHit = await run(GET, ['PAY-PROBE-A']);
  line('a list ["PAY-PROBE-A"]', ids(listHit));
  line('an object {"id":"PAY-PROBE-A"}', ids(await run(GET, { id: 'PAY-PROBE-A' })));
  const afterList = await run(GET, ABSENT);
  line(`text ${show(ABSENT)} after the list and the object`, ids(afterList));
  finding('a list or an object where text is expected (comparison)', listHit.rows?.length === 0 && afterList.rows?.length === 0
    ? 'compared as its JSON text: ["PAY-PROBE-A"] finds nothing, and the statement goes on comparing text as text'
    : `NOT as assumed: the list found ${ids(listHit)}; a text id nobody has then found ${ids(afterList)}`);
  line('the number 12345', ids(await run(GET, 12345)));
  const afterNumber = await run(GET, ABSENT);
  line(`text ${show(ABSENT)} after the number`, ids(afterNumber));
  const own = await run(GET, 'PAY-PROBE-A');
  line('text "PAY-PROBE-A" after the number', ids(own));
  line('text "77PAY-PROBE" after the number', ids(await run(GET, '77PAY-PROBE')));
  line('the number 77', ids(await run(GET, 77)));
  line('NULL, then text again', `${ids(await run(GET, null))}; ${ids(await run(GET, ABSENT))}`);
  finding('a number where text is expected (comparison)', afterNumber.rows?.length > 0
    ? `the statement compares numerically from then on, on that connection: a text id that no settlement has finds ${afterNumber.rows.length} rows (every id that does not start with a digit reads as 0); the adapter hands the caller the first`
    : 'NOT reproduced: text was compared as text after the number');
  // 0 and false, first use of a statement text of its own
  const GET0 = 'SELECT * FROM remit_payments WHERE id = ? /* probe: first use with 0 */';
  line('0 on a statement never used before', ids(await run(GET0, 0)));
  const GETF = 'SELECT * FROM remit_payments WHERE id = ? /* probe: first use with false */';
  const falseHit = await run(GETF, false);
  line('false on a statement never used before', ids(falseHit));
  finding('payment_id 0 or false', falseHit.rows?.length > 0
    ? `needs no earlier request: 0 / false equals every id that does not start with a digit (${falseHit.rows.length} rows here), so the lookup "finds" a settlement and the handler goes on`
    : 'found nothing');

  // ── 2. the institution lookup, with 0 ────────────────────────────────────────────────────────────────────────
  head('2. SELECT * FROM institutions WHERE id = ?   (Registry.institution — every signature check)');
  await run("INSERT INTO institutions (id, org_id, role, name, country, signing_spki, encryption_jwk, authority, created_at) VALUES ('ZZ-PROBE-BANK', ?, 'COLLECTION_BANK', 'Probe Bank', 'ZZ', NULL, NULL, '[]', ?)", ORG, T);
  const INST = 'SELECT * FROM institutions WHERE id = ?';
  line('text "ZZ-PROBE-BANK"', ids(await run(INST, 'ZZ-PROBE-BANK')));
  line('0', ids(await run(INST, 0)));
  const instAfter = await run(INST, 'ZZ-PROBE-BANK');
  line('text "ZZ-PROBE-BANK" after 0', ids(instAfter));
  line('text "NOBODY-REGISTERED-THIS" after 0', ids(await run(INST, 'NOBODY-REGISTERED-THIS')));

  // ── 3. two parameters: the quote of an organisation, the subscription of a product ───────────────────────────
  head('3. SELECT * FROM remit_quotes WHERE id = ? AND org_id = ?   (RemitStore.quote)');
  const QUOTE = 'SELECT * FROM remit_quotes WHERE id = ? AND org_id = ?';
  line('text "QT-PROBE-2"', ids(await run(QUOTE, 'QT-PROBE-2', ORG)));
  line('a list ["QT-PROBE-2"]', ids(await run(QUOTE, ['QT-PROBE-2'], ORG)));
  line('the number 12345', ids(await run(QUOTE, 12345, ORG)));
  const q2 = await run(QUOTE, 'QT-PROBE-2', ORG);
  line('text "QT-PROBE-2" after the number', ids(q2));
  line('text "QT-NOBODY" after the number', ids(await run(QUOTE, 'QT-NOBODY', ORG)));
  line('text "QT-PROBE-2" of the other organisation', ids(await run(QUOTE, 'QT-PROBE-2', OTHER)));

  head('   SELECT * FROM subscriptions WHERE org_id = ? AND product = ?   (Registry.subscription — every product gate)');
  for (const [product, status] of [['attest', 'active'], ['por', 'inactive'], ['remit', 'inactive']]) {
    await run("INSERT INTO subscriptions (id, org_id, product, plan, status, config, created_at) VALUES (?, ?, ?, 'sandbox', ?, '{}', ?)", `probe-sub-${product}`, ORG, product, status, T);
  }
  const SUB = 'SELECT * FROM subscriptions WHERE org_id = ? AND product = ?';
  const prod = (r) => (r.error ? said(r) : r.rows.length === 0 ? 'nothing' : r.rows.map((x) => `${x.product} (${x.status})`).join(', '));
  line('text "remit" (switched off)', prod(await run(SUB, ORG, 'remit')));
  line('0 as a product', prod(await run(SUB, ORG, 0)));
  const gate = await run(SUB, ORG, 'remit');
  line('text "remit" after 0', prod(gate));
  finding('a number as a product name (admin deactivation)', gate.rows?.length > 1 || (gate.rows?.[0] && gate.rows[0].product !== 'remit')
    ? `afterwards the gate's lookup of "remit" answers ${prod(gate)}; the adapter takes the first row, so a product that is switched off can pass on the strength of another that is on`
    : `afterwards the lookup of "remit" answers ${prod(gate)}`);

  // ── 4. a value that is inserted ──────────────────────────────────────────────────────────────────────────────
  head('4. INSERT INTO attestations (… content_type …)   (AttestService.issue — every product\'s anchor)');
  const ISSUE = `INSERT INTO attestations
         (id, org_id, leaf_bytes, content_type, descriptor, status, created_at, source,
          expires_at, statement, issuer_trust, product)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?)`;
  let n = 0;
  const issue = (contentType) => { n++; return run(ISSUE, `probe-att-${n}`, ORG, String(n).padStart(64, 'a'), contentType, '{}', T, 'api', null, null, null, 'attest'); };
  const stored = async (table, col, id) => { const [[row]] = await conn.query(`SELECT ${col} AS v FROM ${table} WHERE id = ?`, [id]); return row ? show(row.v) : 'no row'; };
  line('content_type "text/plain"', `${said(await issue('text/plain'))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  line('content_type NULL', `${said(await issue(null))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  line('content_type a list ["text/plain"]', `${said(await issue(['text/plain']))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  line('content_type "text/plain" after the list', `${said(await issue('text/plain'))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  const numberIn = await issue(12345);
  line('content_type the number 12345', `${said(numberIn)}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  const textAfter = await issue('text/plain');
  const textAfterStored = await stored('attestations', 'content_type', `probe-att-${n}`);
  line('content_type "text/plain" after the number', `${said(textAfter)}; stored ${textAfterStored}`);
  line('content_type "application/json" after the number', `${said(await issue('application/json'))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  line('content_type "42" after the number', `${said(await issue('42'))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  line('content_type NULL after the number', `${said(await issue(null))}; stored ${await stored('attestations', 'content_type', `probe-att-${n}`)}`);
  finding('a number where a text value is INSERTed', textAfter.error
    ? `the statement is left numeric there too: every later text value is REFUSED on that connection (${textAfter.error.split(':')[0]}) — the caller gets a 500 — until the process restarts`
    : textAfterStored === show('text/plain') ? 'NOT left numeric: a later text value is stored as the text it is' : `the statement is left numeric there too: a later text value is stored as ${textAfterStored}`);

  // ── 5. a value that is SET, and the row it is set on ─────────────────────────────────────────────────────────
  head('5. UPDATE institutions SET role = ?, name = ?, … WHERE id = ?   (Registry.upsert)');
  const UPSERT = `UPDATE institutions SET role = ?, name = ?, country = ?, org_id = ?,
           signing_spki = COALESCE(?, signing_spki),
           encryption_jwk = COALESCE(?, encryption_jwk),
           authority = ? WHERE id = ?`;
  const upsert = (name, id = 'ZZ-PROBE-BANK') => run(UPSERT, 'COLLECTION_BANK', name, 'ZZ', ORG, null, null, '[]', id);
  line('name "Probe Bank, renamed"', `${said(await upsert('Probe Bank, renamed'))}; stored ${await stored('institutions', 'name', 'ZZ-PROBE-BANK')}`);
  line('name the number 7', `${said(await upsert(7))}; stored ${await stored('institutions', 'name', 'ZZ-PROBE-BANK')}`);
  const renamed = await upsert('Probe Bank');
  const renamedTo = await stored('institutions', 'name', 'ZZ-PROBE-BANK');
  line('name "Probe Bank" after the number', `${said(renamed)}; stored ${renamedTo}`);
  finding('a number where a text value is SET (UPDATE)', renamed.error
    ? `left numeric: every later text value is REFUSED on that connection (${renamed.error.split(':')[0]})`
    : renamedTo === show('Probe Bank') ? 'NOT left numeric: a later text value is stored as the text it is' : `left numeric: a later text value is stored as ${renamedTo}`);

  head('6. UPDATE remit_payments SET state = ?, updated_at = ? WHERE id = ?   (RemitStore.transition — every state change)');
  const MOVE = 'UPDATE remit_payments SET state = ?, updated_at = ? WHERE id = ?';
  line('id "PAY-PROBE-A"', said(await run(MOVE, 'BANK_AUTHORIZED', T, 'PAY-PROBE-A')));
  line('id the number 12345', said(await run(MOVE, 'BANK_AUTHORIZED', T, 12345)));
  const moved = await run(MOVE, 'CANCELLED', T, 'PAY-PROBE-A');
  line('id "PAY-PROBE-A" after the number', said(moved));
  const [[{ n: cancelled }]] = await conn.query("SELECT COUNT(*) AS n FROM remit_payments WHERE state = 'CANCELLED' AND updated_at = ?", [T]);
  line('settlements this one statement moved to CANCELLED', String(cancelled));
  finding('a number as the id of a state change (UPDATE … WHERE id = ?)', moved.error
    ? `afterwards every state change on that connection is REFUSED by the database (${moved.error.split(':')[0]}): the server will not turn a text id into a number inside an UPDATE under this sql_mode, so no other row is written — but no settlement moves either`
    : `afterwards a state change of ONE settlement changed ${moved.changed} rows (${cancelled} settlements now stand CANCELLED)`);

  head('7. the statements an acceptance runs with the request\'s own payment_id');
  const numeric = await run(INSERT_PAYMENT, ...payment(4242424242, ORG, 'QT-PROBE-1'));
  const [[asStored]] = await conn.query("SELECT id FROM remit_payments WHERE id = '4242424242'");
  line('INSERT INTO remit_payments, id the number 4242424242', `${said(numeric)}; stored under ${asStored ? show(asStored.id) : 'nothing'}`);
  const nextText = await run(INSERT_PAYMENT, ...payment('PAY-PROBE-C', ORG, 'QT-PROBE-1'));
  line('INSERT INTO remit_payments, id "PAY-PROBE-C" after it', said(nextText));
  const SEQ = 'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM remit_events WHERE payment_id = ?';
  const EVENT = `INSERT INTO remit_events (id, payment_id, seq, type, issuer, payload, sig, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  await run(EVENT, 'probe-ev-1', 'PAY-PROBE-A', 0, 'REQUEST_ACCEPTED', 'STONEHASH', '{}', null, T);
  await run(EVENT, 'probe-ev-2', 'PAY-PROBE-B', 0, 'REQUEST_ACCEPTED', 'STONEHASH', '{}', null, T);
  await run(EVENT, 'probe-ev-3', 'PAY-PROBE-B', 1, 'BANK_EVIDENCE_SUBMITTED', 'STONEHASH', '{}', null, T);
  const seq = (r) => (r.error ? said(r) : String(r.rows[0].n));
  line('next event number of "PAY-PROBE-A" (it has one event)', seq(await run(SEQ, 'PAY-PROBE-A')));
  line('next event number of the number 4242424242', seq(await run(SEQ, 4242424242)));
  const seqAfter = await run(SEQ, 'PAY-PROBE-A');
  line('next event number of "PAY-PROBE-A" after the number', seq(seqAfter));
  finding('a settlement accepted under a number as its id', `the row is stored under the text ${asStored ? show(asStored.id) : '?'}; the same INSERT with a text id afterwards: ${said(nextText)}; `
    + `the next event number of a settlement that has one event is then answered ${seq(seqAfter)}`);

  // ── 8. what the adapter-level defence would rely on ──────────────────────────────────────────────────────────
  head('8. numbers handed over as their decimal text (what "bind every value as text" would send)');
  const LIST = 'SELECT * FROM remit_payments WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?';
  const limitNumber = await run(LIST, ORG, 2);
  line('LIMIT ? given the number 2', said(limitNumber));
  const limitText = await run(LIST, ORG, '2');
  line('LIMIT ? given the text "2"', said(limitText));
  const limitFresh = await run(`${LIST} /* probe: first use with text */`, ORG, '2');
  line('LIMIT ? given the text "2", statement never used before', said(limitFresh));
  const seqText = await run(EVENT, 'probe-ev-4', 'PAY-PROBE-A', '1', 'BANK_EVIDENCE_SUBMITTED', 'STONEHASH', '{}', null, T);
  line('an INT column (remit_events.seq) given the text "1"', `${said(seqText)}; stored ${await stored('remit_events', 'seq', 'probe-ev-4')}`);
  const seqBad = await run(EVENT, 'probe-ev-5', 'PAY-PROBE-A', 'two', 'X', 'STONEHASH', '{}', null, T);
  line('an INT column given the text "two"', said(seqBad));
  const IDX = 'SELECT payment_id FROM remit_source_refs WHERE org_id = ? AND sha256 = ? AND idx = ?';
  line('an INT comparison (remit_source_refs.idx) given the text "0"', said(await run(IDX, ORG, 'a'.repeat(64), '0')));
  const textId = await run(`${GET} /* probe: numbers as text */`, '12345');
  const textIdAfter = await run(`${GET} /* probe: numbers as text */`, ABSENT);
  line('WHERE id = ? given the text "12345", then a text id nobody has', `${ids(textId)}; ${ids(textIdAfter)}`);
  finding('a number handed over as its decimal text', `LIMIT ? takes the text "2": ${limitText.error ? `NO — ${limitText.error}` : 'yes'} (on a statement never used before: ${limitFresh.error ? `NO — ${limitFresh.error}` : 'yes'}); `
    + `an INT column takes the text "1": ${seqText.error ? `NO — ${seqText.error}` : 'yes'}; a comparison is not left numeric by it: ${textIdAfter.rows?.length === 0 ? 'yes' : 'NO'}`);
} finally {
  // Everything above was one transaction.
  await conn.rollback().catch(() => {});
  const [[{ n: left }]] = await conn.query("SELECT (SELECT COUNT(*) FROM orgs WHERE id LIKE 'probe-typing-%') + (SELECT COUNT(*) FROM remit_payments WHERE id LIKE '%PROBE%' OR id = '4242424242') + (SELECT COUNT(*) FROM attestations WHERE id LIKE 'probe-att-%') + (SELECT COUNT(*) FROM institutions WHERE id = 'ZZ-PROBE-BANK') AS n");
  console.log(`\nrolled back; rows of the probe left in ${schema}: ${left}`);
  await conn.end();
}

console.log('\n== answers');
for (const [q, a] of findings) console.log(`- ${q}: ${a}`);
