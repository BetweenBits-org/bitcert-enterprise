/**
 * Witness inscription — bundle-schema.md §4.4. The original document rides in
 * the reveal transaction's witness, so the bundle is self-contained: the original
 * is recovered from the chain itself, with no off-bundle file.
 *
 * On-chain tapscript layout:
 *   <x-only pubkey> OP_CHECKSIG OP_FALSE OP_IF <tag> <content_type> <body chunks…> OP_ENDIF
 *
 * Critical: **the witness is not covered by the txid** (it is malleable). So
 * recovered bytes are worthless on their own — the caller MUST bind
 * `SHA-256(body)` to `record.leaf_bytes`, which *is* txid-committed through the
 * anchor output. `bundle.ts` does exactly that and nothing else trusts the body.
 */
import { hexToBytes } from './bytes.ts';

/** Minimal reader duplicated here so this module stays independent of anchor.ts. */
class Reader {
  private o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
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

/**
 * Witness stack elements for one input, or `null` for a non-segwit transaction
 * or an out-of-range index.
 */
export function extractWitnessItems(rawTxHex: string, inputIndex: number): Uint8Array[] | null {
  const r = new Reader(hexToBytes(rawTxHex));
  r.take(4); // version
  const marker = r.peek(2);
  if (!(marker.length === 2 && marker[0] === 0x00 && marker[1] === 0x01)) return null;
  r.take(2);

  const vin = r.varint();
  for (let i = 0; i < vin; i++) {
    r.take(32); r.take(4);
    r.take(r.varint()); // scriptSig
    r.take(4);          // sequence
  }
  const vout = r.varint();
  for (let i = 0; i < vout; i++) {
    r.take(8);
    r.take(r.varint()); // scriptPubKey
  }
  const witnesses: Uint8Array[][] = [];
  for (let i = 0; i < vin; i++) {
    const n = r.varint();
    const items: Uint8Array[] = [];
    for (let j = 0; j < n; j++) items.push(r.take(r.varint()));
    witnesses.push(items);
  }
  if (inputIndex < 0 || inputIndex >= witnesses.length) return null;
  return witnesses[inputIndex]!;
}

export interface Envelope {
  protocolTag: Uint8Array;
  contentType: Uint8Array;
  /** Plain concatenation of every push after `content_type` inside OP_IF…OP_ENDIF. */
  body: Uint8Array;
}

/**
 * Walk the inscription tapscript and recover `(tag, content_type, body)`.
 * Returns `null` when the script is not an envelope (fewer than two pushes
 * inside the `OP_IF` block).
 */
export function parseEnvelope(script: Uint8Array): Envelope | null {
  let o = 0;
  let collecting = false;
  const pushes: Uint8Array[] = [];
  while (o < script.length) {
    const op = script[o]!;
    o += 1;
    let data: Uint8Array | null = null;
    if (op <= 0x4b) { data = script.subarray(o, o + op); o += op; }
    else if (op === 0x4c) { const ln = script[o]!; o += 1; data = script.subarray(o, o + ln); o += ln; }
    else if (op === 0x4d) {
      const ln = script[o]! | (script[o + 1]! << 8); o += 2;
      data = script.subarray(o, o + ln); o += ln;
    } else if (op === 0x4e) {
      const ln = script[o]! | (script[o + 1]! << 8) | (script[o + 2]! << 16) | (script[o + 3]! << 24);
      o += 4;
      data = script.subarray(o, o + ln); o += ln;
    } else if (op === 0x63) collecting = true;  // OP_IF
    else if (op === 0x68) collecting = false;   // OP_ENDIF
    if (data !== null && collecting) pushes.push(data);
  }
  if (pushes.length < 2) return null;
  let total = 0;
  for (let i = 2; i < pushes.length; i++) total += pushes[i]!.length;
  const body = new Uint8Array(total);
  let bo = 0;
  for (let i = 2; i < pushes.length; i++) { body.set(pushes[i]!, bo); bo += pushes[i]!.length; }
  return { protocolTag: pushes[0]!, contentType: pushes[1]!, body };
}
