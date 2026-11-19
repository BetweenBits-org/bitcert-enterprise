/**
 * Link C2 — the one claim neither the verifier nor arithmetic can settle.
 *
 * Its own module, with no DOM in it, so the rule below is reachable from a
 * test. The rule is small and the cost of getting it backwards is not: a
 * mainnet proof that showed a green C2 nobody actually checked would be the
 * exact misrepresentation this product exists to make impossible.
 */
import type { CheckState, ProofBundle, VerifyReport } from './vendor/attest-verify/index.ts';

/**
 * Link C2, performed by the caller — the one step the verifier refuses to take.
 *
 * `verifyBundle` always returns C2 = `skip`. It contacts nothing, so it cannot
 * know whether a txid ever reached a block, and a verifier that guessed would
 * be worse than one that abstains. The format's answer is that the **caller**
 * consults a Bitcoin source and merges the verdict in. This is that merge.
 *
 * Which source exists depends on the chain, and the two cases are not the same
 * claim:
 *
 * - **mainnet** — an independent source exists, so C2 stays unchecked here on
 *   purpose. A tick this page drew for itself would prove nothing; the reader
 *   asks their own node or an explorer, which is the entire exercise.
 * - **a private chain** — there is nobody independent to ask, because
 *   StoneHash mines the blocks. Inclusion is then a fact only the chain's
 *   operator can state, and the bundle states it: block height and block hash.
 *   Reporting `pass` is accurate about what the chain did, and leaving it at
 *   NOT CHECKED was inaccurate in the other direction — the transaction is in
 *   a block. It is attributed to the operator on screen, because the distance
 *   between "in a block" and "in a block nobody can quietly rewrite" is the
 *   whole product.
 *
 * Done here rather than in `attest-verify` so the published verifier keeps
 * abstaining for every other caller: an SDK that green-ticked C2 off a field
 * the producer wrote would hand anyone a regtest proof that audits clean.
 */
export function withChainInclusion(r: VerifyReport, bundle: ProofBundle): VerifyReport {
  const c = bundle.anchor?.confirmed;
  if (r.network === 'mainnet' || !c?.block_hash || typeof c.block_height !== 'number') return r;

  const checks = r.checks.map((chk) => (chk.id === 'onchain'
    ? {
      ...chk,
      state: 'pass' as CheckState,
      label: `On-chain confirmation — ${r.network} 블록 ${c.block_height} 에 포함`,
      detail: {
        block_height: c.block_height,
        block_hash: c.block_hash,
        confirmations: c.confirmations ?? 1,
        attested_by: `${r.network} 운영자(StoneHash) — 제3자 아님`,
      },
    }
    : chk));

  return { ...r, checks, links: { ...r.links, C2: 'pass' } };
}
