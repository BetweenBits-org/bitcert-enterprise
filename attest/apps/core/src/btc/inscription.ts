/**
 * The inscription envelope — the original document, as script.
 *
 * Layout, fixed by `bundle-schema.md §4.4` and by the conformance fixture
 * `07-witness-unified`, which this module must keep byte-compatible:
 *
 *     <32-byte x-only pubkey> OP_CHECKSIG
 *     OP_FALSE OP_IF
 *       <protocol tag>  <content type>  <body chunk…>
 *     OP_ENDIF
 *
 * ## Why the document survives in a place the txid does not cover
 *
 * The envelope sits inside `OP_FALSE OP_IF … OP_ENDIF`, so the interpreter
 * never executes it: the pushes are inert data that the chain nonetheless
 * stores and republishes forever. The signature check in front is what makes
 * the output spendable only by us before the reveal lands.
 *
 * The witness is **not** committed by the txid. Bytes recovered from it are
 * therefore worth nothing on their own, and `attest-verify` treats them that
 * way — it hashes the recovered body and requires the digest to equal
 * `leaf_bytes`, which *is* committed, through the anchor output. Producing an
 * envelope whose body does not hash to the record's leaf would therefore
 * produce a bundle that fails its own verifier, which is why `buildInscription`
 * computes the leaf from the body rather than accepting one.
 */
import { createHash } from 'node:crypto';
import { concat } from './tx.ts';
import { pushData, taprootSingleLeaf } from './taproot.ts';
import type { TaprootOutput } from './taproot.ts';

const OP_CHECKSIG = 0xac;
const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;

/**
 * Consensus caps a single push at 520 bytes inside a script, so a body larger
 * than that is split. The verifier concatenates every push after the content
 * type, so where the boundaries fall does not change what is recovered.
 */
export const MAX_PUSH = 520;

/**
 * The BIP341 NUMS point — `lift_x` of the SHA-256 of the uncompressed
 * generator, with no known discrete logarithm.
 *
 * Every inscription commits under **this** as its taproot internal key, so the
 * commit output has no key path. That is the entire point, and it is not a
 * stylistic preference:
 *
 * An output that can be spent by the key path can be spent **without
 * revealing the script**, and the script is where the document lives. Such a
 * spend produces a transaction with the same outputs, the same anchor digest
 * and — because the witness is not committed by it — a txid that looks
 * exactly as expected. The inscribed bytes would simply never appear, while
 * every artifact a reader checks still lined up.
 *
 * Using the signing key as the internal key makes that substitution available
 * to anyone holding it. With NUMS the only way to spend the commit output is
 * the script path, which reveals the envelope by construction.
 */
export const NUMS_INTERNAL_KEY = Uint8Array.from([
  0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e,
  0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0,
]);

/**
 * Three ceilings, and they answer different questions.
 *
 * **Standard relay.** `MAX_STANDARD_TX_WEIGHT` is 400,000 weight units —
 * 100,000 vB. The witness is discounted 4×, so a body of roughly 390 KB is
 * the most an ordinary node will accept, and the signature, control block and
 * the rest of the transaction come out of the same budget. A mainnet node
 * rejects anything above this at relay, before any miner sees it.
 *
 * **Hard ceiling.** A node run with `-acceptnonstdtxn=1` and raised mempool
 * `-limit{ancestor,descendant}size` — which is how the regtest node here is
 * configured — lifts the practical cap toward the ~4 MB block limit.
 * 3,500,000 bytes is ≈ 875 KvB, safely under both. This is the last-line
 * guard, not a target.
 *
 * **Soft cap.** What this deployment will actually accept, set in config and
 * clamped to the hard ceiling. It is the number the console shows and the one
 * a caller hits first, because a limit discovered as a mempool rejection
 * after the commit has been funded is the expensive way to learn it.
 */
export const STANDARD_RELAY_MAX_BODY_BYTES = 390_000;
export const HARD_CEILING_BYTES = 3_500_000;
export const DEFAULT_SOFT_CAP_BYTES = 100_000;

/** `bcrt` on regtest, `bc` on mainnet — recorded in the bundle, not interpreted. */
export function protocolTagFor(network: 'regtest' | 'mainnet'): string {
  return network === 'mainnet' ? 'bc' : 'bcrt';
}

export function chunk(body: Uint8Array, size = MAX_PUSH): Uint8Array[] {
  if (body.length === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let o = 0; o < body.length; o += size) out.push(body.subarray(o, Math.min(o + size, body.length)));
  return out;
}

/** The `OP_FALSE OP_IF … OP_ENDIF` block on its own. */
export function envelopeScript(tag: string, contentType: string, body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([OP_FALSE, OP_IF]),
    pushData(new TextEncoder().encode(tag)),
    pushData(new TextEncoder().encode(contentType)),
  ];
  for (const c of chunk(body)) parts.push(pushData(c));
  parts.push(new Uint8Array([OP_ENDIF]));
  return concat(parts);
}

/** The complete tapscript leaf: signature check, then the envelope. */
export function inscriptionLeafScript(
  xOnlyPubkey: Uint8Array, tag: string, contentType: string, body: Uint8Array,
): Uint8Array {
  if (xOnlyPubkey.length !== 32) throw new Error('leaf pubkey must be x-only (32 bytes)');
  return concat([
    pushData(xOnlyPubkey),
    new Uint8Array([OP_CHECKSIG]),
    envelopeScript(tag, contentType, body),
  ]);
}

export interface Inscription {
  /** SHA-256 of the body — the record's `leaf_bytes`, and what binds link A. */
  leafHex: string;
  leafScript: Uint8Array;
  taproot: TaprootOutput;
  contentType: string;
  protocolTag: string;
  bodyLength: number;
}

/**
 * Everything the commit and reveal need, derived from the document bytes.
 *
 * Two different keys, and the distinction is load-bearing: `xOnlyPubkey` goes
 * into the tapscript's `OP_CHECKSIG` and signs the reveal, while the taproot
 * internal key is always [`NUMS_INTERNAL_KEY`] so the commit output has no key
 * path at all. See that constant for what sharing one key would allow.
 */
export function buildInscription(opts: {
  /** The key in the tapscript's `OP_CHECKSIG` — what signs the reveal. */
  xOnlyPubkey: Uint8Array;
  body: Uint8Array;
  contentType: string;
  protocolTag: string;
  /** This deployment's limit. Clamped to the hard ceiling. */
  maxBodyBytes?: number;
}): Inscription {
  if (opts.body.length === 0) throw new Error('nothing to inscribe: the document is empty');
  if (!opts.contentType) throw new Error('content_type is mandatory and must be a single push');
  if (opts.contentType.length > MAX_PUSH || opts.protocolTag.length > MAX_PUSH) {
    throw new Error('content_type and protocol_tag must each fit in one push');
  }
  const cap = Math.min(opts.maxBodyBytes ?? DEFAULT_SOFT_CAP_BYTES, HARD_CEILING_BYTES);
  if (opts.body.length > cap) {
    throw new Error(
      `document is ${opts.body.length} bytes; the inscription limit is ${cap}`);
  }
  const leafScript = inscriptionLeafScript(
    opts.xOnlyPubkey, opts.protocolTag, opts.contentType, opts.body);
  return {
    leafHex: createHash('sha256').update(opts.body).digest('hex'),
    leafScript,
    // NUMS, never the signing key — see the constant for what that prevents.
    taproot: taprootSingleLeaf(NUMS_INTERNAL_KEY, leafScript),
    contentType: opts.contentType,
    protocolTag: opts.protocolTag,
    bodyLength: opts.body.length,
  };
}
