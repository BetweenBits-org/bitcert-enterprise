/**
 * What the reference's store answers once an id that is not text has been looked up on a connection.
 *
 *   node apps/core-java/tools/probe-reference-id-binding.mjs [<reference env file>]      (default: apps/core-java/.env.ref)
 *
 * Read-only, on a `stonehash_test_` schema that has settlements in it (seed it first: tools/seed-reference.mjs),
 * through the reference's own `openDb` and `RemitStore.get` — the lookup `POST /v1/settlements` makes with the
 * `payment_id` of the request, whatever JSON value that is (its pattern check coerces a number or `true` to text
 * and lets it through; `apps/core/src/remit/routes.ts`, `orchestrator.ts` acceptSettlement).
 *
 * The reference's MySQL adapter runs server-side prepared statements (`conn.execute`). Once such a statement has
 * been executed with a number (or a boolean) where the id goes, the server keeps comparing that statement's
 * parameter as a number on that connection: every later lookup of a text id is `id = 0`, which is true of every id
 * that does not start with a digit. So after ONE request with `"payment_id": 12345` the connection answers
 * "a settlement of that id exists" — some other organisation's row — for ids that do not exist, until the process
 * is restarted. Seen on 2026-11-19: `text → nothing; 12345 → nothing; true → nothing; text → a row`.
 *
 * The Java service refuses an id that is not text before any statement runs (docs/JAVA-INTENDED-DIFFERENCES.md
 * D-18), which is why the response comparison does not send such ids: they would spoil the reference's answers to
 * everything after them.
 *
 * Exit status 0 when the effect is observed, 1 when it is not (the reference or its driver was changed), 2 when
 * the schema has no settlement to be mistaken for another.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { problems, readEnvFile } from './check-test-env.mjs';
import { openDb } from '../../core/src/db.ts';
import { RemitStore } from '../../core/src/remit/store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(process.argv[2] ?? path.resolve(HERE, '../.env.ref'));
const env = readEnvFile(envFile);
const unsafe = problems(env);
if (unsafe.length) { for (const p of unsafe) console.error(`${path.basename(envFile)}: ${p}`); process.exit(1); }
const schema = new URL(env.STONEHASH_DB_URL).pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) { console.error(`refusing: ${schema} is not a stonehash_test_ schema`); process.exit(1); }

const db = await openDb(env.STONEHASH_DB_URL);
let seen = [];
try {
  const store = new RemitStore(db);
  const any = await db.prepare('SELECT COUNT(*) AS n FROM remit_payments').get();
  if (Number(any.n) === 0) { console.log(`${schema} has no settlement: nothing could be mistaken for another`); process.exitCode = 2; }
  else {
    const ask = async (label, id) => { const row = await store.get(id); seen.push(Boolean(row)); console.log(`${label.padEnd(44)} → ${row ? `a settlement (${row.state}) that has another id` : 'nothing'}`); };
    const absent = 'PAY-NO-SETTLEMENT-HAS-THIS-ID';
    await ask(`${JSON.stringify(absent)}`, absent);
    await ask('a list of that text', [absent]);
    await ask('the text again', absent);
    await ask('the number 12345', 12345);
    await ask('true', true);
    await ask('the text once more', absent);
    const spoiled = seen[0] === false && seen[2] === false && seen[5] === true;
    console.log(spoiled
      ? 'after an id that was a number, the same connection finds a settlement under a text id that no settlement has'
      : 'not observed: a text id that no settlement has was answered "nothing" after the number as before it');
    if (process.exitCode === undefined) process.exitCode = spoiled ? 0 : 1;
  }
} finally {
  await db.close();
}
