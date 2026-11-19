/**
 * Evidence bundle assembly.
 *
 * ## What the archive is for
 *
 * One file a reviewer can attach to a case, hand to an auditor, or keep for
 * years — and from which the whole result can be re-derived without contacting
 * StoneHash. That means the archive has to carry the *inputs* as well as the
 * conclusion: the sources, the exact policy, the verdict, and the proof files.
 * A report alone would be an assertion; the inputs make it checkable.
 *
 * ## Proof-file compatibility
 *
 * `merkle-proof.json` and `bitcoin-anchor.json` are split out of the proof
 * bundle, and `proof-bundle.json` is included whole. The whole file is what the
 * published verifier consumes, so a reviewer can run the existing open-source
 * tool against this archive directly rather than needing a StoneHash-specific
 * reader. The split files are for people reading rather than executing.
 *
 * ## Reproducibility
 *
 * Deterministic: no clock, no locale, no randomness. The timestamp and bundle id
 * come from the caller, entries are emitted in a fixed order, and every JSON is
 * serialised with sorted keys. Two exports of the same evidence produce
 * byte-identical archives, so a digest of the archive is meaningful.
 */
import { bytesToHex, sha256, utf8 } from '@stonehash/attest-verify';
import type { ProofBundle, VerifyReport } from '@stonehash/attest-verify';
import { canonicalPolicy } from '@stonehash/attest-rules';
import type { MatchingResult, Policy, SettlementEvidence } from '@stonehash/attest-rules';
import { writeZip } from './zip.ts';
import type { ZipEntry } from './zip.ts';
import { renderPdf } from './pdf.ts';
import { buildReport } from './report.ts';

export interface AssembleInput {
  evidence: SettlementEvidence;
  policy: Policy;
  verdict: MatchingResult;
  /** The anchored proof, when the evidence was anchored. */
  proofBundle?: ProofBundle;
  /** The verifier's own report on that proof, if it was run. */
  proofReport?: VerifyReport;
  /** Stable archive identifier. Caller-supplied so the output stays pure. */
  bundleId: string;
  /** Written into the archive and the PDF. Caller-supplied, never the clock. */
  generatedAt: Date;
  /** `false` stores entries uncompressed. */
  compress?: boolean;
}

/** Canonical JSON: sorted keys, two-space indent, trailing newline. */
function json(value: unknown): Uint8Array {
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
  return utf8(`${JSON.stringify(norm(value), null, 2)}\n`);
}

export interface BundleFile {
  path: string;
  /** One line explaining what it is, repeated into `manifest.json`. */
  describes: string;
  bytes: Uint8Array;
}

/**
 * Build the file set without archiving it.
 *
 * Exposed separately so the Playground can show the contents before a download
 * and the service can stream individual members.
 */
export function assembleFiles(i: AssembleInput): BundleFile[] {
  const files: BundleFile[] = [];
  const add = (path: string, describes: string, bytes: Uint8Array): void => {
    files.push({ path, describes, bytes });
  };

  add('evidence.json',
    'The source evidence as submitted: the fund movement, payout confirmation, bank instruction '
    + 'and commercial documents, with their digests and signature states.',
    json(i.evidence));

  // The canonical form, not a pretty-printed copy: this is the exact byte
  // sequence the verdict's policy digest was taken over, so a reader can
  // recompute the digest and confirm which rules ran.
  add('policy.json',
    'The exact rules that produced the verdict, in the canonical form the policy digest is '
    + 'taken over. Re-hash this file to confirm it matches matching-results.json.',
    utf8(`${canonicalPolicy(i.policy)}\n`));

  add('matching-results.json',
    'The verdict as data: six axis states, every finding with its expected and actual values, '
    + 'and the policy version and digest that produced them.',
    json(i.verdict));

  // Digests and signature states, lifted out for a reader who wants them
  // without walking the whole evidence document.
  const el = i.evidence.elements;
  const sources: Record<string, unknown> = {};
  const signatures: Record<string, unknown> = {};
  const record = (name: string, v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    const e = v as { digest?: string; digestVerified?: boolean; signature?: unknown };
    if (e.digest !== undefined) {
      sources[name] = { digest: e.digest, verified: e.digestVerified ?? null };
    }
    if (e.signature !== undefined) signatures[name] = e.signature;
  };
  record('chainTransfer', el.chainTransfer);
  for (const [n, r] of (el.payoutReceipts ?? []).entries()) record(`payoutReceipt[${n}]`, r);
  record('bankInstruction', el.bankInstruction);
  record('commercialDocs', el.commercialDocs);

  add('source-hashes.json',
    'Digest of each source document and whether the submitted bytes were checked against it. '
    + '`verified: null` means no check was performed - it does not mean the document is intact.',
    json(sources));

  add('issuer-signatures.json',
    'Signature state per element. Signature validity and issuer identity are separate: a '
    + 'demonstration key can produce a valid signature while establishing nothing about who signed.',
    json(signatures));

  if (i.proofBundle) {
    // The whole file first: this is what the published verifier consumes.
    add('proof-bundle.json',
      'The Bitcoin proof bundle, complete and unmodified. This is the file the published '
      + 'open-source verifier reads, so it can be checked without any StoneHash software.',
      json(i.proofBundle));
    if (i.proofBundle.merkle) {
      add('merkle-proof.json',
        'The Merkle inclusion proof, split out for reading. Folding leaf_bytes through the '
        + 'siblings reproduces the root.',
        json({ record: i.proofBundle.record, merkle: i.proofBundle.merkle }));
    }
    add('bitcoin-anchor.json',
      'The on-chain commitment, split out for reading: the anchor payload, the raw transaction '
      + 'and the claimed block. The block is a claim - a strict verifier re-fetches it from a '
      + 'Bitcoin source of its own choosing.',
      json({ bitcoin_network: i.proofBundle.bitcoin_network, anchor: i.proofBundle.anchor }));
  }

  if (i.proofReport) {
    add('verification-report.json',
      'The verifier\'s own result on the proof bundle, link by link. C2 (public-chain inclusion) '
      + 'is reported as unverified unless a Bitcoin source was consulted.',
      json(i.proofReport));
  }

  const pdf = renderPdf(
    buildReport({
      verdict: i.verdict,
      evidence: i.evidence,
      ...(i.proofReport ? { proof: i.proofReport } : {}),
      bundleId: i.bundleId,
      generatedAt: i.generatedAt,
    }),
    {
      title: `Settlement Evidence Verification Report - ${i.bundleId}`,
      createdAt: i.generatedAt,
      footer: `StoneHash Attest  ·  ${i.bundleId}  ·  policy ${i.verdict.policyVersion}`
        + (i.evidence.dataMode === 'SYNTHETIC' ? '  ·  SYNTHETIC DATA' : ''),
    },
  );
  add('verification-report.pdf',
    'A printable summary for filing. English only - the standard PDF fonts cover Latin-1, so '
    + 'text in other scripts appears in full in the JSON files instead.',
    pdf);

  // The manifest goes last so it can digest everything above it, and is placed
  // first in the archive so a reader meets it first.
  const manifest = {
    bundleFormat: 'stonehash-evidence/v1',
    bundleId: i.bundleId,
    generatedAt: i.generatedAt.toISOString(),
    dataMode: i.evidence.dataMode,
    notRealPayment: i.evidence.notRealPayment,
    scenario: i.evidence.scenario,
    policyVersion: i.verdict.policyVersion,
    policyDigest: i.verdict.policyDigest,
    manualReviewRequired: i.verdict.manualReviewRequired,
    regulatoryDecision: i.verdict.regulatoryDecision,
    axes: Object.fromEntries(Object.entries(i.verdict.axes).map(([k, v]) => [k, v.state])),
    bitcoinNetwork: i.proofBundle?.bitcoin_network ?? null,
    anchorTxid: i.proofBundle?.anchor?.reveal_txid ?? null,
    // Digest of every other member, so a reader can detect an edited archive.
    contents: files.map((f) => ({
      path: f.path,
      bytes: f.bytes.length,
      sha256: bytesToHex(sha256(f.bytes)),
      describes: f.describes,
    })),
    limitations: [
      'Field-coverage mapping is not a compliance determination.',
      'Signature validity does not establish the signer\'s legal identity.',
      'A Bitcoin block is not an RFC 3161 accredited timestamp.',
      'Hash-linked history cannot evidence an event that was never submitted.',
      ...(i.evidence.dataMode === 'SYNTHETIC'
        ? ['All data in this archive is synthetic. No funds moved and no institution certified it.']
        : []),
      ...(i.proofBundle && i.proofBundle.bitcoin_network !== 'mainnet'
        ? [`Anchored to ${i.proofBundle.bitcoin_network}, a non-public chain: links A, B and C1 `
           + 'verify offline but public-chain inclusion cannot be confirmed by a third party.']
        : []),
    ],
  };
  files.unshift({
    path: 'manifest.json',
    describes: 'What this archive contains, with a digest of every other member.',
    bytes: json(manifest),
  });

  return files;
}

export interface AssembledBundle {
  /** The archive. */
  zip: Uint8Array;
  /** `SHA-256` of the archive, for citing it in a case file. */
  sha256: string;
  files: BundleFile[];
  /** Suggested download name. */
  filename: string;
}

/** Build the evidence archive. */
export async function assembleEvidenceBundle(i: AssembleInput): Promise<AssembledBundle> {
  const files = assembleFiles(i);
  const entries: ZipEntry[] = files.map((f) => ({ path: f.path, data: f.bytes }));
  const zip = await writeZip(entries, {
    modifiedAt: i.generatedAt,
    ...(i.compress === false ? { compress: false } : {}),
  });
  return {
    zip,
    sha256: bytesToHex(sha256(zip)),
    files,
    filename: `stonehash-evidence-${i.bundleId}.zip`,
  };
}
