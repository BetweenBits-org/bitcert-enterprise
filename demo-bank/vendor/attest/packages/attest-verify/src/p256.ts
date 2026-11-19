/**
 * ECDSA P-256 verification, in plain JavaScript.
 *
 * ## Why this is not just `crypto.subtle.verify`
 *
 * `crypto.subtle` exists only in a secure context. The console and the
 * Playground are reached over plain `http://` at a bare IP address — no
 * certificate, no secure context — and in that setting `crypto.subtle` is
 * `undefined`. Every signature check then fails with
 * `Cannot read properties of undefined (reading 'importKey')`, surfaced to the
 * reader as "the signature does not verify", which points nowhere near the
 * cause and is the opposite of the truth.
 *
 * This package already ships a dependency-free SHA-256 for the same reason.
 * Hashing works on those deployments and verification did not, which left the
 * one screen whose entire job is checking a signature unable to check one.
 *
 * ## Scope
 *
 * Verification only, and P-256 only. There is no signing here and there never
 * should be: this package is what a *recipient* runs, and a verifier has no
 * use for a private key. RSA is left to WebCrypto — a bank with RSA keys is
 * not evaluating the product over plain http at an IP.
 *
 * Not constant-time, and it does not need to be: every input is public. A
 * signature, a public key and a message are exactly the three things an
 * attacker already has.
 */
import { sha256 } from './sha256.ts';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

/** `a = −3` on this curve, which is why the doubling formula differs from secp256k1's. */
const A = P - 3n;

type Point = { x: bigint; y: bigint } | null;
const G: Point = { x: GX, y: GY };

const mod = (a: bigint, m: bigint = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

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

/** Fermat inverse. `m` is prime for both moduli used here. */
const inv = (a: bigint, m: bigint = P): bigint => power(mod(a, m), m - 2n, m);

function double(p: Point): Point {
  if (p === null || p.y === 0n) return null;
  // λ = (3x² + a) / 2y — the `+ a` term is what secp256k1 omits.
  const lam = mod((3n * p.x * p.x + A) * inv(2n * p.y));
  const x = mod(lam * lam - 2n * p.x);
  return { x, y: mod(lam * (p.x - x) - p.y) };
}

function add(p: Point, q: Point): Point {
  if (p === null) return q;
  if (q === null) return p;
  if (p.x === q.x) return mod(p.y + q.y) === 0n ? null : double(p);
  const lam = mod((q.y - p.y) * inv(q.x - p.x));
  const x = mod(lam * lam - p.x - q.x);
  return { x, y: mod(lam * (p.x - x) - p.y) };
}

function mul(k: bigint, p: Point): Point {
  let n = mod(k, N);
  let acc: Point = null;
  let addend = p;
  while (n > 0n) {
    if (n & 1n) acc = add(acc, addend);
    addend = double(addend);
    n >>= 1n;
  }
  return acc;
}

const toBigint = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
};

const onCurve = (p: NonNullable<Point>): boolean =>
  mod(p.y * p.y) === mod(p.x * p.x * p.x + A * p.x + B);

/**
 * Pull the uncompressed point out of an SPKI DER public key.
 *
 * A P-256 SPKI ends with a BIT STRING holding `0x04 ‖ X ‖ Y`, 65 bytes. The
 * algorithm identifier in front of it is fixed for this curve, so rather than
 * walking the DER the tail is taken and checked — which fails loudly on a key
 * for some other curve instead of silently reading 64 bytes of the wrong
 * structure as coordinates.
 */
export function pointFromSpki(spki: Uint8Array): NonNullable<Point> {
  if (spki.length < 65) throw new Error('not a P-256 SPKI public key: too short');
  const tail = spki.subarray(spki.length - 65);
  if (tail[0] !== 0x04) {
    throw new Error('unsupported public key: expected an uncompressed P-256 point');
  }
  const p = { x: toBigint(tail.subarray(1, 33)), y: toBigint(tail.subarray(33, 65)) };
  if (p.x >= P || p.y >= P || !onCurve(p)) {
    throw new Error('public key is not a point on P-256');
  }
  return p;
}

/**
 * Verify an ECDSA P-256 signature over `message`, SHA-256 hashed.
 *
 * `signature` is the 64-byte `r ‖ s` form WebCrypto produces — not DER. The
 * two are easy to confuse and a DER signature passed here would simply fail,
 * so the length is checked rather than guessed at.
 */
export function verifyP256(
  signature: Uint8Array, message: Uint8Array, spki: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  const r = toBigint(signature.subarray(0, 32));
  const s = toBigint(signature.subarray(32, 64));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;

  let q: NonNullable<Point>;
  try {
    q = pointFromSpki(spki);
  } catch {
    return false;
  }

  const e = toBigint(sha256(message));
  const w = inv(s, N);
  const point = add(mul(mod(e * w, N), G), mul(mod(r * w, N), q));
  if (point === null) return false;
  return mod(point.x, N) === r;
}
