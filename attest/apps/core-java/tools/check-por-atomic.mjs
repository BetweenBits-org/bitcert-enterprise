/**
 * A commitment is issued and its snapshot row written together, or neither
 * is: what each service leaves behind when the row cannot be written.
 *
 *   node apps/core-java/tools/check-por-atomic.mjs --ref http://127.0.0.1:8791 --java http://127.0.0.1:8790 \
 *        --ref-env apps/core-java/.env.ref --java-env apps/core-java/.env.parity
 *
 * Both servers on freshly seeded test schemas (the seed's exchange and its
 * key are used). One signed statement is sent to each, root only, whose
 * as-of time is a valid instant written with more digits than the column
 * that keeps it holds (51 characters; `por_snapshots.asof` holds 40). Both
 * services take the statement — its shape and its signature are good — and
 * both then fail to store the snapshot (a 500).
 *
 * The Java service has to leave nothing behind: no snapshot, and no record
 * of the commitment waiting to be anchored. The reference issues the record
 * first and writes the row afterwards, so the record stays
 * (docs/JAVA-INTENDED-DIFFERENCES.md, S-17); what it leaves is printed.
 * Not part of parity/run.mjs: after this the two schemas differ on purpose.
 */
import fs from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildPorTree } from '../../../packages/attest-por/src/sumtree.ts';
import { leafFromRow } from '../../../packages/attest-por/src/leaves.ts';
import { buildSnapshotStatement } from '../../../packages/attest-por/src/snapshot.ts';
import { porSnapshotCommitment } from '../../../packages/attest-verify/src/merkle-sum.ts';
import { signEvent } from '../../core/src/remit/sign.ts';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const [REF, JAVA, refEnv, javaEnv] = [arg('--ref'), arg('--java'), arg('--ref-env'), arg('--java-env')];
if (!REF || !JAVA || !refEnv || !javaEnv) { console.error('usage: node check-por-atomic.mjs --ref <url> --java <url> --ref-env <file> --java-env <file>'); process.exit(2); }
const seed = JSON.parse(fs.readFileSync(new URL('../parity/seed.json', import.meta.url), 'utf8')).por;
const EX = seed.institutions.exchange;
const urlOf = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.startsWith('STONEHASH_DB_URL=')).slice('STONEHASH_DB_URL='.length);
const schemaOf = (file) => new URL(urlOf(file)).pathname.replace(/^\//, '');
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(schemaOf(refEnv)) || !TEST.test(schemaOf(javaEnv))) { console.error('refusing: both schemas must be stonehash_test_ schemas'); process.exit(1); }

const inputs = [1, 2, 3].map((i) => leafFromRow(EX, new Uint8Array(32).fill(3), { user_ref: `A-${i}`, balances: { BTC: String(i) } }));
const tree = buildPorTree(inputs, ['BTC']);
const statement = structuredClone(buildSnapshotStatement({ institutionId: EX, name: 'Atomic', asof: `2026-10-01T00:00:00.${'0'.repeat(30)}Z`, assets: [{ symbol: 'BTC', decimals: 8 }] }, tree, new Date()));
const body = JSON.stringify({ statement, sig: signEvent(statement, createPrivateKey(seed.signing.exchange.pem), EX, EX) });
const commitment = porSnapshotCommitment(statement);
const send = async (base) => { const r = await fetch(`${base}/v1/por/snapshots`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${seed.keys.exchange}` }, body }); return { status: r.status, body: await r.json() }; };

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(urlOf(refEnv));
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
const left = async (schema) => ({
  records: (await conn.query(`SELECT COUNT(*) AS n FROM \`${schema}\`.attestations WHERE leaf_bytes = ?`, [commitment]))[0][0].n,
  snapshots: (await conn.query(`SELECT COUNT(*) AS n FROM \`${schema}\`.por_snapshots WHERE commitment = ?`, [commitment]))[0][0].n,
});
const failures = [];
for (const [who, base, env] of [['reference', REF, refEnv], ['java', JAVA, javaEnv]]) {
  const first = await send(base);
  const again = await send(base);
  const after = await left(schemaOf(env));
  console.log(`${who}: an as-of time of ${statement.asof.length} characters → ${first.status} ${first.body.error ?? ''}; sent again → ${again.status}; left behind: ${after.records} record(s) of the commitment, ${after.snapshots} snapshot(s)`);
  if (who === 'java' && !(first.status === 500 && again.status === 500 && after.records === 0 && after.snapshots === 0)) failures.push('the Java service did not fail the request and leave nothing behind');
}
await conn.end();
console.log(failures.length === 0 ? 'the Java service: nothing left behind, as required' : failures.join('; '));
process.exit(failures.length === 0 ? 0 : 1);
