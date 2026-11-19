/**
 * The checks of the second demo set — the end-to-end arrangement in which the
 * sandbox's two smoke scripts run against a test core, on copies of the
 * partner simulator and of the bank demo, with nothing live in reach.
 * `tools/run-second-set.sh` calls every mode below; each can be run alone.
 *
 *   node apps/core-java/tools/check-second-set.mjs --set ref|java [--work <work folder>] <mode>
 *
 * (--work, the folder given to run-second-set.sh, is needed by --env, --provisioned and --after: they look at
 * the copies, and a copy is only a copy where it stands.)
 *
 *   --constants core=N chain=N partner=N bank=N env=<file name>
 *                    the caller's own table of the set must be this tool's (the run script states the
 *                    ports once more; the two statements have to agree before anything starts)
 *   --preflight      the set's settings file, beyond check-test-env.mjs: it must name THIS set's port, schema,
 *                    data directory, partner copy and stand-in node, the wallet attest-java, and an admin
 *                    token that is neither the sandbox default nor the live service's
 *   --schema-empty   every data table of the set's schema holds no row
 *   --wallet         what the wallet attest-java holds (a read: listwallets, getbalances, getwalletinfo)
 *   --wallet-free    no other service on this machine is running with a worker on that wallet
 *   --env [--gated] <role>=<pid> …
 *                    reads /proc/<pid>/environ, /proc/<pid>/cmdline and /proc/<pid>/cwd of processes of the
 *                    set and requires the environment to be the set's own: ATTEST_BASE, PORT, CHAIN_BACKEND,
 *                    BANK_PUBLIC_BASE (and the others a role is given) present with the set's values, nothing
 *                    else but PATH/HOME/LANG, and no live address anywhere. Prints names and whether they are
 *                    the set's — never a value. Roles: chain, core, partner-setup, bank-setup, partner, bank,
 *                    smoke-remit, smoke-exceptions (and core-migrate, core-routes: the Java service's two
 *                    commands that end by themselves). With --gated the process must still be waiting at the
 *                    run script's gate (nothing of the program has run yet), and the command it is about to
 *                    run is checked too. A bare <pid> is looked at by what it is running.
 *   --provisioned    both copies were provisioned against this set's core and no other: their own state
 *                    files say so, and the core's registry holds the partner copy's public keys
 *   --partner        the partner copy answers, and says its chain is `mock`
 *   --bank-webhook   the bank copy is subscribed and registered a webhook address on its own port
 *   --after          after the two smoke scripts (E.2 step 8 / E.3 of the verification plan, the part that
 *                    does not need the Java side): the bank copy's own verification route answers
 *                    `verified: true` for its anchored cases; every webhook body stored in the set's schema
 *                    passes the TypeScript SDK's `verifyWebhook` and was addressed to the bank copy; every
 *                    evidence response passes the TypeScript SDK's `verifyEvidencePackage`; the ledger holds
 *                    the seven settlements of the two scripts in their end states; the partner copy's own
 *                    ledger shows no record in an error state
 *   --admin-token-to-pipe
 *                    hands the set's admin token to the run script (for the partner copy's setup.mjs, which
 *                    reads it from its environment). Refuses a terminal: the token is never shown.
 *
 * Nothing here reads a live address: every request goes to 127.0.0.1 on a port of the set, a live port is
 * refused wherever a port is used, the node's address comes from the set's own settings file (never from the
 * live service's), and the only wallet named is attest-java. Settings, state files and keys are read and
 * compared; their values are never printed. Exit status 1 when a check fails, 2 on a usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { problems, readEnvFile } from './check-test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
const ATTEST = path.resolve(HERE, '../../..');
const REPO = path.resolve(ATTEST, '..');

/** Ports something live listens on here (the list of check-test-env.mjs). No step of the second set may name one. */
export const LIVE_PORTS = ['8787', '3100', '3200', '3300', '3400', '3500', '5106', '8545', '18443'];
/** The two sets. One at a time: both anchor from the one wallet, and they share the stand-in node's port. */
export const SETS = {
  ref: { core: 8782, chain: 8783, partner: 3304, bank: 3202, envFile: '.env.e2e-ref', schema: 'stonehash_test_e2e_ref', dataDir: '.data-e2e-ref' },
  java: { core: 8781, chain: 8783, partner: 3303, bank: 3201, envFile: '.env.e2e-java', schema: 'stonehash_test_e2e_java', dataDir: '.data-e2e-java' },
};
export const WALLET = 'attest-java';
export const JAVA17 = '/usr/lib/jvm/java-17-openjdk-amd64/bin/java';
/** What the run script's gate looks like in /proc/<pid>/cmdline: the process waits here until its environment has been read. */
export const GATE_SCRIPT = 'read -r _ < "$1"; shift; exec "$@"';
/** The ids the partner simulator registers, and the bank the demo is. */
const PARTNER_IDS = { bfi: 'SG-BFI-001', sgbank: 'SG-PAYBANK-001', wallet: 'SETTLE-ENTITY-001' };
const BANK_ID = 'VN-BANK-001';
/** The end states of the seven settlements the two smoke scripts make (smoke-remit: one; the exception matrix: six). */
const EXPECTED_STATES = { EVIDENCE_ANCHORED: 3, CANCELLED: 2, RETURNED: 1, PAYOUT_IN_PROGRESS: 1 };

const loc = (port) => `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── output: one line per thing looked at ────────────────────────────────────

let failed = 0;
const ok = (what) => console.log(`ok    ${what}`);
const bad = (what) => { failed++; console.log(`FAIL  ${what}`); };
const note = (what) => console.log(`      ${what}`);
const must = (cond, what, why = '') => { if (cond) ok(what); else bad(why ? `${what} — ${why}` : what); return !!cond; };
function usage(msg) { console.error(msg); process.exit(2); }

// ── arguments ───────────────────────────────────────────────────────────────

const MODES = ['--constants', '--preflight', '--schema-empty', '--wallet', '--wallet-free', '--env', '--provisioned', '--partner', '--bank-webhook', '--after', '--admin-token-to-pipe'];
const argv = process.argv.slice(2);
const options = { '--set': null, '--work': null };
const flags = new Set();
/** What is neither an option nor a flag: the `name=value` items of --constants, the `role=pid` items of --env. */
const items = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (Object.hasOwn(options, a)) options[a] = argv[++i] ?? null;
  else if (MODES.includes(a) || a === '--gated') flags.add(a);
  else if (a.startsWith('--')) usage(`unknown argument ${a}`);
  else items.push(a);
}
const flag = (name) => flags.has(name);
const valueOf = (name) => options[name];

// ── addresses: nothing live, nothing off this machine ───────────────────────

/** What is wrong with an address this tool or a process of the set would call, or null. */
function addressProblem(value) {
  let u;
  try { u = new URL(value); } catch { return 'not an address'; }
  if (u.hostname !== '127.0.0.1') return 'does not point at 127.0.0.1';
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (LIVE_PORTS.includes(port)) return `points at a live port (${port})`;
  return null;
}
/** Does this text name a live address anywhere — a live port after a colon, or a host that is not this machine? */
function namesSomethingLive(text) {
  for (const port of LIVE_PORTS) if (new RegExp(`:${port}(?![0-9])`).test(text)) return `a live port (${port})`;
  for (const m of text.matchAll(/https?:\/\/([^/\s:"']+)/g)) if (m[1] !== '127.0.0.1') return 'an address that is not 127.0.0.1';
  return null;
}
/** Every request this tool sends goes through here. */
async function request(method, url, { headers = {}, body, timeoutMs = 15_000 } = {}) {
  const p = addressProblem(url);
  if (p) throw new Error(`refusing to call an address that ${p}`);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const u = new URL(url);
    throw new Error(`${method} :${u.port}${u.pathname} got no answer (${e?.cause?.code ?? e?.name ?? 'no connection'}) — is the set running?`);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

// ── the set, its settings file, its folders ─────────────────────────────────

function theSet() {
  const name = valueOf('--set');
  if (!name || !Object.hasOwn(SETS, name)) usage('usage: node check-second-set.mjs --set ref|java [--work <work folder>] <mode> — see the head of the file');
  const s = SETS[name];
  for (const port of [s.core, s.chain, s.partner, s.bank]) if (LIVE_PORTS.includes(String(port))) usage(`the table of this tool names a live port (${port})`);
  return { name, ...s, envPath: path.join(MODULE, s.envFile), dataPath: path.join(MODULE, s.dataDir), base: loc(s.core), bankBase: loc(s.bank), partnerBase: loc(s.partner), chainBase: loc(s.chain), webhook: `${loc(s.bank)}/api/remit/webhook` };
}
/** The set's settings. Read here, compared here, never printed. */
function settings(set) {
  if (!fs.existsSync(set.envPath)) { console.error(`${set.envFile} is not there — make it with tools/make-dev-env.mjs (see run-second-set.sh)`); process.exit(1); }
  return readEnvFile(set.envPath);
}
const underRepo = (p) => p === REPO || p.startsWith(`${REPO}${path.sep}`);
/** The work folder: given, there, and not inside the repository — a demo copy beside the live folders would read their data (hazard F-10). */
function workFolder() {
  const given = valueOf('--work');
  if (!given || !path.isAbsolute(given)) usage('--work <absolute path of the work folder> is needed for this mode');
  let real;
  try { real = fs.realpathSync(given); } catch { console.error(`the work folder ${given} is not there`); process.exit(1); }
  if (underRepo(real)) { console.error('refusing: the work folder is inside the repository'); process.exit(1); }
  return real;
}
/** A state file a copy made for itself (never a live one): parsed, for comparing. */
function ownState(work, set, demo) {
  const file = path.join(work, set.name, demo, 'state.json');
  const real = fs.realpathSync(file);
  if (underRepo(real)) throw new Error(`refusing to read ${demo}/state.json: it resolves into the repository`);
  return JSON.parse(fs.readFileSync(real, 'utf8'));
}

// ── --constants ─────────────────────────────────────────────────────────────

function constants(set) {
  const given = Object.fromEntries(items.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const mine = { core: String(set.core), chain: String(set.chain), partner: String(set.partner), bank: String(set.bank), env: set.envFile };
  for (const [k, v] of Object.entries(mine)) must(given[k] === v, `${k}: the run script and this tool name the same ${k === 'env' ? 'settings file' : 'port'} (${v})`, `the run script says ${given[k] ?? 'nothing'}`);
  for (const k of Object.keys(given)) if (!Object.hasOwn(mine, k)) bad(`${k}: not a constant of the set`);
}

// ── --preflight ─────────────────────────────────────────────────────────────

/** The live service's admin token (its settings file's, or the sandbox default) — to compare with, never printed. */
function liveAdminToken() {
  try { return readEnvFile(path.join(ATTEST, 'apps/core/.env')).REMIT_ADMIN_TOKEN || 'remit-admin-sandbox'; } catch { return 'remit-admin-sandbox'; }
}
/** What is wrong with the set's admin token, or null. A token of its own: the live core refuses it, this core refuses the live one's. */
function tokenProblem(env) {
  const t = env.REMIT_ADMIN_TOKEN ?? '';
  if (!t) return 'REMIT_ADMIN_TOKEN is not set — its default is the sandbox token, which the live core accepts';
  if (t === 'remit-admin-sandbox') return 'REMIT_ADMIN_TOKEN is the sandbox default';
  if (t === liveAdminToken()) return 'REMIT_ADMIN_TOKEN is the live service\'s';
  if (t.length < 24) return 'REMIT_ADMIN_TOKEN is too short to be a token of its own';
  return null;
}
const samePlace = (value, expected) => { try { const a = new URL(value); const b = new URL(expected); return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port && (a.pathname === '/' || a.pathname === ''); } catch { return false; } };

function preflight(set) {
  const env = settings(set);
  const unsafe = problems(env);
  must(unsafe.length === 0, `${set.envFile}: safe for a test server by check-test-env.mjs`, unsafe.join('; '));
  let schema = ''; let dbHost = '';
  try { const u = new URL(env.STONEHASH_DB_URL); schema = u.pathname.replace(/^\//, ''); dbHost = u.hostname; } catch { /* reported below */ }
  must(schema === set.schema, `STONEHASH_DB_URL names this set's schema (${set.schema})`);
  must(dbHost === '127.0.0.1' || dbHost === 'localhost', 'STONEHASH_DB_URL: the database is on this machine');
  must(env.PORT === String(set.core), `PORT is this set's (${set.core})`);
  must(env.HOST === '127.0.0.1', 'HOST is 127.0.0.1 — the core is not reachable from outside');
  must(env.STONEHASH_ENV === 'test', 'STONEHASH_ENV is test');
  must(env.ANCHOR_BACKEND === 'regtest', 'ANCHOR_BACKEND is regtest');
  must(env.REMIT_ENABLED === '1', 'REMIT_ENABLED is 1');
  must(env.BITCOIND_WALLET === WALLET, `BITCOIND_WALLET is ${WALLET}`);
  must(/^[1-9][0-9]*$/.test(env.WORKER_TICK_MS ?? ''), 'WORKER_TICK_MS is on — the smoke waits for EVIDENCE_ANCHORED');
  must(/^[1-9][0-9]*$/.test(env.BATCH_FLUSH_INTERVAL_MS ?? '') && /^[1-9][0-9]*$/.test(env.BATCH_MAX_LEAVES ?? ''), 'BATCH_FLUSH_INTERVAL_MS and BATCH_MAX_LEAVES are set');
  must(path.resolve(env.STONEHASH_DATA_DIR ?? '/') === set.dataPath, `STONEHASH_DATA_DIR is this set's (${set.dataDir})`);
  const key = path.resolve(env.REMIT_PLATFORM_KEY_PATH || path.join(env.STONEHASH_DATA_DIR ?? '/', 'platform-remit-key.pem'));
  must(key.startsWith(`${set.dataPath}${path.sep}`), `REMIT_PLATFORM_KEY_PATH is inside ${set.dataDir} — the core makes its own platform key there`);
  must(samePlace(env.REMIT_PARTNERS_BASE, set.partnerBase), `REMIT_PARTNERS_BASE is this set's partner copy (:${set.partner})`);
  must(samePlace(env.REMIT_CHAIN_RPC, set.chainBase), `REMIT_CHAIN_RPC is the stand-in node (:${set.chain})`);
  must(samePlace(env.POR_CHAIN_RPC, set.chainBase), `POR_CHAIN_RPC is the stand-in node (:${set.chain})`);
  const tp = tokenProblem(env);
  must(tp === null, 'REMIT_ADMIN_TOKEN is a token of this set\'s own — neither the sandbox default nor the live service\'s', tp ?? '');
  let node = '';
  try { node = new URL(env.BITCOIND_URL || 'http://127.0.0.1:18443').hostname; } catch { /* reported below */ }
  must(node === '127.0.0.1' || node === 'localhost', 'BITCOIND_URL: the regtest node of this machine (the one address of a live port a test core is given — it is used with the wallet attest-java only)');
  must(!env.STONEHASH_CUTOVER_APPROVED && !env.ALLOW_REGTEST_IN_LIVE, 'no switch of the approved cut-over is set');
  // Every other setting that could hold an address the service calls. Link templates and paths are named, not followed.
  const links = new Set(['EXPLORER_BASE_URL', 'REMIT_EXPLORER_TX_URL', 'PUBLIC_BASE_URL', 'PUBLIC_ANCHOR_ORIGINS']);
  const looked = new Set(['STONEHASH_DB_URL', 'BITCOIND_URL', 'REMIT_PARTNERS_BASE', 'REMIT_CHAIN_RPC', 'POR_CHAIN_RPC']);
  const stray = Object.entries(env).filter(([k, v]) => !links.has(k) && !looked.has(k) && /https?:\/\//.test(v)).map(([k]) => k);
  must(stray.length === 0, 'no other setting holds an address', `not looked at: ${stray.join(', ')}`);
  const present = [...links].filter((k) => env[k]);
  if (present.length) note(`${present.join(', ')}: links written into answers, never called by the service`);
}

// ── the set's schema ────────────────────────────────────────────────────────

async function db(set) {
  const env = settings(set);
  const u = new URL(env.STONEHASH_DB_URL);
  const database = u.pathname.replace(/^\//, '');
  if (!/^stonehash_test_[a-z0-9_]+$/.test(database) || database !== set.schema) throw new Error(`refusing: the settings file does not name ${set.schema}`);
  const require = createRequire(new URL('../../core/package.json', import.meta.url));
  const mysql = require('mysql2/promise');
  return mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database });
}

async function schemaEmpty(set) {
  const conn = await db(set);
  try {
    const [tables] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name <> 'flyway_schema_history'", [set.schema]);
    const full = [];
    for (const { t } of tables) {
      const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      if (Number(rows[0].n) > 0) full.push(`${t} (${rows[0].n})`);
    }
    must(full.length === 0, `${set.schema}: ${tables.length} data tables, no row in any`, `rows in ${full.join(', ')}`);
  } finally { await conn.end(); }
}

// ── the wallet ──────────────────────────────────────────────────────────────

/** The regtest node, by the set's own settings file. Reads only, and the one wallet. */
async function nodeRpc(set, method, params = [], wallet = '') {
  if (!['listwallets', 'getbalances', 'getwalletinfo', 'getblockcount'].includes(method)) throw new Error(`this tool does not send ${method}`);
  if (wallet && wallet !== WALLET) throw new Error('this tool names no wallet but attest-java');
  const env = settings(set);
  const res = await fetch((env.BITCOIND_URL || 'http://127.0.0.1:18443').replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.BITCOIND_USER ?? ''}:${env.BITCOIND_PASSWORD ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}

async function wallet(set) {
  const env = settings(set);
  if (!must(env.BITCOIND_WALLET === WALLET, `the set's wallet is ${WALLET}`)) return;
  const loaded = await nodeRpc(set, 'listwallets');
  if (!must(loaded.includes(WALLET), `the node has ${WALLET} loaded`, 'it is not loaded — loading a wallet changes the node and is not this tool\'s to do')) return;
  const b = await nodeRpc(set, 'getbalances', [], WALLET);
  const info = await nodeRpc(set, 'getwalletinfo', [], WALLET);
  const height = await nodeRpc(set, 'getblockcount');
  const sat = (btc) => Math.round(Number(btc) * 1e8);
  console.log(`wallet ${WALLET}: trusted ${sat(b.mine.trusted)} sat, unconfirmed ${sat(b.mine.untrusted_pending)} sat, immature ${sat(b.mine.immature)} sat, ${info.txcount} transactions; chain height ${height}`);
  must(sat(b.mine.trusted) > 20_000, `${WALLET} can pay for the anchors of a set (about six small transactions)`, 'under 20,000 sat spendable — it is not topped up by a tool: that is the owner\'s call');
}

/**
 * Is another service running with a worker on the wallet? Looked for by command line: the reference
 * started through run-reference-core.mjs, the Java service (`--env-file=`), a Java integration test
 * (`-Dstonehash.env=`). Each settings file found is read; a file that names attest-java with the worker
 * on (or a test, which drives the worker itself) is a second user of the wallet.
 */
function walletFree() {
  const found = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    let args; try { args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    let cwd = null; try { cwd = fs.readlinkSync(`/proc/${d}/cwd`); } catch { /* somebody else's process */ }
    const files = [];
    args.forEach((a, i) => {
      if (/(^|\/)run-reference-core\.mjs$/.test(a) && args[i + 1]) files.push({ file: args[i + 1], test: false });
      if (a.startsWith('--env-file=')) files.push({ file: a.slice('--env-file='.length), test: false });
      if (a.startsWith('-Dstonehash.env=')) files.push({ file: a.slice('-Dstonehash.env='.length), test: true });
    });
    for (const { file, test } of files) {
      const candidates = path.isAbsolute(file) ? [file] : [cwd && path.resolve(cwd, file), path.resolve(MODULE, file)].filter(Boolean);
      for (const full of candidates) {
        let env; try { env = readEnvFile(full); } catch { continue; }
        if (env.BITCOIND_WALLET === WALLET && (test || (env.WORKER_TICK_MS ?? '') !== '0')) found.push(`process ${d} (${path.basename(full)}${test ? ', an integration test' : ''})`);
        break;
      }
    }
  }
  must(found.length === 0, `no other service is running with a worker on ${WALLET}`, `${found.join(', ')} — two services never anchor from that wallet at once`);
}

// ── --env: the environment of a process of the set ──────────────────────────

/** What bash adds of its own when it runs a command; and what every process of the set is given. */
const HARMLESS = new Set(['PATH', 'HOME', 'LANG', 'PWD', 'OLDPWD', 'SHLVL', '_']);

/**
 * What a process of the set is given, where it runs and what it runs. `outside`: a copy, which must run in the
 * work folder and nowhere in the repository. `cwdRunning`: where the program moves to once it runs (the
 * reference changes to its own source folder, as tools/run-reference-core.mjs has always done).
 */
function roleOf(set, role, work) {
  const demo = { ATTEST_BASE: set.base, CHAIN_BACKEND: 'mock', ANVIL_URL: 'http://127.0.0.1:1', BANK_PUBLIC_BASE: set.bankBase, ATTEST_PUBLIC_BASE: set.base, PARTNERS_PUBLIC_BASE: set.partnerBase };
  const preload = `file://${path.join(work, 'loopback-only.mjs')}`;
  const at = (...parts) => path.join(work, ...parts);
  switch (role) {
    case 'chain': return { env: {}, cwd: ATTEST, command: ['node', path.join(HERE, 'stand-in-eth-rpc.mjs'), '--port', String(set.chain)] };
    case 'core': return set.name === 'java'
      ? { env: {}, cwd: MODULE, command: [JAVA17, '-jar', at('core-java.jar'), `--env-file=${set.envPath}`, 'serve'] }
      : { env: {}, cwd: ATTEST, cwdRunning: path.join(ATTEST, 'apps/core'), command: ['node', path.join(HERE, 'run-reference-core.mjs'), set.envPath] };
    // The Java service's two commands that end by themselves: bring the schema to the build's version; print the route table.
    case 'core-migrate': case 'core-routes': return set.name !== 'java' ? null
      : { env: {}, cwd: MODULE, command: [JAVA17, '-jar', at('core-java.jar'), `--env-file=${set.envPath}`, role.slice('core-'.length)] };
    case 'partner-setup': return { env: { ATTEST_BASE: set.base, REMIT_ADMIN_TOKEN: settings(set).REMIT_ADMIN_TOKEN }, cwd: at(set.name, 'demo-partners'), command: ['node', 'setup.mjs'], outside: true };
    case 'bank-setup': return { env: { ATTEST_BASE: set.base }, cwd: at(set.name, 'demo-bank'), command: ['node', 'setup.mjs'], outside: true };
    case 'partner': return { env: { ...demo, PORT: String(set.partner) }, cwd: at(set.name, 'demo-partners'), command: ['node', '--import', preload, 'server.mjs'], outside: true };
    case 'bank': return { env: { ...demo, PORT: String(set.bank) }, cwd: at(set.name, 'demo-bank'), command: ['node', '--import', preload, 'server.mjs'], outside: true };
    case 'smoke-remit': return { env: { ATTEST_BASE: set.base, REMIT_WEBHOOK_URL: set.webhook }, cwd: at('attest', 'deploy'), command: ['node', 'smoke-remit.mjs'], outside: true };
    case 'smoke-exceptions': return { env: { BANK_BASE: set.bankBase }, cwd: at('attest', 'deploy'), command: ['node', 'smoke-exceptions.mjs'], outside: true };
    default: return null;
  }
}
/** A bare pid: what is it running? */
function guessRole(args, cwd) {
  const last = args.at(-1) ?? '';
  if (args.some((a) => /stand-in-eth-rpc\.mjs$/.test(a))) return 'chain';
  if (args.some((a) => /run-reference-core\.mjs$/.test(a)) || args.some((a) => a.startsWith('--env-file='))) return 'core';
  const folder = path.basename(cwd ?? '');
  if (last === 'server.mjs') return folder === 'demo-partners' ? 'partner' : folder === 'demo-bank' ? 'bank' : null;
  if (last === 'setup.mjs') return folder === 'demo-partners' ? 'partner-setup' : folder === 'demo-bank' ? 'bank-setup' : null;
  if (last === 'smoke-remit.mjs' || last === 'smoke-exceptions.mjs') return last.replace('.mjs', '');
  return null;
}
const readProc = (pid) => {
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); args.pop();
  const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
  return { args, environ, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) };
};

async function envOf(set) {
  const gated = flag('--gated');
  if (items.length === 0) usage('--env needs <role>=<pid> …');
  const work = workFolder(); // where the copies must be running
  for (const item of items) {
    const i = item.indexOf('=');
    let role = i < 0 ? null : item.slice(0, i);
    const pid = i < 0 ? item : item.slice(i + 1);
    if (!/^[1-9][0-9]*$/.test(pid)) { bad(`${item}: not a process id`); continue; }
    let proc;
    try {
      proc = readProc(pid);
      // At the gate nothing of the program has run. Wait until the process has become the gate (a moment after it was started).
      for (let n = 0; gated && n < 200 && !(proc.args[1] === '-c' && proc.args[2] === GATE_SCRIPT); n++) { await sleep(25); proc = readProc(pid); }
    } catch (e) { bad(`process ${pid}: its environment cannot be read (${e.code ?? e.message}) — it has ended, or it is not ours`); continue; }
    const atGate = proc.args[1] === '-c' && proc.args[2] === GATE_SCRIPT;
    if (gated && !atGate) { bad(`process ${pid}: it is not waiting at the gate — it was not started by the run script's gate, or it is already running`); continue; }
    const command = atGate ? proc.args.slice(5) : proc.args; // bash -c <gate> gate <fifo> <command …>
    role = role ?? guessRole(command, proc.cwd);
    const want = role ? roleOf(set, role, work) : null;
    const who = `${role ?? 'process'} ${pid}${atGate ? ' (at the gate)' : ''}`;
    if (!want) { bad(`${who}: not a role of this set (chain, core, partner-setup, bank-setup, partner, bank, smoke-remit, smoke-exceptions; for the Java set also core-migrate, core-routes)`); continue; }

    const env = new Map(proc.environ.map((kv) => { const k = kv.indexOf('='); return [kv.slice(0, k), kv.slice(k + 1)]; }));
    const lines = [];
    let wrong = 0;
    for (const [name, value] of Object.entries(want.env)) {
      const same = env.get(name) === value;
      if (!same) wrong++;
      lines.push(`${name}: ${env.has(name) ? (same ? 'the set\'s own' : 'NOT the set\'s') : 'ABSENT — its default is a live address or a live setting'}`);
    }
    for (const name of env.keys()) {
      if (Object.hasOwn(want.env, name)) continue;
      if (!HARMLESS.has(name)) { wrong++; lines.push(`${name}: not a variable this process is given`); }
    }
    for (const [name, value] of env) {
      const live = name === 'PATH' ? null : namesSomethingLive(value);
      if (live) { wrong++; lines.push(`${name}: names ${live}`); }
    }
    const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
    if (!env.has('HOME') || !(real(env.get('HOME')) ?? '').startsWith(`${work}${path.sep}`)) { wrong++; lines.push('HOME: not a folder inside the work folder'); }
    // Where it runs and what it runs: the copy in the work folder, never a live folder.
    const realCwd = real(proc.cwd) ?? proc.cwd;
    const wantCwd = real(atGate ? want.cwd : want.cwdRunning ?? want.cwd);
    if (wantCwd === null || realCwd !== wantCwd) { wrong++; lines.push('working directory: NOT the folder this role runs in'); } else lines.push('working directory: the set\'s own');
    if (want.outside && underRepo(realCwd)) { wrong++; lines.push('working directory: inside the repository'); }
    const sameCommand = command.length === want.command.length && command.every((a, k) => a === want.command[k]);
    if (!sameCommand) { wrong++; lines.push(`command: NOT the one this role runs (${want.command.map((a) => path.basename(a)).join(' ')})`); } else lines.push('command: the set\'s own');
    // A copy is a file of the work folder. Were it a link to the repository's file, the program would find
    // itself in the live folder — and read the live identity beside it (hazard F-6).
    if (want.outside) {
      const program = path.resolve(realCwd, want.command.at(-1));
      let plain = false; try { plain = fs.lstatSync(program).isFile(); } catch { /* reported below */ }
      const where = real(program) ?? '';
      if (!plain || where !== program || underRepo(where) || !where.startsWith(`${work}${path.sep}`)) { wrong++; lines.push('program file: NOT a plain file of the work folder'); } else lines.push('program file: a copy in the work folder');
    }
    (wrong === 0 ? ok : bad)(`${who}: ${wrong === 0 ? 'its environment is the set\'s own, nothing live in it' : `${wrong} thing(s) wrong`}`);
    for (const l of lines) note(l);
  }
}

// ── --provisioned, --partner, --bank-webhook ────────────────────────────────

async function provisioned(set) {
  const work = workFolder();
  const partner = ownState(work, set, 'demo-partners');
  const bank = ownState(work, set, 'demo-bank');
  must(partner.core === set.base, `the partner copy was provisioned against this set's core (:${set.core})`);
  must(bank.core === set.base, `the bank copy was provisioned against this set's core (:${set.core})`);
  const meta = await request('GET', `${set.base}/v1/remit/meta`);
  if (!must(meta.status === 200 && Array.isArray(meta.json?.institutions), 'GET /v1/remit/meta answers with the registry', `status ${meta.status}`)) return;
  for (const [slug, id] of Object.entries(PARTNER_IDS)) {
    const row = meta.json.institutions.find((x) => x.id === id);
    must(!!row && !!partner.institutions?.[slug]?.spki && row.signing_spki === partner.institutions[slug].spki, `${id}: this core's registry holds the key the partner copy made`);
  }
  const bfi = meta.json.institutions.find((x) => x.id === PARTNER_IDS.bfi);
  must(!!bfi?.encryption_jwk, `${PARTNER_IDS.bfi}: the registry publishes its encryption key (mode B needs it)`);
}

async function partnerMock(set) {
  const h = await request('GET', `${set.partnerBase}/healthz`);
  must(h.status === 200 && h.json?.status === 'ok', `the partner copy answers on :${set.partner}`, `status ${h.status}`);
  must(h.json?.chain === 'mock', 'the partner copy says its chain is mock', `it says ${JSON.stringify(h.json?.chain)} — it would write to the shared chain node`);
  const w = await request('GET', `${set.partnerBase}/wallet/state`);
  must(w.status === 200 && w.json?.chain?.backend === 'mock', 'its settlement wallet is on the mock chain too');
}

async function bankWebhook(set) {
  const c = await request('GET', `${set.bankBase}/api/remit/config`);
  must(c.status === 200 && c.json?.subscribed === true, `the bank copy on :${set.bank} is subscribed to the rail`, `status ${c.status}`);
  must(c.json?.webhook_url === set.webhook, 'the webhook address it registered is on its own port', 'it registered another address — the core would post this set\'s webhooks there');
  must(c.json?.institution === BANK_ID, `it is ${BANK_ID}`);
}

// ── --after ─────────────────────────────────────────────────────────────────

async function after(set) {
  const work = workFolder();
  const bankState = ownState(work, set, 'demo-bank');
  if (!must(bankState.core === set.base, 'the bank copy\'s key belongs to this set\'s core')) return;
  const bearer = { authorization: `Bearer ${bankState.apiKey}` };

  // 1 — the bank copy's own verification of the cases that ended anchored (demo-bank/remit.mjs verifyEvidence:
  //     commitment, element signatures, the six axes re-run and compared in order, the anchor bundle).
  console.log('\n— the bank copy verifies its anchored cases itself');
  const list = await request('GET', `${set.bankBase}/api/remit/cases`);
  if (must(list.status === 200 && Array.isArray(list.json?.data), 'the bank copy lists its cases', `status ${list.status}`)) {
    const anchored = [];
    for (const c of list.json.data) {
      if (!c.payment_id) continue;
      const d = await request('GET', `${set.bankBase}/api/remit/cases/${c.id}`); // refreshes the case from the core
      if (d.json?.platform?.state === 'EVIDENCE_ANCHORED') anchored.push(d.json);
    }
    must(anchored.length >= 2, `${anchored.length} case(s) of the exception matrix ended anchored (the RFI case and the mode B case)`, 'two were expected');
    for (const c of anchored) {
      const v = await request('POST', `${set.bankBase}/api/remit/cases/${c.id}/verify`, { timeoutMs: 30_000 });
      const checks = Array.isArray(v.json?.checks) ? v.json.checks : [];
      must(v.status === 200 && v.json?.verified === true && checks.length === 4, `${c.payment_id} (${c.scenario}, mode ${c.travel_rule_mode}): the bank copy answers verified: true`,
        `status ${v.status}; failed: ${checks.filter((x) => !x.ok).map((x) => x.name).join(', ') || v.json?.error || 'no report'}`);
    }
  }

  // 2 — every webhook the core stored: signed by this core's platform key (the TypeScript SDK's verifyWebhook),
  //     and addressed to the bank copy — a row for another address would be a webhook posted somewhere else.
  console.log('\n— webhooks stored in the set\'s schema');
  const { RemitClient, verifyEvidencePackage } = await import('../../../packages/attest-remit/src/index.ts');
  const client = new RemitClient({ core: set.base, apiKey: bankState.apiKey, institutionId: BANK_ID, institutionName: 'second set', readOnly: true });
  const conn = await db(set);
  try {
    const [subs] = await conn.query('SELECT product, config FROM subscriptions');
    const hooks = subs.map((r) => { try { return JSON.parse(r.config).webhook_url; } catch { return undefined; } }).filter((u) => u !== undefined && u !== null);
    must(hooks.length >= 1 && hooks.every((u) => u === set.webhook), `every webhook address registered in ${set.schema} is the bank copy's (${hooks.length})`);
    const [rows] = await conn.query('SELECT id, payment_id, event_id, url, status, attempts, body FROM remit_webhook_deliveries ORDER BY created_at, id');
    must(rows.length > 0, `${rows.length} webhook deliveries are stored`, 'none — the bank copy registered no address, or nothing was accepted');
    const elsewhere = rows.filter((r) => r.url !== set.webhook);
    must(elsewhere.length === 0, 'every delivery is addressed to the bank copy', `${elsewhere.length} to another address`);
    const invalid = []; const seen = new Set(); let twice = 0;
    for (const r of rows) {
      let body; try { body = JSON.parse(r.body); } catch { invalid.push(`${r.id}: not JSON`); continue; }
      const v = await client.verifyWebhook(body);
      if (!v.valid) invalid.push(`${r.id}: signature does not verify`);
      else if (v.envelope.payment_id !== r.payment_id || v.envelope.event_id !== r.event_id) invalid.push(`${r.id}: the envelope is not the row's`);
      if (seen.has(r.event_id)) twice++; seen.add(r.event_id);
    }
    must(invalid.length === 0, `every stored webhook body passes the TypeScript SDK's verifyWebhook (${rows.length})`, invalid.slice(0, 5).join('; '));
    must(twice === 0, 'no event id is stored twice');
    const by = {}; for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
    note(`delivery status: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    must(!by.exhausted, 'no delivery ran out of attempts');
  } finally { await conn.end(); }

  // 3 — every evidence response of the ledger, re-verified by the TypeScript SDK (commitment, signatures, verdict, anchor).
  console.log('\n— evidence responses');
  const ledger = await request('GET', `${set.base}/v1/settlements?limit=100`, { headers: bearer });
  if (must(ledger.status === 200 && Array.isArray(ledger.json?.data), 'the core lists the bank\'s settlements', `status ${ledger.status}`)) {
    const states = {}; for (const p of ledger.json.data) states[p.state] = (states[p.state] ?? 0) + 1;
    const text = (o) => Object.entries(o).sort().map(([k, n]) => `${k} ${n}`).join(', ');
    must(text(states) === text(EXPECTED_STATES), `the ledger holds the seven settlements of the two scripts in their end states (${text(EXPECTED_STATES)})`, `it holds ${text(states) || 'nothing'}`);
    const withEvidence = ledger.json.data.filter((p) => p.evidence_available);
    must(withEvidence.length >= 3, `${withEvidence.length} settlement(s) have an evidence package`, 'three were expected');
    for (const p of withEvidence) {
      let report = null; let status = 0;
      for (let n = 0; n < 40; n++) { // an anchor that is still on its way is waited for, a minute at most
        const ev = await request('GET', `${set.base}/v1/settlements/${encodeURIComponent(p.payment_id)}/evidence`, { headers: bearer });
        status = ev.status;
        if (ev.status === 200) { report = await verifyEvidencePackage(ev.json); if (report.verified) break; }
        await sleep(1500);
      }
      must(report?.verified === true && report.checks.length === 4, `${p.payment_id}: the evidence response passes the TypeScript SDK's verifyEvidencePackage (${(report?.checks ?? []).map((c) => c.name).join(', ')})`,
        `status ${status}; failed: ${(report?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ') || 'no report'}`);
    }
  }

  // 4 — the partner copy's own ledger: a callback the core refused, or a transfer it never saw, leaves a record in ERROR.
  console.log('\n— the partner copy\'s own ledger');
  const bfi = await request('GET', `${set.partnerBase}/bfi/state`);
  if (must(bfi.status === 200 && Array.isArray(bfi.json?.payments), 'the partner copy shows its ledger', `status ${bfi.status}`)) {
    const by = {}; for (const r of bfi.json.payments) by[r.state] = (by[r.state] ?? 0) + 1;
    note(`records: ${Object.entries(by).sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
    const errors = bfi.json.payments.filter((r) => r.state === 'ERROR' || r.error);
    must(errors.length === 0, 'no record is in an error state', errors.map((r) => `${r.payment_id}: ${r.error}`).join('; '));
    must(bfi.json.payments.length >= 6, `${bfi.json.payments.length} records (every settlement that got past screening)`, 'six were expected');
  }
  // On a chain node the simulator deploys its token at start and writes this file (hazard F-3). On the mock chain there is none.
  must(!fs.existsSync(path.join(work, set.name, 'demo-partners', 'data', 'chain-state.json')), 'the partner copy kept no chain-state file — it deployed nothing to a chain node');

  // 5 ── THE JAVA SIDE — to be added here by the builder ─────────────────────────────────────────────────────
  //
  // Checks of E.2 step 8 that need the Java rail or the Java SDK and could not be written before the rail exists:
  //   - every stored webhook body and every evidence response also passes the JAVA SDK's verification
  //     (sdks/attest-remit-java: RemitClient.verifyWebhook, the evidence re-verification);
  //   - the invariants of verification plan D.0 on the Java schema's job table (no job left running or failed,
  //     one terminal job per step, attempts as the design says) — the table and its columns are the rail's;
  //   - tools/compare-remit.mjs's invariants on the set's schema.
  // Each is one `must(…)` line like the ones above; `conn` (the set's schema), `client`, `ledger` are at hand.
  if (set.name === 'java') note('NOT CHECKED YET: the Java SDK\'s verification, the job table\'s invariants (D.0), compare-remit.mjs — see the marked place in this file');
}

// ── main ────────────────────────────────────────────────────────────────────

const set = theSet();
const modes = MODES.filter(flag);
if (modes.length !== 1) usage('give exactly one mode: --constants, --preflight, --schema-empty, --wallet, --wallet-free, --env, --provisioned, --partner, --bank-webhook, --after');
if (items.length > 0 && modes[0] !== '--env' && modes[0] !== '--constants') usage(`${modes[0]} takes no further argument (${items[0]})`);
try {
  switch (modes[0]) {
    case '--constants': constants(set); break;
    case '--preflight': preflight(set); break;
    case '--schema-empty': await schemaEmpty(set); break;
    case '--wallet': await wallet(set); break;
    case '--wallet-free': walletFree(); break;
    case '--env': await envOf(set); break;
    case '--provisioned': await provisioned(set); break;
    case '--partner': await partnerMock(set); break;
    case '--bank-webhook': await bankWebhook(set); break;
    case '--after': await after(set); break;
    case '--admin-token-to-pipe': {
      if (process.stdout.isTTY) { console.error('refusing: the token is handed to the run script through a pipe, never shown'); process.exit(1); }
      const tp = tokenProblem(settings(set));
      if (tp) { console.error(`refusing: ${tp}`); process.exit(1); }
      process.stdout.write(settings(set).REMIT_ADMIN_TOKEN);
      break;
    }
    default: usage('unknown mode');
  }
} catch (e) {
  bad(`${modes[0]}: ${e instanceof Error ? e.message : String(e)}`);
}
if (modes[0] !== '--admin-token-to-pipe') console.log(failed === 0 ? `\n${modes[0].slice(2)}: passed` : `\n${modes[0].slice(2)}: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
