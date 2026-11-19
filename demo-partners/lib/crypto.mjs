/**
 * Signing and encryption glue for the partner simulators.
 *
 * Imports the exact modules the platform itself uses — the point of the
 * simulators is to exercise the platform's contract, so there must be one
 * definition of the signing bytes, the element digest and the JWE profile,
 * not two that agree today. (A real counterparty re-implements these from
 * the published spec; the conformance fixtures are what hold that honest.)
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  signEvent, verifyEvent, signEvidenceElement, elementDigest,
  spkiFromPublicKey, sha256hex,
} from '../../attest/apps/core/src/remit/sign.ts';
import { decryptJwe, generateEncryptionKey } from '../../attest/apps/core/src/remit/jwe.ts';
import { jcs } from '../../attest/packages/attest-verify/src/index.ts';

export { signEvent, verifyEvent, elementDigest, sha256hex, decryptJwe, jcs };

export function newSigningKey() {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    spki: spkiFromPublicKey(kp.publicKey),
  };
}

export const newEncryptionKey = generateEncryptionKey;
export const privateKeyFromPem = (pem) => createPrivateKey(pem);
export const spkiOf = (pem) => spkiFromPublicKey(createPublicKey(createPrivateKey(pem)));

/** digest → sign, the order every issuer must follow. */
export function finishElement(core, keyPem, keyId, issuer) {
  const withDigest = { ...core, digest: elementDigest(core) };
  return signEvidenceElement(withDigest, createPrivateKey(keyPem), keyId, issuer);
}

export function signPayload(payload, keyPem, keyId, issuer) {
  return signEvent(payload, createPrivateKey(keyPem), keyId, issuer);
}
