/**
 * The customer's half of the signing conventions — implemented from the
 * published rules, on the customer's side of the wire.
 *
 * Deliberately NOT imported from the platform: this package is what a bank's
 * integration team ships, so it holds its own copy of the two domain
 * separators and derives everything else from the public packages
 * (`attest-rules` owns the element convention, `attest-verify` owns JCS and
 * SHA-256). The platform's end-to-end flow is what keeps the two sides
 * honest with each other.
 *
 * Keys are `node:crypto` KeyObjects. The PEM the console hands you at
 * activation loads with `createPrivateKey(readFileSync(path))` — in
 * production the same calls route to your HSM provider's ES256 signer.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createHash } from 'node:crypto';
import { signedBytes, toBase64Url, fromBase64Url } from '@stonehash/attest-rules';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';

/** Domain for API events: authorizations, callbacks, webhooks, manifests. */
export const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';
/** Domain for an element's self-describing content digest. */
export const DIGEST_DOMAIN = 'stonehash:evidence:digest:v1\n';
/** Fields outside both the signature and the digest, per the evidence spec. */
const UNSIGNED_FIELDS = ['signature', 'digestVerified', 'attached', 'citedOnly'] as const;

export interface EventSig {
  alg: 'ES256';
  key_id: string;
  issuer: string;
  sig: string;
}

export const sha256hex = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

export function eventSigningBytes(payload: unknown): Buffer {
  return Buffer.concat([Buffer.from(EVENT_DOMAIN, 'utf8'), Buffer.from(jcs(payload as JcsValue))]);
}

export function signEvent(payload: unknown, key: KeyObject, keyId: string, issuer: string): EventSig {
  const raw = cryptoSign('sha256', eventSigningBytes(payload), { key, dsaEncoding: 'ieee-p1363' });
  return { alg: 'ES256', key_id: keyId, issuer, sig: toBase64Url(new Uint8Array(raw)) };
}

export function verifyEvent(payload: unknown, sig: EventSig, spkiBase64: string): boolean {
  if (sig?.alg !== 'ES256' || !sig.sig) return false;
  try {
    return cryptoVerify('sha256', eventSigningBytes(payload),
      { key: createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' }),
        dsaEncoding: 'ieee-p1363' },
      Buffer.from(fromBase64Url(sig.sig)));
  } catch {
    return false;
  }
}

export function elementDigest(element: Record<string, unknown>): string {
  const core: Record<string, unknown> = { ...element };
  for (const f of [...UNSIGNED_FIELDS, 'digest']) delete core[f];
  return sha256hex(Buffer.concat([
    Buffer.from(DIGEST_DOMAIN, 'utf8'), Buffer.from(jcs(core as JcsValue)),
  ]));
}

/**
 * Digest, then sign — the order every issuer must follow so the signature
 * covers the digest it declares.
 */
export function finishElement<T extends Record<string, unknown>>(
  element: T, key: KeyObject, keyId: string, issuer: string,
): T & { digest: string; signature: Record<string, unknown> } {
  const withDigest = { ...element, digest: elementDigest(element) };
  const raw = cryptoSign('sha256', Buffer.from(signedBytes(withDigest)), { key, dsaEncoding: 'ieee-p1363' });
  return {
    ...withDigest,
    signature: {
      status: 'VALID', keyId, algorithm: 'ES256', issuer,
      trustLevel: 'ATTESTED', value: toBase64Url(new Uint8Array(raw)),
    },
  };
}

export function spkiOf(key: KeyObject): string {
  return (createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}
