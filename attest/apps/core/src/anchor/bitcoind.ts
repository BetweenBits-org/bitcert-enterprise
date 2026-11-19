/**
 * Anchor backend backed by a bitcoind wallet. Serves `regtest` today and
 * `mainnet` unchanged when a customer subscribes — the only difference is which
 * node the URL points at and the value of `network`.
 *
 * ## Why bitcoind funds and signs, not us
 *
 * The flow is `createrawtransaction` → `fundrawtransaction` →
 * `signrawtransactionwithwallet` → `sendrawtransaction`. bitcoind picks the
 * inputs, computes the fee, adds change and signs. That means:
 *
 * - **no private key ever enters this process**, so a compromise of the API
 *   cannot move coins;
 * - no fee estimator, coin selector or signer to write and get subtly wrong;
 * - the same code path works on mainnet, where those mistakes cost money.
 *
 * We contribute exactly one thing: the `OP_RETURN` output carrying the
 * commitment.
 */
import { opReturnScript, bytesToHex } from '../btc/tx.ts';
import { rpc } from './rpc.ts';
import type { RpcOptions } from './rpc.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from './backend.ts';

interface FundResult { hex: string; fee: number; changepos: number }
interface SignResult { hex: string; complete: boolean; errors?: { error: string }[] }
interface TxOut { scriptPubKey?: { hex?: string; type?: string } }
interface GetTxResult {
  txid: string;
  hex: string;
  confirmations?: number;
  blockhash?: string;
  blockheight?: number;
  vout?: TxOut[];
}
interface BlockchainInfo { chain: string; blocks: number }

export class BitcoindAnchorBackend implements AnchorBackend {
  readonly network: 'regtest' | 'mainnet';
  readonly name: string;
  private readonly rpcOpts: RpcOptions;
  private readonly wallet: string;

  constructor(opts: {
    network: 'regtest' | 'mainnet';
    url: string;
    user: string;
    password: string;
    wallet: string;
  }) {
    this.network = opts.network;
    this.name = `bitcoind:${opts.network}`;
    this.rpcOpts = { url: opts.url, user: opts.user, password: opts.password };
    this.wallet = opts.wallet;
  }

  async submit(payload: Uint8Array): Promise<AnchorHandle> {
    const script = opReturnScript(payload);
    // `data` is bitcoind's own OP_RETURN shorthand: it builds `OP_RETURN <push>`
    // from the hex, which is byte-identical to `opReturnScript` above. We keep
    // our own encoder because the bundle assembler needs the exact bytes, and a
    // test asserts the two agree.
    const unfunded = await rpc<string>(
      this.rpcOpts, 'createrawtransaction', [[], [{ data: bytesToHex(payload) }]],
    );
    const funded = await rpc<FundResult>(
      this.rpcOpts, 'fundrawtransaction', [unfunded, { fee_rate: 1 }], this.wallet,
    );
    const signed = await rpc<SignResult>(
      this.rpcOpts, 'signrawtransactionwithwallet', [funded.hex], this.wallet,
    );
    if (!signed.complete) {
      const why = signed.errors?.map((e) => e.error).join('; ') ?? 'unknown';
      throw new Error(`bitcoind could not fully sign the anchor transaction: ${why}`);
    }

    // Before broadcasting, confirm bitcoind framed the OP_RETURN exactly as our
    // own encoder would. If the two ever disagreed, the bundle would advertise
    // one payload while the chain carried another, and the mismatch would
    // surface in a customer's verifier rather than here.
    const want = bytesToHex(script);
    if (!signed.hex.includes(want)) {
      throw new Error(
        `bitcoind framed the anchor output differently than expected; refusing to broadcast. ` +
        `expected script ${want} to appear in the signed transaction`,
      );
    }

    const txid = await rpc<string>(this.rpcOpts, 'sendrawtransaction', [signed.hex], this.wallet);
    return { txid, rawTxHex: signed.hex, anchorPayloadHex: bytesToHex(payload) };
  }

  async poll(handle: AnchorHandle): Promise<AnchorState> {
    const tx = await rpc<GetTxResult>(
      this.rpcOpts, 'gettransaction', [handle.txid, true, true], this.wallet,
    );
    const confirmations = tx.confirmations ?? 0;
    if (confirmations <= 0) return { status: 'pending', confirmations: 0 };
    const state: AnchorState = { status: 'confirmed', confirmations };
    if (tx.blockhash) state.blockHash = tx.blockhash;
    if (typeof tx.blockheight === 'number') state.blockHeight = tx.blockheight;
    return state;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const info = await rpc<BlockchainInfo>(this.rpcOpts, 'getblockchaininfo');
      const expected = this.network === 'mainnet' ? 'main' : 'regtest';
      if (info.chain !== expected) {
        return { ok: false, detail: `bitcoind is on "${info.chain}" but this process expects "${expected}"` };
      }
      return { ok: true, detail: `chain ${info.chain} at height ${info.blocks}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** regtest convenience: mine `n` blocks so a submission confirms immediately.
   *  Refuses to run on mainnet, where it is meaningless. */
  async generate(n: number): Promise<string[]> {
    if (this.network !== 'regtest') throw new Error('block generation is regtest-only');
    const addr = await rpc<string>(this.rpcOpts, 'getnewaddress', [], this.wallet);
    return rpc<string[]>(this.rpcOpts, 'generatetoaddress', [n, addr], this.wallet);
  }
}
