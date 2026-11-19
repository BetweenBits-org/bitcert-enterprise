/**
 * `BC01` anchor payload — 53 bytes, the layout published in
 * bundle-schema.md §4.1.
 *
 * | offset | len | field                      |
 * |--------|-----|----------------------------|
 * | 0..4   | 4   | magic `BC01` (`42 43 30 31`) |
 * | 4..5   | 1   | version `0x01`             |
 * | 5..37  | 32  | merkle_root                |
 * | 37..53 | 16  | batch_id (UUID, raw)       |
 *
 * ## Why BC01 and not v30
 *
 * The OP_RETURN v30 (`BC30`) witness double-envelope is patent-pending
 * (BetweenBits, filed 2024-10-04) and its encoder is deliberately not
 * implemented anywhere in this repository. BC01 carries everything a proof
 * bundle needs — a committed root plus a batch identifier — in a third of the
 * bytes, with no patent entanglement, and the published verifiers already decode
 * it. If v30 is ever licensed into this product it slots in behind the same
 * `AnchorBackend`, with no change to batching, bundling or verification.
 */
export const BC01_MAGIC = new Uint8Array([0x42, 0x43, 0x30, 0x31]); // "BC01"
export const BC01_VERSION = 0x01;
export const BC01_LEN = 53;

/** Encode a 32-byte root and a 16-byte batch id into the 53-byte payload. */
export function encodeBc01(merkleRoot: Uint8Array, batchId16: Uint8Array): Uint8Array {
  if (merkleRoot.length !== 32) throw new Error(`merkle_root must be 32 bytes, got ${merkleRoot.length}`);
  if (batchId16.length !== 16) throw new Error(`batch_id must be 16 bytes, got ${batchId16.length}`);
  const out = new Uint8Array(BC01_LEN);
  out.set(BC01_MAGIC, 0);
  out[4] = BC01_VERSION;
  out.set(merkleRoot, 5);
  out.set(batchId16, 37);
  return out;
}

/** `uuid` with dashes → its 16 raw bytes. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`not a uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
