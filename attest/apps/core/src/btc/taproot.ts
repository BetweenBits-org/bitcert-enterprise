/**
 * Taproot — BIP341 commitments and BIP342 tapscript, for one spend shape.
 *
 * Everything here exists to build and sign a single transaction: the reveal
 * that spends a one-leaf P2TR output by the script path, carrying an
 * inscription envelope in its witness. Nothing else in the service spends
 * anything, so this is not a general taproot library and should not grow into
 * one — key-path spends, multi-leaf trees, annexes and the other sighash
 * types are all absent because nothing needs them.
 *
 * ## The three things that are easy to get wrong
 *
 * **Parity.** The control block's low bit is the parity of the *tweaked output*
 * key's y coordinate, not the internal key's. Get it wrong and the node
 * recomputes a different output key and rejects the spend with a message that
 * does not mention parity.
 *
 * **Which key signs.** The tapscript's `OP_CHECKSIG` tests the pubkey pushed
 * inside the leaf, so the signature is made with the plain leaf key — *not*
 * the tweaked key. The tweak only ever appears in the output commitment.
 *
 * **The sighash covers every input's amount and scriptPubKey**, not just the
 * one being signed. A reveal that borrowed amounts from the wrong prevout
 * produces a signature that verifies against nothing.
 */
import { encodeVarint, uintLE } from './varint.ts';
import { concat, hexToBytes, reversed, sha256d } from './tx.ts';
import { bigintTo32, bytesToBigint, G, liftX, pointAdd, pointMul, taggedHash, xOnly, N } from './secp256k1.ts';
import { createHash } from 'node:crypto';
import type { TxInput, TxOutput } from './tx.ts';

/** BIP342 tapscript leaf version. */
export const LEAF_VERSION = 0xc0;

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

/** Satoshi values exceed 2^32, so the halves are written separately. */
function uint64LE(v: number): Uint8Array {
  return concat([uintLE(v % 0x100000000, 4), uintLE(Math.floor(v / 0x100000000), 4)]);
}

/**
 * Minimal push encoding for script data.
 *
 * Minimality matters: a tapscript with a non-minimal push is non-standard, so
 * the reveal would be rejected from the mempool rather than failing a check we
 * could see. An empty push is `OP_0`, which is also the `OP_FALSE` that opens
 * the inscription envelope.
 */
export function pushData(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array([0x00]);
  if (data.length <= 0x4b) return concat([new Uint8Array([data.length]), data]);
  if (data.length <= 0xff) return concat([new Uint8Array([0x4c, data.length]), data]);
  if (data.length <= 0xffff) {
    return concat([new Uint8Array([0x4d, data.length & 0xff, (data.length >> 8) & 0xff]), data]);
  }
  throw new Error(`push too large for this encoder: ${data.length}`);
}

/** `tagged_hash("TapLeaf", leaf_version ‖ compact_size(script) ‖ script)`. */
export function tapleafHash(script: Uint8Array, leafVersion = LEAF_VERSION): Uint8Array {
  return taggedHash('TapLeaf', new Uint8Array([leafVersion]), encodeVarint(script.length), script);
}

export interface TaprootOutput {
  /** x-only tweaked output key — what the scriptPubKey commits to. */
  outputKey: Uint8Array;
  /** y-parity of the tweaked point; the control block's low bit. */
  parity: number;
  /** `OP_1 <32-byte push>` — the P2TR scriptPubKey. */
  scriptPubKey: Uint8Array;
  /** `[leaf_version | parity] ‖ internal_key` — 33 bytes for a single leaf. */
  controlBlock: Uint8Array;
  tapleaf: Uint8Array;
}

/**
 * Commit a single-leaf script tree to an internal key.
 *
 * With one leaf the Merkle root *is* the leaf hash and the control block
 * carries no path, which is why it is exactly 33 bytes here. A second leaf
 * would add 32 bytes per level and change nothing else.
 */
export function taprootSingleLeaf(internalXOnly: Uint8Array, script: Uint8Array): TaprootOutput {
  if (internalXOnly.length !== 32) throw new Error('internal key must be x-only (32 bytes)');
  const tapleaf = tapleafHash(script);
  const tweak = bytesToBigint(taggedHash('TapTweak', internalXOnly, tapleaf));
  if (tweak >= N) throw new Error('taproot tweak out of range');

  const internalPoint = liftX(bytesToBigint(internalXOnly));
  if (internalPoint === null) throw new Error('internal key is not on the curve');
  const q = pointAdd(internalPoint, pointMul(tweak, G));
  if (q === null) throw new Error('taproot tweak produced the point at infinity');

  const outputKey = xOnly(q);
  const parity = Number(q.y & 1n);
  return {
    outputKey,
    parity,
    scriptPubKey: concat([new Uint8Array([0x51, 0x20]), outputKey]),
    controlBlock: concat([new Uint8Array([LEAF_VERSION | parity]), internalXOnly]),
    tapleaf,
  };
}

// ── sighash ────────────────────────────────────────────────────────────────

/** What each input spends — needed because the sighash covers all of them. */
export interface Prevout {
  value: number;
  scriptPubKey: Uint8Array;
}

/**
 * BIP341 signature message for a script-path spend with `SIGHASH_DEFAULT`.
 *
 * `SIGHASH_DEFAULT` (0x00) signs every input and every output and, unlike
 * `SIGHASH_ALL`, leaves no trailing byte on the signature — so the witness
 * element is exactly 64 bytes. The BIP342 extension (tapleaf, key version,
 * codeseparator position) is appended because this is a tapscript spend.
 */
export function tapSighash(
  inputs: TxInput[],
  outputs: TxOutput[],
  prevouts: Prevout[],
  inputIndex: number,
  tapleaf: Uint8Array,
  version = 2,
  locktime = 0,
): Uint8Array {
  if (prevouts.length !== inputs.length) {
    throw new Error('every input needs its prevout: the sighash commits to all of them');
  }
  const shaPrevouts = sha256(concat(inputs.map((i) =>
    concat([reversed(hexToBytes(i.txid)), uintLE(i.vout, 4)]))));
  const shaAmounts = sha256(concat(prevouts.map((p) => uint64LE(p.value))));
  const shaScriptPubKeys = sha256(concat(prevouts.map((p) =>
    concat([encodeVarint(p.scriptPubKey.length), p.scriptPubKey]))));
  const shaSequences = sha256(concat(inputs.map((i) => uintLE(i.sequence ?? 0xffffffff, 4))));
  const shaOutputs = sha256(concat(outputs.map((o) =>
    concat([uint64LE(o.value), encodeVarint(o.scriptPubKey.length), o.scriptPubKey]))));

  // spend_type = ext_flag * 2 + annex_present. Tapscript sets ext_flag = 1 and
  // we never attach an annex, so it is 2.
  const SPEND_TYPE = 0x02;
  const KEY_VERSION = 0x00;
  const NO_CODESEPARATOR = 0xffffffff;

  return taggedHash('TapSighash',
    new Uint8Array([0x00]),            // sighash epoch
    new Uint8Array([0x00]),            // hash_type: SIGHASH_DEFAULT
    uintLE(version, 4),
    uintLE(locktime, 4),
    shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences,
    shaOutputs,
    new Uint8Array([SPEND_TYPE]),
    uintLE(inputIndex, 4),
    tapleaf,
    new Uint8Array([KEY_VERSION]),
    uintLE(NO_CODESEPARATOR, 4),
  );
}

// ── segwit serialisation ───────────────────────────────────────────────────

/**
 * Serialise with the witness marker, flag and stacks.
 *
 * The txid is still taken over the **legacy** form — `serializeLegacy` in
 * `tx.ts` — because the witness is not committed by it. That asymmetry is the
 * whole reason a witness inscription must bind its body through `leaf_bytes`
 * rather than being trusted on sight, and `attest-verify` enforces exactly
 * that when it reads one of these back.
 */
export function serializeWitness(
  inputs: TxInput[],
  outputs: TxOutput[],
  witnesses: Uint8Array[][],
  version = 2,
  locktime = 0,
): Uint8Array {
  if (witnesses.length !== inputs.length) {
    throw new Error('serializeWitness needs one witness stack per input');
  }
  const parts: Uint8Array[] = [
    uintLE(version, 4),
    new Uint8Array([0x00, 0x01]),      // segwit marker and flag
    encodeVarint(inputs.length),
  ];
  for (const i of inputs) {
    parts.push(reversed(hexToBytes(i.txid)), uintLE(i.vout, 4));
    const ss = i.scriptSig ?? new Uint8Array(0);
    parts.push(encodeVarint(ss.length), ss, uintLE(i.sequence ?? 0xffffffff, 4));
  }
  parts.push(encodeVarint(outputs.length));
  for (const o of outputs) {
    parts.push(uint64LE(o.value), encodeVarint(o.scriptPubKey.length), o.scriptPubKey);
  }
  for (const stack of witnesses) {
    parts.push(encodeVarint(stack.length));
    for (const item of stack) parts.push(encodeVarint(item.length), item);
  }
  parts.push(uintLE(locktime, 4));
  return concat(parts);
}

/** wtxid — over the witness form. Only useful for logs; the txid is elsewhere. */
export function wtxidOf(witnessSerialisation: Uint8Array): string {
  return Buffer.from(reversed(sha256d(witnessSerialisation))).toString('hex');
}

/** A 32-byte secret in range, for one inscription and then discarded. */
export function ephemeralSecret(random: () => Uint8Array): Uint8Array {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = random();
    const v = bytesToBigint(candidate);
    if (v > 0n && v < N) return bigintTo32(v);
  }
  throw new Error('could not draw a secret key in range');
}
