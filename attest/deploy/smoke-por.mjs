/**
 * PoR mode-C smoke — plays the exchange end-to-end against a running core,
 * using nothing but what an exchange is given: the SDK's command line.
 *
 *   provision (account + EXCHANGE key + por subscription)
 *   → export 10k synthetic balances to CSV → check → build (tree stays local)
 *   → sign → submit: accepted on the signature, no account opened → anchored
 *   → prove one user → offline verify-proof
 *   → fetch the public material and re-verify commitment + anchor bundle
 *   → submit the same statement again with a spot check: challenge answered
 *     from the local tree → VERIFIED, and the public material says so.
 *
 * What never crosses the wire: the balance file, the leaves, the seed. On the
 * default path no leaf at all; on the spot-check path only the 8 openings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spkiFromPublicKey } from '../apps/core/src/remit/sign.ts';
import { porSnapshotCommitment, verifyBundle } from '../packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const DATA = path.resolve(HERE, '../apps/core/.data');
const STATE_FILE = path.join(DATA, 'por-exchange.json');
const KEY_FILE = path.join(DATA, 'por-exchange-key.pem');
const RUN_DIR = path.join(DATA, 'por-run');
const CLI = path.resolve(HERE, '../packages/attest-por/src/cli.ts');
const USERS = Number(process.env.POR_SMOKE_USERS ?? 10_000);
const INSTITUTION = 'EX-DEMO-001';

const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const step = (m) => console.log(`— ${m}`);
const jfetch = async (url, opts = {}) => {
  // connection: close — the SDK steps between two calls outlast the server's keep-alive.
  const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', connection: 'close', ...(opts.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
};
const cli = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, STONEHASH_API_KEY: state?.apiKey ?? '' } });

// ── provision the exchange (idempotent) ────────────────────────────────────
mkdirSync(DATA, { recursive: true });
let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
if (!state) {
  const email = 'ops@demo-exchange.example';
  const password = randomBytes(18).toString('base64url');
  const signup = await jfetch(`${CORE}/v1/console/signup`, {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  if (signup.status !== 201) fail(`exchange signup: ${signup.status} ${JSON.stringify(signup.body)}`);
  state = { email, password, apiKey: signup.body.api_key_secret };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  chmodSync(STATE_FILE, 0o600);
}
if (!existsSync(KEY_FILE)) {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(KEY_FILE, kp.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  chmodSync(KEY_FILE, 0o600);
}
const exchangeKey = createPrivateKey(readFileSync(KEY_FILE, 'utf8'));
const spki = spkiFromPublicKey(createPublicKey(exchangeKey));

const login = await jfetch(`${CORE}/v1/console/login`, {
  method: 'POST', body: JSON.stringify({ email: state.email, password: state.password }),
});
if (login.status !== 200) fail(`login: ${login.status}`);
const cookie = login.headers.get('set-cookie').split(';')[0];

const keysRes = await jfetch(`${CORE}/v1/console/issuer-keys`, { headers: { cookie } });
const list = keysRes.body.data ?? keysRes.body.keys ?? keysRes.body;
let issuerKey = (Array.isArray(list) ? list : []).find((k) => k.public_key === spki);
if (!issuerKey) {
  const reg = await jfetch(`${CORE}/v1/console/issuer-keys`, {
    method: 'POST', headers: { cookie },
    body: JSON.stringify({ public_key: spki, label: '거래소 서명키 (P-256)', algorithm: 'ES256' }),
  });
  if (reg.status !== 201 && reg.status !== 200) fail(`issuer key: ${reg.status} ${JSON.stringify(reg.body)}`);
  issuerKey = { id: reg.body.id ?? reg.body.key?.id };
}
const sub = await jfetch(`${CORE}/v1/console/products`, {
  method: 'POST', headers: { cookie },
  body: JSON.stringify({
    product: 'por',
    institution: { id: INSTITUTION, name: 'Demo Exchange (sim)', country: 'KY' },
    issuer_key_id: issuerKey.id,
  }),
});
if (sub.status !== 201) fail(`por subscription: ${sub.status} ${JSON.stringify(sub.body)}`);
step(`exchange provisioned: ${INSTITUTION} → ${sub.body.snapshot_endpoint}`);

// ── SDK: synth + build (everything local) ──────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true });
const liab = path.join(RUN_DIR, 'balances.csv');
cli('synth', '--users', String(USERS), '--assets', 'BTC,ETH,USDT', '--out', liab, '--seed', String(randomInt(1e9)));
const checked = cli('check', '--csv', liab, '--assets', 'BTC:8,ETH:18,USDT:6', '--amounts', 'base');
if (!/OK — this file can be built/.test(checked)) fail(`check did not pass:\n${checked}`);
step(`balance file checked: ${checked.split('\n').find((l) => l.includes('accounts'))?.trim()}`);
const asof = new Date().toISOString();

// Declared reserves: an address on the sandbox chain holding mUSDC, standing
// in for the exchange's USDT treasury. The platform will MEASURE it; BTC/ETH
// entries stay declared-only (no reachable chain here) — both paths shown.
const ANVIL = process.env.ANVIL_URL ?? 'http://127.0.0.1:8545';
const rpc = async (method, params = []) => {
  const r = await (await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
let reservesArg = [];
try {
  const accounts = await rpc('eth_accounts');
  const reserveAddr = accounts[2];
  const partnersState = await (await fetch('http://127.0.0.1:3300/wallet/state')).json();
  const usdcContract = partnersState.chain?.usdc;
  if (usdcContract) {
    writeFileSync(path.join(RUN_DIR, 'reserves.json'), JSON.stringify([
      { chain: 'eip155:31337', asset: 'USDT', address: reserveAddr, token_contract: usdcContract },
      { chain: 'bip122:000000000019d6689c085ae165831e93', asset: 'BTC', address: 'bc1q-demo-cold-storage' },
    ], null, 2));
    reservesArg = ['--reserves', path.join(RUN_DIR, 'reserves.json')];
    state.reserve = { address: reserveAddr, token: usdcContract, deployer: accounts[0] };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
} catch (e) {
  step(`reserves declaration skipped (${e.message}) — liability-only snapshot`);
}

const built = cli('build', '--csv', liab, '--amounts', 'base',
  '--exchange', INSTITUTION, '--name', 'Demo Exchange (sim)',
  '--asof', asof, '--assets', 'BTC:8,ETH:18,USDT:6', '--out', RUN_DIR, ...reservesArg);
step(`SDK build: ${built.split('\n')[0]}`);
const statement = JSON.parse(readFileSync(path.join(RUN_DIR, 'snapshot.json'), 'utf8'));

// Fund the reserve address to ~110% of the USDT liabilities so the measured
// coverage lands above water. The deployer still holds the mock supply.
if (state.reserve) {
  const needUnits = (BigInt(statement.totals.USDT ?? '0') * 110n) / 100n;
  const bal = BigInt(await rpc('eth_call', [{ to: state.reserve.token,
    data: '0x70a08231' + state.reserve.address.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
  if (bal < needUnits) {
    const delta = needUnits - bal;
    await rpc('eth_sendTransaction', [{ from: state.reserve.deployer, to: state.reserve.token, gas: '0x30d40',
      data: '0xa9059cbb' + state.reserve.address.slice(2).toLowerCase().padStart(64, '0') + delta.toString(16).padStart(64, '0') }]);
  }
  step(`reserve address funded to ≥110% of USDT liabilities (${state.reserve.address.slice(0, 10)}…)`);
}

// ── sign, then hand over: accepted on the signature alone ──────────────────
const auth = { authorization: `Bearer ${state.apiKey}` };
cli('sign', '--tree', RUN_DIR, '--key', KEY_FILE);
const submission = JSON.parse(readFileSync(path.join(RUN_DIR, 'submission.json'), 'utf8'));
if (JSON.stringify(submission).includes('user-0')) fail('the file that is sent names an account');
const sent = cli('submit', '--tree', RUN_DIR, '--core', CORE, '--wait');
const receipt = JSON.parse(readFileSync(path.join(RUN_DIR, 'receipt.json'), 'utf8'));
if (receipt.status !== 'ACCEPTED' || receipt.spot_check !== false || receipt.anchor !== 'confirmed') {
  fail(`submit: ${JSON.stringify(receipt)}\n${sent}`);
}
const snapshotId = receipt.snapshot_id;
step(`submitted ${snapshotId}: ACCEPTED on the signature — no account opened; anchor confirmed`);

// ── a user verifies, offline ───────────────────────────────────────────────
const userRef = `user-${String(randomInt(USERS) + 1).padStart(7, '0')}`;
const proofFile = path.join(RUN_DIR, 'proof.json');
cli('prove', '--tree', RUN_DIR, '--user-ref', userRef, '--out', proofFile);
const verdict = cli('verify-proof', '--proof', proofFile, '--snapshot', path.join(RUN_DIR, 'snapshot.json'));
if (!/root\+totals {2}MATCH/.test(verdict)) fail(`user proof failed:\n${verdict}`);
if (!/matches user_ref_hash/.test(verdict)) fail('user_ref binding failed');
step(`user ${userRef} verified their inclusion offline (root+totals MATCH)`);

// ── public material re-verification ────────────────────────────────────────
// solvency report must show a measured USDT line when reserves were declared
if (state.reserve) {
  const view = await jfetch(`${CORE}/v1/por/snapshots/${snapshotId}`, { headers: auth });
  const line = (view.body.reserves?.solvency ?? []).find((l) => l.asset === 'USDT');
  if (!line || line.status !== 'MEASURED') fail(`USDT reserves not measured: ${JSON.stringify(view.body.reserves ?? null)}`);
  step(`reserves measured on chain: USDT coverage ${line.coverage}`);
}

const publicMaterial = async (id) => {
  const pub = await jfetch(`${CORE}/v1/public/por/snapshots/${id}`);
  if (pub.status !== 200) fail(`public endpoint: ${pub.status}`);
  const commit = porSnapshotCommitment(pub.body.statement);
  if (commit !== pub.body.commitment) fail('public commitment mismatch');
  const bundle = pub.body.attestation?.bundle;
  if (!bundle) fail('public bundle missing');
  if (bundle.record?.leaf_bytes !== commit) fail('anchored leaf ≠ statement commitment');
  const rep = await verifyBundle(bundle, {});
  if (rep.verified !== true) fail(`bundle verification failed: ${JSON.stringify(rep.checks)}`);
  return { body: pub.body, checks: rep.checks.length };
};
const plain = await publicMaterial(snapshotId);
// The platform must not claim a sample it did not take.
if (plain.body.spot_check !== false || plain.body.verified_sampling?.sampled !== 0
  || (plain.body.platform_checks ?? []).includes('spot_check')) {
  fail(`public material overstates what was checked: ${JSON.stringify({ spot_check: plain.body.spot_check, verified_sampling: plain.body.verified_sampling, platform_checks: plain.body.platform_checks })}`);
}
step(`public material verified: commitment + anchor bundle (${plain.checks} checks); says "not spot-checked"`);

// ── the optional spot check, same statement ────────────────────────────────
cli('submit', '--tree', RUN_DIR, '--core', CORE, '--spot-check', '--wait');
const spot = JSON.parse(readFileSync(path.join(RUN_DIR, 'receipt.json'), 'utf8'));
if (spot.status !== 'VERIFIED' || spot.spot_check !== true || spot.sampled_accounts < 1) fail(`spot check: ${JSON.stringify(spot)}`);
const openings = JSON.parse(readFileSync(path.join(RUN_DIR, 'openings.json'), 'utf8')).openings;
if (openings.some((o) => o.leaf.user_ref !== undefined)) fail('an opening carried an account reference');
const sampled = await publicMaterial(spot.snapshot_id);
if (sampled.body.spot_check !== true || sampled.body.verified_sampling?.sampled !== spot.sampled_accounts
  || !(sampled.body.platform_checks ?? []).includes('spot_check')) {
  fail(`public material for the spot-checked snapshot: ${JSON.stringify(sampled.body.verified_sampling)}`);
}
step(`spot check passed (${spot.sampled_accounts} accounts opened) → VERIFIED ${spot.snapshot_id}; public material says so`);

console.log(`\n✓ PoR smoke passed: ${snapshotId}`);
console.log(`  leaves ${statement.tree.leaf_count} · root ${statement.tree.root.slice(0, 20)}…`);
console.log(`  totals ${JSON.stringify(statement.totals)}`);
console.log(`  검증 페이지: ${CORE}/playground/por.html (snapshot id: ${snapshotId})`);
