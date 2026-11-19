/**
 * The printable verification report.
 *
 * What a reviewer files. It states the verdict per axis, the reasons behind
 * each, the policy that produced them, and — at the same prominence — what the
 * report does not establish. A summary that omitted the limits would be the most
 * misleading artefact in the archive, because a PDF looks authoritative in a way
 * a JSON file does not.
 */
import type { MatchingResult, SettlementEvidence } from '@stonehash/attest-rules';
import type { VerifyReport } from '@stonehash/attest-verify';
import type { TextRun } from './pdf.ts';

const H1 = { font: 'Helvetica-Bold' as const, size: 17 };
const H2 = { font: 'Helvetica-Bold' as const, size: 11.5, spaceBefore: 18 };
const BODY = { font: 'Helvetica' as const, size: 9.5 };
const MONO = { font: 'Courier' as const, size: 8.5 };
const LABEL = { font: 'Helvetica-Bold' as const, size: 9 };

const AXIS_LABEL: Record<string, string> = {
  integrity: 'Integrity',
  issuer: 'Issuer',
  matching: 'Matching',
  completeness: 'Completeness',
  regulatoryMapping: 'Regulatory mapping',
  businessFinality: 'Business finality',
};

export interface ReportInput {
  verdict: MatchingResult;
  evidence: SettlementEvidence;
  /** Present when the evidence was anchored and a proof bundle exists. */
  proof?: VerifyReport;
  /** Archive identifier, so a printed page can be tied back to its ZIP. */
  bundleId: string;
  generatedAt: Date;
}

function kv(label: string, value: string): TextRun[] {
  return [
    { text: label, ...LABEL, spaceBefore: 6 },
    { text: value, ...MONO, indent: 12 },
  ];
}

/** Compose the report as a flat run list for `renderPdf`. */
export function buildReport(i: ReportInput): TextRun[] {
  const { verdict: v, evidence: ev } = i;
  const runs: TextRun[] = [];

  runs.push({ text: 'Settlement Evidence Verification Report', ...H1 });
  runs.push({ text: 'StoneHash Attest', ...BODY, spaceBefore: 2, rule: true });

  // The caveat goes first, not in an appendix. A reader who stops after the
  // first page must still know what they are holding.
  if (ev.dataMode === 'SYNTHETIC') {
    runs.push({ text: 'SYNTHETIC DATA - NOT A RECORD OF A REAL PAYMENT', ...LABEL, spaceBefore: 14 });
    runs.push({
      text: 'Every transaction, document and signature described below was fabricated for '
        + 'demonstration. No financial institution has certified it, no regulator has approved it, '
        + 'and no funds moved. Signing keys are demonstration keys, so a valid signature here '
        + 'establishes nothing about who signed.',
      ...BODY, indent: 0,
    });
  }

  runs.push({ text: 'Subject', ...H2, rule: true });
  runs.push(...kv('Scenario', ev.scenario));
  runs.push(...kv('Data mode', ev.dataMode));
  if (ev.purpose) runs.push(...kv('Stated purpose', ev.purpose));
  if (ev.jurisdiction) runs.push(...kv('Corridor', `${ev.jurisdiction.from} -> ${ev.jurisdiction.to}`));
  runs.push(...kv('Bundle id', i.bundleId));
  runs.push(...kv('Report generated', i.generatedAt.toISOString()));

  runs.push({ text: 'Verdict by axis', ...H2 });
  runs.push({
    text: 'Reported separately by design. A single pass or fail would hide which claim failed, '
      + 'and missing evidence is kept distinct from contradicted evidence because they call for '
      + 'different action.',
    ...BODY, rule: true,
  });
  for (const [key, axis] of Object.entries(v.axes)) {
    runs.push({ text: `${AXIS_LABEL[key] ?? key}: ${axis.state}`, ...LABEL, spaceBefore: 7 });
    for (const f of axis.findings) {
      runs.push({ text: `[${f.severity.toUpperCase()}] ${f.code}`, ...MONO, indent: 12 });
      runs.push({ text: f.detail, ...BODY, indent: 12 });
      const parts: string[] = [];
      if (f.element) parts.push(`element=${f.element}${f.field ? `.${f.field}` : ''}`);
      if (f.expected !== undefined) parts.push(`expected=${f.expected}`);
      if (f.actual !== undefined) parts.push(`actual=${f.actual}`);
      if (f.tolerance !== undefined) parts.push(`tolerance=${f.tolerance}`);
      if (parts.length > 0) runs.push({ text: parts.join('   '), ...MONO, indent: 12 });
    }
    if (axis.findings.length === 0) {
      runs.push({ text: 'No findings on this axis.', ...BODY, indent: 12 });
    }
  }

  runs.push({ text: 'Manual review', ...H2, rule: true });
  runs.push({
    text: v.manualReviewRequired
      ? 'REQUIRED. At least one axis is not cleanly satisfied. This engine reconciles evidence; '
        + 'whether the payment is acceptable is a judgement about counterparty, jurisdiction and '
        + 'AML risk that it does not make.'
      : 'Not indicated by the reconciliation. This is not an approval: the engine reports only '
        + 'that every axis it evaluates is satisfied under the stated policy.',
    ...BODY,
  });

  runs.push({ text: 'Policy', ...H2, rule: true });
  runs.push({
    text: 'The verdict above is reproducible only against the exact rules that produced it. The '
      + 'version is a label a human chose; the digest is derived from the canonicalised policy '
      + 'bytes, so an edited policy is a different policy whether or not the version was bumped.',
    ...BODY,
  });
  runs.push(...kv('Policy version', v.policyVersion));
  runs.push(...kv('Policy digest (SHA-256)', v.policyDigest));
  runs.push(...kv('Regulatory decision', v.regulatoryDecision));

  if (i.proof) {
    const p = i.proof;
    runs.push({ text: 'Anchoring', ...H2, rule: true });
    runs.push(...kv('Bundle schema', p.schema ?? 'unknown'));
    runs.push(...kv('Bitcoin network', p.network ?? 'unknown'));
    if (p.txid) runs.push(...kv('Anchor transaction', p.txid));
    runs.push({ text: 'Proof links', ...LABEL, spaceBefore: 8 });
    runs.push({
      text: `A original->digest: ${p.links.A}    B digest->root: ${p.links.B}`
        + `    C1 anchor<->txid: ${p.links.C1}    C2 public chain: ${p.links.C2}`,
      ...MONO, indent: 12,
    });
    if (p.links.C2 !== 'pass') {
      runs.push({
        text: 'Public-chain inclusion is reported as unverified. Links A, B and C1 are arithmetic '
          + 'and prove out offline; confirming that the transaction is in a block requires a '
          + 'Bitcoin source of the reader\'s own choosing. On a private test chain a third party '
          + 'cannot establish it at all.',
        ...BODY, indent: 12,
      });
    }
  }

  runs.push({ text: 'What this report does not establish', ...H2, rule: true });
  for (const line of [
    'AML or CFT suitability. Field-coverage mapping shows whether required data is present in a '
      + 'submission; it is not a compliance determination and no regulator has reviewed it.',
    'The legal identity of any party. Verifying a signature proves a key signed specific bytes. '
      + 'Binding that key to an incorporated entity requires a certificate authority or an '
      + 'identity check, reported here as a separate axis.',
    'The true source of funds, or that the payment was lawful.',
    'A legally certified instant. A Bitcoin block bounds when a commitment existed; it is not an '
      + 'RFC 3161 timestamp from an accredited authority.',
    'That nothing was withheld. Hash-linked history makes tampering with submitted records '
      + 'evident and says nothing about an event that was never submitted.',
  ]) {
    runs.push({ text: `- ${line}`, ...BODY, spaceBefore: 5 });
  }

  runs.push({ text: 'How to re-check this independently', ...H2, rule: true });
  runs.push({
    text: 'This PDF is a summary. The archive it came from carries the full record: evidence.json '
      + '(the sources), policy.json (the exact rules), matching-results.json (this verdict as '
      + 'data), and where present merkle-proof.json and bitcoin-anchor.json. Re-running the '
      + 'published rules engine over the same evidence and policy reproduces the verdict; running '
      + 'the published verifier over the proof files re-derives the anchoring independently of '
      + 'StoneHash.',
    ...BODY,
  });
  runs.push({
    text: 'Note on language: this summary is rendered with the standard PDF fonts, which cover '
      + 'Latin-1 only. Text supplied in other scripts appears in full in the JSON files inside '
      + 'the archive.',
    ...BODY, spaceBefore: 10,
  });

  return runs;
}
