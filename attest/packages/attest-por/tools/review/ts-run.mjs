/**
 * The reference, checked against an implementation written from SPEC.md alone.
 *
 * `pytree.py` builds the same trees with nothing but hashlib; this script
 * builds every case with the SDK in both tree formats and writes what the
 * two can be compared on — root, totals, every level's hashes, leaf order
 * and proofs. From this directory:
 *
 *   work=$(mktemp -d)
 *   python3 gen_cases.py 400 > "$work/cases.jsonl"
 *   node ts-run.mjs "$work" && python3 compare.py "$work"
 *
 * `compare.py` must report `"mismatches": 0`.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { buildPorTree, provePorLeaf, leafFromRow } from '../../src/index.ts';
import { verifyPorInclusion } from '@stonehash/attest-verify';
const work = process.argv[2];
if (!work) { console.error('usage: node ts-run.mjs <work dir holding cases.jsonl>'); process.exit(1); }
const out = createWriteStream(path.join(work, 'ts-out.jsonl'));
let n = 0, proofs = 0, bad = [];
for await (const line of createInterface({ input: createReadStream(path.join(work, 'cases.jsonl')), crlfDelay: Infinity })) {
  if (!line) continue;
  const c = JSON.parse(line);
  const seed = Buffer.from(c.seed_hex, 'hex');
  const res = { id: c.id };
  for (const [name, algo] of [['v1', 'merkle-sum-sha256-v1'], ['v2', 'merkle-sum-sha256-v2']]) {
    try {
      const leaves = c.rows.map((r) => leafFromRow(c.exchange_id, seed, r));
      const tree = buildPorTree(leaves, c.assets, { algo });
      const sorted = [...leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
      const picked = (c.prove ?? [0]).filter((i) => i < sorted.length).map((i) => {
        const proof = provePorLeaf(tree, i, sorted[i]);
        const ok = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals }).ok;
        proofs++;
        if (!ok) bad.push([c.id, name, i]);
        // The lookup a customer's proof is issued by.
        const at = tree.index[sorted[i].user_ref];
        if (at !== i) bad.push([c.id, name, 'index lookup', sorted[i].user_ref, String(at)]);
        return proof;
      });
      res[name] = { root: tree.root, totals: tree.totals, levels: tree.levels.map((l) => l.map((x) => x.hash)), order: sorted.map((l) => l.user_ref), proofs: picked };
    } catch (e) { res[name] = { error: String(e.message ?? e) }; }
  }
  out.write(JSON.stringify(res) + '\n');
  n++;
}
out.end();
await new Promise((ok) => out.on('finish', ok));
console.log(JSON.stringify({ cases: n, proofs, ts_side_failures: bad.slice(0, 10), failures: bad.length }));
