// Read-only: is the live core about to anchor anything? (counts only)
import { createRequire } from 'node:module';
import { env } from './btc-rpc.mjs';
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
export async function pending() {
  const u = new URL(env().STONEHASH_DB_URL);
  const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') });
  const [a] = await conn.query("SELECT status, COUNT(*) AS n FROM attestations GROUP BY status ORDER BY status");
  const [b] = await conn.query("SELECT status, COUNT(*) AS n FROM batches GROUP BY status ORDER BY status");
  const [t] = await conn.query("SELECT status, COUNT(*) AS n FROM anchor_txs GROUP BY status ORDER BY status");
  await conn.end();
  const obj = (rows) => Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { attestations: obj(a), batches: obj(b), anchor_txs: obj(t) };
}
if (process.argv[1].endsWith('live-pending.mjs')) console.log(JSON.stringify(await pending()));
