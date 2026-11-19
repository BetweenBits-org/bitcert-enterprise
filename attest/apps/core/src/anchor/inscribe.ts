/**
 * Commit and reveal — putting the document itself on the chain.
 *
 * Two transactions, because taproot only discloses a script when it is spent:
 *
 *   **commit**  pays a funded output to a P2TR key that secretly commits to a
 *               tapscript leaf containing the document. Nothing is revealed.
 *   **reveal**  spends that output by the script path, which forces the whole
 *               leaf — document included — into the witness, where it stays on
 *               the chain forever.
 *
 * bitcoind funds and signs the commit, exactly as it does for a hash anchor,
 * so no wallet key is handled here. The reveal is different: it spends a
 * tapscript that bitcoind's descriptor language cannot express, so the
 * signature is made in-process with an ephemeral key. That key controls one
 * dust output and is dropped when this function returns.
 *
 * It is **not** the taproot internal key — that is always the NUMS point, so
 * the commit output has no key path and the only way to spend it is the one
 * that publishes the document. See `NUMS_INTERNAL_KEY`.
 *
 * ## What the OP_RETURN carries, and why it is not a Merkle root
 *
 * An inscription is per-document and immediate — there is no batch to
 * aggregate, so there is no tree. The anchor output therefore carries the
 * 32-byte `leaf_bytes` directly, which is the "legacy witness" shape
 * `attest-verify` recognises: it checks `anchor payload == leaf_bytes` and
 * skips link B rather than looking for an inclusion proof that does not exist.
 *
 * The result is that **both** copies of the commitment ride in the same
 * transaction: the digest in an output the txid covers, and the bytes in a
 * witness it does not. The verifier is what ties them together.
 */
import { randomBytes } from 'node:crypto';
import { buildInscription, protocolTagFor } from '../btc/inscription.ts';
import { ephemeralSecret, serializeWitness, tapSighash } from '../btc/taproot.ts';
import { schnorrSign, xOnlyPubkey } from '../btc/secp256k1.ts';
import {
  bytesToHex, hexToBytes, opReturnScript, serializeLegacy, txidOf,
} from '../btc/tx.ts';
import { rpc } from './rpc.ts';
import type { RpcOptions } from './rpc.ts';
import type { TxInput, TxOutput } from '../btc/tx.ts';

interface FundResult { hex: string; fee: number; changepos: number }
interface SignResult { hex: string; complete: boolean; errors?: { error: string }[] }
interface DecodedTx { vout: { n: number; value: number; scriptPubKey: { hex: string } }[] }
interface AddressInfo { scriptPubKey: string }

/** Value left in the reveal's own output. Comfortably over the P2TR dust floor. */
const REVEAL_OUTPUT_SATS = 1000;
/** regtest and a quiet mempool; the same knob as the hash anchor's `fee_rate`. */
const FEE_RATE_SAT_VB = 2;

export interface InscriptionResult {
  commitTxid: string;
  revealTxid: string;
  /** Full reveal transaction, witness included — what the bundle carries. */
  revealTxHex: string;
  /** The 32-byte digest in the anchor output, hex. */
  anchorPayloadHex: string;
  /** SHA-256 of the inscribed body. Equals `anchorPayloadHex` by construction. */
  leafHex: string;
  contentType: string;
  protocolTag: string;
  bodyLength: number;
  /** Which input carries the envelope. Always 0 here; recorded for the bundle. */
  witnessInputIndex: number;
  feePaidSats: number;
}

/**
 * Weight-accurate size, so the commit funds the reveal exactly once.
 *
 * Guessing high wastes a customer's money on mainnet and guessing low gets the
 * reveal rejected after the commit has already confirmed — leaving funds in an
 * output only this process could ever spend, with the key already discarded.
 * So the reveal is serialised twice: once to measure, once for real.
 */
function revealVsize(
  inputs: TxInput[], outputs: TxOutput[], leafScript: Uint8Array, controlBlock: Uint8Array,
): number {
  const base = serializeLegacy(inputs, outputs).length;
  const total = serializeWitness(inputs, outputs,
    [[new Uint8Array(64), leafScript, controlBlock]]).length;
  const weight = base * 3 + total;
  return Math.ceil(weight / 4);
}

export async function inscribeDocument(opts: {
  rpcOpts: RpcOptions;
  wallet: string;
  network: 'regtest' | 'mainnet';
  body: Uint8Array;
  contentType: string;
  /** This deployment's limit. Checked before any coin is committed. */
  maxBodyBytes?: number;
}): Promise<InscriptionResult> {
  const secret = ephemeralSecret(() => new Uint8Array(randomBytes(32)));
  const pubkey = xOnlyPubkey(secret);
  const ins = buildInscription({
    xOnlyPubkey: pubkey,
    body: opts.body,
    contentType: opts.contentType,
    protocolTag: protocolTagFor(opts.network),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  });

  // Where the reveal's change goes. Asking the node for the script rather than
  // encoding bech32m here means we cannot disagree with it about the address.
  const address = await rpc<string>(opts.rpcOpts, 'getnewaddress', ['inscription', 'bech32m'], opts.wallet);
  const info = await rpc<AddressInfo>(opts.rpcOpts, 'getaddressinfo', [address], opts.wallet);
  const revealOut: TxOutput = { value: REVEAL_OUTPUT_SATS, scriptPubKey: hexToBytes(info.scriptPubKey) };
  const anchorOut: TxOutput = { value: 0, scriptPubKey: opReturnScript(hexToBytes(ins.leafHex)) };

  // Measure against a placeholder input; only its size matters at this point.
  const measured = revealVsize(
    [{ txid: '00'.repeat(32), vout: 0, sequence: 0xfffffffd }],
    [anchorOut, revealOut], ins.leafScript, ins.taproot.controlBlock);
  const revealFee = measured * FEE_RATE_SAT_VB;
  const commitValue = REVEAL_OUTPUT_SATS + revealFee;

  // ── commit ───────────────────────────────────────────────────────────────
  // Hand-serialised with no inputs: `createrawtransaction` only speaks
  // addresses, and the P2TR script here is derived from a key the node has
  // never seen. `fundrawtransaction` happily takes the raw form.
  const skeleton = bytesToHex(serializeLegacy([], [{
    value: commitValue, scriptPubKey: ins.taproot.scriptPubKey,
  }]));
  const funded = await rpc<FundResult>(
    opts.rpcOpts, 'fundrawtransaction', [skeleton, { fee_rate: FEE_RATE_SAT_VB }], opts.wallet);
  const signedCommit = await rpc<SignResult>(
    opts.rpcOpts, 'signrawtransactionwithwallet', [funded.hex], opts.wallet);
  if (!signedCommit.complete) {
    const why = signedCommit.errors?.map((e) => e.error).join('; ') ?? 'unknown';
    throw new Error(`bitcoind could not sign the commit transaction: ${why}`);
  }

  // Funding inserts change at an arbitrary position, so the inscription output
  // is found by its script, never by assuming index 0.
  const decoded = await rpc<DecodedTx>(opts.rpcOpts, 'decoderawtransaction', [signedCommit.hex]);
  const want = bytesToHex(ins.taproot.scriptPubKey);
  const mine = decoded.vout.find((v) => v.scriptPubKey.hex === want);
  if (!mine) throw new Error('the funded commit transaction no longer carries the inscription output');

  const commitTxid = await rpc<string>(
    opts.rpcOpts, 'sendrawtransaction', [signedCommit.hex], opts.wallet);

  // ── reveal ───────────────────────────────────────────────────────────────
  const inputs: TxInput[] = [{ txid: commitTxid, vout: mine.n, sequence: 0xfffffffd }];
  const outputs = [anchorOut, revealOut];
  const prevouts = [{ value: commitValue, scriptPubKey: ins.taproot.scriptPubKey }];

  const sighash = tapSighash(inputs, outputs, prevouts, 0, ins.taproot.tapleaf);
  const signature = schnorrSign(sighash, secret);
  const revealRaw = serializeWitness(inputs, outputs,
    [[signature, ins.leafScript, ins.taproot.controlBlock]]);

  const revealTxid = await rpc<string>(
    opts.rpcOpts, 'sendrawtransaction', [bytesToHex(revealRaw)], opts.wallet);

  // The node's txid and ours must agree; if they ever did not, the bundle would
  // point at a transaction nobody can look up.
  const computed = txidOf(serializeLegacy(inputs, outputs));
  if (computed !== revealTxid) {
    throw new Error(`txid disagreement: node says ${revealTxid}, we computed ${computed}`);
  }

  return {
    commitTxid,
    revealTxid,
    revealTxHex: bytesToHex(revealRaw),
    anchorPayloadHex: ins.leafHex,
    leafHex: ins.leafHex,
    contentType: ins.contentType,
    protocolTag: ins.protocolTag,
    bodyLength: ins.bodyLength,
    witnessInputIndex: 0,
    feePaidSats: revealFee + Math.round(funded.fee * 1e8),
  };
}
