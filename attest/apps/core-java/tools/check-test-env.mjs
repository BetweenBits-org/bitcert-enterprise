/**
 * Is this settings file safe to start a test server with?
 *
 *   node apps/core-java/tools/check-test-env.mjs <env file> [<env file> …]
 *
 * A test server — the Java service on its test schema, or the reference
 * TypeScript core beside it — must not be able to reach anything that is
 * live on this machine: the live schema, the live wallet, the live data
 * directory with the platform's signing key in it, the partner simulator the
 * sandbox runs on (:3300), the settlement chain's node (:8545), the live core
 * and the demos. Both services read a setting that is absent or blank as "not
 * set" and take its default, and several defaults ARE the live addresses
 * (`REMIT_PARTNERS_BASE` → :3300, `REMIT_CHAIN_RPC` and `POR_CHAIN_RPC` →
 * :8545). So the settings that have such a default must be present, and must
 * name something else. With the settlement rail in place a server whose file
 * left them out would call the live simulator on every accepted settlement.
 *
 * Prints the names of the settings it looked at and what is wrong — never a
 * value. Exit status 1 when a file is not safe.
 *
 * Also a module: `problems(env)` takes the settings as an object and returns
 * the list of what is wrong, for a tool that has already read them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Ports something live listens on here: the core, the homepage, the three demos, the partner simulator, the explorer gateway, the chain node, bitcoind. */
const LIVE_PORTS = new Set(['8787', '3100', '3200', '3300', '3400', '3500', '5106', '8545', '18443']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function readEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

/** The live service's data directory, to compare with — read here, never printed. */
function liveDataDir() {
  try {
    const live = readEnvFile(path.resolve(HERE, '../../core/.env'));
    return live.STONEHASH_DATA_DIR ? path.resolve(path.resolve(HERE, '../../core'), live.STONEHASH_DATA_DIR) : path.resolve(HERE, '../../core/.data');
  } catch {
    return path.resolve(HERE, '../../core/.data');
  }
}

/** An address a test server may call: there, on this machine, and not a live port. Returns what is wrong, or null. */
function addressProblem(name, value) {
  if (!value) return `${name} is not set — its default is a live address`;
  let u;
  try { u = new URL(value); } catch { return `${name} is not an address`; }
  if (!LOOPBACK.has(u.hostname)) return `${name} does not point at this machine`;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (LIVE_PORTS.has(port)) return `${name} points at a live port (${port})`;
  return null;
}

export function problems(env) {
  const out = [];
  let schema = '';
  try { schema = new URL(env.STONEHASH_DB_URL ?? 'mysql://x/').pathname.replace(/^\//, ''); } catch { /* reported below */ }
  if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) out.push('STONEHASH_DB_URL does not name a stonehash_test_ schema');
  if (!env.PORT) out.push('PORT is not set — its default is the live port');
  else if (LIVE_PORTS.has(env.PORT)) out.push(`PORT is a live port (${env.PORT})`);
  if (!env.STONEHASH_DATA_DIR) out.push('STONEHASH_DATA_DIR is not set — its default is the live data directory');
  else if (path.resolve(env.STONEHASH_DATA_DIR) === liveDataDir()) out.push('STONEHASH_DATA_DIR is the live data directory');
  if (!env.BITCOIND_WALLET) out.push('BITCOIND_WALLET is not set');
  else if (env.BITCOIND_WALLET === 'attest') out.push('BITCOIND_WALLET is the live wallet');
  for (const name of ['REMIT_PARTNERS_BASE', 'REMIT_CHAIN_RPC', 'POR_CHAIN_RPC']) {
    const p = addressProblem(name, env[name]);
    if (p) out.push(p);
  }
  if (env.REMIT_PLATFORM_KEY_PATH) {
    const key = path.resolve(env.REMIT_PLATFORM_KEY_PATH);
    if (key === liveDataDir() || key.startsWith(`${liveDataDir()}${path.sep}`)) out.push('REMIT_PLATFORM_KEY_PATH is inside the live data directory');
  }
  if (env.STONEHASH_CUTOVER_APPROVED) out.push('STONEHASH_CUTOVER_APPROVED is set — that is for the approved switch, never for a test server');
  return out;
}

export const CHECKED = ['STONEHASH_DB_URL', 'PORT', 'STONEHASH_DATA_DIR', 'BITCOIND_WALLET', 'REMIT_PARTNERS_BASE', 'REMIT_CHAIN_RPC', 'POR_CHAIN_RPC', 'REMIT_PLATFORM_KEY_PATH', 'STONEHASH_CUTOVER_APPROVED'];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error('usage: node check-test-env.mjs <env file> [<env file> …]'); process.exit(2); }
  let bad = 0;
  for (const file of files) {
    const full = path.resolve(file);
    if (path.dirname(full) !== path.resolve(HERE, '..') || !path.basename(full).startsWith('.env.')) {
      console.error(`${file}: not a settings file of this module (apps/core-java/.env.*)`); bad++; continue;
    }
    const found = problems(readEnvFile(full));
    if (found.length === 0) console.log(`${path.basename(full)}: safe for a test server (looked at ${CHECKED.join(', ')})`);
    else { bad++; for (const p of found) console.error(`${path.basename(full)}: ${p}`); }
  }
  process.exit(bad ? 1 : 0);
}
