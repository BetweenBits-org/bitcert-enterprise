/**
 * Transaction serialisation and txid computation.
 *
 * Only what anchoring needs: build the `OP_RETURN` scriptPubKey, serialise a
 * transaction in **legacy** (non-witness) form, and take its txid. Signing and
 * funding are bitcoind's job — see `anchor/regtest.ts`. No private key is ever
 * handled in this process.
 *
 * Byte-order warning, because getting it wrong fails silently: a txid is the
 * double-SHA-256 of the legacy serialisation **reversed** into display order.
 * Everything inside a transaction is little-endian; everything a human or an
 * explorer sees is big-endian.
 */
import { createHash } from 'node:crypto';
import { encodeVarint, uintLE } from './varint.ts';

export function sha256d(b: Uint8Array): Uint8Array {
  const once = createHash('sha256').update(b).digest();
  return new Uint8Array(createHash('sha256').update(once).digest());
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * `OP_RETURN <push data>`. Payloads up to 75 bytes use a direct push; larger
 * ones use `OP_PUSHDATA1`. A BC01 payload is 53 bytes, so it takes the direct
 * form and the whole output script is 55 bytes.
 */
export function opReturnScript(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xff) throw new Error(`anchor payload too large: ${payload.length}`);
  return payload.length <= 0x4b
    ? concat([new Uint8Array([0x6a, payload.length]), payload])
    : concat([new Uint8Array([0x6a, 0x4c, payload.length]), payload]);
}

export interface TxInput {
  /** Previous txid in **display** order, as a user or explorer would quote it. */
  txid: string;
  vout: number;
  scriptSig?: Uint8Array;
  sequence?: number;
}

export interface TxOutput {
  /** Satoshis. An `OP_RETURN` output carries 0. */
  value: number;
  scriptPubKey: Uint8Array;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function reversed(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]!;
  return out;
}

/** Serialise in legacy (non-witness) form — the txid preimage. */
export function serializeLegacy(
  inputs: TxInput[], outputs: TxOutput[], version = 2, locktime = 0,
): Uint8Array {
  const parts: Uint8Array[] = [uintLE(version, 4), encodeVarint(inputs.length)];
  for (const i of inputs) {
    // Display order in, wire order out.
    parts.push(reversed(hexToBytes(i.txid)));
    parts.push(uintLE(i.vout, 4));
    const ss = i.scriptSig ?? new Uint8Array(0);
    parts.push(encodeVarint(ss.length), ss);
    parts.push(uintLE(i.sequence ?? 0xffffffff, 4));
  }
  parts.push(encodeVarint(outputs.length));
  for (const o of outputs) {
    // Satoshi values exceed 2^32, so split across two 32-bit halves rather than
    // relying on bit operators, which would silently truncate.
    const lo = o.value % 0x100000000;
    const hi = Math.floor(o.value / 0x100000000);
    parts.push(uintLE(lo, 4), uintLE(hi, 4));
    parts.push(encodeVarint(o.scriptPubKey.length), o.scriptPubKey);
  }
  parts.push(uintLE(locktime, 4));
  return concat(parts);
}

/** txid of a legacy serialisation, in display (big-endian) order. */
export function txidOf(legacy: Uint8Array): string {
  return Buffer.from(reversed(sha256d(legacy))).toString('hex');
}

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
