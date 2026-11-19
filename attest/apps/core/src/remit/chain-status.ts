/**
 * What the settlement chain says about one transfer, right now.
 *
 * The same idea as the Bitcoin lookup on the records screen: the settlement's
 * state is what we recorded; this is the node's answer this second, and when
 * the two disagree the disagreement is the information. A bank waiting on a
 * transfer wants to see it move from "sent" to "in a block" to "N
 * confirmations" before the platform reports anything, and on a chain no
 * public explorer indexes — the sandbox rail is a local test chain — this is
 * the only place that answer can come from.
 *
 * Read-only by construction: four `eth_` reads, no account, no key. The RPC
 * stays on the server; the browser never learns its address, which matters on
 * a dev chain whose accounts are unlocked — and that includes the error text
 * of a failed call, which is why no error message is ever passed through.
 */
export type ChainTxState = 'confirmed' | 'failed' | 'pending' | 'not_found' | 'unreachable';

export interface ChainTxStatus {
  tx_hash: string;
  /** CAIP-2 label of the chain asked, e.g. `eip155:31337`. */
  chain: string;
  state: ChainTxState;
  block_number?: number;
  /** Blocks on top of it, counting its own: 1 the moment it lands. */
  confirmations?: number;
  block_time?: string;
  /** The ERC-20 transfer the transaction carried, read from its first Transfer log. */
  transfer?: { token: string; from: string; to: string; amount: string };
  /** Why the answer is partial — never set on a plain `confirmed`. */
  detail?: string;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface RpcTx { blockNumber: string | null; from: string; to: string | null }
interface RpcReceipt {
  blockNumber: string; status?: string;
  logs: { address: string; topics: string[]; data: string }[];
}
interface RpcBlock { timestamp: string }

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json() as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message ?? 'error'}`);
  return json.result as T;
}

const hexNum = (h: string): number => Number.parseInt(h, 16);
/** The last 20 bytes of a 32-byte topic, as an address. */
const topicAddress = (topic: string): string => `0x${topic.slice(-40)}`;

export async function chainTxStatus(rpcUrl: string, chain: string, txHash: string): Promise<ChainTxStatus> {
  const base = { tx_hash: txHash, chain };
  if (!TX_HASH.test(txHash)) return { ...base, state: 'not_found', detail: 'not a transaction hash of this chain' };
  if (!rpcUrl) return { ...base, state: 'unreachable', detail: 'no RPC is configured for the settlement chain' };
  try {
    const tx = await rpc<RpcTx | null>(rpcUrl, 'eth_getTransactionByHash', [txHash]);
    if (!tx) return { ...base, state: 'not_found', detail: 'the node does not know this transaction' };
    if (!tx.blockNumber) return { ...base, state: 'pending', detail: 'broadcast, not yet in a block' };
    const [receipt, head] = await Promise.all([
      rpc<RpcReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash]),
      rpc<string>(rpcUrl, 'eth_blockNumber', []),
    ]);
    if (!receipt) return { ...base, state: 'pending', detail: 'in a block, receipt not yet available' };
    const height = hexNum(receipt.blockNumber);
    const block = await rpc<RpcBlock | null>(rpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    const log = receipt.logs.find((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3);
    return {
      ...base,
      // Pre-Byzantium receipts have no status; every chain this rail runs on does.
      state: receipt.status === '0x0' ? 'failed' : 'confirmed',
      block_number: height,
      confirmations: Math.max(1, hexNum(head) - height + 1),
      ...(block ? { block_time: new Date(hexNum(block.timestamp) * 1000).toISOString() } : {}),
      ...(log ? { transfer: {
        token: log.address, from: topicAddress(log.topics[1]!), to: topicAddress(log.topics[2]!),
        amount: BigInt(log.data === '0x' ? 0 : log.data).toString(),
      } } : {}),
      ...(receipt.status === '0x0' ? { detail: 'the transaction was mined and reverted' } : {}),
    };
  } catch (e) {
    /*
     * A fixed sentence, never the error. Node's fetch quotes the URL when it
     * carries `user:pass@` or does not parse, so the message can be the RPC
     * address with its credentials — and this answer goes to any tenant with
     * a settlement. The log gets the error's name, enough to tell a timeout
     * from a refusal, and no more.
     */
    console.error(`settlement chain lookup failed (${chain}): ${e instanceof Error ? e.name : typeof e}`);
    return { ...base, state: 'unreachable', detail: 'the chain node did not answer' };
  }
}
