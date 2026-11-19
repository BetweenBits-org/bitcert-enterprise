/**
 * Are the settlement rail's seeded rows what they are meant to be — the same
 * in both schemas but for the one thing that is meant to differ, and sound in
 * themselves?
 *
 *   node apps/core-java/tools/check-remit-seed.mjs <reference env file> <second env file> [--seed <seed file>]
 *
 * Read-only, on stonehash_test_ schemas, right after a seed (before a server
 * has written anything). It checks:
 *
 *   the same rows      every table, row for row, column for column — except `subscriptions.config` and
 *                      `remit_webhook_deliveries.url`, which have to be equal once each schema's own
 *                      `<REMIT_PARTNERS_BASE>/hooks/` is read as "its own stand-in", and have to start with it
 *   the ledgers        event numbers 0, 1, 2 … without a gap; every signature of every event verifies with the key
 *                      the registry holds for its signer (the platform's, a bank's, a partner's); no party data left
 *                      in `request_body` once the travel rule went out
 *   the packages       the stored commitment is the reference's `packageCommitment` of the stored package and nonce,
 *                      and is the leaf of the anchor record the settlement points at
 *   the webhooks       every stored body is `{ envelope, signature }` and the signature verifies with the platform key
 *   the partner        what the seed file says the partner remembers (`remit.partner.ledger`) names seeded settlements
 *   nothing to do      no settlement made from a message is without its source reference row (the reference would
 *                      give it one when it starts, in its own schema only)
 *
 * Prints counts and what is wrong — never a key or a signature. Exit status 1 when something is wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyEvent } from '../../core/src/remit/sign.ts';
import { packageCommitment } from '../../core/src/remit/evidence.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const seedFile = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : path.resolve(HERE, '../parity/seed.json');
const [refEnvFile, devEnvFile] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--seed');
if (!refEnvFile || !devEnvFile) { console.error('usage: node check-remit-seed.mjs <reference env file> <second env file> [--seed <seed file>]'); process.exit(2); }
const readEnv = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.indexOf('=') > 0).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const [refEnv, devEnv] = [readEnv(refEnvFile), readEnv(devEnvFile)];
const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
const [REF, DEV] = [schemaOf(refEnv.STONEHASH_DB_URL), schemaOf(devEnv.STONEHASH_DB_URL)];
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(REF) || !TEST.test(DEV) || REF === DEV) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(refEnv.STONEHASH_DB_URL);
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const wrong = [];
const say = (line) => { if (wrong.length < 60) wrong.push(line); else if (wrong.length === 60) wrong.push('… and more'); };
const hooksOf = (env) => `${String(env.REMIT_PARTNERS_BASE ?? '').replace(/\/+$/, '')}/hooks/`;
const OWN = '<its own stand-in>/hooks/';

// ── the same rows ────────────────────────────────────────────────────────────
const tables = (await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [REF])).map((r) => r.t).filter((t) => t !== 'flyway_schema_history');
const OWN_ADDRESS = { subscriptions: 'config', remit_webhook_deliveries: 'url' };
let compared = 0; let ownAddresses = 0;
for (const t of tables) {
  const cols = (await q('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [REF, t])).map((r) => r.c);
  const keyCols = (await q("SELECT column_name AS c FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position", [REF, t])).map((r) => r.c);
  const by = (keyCols.length > 0 ? keyCols : cols).map((c) => `\`${c}\``).join(', ');
  const read = async (schema) => { try { return await q(`SELECT ${cols.map((c) => `\`${c}\``).join(', ')} FROM \`${schema}\`.\`${t}\` ORDER BY ${by}`); } catch (e) { say(`${t}: cannot be read in ${schema} (${e.code ?? e.message})`); return null; } };
  const [a, b] = [await read(REF), await read(DEV)];
  if (!a || !b) continue;
  if (a.length !== b.length) { say(`${t}: ${a.length} rows in ${REF}, ${b.length} in ${DEV}`); continue; }
  for (const [i, row] of a.entries()) {
    for (const c of cols) {
      let [x, y] = [row[c], b[i][c]];
      if (Buffer.isBuffer(x)) x = x.toString('hex');
      if (Buffer.isBuffer(y)) y = y.toString('hex');
      if (OWN_ADDRESS[t] === c && typeof x === 'string' && typeof y === 'string' && (x.includes(hooksOf(refEnv)) || y.includes(hooksOf(devEnv)))) {
        ownAddresses++;
        if (t === 'remit_webhook_deliveries' && (!x.startsWith(hooksOf(refEnv)) || !y.startsWith(hooksOf(devEnv)))) say(`${t} ${row.id}: the address is not that schema's own stand-in`);
        x = x.split(hooksOf(refEnv)).join(OWN); y = y.split(hooksOf(devEnv)).join(OWN);
      }
      if (String(x) !== String(y)) { say(`${t} row ${i} (${keyCols.map((k) => row[k]).join(' / ').slice(0, 80)}): column ${c} differs`); break; }
    }
    compared++;
  }
}

// ── the ledgers (read in the reference schema; the rows are the same in the other) ──
const institutions = new Map((await q(`SELECT id, role, signing_spki FROM \`${REF}\`.institutions`)).map((r) => [r.id, r]));
const platform = institutions.get('STONEHASH');
if (!platform?.signing_spki) say('the platform\'s own institution row is not seeded');
const events = await q(`SELECT payment_id, seq, type, issuer, payload, sig FROM \`${REF}\`.remit_events ORDER BY payment_id, seq`);
const payments = new Map((await q(`SELECT id, org_id, state, request_body, package_json, commitment, nonce, attestation_id FROM \`${REF}\`.remit_payments`)).map((r) => [r.id, r]));
const seqOf = new Map(); const sent = new Set(); let verified = 0; let unsigned = 0; const madeUp = new Set();
for (const e of events) {
  const expected = seqOf.get(e.payment_id) ?? 0;
  if (e.seq !== expected) say(`${e.payment_id}: event number ${e.seq} where ${expected} was due`);
  seqOf.set(e.payment_id, e.seq + 1);
  if (e.type === 'TRAVEL_RULE_SENT') sent.add(e.payment_id);
  if (e.sig === null) { unsigned++; continue; }
  let payload; let sig;
  try { payload = JSON.parse(e.payload); sig = JSON.parse(e.sig); } catch { madeUp.add(e.payment_id); continue; } // the console's skeletal rows
  if (!sig || typeof sig.key_id !== 'string') { madeUp.add(e.payment_id); continue; }
  // The platform signs as itself under its key id; everybody else's key id is its institution id.
  const signer = sig.issuer === 'STONEHASH' ? platform : institutions.get(sig.key_id);
  // Two events carry a signature over something other than their whole payload: the instruction inside
  // SETTLEMENT_INSTRUCTED has the platform's own, and a cancellation keeps the bank's over { payment_id, reason }.
  const proper = e.type === 'SETTLEMENT_INSTRUCTED' ? verifyEvent((({ signature, ...rest }) => rest)(payload), payload.signature, platform.signing_spki) && verifyEvent(payload, sig, platform.signing_spki)
    : e.type === 'CANCEL_REQUESTED' ? signer?.signing_spki && verifyEvent({ payment_id: payload.payment_id, reason: payload.reason }, sig, signer.signing_spki)
      : signer?.signing_spki && verifyEvent(payload, sig, signer.signing_spki);
  if (proper) verified++;
  else if (e.type === 'PAYOUT_ACCEPTED' && sig.key_id === 'SG-BFI-UNREGISTERED') say(`${e.payment_id}: an approval by an unregistered key was recorded`);
  else say(`${e.payment_id} #${e.seq} ${e.type}: the signature by ${sig.key_id} does not verify with the registered key`);
}
let plaintextLeft = 0; let packages = 0;
const leaves = new Map((await q(`SELECT id, leaf_bytes, product FROM \`${REF}\`.attestations`)).map((r) => [r.id, r]));
for (const p of payments.values()) {
  if (sent.has(p.id) && p.request_body.includes('compliance_plaintext')) { plaintextLeft++; say(`${p.id}: party data is still in request_body after the travel rule went out`); }
  if (p.package_json === null) continue;
  packages++;
  if (packageCommitment(JSON.parse(p.package_json), p.nonce) !== p.commitment) say(`${p.id}: the stored commitment is not that of the stored package and nonce`);
  const record = leaves.get(p.attestation_id);
  if (record && (record.leaf_bytes !== p.commitment || record.product !== 'remit')) say(`${p.id}: its anchor record is not the commitment's (or not the rail's)`);
}
const deliveries = await q(`SELECT id, payment_id, body FROM \`${REF}\`.remit_webhook_deliveries`);
let webhooks = 0; let skeletal = 0;
for (const d of deliveries) {
  let body; try { body = JSON.parse(d.body); } catch { body = null; }
  if (!body?.envelope || !body.signature) { if (d.body === '{}') { skeletal++; continue; } say(`webhook ${d.id}: the stored body is not { envelope, signature }`); continue; }
  if (!verifyEvent(body.envelope, body.signature, platform.signing_spki)) say(`webhook ${d.id}: the signature does not verify with the platform key`); else webhooks++;
}
const unplaced = (await q(`SELECT COUNT(*) AS n FROM \`${REF}\`.remit_payments p JOIN \`${REF}\`.remit_events e ON e.payment_id = p.id AND e.type = 'BANK_EVIDENCE_SUBMITTED'
  WHERE e.payload LIKE '%"sourceMessage"%' AND NOT EXISTS (SELECT 1 FROM \`${REF}\`.remit_source_refs r WHERE r.payment_id = p.id)`))[0].n;
if (Number(unplaced) !== 0) say(`${unplaced} settlements made from a message have no source reference row`);

// ── the partner's memory, as the seed file states it ─────────────────────────
let remembered = 0;
if (fs.existsSync(seedFile)) {
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')).remit;
  if (!seed || seed.skipped) say(`${path.basename(seedFile)} holds no rail seed`);
  else {
    for (const id of Object.keys(seed.partner.ledger)) { remembered++; if (!payments.has(id)) say(`the partner remembers ${id}, which is no seeded settlement`); }
    for (const [org, list] of Object.entries(seed.settlements)) for (const [name, s] of Object.entries(list)) {
      const p = payments.get(s.id);
      if (!p) say(`${org}/${name}: ${s.id} is not in the schema`); else if (p.state !== s.state) say(`${org}/${name}: the seed file says ${s.state}, the row says ${p.state}`);
    }
  }
} else say(`no seed file at ${seedFile}`);
await conn.end();

for (const w of wrong) console.log(`WRONG ${w}`);
console.log(`${tables.length} tables, ${compared} rows the same in ${REF} and ${DEV} (${ownAddresses} webhook addresses read as each schema's own stand-in)`);
console.log(`${events.length} events: ${verified} signatures verified with the registered keys, ${unsigned} unsigned, ${madeUp.size} settlements with made-up events (the console's); ${packages} packages recomputed; ${webhooks} webhook bodies verified${skeletal ? `, ${skeletal} skeletal` : ''}; ${plaintextLeft} with party data left; the partner remembers ${remembered} payments`);
console.log(wrong.length === 0 ? 'the rail\'s seed is sound' : `${wrong.length} thing(s) wrong`);
process.exit(wrong.length === 0 ? 0 : 1);
