/**
 * The attestation statement — what an issuer signs, and what the chain commits to.
 *
 * ## Why this exists
 *
 * Anchoring `sha256(document)` proves a document existed by a block height. It
 * says nothing about **who** published it: anyone can hash a file. An issuer
 * signature fixes that, but a signature living only in the bundle would prove
 * authorship without time — nothing stops it being produced later and attached
 * to an older anchor.
 *
 * So the signature goes *inside* the thing the chain commits to. The leaf is
 * the hash of a statement that already contains the signature, which makes a
 * single block height cover three facts at once:
 *
 *   1. this document existed,
 *   2. this issuer signed it,
 *   3. both were true by that block.
 *
 * ## Why it lives in `attest-verify`
 *
 * Three independent programs have to agree on these bytes exactly: the signing
 * SDK a customer runs offline, the service that anchors, and the verifier that
 * checks the result years later. One character of disagreement in the
 * canonicalisation produces a signature that fails with no useful error. This
 * module is the single definition, and the verifier package is where it
 * belongs because that is the one everybody already depends on.
 *
 * ## What is signed, exactly
 *
 *     "stonehash:attestation:sig:v1\n" ‖ JCS(statement without `signature`)
 *
 * The domain separator means a signature made here can never be replayed as a
 * signature over settlement evidence, which uses `stonehash:evidence:sig:v1`
 * over its own structure. `signature` is excluded for the obvious reason that
 * it cannot be an input to itself.
 *
 * ## What the chain gets
 *
 *     leaf_bytes = sha256(JCS(statement *with* `signature`))
 *
 * Note the asymmetry: signing covers the statement without the signature,
 * anchoring covers it with. That is deliberate — the leaf must commit to the
 * signature, or the signature is not timestamped and this whole module is
 * pointless.
 */
import { sha256 } from './sha256.ts';
import { bytesToHex, concat, utf8 } from './bytes.ts';
import { jcs } from './jcs.ts';
import { verifyP256 } from './p256.ts';
import type { JcsValue } from './jcs.ts';

/** Prefix on the signing input. Never reused by any other structure. */
export const STATEMENT_DOMAIN = 'stonehash:attestation:sig:v1\n';

export const STATEMENT_SCHEMA = 'stonehash-attestation-statement/v1';

/**
 * Algorithms a statement may declare.
 *
 * `ES256` is the default and what the SDK generates: P-256 is what WebCrypto,
 * WebAuthn and most KMS products produce, and its signatures are 64 bytes.
 * `RS256` exists because banks have RSA keys in hardware they cannot replace
 * to suit us.
 */
export type StatementAlgorithm = 'ES256' | 'RS256';

export interface StatementIssuer {
  /** Stable id for the key. The verifier reports it; it proves nothing alone. */
  key_id: string;
  algorithm: StatementAlgorithm;
  /** SPKI DER, base64. The public half, carried so the bundle is self-contained. */
  public_key: string;
}

/** The signed core. Field order is irrelevant — JCS sorts it. */
export interface StatementCore {
  schema: typeof STATEMENT_SCHEMA;
  document: {
    /** SHA-256 of the document bytes, 64 lowercase hex. */
    sha256: string;
    content_type?: string;
  };
  issuer: StatementIssuer;
  /** When the issuer signed. A claim; the block height is the checkable one. */
  issued_at: string;
}

export interface SignedStatement extends StatementCore {
  /** base64url, over `statementSigningInput(core)`. */
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Reject anything that would produce a statement nobody can verify.
 *
 * Checked here rather than at each caller because all three implementations
 * route through this module, and a malformed statement is cheapest to catch
 * before a signature is made over it.
 */
export function assertStatementCore(core: StatementCore): void {
  if (core.schema !== STATEMENT_SCHEMA) {
    throw new Error(`statement schema must be ${STATEMENT_SCHEMA}`);
  }
  if (!HEX64.test(core.document.sha256)) {
    throw new Error('document.sha256 must be 64 lowercase hex characters');
  }
  if (!core.issuer.key_id) throw new Error('issuer.key_id is required');
  if (core.issuer.algorithm !== 'ES256' && core.issuer.algorithm !== 'RS256') {
    throw new Error(`unsupported algorithm: ${String(core.issuer.algorithm)}`);
  }
  if (!core.issuer.public_key) throw new Error('issuer.public_key is required');
  if (Number.isNaN(Date.parse(core.issued_at))) {
    throw new Error('issued_at must be an ISO-8601 timestamp');
  }
}

/** Strip `signature` and nothing else, so signing and verifying agree. */
function coreOf(s: StatementCore | SignedStatement): StatementCore {
  const { signature: _drop, ...core } = s as SignedStatement;
  return core as StatementCore;
}

/**
 * The exact bytes an issuer signs.
 *
 * Takes a signed statement happily — it strips the signature — so a verifier
 * can hand over what it parsed without having to reconstruct the core.
 */
export function statementSigningInput(s: StatementCore | SignedStatement): Uint8Array {
  const core = coreOf(s);
  assertStatementCore(core);
  return concat(utf8(STATEMENT_DOMAIN), jcs(core as unknown as JcsValue));
}

/**
 * `leaf_bytes` for a signed anchor — the hash of the statement *including*
 * its signature. This is the 32 bytes that reach Bitcoin.
 */
export function statementLeaf(s: SignedStatement): string {
  assertStatementCore(coreOf(s));
  if (!s.signature) throw new Error('a signed statement needs its signature');
  return bytesToHex(sha256(jcs(s as unknown as JcsValue)));
}

/** Build a core from the parts a caller actually has. */
export function buildStatement(opts: {
  documentSha256: string;
  contentType?: string;
  keyId: string;
  algorithm?: StatementAlgorithm;
  publicKeySpkiBase64: string;
  issuedAt: string;
}): StatementCore {
  const core: StatementCore = {
    schema: STATEMENT_SCHEMA,
    document: {
      sha256: opts.documentSha256.toLowerCase(),
      ...(opts.contentType ? { content_type: opts.contentType } : {}),
    },
    issuer: {
      key_id: opts.keyId,
      algorithm: opts.algorithm ?? 'ES256',
      public_key: opts.publicKeySpkiBase64,
    },
    issued_at: opts.issuedAt,
  };
  assertStatementCore(core);
  return core;
}

// ── verification ───────────────────────────────────────────────────────────

export interface StatementVerdict {
  /** The signature checks out against the key the statement carries. */
  signatureOk: boolean;
  /** `sha256(JCS(statement))` equals the leaf the chain committed to. */
  leafOk: boolean;
  keyId: string;
  algorithm: string;
  computedLeaf: string;
  /** Set when the check could not run at all. */
  error?: string;
}

/**
 * base64 or base64url → bytes.
 *
 * The padding is re-added. A 64-byte ES256 signature encodes to 86 base64url
 * characters with its `==` stripped, and `atob` rejects that length in some
 * engines while Node's Buffer accepts it — so the same signature verified
 * under `node --test` and failed in a browser, reported only as "signature
 * does not verify". `attest-rules/signature.ts` pads for exactly this reason.
 */
function b64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const algorithmParams = (alg: StatementAlgorithm): {
  importParams: EcKeyImportParams | RsaHashedImportParams;
  verifyParams: EcdsaParams | AlgorithmIdentifier;
} => alg === 'ES256'
  ? {
      importParams: { name: 'ECDSA', namedCurve: 'P-256' },
      verifyParams: { name: 'ECDSA', hash: 'SHA-256' },
    }
  : {
      importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      verifyParams: { name: 'RSASSA-PKCS1-v1_5' },
    };

/**
 * Check a signed statement against the leaf the chain carries.
 *
 * Both halves are reported separately. A statement whose signature verifies
 * but whose hash is not what was anchored is a different failure from one
 * anchored correctly with a bad signature, and collapsing them would hide
 * which.
 *
 * The key comes from the statement itself, so this proves *consistency*, not
 * identity: it shows the holder of that key signed this document. Deciding
 * whether that key belongs to who it claims is a separate question, and the
 * reason `trustLevel` exists elsewhere in this system.
 */
export async function verifyStatement(
  statement: SignedStatement, anchoredLeafHex: string,
): Promise<StatementVerdict> {
  const base: StatementVerdict = {
    signatureOk: false,
    leafOk: false,
    keyId: statement?.issuer?.key_id ?? '',
    algorithm: statement?.issuer?.algorithm ?? '',
    computedLeaf: '',
  };
  try {
    const computedLeaf = statementLeaf(statement);
    const leafOk = computedLeaf === anchoredLeafHex.toLowerCase();

    const sig = b64ToBytes(statement.signature);
    const spki = b64ToBytes(statement.issuer.public_key);
    const input = statementSigningInput(statement);

    /*
     * `crypto.subtle` is withheld outside a secure context, and the console
     * and Playground are reached over plain http at an IP address. Falling
     * back rather than failing keeps verification working exactly where a
     * sceptical reader is most likely to be standing — the symptom otherwise
     * is "the signature does not verify", which is both unhelpful and untrue.
     *
     * ES256 only: `p256.ts` is verification-only and small. RSA stays with
     * WebCrypto and says so rather than returning a quiet false.
     */
    if (!globalThis.crypto?.subtle) {
      if (statement.issuer.algorithm !== 'ES256') {
        return {
          ...base, computedLeaf, leafOk,
          error: 'RS256 needs WebCrypto, which a browser withholds outside a secure '
            + 'context. Open this page over HTTPS to check an RSA signature.',
        };
      }
      return { ...base, computedLeaf, leafOk, signatureOk: verifyP256(sig, input, spki) };
    }

    const { importParams, verifyParams } = algorithmParams(statement.issuer.algorithm);
    const key = await crypto.subtle.importKey(
      'spki', spki as BufferSource, importParams, false, ['verify'],
    );
    const signatureOk = await crypto.subtle.verify(
      verifyParams, key, sig as BufferSource, input as BufferSource,
    );
    return { ...base, computedLeaf, leafOk, signatureOk };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
