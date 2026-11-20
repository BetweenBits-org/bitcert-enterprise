import { buildStatement, statementLeaf, verifyStatement } from './vendor/attest-verify/index.ts';
import type { SignedStatement, StatementCore } from './vendor/attest-verify/index.ts';
import type { IssuerKey } from './api.ts';

/** The same unsigned statement consumed by the offline SDK's --statement option. */
export function documentSigningRequest(digest: string, key: IssuerKey, contentType = '', issuedAt = new Date().toISOString()): StatementCore {
  if (key.algorithm !== 'ES256' && key.algorithm !== 'RS256') throw new Error('Unsupported signing algorithm');
  return buildStatement({ documentSha256: digest, keyId: key.id, algorithm: key.algorithm,
    publicKeySpkiBase64: key.public_key, issuedAt, ...(contentType ? { contentType } : {}) });
}

/** Key ids are labels; compare the actual public material and algorithm. */
export async function checkDocumentSignature(raw: string, digest: string, key: IssuerKey | null) {
  const statement = JSON.parse(raw) as SignedStatement;
  const leaf = statementLeaf(statement);
  const verdict = await verifyStatement(statement, leaf);
  const matchesDocument = digest !== '' && statement.document.sha256 === digest;
  const matchesKey = !!key && statement.issuer.public_key === key.public_key
    && statement.issuer.algorithm === key.algorithm;
  return { statement, leaf, signatureOk: verdict.signatureOk, matchesDocument, matchesKey,
    error: verdict.error, valid: verdict.signatureOk && matchesDocument && matchesKey };
}
