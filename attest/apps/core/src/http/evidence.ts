/**
 * Settlement-evidence endpoints.
 *
 * Reconciliation and archive assembly both run through the shared packages, so
 * what the service returns is what the Playground computes from the same inputs.
 * That is the point of sharing the rules engine: a reviewer who re-runs the
 * policy in a browser must get the server's answer, or the demonstration would
 * misrepresent the product.
 *
 * The archive is assembled per request and never stored. There is nothing to
 * leak later, and nothing to serve stale — and because the assembler is
 * deterministic, two requests for the same evidence return byte-identical
 * archives, so a digest a reviewer cites stays valid.
 */
import { randomUUID } from 'node:crypto';
import { DEMO_KEYRING, evaluate, validatePolicy, verifyEvidenceSignatures } from '@stonehash/attest-rules';
import type { Policy, SettlementEvidence } from '@stonehash/attest-rules';
import { assembleEvidenceBundle } from '@stonehash/attest-evidence';
import { HttpError, HttpResult } from './server.ts';
import type { Ctx } from './server.ts';

/** Shape accepted by both endpoints. */
interface EvidenceRequest {
  evidence?: SettlementEvidence;
  policy?: Policy;
  /** Caller-supplied so a re-export reproduces the same archive. */
  bundleId?: string;
  /** ISO instant. Caller-supplied for the same reason. */
  generatedAt?: string;
}

/**
 * Verify issuer signatures before any rule runs.
 *
 * `Signature.status` arrives as a claim, and the engine refuses to credit one
 * it did not compute — so without this pass every request would come back with
 * the issuer axis reporting `SIGNATURE_NOT_CHECKED`, which is correct but
 * useless. Running it here means the endpoint's answer is about cryptography
 * rather than about what the caller wrote in the field.
 *
 * The keyring is the demo issuers': this deployment reconciles synthetic
 * evidence, and a signature from one of those keys resolves to `DEMO_VALID`
 * with the issuer axis still reporting `UNKNOWN_ISSUER`. Production keys would
 * be configuration, not a code change.
 */
async function verifySignatures(evidence: SettlementEvidence): Promise<SettlementEvidence> {
  return verifyEvidenceSignatures(evidence, DEMO_KEYRING);
}

function parse(body: unknown): { evidence: SettlementEvidence; policy: Policy; req: EvidenceRequest } {
  const req = (body ?? {}) as EvidenceRequest;
  if (!req.evidence || typeof req.evidence !== 'object') {
    throw new HttpError(400, 'missing_evidence',
      'provide "evidence": the settlement evidence document to reconcile');
  }
  if (!req.policy || typeof req.policy !== 'object') {
    throw new HttpError(400, 'missing_policy',
      'provide "policy": the rule set to evaluate against. A verdict without a stated policy '
      + 'would not be reproducible, so there is no default.');
  }
  try {
    validatePolicy(req.policy);
  } catch (e) {
    throw new HttpError(400, 'invalid_policy', e instanceof Error ? e.message : String(e));
  }
  return { evidence: req.evidence, policy: req.policy, req };
}

/** `POST /v1/settlements/reconcile` — the verdict, as data. */
export async function reconcile(ctx: Ctx): Promise<unknown> {
  const { evidence, policy } = parse(await ctx.body());
  try {
    return evaluate(await verifySignatures(evidence), policy);
  } catch (e) {
    // A malformed amount is the caller's data problem, not a server fault.
    throw new HttpError(400, 'invalid_evidence', e instanceof Error ? e.message : String(e));
  }
}

/**
 * `POST /v1/settlements/bundle` — the evidence archive.
 *
 * Returns the ZIP itself rather than a link: there is no stored object to link
 * to, and a download URL would imply a retention the service does not have.
 */
export async function bundle(ctx: Ctx): Promise<HttpResult> {
  const { evidence, policy, req } = parse(await ctx.body());

  // Both are caller-supplied where given, because the assembler is pure and its
  // determinism is the reason an archive digest can be cited at all.
  const bundleId = typeof req.bundleId === 'string' && req.bundleId.length > 0
    ? req.bundleId
    : `EV-${randomUUID().slice(0, 8).toUpperCase()}`;
  const generatedAt = req.generatedAt ? new Date(req.generatedAt) : new Date();
  if (Number.isNaN(generatedAt.getTime())) {
    throw new HttpError(400, 'invalid_timestamp', `"generatedAt" is not a valid instant: ${req.generatedAt}`);
  }

  let verdict;
  let checked;
  try {
    checked = await verifySignatures(evidence);
    verdict = evaluate(checked, policy);
  } catch (e) {
    throw new HttpError(400, 'invalid_evidence', e instanceof Error ? e.message : String(e));
  }

  // The archive carries the *verified* evidence, not what arrived. Otherwise a
  // reviewer re-opening the bundle would see the declared signature statuses
  // again and have to take the verdict's word for what was checked.
  const assembled = await assembleEvidenceBundle({
    evidence: checked, policy, verdict, bundleId, generatedAt,
  });

  return new HttpResult(200, assembled.zip, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${assembled.filename}"`,
    // So a caller can cite the archive without hashing it themselves, and can
    // confirm the transfer was not truncated.
    'x-evidence-sha256': assembled.sha256,
    'x-evidence-bundle-id': bundleId,
  });
}
