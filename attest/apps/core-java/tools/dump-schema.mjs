/**
 * Reads the structure of a schema — and nothing else — into a JSON file:
 * every table's CREATE statement and the catalogue rows that describe its
 * columns, indexes, foreign keys and checks.
 *
 *   node apps/core-java/tools/dump-schema.mjs <env file> <out.json> [schema]
 *
 * The connection is the one `STONEHASH_DB_URL` of the env file names; with a
 * third argument another schema on the same server is read. It only reads
 * (SHOW CREATE TABLE, information_schema). It prints no credential.
 *
 * Used twice: on the live schema, to write the baseline migration from
 * (tools/make-baseline.mjs), and on a schema the migrations built, to show
 * that the two are the same (tools/compare-schema.mjs).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [envFile, outFile, schemaOverride] = process.argv.slice(2);
if (!envFile || !outFile) {
  console.error('usage: node dump-schema.mjs <env file> <out.json> [schema]');
  process.exit(2);
}
// The MySQL driver is the reference service's own dependency.
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const u = new URL(env.STONEHASH_DB_URL);
const database = schemaOverride || u.pathname.replace(/^\//, '');
const conn = await mysql.createConnection({
  host: u.hostname, port: u.port ? Number(u.port) : 3306,
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database, charset: 'utf8mb4_bin',
});
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const server = Object.fromEntries((await q(
  "SHOW VARIABLES WHERE Variable_name IN ('version','transaction_isolation','character_set_server','collation_server','lower_case_table_names')",
)).map((r) => [r.Variable_name, r.Value]));
const schema = (await q('SELECT default_character_set_name AS cs, default_collation_name AS co FROM information_schema.schemata WHERE schema_name = ?', [database]))[0];
const tables = await q("SELECT table_name AS t, engine AS e, table_collation AS c FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [database]);
const creates = [];
for (const { t } of tables) creates.push({ table: t, ddl: (await q(`SHOW CREATE TABLE \`${t}\``))[0]['Create Table'] });
const columns = await q(
  `SELECT table_name AS t, column_name AS c, ordinal_position AS pos, column_default AS dflt, is_nullable AS nullable, column_type AS type,
          character_set_name AS cs, collation_name AS co, column_key AS k, extra AS extra
     FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, [database]);
const statistics = await q(
  `SELECT table_name AS t, index_name AS i, non_unique AS nu, seq_in_index AS seq, column_name AS c, sub_part AS sub, collation AS dir, index_type AS type
     FROM information_schema.statistics WHERE table_schema = ? ORDER BY table_name, index_name, seq_in_index`, [database]);
const fks = await q(
  `SELECT k.table_name AS t, k.constraint_name AS n, k.ordinal_position AS pos, k.column_name AS c, k.referenced_table_name AS rt, k.referenced_column_name AS rc,
          r.update_rule AS on_update, r.delete_rule AS on_delete
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
    WHERE k.table_schema = ? AND k.referenced_table_name IS NOT NULL ORDER BY k.table_name, k.constraint_name, k.ordinal_position`, [database]);
const checks = await q(
  `SELECT t.table_name AS t, c.constraint_name AS n, c.check_clause AS clause, t.enforced AS enforced
     FROM information_schema.check_constraints c
     JOIN information_schema.table_constraints t ON t.constraint_schema = c.constraint_schema AND t.constraint_name = c.constraint_name
    WHERE c.constraint_schema = ? AND t.constraint_type = 'CHECK' ORDER BY t.table_name, c.constraint_name`, [database]);
await conn.end();
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ database, server, schema, tables, creates, columns, statistics, fks, checks }, null, 1)}\n`);
console.log(`${database}: ${tables.length} tables, ${columns.length} columns, ${statistics.length} index rows, ${fks.length} foreign-key rows, ${checks.length} checks → ${outFile}`);
