/**
 * Read-only JSON-RPC gateway in front of the sandbox's settlement chain.
 *
 * The explorer (Otterscan) is a static page that speaks JSON-RPC from the
 * visitor's browser, so *some* RPC has to be reachable from the internet. The
 * chain's own cannot be: anvil's dev accounts are unlocked, so
 * `eth_sendTransaction`, `eth_sign` or any `anvil_*` call from anyone would
 * move, mint or rewrite the demo's money. This gateway is what is reachable
 * instead — bound to loopback, behind the explorer's nginx on the same origin
 * (`/rpc`) — and it forwards only methods that read.
 *
 * What is checked is what is sent: the body is parsed, every call is rebuilt
 * from {jsonrpc, id, method, params} alone, and only an allow-listed method
 * name goes upstream. A batch is filtered call by call; a refused call gets a
 * JSON-RPC error in its place.
 */
import { createServer } from 'node:http';

export const READ_METHODS = new Set([
  'web3_clientVersion', 'net_version', 'eth_chainId', 'eth_syncing', 'eth_blockNumber',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getProof',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByHash', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_getUncleCountByBlockNumber', 'eth_getUncleCountByBlockHash',
  // Simulations: executed against a copy of state and never committed.
  'eth_call', 'eth_estimateGas',
  'erigon_getHeaderByNumber', 'erigon_getHeaderByHash', 'erigon_getBlockByTimestamp',
  'erigon_getBlockReceiptsByBlockHash',
  'trace_transaction', 'trace_block', 'trace_replayTransaction', 'trace_replayBlockTransactions',
]);

/** The Otterscan API (`ots_*`) is read-only by design; its names are plain identifiers. */
export function allowed(method) {
  if (typeof method !== 'string') return false;
  if (READ_METHODS.has(method)) return true;
  return /^ots_[A-Za-z0-9]+$/.test(method);
}

const refusal = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const MAX_BATCH = 100;

/**
 * Split a parsed body into what may go upstream and the answers for what may
 * not. Each forwarded call carries only the four JSON-RPC fields, so nothing
 * but the checked method name reaches the node.
 */
export function filterBody(body) {
  const one = (c) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      return { refused: refusal(null, -32600, 'invalid request') };
    }
    const id = typeof c.id === 'number' || typeof c.id === 'string' ? c.id : null;
    if (id === null) return { refused: refusal(null, -32600, 'a call needs a string or number id') };
    if (c.params !== undefined && (c.params === null || typeof c.params !== 'object')) {
      return { refused: refusal(id, -32602, 'params must be an array or an object') };
    }
    if (!allowed(c.method)) {
      return { refused: refusal(id, -32601, 'method not available: this explorer gateway is read-only') };
    }
    return { forward: { jsonrpc: '2.0', id, method: c.method, ...(c.params !== undefined ? { params: c.params } : {}) } };
  };
  if (Array.isArray(body)) {
    if (body.length === 0) return { batch: true, forward: [], refused: [refusal(null, -32600, 'empty batch')] };
    if (body.length > MAX_BATCH) return { batch: true, forward: [], refused: [refusal(null, -32600, `at most ${MAX_BATCH} calls per batch`)] };
    const parts = body.map(one);
    return { batch: true, forward: parts.filter((p) => p.forward).map((p) => p.forward), refused: parts.filter((p) => p.refused).map((p) => p.refused) };
  }
  const p = one(body);
  return { batch: false, forward: p.forward ? [p.forward] : [], refused: p.refused ? [p.refused] : [] };
}

/**
 * A fixed window per client, charged per call that would reach the node — a
 * batch of a hundred costs a hundred, or one request could multiply the load
 * on the chain the live settlement rail also uses. Nothing is charged for a
 * call that is refused here.
 */
function limiter(windowMs, max) {
  const hits = new Map();
  return (key, weight = 1) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    if (h.n + weight > max) return false;
    h.n += weight;
    return true;
  };
}

export function createGateway({ upstream, maxBody = 256 * 1024, rate = { windowMs: 60_000, max: 1200 } }) {
  const allow = limiter(rate.windowMs, rate.max);
  const send = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  };
  return createServer((req, res) => {
    if (req.method !== 'POST' || !['/rpc', '/'].includes((req.url ?? '/').split('?')[0])) {
      send(res, 405, refusal(null, -32600, 'POST JSON-RPC to /rpc'));
      return;
    }
    // nginx sets this header itself (it does not append), and the gateway
    // listens on loopback only, so the value is nginx's view of the client.
    const client = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) { send(res, 413, refusal(null, -32600, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(res, 400, refusal(null, -32700, 'parse error')); return; }
      const { batch, forward, refused } = filterBody(body);
      if (forward.length === 0) { send(res, 200, batch ? refused : refused[0]); return; }
      if (!allow(client, forward.length)) { send(res, 429, refusal(null, -32005, 'too many requests')); return; }
      fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch ? forward : forward[0]),
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json()).then((answer) => {
        if (!batch) { send(res, 200, answer); return; }
        send(res, 200, [...(Array.isArray(answer) ? answer : [answer]), ...refused]);
      }).catch((e) => {
        console.error('[evm-gateway] upstream failed:', e instanceof Error ? e.name : typeof e);
        send(res, 502, refusal(null, -32603, 'the chain node did not answer'));
      });
    });
    req.on('error', () => { res.destroy(); });
  });
}

