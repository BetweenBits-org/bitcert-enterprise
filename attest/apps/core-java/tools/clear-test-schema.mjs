/**
 * Empties the data tables of the test schema an env file names — if and only
 * if its name starts with stonehash_test_. The table the migrations keep
 * their own record in is left alone.
 *
 *   node apps/core-java/tools/clear-test-schema.mjs <env file>
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const envFile = process.argv[2];
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const u = new URL(env.STONEHASH_DB_URL);
const database = u.pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(database)) { console.error(`refusing: ${database} is not a stonehash_test_ schema`); process.exit(1); }
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
const [tables] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name <> 'flyway_schema_history'", [database]);
await conn.query('SET FOREIGN_KEY_CHECKS = 0');
for (const { t } of tables) await conn.query(`TRUNCATE TABLE \`${database}\`.\`${t}\``);
await conn.query('SET FOREIGN_KEY_CHECKS = 1');
await conn.end();
console.log(`${database}: ${tables.length} tables emptied`);
