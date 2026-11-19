/**
 * Issuer signing — the half that runs on the customer's machine.
 *
 * ## What this is for
 *
 * Anchoring a digest proves a document existed by a block height. It does not
 * say who published it, because anyone can hash a file. An issuer signature
 * supplies that, and for it to mean anything the private key must never reach
 * us — a signature we could have produced proves nothing about the issuer.
 *
 * So this library exists to be run **by the customer, on their own machine**,
 * and its most important property is a negative one: it makes no network
 * calls. Not to us, not to anyone. The only way a key leaves the machine is
 * if the operator copies it out.
 *
 * ## Why it is a library rather than a written procedure
 *
 * The signed bytes are `"stonehash:attestation:sig:v1\n" ‖ JCS(statement)`,
 * where JCS is RFC 8785 canonical JSON. A re-implementation that sorts keys
 * slightly differently, or formats a number differently, produces a signature
 * that fails verification with no diagnostic worth reading. Documenting the
 * procedure guarantees that outcome eventually; shipping the canonicaliser
 * avoids it.
 *
 * The canonicalisation is not reimplemented here either — it comes from
 * `@stonehash/attest-verify`, the same module the verifier uses, so the
 * signer and the checker cannot drift.
 *
 * ## What it deliberately does not do
 *
 * It does not store keys, choose where they live, or encrypt them. Those are
 * the operator's decisions and their environment's job — an HSM, a KMS, a
 * file on an offline machine. A library that invented its own key store would
 * be asking to be trusted with the one thing it must not hold.
 */
import {
  buildStatement, statementLeaf, statementSigningInput, verifyStatement,
} from '@stonehash/attest-verify';
import type {
  SignedStatement, StatementAlgorithm, StatementCore,
} from '@stonehash/attest-verify';

export type { SignedStatement, StatementAlgorithm, StatementCore };
export { statementLeaf, statementSigningInput, buildStatement };

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');
const b64url = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const unb64 = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

/** A generated keypair, in the form an operator has to store. */
export interface GeneratedKey {
  keyId: string;
  algorithm: StatementAlgorithm;
  /** PKCS#8 DER, base64. **The secret.** Everything else here is public. */
  privateKeyPkcs8Base64: string;
  /** SPKI DER, base64. Goes in every statement and into the console. */
  publicKeySpkiBase64: string;
  createdAt: string;
}

const params = (alg: StatementAlgorithm): {
  gen: EcKeyGenParams | RsaHashedKeyGenParams;
  imp: EcKeyImportParams | RsaHashedImportParams;
  sig: EcdsaParams | AlgorithmIdentifier;
} => alg === 'ES256'
  ? {
      gen: { name: 'ECDSA', namedCurve: 'P-256' },
      imp: { name: 'ECDSA', namedCurve: 'P-256' },
      sig: { name: 'ECDSA', hash: 'SHA-256' },
    }
  : {
      gen: {
        name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
      },
      imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      sig: { name: 'RSASSA-PKCS1-v1_5' },
    };

/**
 * A key id that is unmistakably not a secret.
 *
 * Derived from the public key so it is stable and reproducible from material
 * the operator can share freely. Random would work equally well; derived
 * means a lost id can be recovered from the public key alone.
 */
export async function deriveKeyId(spkiBase64: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', unb64(spkiBase64) as BufferSource);
  return `ik_${Buffer.from(new Uint8Array(h).slice(0, 8)).toString('hex')}`;
}

/**
 * Generate a keypair, here, with this machine's randomness.
 *
 * `crypto.subtle.generateKey` draws from the platform CSPRNG. Nothing in this
 * process contributes a seed, derives from a constant, or records the result
 * anywhere — the returned object is the only copy, and what happens to it is
 * the caller's decision.
 *
 * ES256 by default: P-256 is what WebCrypto, WebAuthn, and most KMS products
 * speak, and its signatures are 64 bytes rather than RSA's 256, which matters
 * when they are going into a Bitcoin witness.
 */
export async function generateKey(algorithm: StatementAlgorithm = 'ES256'): Promise<GeneratedKey> {
  const { gen } = params(algorithm);
  const kp = await crypto.subtle.generateKey(gen, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKeySpkiBase64 = b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  return {
    keyId: await deriveKeyId(publicKeySpkiBase64),
    algorithm,
    privateKeyPkcs8Base64: b64(await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
    publicKeySpkiBase64,
    createdAt: new Date().toISOString(),
  };
}

export interface SignOptions {
  /** SHA-256 of the document, 64 hex. Hash the file yourself; it is not read here. */
  documentSha256: string;
  contentType?: string;
  /** Overridden only by tests that need a fixed statement. */
  issuedAt?: string;
}

/**
 * Sign a statement about one document.
 *
 * The document itself is never passed in — only its digest. That is not an
 * optimisation: it means this function cannot read, copy or transmit the
 * file, and an operator can satisfy themselves of that by reading one
 * signature.
 */
export async function signStatement(
  key: Pick<GeneratedKey, 'keyId' | 'algorithm' | 'privateKeyPkcs8Base64' | 'publicKeySpkiBase64'>,
  opts: SignOptions,
): Promise<SignedStatement> {
  const core: StatementCore = buildStatement({
    documentSha256: opts.documentSha256,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKeySpkiBase64: key.publicKeySpkiBase64,
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
  });

  const { imp, sig } = params(key.algorithm);
  const priv = await crypto.subtle.importKey(
    'pkcs8', unb64(key.privateKeyPkcs8Base64) as BufferSource, imp, false, ['sign']);
  const signature = await crypto.subtle.sign(
    sig, priv, statementSigningInput(core) as BufferSource);

  return { ...core, signature: b64url(signature) };
}

/**
 * Sign a statement the console has already composed.
 *
 * The console shows the operator exactly what will be signed, so the offline
 * step should sign *that*, not a reconstruction of it. Reconstructing invites
 * the one failure this whole design is arranged to avoid: two canonical forms
 * that differ by a character.
 */
export async function signPreparedStatement(
  key: Pick<GeneratedKey, 'algorithm' | 'privateKeyPkcs8Base64'>,
  core: StatementCore,
): Promise<SignedStatement> {
  const { imp, sig } = params(key.algorithm);
  const priv = await crypto.subtle.importKey(
    'pkcs8', unb64(key.privateKeyPkcs8Base64) as BufferSource, imp, false, ['sign']);
  const signature = await crypto.subtle.sign(
    sig, priv, statementSigningInput(core) as BufferSource);
  return { ...core, signature: b64url(signature) };
}

// ── signing with a key that cannot leave its hardware ───────────────────────

/**
 * What an HSM, a KMS or a smartcard looks like from here: something that can
 * sign bytes it is handed, for a key whose public half is known. The private
 * key never appears in this process — that is the point of the interface.
 *
 * `sign` may return the signature in whatever form the device produces. For
 * ES256 both encodings in circulation are accepted — raw `r‖s` (WebCrypto,
 * PKCS#11) and ASN.1 DER (OpenSSL, most KMS products) — and the result is
 * verified against the statement's public key before it is returned.
 */
export interface ExternalSigner {
  algorithm: StatementAlgorithm;
  /** SPKI DER, base64 — the public half, exportable from any HSM or KMS. */
  publicKeySpkiBase64: string;
  /** Derived from the public key when omitted. */
  keyId?: string;
  sign(input: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/**
 * DER `ECDSA-Sig-Value` → raw 64-byte `r‖s`, or null where the bytes are not
 * that. Strict — every length must account for every byte — because the
 * caller uses "parses as DER" to decide how to treat an ambiguous signature.
 */
function derToRawP256(der: Uint8Array): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let seqLen = der[i++]!;
  // One long-form length byte: never needed at P-256 sizes, but some
  // encoders emit it anyway and the bytes are not wrong, only verbose.
  if (seqLen === 0x81) seqLen = der[i++]!;
  else if (seqLen >= 0x80) return null;
  if (seqLen !== der.length - i) return null;
  const readInt = (): Uint8Array | null => {
    if (der[i++] !== 0x02) return null;
    const len = der[i++]!;
    if (len === 0 || len > 33 || i + len > der.length) return null;
    let b = der.subarray(i, i + len);
    i += len;
    if (b[0] === 0x00) b = b.subarray(1); // sign padding
    if (b.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(b, 32 - b.length);
    return out;
  };
  const r = readInt();
  if (!r) return null;
  const s = readInt();
  if (!s) return null;
  if (i !== der.length) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/**
 * The encodings a signature might arrive in, in the order worth trying.
 *
 * 64 bytes is taken as raw `r‖s`; anything that parses as strict DER is
 * converted. Both can be true of the same bytes — it takes a deliberate
 * construction, but the cost of guessing wrong is a sound signature reported
 * invalid — so every candidate is returned and verification decides.
 */
function signatureCandidates(algorithm: StatementAlgorithm, sig: Uint8Array): Uint8Array[] {
  if (algorithm !== 'ES256') return [sig];
  const candidates: Uint8Array[] = [];
  if (sig.length === 64) candidates.push(sig);
  const fromDer = derToRawP256(sig);
  if (fromDer) candidates.push(fromDer);
  if (candidates.length === 0) {
    throw new Error(
      `an ES256 signature is 64 raw bytes or their DER encoding; got ${sig.length} `
      + 'bytes that are neither. Check the device signed with ECDSA over SHA-256.');
  }
  return candidates;
}

/**
 * Sign a statement the console or `prepare` already composed, with a key
 * held elsewhere.
 *
 * The signature is verified before it is returned. An external device offers
 * more ways to go quietly wrong than WebCrypto does — a key picked by the
 * wrong alias, the wrong hash, bytes mangled in transit — and each of them
 * would otherwise surface months later, as "does not verify", in front of a
 * recipient instead of the operator who can fix it.
 */
export async function signPreparedStatementWith(
  signer: Pick<ExternalSigner, 'algorithm' | 'sign'>,
  core: StatementCore,
): Promise<SignedStatement> {
  const produced = await signer.sign(statementSigningInput(core));
  for (const sig of signatureCandidates(signer.algorithm, produced)) {
    const statement: SignedStatement = { ...core, signature: b64url(sig) };
    if ((await verifyStatement(statement, statementLeaf(statement))).signatureOk) {
      return statement;
    }
  }
  throw new Error(
    'the external signature does not verify against the public key in the statement. '
    + 'Check that the device signed exactly the prepared input bytes, with SHA-256, '
    + 'using the key whose public half the statement names.');
}

/** `signStatement`, for a key that cannot leave its hardware. */
export async function signStatementWith(
  signer: ExternalSigner, opts: SignOptions,
): Promise<SignedStatement> {
  const core = buildStatement({
    documentSha256: opts.documentSha256,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    keyId: signer.keyId ?? await deriveKeyId(signer.publicKeySpkiBase64),
    algorithm: signer.algorithm,
    publicKeySpkiBase64: signer.publicKeySpkiBase64,
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
  });
  return signPreparedStatementWith(signer, core);
}
