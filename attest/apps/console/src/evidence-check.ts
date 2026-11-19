/**
 * 정산 증빙 검증 — the settlement SDK's four checks, in the visitor's own page.
 *
 * `GET /v1/settlements/{id}/evidence` hands out a package, the commitment
 * made over it and the proof bundle that anchors that commitment. The bank
 * SDK re-checks all three on a server (`verifyEvidencePackage`). This module
 * gives the same answers for the same file with no server and no request, so
 * the 검증 screen can check an evidence file where the visitor is:
 *
 *   1. commitment — SHA-256(domain ‖ nonce ‖ JCS(package)) is the stated value
 *   2. signatures — every evidence element, against the registry snapshot
 *                   carried inside the package
 *   3. verdict    — the six-axis engine re-run over the evidence as its
 *                   signatures were found here; the axes must be the package's
 *   4. anchor     — the proof bundle holds, and its leaf is that commitment
 *
 * ## Why it is not the SDK's own function
 *
 * The SDK builds its keyring with `node:crypto` and verifies through
 * `crypto.subtle`. A page has the first nowhere, and this console is reached
 * over plain http at an IP address, where the browser withholds the second.
 * `attest-rules`' `verifySignature` does not fail loudly there: it catches
 * the error and answers INVALID, for every signature. So it is never called.
 * The bytes an issuer signs and the engine are `attest-rules`' own files,
 * vendored; only the arithmetic is swapped, for the verifier's P-256 in
 * plain JavaScript.
 *
 * ## The same answers, with the differences named
 *
 * What the SDK reports for a file, this reports: `verified`, each of the
 * four, and each element's status in the SDK's order.
 * `test/evidence-check.test.ts` holds the two against each other. Where the
 * SDK throws, this returns its report with the check failed and the reason
 * in `problem`. They differ in the places listed below and nowhere else: in
 * all but one this module is the stricter.
 *
 * The one where it passes what the SDK fails is a sound file the SDK is
 * wrong about: it compares the two verdicts as JSON text, so a package whose
 * axes are listed in another order — the same package to the commitment,
 * which is made over a form that sorts keys — fails its verdict check. Any
 * tool that re-serialises JSON does that to a stored file. Here the same
 * axes with the same states agree, whatever their order.
 *
 * Some input Node reads in a way a page cannot follow: `Buffer.from` drops
 * whatever it cannot decode and keeps the rest, and `Date.parse` fills in the
 * time zone of the machine it runs on. There this module is the stricter of
 * the two, never the other way round:
 *
 *   - the nonce must be whole hex bytes and nothing else;
 *   - a registry key must be standard base64 of a P-256 public key in its
 *     one DER form. A key of another kind, or one that cannot be read, fails
 *     the signatures check as a whole, and the verdict with it — a verdict
 *     is not re-evaluated over signatures nobody could check;
 *   - a time the engine does arithmetic on must be ISO 8601 with its zone
 *     stated. The SDK's verdict over any other is the verdict of the server
 *     it ran on; a browser somewhere else cannot give that answer, so the
 *     verdict check fails and says which time it was.
 *
 * ## What it leaves alone
 *
 * A value in, a report out: no DOM, no network, no storage. Signature
 * statuses are written into a copy of the evidence, so the caller's object
 * is as it was. The report carries states and values for the screen to say
 * in Korean or in English. `problem` is the one place with words in it: the
 * technical reason a check could not be made, for a detail line.
 */
import {
  bytesToHex, concat, hexToBytes, jcsString, pointFromSpki, sha256, utf8, verifyBundle, verifyP256,
} from './vendor/attest-verify/index.ts';
import type { JcsValue, ProofBundle, VerifyReport } from './vendor/attest-verify/index.ts';
import { evaluate } from './vendor/attest-rules/engine.ts';
import { SIGNABLE_ELEMENTS, fromBase64Url, signedBytes } from './vendor/attest-rules/signature.ts';
import type { Policy, SettlementEvidence, Signature } from './vendor/attest-rules/types.ts';

export interface EvidenceCheckReport {
  /** All four hold — the same meaning as the SDK's `verified`. */
  verified: boolean;
  /**
   * `computed` is what this page hashed, `stated` what the response says the
   * platform anchored. `computed` is `null` when the hash could not be made,
   * and `problem` then says why.
   */
  commitment: { ok: boolean; computed: string | null; stated: string | null; problem?: string };
  /**
   * One entry per element instance, in the order the SDK lists them. A
   * status is VALID, INVALID, UNKNOWN_KEY (signed under a key the package's
   * registry does not hold), ABSENT (no signature to check) or NOT_VERIFIED
   * (an element under a name this verifier does not check, whatever it says
   * of itself). Only VALID counts. With `problem` set the list is empty and
   * nothing was checked: the signatures could not be checked at all, or the
   * package carries no evidence element — which does not pass by having
   * nothing to fail.
   */
  signatures: { ok: boolean; elements: { element: string; status: string }[]; problem?: string };
  /**
   * Axis → state, as the engine found it here (`mine`) and as the package
   * states it (`theirs`). They agree only if they are the same axes, in the
   * same order, with the same states. `mine` is `null` when the engine did
   * not run or its answer would depend on the machine (see `problem`),
   * `theirs` when the package states no verdict that can be read.
   */
  verdict: { ok: boolean; mine: Record<string, string> | null; theirs: Record<string, string> | null; problem?: string };
  /**
   * `pending`: the response carries no bundle yet (the anchor is not
   * confirmed) — not ok, but not a contradiction either. Otherwise
   * `leafMatches` says whether the bundle's leaf is the stated commitment,
   * and `bundle` is the independent verifier's report on the bundle itself;
   * `null` there, with `problem`, when the bundle could not be read at all.
   */
  anchor: { ok: boolean; pending: boolean; leafMatches: boolean | null; bundle: VerifyReport | null; problem?: string };
  /** Read off the package for a heading; nothing here is checked. */
  subject: { paymentId: string | null; state: string | null; generatedAt: string | null };
}

/** Prefixed to what is hashed, so a commitment can be nothing but a commitment. */
const COMMIT_DOMAIN = 'STONEHASH-EVIDENCE-V1';

/**
 * Everything in front of the point in a P-256 public key (SPKI, DER).
 *
 * DER allows one encoding of a value, so every uncompressed P-256 key is
 * these 26 bytes followed by `04 ‖ X ‖ Y` — 91 in all.
 */
const P256_SPKI_HEAD = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
const P256_SPKI_LENGTH = 91;

/** The SDK's words for a package whose evidence lists nothing. */
const NO_ELEMENT = 'the package carries no evidence element';

/** Standard alphabet, padded: the one way base64 writes a given run of bytes. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;

/** A value this module reads fields from without knowing what it holds. */
type Loose = Record<string, unknown>;

/**
 * Read into a value the way the SDK's own property access does.
 *
 * Anything but `null` and `undefined` can be read from — a string or a number
 * simply has no such field — and those two cannot. There the SDK throws; here
 * the check that needed the value fails, saying what was missing.
 */
function within(value: unknown, what: string): Loose {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value as Loose;
}

/**
 * The response itself. Text, a number or nothing at all has no package and
 * no commitment to read — the SDK throws on each of them before it has
 * checked anything.
 */
function responseOf(value: unknown): Loose {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error('not an evidence response');
  }
  return value as Loose;
}

/** One element or a list of them, as a list. */
const listOf = (node: unknown): unknown[] => (Array.isArray(node) ? node : [node]);

/** Why a check could not be carried out, as text. Never throws itself. */
function reason(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return 'unreadable error';
  }
}

/**
 * Whether a value has the shape of the evidence response: an object holding
 * a `package` object and a `commitment` object. A proof bundle has neither,
 * which is how a screen offered any file tells the two apart.
 */
export function looksLikeEvidence(value: unknown): boolean {
  const object = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
  try {
    return object(value) && object(value.package) && object(value.commitment);
  } catch {
    return false;
  }
}

/**
 * The four checks. Never throws, whatever it is given: a check that cannot be
 * carried out is a failed check with a `problem`.
 */
export async function checkEvidence(value: unknown): Promise<EvidenceCheckReport> {
  const commitment = checkCommitment(value);
  const signatures = checkSignatures(value);
  const verdict = checkVerdict(value, signatures.evidence);
  const anchor = checkAnchor(value);
  return {
    verified: commitment.ok && signatures.check.ok && verdict.ok && anchor.ok,
    commitment,
    signatures: signatures.check,
    verdict,
    anchor,
    subject: subjectOf(value),
  };
}

// ── 1 · commitment ─────────────────────────────────────────────────────────

function checkCommitment(res: unknown): EvidenceCheckReport['commitment'] {
  let stated: string | null = null;
  try {
    const root = responseOf(res);
    const commitment = within(root.commitment, 'the commitment');
    if (typeof commitment.value === 'string') stated = commitment.value;
    if (root.package === undefined) throw new Error('the package is missing');
    const canonical = jcsString(root.package as JcsValue);
    // Node decodes a hex string up to the first thing that is not a hex byte
    // and hashes what it got. A nonce like that is refused here instead.
    const nonce = commitment.nonce;
    if (typeof nonce !== 'string' || !HEX_BYTES.test(nonce)) {
      throw new Error('the nonce is not a string of hex bytes');
    }
    const computed = bytesToHex(sha256(concat(utf8(COMMIT_DOMAIN), hexToBytes(nonce), utf8(canonical))));
    return { ok: computed === commitment.value, computed, stated };
  } catch (e) {
    return { ok: false, computed: null, stated, problem: reason(e) };
  }
}

// ── 2 · signatures ─────────────────────────────────────────────────────────

/** One institution's key from the package's registry snapshot. */
interface RegistryKey {
  /** The institution's name, as the registry has it. */
  issuer: string;
  /** Its P-256 public key, SPKI DER. */
  spki: Uint8Array;
}

/**
 * A registry key, read strictly: standard base64 of a P-256 public key in
 * its one DER form, the point on the curve. `null` for anything else.
 *
 * The SDK decodes the same field with `Buffer.from` and hands it to
 * `createPublicKey`. Between them they also read keys a page has no
 * arithmetic for (RSA, other curves) and other spellings of this one: base64
 * with stray characters in it, a compressed point, bytes after the key.
 * Reading exactly one form is what keeps this side from accepting a key Node
 * would refuse — the verifier's own `pointFromSpki` looks only at the last 65
 * bytes, so the bytes in front are compared here.
 */
function p256Spki(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !BASE64.test(value)) return null;
  const text = atob(value);
  const der = new Uint8Array(text.length);
  for (let i = 0; i < der.length; i++) der[i] = text.charCodeAt(i);
  if (der.length !== P256_SPKI_LENGTH || bytesToHex(der.subarray(0, P256_SPKI_HEAD.length / 2)) !== P256_SPKI_HEAD) {
    return null;
  }
  try {
    pointFromSpki(der);
  } catch {
    return null;
  }
  return der;
}

/**
 * The SDK's keyring: every institution in the snapshot that has a signing
 * key, under its id. Throws where the SDK's would — no registry, an entry
 * that is nothing, a key that cannot be read, the same id twice — and on a
 * key `p256Spki` does not read, which is where this is the stricter. The
 * caller reports a throw as signatures that could not be checked.
 */
function registryKeys(pkg: Loose): Map<unknown, RegistryKey> {
  const institutions = within(pkg.trust_registry, 'the trust registry').institutions;
  if (!Array.isArray(institutions)) throw new Error('the trust registry lists no institutions');
  const keys = new Map<unknown, RegistryKey>();
  for (const entry of institutions) {
    const institution = within(entry, 'an institution in the trust registry');
    if (!institution.signing_spki) continue;
    const spki = p256Spki(institution.signing_spki);
    if (spki === null) {
      throw new Error(`the signing key of ${String(institution.id)} is not a P-256 public key this page can read`);
    }
    if (keys.has(institution.id)) throw new Error(`duplicate keyId in keyring: ${String(institution.id)}`);
    // The name is carried as written; the SDK does not ask what it is either.
    keys.set(institution.id, { issuer: institution.name as string, spki });
  }
  return keys;
}

/**
 * One element's signature, with a status computed here.
 *
 * `attest-rules`' `verifySignature`, line for line, except the one call that
 * needs `crypto.subtle`: the object returned is what that function returns
 * for a key of trust level ATTESTED, field for field, because the engine
 * reads it. A signature or an element that cannot even be decoded is INVALID
 * there, and so here.
 */
function recomputed(element: Loose, keys: Map<unknown, RegistryKey>): Signature {
  const declared = element.signature as Signature | null | undefined;
  if (!declared || declared.status === 'ABSENT' || !declared.value) {
    return { status: 'ABSENT', checked: true, ...(declared?.keyId ? { keyId: declared.keyId } : {}) };
  }

  const key = declared.keyId ? keys.get(declared.keyId) : undefined;
  if (!key) {
    return { ...declared, status: 'UNKNOWN_KEY', checked: true, trustLevel: undefined };
  }

  let ok = false;
  try {
    ok = verifyP256(fromBase64Url(declared.value), signedBytes(element), key.spki);
  } catch {
    ok = false;
  }

  return {
    ...declared,
    issuer: key.issuer,
    trustLevel: 'ATTESTED',
    algorithm: 'ES256',
    checked: true,
    status: ok ? 'VALID' : 'INVALID',
  };
}

/**
 * Re-verify every element signature, and list what was found.
 *
 * Returns the copy of the evidence the statuses were written into — what the
 * engine is then run over — or `null` when the signatures could not be
 * checked at all.
 */
function checkSignatures(res: unknown): { check: EvidenceCheckReport['signatures']; evidence: SettlementEvidence | null } {
  try {
    const pkg = within(responseOf(res).package, 'the package');
    const keys = registryKeys(pkg);
    const evidence: unknown = structuredClone(pkg.evidence);
    const elements = within(within(evidence, 'the evidence').elements, 'the list of evidence elements');

    for (const name of SIGNABLE_ELEMENTS) {
      const node = elements[name];
      if (!node) continue;
      for (const item of listOf(node)) {
        if (item && typeof item === 'object' && 'signature' in item) {
          (item as { signature: Signature }).signature = recomputed(item as Loose, keys);
        }
      }
    }

    // Only a status computed above counts. An element under a name that is
    // not checked keeps the status it arrived with — "VALID", written by
    // whoever built the package — so it is listed as not verified.
    const checked = new Set(SIGNABLE_ELEMENTS);
    const found = Object.entries(elements).flatMap(([element, node]) =>
      listOf(node).map((item) => ({
        element,
        status: checked.has(element)
          ? String((item as { signature?: { status?: unknown } } | null)?.signature?.status ?? 'ABSENT')
          : 'NOT_VERIFIED',
      })));
    // A package with no element at all has shown nothing: it does not pass by
    // having nothing to fail. The engine is still run over it, as the SDK's is.
    const check: EvidenceCheckReport['signatures'] = found.length === 0
      ? { ok: false, elements: [], problem: NO_ELEMENT }
      : { ok: found.every((e) => e.status === 'VALID'), elements: found };
    return { check, evidence: evidence as SettlementEvidence };
  } catch (e) {
    return { check: { ok: false, elements: [], problem: reason(e) }, evidence: null };
  }
}

// ── 3 · verdict ────────────────────────────────────────────────────────────

/** Axis → state, off a verdict's `axes`. Throws on axes that are not there. */
function statesOf(axes: unknown): Loose {
  return Object.fromEntries(
    Object.entries(axes as Loose).map(([axis, result]) => [axis, (result as { state: unknown }).state]));
}

/**
 * The same map for a screen: a state that is not text is shown as the JSON
 * it is, and one that is not there at all is left out, which is also how the
 * comparison below reads it.
 */
function shown(states: Loose | null): Record<string, string> | null {
  if (states === null) return null;
  return Object.fromEntries(Object.entries(states).flatMap(([axis, state]): [string, string][] => {
    const text = typeof state === 'string' ? state : JSON.stringify(state);
    return typeof text === 'string' ? [[axis, text]] : [];
  }));
}

/**
 * A time every machine reads as the same instant: ISO 8601 with its zone
 * stated, or a date alone, which is UTC.
 */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

/**
 * Whether the engine's `Date.parse` gives one answer for this value wherever
 * it runs.
 *
 * It does for a time written as `INSTANT` on a day the calendar has, and for
 * a value that is not there. It does not for a time without a zone, which is
 * read in the machine's own — nine hours apart between a server on UTC and a
 * browser in Seoul — nor for any other spelling, which an engine reads by
 * habits of its own: Node's takes 30 February for 2 March, where the
 * language standard has it as no date at all.
 */
function readsTheSameEverywhere(time: unknown): boolean {
  if (time === undefined || time === null || time === '') return true;
  const m = typeof time === 'string' ? INSTANT.exec(time) : null;
  if (m === null) return false;
  const part = (i: number): number => Number(m[i] ?? 0);
  const leap = part(1) % 4 === 0 && (part(1) % 100 !== 0 || part(1) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][part(2) - 1] ?? 0;
  return part(3) >= 1 && part(3) <= days && part(4) <= 23 && part(5) <= 59 && part(6) <= 59 && part(7) <= 23 && part(8) <= 59;
}

/**
 * The first time in the evidence that the engine does arithmetic on and that
 * would not read the same everywhere — named by where it is — or `null`.
 *
 * These are the engine's six, read the way it reads them: when the funds
 * moved, the last payout, the bank's approval, the receiving VASP's, and the
 * two ends of the quote. The SDK lets `Date.parse` make what it will of each,
 * so its verdict over such a time is the verdict of the machine it ran on.
 * All six sit inside signed elements: only an institution's own signature
 * can put one there.
 */
function machineReadTime(evidence: SettlementEvidence): string | null {
  const el = ((evidence as unknown as Loose).elements ?? {}) as Record<string, Loose | null | undefined>;
  const receipts = (el.payoutReceipts ?? []) as unknown as ArrayLike<Loose | null | undefined>;
  const quote = el.bankApproval?.fxQuote as Loose | null | undefined;
  const times: [string, unknown][] = [
    ['chainTransfer.observedAt', el.chainTransfer?.observedAt],
    ['payoutReceipts.paidAt', receipts[receipts.length - 1]?.paidAt],
    ['bankInstruction.approvedAt', el.bankInstruction?.approvedAt],
    ['travelRule.approvedAt', el.travelRule?.approvedAt],
    ['bankApproval.fxQuote.quotedAt', quote?.quotedAt],
    ['bankApproval.fxQuote.validUntil', quote?.validUntil],
  ];
  return times.find(([, time]) => !readsTheSameEverywhere(time))?.[0] ?? null;
}

/**
 * The same axes with the same states, in whatever order each map lists them.
 * A state is compared as the JSON it is, so one that is not text is still
 * compared for what it holds.
 */
function sameStates(x: Loose, y: Loose): boolean {
  const kx = Object.keys(x).sort();
  const ky = Object.keys(y).sort();
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && JSON.stringify(x[k]) === JSON.stringify(y[k]));
}

function checkVerdict(res: unknown, evidence: SettlementEvidence | null): EvidenceCheckReport['verdict'] {
  let mine: Loose | null = null;
  let theirs: Loose | null = null;
  let problem: string | undefined;
  try {
    const pkg = within(responseOf(res).package, 'the package');
    try {
      theirs = statesOf(within(pkg.verdict, 'the stated verdict').axes);
    } catch (e) {
      problem = `the package states no verdict that can be read — ${reason(e)}`;
    }
    if (evidence !== null) {
      const found = statesOf(evaluate(evidence, pkg.policy as Policy).axes);
      const time = machineReadTime(evidence);
      if (time === null) mine = found;
      else problem = `the verdict would depend on the machine computing it: ${time} is not an ISO 8601 time with its zone stated`;
    }
  } catch (e) {
    problem = reason(e);
  }
  // Said last so that it is the reason given: the engine was never run.
  if (evidence === null) problem = 'not re-evaluated: the element signatures could not be checked';

  try {
    const ok = mine !== null && theirs !== null && sameStates(mine, theirs);
    return { ok, mine: shown(mine), theirs: shown(theirs), ...(problem === undefined ? {} : { problem }) };
  } catch (e) {
    return { ok: false, mine: null, theirs: null, problem: reason(e) };
  }
}

// ── 4 · anchor ─────────────────────────────────────────────────────────────

function checkAnchor(res: unknown): EvidenceCheckReport['anchor'] {
  let leafMatches: boolean | null = null;
  try {
    const root = responseOf(res);
    const bundle = (root.attestation as Loose | null | undefined)?.bundle as Loose | null | undefined;
    if (!bundle) return { ok: false, pending: true, leafMatches: null, bundle: null };

    const leaf = (bundle.record as Loose | null | undefined)?.leaf_bytes;
    const stated = (root.commitment as Loose | null | undefined)?.value;
    leafMatches = typeof leaf === 'string' && leaf === stated;
    const report = verifyBundle(bundle as unknown as ProofBundle, {});
    return { ok: leafMatches && report.verified === true, pending: false, leafMatches, bundle: report };
  } catch (e) {
    return { ok: false, pending: false, leafMatches, bundle: null, problem: reason(e) };
  }
}

// ── heading ────────────────────────────────────────────────────────────────

function subjectOf(res: unknown): EvidenceCheckReport['subject'] {
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  try {
    const pkg = (res as Loose | null | undefined)?.package as Loose | null | undefined;
    return { paymentId: text(pkg?.payment_id), state: text(pkg?.state), generatedAt: text(pkg?.generated_at) };
  } catch {
    return { paymentId: null, state: null, generatedAt: null };
  }
}
