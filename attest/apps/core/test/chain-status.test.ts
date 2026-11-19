/**
 * The settlement-chain lookup against a fake JSON-RPC node: every state the
 * console can show, and the two ways it must refuse to guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chainTxStatus } from '../src/remit/chain-status.ts';

const HASH = `0x${'ab'.repeat(32)}`;
const TOKEN = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const FROM = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TO = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const pad = (a: string): string => `0x${a.slice(2).padStart(64, '0')}`;

type Answers = Record<string, unknown>;

async function node(answers: Answers): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const { method } = JSON.parse(body) as { method: string };
      calls.push(method);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answers[method] ?? null }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${addr.port}`, calls, close: () => { server.closeAllConnections(); server.close(); } };
}

test('a mined transfer reports its block, its confirmations and the token movement', async () => {
  const n = await node({
    eth_getTransactionByHash: { blockNumber: '0x6', from: FROM, to: TOKEN },
    eth_getTransactionReceipt: { blockNumber: '0x6', status: '0x1', logs: [
      { address: TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(FROM), pad(TO)], data: '0x2e5ab2c0' },
    ] },
    eth_blockNumber: '0x8',
    eth_getBlockByNumber: { timestamp: '0x6731f5a0' },
  });
  try {
    const s = await chainTxStatus(n.url, 'eip155:31337', HASH);
    assert.equal(s.state, 'confirmed');
    assert.equal(s.block_number, 6);
    assert.equal(s.confirmations, 3, 'its own block and the two on top');
    assert.equal(s.block_time, new Date(0x6731f5a0 * 1000).toISOString());
    assert.deepEqual(s.transfer, { token: TOKEN, from: FROM, to: TO, amount: String(0x2e5ab2c0) });
    assert.equal(s.detail, undefined);
    assert.equal(s.chain, 'eip155:31337');
  } finally { n.close(); }
});

test('a reverted transaction is failed, not confirmed', async () => {
  const n = await node({
    eth_getTransactionByHash: { blockNumber: '0x2', from: FROM, to: TOKEN },
    eth_getTransactionReceipt: { blockNumber: '0x2', status: '0x0', logs: [] },
    eth_blockNumber: '0x2',
    eth_getBlockByNumber: { timestamp: '0x1' },
  });
  try {
    const s = await chainTxStatus(n.url, 'eip155:31337', HASH);
    assert.equal(s.state, 'failed');
    assert.equal(s.confirmations, 1);
    assert.match(s.detail ?? '', /reverted/);
    assert.equal(s.transfer, undefined);
  } finally { n.close(); }
});

test('broadcast but unmined is pending; unknown is not_found — and neither asks for more', async () => {
  const pending = await node({ eth_getTransactionByHash: { blockNumber: null, from: FROM, to: TOKEN } });
  try {
    const s = await chainTxStatus(pending.url, 'c', HASH);
    assert.equal(s.state, 'pending');
    assert.equal(s.block_number, undefined);
    assert.deepEqual(pending.calls, ['eth_getTransactionByHash']);
  } finally { pending.close(); }
  const unknown = await node({});
  try {
    const s = await chainTxStatus(unknown.url, 'c', HASH);
    assert.equal(s.state, 'not_found');
    assert.deepEqual(unknown.calls, ['eth_getTransactionByHash']);
  } finally { unknown.close(); }
});

test('a failed lookup says the node did not answer — never the RPC address or its credentials', async () => {
  // fetch quotes both of these in the error it throws: a URL carrying
  // credentials, and one that does not parse. That error used to be the
  // detail, and the detail goes to any tenant with a settlement.
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
  try {
    for (const rpc of ['https://rpcuser:s3cret@rpc.example:8545', '10.0.0.5:8545']) {
      const s = await chainTxStatus(rpc, 'eip155:31337', HASH);
      assert.equal(s.state, 'unreachable', rpc);
      assert.equal(s.detail, 'the chain node did not answer', rpc);
      const wire = JSON.stringify(s);
      for (const secret of ['s3cret', 'rpcuser', 'rpc.example', '10.0.0.5']) {
        assert.ok(!wire.includes(secret), `${secret} must not reach the caller: ${wire}`);
      }
    }
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2, 'each failure is logged');
  for (const l of logged) {
    assert.ok(!/s3cret|rpcuser|rpc\.example|10\.0\.0\.5/.test(l), `the log keeps the error's name only: ${l}`);
  }
});

test('no node, a dead node and a malformed hash are said, not guessed', async () => {
  assert.equal((await chainTxStatus('', 'c', HASH)).state, 'unreachable');
  const dead = await chainTxStatus('http://127.0.0.1:9', 'c', HASH);
  assert.equal(dead.state, 'unreachable');
  assert.ok(dead.detail);
  const n = await node({});
  try {
    const bad = await chainTxStatus(n.url, 'c', '0x1234');
    assert.equal(bad.state, 'not_found');
    assert.deepEqual(n.calls, [], 'a value that is not a hash never reaches the node');
  } finally { n.close(); }
});
