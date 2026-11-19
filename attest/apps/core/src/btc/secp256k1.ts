/**
 * secp256k1 and BIP340 Schnorr — the minimum needed to sign one tapscript spend.
 *
 * ## Why this file exists at all
 *
 * Every other signature in this service is delegated: bitcoind funds and signs
 * anchor transactions, so no key has ever had to live in this process. A
 * witness inscription breaks that, and not by choice. The reveal transaction
 * spends a P2TR output by the script path, and the leaf script is an
 * `OP_CHECKSIG` over a key we invented for that one output. bitcoind cannot
 * sign it — its descriptor language has no way to express "spend this arbitrary
 * tapscript" — so the signature has to be produced here.
 *
 * What that does **not** mean: no wallet key enters this process. The key in
 * play is generated for a single inscription, controls a single dust output
 * that we funded a moment earlier, and is discarded once the reveal is
 * broadcast. Losing it costs the commit output's dust and nothing else.
 *
 * ## Why not a library
 *
 * The service has zero runtime dependencies, deliberately — `deploy` is "copy
 * the tree, run node". Adding a curve library to sign one input would be the
 * only installed code in the service, in the one place where a supply-chain
 * compromise mints signatures.
 *
 * ## Constant time
 *
 * This is **not** constant-time. BigInt arithmetic in V8 branches on value and
 * nothing here attempts to hide it. That is acceptable for exactly the reason
 * above — the secret is an ephemeral key over dust, used once, and never
 * reused — and it would not be acceptable for a wallet key. Do not reach for
 * this module to sign anything that holds value.
 *
 * Test vectors: BIP340's published set, in `test/schnorr.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Field prime: 2²⁵⁶ − 2³² − 977. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
/** Group order. */
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** Affine point; `null` is the point at infinity. */
export type Point = { x: bigint; y: bigint } | null;

export const G: Point = { x: GX, y: GY };

const mod = (a: bigint, m: bigint = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

/**
 * Modular inverse by Fermat's little theorem.
 *
 * `a^(p-2) mod p`. The extended Euclidean algorithm is faster but branches on
 * the operands in a way that is harder to read; with one signature per
 * inscription the difference is not measurable.
 */
function inv(a: bigint, m: bigint = P): bigint {
  if (a === 0n) throw new Error('secp256k1: inverse of zero');
  return power(mod(a, m), m - 2n, m);
}

function power(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function pointAdd(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) {
    // Same x: either a doubling, or a + (−a) = infinity.
    if (mod(a.y + b.y) === 0n) return null;
    return pointDouble(a);
  }
  const lam = mod((b.y - a.y) * inv(b.x - a.x));
  const x = mod(lam * lam - a.x - b.x);
  return { x, y: mod(lam * (a.x - x) - a.y) };
}

function pointDouble(a: Point): Point {
  if (a === null) return null;
  if (a.y === 0n) return null;
  // secp256k1 has a = 0, so the tangent slope is 3x² / 2y.
  const lam = mod(3n * a.x * a.x * inv(2n * a.y));
  const x = mod(lam * lam - 2n * a.x);
  return { x, y: mod(lam * (a.x - x) - a.y) };
}

/** Double-and-add. Not constant time — see the module note. */
export function pointMul(k: bigint, p: Point = G): Point {
  let n = mod(k, N);
  if (n === 0n || p === null) return null;
  let acc: Point = null;
  let add: Point = p;
  while (n > 0n) {
    if (n & 1n) acc = pointAdd(acc, add);
    add = pointDouble(add);
    n >>= 1n;
  }
  return acc;
}

/**
 * BIP340 `lift_x`: the point with this x and **even** y.
 *
 * Returns null when x is not on the curve, which is a real possibility for
 * attacker-supplied input and must not be an exception that reads as a bug.
 */
export function liftX(x: bigint): Point {
  if (x <= 0n || x >= P) return null;
  const ySq = mod(x * x * x + 7n);
  // p ≡ 3 (mod 4), so the square root is y = c^((p+1)/4) when one exists.
  const y = power(ySq, (P + 1n) / 4n, P);
  if (mod(y * y) !== ySq) return null;
  return { x, y: (y & 1n) === 0n ? y : P - y };
}

// ── encoding ───────────────────────────────────────────────────────────────

export function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

export function bigintTo32(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 256n) throw new Error('value does not fit in 32 bytes');
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/** The 32-byte x-only encoding BIP340 and taproot use everywhere. */
export function xOnly(p: Point): Uint8Array {
  if (p === null) throw new Error('secp256k1: no x-only encoding for infinity');
  return bigintTo32(p.x);
}

export const hasEvenY = (p: Point): boolean => p !== null && (p.y & 1n) === 0n;

// ── tagged hashes ──────────────────────────────────────────────────────────

const tagCache = new Map<string, Buffer>();

/**
 * BIP340 tagged hash: `SHA256(SHA256(tag) ‖ SHA256(tag) ‖ msg)`.
 *
 * The doubled tag digest is the domain separator — it is what stops a
 * signature over one structure from being replayed as a signature over
 * another, which is exactly the property taproot leans on when the same key
 * signs both a key-path spend and a tapleaf.
 */
export function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  let prefix = tagCache.get(tag);
  if (!prefix) {
    const d = createHash('sha256').update(tag, 'utf8').digest();
    prefix = Buffer.concat([d, d]);
    tagCache.set(tag, prefix);
  }
  const h = createHash('sha256').update(prefix);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

// ── BIP340 ─────────────────────────────────────────────────────────────────

/** x-only public key for a secret, as BIP340 defines it. */
export function xOnlyPubkey(secret: Uint8Array): Uint8Array {
  const d = bytesToBigint(secret);
  if (d <= 0n || d >= N) throw new Error('secp256k1: secret key out of range');
  const p = pointMul(d);
  if (p === null) throw new Error('secp256k1: secret key produced infinity');
  return xOnly(p);
}

/**
 * BIP340 sign.
 *
 * `aux` defaults to fresh randomness. BIP340 permits all-zero aux (making the
 * scheme deterministic) but recommends randomising, because it removes the
 * class of fault attacks that recover a key from two signatures over the same
 * message with the same nonce.
 */
export function schnorrSign(
  msg: Uint8Array, secret: Uint8Array, aux: Uint8Array = new Uint8Array(randomBytes(32)),
): Uint8Array {
  const d0 = bytesToBigint(secret);
  if (d0 <= 0n || d0 >= N) throw new Error('secp256k1: secret key out of range');
  const pointP = pointMul(d0);
  if (pointP === null) throw new Error('secp256k1: secret key produced infinity');

  // BIP340 signs with the key whose public point has even y; if ours does not,
  // negate the scalar. Skipping this is the classic way to produce signatures
  // that verify locally and are rejected by every node.
  const d = hasEvenY(pointP) ? d0 : N - d0;

  const t = bigintTo32(d ^ bytesToBigint(taggedHash('BIP0340/aux', aux)));
  const rand = taggedHash('BIP0340/nonce', t, xOnly(pointP), msg);
  const k0 = mod(bytesToBigint(rand), N);
  if (k0 === 0n) throw new Error('secp256k1: nonce was zero');

  const pointR = pointMul(k0);
  if (pointR === null) throw new Error('secp256k1: nonce produced infinity');
  const k = hasEvenY(pointR) ? k0 : N - k0;

  const e = mod(
    bytesToBigint(taggedHash('BIP0340/challenge', xOnly(pointR), xOnly(pointP), msg)), N,
  );

  const sig = new Uint8Array(64);
  sig.set(xOnly(pointR), 0);
  sig.set(bigintTo32(mod(k + e * d, N)), 32);
  return sig;
}

/** BIP340 verify. Present so signing can be checked against itself in tests. */
export function schnorrVerify(sig: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
  if (sig.length !== 64 || pubkey.length !== 32) return false;
  const pointP = liftX(bytesToBigint(pubkey));
  if (pointP === null) return false;
  const r = bytesToBigint(sig.subarray(0, 32));
  const s = bytesToBigint(sig.subarray(32, 64));
  if (r >= P || s >= N) return false;

  const e = mod(bytesToBigint(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pubkey, msg)), N);
  // R = sG − eP
  const negE = mod(N - e, N);
  const pointR = pointAdd(pointMul(s), pointMul(negE, pointP));
  if (pointR === null) return false;
  return hasEvenY(pointR) && pointR.x === r;
}
