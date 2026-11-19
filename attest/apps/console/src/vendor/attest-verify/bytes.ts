/** Byte and hex helpers. Lowercase hex everywhere, per bundle-schema.md §1. */

/** Decode lowercase-or-uppercase hex. Throws on odd length or non-hex input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even, got ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

const HEX = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Encode as lowercase hex. */
export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!];
  return s;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Latin-1 decode — used for the 4-byte ASCII anchor magic and envelope tags. */
export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Case-insensitive hex comparison. `null`/`undefined` never equal anything. */
export function hexEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Reverse a copy — Bitcoin display (big-endian) vs wire (little-endian) order. */
export function reversed(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]!;
  return out;
}

export const ZERO_HASH_HEX = '00'.repeat(32);
