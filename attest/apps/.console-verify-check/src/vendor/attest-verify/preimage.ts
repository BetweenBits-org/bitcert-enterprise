/**
 * Original → `leaf_bytes` — bundle-schema.md §2.1 (link A).
 *
 * This is the link that makes the rest mean anything. Merkle + anchor prove that
 * *some* 32-byte digest is committed to Bitcoin; only the preimage rule shows
 * that digest is **your** document or **your** balance row. A bundle with no
 * `preimage` section is still verifiable for links B and C, but link A must then
 * be reported as unverified rather than quietly passed.
 */
import { sha256 } from './sha256.ts';
import { bytesToHex, concat, utf8 } from './bytes.ts';
import { jcs } from './jcs.ts';
import type { JcsValue } from './jcs.ts';
import { deriveUserCommitment } from './recon.ts';

export interface PreimageSection {
  scheme: 'sha256-file' | 'sha256-jcs-fields' | 'sha256-signed-statement/v1';
  content_type?: string;
  domain?: string;
  fields?: Record<string, string>;
  commitment?: { scheme: string; salt_hex?: string; account_field?: string };
  /**
   * Present for `sha256-signed-statement/v1`: the statement the leaf hashes.
   *
   * Only `document.sha256` is read here; everything else is carried through
   * to the canonicaliser untouched. Deliberately typed without an index
   * signature so a concrete `SignedStatement` is assignable — the fields this
   * module does not name are still hashed, because JCS sees the object, not
   * the type.
   */
  statement?: {
    document?: { sha256?: string; content_type?: string };
  };
}

export interface PreimageResult {
  scheme: string;
  /** `need_original` means the rule is `sha256-file` and no file was supplied. */
  status: 'checked' | 'need_original';
  computed?: string;
  /** Recomputed digest equals `record.leaf_bytes`. */
  selfOk?: boolean;
  /** Only for `sha256-jcs-fields` with an account id + salt supplied.
   *  `undefined` = not attempted; `false` = attempted and mismatched. */
  identityOk?: boolean;
  /** Signed statements: the original hashed to the digest the statement
   *  declares. `undefined` = no original was supplied, so it was not checked. */
  documentOk?: boolean;
  /** Signed statements: the digest the statement commits to. */
  documentDigest?: string;
}

export interface PreimageInput {
  originalBytes?: Uint8Array;
  accountId?: string;
  saltHex?: string;
}

/**
 * Recompute `leaf_bytes` from the original per the declared rule.
 * Returns `null` when the bundle declares no rule. Throws on an unknown scheme —
 * silently skipping an unrecognised rule would report link A as fine when it was
 * never evaluated.
 */
export function verifyPreimage(
  leafBytesHex: string,
  pre: PreimageSection | undefined | null,
  input: PreimageInput = {},
): PreimageResult | null {
  if (!pre) return null;
  const leaf = leafBytesHex.toLowerCase();

  if (pre.scheme === 'sha256-file') {
    if (!input.originalBytes) return { scheme: pre.scheme, status: 'need_original' };
    const computed = bytesToHex(sha256(input.originalBytes));
    return { scheme: pre.scheme, status: 'checked', computed, selfOk: computed === leaf };
  }

  /*
   * A signed anchor. The leaf is not the document's digest — it is the hash
   * of an issuer statement that *contains* that digest alongside the
   * signature, so one block height timestamps the document and the signature
   * together.
   *
   * Link A therefore has two halves and they fail differently:
   *
   *   statement → leaf     always checkable, from the bundle alone
   *   document  → statement  needs the original, exactly as `sha256-file` does
   *
   * `selfOk` reports the first. The second is reported through `documentOk`
   * and left `undefined` when no original was supplied, so a reader is never
   * told their document matched when nobody looked at it.
   */
  if (pre.scheme === 'sha256-signed-statement/v1') {
    const st = pre.statement;
    if (!st) {
      throw new Error('sha256-signed-statement/v1 requires the statement it commits to');
    }
    const computed = bytesToHex(sha256(jcs(st as unknown as JcsValue)));
    const res: PreimageResult = {
      scheme: pre.scheme, status: 'checked', computed, selfOk: computed === leaf,
    };
    const declared = String(st.document?.sha256 ?? '').toLowerCase();
    if (input.originalBytes) {
      res.documentOk = bytesToHex(sha256(input.originalBytes)) === declared;
    }
    res.documentDigest = declared;
    return res;
  }

  if (pre.scheme === 'sha256-jcs-fields') {
    const fields = pre.fields ?? {};
    const domain = utf8(pre.domain ?? '');
    const computed = bytesToHex(sha256(concat(domain, jcs(fields as unknown as JcsValue))));
    const res: PreimageResult = {
      scheme: pre.scheme, status: 'checked', computed, selfOk: computed === leaf,
    };
    // The salt is held privately by the customer and is never in the public
    // bundle, so this step only runs when they supply it.
    const salt = input.saltHex ?? pre.commitment?.salt_hex;
    if (input.accountId !== undefined && salt !== undefined && pre.commitment) {
      const uc = deriveUserCommitment(salt, input.accountId);
      res.identityOk = uc === String(fields['user_commitment'] ?? '').toLowerCase();
    }
    return res;
  }

  throw new Error(`unknown preimage scheme: ${JSON.stringify((pre as { scheme: string }).scheme)}`);
}
