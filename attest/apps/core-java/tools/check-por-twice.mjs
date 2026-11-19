/**
 * The same thing sent several times at once, to one service: what the
 * comparison run cannot show, because it asks one question at a time.
 *
 *   node apps/core-java/tools/check-por-twice.mjs --base http://127.0.0.1:8790 [--reference]
 *
 * Needs the seed (parity/seed.json: the exchange of the reserve cases and its
 * key) and a server started on a seeded test schema.
 *
 *   1. One signed statement, root only, eight times at once: one snapshot.
 *      Exactly one answer is "accepted" (201); the others are the same
 *      snapshot again (200, `already: true`); the organisation's list shows
 *      it once. Both services have to do this.
 *   2. The right openings of one challenge, four times at once: the snapshot
 *      is verified once. The Java service settles a challenge once — the
 *      first answer is the answer, the others are told it is settled (409),
 *      as they would be had they come one after the other. The reference
 *      takes every answer that arrived before the first was recorded: the
 *      others fail inside it (500, the record's digest stored twice at once).
 *   3. Wrong openings and the right ones, at once: with the Java service
 *      whichever settles the challenge first is the answer, the snapshot
 *      ends in that state, and no later answer changes it. The reference
 *      takes them all: one caller is told the snapshot is rejected and the
 *      snapshot ends verified.
 *
 * With `--reference` nothing is required of points 2 and 3: what the
 * reference does is printed, for docs/JAVA-INTENDED-DIFFERENCES.md (D-17).
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { buildPorTree, provePorLeaf } from '../../../packages/attest-por/src/sumtree.ts';
import { leafFromRow } from '../../../packages/attest-por/src/leaves.ts';
import { buildSnapshotStatement } from '../../../packages/attest-por/src/snapshot.ts';
import { signEvent } from '../../core/src/remit/sign.ts';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const BASE = arg('--base');
const REFERENCE = process.argv.includes('--reference');
if (!BASE) { console.error('usage: node check-por-twice.mjs --base <url> [--reference]'); process.exit(2); }
const seed = JSON.parse(readFileSync(new URL('../parity/seed.json', import.meta.url), 'utf8')).por;
const EX = seed.institutions.exchange;
const key = createPrivateKey(seed.signing.exchange.pem);
const headers = { 'content-type': 'application/json', authorization: `Bearer ${seed.keys.exchange}` };
const post = async (target, body) => { const r = await fetch(`${BASE}${target}`, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const get = async (target) => { const r = await fetch(`${BASE}${target}`, { headers }); return { status: r.status, body: await r.json() }; };

const rows = Array.from({ length: 6 }, (_, i) => ({ user_ref: `T-${i}`, balances: { BTC: String(1000 * (i + 1)), USDT: String(500 * (6 - i)) } }));
const inputs = rows.map((r) => leafFromRow(EX, new Uint8Array(32).fill(9), r));
const tree = buildPorTree(inputs, ['BTC', 'USDT']);
const proofs = inputs.map((x) => provePorLeaf(tree, tree.index[x.user_ref], { user_ref_hash: x.user_ref_hash, salt: x.salt, balances: x.balances })).sort((a, b) => a.leaf_index - b.leaf_index);
let n = 0;
const statement = () => { const at = new Date(Date.now() + 1000 * n++); return structuredClone(buildSnapshotStatement({ institutionId: EX, name: 'Twice', asof: at.toISOString(), assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'USDT', decimals: 6 }] }, tree, at)); };
const signed = (st, extra = {}) => ({ statement: st, sig: signEvent(st, key, EX, EX), ...extra });
const failures = [];
const need = (ok, what) => { if (!ok) failures.push(what); };
const tally = (answers) => Object.entries(answers.reduce((m, a) => { m[a.status] = (m[a.status] ?? 0) + 1; return m; }, {})).map(([s, c]) => `${c}×${s}`).join(' ');

// 1 — one statement, eight times at once.
{
  const body = signed(statement());
  const answers = await Promise.all(Array.from({ length: 8 }, () => post('/v1/por/snapshots', body)));
  const ids = new Set(answers.map((a) => a.body.snapshot_id));
  const made = answers.filter((a) => a.status === 201).length;
  const again = answers.filter((a) => a.status === 200 && a.body.already === true).length;
  const list = await get('/v1/por/snapshots');
  const listed = list.body.data.filter((s) => ids.has(s.snapshot_id)).length;
  console.log(`one statement eight times at once: ${tally(answers)}; ${ids.size} snapshot id(s); listed ${listed} time(s)`);
  need(made === 1 && again === 7 && ids.size === 1 && listed === 1 && new Set(answers.map((a) => a.body.attestation_id)).size === 1, 'one statement sent eight times at once is not one snapshot');
}
// 2 — the right openings, four times at once.
{
  const c = await post('/v1/por/snapshots', signed(statement(), { spot_check: true }));
  const answers = await Promise.all(Array.from({ length: 4 }, () => post(`/v1/por/snapshots/${c.body.snapshot_id}/openings`, { openings: proofs })));
  const after = await get(`/v1/por/snapshots/${c.body.snapshot_id}`);
  const verified = answers.filter((a) => a.status === 200 && a.body.status === 'VERIFIED');
  const settled = answers.filter((a) => a.status === 409 && a.body.error === 'wrong_state');
  console.log(`the right openings four times at once: ${tally(answers)}; the snapshot is ${after.body.status}; record ids in the answers: ${new Set(verified.map((a) => a.body.attestation_id)).size}`);
  need(after.body.status === 'VERIFIED' && verified.length >= 1 && new Set(verified.map((a) => a.body.attestation_id)).size === 1, 'the right openings at once did not verify the snapshot');
  if (!REFERENCE) need(verified.length === 1 && settled.length === 3, `a challenge was settled ${verified.length} times, and ${settled.length} answers were told so`);
}
// 3 — wrong openings and the right ones, at once, several rounds.
{
  let rejected = 0; let verifiedRounds = 0; let changedAfter = 0;
  for (let round = 0; round < 6; round++) {
    const c = await post('/v1/por/snapshots', signed(statement(), { spot_check: true }));
    const wrong = { openings: proofs.slice(1) };
    const answers = await Promise.all([post(`/v1/por/snapshots/${c.body.snapshot_id}/openings`, wrong), post(`/v1/por/snapshots/${c.body.snapshot_id}/openings`, { openings: proofs }),
      post(`/v1/por/snapshots/${c.body.snapshot_id}/openings`, wrong)]);
    const after = await get(`/v1/por/snapshots/${c.body.snapshot_id}`);
    const settledBy = answers.filter((a) => a.status === 200 || a.status === 422);
    if (after.body.status === 'REJECTED') rejected++; else if (after.body.status === 'VERIFIED') verifiedRounds++;
    // With the Java service exactly one answer settled it, and the state is that answer's.
    if (!REFERENCE) {
      need(settledBy.length === 1 && answers.filter((a) => a.status === 409).length === 2, `round ${round}: ${tally(answers)} — a challenge has to be settled by one answer`);
      need((settledBy[0]?.status === 200) === (after.body.status === 'VERIFIED'), `round ${round}: the snapshot is ${after.body.status} and the answer that settled it was ${settledBy[0]?.status}`);
      need((after.body.attestation === null) === (after.body.status === 'REJECTED'), `round ${round}: a ${after.body.status} snapshot ${after.body.attestation === null ? 'has no record' : 'has a record'}`);
    } else if (settledBy.length > 1) changedAfter++;
  }
  console.log(`wrong and right openings at once, six rounds: ${rejected} ended rejected, ${verifiedRounds} verified${REFERENCE ? `; in ${changedAfter} rounds more than one answer was taken` : '; each settled by exactly one answer'}`);
}
for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length === 0 ? 'as required' : `${failures.length} not as required`);
process.exit(failures.length === 0 ? 0 : 1);
