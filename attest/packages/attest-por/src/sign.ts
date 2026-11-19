/**
 * Signing a snapshot statement, and the one file that travels.
 *
 * The statement says "these were our liabilities at this time"; the signature
 * is what makes it the exchange's statement rather than anyone's. Signing is
 * its own step, apart from sending, for two reasons that both come from how
 * an exchange actually runs:
 *
 *   - the machine that holds the signing key is often not the machine allowed
 *     to open a connection to the internet, so "sign" has to end in a file
 *     that can be carried from one to the other;
 *   - before anything leaves the building somebody will want to read it, and
 *     the file written here is byte for byte what `submit` sends. There is no
 *     second payload assembled later from things the reviewer did not see.
 *
 * The convention is the platform's published event signature — ECDSA P-256
 * over SHA-256, raw r‖s, over `stonehash:remit:event:v1\n` followed by the
 * statement's canonical JSON — implemented here from the specification so the
 * SDK stands on the public packages alone. Canonical JSON is taken over the
 * parsed value, so re-indenting or re-ordering the file changes neither the
 * signature nor the commitment.
 */
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { jcs, toBase64Url } from './compat.ts';
import { validateSnapshotStatement } from './snapshot.ts';
import type { PorSnapshotStatement } from './snapshot.ts';

const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';

export interface PorSignature {
  alg: 'ES256';
  /** The exchange's institution id; names the registered key the platform checks against. */
  key_id: string;
  issuer: string;
  /** base64url of the 64-byte r‖s. */
  sig: string;
}

/** Exactly the body of `POST /v1/por/snapshots`, minus the optional `spot_check`. */
export interface PorSubmission {
  schema: 'stonehash.por-submission.v1';
  statement: PorSnapshotStatement;
  sig: PorSignature;
}

function signedBytes(statement: PorSnapshotStatement): Buffer {
  return Buffer.concat([Buffer.from(EVENT_DOMAIN, 'utf8'), Buffer.from(jcs(statement as never))]);
}

function assertP256(key: KeyObject): void {
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
    throw new Error('the signing key must be an ECDSA P-256 key (ES256), the kind the console issues');
  }
}

export function signSnapshotStatement(statement: PorSnapshotStatement, key: KeyObject): PorSignature {
  assertP256(key);
  const raw = cryptoSign('sha256', signedBytes(statement), { key, dsaEncoding: 'ieee-p1363' });
  return {
    alg: 'ES256',
    key_id: statement.exchange.institution_id,
    issuer: statement.exchange.name,
    sig: toBase64Url(new Uint8Array(raw)),
  };
}

/**
 * Check a signature against a public key (`spki`: base64 DER, as the platform
 * registers it). The platform runs the same check on arrival; running it here
 * first turns "the wrong key was used" from a rejected request into a message
 * on the machine where it can be fixed.
 */
export function verifySnapshotSignature(statement: PorSnapshotStatement, sig: PorSignature, spkiBase64: string): boolean {
  if (sig.alg !== 'ES256' || !/^[A-Za-z0-9_-]+$/.test(sig.sig)) return false;
  const raw = Buffer.from(sig.sig, 'base64url');
  if (raw.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify('sha256', signedBytes(statement), { key, dsaEncoding: 'ieee-p1363' }, raw);
  } catch {
    return false;
  }
}

/** The registered form of a key's public half: SPKI DER, base64. */
export function publicSpkiBase64(key: KeyObject): string {
  return (createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

export function buildSubmission(statement: PorSnapshotStatement, key: KeyObject): PorSubmission {
  const problems = validateSnapshotStatement(statement);
  if (problems.length > 0) throw new Error(`the statement is not valid: ${problems.join('; ')}`);
  return { schema: 'stonehash.por-submission.v1', statement, sig: signSnapshotStatement(statement, key) };
}

/** Shape check for a submission read back from disk; returns problems, empty = usable. */
export function validateSubmission(value: unknown): string[] {
  const s = value as Partial<PorSubmission> | null;
  if (!s || typeof s !== 'object') return ['the file is not a JSON object'];
  const p: string[] = [];
  if (s.schema !== 'stonehash.por-submission.v1') p.push('schema must be stonehash.por-submission.v1');
  p.push(...validateSnapshotStatement(s.statement));
  const sig = s.sig;
  if (!sig || typeof sig !== 'object') p.push('sig is missing');
  else {
    if (sig.alg !== 'ES256') p.push('sig.alg must be ES256');
    if (typeof sig.sig !== 'string' || Buffer.from(sig.sig, 'base64url').length !== 64) p.push('sig.sig must be 64 bytes, base64url');
  }
  return p;
}
