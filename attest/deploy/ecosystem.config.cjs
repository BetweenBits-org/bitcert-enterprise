/**
 * pm2 process definition.
 *
 * pm2 is already how the homepage runs on this host, so the service uses it too
 * rather than introducing a second supervisor. Nothing about the application
 * depends on it — `node src/main.ts` is the whole start command, and systemd or
 * a container would work identically.
 *
 * Configuration still comes from `apps/core/.env`: pm2 loads it here rather
 * than duplicating values, so the file stays the single place settings live and
 * `deploy/run-core.sh` and pm2 cannot drift apart.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps/core');

/** Minimal dotenv: `KEY=value`, `#` comments, no interpolation. */
function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const REPO = path.resolve(ROOT, '..');

module.exports = {
  apps: [{
    name: 'stonehash-attest-core',
    script: 'src/main.ts',
    interpreter: 'node',
    cwd: APP,
    env: readEnv(path.join(APP, '.env')),
    time: true,
    autorestart: true,
    // A crash loop should surface as a stopped process, not as an endless
    // restart that hides the cause in the log.
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 2000,
    kill_timeout: 6000,
    merge_logs: true,
  }, {
    /*
     * The settlement leg's chain. anvil is deterministic (fixed mnemonic),
     * so a restart reproduces the same accounts; the deployed mUSDC address
     * is re-checked by demo-partners on boot and redeployed if the chain is
     * fresh.
     */
    name: 'stonehash-anvil',
    script: `${process.env.HOME}/.foundry/bin/anvil`,
    args: '--port 8545 --chain-id 31337 --silent',
    interpreter: 'none',
    time: true,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    merge_logs: true,
  }, {
    // The three-customer portal: each tab is one target customer type's
    // integration, running on the public API/SDK surface only.
    name: 'stonehash-customers',
    script: 'server.mjs',
    interpreter: 'node',
    cwd: path.join(REPO, 'demo-customers'),
    time: true,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 2000,
    merge_logs: true,
  }, {
    // Receiving-side estate: Triple-A-profile BFI + SG payout bank +
    // settlement wallet. Needs anvil (above) and provisioning (setup.mjs).
    name: 'stonehash-partners',
    script: 'server.mjs',
    interpreter: 'node',
    cwd: path.join(REPO, 'demo-partners'),
    time: true,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 2000,
    merge_logs: true,
  }, {
    // The demo bank's Java back end (:3500): the same bank as the customers
    // portal's bank tab, but a JVM calling the Java SDK — what a bank whose
    // systems are Java runs. Build first: demo-bank-java/build.sh (which
    // needs attest/sdks/attest-remit-java/build.sh). It runs from its own
    // copy of the SDK jar, so rebuilding the SDK does not disturb it.
    name: 'stonehash-bank-java',
    script: 'java',
    args: '-cp lib/stonehash-attest-remit-0.1.0.jar:build BankDemo',
    interpreter: 'none',
    cwd: path.join(REPO, 'demo-bank-java'),
    env: { PORT: '3500' },
    time: true,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 2000,
    merge_logs: true,
  }, {
    /*
     * Read-only JSON-RPC in front of anvil, for the settlement-chain explorer
     * (Otterscan, docker `stonehash-evm-explorer` on :5106 — evm-explorer/up.sh).
     * Loopback only: anvil's accounts are unlocked, so anvil itself is never
     * exposed; this forwards only methods that read.
     */
    name: 'stonehash-evm-gateway',
    script: 'serve.mjs',
    interpreter: 'node',
    cwd: path.join(REPO, 'evm-explorer'),
    time: true,
    autorestart: true,
    max_restarts: 5,
    min_uptime: '10s',
    restart_delay: 2000,
    merge_logs: true,
  }],
};
