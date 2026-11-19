/**
 * What a file handed to 검증 is, what it is checked against, and the checks.
 *
 * The console hands out three kinds of proof — the bundle of any anchored
 * record, a settlement's evidence package, a reserve snapshot's proof file —
 * and one screen checks all of them. A visitor does not say which kind a file
 * is; the file does. So this module reads each file for what it is, decides
 * what the two slots mean together, and runs the check that pairing calls
 * for. Nothing here draws or asks a server: the screen (`verify.ts`) words
 * the outcome, and this part can be run where there is no browser.
 *
 * ## Why the pairing matters
 *
 * A bundle says one thing: this hash went into that Bitcoin transaction. To
 * say *what* was anchored, something has to be hashed and compared — and the
 * three products do not hash alike. A document's anchor is the SHA-256 of
 * its bytes. A reserve snapshot's is a commitment over its statement. A
 * settlement's is a commitment over its evidence package and a nonce. Hashing
 * a snapshot's proof file or an evidence package as if it were a document
 * gives a different value, and the honest file would be called a forgery.
 * (A bundle labels its preimage `sha256-file` whatever the product, so its
 * own word cannot be used to tell them apart.) Each original is therefore
 * held against the anchored hash by its own rule — and by the document rule
 * first, since any file at all may have been anchored as a document.
 *
 * ## What is never done
 *
 * A file that does not match is never reported as holding because some other
 * reading of it would. And a check that was not run is reported as not run:
 * a pairing decides which checks apply, not which pass.
 */
import { bytesToHex, porSnapshotCommitment, sha256, verifyBundle, verifyStatement } from './vendor/attest-verify/index.ts';
import type { ProofBundle, SignedStatement, VerifyReport } from './vendor/attest-verify/index.ts';
import { SnapshotProofError, ledgerOptionsOf, parseSnapshotProof, restoreSnapshot } from './vendor/attest-por/snapshot-proof.ts';
import type { PorSnapshotProof, SnapshotMismatch } from './vendor/attest-por/snapshot-proof.ts';
import { MAX_ACCOUNTS, MAX_TREE_SUMS, readLedger, treeSums } from './por-ledger.ts';
import { checkEvidence, looksLikeEvidence } from './evidence-check.ts';
import type { EvidenceCheckReport } from './evidence-check.ts';

/** What a file turned out to be. `other` is everything that is not a proof: a document, a balance file. */
export type ReadFile =
  | { kind: 'bundle'; bundle: ProofBundle }
  | { kind: 'evidence'; value: Record<string, unknown> }
  | { kind: 'snapshot'; proof: PorSnapshotProof }
  /** A reserve proof file by its own word, but damaged or of a version this code does not read. */
  | { kind: 'snapshot-unreadable'; error: SnapshotProofError }
  /** One account's proof — the file an account holder takes to the public verify page. */
  | { kind: 'account-proof' }
  | { kind: 'other' };

/** A JSON object, or nothing: a proof of any kind is one. */
function jsonObject(bytes: Uint8Array): { text: string; value: Record<string, unknown> } | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Looked at before it is parsed: a balance export can be a hundred megabytes of CSV.
  if (!/^[\uFEFF\s]*\{/.test(text.slice(0, 64))) return null;
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { text, value: value as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** Read a file for what it is. Never throws. */
export function readFile(bytes: Uint8Array): ReadFile {
  const json = jsonObject(bytes);
  if (!json) return { kind: 'other' };
  try {
    return { kind: 'snapshot', proof: parseSnapshotProof(json.text) };
  } catch (e) {
    if (!(e instanceof SnapshotProofError)) return { kind: 'other' };
    if (e.code === 'account_proof') return { kind: 'account-proof' };
    if (e.code === 'unsupported_version' || e.code === 'damaged') return { kind: 'snapshot-unreadable', error: e };
  }
  if (looksLikeEvidence(json.value)) return { kind: 'evidence', value: json.value };
  // A bundle is known by its record: the anchored hash is the one thing every bundle has.
  const record = json.value['record'];
  if (record !== null && typeof record === 'object' && typeof (record as { leaf_bytes?: unknown }).leaf_bytes === 'string') {
    return { kind: 'bundle', bundle: json.value as unknown as ProofBundle };
  }
  return { kind: 'other' };
}

/** What a bundle's anchored hash is held against. */
export type BundleOriginal =
  | { as: 'document'; bytes: Uint8Array }
  | { as: 'snapshot'; proof: PorSnapshotProof };

/**
 * What the two slots mean together.
 *
 * `swapped` — the proof was in the second slot and the first held its
 * original: put right without a word, since nothing is lost by it.
 */
export type Plan = PlanBody & { swapped: boolean };

type PlanBody =
  | { check: 'bundle'; bundle: ProofBundle; original: BundleOriginal | null }
  /** `bundle`: a bundle given beside the package, to be the anchor it is checked against. `spare`: a second file the check has no use for. */
  | { check: 'evidence'; evidence: Record<string, unknown>; bundle: ProofBundle | null; spare: boolean }
  /** `ledger` null: the proof file alone, which states a snapshot and proves nothing of it. */
  | { check: 'snapshot'; proof: PorSnapshotProof; ledger: Uint8Array | null }
  | { check: 'none'; why: 'not_a_proof' | 'account_proof' | 'snapshot_unreadable' | 'two_of_a_kind' | 'no_pair'; error?: SnapshotProofError };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const leafOf = (bundle: ProofBundle): string => String((bundle.record as { leaf_bytes?: unknown } | undefined)?.leaf_bytes ?? '').toLowerCase();

/** How a bundle says its anchored hash was made. */
const SIGNED = 'sha256-signed-statement/v1';
const schemeOf = (bundle: ProofBundle): string => text((bundle.record as { preimage?: { scheme?: unknown } } | undefined)?.preimage?.scheme);
/** An inscription: the document is in the transaction, and whatever else the bundle says of its preimage is not what was anchored. */
const inscribed = (bundle: ProofBundle): boolean => Boolean((bundle.anchor as { witness_envelope?: unknown } | undefined)?.witness_envelope);
/** A signed anchor's statement, when the bundle carries one. */
const statementOf = (bundle: ProofBundle): SignedStatement | null => {
  const st = (bundle.record as { preimage?: { statement?: unknown } } | undefined)?.preimage?.statement;
  return st !== null && typeof st === 'object' ? st as SignedStatement : null;
};

/**
 * The SHA-256 the document behind a bundle has: the anchored hash itself for
 * a plain hash anchor and for an inscription, the one the statement names
 * for a signed anchor. Empty for a bundle whose hash is of no document.
 */
function documentDigest(bundle: ProofBundle): string {
  if (inscribed(bundle) || schemeOf(bundle) === 'sha256-file') return leafOf(bundle);
  if (schemeOf(bundle) === SIGNED) return text((statementOf(bundle) as { document?: { sha256?: unknown } } | null)?.document?.sha256).toLowerCase();
  return '';
}
const isDocumentOf = (bundle: ProofBundle, bytes: Uint8Array): boolean => {
  const digest = documentDigest(bundle);
  return digest !== '' && bytesToHex(sha256(bytes)) === digest;
};

type Slot = { read: ReadFile; bytes: Uint8Array };

function decide(a: Slot, b: Slot | null): PlanBody {
  const x = a.read;
  if (x.kind === 'other') return { check: 'none', why: 'not_a_proof' };
  if (x.kind === 'account-proof') return { check: 'none', why: 'account_proof' };
  if (x.kind === 'snapshot-unreadable') return { check: 'none', why: 'snapshot_unreadable', error: x.error };

  if (x.kind === 'bundle') {
    if (!b) return { check: 'bundle', bundle: x.bundle, original: null };
    const y = b.read;
    if (y.kind === 'evidence') return { check: 'evidence', evidence: y.value, bundle: x.bundle, spare: false };
    if (y.kind === 'snapshot') return { check: 'bundle', bundle: x.bundle, original: { as: 'snapshot', proof: y.proof } };
    if (y.kind === 'bundle') return { check: 'none', why: 'two_of_a_kind' };
    if (y.kind === 'snapshot-unreadable') return { check: 'none', why: 'snapshot_unreadable', error: y.error };
    if (y.kind === 'account-proof') return { check: 'none', why: 'no_pair' };
    return { check: 'bundle', bundle: x.bundle, original: { as: 'document', bytes: b.bytes } };
  }

  if (x.kind === 'evidence') {
    if (!b) return { check: 'evidence', evidence: x.value, bundle: null, spare: false };
    if (b.read.kind === 'bundle') return { check: 'evidence', evidence: x.value, bundle: b.read.bundle, spare: false };
    if (b.read.kind === 'evidence') return { check: 'none', why: 'two_of_a_kind' };
    // Beside a proof of another kind it is no pair, whichever slot each is in; beside a file that is no proof
    // it is checked on its own and the file is said to be unused.
    if (b.read.kind !== 'other') return { check: 'none', why: 'no_pair' };
    return { check: 'evidence', evidence: x.value, bundle: null, spare: true };
  }

  // A reserve snapshot's proof file.
  if (!b) return { check: 'snapshot', proof: x.proof, ledger: null };
  const y = b.read;
  if (y.kind === 'bundle') return { check: 'bundle', bundle: y.bundle, original: { as: 'snapshot', proof: x.proof } };
  if (y.kind === 'other') return { check: 'snapshot', proof: x.proof, ledger: b.bytes };
  if (y.kind === 'snapshot') return { check: 'none', why: 'two_of_a_kind' };
  return { check: 'none', why: 'no_pair' };
}

/** Decide what to check from the bytes of the two slots; the second may be empty. Never throws. */
export function planCheck(first: Uint8Array, second: Uint8Array | null): Plan {
  const a: Slot = { read: readFile(first), bytes: first };
  const b: Slot | null = second ? { read: readFile(second), bytes: second } : null;
  if (b) {
    // Any file may have been anchored as a document — a proof file of any kind, a damaged one, one account's
    // proof, another bundle. A bundle beside the very file its hash is of is that pair, whichever slot each is
    // in and whatever else the file looks like; so this is tried before every other reading of the two, and
    // before any refusal. (A file that is no proof is held as a document anyway, and is hashed once, when it
    // is checked — it may be very large.)
    if (a.read.kind === 'bundle' && b.read.kind !== 'other' && isDocumentOf(a.read.bundle, b.bytes)) {
      return { check: 'bundle', bundle: a.read.bundle, original: { as: 'document', bytes: b.bytes }, swapped: false };
    }
    if (b.read.kind === 'bundle' && a.read.kind !== 'other' && isDocumentOf(b.read.bundle, a.bytes)) {
      return { check: 'bundle', bundle: b.read.bundle, original: { as: 'document', bytes: a.bytes }, swapped: true };
    }
  }
  // A proof in the second slot and none in the first: the two slots the other way round.
  if (a.read.kind === 'other' && b && b.read.kind !== 'other') return { ...decide(b, a), swapped: true };
  return { ...decide(a, b), swapped: false };
}

/** What a bundle says it anchors. Its own label — the proof does not cover it, and it is shown as a label. */
export type BundleSubject =
  | { kind: 'por-snapshot'; snapshotId: string }
  | { kind: 'remit-evidence'; paymentId: string }
  /** A day's settlements, closed and anchored as one record. */
  | { kind: 'remit-manifest'; date: string }
  /** A record of a kind this screen has no words for: named as the bundle names it. */
  | { kind: 'other'; name: string }
  /** No label: a document. */
  | null;

export function bundleSubject(bundle: ProofBundle): BundleSubject {
  const d = (bundle.record as { descriptor?: unknown } | undefined)?.descriptor;
  if (d === null || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (o['kind'] === 'por-snapshot' && text(o['snapshot_id'])) {
    return { kind: 'por-snapshot', snapshotId: text(o['snapshot_id']) };
  }
  if (o['kind'] === 'remit-evidence' && text(o['payment_id'])) return { kind: 'remit-evidence', paymentId: text(o['payment_id']) };
  if (o['kind'] === 'remit-manifest' && text(o['date'])) return { kind: 'remit-manifest', date: text(o['date']) };
  if (text(o['kind'])) return { kind: 'other', name: text(o['kind']) };
  return null;
}

/** The preimage rules a bundle may name that this screen has words for. Anything else is said to be unknown. */
const KNOWN_SCHEMES = new Set(['', 'sha256-file', SIGNED, 'sha256-jcs-fields']);

/**
 * Whether a bundle ties its hash to a transaction, rather than only saying
 * that it does.
 *
 * The verifier marks nothing against a bundle that carries no transaction —
 * it reports the link as not checked. On this screen "holds" means the hash
 * is in the batch and the batch is in a transaction whose id was recomputed
 * from the transaction itself; every bundle the platform hands out carries
 * that transaction, so one without it shows less than it claims. An
 * inscription has no batch: its document is the transaction's own content.
 */
const chained = (report: VerifyReport): boolean =>
  report.links.C1 === 'pass' && (report.witnessMode || report.links.B === 'pass');

export interface BundleOutcome {
  report: VerifyReport;
  /** The bundle's own word for how its hash was made (`sha256-file`, a signed statement, …); empty when it says nothing. */
  scheme: string;
  /** False when the bundle names a rule this screen does not know: nothing could then be held against the hash. */
  schemeKnown: boolean;
  /**
   * How the original was held against what was anchored, if one was given.
   * `unused`: the bundle's rule hashes fields it carries itself, and has no
   * use for a file.
   */
  original: 'none' | 'document' | 'snapshot' | 'unused';
  /** Whether the original is the anchored one. `null`: none was given, or the bundle has no use for one. */
  originalMatches: boolean | null;
  /**
   * The first of the four links, as the screen reports it: whether the file
   * the visitor holds is what was anchored. `skip` whenever no file was held
   * against anything — except for an inscription, which carries its document
   * — and for a signed anchor whenever the issuer's signature did not verify:
   * nothing is said to be "the document the issuer signed" on the strength of
   * a signature nobody could check.
   */
  documentLink: 'pass' | 'fail' | 'skip';
  /**
   * A signed anchor's issuer: the signature over the statement, checked with
   * the key the statement carries — and only when that statement is what was
   * anchored. `skip` when this page cannot check it (an RSA key, where the
   * browser withholds WebCrypto). `null` for any other bundle, an inscription
   * included: a statement written into its preimage is nothing the
   * transaction anchors.
   */
  issuer: { keyId: string; algorithm: string; signature: 'pass' | 'fail' | 'skip'; problem?: string } | null;
  /**
   * The bundle holds: every gating check of the verifier, the hash tied to a
   * transaction, the original the anchored one when one was given, and — for
   * a signed anchor — the issuer's signature verified.
   */
  verified: boolean;
  /**
   * Everything that could be checked holds, and the issuer's signature could
   * not be checked on this page. Not holding, and not failed: a third state.
   */
  unsigned: boolean;
  subject: BundleSubject;
  /** The snapshot a proof file states, when that was the original. */
  snapshot: PorSnapshotProof | null;
}

async function issuerOf(bundle: ProofBundle): Promise<BundleOutcome['issuer']> {
  if (inscribed(bundle) || schemeOf(bundle) !== SIGNED) return null;
  const statement = statementOf(bundle);
  if (!statement) return { keyId: '', algorithm: '', signature: 'fail', problem: 'the bundle names a signed statement and carries none' };
  const v = await verifyStatement(statement, leafOf(bundle));
  // The one check this page may be unable to run: an RSA signature where the browser withholds WebCrypto.
  // Anything else that stops the check — a statement with no signature, a key that cannot be read — is a
  // signature that did not verify.
  const withheld = v.error !== undefined && !globalThis.crypto?.subtle && v.algorithm === 'RS256';
  const signature = withheld ? 'skip' : v.error === undefined && v.signatureOk && v.leafOk ? 'pass' : 'fail';
  const problem = v.error ?? (v.leafOk ? undefined : 'the statement is not what was anchored');
  return { keyId: v.keyId, algorithm: v.algorithm, signature, ...(problem === undefined ? {} : { problem }) };
}

/**
 * Check a bundle, and the original against it.
 *
 * The verifier checks the bundle. What the visitor's own file is held against
 * depends on what was anchored, and is decided here so that no file is ever
 * reported as matching when it was not looked at:
 *
 *   - a document anchored by hash, or inscribed: its SHA-256 is the anchored
 *     hash. (For an inscription the verifier reads the document out of the
 *     transaction and never looks at a file given beside it.)
 *   - a signed anchor: the anchored hash is of the issuer's statement, and
 *     the statement names the document's SHA-256. (The verifier checks the
 *     first half and reports link A on it alone.)
 *   - a reserve snapshot: the commitment over its statement, by the exchange
 *     SDK's rule — `porSnapshotCommitment`, the function the platform anchors
 *     with.
 */
export async function checkBundle(bundle: ProofBundle, original: BundleOriginal | null): Promise<BundleOutcome> {
  const subject = bundleSubject(bundle);
  const scheme = schemeOf(bundle);
  const issuer = await issuerOf(bundle);
  const base = { scheme, schemeKnown: KNOWN_SCHEMES.has(scheme) || inscribed(bundle), issuer, subject };
  /** Put the parts together: what holds, what is the third state, and what link A may say. */
  const outcome = (report: VerifyReport, held: BundleOutcome['original'], matches: boolean | null, link: BundleOutcome['documentLink'], snapshot: PorSnapshotProof | null): BundleOutcome => {
    const rest = report.verified === true && chained(report) && matches !== false;
    const signed = issuer === null || issuer.signature === 'pass';
    return {
      ...base, report, original: held, originalMatches: matches, snapshot,
      documentLink: issuer !== null && issuer.signature !== 'pass' && link === 'pass' ? 'skip' : link,
      verified: rest && signed,
      unsigned: rest && issuer?.signature === 'skip',
    };
  };
  if (original?.as === 'snapshot') {
    const report = await verifyBundle(bundle, {});
    const matches = porSnapshotCommitment(original.proof.statement) === leafOf(bundle);
    return outcome(report, 'snapshot', matches, matches ? 'pass' : 'fail', original.proof);
  }
  // A document is hashed once, by whoever judges it: the verifier for a plain hash anchor, this function
  // where the verifier does not look at the file (an inscription, a signed anchor). An original may be
  // hundreds of megabytes, and the hash runs on the thread that draws the page.
  const byVerifier = original !== null && scheme === 'sha256-file' && !inscribed(bundle);
  const report = await verifyBundle(bundle, byVerifier ? { originalBytes: original.bytes } : {});
  const a = report.links.A ?? 'skip';
  if (!original) {
    // An inscription's document is in the transaction and the verifier has held it against the hash; of any
    // other bundle nothing can be said about a document nobody supplied — a signed statement included.
    return outcome(report, 'none', null, report.witnessMode && (a === 'pass' || a === 'fail') ? a : 'skip', null);
  }
  let matches: boolean | null;
  if (byVerifier) {
    matches = a === 'pass';
  } else if (report.witnessMode) {
    matches = bytesToHex(sha256(original.bytes)) === leafOf(bundle);
  } else if (scheme === SIGNED) {
    // The statement against the anchored hash is the verifier's check; the document against the statement is made here.
    matches = a !== 'fail' && bytesToHex(sha256(original.bytes)) === documentDigest(bundle);
  } else {
    // A rule that hashes fields the bundle carries, or one this screen does not know: the file was not used,
    // and the first link says nothing of it.
    matches = null;
  }
  return outcome(report, matches === null ? 'unused' : 'document', matches, matches === null ? 'skip' : matches ? 'pass' : 'fail', null);
}

export interface EvidenceOutcome {
  /** The four checks. Made against the bundle given beside the package when that bundle is its anchor; otherwise on the package as it was downloaded. */
  report: EvidenceCheckReport;
  /**
   * The bundle given beside the package, if one was: whether the hash it
   * anchors is the package's, and what the bundle itself names as its record.
   * A bundle of another record is a mistake in the pairing — it says nothing
   * against the package, and is reported as that mistake.
   */
  given: { matches: boolean; subject: BundleSubject } | null;
  /**
   * Where the anchor stands: held (the bundle's hash is the package's and is
   * tied to a transaction), waiting (no bundle yet), or failed. Stricter than
   * the four checks' own `anchor.ok`, which a bundle carrying no transaction
   * can pass.
   */
  anchor: 'pass' | 'pending' | 'fail';
  /** The package holds — and the bundle given beside it, when one was, is its anchor. */
  verified: boolean;
}

/** An evidence outcome from its report: the anchor by this screen's rule, and what that makes of the whole. */
function evidenceOutcome(report: EvidenceCheckReport, given: EvidenceOutcome['given']): EvidenceOutcome {
  const anchor = report.anchor.pending ? 'pending'
    : report.anchor.ok && report.anchor.bundle !== null && chained(report.anchor.bundle) ? 'pass' : 'fail';
  return {
    report, given, anchor,
    verified: report.commitment.ok && report.signatures.ok && report.verdict.ok && anchor === 'pass' && given?.matches !== false,
  };
}

/**
 * Check an evidence package, and the bundle given beside it.
 *
 * A package downloaded before its anchor confirmed carries no bundle of its
 * own; the bundle of its record, taken from 앵커링 기록 later, completes it.
 * Such a bundle — one whose anchored hash is the package's stated commitment
 * — takes the place of whatever the package carries, and the four checks are
 * made against it. Any other bundle is not this package's anchor: the pair
 * does not hold, and the package is checked as it came.
 */
export async function checkEvidenceWith(evidence: Record<string, unknown>, bundle: ProofBundle | null): Promise<EvidenceOutcome> {
  if (!bundle) return evidenceOutcome(await checkEvidence(evidence), null);
  // Compared as the four checks compare them: the two strings as they are written.
  const stated = (evidence['commitment'] as { value?: unknown } | null | undefined)?.value;
  const leaf = (bundle.record as { leaf_bytes?: unknown } | undefined)?.leaf_bytes;
  const matches = typeof stated === 'string' && stated !== '' && leaf === stated;
  const subject = bundleSubject(bundle);
  if (!matches) return evidenceOutcome(await checkEvidence(evidence), { matches: false, subject });
  const attestation = evidence['attestation'];
  const report = await checkEvidence({
    ...evidence,
    attestation: { ...(attestation !== null && typeof attestation === 'object' ? attestation as Record<string, unknown> : {}), bundle },
  });
  return evidenceOutcome(report, { matches: true, subject });
}

export type SnapshotOutcome = { proof: PorSnapshotProof; /** The balance file is byte for byte the one the proof file was written for. */ sameFile: boolean } & (
  | { result: 'match'; accounts: number }
  | { result: 'mismatch'; mismatch: SnapshotMismatch }
  /** The file could not be read as the balance file the proof file describes. `message`: the reader's first problem, as it words it. */
  | { result: 'unreadable'; why: 'not_text' | 'reader_failed' | 'problems'; message: string }
  /** The file has more rows than the snapshot the proof file states could have been built from: another file. */
  | { result: 'too_many_rows'; accounts: number }
  /** The snapshot itself is past what a page can rebuild. `accounts` is the snapshot's own count. */
  | { result: 'too_large'; accounts: number; assets: number }
  | { result: 'failed'; message: string }
);

/** Whether the bytes hold more line breaks than `limit`. Stops at the first one past it. */
function moreLinesThan(bytes: Uint8Array, limit: number): boolean {
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a && ++lines > limit) return true;
  return false;
}

/**
 * Put a proof file and a balance file together: read the balance file as the
 * proof file says it was read, rebuild the tree, and compare root, totals and
 * account count with the statement. The SDK's own `restoreSnapshot` does the
 * comparing, so the answer is the one `openSnapshot` gives on a server.
 *
 * Synchronous, and heavy for a real ledger: a hash per node of the tree. The
 * caller lets the page draw first. A file that cannot be the original is
 * turned away before any of that work — whatever is dropped in the slot is
 * read on the thread that draws the page, and a hundred megabytes of
 * something else must not freeze it for half a minute to say so.
 */
export function checkSnapshotFiles(proof: PorSnapshotProof, ledger: Uint8Array): SnapshotOutcome {
  const options = ledgerOptionsOf(proof);
  const stated = proof.statement.tree.leaf_count;
  const json = proof.source.layout === 'json';
  // Byte for byte the recorded file: only a file of the recorded length can be, so only that one is hashed.
  let same: boolean | null = null;
  const base = {
    proof,
    get sameFile(): boolean {
      same ??= ledger.length === proof.source.bytes && bytesToHex(sha256(ledger)) === proof.source.sha256;
      return same;
    },
  };
  const out = <T extends object>(rest: T): T & { proof: PorSnapshotProof; sameFile: boolean } => ({ proof, sameFile: base.sameFile, ...rest });

  if (stated > MAX_ACCOUNTS) return out({ result: 'too_large' as const, accounts: stated, assets: options.assets.length });
  // A CSV has a row for each account, or for each balance an account holds, and a header. More line breaks
  // than that — with room for blank lines — is more rows than this snapshot was built from.
  if (!json && moreLinesThan(ledger, stated * Math.max(1, options.assets.length) + 1_000)) {
    return out({ result: 'too_many_rows' as const, accounts: stated });
  }
  let decoded = '';
  if (json) {
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(ledger);
    } catch {
      return out({ result: 'unreadable' as const, why: 'not_text' as const, message: 'the file is not UTF-8' });
    }
  }
  let read: ReturnType<typeof readLedger>;
  try {
    read = readLedger(ledger, decoded, json, options);
  } catch (e) {
    return out({ result: 'unreadable' as const, why: 'reader_failed' as const, message: e instanceof Error ? e.message : String(e) });
  }
  // The reader stops counting at what this screen takes. The snapshot is within that, so a file past it has
  // more accounts than the snapshot: another file, not one too large to check.
  if (read.report.problems.some((p) => p.code === 'too_many_accounts')) return out({ result: 'too_many_rows' as const, accounts: stated });
  if (!read.report.ok) {
    const p = read.report.problems[0];
    return out({
      result: 'unreadable' as const, why: 'problems' as const,
      // What the reader found. Its advice on command-line options, after the semicolon, is for another tool.
      message: p ? `${p.line > 0 ? `${p.line}: ` : ''}${p.code} — ${p.message.split('; ')[0]}` : '',
    });
  }
  if (treeSums(read.rows, options.assets.length) > MAX_TREE_SUMS) {
    return out({ result: 'too_large' as const, accounts: read.rows.length, assets: options.assets.length });
  }
  try {
    const { tree } = restoreSnapshot(proof, read.rows);
    return out({ result: 'match' as const, accounts: tree.leaf_count });
  } catch (e) {
    if (e instanceof SnapshotProofError && e.mismatch !== null) return out({ result: 'mismatch' as const, mismatch: e.mismatch });
    return out({ result: 'failed' as const, message: e instanceof Error ? e.message : String(e) });
  }
}
