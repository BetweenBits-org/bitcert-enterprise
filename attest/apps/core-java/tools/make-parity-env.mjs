/**
 * Writes the settings file of the Java server of a comparison run: a
 * development file, with a wallet that does not exist.
 *
 *   node apps/core-java/tools/make-parity-env.mjs <dev env file> <parity env file> [wallet name]
 *
 * The comparison (parity/run.mjs) sends both servers requests that the
 * inscription routes must refuse — and now and then a build in which one of
 * those rules is broken on purpose, to see that the comparison notices. A
 * server that holds a wallet which can pay would then really inscribe: coins
 * spent, a document on a chain. So the Java server of a comparison run is
 * given the name of a wallet the node does not have, as the reference server
 * of the run always was: whatever gets past the service's own checks ends at
 * the node, which signs nothing for a wallet it does not hold.
 *
 * Every other line is kept. The node is asked (with the file's own address
 * and credentials) whether it knows a wallet of that name, loaded or not,
 * and the file is not written if it does. The new file is readable by its
 * owner alone. No value but the wallet's name is printed.
 */
import fs from 'node:fs';

const [from, to, name = 'attest-parity-none'] = process.argv.slice(2);
if (!from || !to) { console.error('usage: node make-parity-env.mjs <dev env file> <parity env file> [wallet name]'); process.exit(2); }
const lines = fs.readFileSync(from, 'utf8').split('\n');
const env = {};
for (const line of lines) { const t = line.trim(); const i = t.indexOf('='); if (t && !t.startsWith('#') && i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim(); }
if (!env.BITCOIND_WALLET) { console.error(`refusing: ${from} names no BITCOIND_WALLET`); process.exit(1); }

async function rpc(method, params = []) {
  const res = await fetch(`${(env.BITCOIND_URL || 'http://127.0.0.1:18443').replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.BITCOIND_USER ?? ''}:${env.BITCOIND_PASSWORD ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}
const known = new Set([...(await rpc('listwallets')), ...(await rpc('listwalletdir')).wallets.map((w) => w.name)]);
if (known.has(name)) { console.error(`refusing: the node has a wallet named ${name}; give a name it does not have`); process.exit(1); }

const out = lines.map((line) => (line.trim().startsWith('BITCOIND_WALLET=') ? `BITCOIND_WALLET=${name}` : line));
fs.writeFileSync(to, out.join('\n'), { mode: 0o600 });
fs.chmodSync(to, 0o600);
console.log(`wrote ${to} (owner-only): BITCOIND_WALLET=${name}, which the node does not have (${known.size} wallets known to it); the rest as in ${from}`);
