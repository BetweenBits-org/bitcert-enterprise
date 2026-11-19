/**
 * Creates the empty schema an env file names — or, with --drop, removes it —
 * if and only if its name starts with stonehash_test_.
 *
 *   node apps/core-java/tools/create-schema.mjs <env file> [--drop]
 *
 * utf8mb4 / utf8mb4_bin, as the live schema. Nothing else is touched.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [envFile, flag] = process.argv.slice(2);
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
if (flag === '--drop') {
  await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
  console.log(`dropped ${database}`);
} else {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [database]);
  console.log(`${database} is there (${rows[0].n} tables)`);
}
await conn.end();
