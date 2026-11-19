/**
 * Per-organisation chain continuity — bundle-schema.md §5 (link D).
 *
 * Each settlement writes an append-only entry whose `prev_entry_hash` points at
 * the previous entry's `payload_hash`. Walking the links makes a removed or
 * reordered day detectable: you cannot drop an entry without breaking the chain.
 *
 * What it does NOT do: prove that an entry which was never submitted does not
 * exist. Hash-linking makes tampering with *submitted* history evident; it says
 * nothing about events that were never recorded.
 */
import { sha256 } from './sha256.ts';
import { bytesToHex, concat, utf8 } from './bytes.ts';
import { jcs } from './jcs.ts';
import type { JcsValue } from './jcs.ts';

const CHAIN_DOMAIN = /* @__PURE__ */ utf8('bitcert:chain:v1\n');

export interface ChainEntry {
  exchange_id: string;
  seq: number;
  kind: string;
  prev_entry_hash: string;
  body_hash: string;
  business_date: string;
  payload_hash?: string;
}

/** The six fields the payload hash commits to, canonicalised and domain-tagged. */
function entryCore(e: ChainEntry): JcsValue {
  return {
    body_hash: e.body_hash,
    business_date: e.business_date,
    exchange_id: e.exchange_id,
    kind: e.kind,
    prev_entry_hash: e.prev_entry_hash,
    seq: e.seq,
  };
}

/** `SHA-256("bitcert:chain:v1\n" || JCS(core fields))`. */
export function payloadHash(e: ChainEntry): string {
  return bytesToHex(sha256(concat(CHAIN_DOMAIN, jcs(entryCore(e)))));
}

export interface ChainWalkResult {
  ok: boolean;
  detail: string;
}

/**
 * Walk prior entries (ascending `seq`) and confirm each one recomputes its own
 * `payload_hash` and hash-links to the next. The head entry's own
 * `payload_hash` is checked by the caller, so it is only used here as the
 * final link target.
 */
export function verifyChainLinks(links: ChainEntry[] | undefined, head: ChainEntry): ChainWalkResult {
  if (!links || links.length === 0) return { ok: true, detail: '' };
  const chain = [...links, head];
  let prevPh: string | null = null;
  for (const e of chain) {
    const ph = payloadHash(e);
    if (e !== head) {
      if (ph !== String(e.payload_hash ?? '').toLowerCase()) {
        return { ok: false, detail: `link seq ${e.seq}: payload_hash does not recompute` };
      }
    }
    if (prevPh !== null && String(e.prev_entry_hash ?? '').toLowerCase() !== prevPh) {
      return { ok: false, detail: `link seq ${e.seq}: prev_entry_hash does not match payload_hash(seq ${e.seq - 1})` };
    }
    prevPh = ph;
  }
  const n = links.length;
  return { ok: true, detail: `walked ${n} prior ${n === 1 ? 'entry' : 'entries'} + head: hash-linkage holds` };
}
