/**
 * JWE for the Travel Rule payload — ECDH-ES (P-256) + A256GCM, compact form.
 *
 * Exactly the construction the architecture pins (§6-4): the content key is
 * derived, not transported (empty encrypted-key part), the recipient is the
 * BFI's registered encryption key, and the protected header is bound as AAD
 * so a swapped header fails the tag. Implemented on `node:crypto` alone —
 * the Concat KDF (NIST SP 800-56A §5.8.1, as RFC 7518 §4.6 profiles it) is
 * the only piece not in the box, and it is validated against the RFC 7518
 * Appendix C vector in the test suite.
 *
 * What never appears here: the plaintext after encrypt() returns, or a
 * private key beyond the ephemeral one — generated, used for one ECDH, and
 * dropped.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** 32-bit big-endian length prefix, as the KDF's OtherInfo requires. */
function lenPrefixed(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/**
 * Concat KDF, single-block profile.
 *
 * For ECDH-ES direct key agreement the AlgorithmID is the **enc** value, and
 * A256GCM needs 256 bits — exactly one SHA-256 block, so the counter is the
 * constant 1. Kept general enough to derive the 128-bit RFC test vector.
 */
export function concatKdf(z: Buffer, bits: number, alg: string, apu = '', apv = ''): Buffer {
  const otherInfo = Buffer.concat([
    lenPrefixed(Buffer.from(alg, 'utf8')),
    lenPrefixed(Buffer.from(apu, 'utf8')),
    lenPrefixed(Buffer.from(apv, 'utf8')),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(bits, 0); return b; })(),
  ]);
  const out: Buffer[] = [];
  const blocks = Math.ceil(bits / 256);
  for (let i = 1; i <= blocks; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i, 0);
    out.push(createHash('sha256').update(Buffer.concat([counter, z, otherInfo])).digest());
  }
  return Buffer.concat(out).subarray(0, bits / 8);
}

interface EpkJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }

function publicKeyFromJwk(jwk: JsonWebKey): KeyObject {
  return createPublicKey({ key: jwk as never, format: 'jwk' });
}

/**
 * Encrypt to a P-256 JWK. Returns RFC 7516 compact serialisation
 * (`header..iv.ciphertext.tag` — the second part empty, as ECDH-ES direct
 * requires).
 */
export function encryptJwe(plaintext: Buffer, recipientJwk: JsonWebKey, kid?: string): string {
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const z = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyFromJwk(recipientJwk),
  });
  const cek = concatKdf(z, 256, 'A256GCM');

  const epk = ephemeral.publicKey.export({ format: 'jwk' }) as unknown as EpkJwk;
  const header: Record<string, unknown> = {
    alg: 'ECDH-ES',
    enc: 'A256GCM',
    epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y },
    ...(kid ? { kid } : {}),
  };
  const protectedB64 = b64u(Buffer.from(JSON.stringify(header), 'utf8'));

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(protectedB64, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${protectedB64}..${b64u(iv)}.${b64u(ciphertext)}.${b64u(tag)}`;
}

/** Decrypt a compact ECDH-ES/A256GCM JWE with the recipient's private key. */
export function decryptJwe(compact: string, recipientPrivate: KeyObject): Buffer {
  const parts = compact.split('.');
  if (parts.length !== 5) throw new Error('jwe: expected 5 compact parts');
  const [protectedB64, encKey, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  if (encKey !== '') throw new Error('jwe: ECDH-ES direct must have an empty encrypted-key part');

  const header = JSON.parse(fromB64u(protectedB64).toString('utf8')) as {
    alg?: string; enc?: string; epk?: EpkJwk;
  };
  if (header.alg !== 'ECDH-ES' || header.enc !== 'A256GCM' || !header.epk) {
    throw new Error(`jwe: unsupported header alg=${header.alg} enc=${header.enc}`);
  }

  const z = diffieHellman({
    privateKey: recipientPrivate,
    publicKey: publicKeyFromJwk(header.epk as unknown as JsonWebKey),
  });
  const cek = concatKdf(z, 256, 'A256GCM');

  const decipher = createDecipheriv('aes-256-gcm', cek, fromB64u(ivB64));
  decipher.setAAD(Buffer.from(protectedB64, 'ascii'));
  decipher.setAuthTag(fromB64u(tagB64));
  return Buffer.concat([decipher.update(fromB64u(ctB64)), decipher.final()]);
}

/** Generate a P-256 encryption keypair (sandbox provisioning helper). */
export function generateEncryptionKey(): { privatePem: string; publicJwk: JsonWebKey } {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    publicJwk: kp.publicKey.export({ format: 'jwk' }) as JsonWebKey,
  };
}

export { createPrivateKey as jwePrivateKeyFromPem };
