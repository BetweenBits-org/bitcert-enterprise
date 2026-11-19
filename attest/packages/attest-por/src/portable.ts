/**
 * The exchange's side of a snapshot with nothing but the language: salts,
 * leaves and the signature, in plain JavaScript.
 *
 * `leaves.ts` and `sign.ts` do these with `node:crypto`, which is the right
 * tool on a server. This module exists for the one place that has no such
 * tool: a browser page reached over plain http, where the platform withholds
 * `crypto.subtle`. The sandbox console is such a page, and it builds and
 * signs a snapshot from a balance file the visitor picks — the file and the
 * key are read by the page and go no further — so the same derivations have
 * to exist in a form the page can run.
 *
 * Everything here is checked against its `node:crypto` counterpart in
 * `test/portable.test.ts`: the same salts byte for byte, and signatures the
 * server's verifier accepts.
 *
 * About signing in a page. The arithmetic below is not constant-time, and a
 * private key pasted into a browser is exposed to whatever else runs there.
 * That is acceptable for what this is for — a sandbox key, on a test
 * deployment, tried by hand. An exchange's production key belongs on its own
 * server or in its HSM, signed with the server SDK; the console says so next
 * to the button.
 *
 * The nonce is deterministic (RFC 6979), so no randomness is needed at
 * signing time and a weak random source cannot leak the key.
 */
import { jcs, p256KeypairFromSeed, porUserRefHash, sha256, utf8, concat, bytesToHex } from '@stonehash/attest-verify';
import type { PorBalances } from '@stonehash/attest-verify';
import type { PorLeafInput } from './sumtree.ts';
import type { PorSnapshotStatement } from './snapshot.ts';

/** The group order of P-256. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';

const toBigint = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
};
const bytes32 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};
const modN = (a: bigint): bigint => ((a % N) + N) % N;
function inverseModN(a: bigint): bigint {
  // Fermat: N is prime.
  let result = 1n;
  let base = modN(a);
  let e = N - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % N;
    base = (base * base) % N;
    e >>= 1n;
  }
  return result;
}

/** HMAC-SHA-256 (RFC 2104) over the package's own SHA-256. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { inner[i] = block[i]! ^ 0x36; outer[i] = block[i]! ^ 0x5c; }
  return sha256(concat(outer, sha256(concat(inner, message))));
}

/** The per-account salt — the same value `deriveSalt` in `leaves.ts` gives. */
export function deriveSaltPortable(seed: Uint8Array, userRef: string): string {
  if (seed.length !== 32) throw new Error('the master seed must be 32 bytes');
  return bytesToHex(hmacSha256(seed, utf8(userRef)));
}

/** One ledger row as the tree builder takes it — the same leaf `leafFromRow` gives. */
export function leafFromRowPortable(exchangeId: string, seed: Uint8Array, row: { user_ref: string; balances: PorBalances }): PorLeafInput {
  return {
    user_ref: row.user_ref,
    user_ref_hash: porUserRefHash(exchangeId, row.user_ref),
    salt: deriveSaltPortable(seed, row.user_ref),
    balances: row.balances,
  };
}

// ── reading a private key ──────────────────────────────────────────────────

/** id-ecPublicKey and prime256v1, as they sit in a key's algorithm identifier. */
const OID_EC = '2a8648ce3d0201';
const OID_P256 = '2a8648ce3d030107';

interface Tlv { tag: number; start: number; end: number }

/** One DER element at `at`: its tag and the span of its contents. */
function tlv(der: Uint8Array, at: number): Tlv {
  if (at + 2 > der.length) throw new Error('truncated');
  const tag = der[at]!;
  let len = der[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || start + n > der.length) throw new Error('unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | der[start + i]!;
    start += n;
  }
  if (start + len > der.length) throw new Error('truncated');
  return { tag, start, end: start + len };
}

/** `ECPrivateKey ::= SEQUENCE { version INTEGER (1), privateKey OCTET STRING, … }` → the scalar. */
function scalarFromEcPrivateKey(der: Uint8Array, at: number): Uint8Array {
  const seq = tlv(der, at);
  if (seq.tag !== 0x30) throw new Error('not a key');
  const version = tlv(der, seq.start);
  if (version.tag !== 0x02) throw new Error('not a key');
  const key = tlv(der, version.end);
  if (key.tag !== 0x04) throw new Error('not a key');
  const raw = der.subarray(key.start, key.end);
  if (raw.length === 0 || raw.length > 32) throw new Error('not a P-256 key');
  const d = new Uint8Array(32);
  d.set(raw, 32 - raw.length);
  return d;
}

/**
 * The private scalar from a PEM file: PKCS#8 (`BEGIN PRIVATE KEY`, what the
 * console and the SDK write) or SEC 1 (`BEGIN EC PRIVATE KEY`, what
 * `openssl ecparam` writes). Refuses anything that is not a P-256 key, and
 * says only that — never echoing what it was given.
 */
export function privateScalarFromPem(pem: string): Uint8Array {
  const m = /-----BEGIN (EC )?PRIVATE KEY-----([\s\S]*?)-----END (EC )?PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error('this is not a private key in PEM form (expected "-----BEGIN PRIVATE KEY-----")');
  let der: Uint8Array;
  try {
    const bin = atob(m[2]!.replace(/\s+/g, ''));
    der = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new Error('the private key file is damaged (its contents are not base64)');
  }
  try {
    let d: Uint8Array;
    if (m[1]) {
      d = scalarFromEcPrivateKey(der, 0);
    } else {
      const outer = tlv(der, 0);
      const version = tlv(der, outer.start);
      const algorithm = tlv(der, version.end);
      const hex = bytesToHex(der.subarray(algorithm.start, algorithm.end));
      if (!hex.includes(OID_EC) || !hex.includes(OID_P256)) throw new Error('not P-256');
      const wrapped = tlv(der, algorithm.end);
      if (wrapped.tag !== 0x04) throw new Error('not a key');
      d = scalarFromEcPrivateKey(der, wrapped.start);
    }
    const n = toBigint(d);
    if (n === 0n || n >= N) throw new Error('out of range');
    return d;
  } catch {
    throw new Error('this private key is not an ECDSA P-256 (ES256) key, the kind the console issues');
  }
}

/** The public half of a private scalar, as the platform registers it: SPKI DER, base64. */
export function publicSpkiFromScalar(d: Uint8Array): string {
  const spki = p256KeypairFromSeed(d).publicKeySpki;
  let bin = '';
  for (const byte of spki) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// ── signing ────────────────────────────────────────────────────────────────

/** The x coordinate of k·G. The curve arithmetic lives in the verifier package; a "key pair" for k is exactly that point. */
function xOfBasePointTimes(k: bigint): bigint {
  const spki = p256KeypairFromSeed(bytes32(k)).publicKeySpki;
  return toBigint(spki.subarray(spki.length - 64, spki.length - 32));
}

/** RFC 6979 §3.2: the nonce as a function of the key and the message hash. */
function* nonces(d: Uint8Array, hash: Uint8Array): Generator<bigint> {
  const h = bytes32(modN(toBigint(hash)));
  let v: Uint8Array = new Uint8Array(32).fill(0x01);
  let k: Uint8Array = new Uint8Array(32);
  k = hmacSha256(k, concat(v, Uint8Array.of(0x00), d, h));
  v = hmacSha256(k, v);
  k = hmacSha256(k, concat(v, Uint8Array.of(0x01), d, h));
  v = hmacSha256(k, v);
  for (;;) {
    v = hmacSha256(k, v);
    const candidate = toBigint(v);
    if (candidate >= 1n && candidate < N) yield candidate;
    k = hmacSha256(k, concat(v, Uint8Array.of(0x00)));
    v = hmacSha256(k, v);
  }
}

/** ECDSA P-256 over SHA-256, as the 64 bytes r ‖ s. `d` is the private scalar. */
export function signP256(d: Uint8Array, message: Uint8Array): Uint8Array {
  const key = toBigint(d);
  if (d.length !== 32 || key === 0n || key >= N) throw new Error('not a P-256 private key');
  const hash = sha256(message);
  const e = toBigint(hash);
  for (const k of nonces(d, hash)) {
    const r = modN(xOfBasePointTimes(k));
    if (r === 0n) continue;
    const s = modN(inverseModN(k) * modN(e + r * key));
    if (s === 0n) continue;
    return concat(bytes32(r), bytes32(s));
  }
  throw new Error('unreachable');
}

const base64url = (b: Uint8Array): string => {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** The signature envelope over a statement — the same shape, and as acceptable to the platform, as `signSnapshotStatement`'s. */
export function signSnapshotStatementPortable(statement: PorSnapshotStatement, d: Uint8Array): {
  alg: 'ES256'; key_id: string; issuer: string; sig: string;
} {
  const sig = signP256(d, concat(utf8(EVENT_DOMAIN), jcs(statement as never)));
  return { alg: 'ES256', key_id: statement.exchange.institution_id, issuer: statement.exchange.name, sig: base64url(sig) };
}
