/**
 * The Bitcoin commitment — bundle-schema.md §4 (link C).
 *
 * Two jobs:
 *  1. Decode the anchor output payload and pull out the committed 32 bytes (§4.1).
 *  2. Recompute the txid from the raw transaction and confirm the anchor output
 *     bytes really belong to that txid, with **zero network access** (§4.2).
 *
 * Decode only. This package never *builds* an anchor payload — the OP_RETURN v30
 * (BC30) encoder is patent-pending and deliberately out of scope here; the layout
 * below is the published read side from bundle-schema.md §4.1.
 */
import { sha256d } from './sha256.ts';
import { bytesToHex, hexToBytes, latin1, reversed } from './bytes.ts';

export interface DecodedAnchor {
  format: 'BC01' | 'BC30';
  version: number;
  /** The committed 32 bytes. For v1 bundles this is the Merkle root; for v2 it is
   *  the `day_root`. The field name is historical — see §4.1 "Commitment check". */
  merkleRoot: string;
  batchId: string;
  flags?: number;
  aux?: string;
}

/**
 * Decode a `BC01` (53 B) or `BC30` (86 B) anchor payload.
 * Returns `null` for a payload with no recognised magic — that is not an error:
 * a raw 32-byte payload is the *legacy witness* mode selector (§4.4.1), and the
 * caller branches on this being `null`.
 */
export function decodeAnchorPayload(payloadHex: string): DecodedAnchor | null {
  const b = hexToBytes(payloadHex);
  const magic = latin1(b.subarray(0, 4));
  if (magic === 'BC01') {
    if (b.length !== 53) throw new Error(`BC01 must be 53 bytes, got ${b.length}`);
    return {
      format: 'BC01',
      version: b[4]!,
      merkleRoot: bytesToHex(b.subarray(5, 37)),
      batchId: bytesToHex(b.subarray(37, 53)),
    };
  }
  if (magic === 'BC30') {
    if (b.length !== 86) throw new Error(`BC30 must be 86 bytes, got ${b.length}`);
    return {
      format: 'BC30',
      version: b[4]!,
      flags: b[5]!,
      batchId: bytesToHex(b.subarray(6, 22)),
      merkleRoot: bytesToHex(b.subarray(22, 54)),
      aux: bytesToHex(b.subarray(54, 86)),
    };
  }
  return null;
}

/** Sequential byte reader over a transaction. */
class Reader {
  private o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  get offset(): number { return this.o; }
  peek(n: number): Uint8Array { return this.b.subarray(this.o, this.o + n); }
  take(n: number): Uint8Array {
    const s = this.b.subarray(this.o, this.o + n);
    if (s.length !== n) throw new Error('tx truncated');
    this.o += n;
    return s;
  }
  u8(): number { return this.take(1)[0]!; }
  le(n: number): number {
    const s = this.take(n);
    let v = 0;
    for (let i = n - 1; i >= 0; i--) v = v * 256 + s[i]!;
    return v;
  }
  varint(): number {
    const f = this.u8();
    if (f < 0xfd) return f;
    if (f === 0xfd) return this.le(2);
    if (f === 0xfe) return this.le(4);
    return this.le(8);
  }
}

function encodeVarint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  let v = n;
  for (let i = 1; i <= 8; i++) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
}

export interface ParsedTx {
  /** Legacy (non-witness) serialisation — the preimage of the txid. */
  legacy: Uint8Array;
  outputScripts: Uint8Array[];
  segwit: boolean;
}

/**
 * Parse a raw transaction and rebuild its **legacy** serialisation.
 *
 * The txid is the double-SHA-256 of the serialisation *without* witness data, so
 * a segwit transaction has to be re-serialised with the marker, flag and witness
 * stacks stripped. Hashing the raw hex as-is would produce the wtxid and every
 * binding check would fail.
 */
export function parseTx(hexStr: string): ParsedTx {
  const r = new Reader(hexToBytes(hexStr));
  const parts: Uint8Array[] = [r.take(4)]; // version
  const marker = r.peek(2);
  const segwit = marker.length === 2 && marker[0] === 0x00 && marker[1] === 0x01;
  if (segwit) r.take(2);

  const vin = r.varint();
  parts.push(encodeVarint(vin));
  for (let i = 0; i < vin; i++) {
    parts.push(r.take(32)); // prev txid
    parts.push(r.take(4));  // prev vout
    const sl = r.varint();
    parts.push(encodeVarint(sl), r.take(sl)); // scriptSig
    parts.push(r.take(4));  // sequence
  }

  const vout = r.varint();
  parts.push(encodeVarint(vout));
  const outputScripts: Uint8Array[] = [];
  for (let i = 0; i < vout; i++) {
    const value = r.take(8);
    const sl = r.varint();
    const script = r.take(sl);
    parts.push(value, encodeVarint(sl), script);
    outputScripts.push(script);
  }

  if (segwit) {
    for (let i = 0; i < vin; i++) {
      const items = r.varint();
      for (let j = 0; j < items; j++) r.take(r.varint());
    }
  }
  parts.push(r.take(4)); // locktime

  let total = 0;
  for (const p of parts) total += p.length;
  const legacy = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { legacy.set(p, o); o += p.length; }
  return { legacy, outputScripts, segwit };
}

/** Pull the pushed data out of an `OP_RETURN` script, or `null` if not one. */
export function extractAnchorOutput(script: Uint8Array): Uint8Array | null {
  if (script.length < 1 || script[0] !== 0x6a) return null;
  let o = 1;
  if (o >= script.length) return new Uint8Array(0);
  const op = script[o]!;
  o += 1;
  let ln: number;
  if (op <= 0x4b) ln = op;
  else if (op === 0x4c) { ln = script[o]!; o += 1; }
  else if (op === 0x4d) { ln = script[o]! | (script[o + 1]! << 8); o += 2; }
  else if (op === 0x4e) {
    ln = script[o]! | (script[o + 1]! << 8) | (script[o + 2]! << 16) | (script[o + 3]! << 24);
    o += 4;
  } else return null;
  return script.subarray(o, o + ln);
}

export interface TxBinding {
  /** Recomputed txid in **display** (big-endian) order. */
  txid: string;
  /** Hex of the first `OP_RETURN` payload found, or `null` if the tx has none. */
  anchorPayloadHex: string | null;
}

/** Recompute the txid and extract the anchor payload from a raw transaction. */
export function txidFromRaw(hexStr: string): TxBinding {
  const { legacy, outputScripts } = parseTx(hexStr);
  const txid = bytesToHex(reversed(sha256d(legacy)));
  let anchorPayloadHex: string | null = null;
  for (const s of outputScripts) {
    const p = extractAnchorOutput(s);
    if (p !== null) { anchorPayloadHex = bytesToHex(p); break; }
  }
  return { txid, anchorPayloadHex };
}
