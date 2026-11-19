/**
 * The verification driver — bundle-schema.md, producer-independent.
 *
 * ## Why this returns data instead of printing
 *
 * The reference CLI prints a human report and exits 0/1. That is right for a
 * terminal and wrong for everything else we need. The product rule is that a
 * single green tick is never allowed: integrity, issuer, anchor and rules are
 * separate claims and must be shown separately, and "not checked" must never
 * render as success. So the driver emits a [`VerifyReport`] — an ordered list of
 * checks plus an explicit per-link verdict — and leaves rendering to the caller.
 *
 * ## The four links
 *
 * ```text
 *  original ──(A: preimage)──▶ leaf_bytes ──(B: merkle)──▶ root ──(C: anchor)──▶ Bitcoin
 * ```
 *
 * `A`, `B` and `C1` are pure mathematics: they are fully verifiable offline, with
 * no network and no trust in StoneHash. `C2` — "that txid really is in the
 * blockchain" — is the one step that needs a Bitcoin source, and it is
 * deliberately NOT performed here. This function never opens a socket. The
 * caller fetches confirmation from a source **it** chooses (its own node, a
 * public explorer) and merges the outcome. Until then `C2` stays `skip`, which is
 * an honest "unverified", not a pass.
 *
 * On a private chain (`regtest`) `C2` can never be anything but `skip` for a
 * third party. `report.network` surfaces that, and the schema makes it
 * unforgeable: `bitcoin_network` is a required field, so a regtest bundle
 * announces itself as regtest to every verifier that reads it.
 */
import { bytesToHex, hexEq, latin1 } from './bytes.ts';
import { sha256 } from './sha256.ts';
import { verifyInclusion } from './merkle.ts';
import type { MerkleSection } from './merkle.ts';
import { decodeAnchorPayload, txidFromRaw } from './anchor.ts';
import { extractWitnessItems, parseEnvelope } from './witness.ts';
import { payloadHash, verifyChainLinks } from './chain.ts';
import type { ChainEntry } from './chain.ts';
import { dayRoot, reconCommitment } from './recon.ts';
import type { ReconciliationSection } from './recon.ts';
import { verifyPreimage } from './preimage.ts';
import type { PreimageInput, PreimageSection } from './preimage.ts';

export const SUPPORTED_SCHEMAS = ['bitcert-proof-bundle/v1', 'bitcert-proof-bundle/v2'] as const;

/**
 * `pass` / `fail` are cryptographic verdicts. `skip` means a check was not
 * performed (missing input, or offline) and `warn` means performed but
 * inconclusive. Neither `skip` nor `warn` may be rendered as success.
 */
export type CheckState = 'pass' | 'fail' | 'skip' | 'warn';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  /** `true` when this check's failure flips `verified` to false. */
  gating: boolean;
  detail?: Record<string, unknown>;
}

/** Per-link verdict — the honest-reporting surface. See the module docstring. */
export interface LinkVerdicts {
  /** original → leaf_bytes */
  A: CheckState;
  /** leaf_bytes → merkle root */
  B: CheckState;
  /** anchor payload ↔ txid, offline */
  C1: CheckState;
  /** txid is in a public block — never performed here */
  C2: CheckState;
}

export interface VerifyReport {
  schema: string | null;
  /** `mainnet` | `testnet` | `signet` | `regtest` — straight from the bundle. */
  network: string | null;
  /** Conjunction of every gating check. Not a substitute for reading `links`. */
  verified: boolean;
  /** `true` for a witness-inscribed bundle (original recovered from the chain). */
  witnessMode: boolean;
  checks: Check[];
  links: LinkVerdicts;
  /** Recomputed txid, present once link C1 ran. */
  txid?: string;
  /** Informational: the (a)/(b)/(c) figures a v2 day_root commits to. */
  reconciliation?: ReconciliationSection;
}

interface AnchorSection {
  reveal_txid?: string;
  commit_txid?: string;
  reveal_tx_hex?: string;
  op_return_payload_hex: string;
  confirmed?: { block_height?: number; block_hash?: string; confirmations?: number };
  witness_envelope?: { input_index?: number };
}

interface RecordSection {
  kind?: string;
  leaf_bytes: string;
  preimage?: PreimageSection;
  descriptor?: Record<string, unknown>;
}

export interface ProofBundle {
  schema?: string;
  bitcoin_network?: string;
  generated_at?: string;
  record: RecordSection;
  merkle?: MerkleSection;
  anchor: AnchorSection;
  chain?: { entry?: ChainEntry; links?: ChainEntry[] };
  reconciliation?: ReconciliationSection;
}

class Report {
  readonly checks: Check[] = [];
  readonly links: LinkVerdicts = { A: 'skip', B: 'skip', C1: 'skip', C2: 'skip' };
  private ok = true;

  add(id: string, label: string, state: CheckState, gating: boolean, detail?: Record<string, unknown>): void {
    this.checks.push(detail ? { id, label, state, gating, detail } : { id, label, state, gating });
    if (gating && state === 'fail') this.ok = false;
  }
  get verified(): boolean { return this.ok; }
  bust(): void { this.ok = false; }
}

/**
 * Verify a proof bundle. Pure and offline: no network, no clock, no filesystem.
 *
 * `input.originalBytes` binds link A: for `sha256-file` the original must hash
 * to `leaf_bytes`; for a signed anchor (`sha256-signed-statement/v1`) it must
 * hash to the digest the signed statement names; for a witness bundle it must
 * be the document recovered from the transaction. `input.accountId` +
 * `input.saltHex` bind a customer's identity to a daily balance row. All are
 * optional — without them the corresponding checks report `skip`/`warn`, never
 * `pass`: a reader is never told their document matched when nobody looked at
 * it. And an original that was supplied and is not the anchored document
 * always fails link A, whatever else in the bundle holds.
 */
export function verifyBundle(bundle: ProofBundle, input: PreimageInput = {}): VerifyReport {
  const r = new Report();
  const schema = bundle.schema ?? null;
  const network = bundle.bitcoin_network ?? null;

  if (!schema || !(SUPPORTED_SCHEMAS as readonly string[]).includes(schema)) {
    r.add('schema', 'Unsupported bundle schema', 'fail', true,
      { expected: SUPPORTED_SCHEMAS, got: schema });
    return { schema, network, verified: false, witnessMode: false, checks: r.checks, links: r.links };
  }
  r.add('schema', `Schema ${schema} · network ${network ?? '?'}`, 'pass', false,
    { schema, network });

  return bundle.anchor?.witness_envelope
    ? verifyWitness(bundle, r, schema, network, input)
    : verifyStandard(bundle, r, schema, network, input);
}

/** Standard path: the original is supplied off-bundle (or not at all). */
function verifyStandard(
  bundle: ProofBundle, r: Report, schema: string, network: string | null, input: PreimageInput,
): VerifyReport {
  // ── Link A — original → leaf_bytes (§2.1) ────────────────────────────────
  try {
    const pre = verifyPreimage(bundle.record.leaf_bytes, bundle.record.preimage, input);
    if (pre === null) {
      r.add('preimage', 'Original binding — bundle declares no preimage rule', 'skip', false,
        { note: 'proves a 32-byte digest is anchored, not that it is your document' });
      r.links.A = 'skip';
    } else if (pre.status === 'need_original') {
      r.add('preimage', 'Original binding — supply the original file to bind it', 'warn', false,
        { scheme: pre.scheme });
      r.links.A = 'skip';
    } else if (pre.scheme === 'sha256-signed-statement/v1') {
      // Two halves, and they fail differently. The statement must hash to leaf_bytes — that
      // is checked from the bundle alone. The original must be the document the statement
      // names — that needs the file, and without it nothing is said about the document.
      const detail = { scheme: pre.scheme, computed: pre.computed, selfOk: pre.selfOk,
        documentOk: pre.documentOk, documentDigest: pre.documentDigest };
      if (pre.selfOk !== true) {
        r.add('preimage', 'Original binding — the signed statement does NOT hash to leaf_bytes', 'fail', true, detail);
        r.links.A = 'fail';
      } else if (pre.documentOk === undefined) {
        r.add('preimage', 'Original binding — the signed statement hashes to leaf_bytes; '
          + 'supply the original file to bind it to the statement', 'warn', false, detail);
        r.links.A = 'skip';
      } else {
        const ok = pre.documentOk === true;
        r.add('preimage',
          ok ? 'Original binding — original is the document the signed statement names'
             : 'Original binding — original is NOT the document the signed statement names',
          ok ? 'pass' : 'fail', true, detail);
        r.links.A = ok ? 'pass' : 'fail';
      }
    } else {
      const ok = pre.selfOk === true && pre.identityOk !== false;
      r.add('preimage',
        pre.scheme === 'sha256-file'
          ? 'Original binding — original hashes to leaf_bytes'
          : 'Original binding — leaf_bytes = hash(declared fields)',
        ok ? 'pass' : 'fail', true,
        { scheme: pre.scheme, computed: pre.computed, selfOk: pre.selfOk, identityOk: pre.identityOk });
      r.links.A = ok ? 'pass' : 'fail';
    }
  } catch (e) {
    r.add('preimage', 'Original binding — error', 'fail', true, { error: msg(e) });
    r.links.A = 'fail';
  }

  // ── Link B — merkle inclusion (§3) ───────────────────────────────────────
  let merkleRoot: string | null = null;
  try {
    if (!bundle.merkle) throw new Error('bundle has no merkle section');
    const res = verifyInclusion(bundle.record.leaf_bytes, bundle.merkle);
    merkleRoot = String(bundle.merkle.root ?? '').toLowerCase();
    r.add('merkle', res.ok ? 'Merkle inclusion — record is in the root'
                           : 'Merkle inclusion — record is NOT in the root',
      res.ok ? 'pass' : 'fail', true,
      { computedRoot: res.computedRoot, claimedRoot: merkleRoot });
    r.links.B = res.ok ? 'pass' : 'fail';
  } catch (e) {
    r.add('merkle', 'Merkle inclusion — error', 'fail', true, { error: msg(e) });
    r.links.B = 'fail';
  }

  // ── Anchor commitment (§4.1) — v2 commits day_root, v1 the bare root ─────
  const recon = bundle.reconciliation;
  let expectedDayRoot: string | null = null;
  try {
    const decoded = decodeAnchorPayload(bundle.anchor.op_return_payload_hex);
    if (!decoded) throw new Error('anchor payload has no BC01/BC30 magic');
    const anchored = decoded.merkleRoot;
    let ok: boolean;
    if (recon) {
      const ce = bundle.chain?.entry;
      const rc = reconCommitment(
        ce?.exchange_id ?? '', ce?.business_date ?? '', recon.reconciliation_ok, recon.assets ?? []);
      expectedDayRoot = dayRoot(ce?.exchange_id ?? '', ce?.business_date ?? '', merkleRoot ?? '', rc);
      ok = merkleRoot !== null && hexEq(expectedDayRoot, anchored);
      r.add('anchor-commitment',
        ok ? `Anchor commitment — day_root is committed on-chain (${decoded.format})`
           : `Anchor commitment — day_root is NOT committed on-chain (${decoded.format})`,
        ok ? 'pass' : 'fail', true,
        { format: decoded.format, onChain: anchored, recomputedDayRoot: expectedDayRoot });
    } else {
      ok = merkleRoot !== null && hexEq(anchored, merkleRoot);
      r.add('anchor-commitment',
        ok ? `Anchor commitment — Merkle root is committed on-chain (${decoded.format})`
           : `Anchor commitment — Merkle root is NOT committed on-chain (${decoded.format})`,
        ok ? 'pass' : 'fail', true,
        { format: decoded.format, onChain: anchored, batchId: decoded.batchId });
    }
  } catch (e) {
    r.add('anchor-commitment', 'Anchor commitment — error', 'fail', true, { error: msg(e) });
  }

  // ── Link C1 — offline txid binding (§4.2) ────────────────────────────────
  let txid = bundle.anchor.reveal_txid;
  if (bundle.anchor.reveal_tx_hex) {
    try {
      const b = txidFromRaw(bundle.anchor.reveal_tx_hex);
      const txidOk = hexEq(b.txid, bundle.anchor.reveal_txid);
      const opOk = hexEq(b.anchorPayloadHex, bundle.anchor.op_return_payload_hex);
      const ok = txidOk && opOk;
      r.add('txid-binding',
        ok ? 'Transaction binding — anchor payload belongs to this txid'
           : 'Transaction binding — anchor payload does NOT match this txid',
        ok ? 'pass' : 'fail', true,
        { computedTxid: b.txid, bundleTxid: bundle.anchor.reveal_txid, txidOk, payloadOk: opOk });
      r.links.C1 = ok ? 'pass' : 'fail';
      txid = b.txid;
    } catch (e) {
      r.add('txid-binding', 'Transaction binding — error', 'fail', true, { error: msg(e) });
      r.links.C1 = 'fail';
    }
  } else {
    r.add('txid-binding', 'Transaction binding — skipped (bundle carries no reveal_tx_hex)', 'warn', false,
      { note: 'the stated txid cannot be bound to the anchor bytes; trust level reduced' });
    r.links.C1 = 'skip';
  }

  // ── Chain continuity (§5) ────────────────────────────────────────────────
  const entry = bundle.chain?.entry;
  if (entry) {
    try {
      const ph = payloadHash(entry);
      const phOk = hexEq(ph, entry.payload_hash);
      // A daily entry's body_hash must carry the anchored root: day_root for v2,
      // bare Merkle root for v1.
      let bodyOk: boolean;
      let committedLabel: string;
      if (entry.kind !== 'daily') { bodyOk = true; committedLabel = 'n/a'; }
      else if (expectedDayRoot !== null) {
        bodyOk = hexEq(entry.body_hash, expectedDayRoot); committedLabel = 'day_root';
      } else {
        bodyOk = merkleRoot !== null && hexEq(entry.body_hash, merkleRoot); committedLabel = 'merkle root';
      }
      const walk = verifyChainLinks(bundle.chain?.links, entry);
      const ok = phOk && bodyOk && walk.ok;
      r.add('chain-entry',
        ok ? 'Chain entry — payload_hash recomputes and linkage holds'
           : 'Chain entry — continuity broken',
        ok ? 'pass' : 'fail', true,
        { seq: entry.seq, kind: entry.kind, recomputedPayloadHash: ph, payloadHashOk: phOk,
          bodyHashOk: bodyOk, commits: committedLabel, walk: walk.detail || undefined });
    } catch (e) {
      r.add('chain-entry', 'Chain entry — error', 'fail', true, { error: msg(e) });
    }
  }

  // ── On-chain confirmation (§4.3) — never performed in-process ────────────
  r.add('onchain', 'On-chain confirmation — NOT CHECKED (no Bitcoin source consulted)', 'skip', false,
    { txid, note: 'confirm via a Bitcoin source you choose; never via StoneHash' });
  r.links.C2 = 'skip';

  const out: VerifyReport = {
    schema, network, verified: r.verified, witnessMode: false, checks: r.checks, links: r.links,
  };
  if (txid) out.txid = txid;
  if (recon) out.reconciliation = recon;
  return out;
}

/**
 * Witness path: the original rides in the reveal witness, so no off-bundle file
 * is needed. Two modes, selected by decoding the anchor payload (§4.4):
 * a recognised BC magic ⇒ unified (bind through the Merkle proof); a raw
 * 32-byte payload ⇒ legacy (the payload *is* `leaf_bytes`).
 */
function verifyWitness(
  bundle: ProofBundle, r: Report, schema: string, network: string | null, input: PreimageInput = {},
): VerifyReport {
  const leaf = bundle.record.leaf_bytes.toLowerCase();
  const raw = bundle.anchor.reveal_tx_hex;

  if (!raw) {
    r.add('txid-binding', 'Transaction binding — a witness bundle requires reveal_tx_hex', 'fail', true);
    r.links.C1 = 'fail';
    return { schema, network, verified: false, witnessMode: true, checks: r.checks, links: r.links };
  }

  // ── Link C1 ──────────────────────────────────────────────────────────────
  let txid: string | undefined;
  let anchorPayloadHex: string | null = null;
  try {
    const b = txidFromRaw(raw);
    txid = b.txid;
    anchorPayloadHex = b.anchorPayloadHex;
    const ok = hexEq(b.txid, bundle.anchor.reveal_txid)
      && hexEq(b.anchorPayloadHex, bundle.anchor.op_return_payload_hex);
    r.add('txid-binding',
      ok ? 'Transaction binding — anchor payload belongs to this txid'
         : 'Transaction binding — anchor payload does NOT match this txid',
      ok ? 'pass' : 'fail', true,
      { computedTxid: b.txid, bundleTxid: bundle.anchor.reveal_txid });
    r.links.C1 = ok ? 'pass' : 'fail';
  } catch (e) {
    r.add('txid-binding', 'Transaction binding — error', 'fail', true, { error: msg(e) });
    r.links.C1 = 'fail';
    return { schema, network, verified: false, witnessMode: true, checks: r.checks, links: r.links };
  }

  // ── On-chain commitment: legacy (direct) or unified (via Merkle) ──────────
  let decoded: ReturnType<typeof decodeAnchorPayload> = null;
  try { decoded = decodeAnchorPayload(bundle.anchor.op_return_payload_hex); } catch { decoded = null; }

  if (decoded === null) {
    const ok = hexEq(anchorPayloadHex, leaf);
    r.add('anchor-commitment',
      ok ? 'On-chain commitment — anchor payload equals leaf_bytes (legacy witness)'
         : 'On-chain commitment — anchor payload does NOT equal leaf_bytes (legacy witness)',
      ok ? 'pass' : 'fail', true, { mode: 'legacy', onChain: anchorPayloadHex });
    r.links.B = 'skip'; // no tree in legacy mode — the payload commits the leaf directly
  } else {
    try {
      if (!bundle.merkle) throw new Error('unified witness mode requires a merkle section');
      const res = verifyInclusion(bundle.record.leaf_bytes, bundle.merkle);
      const ok = res.ok && hexEq(res.computedRoot, decoded.merkleRoot);
      r.add('anchor-commitment',
        ok ? `On-chain commitment — record binds to the anchored Merkle root (${decoded.format})`
           : `On-chain commitment — record does NOT bind to the anchored root (${decoded.format})`,
        ok ? 'pass' : 'fail', true,
        { mode: 'unified', format: decoded.format,
          recomputedRoot: res.computedRoot, onChainRoot: decoded.merkleRoot });
      r.links.B = ok ? 'pass' : 'fail';
    } catch (e) {
      r.add('anchor-commitment', 'On-chain commitment — error', 'fail', true, { error: msg(e) });
      r.links.B = 'fail';
    }
  }

  // ── Link A — recover the original from the witness and bind it ────────────
  // The witness is NOT committed by the txid, so the recovered bytes are only
  // meaningful once they hash to leaf_bytes (which IS txid-committed above).
  try {
    const items = extractWitnessItems(raw, Number(bundle.anchor.witness_envelope?.input_index ?? 0));
    if (!items || items.length < 2) {
      throw new Error('input has no script-path witness ([sig, script, control])');
    }
    const env = parseEnvelope(items[1]!);
    if (!env) throw new Error('witness[1] is not an OP_FALSE OP_IF inscription envelope');
    const bodyHash = bytesToHex(sha256(env.body));
    const bound = bodyHash === leaf;
    r.add('witness-original',
      bound ? 'Witness original — bytes recovered from Bitcoin bind to leaf_bytes'
            : 'Witness original — recovered bytes do NOT bind to leaf_bytes',
      bound ? 'pass' : 'fail', true,
      { bodyBytes: env.body.length, bodyHash,
        contentType: latin1(env.contentType), protocolTag: latin1(env.protocolTag) });
    r.links.A = bound ? 'pass' : 'fail';
    // A file the reader holds is a separate claim from "the transaction carries a document":
    // if one was supplied, it has to BE that document. Compared with what was recovered from
    // the transaction, so that a different file is never reported as verified.
    if (input.originalBytes) {
      const suppliedHash = bytesToHex(sha256(input.originalBytes));
      const same = suppliedHash === bodyHash;
      r.add('supplied-original',
        same ? 'Supplied original — is the document inscribed in the transaction'
             : 'Supplied original — is NOT the document inscribed in the transaction',
        same ? 'pass' : 'fail', true, { suppliedHash, inscribedHash: bodyHash });
      if (!same) r.links.A = 'fail';
    }
  } catch (e) {
    r.add('witness-original', 'Witness original — error', 'fail', true, { error: msg(e) });
    r.links.A = 'fail';
  }

  r.add('onchain', 'On-chain confirmation — NOT CHECKED (no Bitcoin source consulted)', 'skip', false,
    { txid });
  r.links.C2 = 'skip';

  const out: VerifyReport = {
    schema, network, verified: r.verified, witnessMode: true, checks: r.checks, links: r.links,
  };
  if (txid) out.txid = txid;
  return out;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
