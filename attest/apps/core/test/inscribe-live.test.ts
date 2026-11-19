/**
 * The inscription, against a real bitcoind.
 *
 * Everything in `inscription.test.ts` is checkable offline, and all of it
 * passed while the reveal transaction was still being rejected by the node —
 * because a signature can be internally consistent and still wrong about the
 * sighash, the parity bit or the control block, and only a validating node
 * says so. This test is therefore the one that matters, and it is the reason
 * the others are not enough.
 *
 * Skipped, loudly, when no node is configured or reachable. A silent skip here
 * would let the producer rot behind a green suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWitnessItems, parseEnvelope } from '@stonehash/attest-verify';
import { inscribeDocument } from '../src/anchor/inscribe.ts';
import { DEFAULT_SOFT_CAP_BYTES, HARD_CEILING_BYTES } from '../src/btc/inscription.ts';
import { rpc } from '../src/anchor/rpc.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, '../.env');

function env(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const e = { ...env(), ...process.env } as Record<string, string | undefined>;
const rpcOpts = {
  url: e['BITCOIND_URL'] ?? '',
  user: e['BITCOIND_USER'] ?? '',
  password: e['BITCOIND_PASSWORD'] ?? '',
  timeoutMs: 8000,
};
const wallet = e['BITCOIND_WALLET'] ?? '';

async function reachable(): Promise<string | false> {
  if (!rpcOpts.url) return 'BITCOIND_URL is not set';
  try {
    const info = await rpc<{ chain: string }>(rpcOpts, 'getblockchaininfo');
    if (info.chain !== 'regtest') return `node is on ${info.chain}; this test only runs on regtest`;
    return false;
  } catch (err) {
    return `bitcoind unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const skip = await reachable();

test('a document goes onto the chain and comes back out of it', { skip }, async () => {
  // Spans several 520-byte pushes, so chunk reassembly is exercised on-chain
  // rather than only in the encoder's own tests.
  const body = new Uint8Array(Buffer.from(
    `StoneHash Attest — witness inscription conformance\n${'y'.repeat(1800)}\n`, 'utf8'));
  const digest = createHash('sha256').update(body).digest('hex');

  const r = await inscribeDocument({
    rpcOpts, wallet, network: 'regtest', body, contentType: 'text/plain; charset=utf-8',
  });

  // Acceptance by the node *is* the assertion: `sendrawtransaction` would have
  // thrown on a bad signature, a wrong parity bit or a mismatched tapleaf.
  assert.match(r.commitTxid, /^[0-9a-f]{64}$/);
  assert.match(r.revealTxid, /^[0-9a-f]{64}$/);
  assert.equal(r.anchorPayloadHex, digest, 'the anchor output must carry the document digest');

  // The node stored exactly the bytes we built — no re-serialisation in between.
  const mempoolHex = await rpc<string>(rpcOpts, 'getrawtransaction', [r.revealTxid]);
  assert.equal(mempoolHex, r.revealTxHex);

  const addr = await rpc<string>(rpcOpts, 'getnewaddress', [], wallet);
  await rpc<string[]>(rpcOpts, 'generatetoaddress', [1, addr], wallet);
  const confirmed = await rpc<{ confirmations: number; hex: string }>(
    rpcOpts, 'gettransaction', [r.revealTxid, true, true], wallet);
  assert.ok(confirmed.confirmations >= 1, 'the reveal should confirm in the block we just mined');

  // Link A, from the chain alone: pull the body out of the witness and bind it.
  const items = extractWitnessItems(confirmed.hex, r.witnessInputIndex);
  assert.ok(items && items.length === 3, 'reveal witness should be [sig, script, control]');
  const envelope = parseEnvelope(items[1]!);
  assert.ok(envelope, 'the tapscript should parse as an inscription envelope');
  assert.equal(Buffer.from(envelope.body).toString('hex'), Buffer.from(body).toString('hex'),
    'the document recovered from Bitcoin must be byte-identical to the one submitted');
  assert.equal(createHash('sha256').update(envelope.body).digest('hex'), r.anchorPayloadHex,
    'and must hash to the digest the txid commits to');
  assert.equal(Buffer.from(envelope.contentType).toString('latin1'), 'text/plain; charset=utf-8');
});

test('an oversized document is refused before any coin is committed', { skip }, async () => {
  // The order matters more than the limit. A size check that ran after the
  // commit was funded would leave coins in an output whose only spender is a
  // reveal the service just refused to build.
  await assert.rejects(inscribeDocument({
    rpcOpts, wallet, network: 'regtest',
    body: new Uint8Array(DEFAULT_SOFT_CAP_BYTES + 1), contentType: 'application/octet-stream',
  }), /inscription limit/);

  // Raising the cap for one call is allowed; the hard ceiling is not.
  await assert.rejects(inscribeDocument({
    rpcOpts, wallet, network: 'regtest',
    body: new Uint8Array(HARD_CEILING_BYTES + 1), contentType: 'application/octet-stream',
    maxBodyBytes: HARD_CEILING_BYTES * 2,
  }), /inscription limit/);
});

test('a document at the default cap still relays', { skip }, async () => {
  /*
   * The default soft cap is only a useful number if the node actually takes
   * one that size. This node runs `-acceptnonstdtxn=1` with raised mempool
   * limits, so it would also take far more — but the cap is meant to stay
   * inside what an *ordinary* node relays, and this checks the configured
   * value is reachable rather than aspirational.
   */
  const body = new Uint8Array(DEFAULT_SOFT_CAP_BYTES);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  const r = await inscribeDocument({
    rpcOpts, wallet, network: 'regtest', body, contentType: 'application/octet-stream',
  });
  const entry = await rpc<{ vsize: number; weight: number }>(
    rpcOpts, 'getmempoolentry', [r.revealTxid]);
  assert.equal(r.bodyLength, DEFAULT_SOFT_CAP_BYTES);
  // Under the 100,000 vB standard-relay ceiling, which is the whole point of
  // keeping the default where it is.
  assert.ok(entry.vsize < 100_000,
    `a default-sized inscription measured ${entry.vsize} vB, over standard relay`);
});
