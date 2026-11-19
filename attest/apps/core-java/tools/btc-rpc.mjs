/**
 * A bitcoind JSON-RPC helper for the tools here. The node's address and
 * credentials come from an env file (the live core's by default — the
 * regtest node is one node; which WALLET a call names is what matters) and
 * are never printed.
 *
 * Wallets on that node: `attest` is the live core's — tools read it, and the
 * one tool that ever spent from it is fund-java-wallet.mjs; `attest-java` is
 * the Java core's; `beecert` and `regtest` are not ours and are never named.
 */
import fs from 'node:fs';
export function env(file = new URL('../../core/.env', import.meta.url).pathname) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const e = env();
const URL_ = e.BITCOIND_URL || 'http://127.0.0.1:18443';
const AUTH = `Basic ${Buffer.from(`${e.BITCOIND_USER ?? ''}:${e.BITCOIND_PASSWORD ?? ''}`).toString('base64')}`;
export async function rpc(method, params = [], wallet = '') {
  const res = await fetch(URL_.replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
}
