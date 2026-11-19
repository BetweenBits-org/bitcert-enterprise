/**
 * The anchor backend seam.
 *
 * This interface is the reason "regtest now, mainnet when a customer subscribes"
 * is a configuration change rather than a migration. Batching, bundling,
 * Merkle aggregation and verification all sit above it and know nothing about
 * which chain is underneath; swapping the implementation swaps the chain.
 *
 * What a backend owns: turning a 32-byte commitment into a transaction on some
 * chain, and reporting that transaction's state. What it must never own:
 * deciding what to commit, or what the result means.
 */

/** Opaque handle a backend hands back so it can later find its own submission. */
export interface AnchorHandle {
  txid: string;
  /** Full raw transaction hex. Required — bundles need it for offline binding. */
  rawTxHex: string;
  /** The anchor output payload, so the assembler need not re-parse the tx. */
  anchorPayloadHex: string;
}

export interface AnchorState {
  status: 'pending' | 'confirmed';
  blockHeight?: number;
  /** Display (big-endian) order, as explorers quote it. */
  blockHash?: string;
  confirmations?: number;
}

export interface AnchorBackend {
  /** `regtest` | `mainnet` — written verbatim into every bundle. */
  readonly network: 'regtest' | 'mainnet';
  /** Human label for logs and the admin view. */
  readonly name: string;
  /** Commit 32 bytes to the chain. Throws if it cannot be broadcast. */
  submit(payload: Uint8Array): Promise<AnchorHandle>;
  /** Current state of a prior submission. */
  poll(handle: AnchorHandle): Promise<AnchorState>;
  /** Reachability probe for `/healthz`. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
