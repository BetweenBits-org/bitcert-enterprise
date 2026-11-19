/**
 * Remit signing — ES256 (P-256) over domain-separated JCS bytes.
 *
 * Two domains, one primitive:
 *
 * - **Evidence elements** use `attest-rules`' own convention verbatim
 *   (`stonehash:evidence:sig:v1\n` + JCS of the element minus its unsigned
 *   fields), so an element signed by a bank's HSM or the BFI simulator is
 *   verified by `verifyEvidenceSignatures` with no adapter in between — the
 *   six-axis engine consumes real cryptography, not a status we asserted.
 *
 * - **Events** (state transitions, webhooks, API authorisations) use
 *   `stonehash:remit:event:v1\n` + JCS of the payload. Same curve, same
 *   encoding (raw r‖s, base64url), different domain so a signature over an
 *   event can never be replayed as a signature over evidence or vice versa.
 *
 * Signatures travel detached as `{ alg, key_id, issuer, sig }`. Compact JWS
 * with X.509 chains is the production target (arch doc §7-1) and a P2 item;
 * what matters now is that every byte signed here is independently
 * re-verifiable from the registry's public keys alone.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { signedBytes, toBase64Url, fromBase64Url } from '@stonehash/attest-rules';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';

export const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';

/** Detached signature envelope carried next to the payload it covers. */
export interface EventSig {
  alg: 'ES256';
  key_id: string;
  issuer: string;
  sig: string; // base64url, raw r||s (64 bytes)
}

export function eventSigningBytes(payload: unknown): Buffer {
  return Buffer.concat([Buffer.from(EVENT_DOMAIN, 'utf8'), Buffer.from(jcs(payload as JcsValue))]);
}

export function signEvent(payload: unknown, key: KeyObject, keyId: string, issuer: string): EventSig {
  const raw = sign('sha256', eventSigningBytes(payload), { key, dsaEncoding: 'ieee-p1363' });
  return { alg: 'ES256', key_id: keyId, issuer, sig: toBase64Url(new Uint8Array(raw)) };
}

export function verifyEvent(payload: unknown, sig: EventSig, spkiBase64: string): boolean {
  if (sig.alg !== 'ES256' || !sig.sig) return false;
  let pub: KeyObject;
  try {
    pub = publicKeyFromSpki(spkiBase64);
  } catch {
    return false;
  }
  try {
    return verify('sha256', eventSigningBytes(payload),
      { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromBase64Url(sig.sig)));
  } catch {
    return false;
  }
}

/**
 * Sign one settlement-evidence element in place, `attest-rules` convention.
 *
 * The returned element carries the `signature` field the engine expects; its
 * `status` is a claim that `verifyEvidenceSignatures` recomputes — we never
 * ship a status the verifier did not establish.
 */
export function signEvidenceElement<T extends Record<string, unknown>>(
  element: T, key: KeyObject, keyId: string, issuer: string,
): T & { signature: Record<string, unknown> } {
  const raw = sign('sha256', Buffer.from(signedBytes(element)), { key, dsaEncoding: 'ieee-p1363' });
  return {
    ...element,
    signature: {
      status: 'VALID',
      keyId,
      algorithm: 'ES256',
      issuer,
      trustLevel: 'ATTESTED',
      value: toBase64Url(new Uint8Array(raw)),
    },
  };
}

// ── Key material ───────────────────────────────────────────────────────────

export function publicKeyFromSpki(spkiBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
}

export function spkiFromPublicKey(pub: KeyObject): string {
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

/** SPKI → JWK, for the keyring `verifyEvidenceSignatures` consumes. */
export function spkiToJwk(spkiBase64: string): JsonWebKey {
  return publicKeyFromSpki(spkiBase64).export({ format: 'jwk' }) as JsonWebKey;
}

/**
 * Why offered key material cannot be used, for the door that refuses it.
 *
 * `message` completes "the key is …", so each caller names the key its own
 * way. None of them quotes the material: a refused value may be a private
 * key, and an error message is copied into logs and onto screens.
 */
export interface KeyProblem {
  code: 'private_key_refused' | 'invalid_public_key' | 'unsupported_algorithm';
  message: string;
}

/** The containers a private key travels in. An SPKI decodes as none of them. */
const PRIVATE_KEY_TYPES = ['pkcs8', 'sec1', 'pkcs1'] as const;

/**
 * Decode offered material as an SPKI public key, naming a private key as one.
 *
 * The private-key test comes first and is not a formality: bare base64 has
 * no PEM armour saying PRIVATE KEY, so a pasted PKCS#8 looks like any other
 * base64 until it is decoded — and stored, it would be served back by every
 * list of "public" keys. Armour, when it is there, is read too: it would
 * otherwise decode as noise and be refused as merely malformed. (The space in
 * "PRIVATE KEY" is outside the base64 alphabet, so no SPKI can contain it.)
 */
function offeredSpki(spkiBase64: string): { key: KeyObject } | { problem: KeyProblem } {
  const privateKey: KeyProblem = { code: 'private_key_refused',
    message: 'a private key — only the public half (SPKI, base64) is ever registered; the private key stays with whoever signs' };
  if (spkiBase64.includes('PRIVATE KEY')) return { problem: privateKey };
  const der = Buffer.from(spkiBase64, 'base64');
  for (const type of PRIVATE_KEY_TYPES) {
    try {
      createPrivateKey({ key: der, format: 'der', type });
      return { problem: privateKey };
    } catch { /* not this container */ }
  }
  try {
    return { key: createPublicKey({ key: der, format: 'der', type: 'spki' }) };
  } catch {
    return { problem: { code: 'invalid_public_key',
      message: 'not a base64-encoded SPKI (DER) public key, which is what the SDK\'s generateSigningKey() emits' } };
  }
}

/** Why `spkiBase64` cannot be stored as public key material of any algorithm, or `null`. */
export function publicKeyProblem(spkiBase64: string): KeyProblem | null {
  const offered = offeredSpki(spkiBase64);
  return 'problem' in offered ? offered.problem : null;
}

/**
 * Why `spkiBase64` cannot be an ES256 verification key, or `null` when it can.
 *
 * ES256 is ECDSA on P-256 and nothing else. The registry's keyring converts
 * every institution key with `spkiToJwk` and the verifier imports the result
 * as P-256, so a key that decodes as anything else fails one of two ways: the
 * conversion throws (brainpool, RSA-PSS, DSA) while the keyring is built —
 * one keyring, every tenant — or it converts and every signature checked
 * against it reads INVALID (RSA, P-384, secp256k1). Both are refused where a
 * key becomes an institution's — activation and the signing-key switch — and
 * already at console registration, so neither a new key nor a row stored
 * before these checks existed can reach the keyring.
 */
export function es256PublicKeyProblem(spkiBase64: string): KeyProblem | null {
  const offered = offeredSpki(spkiBase64);
  if ('problem' in offered) return offered.problem;
  const { key } = offered;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  const notEs256: KeyProblem = {
    code: 'unsupported_algorithm',
    message: `not an ES256 key: ES256 is ECDSA on P-256, and this one is ${key.asymmetricKeyType === 'ec'
      ? `EC on ${curve ?? 'explicit curve parameters'}` : (key.asymmetricKeyType ?? 'unknown').toUpperCase()}`,
  };
  if (key.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') return notEs256;
  // The keyring's own conversion, run once here: a key that passes this
  // cannot be the row that stops the keyring.
  try {
    const jwk = spkiToJwk(spkiBase64);
    return jwk.kty === 'EC' && jwk.crv === 'P-256' ? null : notEs256;
  } catch {
    return notEs256;
  }
}

export interface PlatformKey {
  key: KeyObject;
  publicSpkiBase64: string;
  keyId: string;
}

/**
 * The platform's own signing key, created on first boot and kept in the data
 * directory. Sandbox-grade custody by design: production custody is an HSM,
 * and nothing above this function would change.
 */
export function loadOrCreatePlatformKey(pemPath: string): PlatformKey {
  let pem: string;
  if (existsSync(pemPath)) {
    pem = readFileSync(pemPath, 'utf8');
  } else {
    mkdirSync(path.dirname(pemPath), { recursive: true });
    const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    pem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    writeFileSync(pemPath, pem);
    chmodSync(pemPath, 0o600);
  }
  const key = createPrivateKey(pem);
  const spki = spkiFromPublicKey(createPublicKey(key));
  const keyId = `STONEHASH-SIGN-${createHash('sha256').update(spki).digest('hex').slice(0, 8)}`;
  return { key, publicSpkiBase64: spki, keyId };
}

export const sha256hex = (b: Buffer | Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

/**
 * The content digest an element declares, recomputable by anyone.
 *
 * Same exclusion set as the signature (an element is its own source document
 * in this rail), different domain — so the digest can never be mistaken for
 * signing input. The issuer declares it at signing time; the evidence mapper
 * recomputes it and stamps `digestVerified`, which turns the integrity axis
 * into arithmetic rather than a claim.
 */
export const DIGEST_DOMAIN = 'stonehash:evidence:digest:v1\n';
const DIGEST_EXCLUDED = ['signature', 'digest', 'digestVerified', 'attached', 'citedOnly'] as const;

export function elementDigest(element: Record<string, unknown>): string {
  const core: Record<string, unknown> = { ...element };
  for (const f of DIGEST_EXCLUDED) delete core[f];
  return sha256hex(Buffer.concat([
    Buffer.from(DIGEST_DOMAIN, 'utf8'),
    Buffer.from(jcs(core as JcsValue)),
  ]));
}
