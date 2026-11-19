/**
 * Policy loading, validation and digesting.
 *
 * The digest is what makes a verdict reproducible. `policyVersion` is a label a
 * human chose and could reuse after editing a tolerance; the digest is derived
 * from the canonicalised bytes, so an edited policy is a different policy
 * whether or not anyone remembered to bump the version. A reviewer comparing
 * two results can tell in one comparison whether the same rules ran.
 */
import { sha256, bytesToHex, utf8 } from '../attest-verify/index.ts';
import { parseDecimal } from './decimal.ts';
import type { Policy, TrustLevel } from './types.ts';

const TRUST_ORDER: Record<TrustLevel, number> = { DEMO: 0, ATTESTED: 1, ACCREDITED: 2 };

/** `true` when `have` is at least as trusted as `need`. */
export function trustAtLeast(have: TrustLevel | undefined, need: TrustLevel): boolean {
  if (!have) return false;
  return TRUST_ORDER[have] >= TRUST_ORDER[need];
}

/**
 * Canonical JSON for a policy: keys sorted recursively, no insignificant
 * whitespace. Two policies that differ only in key order are the same policy and
 * must digest identically.
 */
export function canonicalPolicy(p: Policy): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = norm((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(p));
}

export function policyDigest(p: Policy): string {
  return bytesToHex(sha256(utf8(canonicalPolicy(p))));
}

/**
 * Validate a policy, throwing on anything the engine cannot evaluate
 * deterministically.
 *
 * Validation is strict because a silently-defaulted field would change verdicts
 * without changing the digest, which is precisely the drift the digest exists to
 * prevent.
 */
export function validatePolicy(p: Policy): void {
  const need = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`policy: ${msg}`);
  };
  need(typeof p.policyVersion === 'string' && p.policyVersion.length > 0, 'policyVersion is required');
  need(Array.isArray(p.currencies) && p.currencies.length > 0, 'currencies must be a non-empty array');
  need(Array.isArray(p.unitOfAccountGroups)
    && p.unitOfAccountGroups.every((g) => Array.isArray(g) && g.length > 0),
    'unitOfAccountGroups must be an array of non-empty arrays');
  // A code in two groups would make 1:1 equivalence ambiguous — A≡B and B≡C
  // would silently imply A≡C, which the policy author may not have intended.
  const seen = new Set<string>();
  for (const g of p.unitOfAccountGroups) {
    for (const c of g) {
      need(!seen.has(c), `currency ${c} appears in more than one unitOfAccountGroup`);
      seen.add(c);
      need(p.currencies.includes(c), `unitOfAccountGroups names ${c}, which is not in currencies`);
    }
  }
  parseDecimal(p.amountTolerance, 'policy.amountTolerance');
  need(Number.isInteger(p.amountToleranceBps) && p.amountToleranceBps >= 0,
    'amountToleranceBps must be a non-negative integer');
  need(p.fxReference === null || typeof p.fxReference === 'string',
    'fxReference must be a string or null');
  need(/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(p.settlementWindow),
    `settlementWindow must be an ISO 8601 duration of days/hours/minutes/seconds, got ${p.settlementWindow}`);
  need(typeof p.fees?.deductible === 'boolean', 'fees.deductible must be a boolean');
  need(Number.isInteger(p.fees?.maxBps) && p.fees.maxBps >= 0, 'fees.maxBps must be a non-negative integer');
  need(typeof p.splitPayments?.allowed === 'boolean', 'splitPayments.allowed must be a boolean');
  need(typeof p.splitPayments?.aggregate === 'boolean', 'splitPayments.aggregate must be a boolean');
  need(p.partyIDMatch === 'exact' || p.partyIDMatch === 'normalized',
    'partyIDMatch must be "exact" or "normalized"');
  need(p.sourceTrustLevel in TRUST_ORDER, `sourceTrustLevel must be one of ${Object.keys(TRUST_ORDER).join(', ')}`);
  need(Array.isArray(p.requiredElements), 'requiredElements must be an array');
  need(Array.isArray(p.signatureRequiredElements), 'signatureRequiredElements must be an array');
  // Corridor controls. Required rather than defaulted: a policy silently
  // missing `requireTravelRulePreflight` would evaluate as if the control were
  // off, which is the one failure mode a supervisor would never forgive.
  need(typeof p.requireTravelRulePreflight === 'boolean',
    'requireTravelRulePreflight must be a boolean — a missing value would evaluate as "control off"');
  need(typeof p.enforceFxQuoteWindow === 'boolean', 'enforceFxQuoteWindow must be a boolean');
  need(Array.isArray(p.settlementIdRequiredIn), 'settlementIdRequiredIn must be an array');
  for (const k of p.signatureRequiredElements) {
    need(p.requiredElements.includes(k),
      `signatureRequiredElements names ${k}, which is not in requiredElements — an element that `
      + 'need not be supplied cannot be required to be signed');
  }
  need(Array.isArray(p.regulatoryFields), 'regulatoryFields must be an array');
}

/**
 * ISO 8601 duration → milliseconds. Days/hours/minutes/seconds only.
 *
 * Months and years are deliberately unsupported: their length depends on a
 * calendar position, so `P1M` could not be evaluated without a reference date
 * and a timezone, and the engine takes neither.
 */
export function durationToMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) throw new Error(`unsupported duration: ${iso}`);
  const [, d, h, min, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
}

/**
 * `true` when two currency codes are one unit of account under this policy, so
 * their amounts compare without conversion. Identical codes always are.
 */
export function sameUnitOfAccount(a: string, b: string, p: Policy): boolean {
  if (a === b) return true;
  return p.unitOfAccountGroups.some((g) => g.includes(a) && g.includes(b));
}

/** Party name comparison under the policy's chosen strictness. */
export function partyEquals(a: string | undefined, b: string | undefined, mode: 'exact' | 'normalized'): boolean {
  if (a === undefined || b === undefined) return false;
  if (mode === 'exact') return a === b;
  // `normalized` folds case, collapses whitespace and drops punctuation and
  // common corporate suffixes, so "ACME Corp." and "Acme Corporation" agree.
  const norm = (s: string): string =>
    s.toLowerCase()
      .replace(/[.,'"()]/g, ' ')
      .replace(/\b(co|corp|corporation|inc|incorporated|ltd|limited|llc|plc|gmbh|pte|pty|sa|nv|bv|ag)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}
