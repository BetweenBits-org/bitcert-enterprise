/**
 * The evaluation sandbox: build evidence, break it on purpose, read the result
 * apart, and take a package away that still verifies somewhere else.
 *
 * ## Why these routes exist when `/v1/settlements/*` already does
 *
 * They do not evaluate anything. Reconciliation stays on the integration
 * endpoint a customer would actually call, so the verdict on screen is
 * produced by the same code path as the verdict in their system — if the
 * sandbox had its own evaluator, agreement between the two would be a hope
 * rather than a fact.
 *
 * What these add is the material to feed it: the starting documents, the
 * catalogue of ways to damage them, and the package format that makes a
 * verdict portable. Everything here is a pure transform of constants. Nothing
 * is stored, and no case data reaches the disk.
 *
 * ## On the package
 *
 * A verdict is worth little if the only place it can be checked is the screen
 * that produced it. The package carries the evidence, the exact policy, the
 * verdict, and the public keys the signatures were checked against — enough
 * for the recipient to redo the work rather than believe the sender. Sigstore
 * bundles take the same line: ship the verification material with the thing
 * being verified. `digest` covers the first four fields canonically, so an
 * edit to any of them is detectable without a second file to keep alongside.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './server.ts';
import type { Ctx } from './server.ts';
import {
  DEMO_ISSUER_KEYS, SAMPLE_POLICY, SAMPLE_SETTLEMENT, SCENARIOS,
  breakDigest, breakSignature, buildScenario, changeAmount, duplicateReceipt,
  evaluate, removeDocument, validatePolicy, verifyEvidenceSignatures, DEMO_KEYRING,
} from '@stonehash/attest-rules';
import type { MatchingResult, Policy, ScenarioId, SettlementEvidence } from '@stonehash/attest-rules';

/** RFC 8785-shaped canonical JSON: sorted keys, no insignificant whitespace. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The damage a reviewer can do from the UI.
 *
 * Each entry names the question it answers, because "break the signature" is
 * a button and "would we notice if the provider's seal were forged" is the
 * reason to press it. `needs` drives the form: an amount change needs a
 * number, removing a document needs to know which one.
 */
export const TAMPERS = [
  {
    id: 'amount',
    label: 'Change an amount',
    asks: 'If someone edits a figure after approval, is it caught, and does the result say which figure?',
    needs: { target: ['chainTransfer', 'bankInstruction', 'commercialDocs', 'payoutReceipt'], amount: 'decimal' },
  },
  {
    id: 'signature',
    label: 'Corrupt a signature',
    asks: 'If an issuer seal is forged, does integrity still pass — and is the failure attributed to the issuer rather than the document?',
    needs: { target: ['chainTransfer', 'payoutReceipt', 'bankInstruction', 'commercialDocs'] },
  },
  {
    id: 'document',
    label: 'Remove a required document',
    asks: 'Is a missing document reported as missing rather than as invalid? The two call for different work.',
    needs: { document: ['invoice', 'billOfLading', 'packingList'] },
  },
  {
    id: 'digest',
    label: 'Replace the document behind a digest',
    asks: 'If the file is swapped but the paperwork is left alone, which link breaks?',
    needs: { target: ['payoutReceipt', 'commercialDocs'] },
  },
  {
    id: 'duplicate',
    label: 'Submit the same payout twice',
    asks: 'Everything verifies and the payment must still be stopped. Does the result distinguish a genuine document from an approved transaction?',
    needs: {},
  },
] as const;

type TamperId = (typeof TAMPERS)[number]['id'];

interface TamperStep {
  id: TamperId;
  target?: string;
  amount?: string;
  document?: string;
}

function applyTamper(ev: SettlementEvidence, step: TamperStep): SettlementEvidence {
  switch (step.id) {
    case 'amount':
      if (!step.amount) throw new HttpError(400, 'missing_amount', 'an amount change needs "amount"');
      return changeAmount(ev, (step.target ?? 'chainTransfer') as never, step.amount);
    case 'signature':
      return breakSignature(ev, (step.target ?? 'payoutReceipt') as never);
    case 'document':
      return removeDocument(ev, step.document ?? 'invoice');
    case 'digest':
      return breakDigest(ev, (step.target ?? 'payoutReceipt') as never);
    case 'duplicate':
      return duplicateReceipt(ev);
    default:
      throw new HttpError(400, 'unknown_tamper', `no such tamper: ${String((step as TamperStep).id)}`);
  }
}

function asSteps(v: unknown): TamperStep[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'invalid_tampers', '"tampers" must be an array');
  return v.map((raw) => {
    const o = raw as Record<string, unknown>;
    const id = o?.['id'];
    if (typeof id !== 'string' || !TAMPERS.some((t) => t.id === id)) {
      throw new HttpError(400, 'unknown_tamper', `no such tamper: ${String(id)}`);
    }
    return {
      id: id as TamperId,
      target: typeof o['target'] === 'string' ? o['target'] : undefined,
      amount: typeof o['amount'] === 'string' ? o['amount'] : undefined,
      document: typeof o['document'] === 'string' ? o['document'] : undefined,
    };
  });
}

export interface EvidencePackage {
  schema: 'attest-evidence-package/0.1';
  bundleId: string;
  generatedAt: string;
  evidence: SettlementEvidence;
  policy: Policy;
  verdict: MatchingResult;
  /** What a recipient needs to redo the signature checks themselves. */
  verificationMaterial: {
    issuerKeys: { id: string; issuer: string; trustLevel: string; publicKeyJwk: unknown }[];
    policyDigest: string;
  };
  /** SHA-256 over the canonical form of everything above. */
  digest: string;
}

function publicKeyMaterial(): EvidencePackage['verificationMaterial']['issuerKeys'] {
  return DEMO_ISSUER_KEYS.map((k) => ({
    id: k.keyId,
    issuer: k.issuer,
    trustLevel: k.trustLevel,
    // Public half only — the package exists to be forwarded. The trust level
    // travels with it so a recipient cannot mistake a demonstration key for
    // an attested one.
    publicKeyJwk: k.publicKeyJwk as unknown,
  }));
}

/** The digest covers everything except itself. */
function sealPackage(pkg: Omit<EvidencePackage, 'digest'>): EvidencePackage {
  return { ...pkg, digest: sha256(canonical(pkg)) };
}

function readPolicy(body: Record<string, unknown>): Policy {
  const supplied = body['policy'];
  if (supplied === undefined) return SAMPLE_POLICY;
  if (typeof supplied !== 'object' || supplied === null) {
    throw new HttpError(400, 'invalid_policy', '"policy" must be an object');
  }
  try {
    validatePolicy(supplied as Policy);
  } catch (e) {
    throw new HttpError(400, 'invalid_policy', e instanceof Error ? e.message : String(e));
  }
  return supplied as Policy;
}

export interface SandboxRoutes {
  catalogue: (ctx: Ctx) => unknown;
  evidence: (ctx: Ctx) => Promise<unknown>;
  pack: (ctx: Ctx) => Promise<unknown>;
  verifyPackage: (ctx: Ctx) => Promise<unknown>;
}

export function sandboxRoutes(guard: (ctx: Ctx) => void | Promise<void>): SandboxRoutes {
  return {
    /** Everything the UI needs to draw itself. No evidence, no verdicts. */
    catalogue: async (ctx) => {
      await guard(ctx);
      return {
        scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, teaches: s.teaches })),
        tampers: TAMPERS,
        policy: SAMPLE_POLICY,
        policyDigest: sha256(canonical(SAMPLE_POLICY)),
        // Said once, here, so every screen can repeat it from one source.
        dataMode: SAMPLE_SETTLEMENT.dataMode,
        notRealPayment: SAMPLE_SETTLEMENT.notRealPayment === true,
        reconcileEndpoint: '/v1/settlements/reconcile',
        bundleEndpoint: '/v1/settlements/bundle',
      };
    },

    /**
     * Build the evidence for a scenario, then apply tampers in order.
     *
     * Signature verification deliberately runs last. A scenario that corrupts
     * a signature, or a transform that rewrites signed content, changes what
     * there is to verify — checking first would describe evidence that no
     * longer exists. This is the same ordering the test suite uses.
     */
    evidence: async (ctx) => {
      await guard(ctx);
      const body = (await ctx.body()) as Record<string, unknown>;
      const steps = asSteps(body['tampers']);

      /*
       * The starting document is the caller's if they supplied one.
       *
       * This is the difference between a demonstration and the product. A
       * paying customer runs these same endpoints over their own settlements;
       * the sandbox differs in which database is open, which chain is anchored
       * to and which key prefix authenticates — not in what the features do.
       * So the tamper catalogue has to work on uploaded evidence too, or the
       * evaluation would only ever prove something about our fixture.
       */
      const supplied = body['evidence'];
      let ev: SettlementEvidence;
      let id: ScenarioId | null = null;
      if (supplied !== undefined) {
        if (typeof supplied !== 'object' || supplied === null) {
          throw new HttpError(400, 'invalid_evidence', '"evidence" must be an object');
        }
        ev = supplied as SettlementEvidence;
      } else {
        id = (body['scenario'] ?? 'A') as ScenarioId;
        if (!SCENARIOS.some((s) => s.id === id)) {
          throw new HttpError(400, 'unknown_scenario', `no such scenario: ${String(id)}`);
        }
        ev = buildScenario(id, SAMPLE_SETTLEMENT);
      }

      for (const step of steps) ev = applyTamper(ev, step);
      return {
        scenario: id,
        source: id ? 'sample' : 'supplied',
        applied: steps.map((s) => s.id),
        evidence: await verifyEvidenceSignatures(ev, DEMO_KEYRING),
      };
    },

    /** Seal a verdict into something that can be handed on. */
    pack: async (ctx) => {
      await guard(ctx);
      const body = (await ctx.body()) as Record<string, unknown>;
      const raw = body['evidence'];
      if (typeof raw !== 'object' || raw === null) {
        throw new HttpError(400, 'missing_evidence', 'provide "evidence"');
      }
      const policy = readPolicy(body);
      const checked = await verifyEvidenceSignatures(raw as SettlementEvidence, DEMO_KEYRING);
      const verdict = evaluate(checked, policy);
      return sealPackage({
        schema: 'attest-evidence-package/0.1',
        bundleId: typeof body['bundleId'] === 'string'
          ? body['bundleId']
          : `EV-${sha256(canonical(checked)).slice(0, 8).toUpperCase()}`,
        generatedAt: new Date().toISOString(),
        evidence: checked,
        policy,
        verdict,
        verificationMaterial: { issuerKeys: publicKeyMaterial(), policyDigest: verdict.policyDigest },
      });
    },

    /**
     * Re-check a package that came back.
     *
     * Two separate questions, reported separately because they fail for
     * different reasons. `digestOk` asks whether the file is the one that was
     * issued. `reproduced` asks whether re-running the stated policy over the
     * enclosed evidence still gives the enclosed verdict — which can differ
     * honestly, if the rules moved since.
     */
    verifyPackage: async (ctx) => {
      await guard(ctx);
      const body = (await ctx.body()) as Record<string, unknown>;
      const pkg = (body['package'] ?? body) as Partial<EvidencePackage>;
      if (!pkg || typeof pkg !== 'object' || typeof pkg.digest !== 'string'
        || !pkg.evidence || !pkg.policy || !pkg.verdict) {
        throw new HttpError(400, 'not_a_package',
          'that file is not an evidence package: expected "evidence", "policy", "verdict" and "digest"');
      }
      const { digest, ...rest } = pkg as EvidencePackage;
      const recomputed = sha256(canonical(rest));

      const checked = await verifyEvidenceSignatures(pkg.evidence, DEMO_KEYRING);
      const fresh = evaluate(checked, pkg.policy);

      const axisNames = Object.keys(fresh.axes) as (keyof typeof fresh.axes)[];
      const differences = axisNames
        .filter((a) => fresh.axes[a].state !== pkg.verdict?.axes?.[a]?.state)
        .map((a) => ({ axis: a, recorded: pkg.verdict!.axes[a]?.state, now: fresh.axes[a].state }));

      return {
        digestOk: recomputed === digest,
        recordedDigest: digest,
        recomputedDigest: recomputed,
        policyUnchanged: fresh.policyDigest === pkg.verdict.policyDigest,
        reproduced: differences.length === 0,
        differences,
        verdict: fresh,
      };
    },
  };
}
