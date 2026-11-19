/** Bitcoin CompactSize encoding — the one primitive every serialiser needs. */

export function encodeVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`varint must be a non-negative integer, got ${n}`);
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

/** Little-endian unsigned integer of `width` bytes. */
export function uintLE(n: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = n;
  for (let i = 0; i < width; i++) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
}
