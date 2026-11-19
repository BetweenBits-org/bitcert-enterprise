/**
 * From a ledger row to a tree leaf: the two derived values, in one place.
 *
 * A leaf carries the account's hashed reference and a salt. Both are computed
 * on the exchange's machine from things only the exchange holds, and both
 * have to be computed the same way every time a proof is issued, so the
 * derivations are exported rather than left for each integration to retype.
 *
 *   user_ref_hash   SHA-256 over a fixed tag, the exchange id and the
 *                   reference. Deterministic, so a customer who knows their
 *                   own reference can recompute it and recognise their leaf.
 *
 *   salt            HMAC-SHA-256 of the reference under a master seed. Blinds
 *                   the balances inside the leaf hash; because it is derived
 *                   rather than random, the exchange needs to keep one
 *                   32-byte seed per snapshot, not one secret per account.
 *
 * Lose the seed and the leaves file and no proof can be issued for that
 * snapshot again; the anchored root stays valid and becomes uncheckable.
 */
import { createHmac } from 'node:crypto';
import { porUserRefHash } from '@stonehash/attest-verify';
import type { PorBalances } from '@stonehash/attest-verify';
import type { PorLeafInput } from './sumtree.ts';

export { porUserRefHash };

/** The per-account salt: 64 hex characters. `seed` is the snapshot's 32-byte master seed. */
export function deriveSalt(seed: Uint8Array, userRef: string): string {
  if (seed.length !== 32) throw new Error('the master seed must be 32 bytes');
  return createHmac('sha256', seed).update(userRef, 'utf8').digest('hex');
}

/** One ledger row as the tree builder takes it. */
export function leafFromRow(exchangeId: string, seed: Uint8Array, row: { user_ref: string; balances: PorBalances }): PorLeafInput {
  return {
    user_ref: row.user_ref,
    user_ref_hash: porUserRefHash(exchangeId, row.user_ref),
    salt: deriveSalt(seed, row.user_ref),
    balances: row.balances,
  };
}
