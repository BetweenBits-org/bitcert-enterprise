/**
 * The reserve-proof smoke, as far as it goes without a chain: an exchange
 * end to end against a running service, using nothing but what an exchange
 * is given — the console's routes to set itself up, and the SDK's command
 * line for everything after.
 *
 *   node apps/core-java/tools/smoke-por-java.mjs --base http://127.0.0.1:8790 --work <an empty directory> [--users 2000] [--registry-stand-in]
 *
 * It follows deploy/smoke-por.mjs step for step:
 *
 *   sign up, register a P-256 key, activate Proof of Reserves
 *   → balances exported to CSV → check → build (the tree stays local)
 *   → sign → submit: accepted on the signature, no account opened
 *   → prove one user → verify the proof offline
 *   → the public material: the statement commits to what was anchored, and says "not spot-checked"
 *   → the same statement again with a spot check: the challenge answered from the local tree → VERIFIED
 *
 * and leaves out what that script does with a chain, because this one is for
 * a test server that has neither a wallet nor a node:
 *
 *   - it does not fund a reserve address (deploy/smoke-por.mjs sends a
 *     transaction to the sandbox chain for that), so no reserves are
 *     declared — what a read of the reserve chain comes to is compared in
 *     parity/cases/por.mjs against the stand-in node;
 *   - it does not wait for the anchor to confirm, and does not verify the
 *     anchor bundle: with the workers off the commitment waits as `accepted`,
 *     and the public material carries no bundle yet. That the record exists
 *     and is the statement's commitment is checked instead.
 *
 * One thing the SDK asks for is not a reserve-proof route: before it submits,
 * its client reads the Trust Registry (`GET /v1/remit/meta`, the settlement
 * rail's) to see that the key it holds is the one the platform has on file.
 * A service that does not have the rail's routes yet answers 404 and the SDK
 * stops there — which is what this smoke reports when run as it is. With
 * `--registry-stand-in` the smoke puts a forwarder in front of the service
 * that answers that one request itself, with the exchange's own row as the
 * console's activation answered it, and passes everything else through
 * unchanged; the rest of the path is then the service's own.
 *
 * Its files go to the directory given (never the service's own data
 * directory), and every run signs up an exchange of its own.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { createPublicKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spkiFromPublicKey } from '../../core/src/remit/sign.ts';
import { porSnapshotCommitment } from '../../../packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const BASE = arg('--base');
const STAND_IN = process.argv.includes('--registry-stand-in');
let CORE = BASE;
const WORK = arg('--work');
const USERS = Number(arg('--users') ?? 2000);
if (!BASE || !WORK) { console.error('usage: node smoke-por-java.mjs --base <url> --work <an empty directory> [--users n] [--registry-stand-in]'); process.exit(2); }
mkdirSync(WORK, { recursive: true });
if (readdirSync(WORK).length > 0) { console.error(`refusing: ${WORK} is not empty`); process.exit(1); }
const CLI = path.resolve(HERE, '../../../packages/attest-por/src/cli.ts');
const KEY_FILE = path.join(WORK, 'exchange-key.pem');
const RUN_DIR = path.join(WORK, 'run');
const tag = randomBytes(4).toString('hex').toUpperCase();
const INSTITUTION = `EX-SMOKE-${tag}`;

let forwarder = null;
const fail = (m) => { console.error(`✗ ${m}`); forwarder?.close(); process.exit(1); };
const step = (m) => console.log(`— ${m}`);
const jfetch = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', connection: 'close', ...(opts.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
};
let apiKey = '';
// Not execFileSync: the forwarder, when there is one, runs in this process and has to answer while the SDK waits.
const run = promisify(execFile);
const cli = async (...args) => {
  try { return (await run('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, STONEHASH_API_KEY: apiKey }, maxBuffer: 64 << 20 })).stdout; } catch (e) {
    fail(`the SDK's ${args[0]} stopped: ${String(e.stderr || e.message).trim().split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).slice(-1)[0]}`);
    return '';
  }
};

// ── provision the exchange ─────────────────────────────────────────────────
const email = `ops-${tag.toLowerCase()}@smoke-exchange.example`;
const password = randomBytes(18).toString('base64url');
const signup = await jfetch(`${CORE}/v1/console/signup`, { method: 'POST', body: JSON.stringify({ email, password }) });
if (signup.status !== 201) fail(`exchange signup: ${signup.status} ${JSON.stringify(signup.body)}`);
apiKey = signup.body.api_key_secret;
const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(KEY_FILE, kp.privateKey.export({ format: 'pem', type: 'pkcs8' }));
chmodSync(KEY_FILE, 0o600);
const spki = spkiFromPublicKey(createPublicKey(kp.privateKey));
const login = await jfetch(`${CORE}/v1/console/login`, { method: 'POST', body: JSON.stringify({ email, password }) });
if (login.status !== 200) fail(`login: ${login.status}`);
const cookie = login.headers.get('set-cookie').split(';')[0];
const reg = await jfetch(`${CORE}/v1/console/issuer-keys`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ public_key: spki, label: '거래소 서명키 (P-256)', algorithm: 'ES256' }) });
if (reg.status !== 201 && reg.status !== 200) fail(`issuer key: ${reg.status} ${JSON.stringify(reg.body)}`);
const sub = await jfetch(`${CORE}/v1/console/products`, { method: 'POST', headers: { cookie },
  body: JSON.stringify({ product: 'por', institution: { id: INSTITUTION, name: 'Smoke Exchange (sim)', country: 'KY' }, issuer_key_id: reg.body.id ?? reg.body.key?.id }) });
if (sub.status !== 201) fail(`por subscription: ${sub.status} ${JSON.stringify(sub.body)}`);
step(`exchange provisioned: ${INSTITUTION} → ${sub.body.snapshot_endpoint}`);
if (STAND_IN) {
  // Everything through, but the one read of the Trust Registry that the settlement rail will answer.
  forwarder = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/v1/remit/meta') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ institutions: [{ id: INSTITUTION, role: 'EXCHANGE', name: 'Smoke Exchange (sim)', signing_spki: spki }] }));
        return;
      }
      const pass = {};
      for (const h of ['authorization', 'content-type', 'cookie']) if (req.headers[h]) pass[h] = req.headers[h];
      const answer = await fetch(`${BASE}${req.url}`, { method: req.method, headers: { ...pass, connection: 'close' }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise((resolve) => forwarder.listen(0, '127.0.0.1', resolve));
  CORE = `http://127.0.0.1:${forwarder.address().port}`;
  step(`the SDK is pointed at a forwarder (${CORE}) that answers GET /v1/remit/meta itself and passes the rest to ${BASE}`);
}

// ── SDK: synth + build (everything local) ──────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true });
const liab = path.join(RUN_DIR, 'balances.csv');
await cli('synth', '--users', String(USERS), '--assets', 'BTC,ETH,USDT', '--out', liab, '--seed', String(randomInt(1e9)));
const checked = await cli('check', '--csv', liab, '--assets', 'BTC:8,ETH:18,USDT:6', '--amounts', 'base');
if (!/OK — this file can be built/.test(checked)) fail(`check did not pass:\n${checked}`);
step(`balance file checked: ${checked.split('\n').find((l) => l.includes('accounts'))?.trim()}`);
const built = await cli('build', '--csv', liab, '--amounts', 'base', '--exchange', INSTITUTION, '--name', 'Smoke Exchange (sim)',
  '--asof', new Date().toISOString(), '--assets', 'BTC:8,ETH:18,USDT:6', '--out', RUN_DIR);
step(`SDK build: ${built.split('\n')[0]}`);
const statement = JSON.parse(readFileSync(path.join(RUN_DIR, 'snapshot.json'), 'utf8'));

// ── sign, then hand over: accepted on the signature alone ──────────────────
const auth = { authorization: `Bearer ${apiKey}` };
await cli('sign', '--tree', RUN_DIR, '--key', KEY_FILE);
const submission = JSON.parse(readFileSync(path.join(RUN_DIR, 'submission.json'), 'utf8'));
if (JSON.stringify(submission).includes('user-0')) fail('the file that is sent names an account');
const sent = await cli('submit', '--tree', RUN_DIR, '--core', CORE);
const receipt = JSON.parse(readFileSync(path.join(RUN_DIR, 'receipt.json'), 'utf8'));
if (receipt.status !== 'ACCEPTED' || receipt.spot_check !== false) fail(`submit: ${JSON.stringify(receipt)}\n${sent}`);
const snapshotId = receipt.snapshot_id;
step(`submitted ${snapshotId}: ACCEPTED on the signature — no account opened; anchor ${receipt.anchor} (nothing confirms on a server with no worker)`);

// ── a user verifies, offline ───────────────────────────────────────────────
const userRef = `user-${String(randomInt(USERS) + 1).padStart(7, '0')}`;
const proofFile = path.join(RUN_DIR, 'proof.json');
await cli('prove', '--tree', RUN_DIR, '--user-ref', userRef, '--out', proofFile);
const verdict = await cli('verify-proof', '--proof', proofFile, '--snapshot', path.join(RUN_DIR, 'snapshot.json'));
if (!/root\+totals {2}MATCH/.test(verdict)) fail(`user proof failed:\n${verdict}`);
if (!/matches user_ref_hash/.test(verdict)) fail('user_ref binding failed');
step(`user ${userRef} verified their inclusion offline (root+totals MATCH)`);

// ── the status, and the public material ────────────────────────────────────
const view = await jfetch(`${CORE}/v1/por/snapshots/${snapshotId}`, { headers: auth });
if (view.status !== 200 || view.body.status !== 'ACCEPTED' || view.body.spot_check !== false || view.body.commitment !== porSnapshotCommitment(statement)
  || view.body.attestation?.status !== 'accepted') fail(`the snapshot read back: ${JSON.stringify(view.body)}`);
const record = await jfetch(`${CORE}/v1/attestations/${view.body.attestation.id}`, { headers: auth });
if (record.status !== 200 || record.body.leaf_bytes !== view.body.commitment) fail(`the record the commitment became: ${record.status} ${JSON.stringify(record.body).slice(0, 200)}`);
const publicMaterial = async (id) => {
  const pub = await jfetch(`${CORE}/v1/public/por/snapshots/${id}`);
  if (pub.status !== 200) fail(`public endpoint: ${pub.status}`);
  const commit = porSnapshotCommitment(pub.body.statement);
  if (commit !== pub.body.commitment) fail('public commitment mismatch');
  if (JSON.stringify(pub.body.statement) !== JSON.stringify(statement)) fail('the public statement is not the one that was signed');
  if (pub.body.exchange_key?.spki !== spki) fail('the public material does not name the key that signed');
  if (pub.body.attestation?.bundle !== null) fail('a bundle on a server that anchors nothing');
  return pub.body;
};
const plain = await publicMaterial(snapshotId);
// The platform must not claim a sample it did not take.
if (plain.spot_check !== false || plain.verified_sampling?.sampled !== 0 || (plain.platform_checks ?? []).includes('spot_check')) {
  fail(`public material overstates what was checked: ${JSON.stringify({ spot_check: plain.spot_check, verified_sampling: plain.verified_sampling, platform_checks: plain.platform_checks })}`);
}
step('public material: the statement as signed, its commitment, the key that signed; says "not spot-checked"; no bundle yet (not anchored here)');

// ── the optional spot check, same statement ────────────────────────────────
await cli('submit', '--tree', RUN_DIR, '--core', CORE, '--spot-check');
const spot = JSON.parse(readFileSync(path.join(RUN_DIR, 'receipt.json'), 'utf8'));
if (spot.status !== 'VERIFIED' || spot.spot_check !== true || spot.sampled_accounts < 1) fail(`spot check: ${JSON.stringify(spot)}`);
const openings = JSON.parse(readFileSync(path.join(RUN_DIR, 'openings.json'), 'utf8')).openings;
if (openings.some((o) => o.leaf.user_ref !== undefined)) fail('an opening carried an account reference');
const sampled = await publicMaterial(spot.snapshot_id);
if (sampled.spot_check !== true || sampled.verified_sampling?.sampled !== spot.sampled_accounts || !(sampled.platform_checks ?? []).includes('spot_check')) {
  fail(`public material for the spot-checked snapshot: ${JSON.stringify(sampled.verified_sampling)}`);
}
// One statement, two snapshots, one record.
const second = await jfetch(`${CORE}/v1/por/snapshots/${spot.snapshot_id}`, { headers: auth });
if (second.body.attestation?.id !== view.body.attestation.id) fail('the two snapshots of one statement do not share its record');
step(`spot check passed (${spot.sampled_accounts} accounts opened) → VERIFIED ${spot.snapshot_id}; public material says so; one record for both`);

forwarder?.close();
console.log(`\n✓ reserve-proof smoke passed against ${BASE}${STAND_IN ? ' (the Trust Registry read answered by the stand-in)' : ''}: ${snapshotId}`);
console.log(`  leaves ${statement.tree.leaf_count} · root ${statement.tree.root.slice(0, 20)}… · skipped: the reserve address on the sandbox chain, the wait for the anchor, the bundle`);
