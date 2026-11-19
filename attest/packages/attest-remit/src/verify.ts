/**
 * Independent re-verification of a settlement evidence package — the
 * "trust no single platform" half of the SDK, built only on the two public
 * checker packages.
 *
 * Four checks, reported separately because they fail for different reasons:
 *   1. commitment   — SHA256(domain ‖ nonce ‖ JCS(package)) equals the value
 *                     the platform anchored
 *   2. signatures   — every evidence element re-verified against the Trust
 *                     Registry snapshot carried *inside* the package
 *   3. verdict      — the six-axis engine re-run locally; every axis must
 *                     read as the platform's verdict reads it, in whatever
 *                     order the package lists its axes
 *   4. anchor       — the Bitcoin proof bundle re-checked, and its leaf must
 *                     be the commitment from (1)
 */
import { createPublicKey } from 'node:crypto';
import {
  SIGNABLE_ELEMENTS, evaluate, keyring, verifyEvidenceSignatures,
} from '@stonehash/attest-rules';
import type { Policy, SettlementEvidence } from '@stonehash/attest-rules';
import { jcsString, verifyBundle } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import { sha256hex } from './signing.ts';

export const EVIDENCE_COMMIT_DOMAIN = 'STONEHASH-EVIDENCE-V1';

export interface EvidenceCheck { name: string; ok: boolean; detail: string }
export interface EvidenceReport { verified: boolean; checks: EvidenceCheck[] }

/** What `GET /v1/settlements/{id}/evidence` returns: the package, its commitment, and the anchor. */
export interface EvidenceResponse {
  package: {
    evidence: SettlementEvidence;
    policy: Policy;
    verdict: { axes: Record<string, { state: string }> };
    trust_registry: { institutions: { id: string; name: string; signing_spki?: string | null }[] };
    [k: string]: unknown;
  };
  commitment: { value: string; nonce: string };
  attestation?: { id: string; bundle?: Record<string, unknown> | null } | null;
}

export async function verifyEvidencePackage(res: EvidenceResponse): Promise<EvidenceReport> {
  const checks: EvidenceCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

  // 1 — commitment
  const canonical = Buffer.from(jcsString(res.package as unknown as JcsValue), 'utf8');
  const commit = sha256hex(Buffer.concat([
    Buffer.from(EVIDENCE_COMMIT_DOMAIN, 'utf8'),
    Buffer.from(res.commitment.nonce, 'hex'),
    canonical,
  ]));
  add('commitment', commit === res.commitment.value, `recomputed ${commit.slice(0, 16)}…`);

  // 2 — element signatures against the embedded registry
  //
  // A package is evidence from someone else, and may be anything: a check
  // that cannot be carried out on it is a check that failed, reported like
  // the others — never an exception in place of a report.
  let checked: SettlementEvidence | null = null;
  try {
    const ring = keyring(res.package.trust_registry.institutions
      .filter((i) => i.signing_spki)
      .map((i) => ({
        keyId: i.id,
        issuer: i.name,
        trustLevel: 'ATTESTED' as const,
        publicKeyJwk: createPublicKey({ key: Buffer.from(i.signing_spki!, 'base64'), format: 'der', type: 'spki' })
          .export({ format: 'jwk' }) as JsonWebKey,
      })));
    checked = await verifyEvidenceSignatures(res.package.evidence, ring);
    // Only a status this verifier computed counts. An element under a name it
    // does not check keeps the status it arrived with — "VALID", written by
    // whoever built the package — so it is reported as not verified. And a
    // package with no element at all has shown nothing: it does not pass by
    // having nothing to fail.
    const checkedNames = new Set(SIGNABLE_ELEMENTS);
    const sigStates = Object.entries(checked.elements).flatMap(([k, v]) => {
      const items = Array.isArray(v) ? v : [v];
      return items.map((item) => `${k}:${checkedNames.has(k)
        ? ((item as { signature?: { status?: string } } | null)?.signature?.status ?? 'ABSENT')
        : 'NOT_VERIFIED'}`);
    });
    add('signatures', sigStates.length > 0 && sigStates.every((x) => x.endsWith(':VALID')),
      sigStates.length > 0 ? sigStates.join(' ') : 'the package carries no evidence element');
  } catch (e) {
    checked = null;
    add('signatures', false, `could not be checked — ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3 — six-axis re-evaluation, over the evidence as this verifier found its signatures
  if (checked === null) {
    add('verdict', false, 'not re-evaluated: the element signatures could not be checked');
  } else {
    try {
      const verdict = evaluate(checked, res.package.policy);
      const mine: [string, string][] = Object.entries(verdict.axes).map(([k, v]) => [k, v.state]);
      // What the package states: every axis it names, and the state of each that gives one, whatever that state
      // is. (An axis that is null cannot be read at all, and stops the check here as it always has.)
      const named: string[] = [];
      const theirs = new Map<string, unknown>();
      for (const [k, v] of Object.entries(res.package.verdict.axes as Record<string, { state?: unknown }>)) {
        named.push(k);
        if (v.state !== undefined) theirs.set(k, v.state);
      }
      const agree = verdictsAgree(mine, named, theirs);
      add('verdict', agree,
        agree ? mine.map(([k, v]) => `${k}=${v}`).join(' ')
          : `local ${axesText(mine)} ≠ platform ${axesText(inOneOrder(mine, theirs))}${alsoNamed(mine, named, theirs)}`);
    } catch (e) {
      add('verdict', false, `could not be re-evaluated — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4 — the Bitcoin anchor
  const bundle = res.attestation?.bundle;
  if (bundle) {
    const leafOk = (bundle as { record?: { leaf_bytes?: string } }).record?.leaf_bytes === res.commitment.value;
    let bundleVerified = false;
    let detail = 'leaf mismatch';
    try {
      const r = await verifyBundle(bundle as never, {});
      bundleVerified = r.verified === true;
      detail = `leaf==commitment:${leafOk} ${(r.checks ?? []).map((c) => `${c.id}:${c.state}`).join(' ')}`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    add('anchor', leafOk && bundleVerified, detail);
  } else {
    add('anchor', false, 'no bundle present — anchor still pending');
  }

  return { verified: checks.every((c) => c.ok), checks };
}

/**
 * Whether the verdict a package states is the one this verifier computed:
 * it names the same axes, and gives each the same state.
 *
 * The order the package lists its axes in carries no meaning and is not
 * compared. The commitment is made over a canonical form that sorts members,
 * so a file whose members were re-ordered — by a tool that re-serialises it,
 * by a JSON column that stores it — is the same package, and has to read as
 * the same package here. An axis only one side has is a difference — also
 * one the package names without giving it a state — and so is a state that
 * is not the same text.
 *
 * @param named every axis the package names
 * @param theirs the state of each axis that gives one
 */
function verdictsAgree(mine: [string, string][], named: string[], theirs: Map<string, unknown>): boolean {
  return named.length === mine.length && mine.every(([axis, state]) => theirs.has(axis) && theirs.get(axis) === state);
}

/**
 * The stated axes in the one order a difference is reported in: this
 * verifier's own axes first, in the engine's order, then any other the
 * package gives a state for, by name (compared by UTF-16 code unit, as
 * `sort()` compares text). The same file reads the same whatever order it was
 * written in, and the same in every SDK. An axis the package names without a
 * state is not listed: there is no state to show for it.
 */
function inOneOrder(mine: [string, string][], theirs: Map<string, unknown>): [string, unknown][] {
  const known = mine.map(([axis]) => axis);
  const others = [...theirs.keys()].filter((axis) => !known.includes(axis)).sort();
  return [...known.filter((axis) => theirs.has(axis)), ...others].map((axis) => [axis, theirs.get(axis)]);
}

/**
 * What the two maps of a difference do not show: an axis the package names
 * beyond this verifier's own, without giving it a state. Said in words, by
 * name and in name order — or nothing, when there is none.
 */
function alsoNamed(mine: [string, string][], named: string[], theirs: Map<string, unknown>): string {
  const known = mine.map(([axis]) => axis);
  const silent = named.filter((axis) => !known.includes(axis) && !theirs.has(axis)).sort();
  return silent.length === 0 ? '' : ` — the package also names ${silent.map((axis) => JSON.stringify(axis)).join(', ')}, without a state`;
}

/** Axes and their states as JSON text, in the order given — never the order an object would list its members in. */
function axesText(axes: [string, unknown][]): string {
  return `{${axes.map(([axis, state]) => `${JSON.stringify(axis)}:${JSON.stringify(state)}`).join(',')}}`;
}
