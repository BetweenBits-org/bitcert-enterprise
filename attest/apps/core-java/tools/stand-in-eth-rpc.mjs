/**
 * A stand-in for the reserve chain's node: one method (`eth_call` of
 * `balanceOf`), answered from a table, so that two services can be asked to
 * measure the same reserves and be given the same answers — without either
 * ever reading the deployment's own node.
 *
 *   node apps/core-java/tools/stand-in-eth-rpc.mjs [--port 8793]
 *
 * Which answer a request gets is decided by the token contract it names
 * (`params[0].to`); see TOKENS below, which the parity cases import. A
 * balance is a function of the holder alone, so both services read the same
 * figure for the same address.
 *
 * It also stands in for the settlement chain's node: the four reads behind
 * `GET /v1/settlements/:id/chain` (`eth_getTransactionByHash`,
 * `eth_getTransactionReceipt`, `eth_blockNumber`, `eth_getBlockByNumber`),
 * answered from the transaction hash alone — see TX, TX_FAULT_AT, TX_FAULT,
 * `txHash` and `txFacts` below, which the partner stand-in and the cases
 * import. Any other method is answered "does not exist", as before.
 *
 *   GET  /log          every request received: who sent it (the User-Agent), and its body
 *   GET  /log/summary  the bodies each sender sent, as multisets, and whether the two services sent the same
 *   POST /log/clear
 *
 * It listens on 127.0.0.1 only and holds nothing but what it was sent.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
export const PORT = 8793;
const token = (n) => `0x${n.toString(16).padStart(40, '0')}`;
/** The token contracts this node knows, by what it does when asked about them. */
export const TOKENS = {
  balance: token(0xa1), // the holder's balance: the last eight hex digits of the address, in millions
  reverted: token(0xe1), // a JSON-RPC error with a message
  page: token(0xe2), // a page of HTML where JSON belongs
  nothing: token(0xe3), // the JSON value null
  empty: token(0xe4), // an answer with neither a result nor an error
  slow: token(0xe5), // the balance, after longer than a read may take
  cut: token(0xe6), // the connection closed without an answer
  decimal: token(0xe7), // a balance written in decimal
  words: token(0xe8), // a result that is no number
  failing: token(0xe9), // the balance, under a status of 500
  negative: token(0xea), // a balance below zero
};
/** The balance this node reports for a holder: a function of the address alone. */
export const balanceOf = (holder) => {
  const tail = holder.toLowerCase().replace(/^0x/, '').slice(-8);
  return /^[0-9a-f]+$/.test(tail) ? BigInt(`0x${tail}`) * 1_000_000n : 0n;
};

// ── the settlement chain: the four reads of GET /v1/settlements/:id/chain (apps/core/src/remit/chain-status.ts) ──
//
// eth_getTransactionByHash, eth_getTransactionReceipt, eth_blockNumber, eth_getBlockByNumber — answered from the
// transaction hash alone, so that two services asked about the same settlement are told the same thing whenever
// they ask. The first byte of a hash says what the node knows about the transaction (TX), the second where a read
// about it goes wrong and how (TX_FAULT_AT, TX_FAULT); the rest tells transactions apart. `txHash` makes such a
// hash, `txFacts` reads one. A block's time and a transfer's parties and amount are functions of the hash as well.
// One read names no transaction: eth_blockNumber. It is answered with HEAD — except right after a transaction
// whose fault is "at the head" was asked for (eth_getTransactionByHash), which is how that fault is reached.

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The height this node reports. Blocks of confirmed transactions lie below it (1000 … 9999). */
export const HEAD = 10_000;
/** What the node knows about a transaction: the first byte of its hash. Any other first byte: nothing (`unknown`). */
export const TX = {
  unknown: 0x00, // not known to the node (null)
  pool: 0x01, // known, not yet in a block
  noReceipt: 0x02, // in a block, its receipt not yet there (null)
  confirmed: 0x10, // in a block, succeeded, one Transfer log
  confirmedNoLog: 0x11, // … no log at all
  confirmedOtherLog: 0x12, // … logs, none of them a Transfer of three topics (an approval, a token-id transfer of four)
  confirmedZero: 0x13, // … a Transfer whose data is `0x`
  confirmedNoStatus: 0x14, // … a receipt without `status` (a chain before Byzantium)
  confirmedNoBlock: 0x15, // … in a block the node cannot show (null)
  confirmedAhead: 0x16, // … in a block above the height the node reports
  confirmedSecond: 0x17, // … the Transfer is the second log, after an approval
  confirmedUpper: 0x18, // … the Transfer's topic written in capitals
  failed: 0x20, // in a block, reverted (status 0x0), no log
  failedWithLog: 0x21, // … reverted, and a Transfer log all the same
};
/** Which of the four reads goes wrong: the high half of the second byte. */
export const TX_FAULT_AT = { tx: 1, receipt: 2, block: 3, head: 4 };
/** How it goes wrong: the low half of the second byte. */
export const TX_FAULT = {
  error: 1, // a JSON-RPC error with a message
  http500: 2, // the answer, under a status of 500
  page: 3, // a page of HTML where JSON belongs, under 200
  gateway: 4, // a page of HTML under 502
  slow: 5, // the answer, after longer than a read may take (5.6 s)
  cut: 6, // the connection closed without an answer
  empty: 7, // an answer with neither a result nor an error
  nothing: 8, // the JSON value null
};
const TX_NAME = Object.fromEntries(Object.entries(TX).map(([name, code]) => [code, name]));
const FAULT_AT_NAME = Object.fromEntries(Object.entries(TX_FAULT_AT).map(([name, code]) => [code, name]));
const FAULT_NAME = Object.fromEntries(Object.entries(TX_FAULT).map(([name, code]) => [code, name]));
const sha256hex = (text) => createHash('sha256').update(text).digest('hex');
const hex2 = (n) => n.toString(16).padStart(2, '0');
/** The token contract every Transfer log of this node names (the mock chain's USDC address). */
export const SETTLEMENT_TOKEN = `0x${'f0'.repeat(20)}`;

/**
 * A transaction hash of the given kind (a name of TX), told apart from others of its kind by `seed`; `fault` is
 * `{ at, how }` (names of TX_FAULT_AT and TX_FAULT) or absent.
 */
export function txHash(kind, seed = '', fault = null) {
  if (!(kind in TX)) throw new Error(`no such kind of transaction: ${kind}`);
  if (fault && (!(fault.at in TX_FAULT_AT) || !(fault.how in TX_FAULT))) throw new Error(`no such fault: ${JSON.stringify(fault)}`);
  return `0x${hex2(TX[kind])}${hex2(fault ? (TX_FAULT_AT[fault.at] << 4) | TX_FAULT[fault.how] : 0)}${sha256hex(`stand-in transaction\n${seed}`).slice(0, 60)}`;
}

/** What this node says about a transaction hash: `null` when it is not a hash of 32 bytes. */
export function txFacts(hash) {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const h = hash.slice(2).toLowerCase();
  const kind = TX_NAME[parseInt(h.slice(0, 2), 16)] ?? 'unknown';
  const second = parseInt(h.slice(2, 4), 16);
  const fault = FAULT_AT_NAME[second >> 4] && FAULT_NAME[second & 15] ? { at: FAULT_AT_NAME[second >> 4], how: FAULT_NAME[second & 15] } : null;
  const n = parseInt(h.slice(4, 8), 16);
  const inBlock = kind !== 'unknown' && kind !== 'pool';
  const block = !inBlock ? null
    : fault?.at === 'block' ? 20_000 + TX_FAULT[fault.how] * 1000 + (n % 1000)
      : kind === 'confirmedNoBlock' ? 30_000 + (n % 1000)
        : kind === 'confirmedAhead' ? HEAD + 1 + (n % 100)
          : 1000 + (n % 9000);
  return {
    hash: `0x${h}`, kind, fault, block,
    from: `0x${h.slice(8, 48)}`, to: `0x${h.slice(24, 64)}`,
    /** In the token's smallest unit: a whole number of cents of a six-decimal token. */
    amount: BigInt(`0x${h.slice(56, 64)}`) * 10_000n,
  };
}
/** The time of a block, in seconds: a function of its number. */
export const blockTime = (number) => 1_780_000_000 + number * 12;

const log = [];
const reply = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
const rpc = (id, fields) => JSON.stringify({ jsonrpc: '2.0', id, ...fields });

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && req.url === '/log') return reply(res, 200, JSON.stringify(log));
    if (req.method === 'POST' && req.url === '/log/clear') { log.length = 0; return reply(res, 200, '{"cleared":true}'); }
    if (req.method === 'GET' && req.url === '/log/summary') {
      const bySender = {};
      for (const e of log) (bySender[e.sender] ??= []).push(e.body);
      const senders = Object.keys(bySender).sort();
      const sorted = senders.map((s) => [...bySender[s]].sort());
      const same = senders.length === 2 && JSON.stringify(sorted[0]) === JSON.stringify(sorted[1]);
      return reply(res, 200, JSON.stringify({ senders: Object.fromEntries(senders.map((s) => [s, bySender[s].length])), same }));
    }
    const sender = /^node/i.test(req.headers['user-agent'] ?? '') ? 'reference (node)' : /java/i.test(req.headers['user-agent'] ?? '') ? 'java' : (req.headers['user-agent'] ?? 'unknown');
    log.push({ at: new Date().toISOString(), sender, method: req.method, contentType: req.headers['content-type'] ?? null, body });
    try { answer(req, res, body); } catch (e) { reply(res, 200, rpc(null, { error: { code: -32603, message: `the stand-in could not answer: ${e.message}` } })); }
  });
});

/** One `eth_call`, answered by what the token contract it names is for. Whatever was sent, the node stays up. */
function answer(req, res, body) {
    let call;
    try { call = JSON.parse(body); } catch { return reply(res, 400, rpc(null, { error: { code: -32700, message: 'parse error' } })); }
    if (CHAIN_READS[call?.method]) return chainRead(req, res, call);
    const to = String(call?.params?.[0]?.to ?? '').toLowerCase();
    const data = String(call?.params?.[0]?.data ?? '');
    if (call?.method !== 'eth_call') return reply(res, 200, rpc(call?.id ?? null, { error: { code: -32601, message: `the method ${call?.method} does not exist` } }));
    const holder = `0x${data.slice(-40)}`;
    const amount = `0x${balanceOf(holder).toString(16).padStart(64, '0')}`;
    switch (to) {
      case TOKENS.balance: return reply(res, 200, rpc(call.id, { result: amount }));
      case TOKENS.reverted: return reply(res, 200, rpc(call.id, { error: { code: 3, message: 'execution reverted' } }));
      case TOKENS.page: return reply(res, 502, '<html><body>502 Bad Gateway</body></html>', 'text/html');
      case TOKENS.nothing: return reply(res, 200, 'null');
      case TOKENS.empty: return reply(res, 200, rpc(call.id, {}));
      case TOKENS.slow: return void setTimeout(() => reply(res, 200, rpc(call.id, { result: amount })), 5_600);
      case TOKENS.cut: return void req.socket.destroy();
      case TOKENS.decimal: return reply(res, 200, rpc(call.id, { result: balanceOf(holder).toString() }));
      case TOKENS.words: return reply(res, 200, rpc(call.id, { result: 'not a number' }));
      case TOKENS.failing: return reply(res, 500, rpc(call.id, { result: amount }));
      case TOKENS.negative: return reply(res, 200, rpc(call.id, { result: `-${balanceOf(holder).toString()}` }));
      default: return reply(res, 200, rpc(call.id, { error: { code: -32000, message: `no contract at ${to}` } }));
    }
}

/** The four reads of the settlement chain, by the place a fault can name. */
const CHAIN_READS = { eth_getTransactionByHash: 'tx', eth_getTransactionReceipt: 'receipt', eth_getBlockByNumber: 'block', eth_blockNumber: 'head' };
/** keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** The transaction most recently asked for: eth_blockNumber names none, so a fault "at the head" is taken from it. */
let lastAsked = null;
const quantity = (n) => `0x${n.toString(16)}`;
const word = (hexDigits) => `0x${hexDigits.padStart(64, '0')}`;
const blockHashOf = (number) => `0x${sha256hex(`stand-in block\n${number}`)}`;

/** `result`, or the same read gone wrong in the manner `how`. */
function answerRead(req, res, id, how, result) {
  switch (how) {
    case 'error': return reply(res, 200, rpc(id, { error: { code: -32000, message: 'the stand-in node refuses this read' } }));
    case 'http500': return reply(res, 500, rpc(id, { result }));
    case 'page': return reply(res, 200, '<html><body>the node is behind a page</body></html>', 'text/html');
    case 'gateway': return reply(res, 502, '<html><body>502 Bad Gateway</body></html>', 'text/html');
    case 'slow': return void setTimeout(() => reply(res, 200, rpc(id, { result })), 5_600);
    case 'cut': return void req.socket.destroy();
    case 'empty': return reply(res, 200, rpc(id, {}));
    case 'nothing': return reply(res, 200, 'null');
    default: return reply(res, 200, rpc(id, { result }));
  }
}

/** One of the four reads, answered from the transaction hash (or the block number) it names. */
function chainRead(req, res, call) {
  const id = call.id ?? null;
  const at = CHAIN_READS[call.method];
  if (at === 'head') return answerRead(req, res, id, lastAsked?.fault?.at === 'head' ? lastAsked.fault.how : 'ok', quantity(HEAD));
  if (at === 'block') {
    const number = Number.parseInt(String(call.params?.[0] ?? ''), 16);
    if (!Number.isInteger(number)) return reply(res, 200, rpc(id, { error: { code: -32602, message: 'not a block number' } }));
    if (number >= 30_000 && number < 31_000) return reply(res, 200, rpc(id, { result: null }));
    const how = number >= 20_000 && number < 30_000 ? FAULT_NAME[Math.floor((number - 20_000) / 1000)] ?? 'ok' : 'ok';
    return answerRead(req, res, id, how, { number: quantity(number), hash: blockHashOf(number), timestamp: quantity(blockTime(number)), transactions: [] });
  }
  const facts = txFacts(call.params?.[0]);
  if (!facts) return reply(res, 200, rpc(id, { error: { code: -32602, message: 'not a transaction hash' } }));
  if (at === 'tx') lastAsked = facts;
  const how = facts.fault?.at === at ? facts.fault.how : 'ok';
  if (facts.kind === 'unknown') return answerRead(req, res, id, how, null);
  const inBlock = facts.block === null ? { blockNumber: null, blockHash: null } : { blockNumber: quantity(facts.block), blockHash: blockHashOf(facts.block) };
  if (at === 'tx') return answerRead(req, res, id, how, { hash: facts.hash, ...inBlock, from: facts.from, to: SETTLEMENT_TOKEN, value: '0x0', input: '0x' });
  // The receipt.
  if (facts.kind === 'pool' || facts.kind === 'noReceipt') return answerRead(req, res, id, how, null);
  const parties = [word(facts.from.slice(2)), word(facts.to.slice(2))];
  const transfer = { address: SETTLEMENT_TOKEN, topics: [TRANSFER_TOPIC, ...parties], data: word(facts.amount.toString(16)) };
  const approval = { address: SETTLEMENT_TOKEN, topics: [APPROVAL_TOPIC, ...parties], data: word('ff') };
  const tokenId = { address: SETTLEMENT_TOKEN, topics: [TRANSFER_TOPIC, ...parties, word('7')], data: '0x' };
  const logs = {
    confirmed: [transfer], confirmedNoLog: [], confirmedOtherLog: [approval, tokenId], confirmedZero: [{ ...transfer, data: '0x' }], confirmedNoStatus: [transfer],
    confirmedNoBlock: [transfer], confirmedAhead: [transfer], confirmedSecond: [approval, transfer],
    confirmedUpper: [{ ...transfer, topics: [`0x${TRANSFER_TOPIC.slice(2).toUpperCase()}`, ...parties] }], failed: [], failedWithLog: [transfer],
  }[facts.kind];
  const reverted = facts.kind === 'failed' || facts.kind === 'failedWithLog';
  return answerRead(req, res, id, how, { transactionHash: facts.hash, ...inBlock, from: facts.from, to: SETTLEMENT_TOKEN,
    ...(facts.kind === 'confirmedNoStatus' ? {} : { status: reverted ? '0x0' : '0x1' }), logs });
}

if (process.argv[1]?.endsWith('stand-in-eth-rpc.mjs')) {
  const port = Number(arg('--port') ?? PORT);
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'stand-in reserve node listening', port })));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
