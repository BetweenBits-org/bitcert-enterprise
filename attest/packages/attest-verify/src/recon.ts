/**
 * Daily reconciliation commitment and `day_root` — bundle-schema.md §6 (v2).
 *
 * For a v2 daily bundle the anchor output does not commit the bare Merkle root;
 * it commits a `day_root` that binds the customer-balance root **and** the
 * (a)/(b)/(c) trust reconciliation. That means the on-chain commitment covers
 * the solvency figures, not just the liability list.
 *
 * Byte-identical to the producer's derivation. Each step is domain-tagged and
 * JCS-canonicalised, and asset rows are sorted by symbol — all three
 * implementations (Rust producer, Python verifier, this one) must agree exactly.
 *
 * Scope limit worth keeping in view: the (a) reserve side is supplied by the
 * exchange. Anchoring makes the figures tamper-evident; it does not
 * independently measure the reserves.
 */
import { sha256 } from './sha256.ts';
import { bytesToHex, concat, hexToBytes, utf8 } from './bytes.ts';
import { jcs } from './jcs.ts';

const RECON_ASSETS_DOMAIN = /* @__PURE__ */ utf8('attest:daily:recon-assets\n');
const RECON_DOMAIN = /* @__PURE__ */ utf8('attest:daily:recon\n');
const DAY_ROOT_DOMAIN = /* @__PURE__ */ utf8('attest:daily:anchor\n');

export interface ReconAsset {
  asset: string;
  ok: boolean;
  residual: string;
  scale: number;
  trust_actual: string;
  trust_required: string;
}

export interface ReconciliationSection {
  reconciliation_ok: boolean;
  assets: ReconAsset[];
}

function assetRow(a: ReconAsset): Uint8Array {
  return jcs({
    asset: a.asset,
    ok: a.ok ? 1 : 0,
    residual: a.residual,
    scale: Number(a.scale),
    trust_actual: a.trust_actual,
    trust_required: a.trust_required,
  });
}

/** `SHA-256("attest:daily:recon-assets\n" || Σ assetRow)`, rows sorted by symbol. */
export function assetsHash(assets: ReconAsset[]): Uint8Array {
  const sorted = [...assets].sort((x, y) => (x.asset < y.asset ? -1 : x.asset > y.asset ? 1 : 0));
  return sha256(concat(RECON_ASSETS_DOMAIN, ...sorted.map(assetRow)));
}

/** `SHA-256("attest:daily:recon\n" || JCS{assets_hash, business_date, exchange_id, reconciliation_ok})`. */
export function reconCommitment(
  exchangeId: string,
  businessDate: string,
  reconciliationOk: boolean,
  assets: ReconAsset[],
): Uint8Array {
  return sha256(concat(RECON_DOMAIN, jcs({
    assets_hash: bytesToHex(assetsHash(assets)),
    business_date: businessDate,
    exchange_id: exchangeId,
    reconciliation_ok: reconciliationOk ? 1 : 0,
  })));
}

/** `SHA-256("attest:daily:anchor\n" || JCS{balances_root, business_date, exchange_id, recon_commitment})`. */
export function dayRoot(
  exchangeId: string,
  businessDate: string,
  balancesRootHex: string,
  reconCommit: Uint8Array,
): string {
  return bytesToHex(sha256(concat(DAY_ROOT_DOMAIN, jcs({
    balances_root: balancesRootHex,
    business_date: businessDate,
    exchange_id: exchangeId,
    recon_commitment: bytesToHex(reconCommit),
  }))));
}

/** `SHA-256(salt || utf8(account_id))` — lets a customer reproduce their own commitment. */
export function deriveUserCommitment(saltHex: string, accountId: string): string {
  return bytesToHex(sha256(concat(hexToBytes(saltHex), utf8(accountId))));
}
