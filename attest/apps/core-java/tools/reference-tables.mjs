/**
 * Gives a test schema the reference's own tables when it has none.
 *
 *   node apps/core-java/tools/reference-tables.mjs <env file>…
 *
 * The seeding tool (tools/seed-reference.mjs) fills its first schema through the reference's code, which makes
 * the tables there, and copies the rows into its second schema — whose tables must already be there. In the
 * comparison pair the second schema is the Java service's and its tables are the migrations'. In a pair of two
 * reference cores (tools/run-remit-reference-pair.sh) nobody has made them when the schema is new, as it is in
 * a fresh working copy: this tool does, by opening the reference's store on the schema once (`openDb` applies
 * the table definitions of apps/core/src/db.ts and writes no row) and closing it.
 *
 * A schema that already has tables is left exactly as it is. A schema whose name does not start with
 * stonehash_test_ is refused. Prints one line per file and nothing of the file itself.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openDb } from '../../core/src/db.ts';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: node reference-tables.mjs <env file>…'); process.exit(2); }
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');

const urlOf = (file) => {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    if (t.slice(0, i).trim() === 'STONEHASH_DB_URL') return t.slice(i + 1).trim();
  }
  return null;
};
const count = async (u, schema) => {
  const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  try {
    const [rows] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [schema]);
    return Number(rows[0].n);
  } finally { await conn.end(); }
};

for (const file of files) {
  const target = urlOf(file);
  if (!target || !target.startsWith('mysql://')) { console.error(`${file}: no MySQL address in STONEHASH_DB_URL`); process.exit(1); }
  const u = new URL(target);
  const schema = u.pathname.replace(/^\//, '');
  if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) { console.error(`refusing: ${schema} is not a stonehash_test_ schema`); process.exit(1); }
  const before = await count(u, schema);
  if (before > 0) { console.log(`${schema}: ${before} tables, left as they are`); continue; }
  const db = await openDb(target);
  await db.close();
  console.log(`${schema}: had no tables, now the reference's ${await count(u, schema)}`);
}
