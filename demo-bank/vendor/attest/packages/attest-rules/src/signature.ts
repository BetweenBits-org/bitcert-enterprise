/**
 * Issuer-signature verification for settlement evidence (ECDSA P-256 / SHA-256).
 *
 * ## What this fixes
 *
 * `Signature.status` used to arrive in the evidence document as a claim. The
 * engine read `status === 'INVALID'` and branched on it, which meant the Bank
 * Review demo displayed `ISSUER VALID` because a fixture said so — no
 * cryptography ran anywhere. A review screen that renders an unverified
 * assertion as a verified one is the exact failure the six-axis design exists
 * to prevent, so the status is now an **output** of this module and the engine
 * refuses to treat an unverified one as valid.
 *
 * ## Why it is a separate pass rather than part of `evaluate()`
 *
 * WebCrypto's `verify` is asynchronous and `evaluate()` is not — it is called
 * synchronously from the HTTP route, the Playground and sixty-odd tests, and
 * making the engine async to reach a signature would spread `await` through all
 * of them.
 *
 * Splitting it is better than a workaround, though. Verification needs a
 * keyring; rule evaluation needs a policy. Keeping them apart means the engine
 * consumes *verified* facts and never holds a key, and the trust boundary is
 * visible in the call graph:
 *
 * ```ts
 * const checked = await verifyEvidenceSignatures(evidence, DEMO_KEYRING);
 * const verdict = evaluate(checked, policy);
 * ```
 *
 * ## What is signed
 *
 * `"stonehash:evidence:sig:v1\n" || JCS(element without its signature)`
 *
 * The element's own content, canonicalised by RFC 8785, with the `signature`
 * field removed so the signature is not an input to itself. A domain separator
 * prefixes it so a signature over an evidence element can never be replayed as
 * a signature over anything else this system hashes.
 *
 * Covering the whole element rather than a declared digest field is deliberate:
 * it means changing an amount breaks the signature. Scenario B (amount
 * mismatch) therefore now fails the issuer axis as well as matching, which is
 * what really happens when someone edits a signed instruction.
 */
import { jcs, utf8, concat, sha256, bytesToHex } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import type { Signature, SettlementEvidence, TrustLevel } from './types.ts';

/**
 * Domain separator. Versioned, because changing what is covered changes which
 * signatures verify, and that must be an explicit migration rather than a
 * silent reinterpretation of existing bytes.
 */
export const SIGNATURE_DOMAIN = 'stonehash:evidence:sig:v1\n';

/** Elements that can carry an issuer signature. */
const SIGNABLE = [
  'payoutReceipts', 'bankInstruction', 'commercialDocs',
  'travelRule', 'bankApproval', 'chainTransfer',
] as const;

/** A public key a verifier is willing to check against. */
export interface VerificationKey {
  keyId: string;
  /** Who the key claims to be. A claim, not a verified identity. */
  issuer: string;
  /**
   * How much weight this key's signature carries. `DEMO` is **not** an
   * identity: it means the signature is arithmetically sound and establishes
   * nothing about who produced it.
   */
  trustLevel: TrustLevel;
  /** Public half only. A verifier has no use for a private key. */
  publicKeyJwk: JsonWebKey;
}

/** Keys indexed by `keyId`. */
export type Keyring = Map<string, VerificationKey>;

export function keyring(keys: readonly VerificationKey[]): Keyring {
  const m = new Map<string, VerificationKey>();
  for (const k of keys) {
    if (m.has(k.keyId)) throw new Error(`duplicate keyId in keyring: ${k.keyId}`);
    m.set(k.keyId, k);
  }
  return m;
}

/** base64url → bytes. The signature travels as JWS-style base64url. */
export function fromBase64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Fields excluded from the signed payload.
 *
 * An issuer signs **what they assert** — the reference, the amount, the
 * currency, the parties, the digest of their own document. They do not assert
 * anything about how the submission was packaged or about what a reviewer later
 * recomputed, and a signature that covered those would make the issuer axis
 * move for reasons that have nothing to do with the issuer.
 *
 * These exclusions are load bearing, not conveniences. Each one keeps a
 * distinct axis from being dragged down by another, which is the separation the
 * six-axis design exists to provide:
 *
 * - `signature` — a signature cannot be an input to itself.
 * - `digestVerified` — our verification result. Covering it would mean
 *   `breakDigest`, whose whole purpose is to fail integrity while the issuer
 *   holds, also broke the signature.
 * - `attached` / `citedOnly` — which files arrived in this submission. A seller
 *   who signs an invoice does not thereby warrant that the courier enclosed
 *   every PDF. Covering these would make a *forgotten* invoice indistinguishable
 *   from a *forged* one, and telling those apart is the entire point of
 *   scenario D: missing evidence calls for a request, forged evidence calls for
 *   escalation, and conflating them sends the reviewer down the wrong path.
 */
const UNSIGNED_FIELDS = ['signature', 'digestVerified', 'attached', 'citedOnly'] as const;

/**
 * The exact bytes an issuer signs for one evidence element.
 *
 * Exported because a third party implementing their own checker needs it, and
 * because the signing tool must not compute it a second, slightly different
 * way — one definition, used by both sides.
 */
export function signedBytes(element: unknown): Uint8Array {
  if (!element || typeof element !== 'object') {
    throw new Error('signedBytes: element must be an object');
  }
  const core: Record<string, unknown> = { ...(element as Record<string, unknown>) };
  for (const f of UNSIGNED_FIELDS) delete core[f];
  return concat(utf8(SIGNATURE_DOMAIN), jcs(core as JcsValue));
}

/** The digest of those bytes, for display and for citing in a finding. */
export function signedDigest(element: unknown): string {
  return bytesToHex(sha256(signedBytes(element)));
}

/**
 * Copy into a standalone `ArrayBuffer` for WebCrypto.
 *
 * A `Uint8Array` can be a view onto a `SharedArrayBuffer`, which `BufferSource`
 * excludes, so the types do not line up without this. Copying rather than
 * casting is deliberate: it also detaches the payload from any buffer the
 * caller might still mutate while the verification is in flight.
 */
function detached(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

/** Imported keys are cached: the same demo key is checked many times a render. */
const imported = new Map<string, Promise<CryptoKey>>();

function importKey(key: VerificationKey): Promise<CryptoKey> {
  const cacheKey = `${key.keyId}:${JSON.stringify(key.publicKeyJwk)}`;
  let p = imported.get(cacheKey);
  if (!p) {
    p = crypto.subtle.importKey(
      'jwk', key.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    imported.set(cacheKey, p);
  }
  return p;
}

/**
 * Verify one element's signature.
 *
 * Returns the signature with a **computed** status and the `checked` marker the
 * engine requires. Every failure path is distinguished, because "the signature
 * is wrong", "we have no key for this signer" and "there is no signature" call
 * for three different responses from a reviewer.
 */
export async function verifySignature(
  element: unknown, keys: Keyring,
): Promise<Signature> {
  const declared = (element as { signature?: Signature } | undefined)?.signature;
  if (!declared || declared.status === 'ABSENT' || !declared.value) {
    // No signature to check. Note that a declared status with no `value` lands
    // here too: a document claiming VALID without carrying a signature is not
    // evidence of anything, and reporting it as absent is the honest reading.
    return { status: 'ABSENT', checked: true, ...(declared?.keyId ? { keyId: declared.keyId } : {}) };
  }

  const key = declared.keyId ? keys.get(declared.keyId) : undefined;
  if (!key) {
    return {
      ...declared,
      status: 'UNKNOWN_KEY',
      checked: true,
      // Trust cannot be inherited from the document. A signature naming an
      // unknown key tells us nothing, so it must not keep whatever
      // `trustLevel` the document asserted.
      trustLevel: undefined,
    };
  }

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importKey(key),
      detached(fromBase64Url(declared.value)),
      detached(signedBytes(element)),
    );
  } catch {
    // A malformed signature or key is a verification failure, not a crash. The
    // reviewer's screen must still render.
    ok = false;
  }

  return {
    ...declared,
    // The key's own trust level wins over anything the document claimed.
    issuer: key.issuer,
    trustLevel: key.trustLevel,
    algorithm: 'ES256',
    checked: true,
    // A demo key that verifies is `DEMO_VALID`, never `VALID`. The distinction
    // is the whole point: the arithmetic held and the identity is still
    // unestablished, and one word must not imply the other.
    status: !ok ? 'INVALID' : key.trustLevel === 'DEMO' ? 'DEMO_VALID' : 'VALID',
  };
}

/**
 * Verify every signature in an evidence document.
 *
 * Returns a copy. Mutating the caller's evidence would mean a verdict depended
 * on whether anyone had evaluated it before, and the engine's determinism is
 * the one property the whole product rests on.
 */
export async function verifyEvidenceSignatures(
  evidence: SettlementEvidence, keys: Keyring,
): Promise<SettlementEvidence> {
  const ev = structuredClone(evidence);
  const el = ev.elements as Record<string, unknown>;

  for (const name of SIGNABLE) {
    const node = el[name];
    if (!node) continue;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object' && 'signature' in item) {
          (item as { signature: Signature }).signature = await verifySignature(item, keys);
        }
      }
    } else if (typeof node === 'object' && 'signature' in node) {
      (node as { signature: Signature }).signature = await verifySignature(node, keys);
    }
  }
  return ev;
}
