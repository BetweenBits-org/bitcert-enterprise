/**
 * The gateway's one promise: nothing that writes, signs or administers the
 * chain gets through — alone, in a batch, or disguised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { allowed, filterBody, createGateway } from './gateway.mjs';

test('reads are allowed; writes, signing and node administration are not', () => {
  for (const m of ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_call',
    'ots_getApiLevel', 'ots_traceTransaction', 'erigon_getHeaderByNumber']) assert.ok(allowed(m), m);
  for (const m of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_signTransaction',
    'eth_signTypedData', 'eth_signTypedData_v4', 'personal_sign', 'personal_unlockAccount', 'eth_accounts',
    'anvil_setBalance', 'anvil_impersonateAccount', 'anvil_mine', 'anvil_reset', 'anvil_setCode', 'anvil_loadState',
    'hardhat_setBalance', 'evm_mine', 'evm_revert', 'evm_setNextBlockTimestamp', 'debug_traceTransaction',
    'txpool_content', 'admin_nodeInfo', 'miner_start',
    'ETH_SENDTRANSACTION', ' eth_call', 'eth_call ', 'ots_', 'ots_x.anvil_mine', 'ots_\u0000', 'ots_getApiLevel\n',
    '', null, 42, ['eth_call'], { m: 'eth_call' }]) assert.equal(allowed(m), false, JSON.stringify(m));
});

test('only the checked fields are forwarded, and the last duplicate key is the one checked', () => {
  // JSON.parse keeps the last of two "method" keys; what is forwarded is that same parsed value.
  const body = JSON.parse('{"jsonrpc":"2.0","id":1,"method":"eth_sendTransaction","method":"eth_blockNumber","params":[],"extra":"x"}');
  const { forward, refused } = filterBody(body);
  assert.deepEqual(forward, [{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }]);
  assert.deepEqual(refused, []);
  const sneaky = JSON.parse('{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","method":"anvil_mine"}');
  assert.equal(filterBody(sneaky).forward.length, 0, 'the value that would be forwarded is the value that was checked');
});

test('a batch is filtered call by call', () => {
  const { batch, forward, refused } = filterBody([
    { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
    { jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction', params: [{ from: '0x0' }] },
    { jsonrpc: '2.0', id: 3, method: 'ots_getApiLevel', params: [] },
    { jsonrpc: '2.0', id: 4, method: 'anvil_setBalance', params: ['0x0', '0x1'] },
    [{ jsonrpc: '2.0', id: 5, method: 'eth_sendTransaction' }],
  ]);
  assert.equal(batch, true);
  assert.deepEqual(forward.map((c) => c.method), ['eth_blockNumber', 'ots_getApiLevel']);
  assert.equal(refused.length, 3);
  assert.ok(refused.every((r) => r.error));
});

test('end to end: the node only ever sees reads', async () => {
  const seen = [];
  const node = createServer((req, res) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      const b = JSON.parse(s);
      const calls = Array.isArray(b) ? b : [b];
      seen.push(...calls.map((c) => c.method));
      const out = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x6' }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(b) ? out : out[0]));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => node.once('listening', r));
  const gw = createGateway({ upstream: `http://127.0.0.1:${node.address().port}` }).listen(0, '127.0.0.1');
  await new Promise((r) => gw.once('listening', r));
  const url = `http://127.0.0.1:${gw.address().port}/rpc`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    const single = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))).json();
    assert.equal(single.result, '0x6');
    const write = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction', params: [{}] }))).json();
    assert.equal(write.error.code, -32601);
    const mixed = await (await post(JSON.stringify([
      { jsonrpc: '2.0', id: 3, method: 'anvil_mine' }, { jsonrpc: '2.0', id: 4, method: 'eth_chainId' },
    ]))).json();
    assert.equal(mixed.length, 2);
    assert.deepEqual(mixed.find((r) => r.id === 4), { jsonrpc: '2.0', id: 4, result: '0x6' });
    assert.equal(mixed.find((r) => r.id === 3).error.code, -32601);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await fetch(url)).status, 405, 'only POST');
    assert.deepEqual(seen, ['eth_blockNumber', 'eth_chainId'], 'the node saw reads and nothing else');
  } finally { gw.close(); node.close(); }
});

test('the rate limit counts calls that reach the node, so a batch cannot multiply it', async () => {
  let upstreamCalls = 0;
  const node = createServer((req, res) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      const b = JSON.parse(s);
      const calls = Array.isArray(b) ? b : [b];
      upstreamCalls += calls.length;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(b) ? calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' })) : { jsonrpc: '2.0', id: b.id, result: '0x1' }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => node.once('listening', r));
  const gw = createGateway({ upstream: `http://127.0.0.1:${node.address().port}`, rate: { windowMs: 60_000, max: 150 } }).listen(0, '127.0.0.1');
  await new Promise((r) => gw.once('listening', r));
  const url = `http://127.0.0.1:${gw.address().port}/rpc`;
  const batch = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_blockNumber' })));
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  try {
    assert.equal((await post(batch)).status, 200, 'the first hundred fit in a budget of 150');
    assert.equal((await post(batch)).status, 429, 'the second hundred would exceed it');
    assert.equal(upstreamCalls, 100, 'the refused batch never reached the node');
    const refusedOnly = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'anvil_mine' }))).json();
    assert.equal(refusedOnly.error.code, -32601, 'a call refused here costs nothing and is answered, even over budget');
  } finally { gw.close(); node.close(); }
});
