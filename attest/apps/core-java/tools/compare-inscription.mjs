/**
 * Two runs of tools/check-inscription.mjs — one through the reference
 * service (`--reference`), one through the Java service — side by side.
 *
 *   node apps/core-java/tools/compare-inscription.mjs <reference result.json> <java result.json>
 *
 * Everything a client or a verifier sees must be the same: the first answer,
 * the bundle before and after the block, the verifier's links, the size and
 * the fee of the reveal, and what a refusal by the node is answered with.
 *
 * What differs is what docs/JAVA-INTENDED-DIFFERENCES.md lists as D-08, and
 * it is required exactly, not tolerated: the reference's batcher sweeps an
 * inscription into a batch a moment after it was made, the Java service does
 * not. So, on the reference side and not on the Java side: the status goes
 * back to `batched` and comes forward again; `batch_id` and `leaf_index` are
 * set and a batch, a proof and one more transaction exist; `bundle_available`
 * is false until then. One more thing follows from the same sweep: the
 * reference then confirms the record through its batch and never records the
 * block of the inscription itself, so its row has no block and its bundle
 * says `confirmed` with no block in it. (Unless a block from elsewhere on
 * the shared chain happened to arrive before the sweep — both are accepted
 * of the reference, and the count is printed.) The Java service always
 * records the block.
 */
import fs from 'node:fs';

const [refFile, javaFile] = process.argv.slice(2);
if (!refFile || !javaFile) { console.error('usage: node compare-inscription.mjs <reference result.json> <java result.json>'); process.exit(2); }
const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
const java = JSON.parse(fs.readFileSync(javaFile, 'utf8'));
if (ref.reference !== true || java.reference !== false) { console.error('the first file must be a run with --reference, the second a run without'); process.exit(2); }

const unexpected = [];
const same = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) unexpected.push(`${what}:\n    reference ${JSON.stringify(a)}\n    java      ${JSON.stringify(b)}`); };
const exactly = (what, ok, found) => { if (!ok) unexpected.push(`${what}: ${JSON.stringify(found)}`); };
const R = ref.summary; const J = java.summary;

same('a refusal by the node', R.refusal, J.refusal);
same('the documents', R.documents.map((d) => [d.name, d.bytes, d.pushes, d.contentTypeSent]), J.documents.map((d) => [d.name, d.bytes, d.pushes, d.contentTypeSent]));
same('bundles that verify', [R.verified, R.readBack], [J.verified, J.readBack]);

const BLOCK = 'confirmed:{block_height:number,block_hash:hex64,confirmations:number}';
let refWithBlock = 0; let sawBatched = 0;
for (const [i, r] of R.documents.entries()) {
  const j = J.documents[i];
  if (!j) break;
  const n = r.name;
  // The same on both sides.
  same(`${n}: the first answer, but for bundle_available`, { ...r.first, bundle_available: null }, { ...j.first, bundle_available: null });
  same(`${n}: the bundle before the block`, r.early, j.early);
  same(`${n}: the verifier's links`, r.links, j.links);
  same(`${n}: the reveal's size and fee`, [r.revealVsize, r.revealFee], [j.revealVsize, j.revealFee]);

  // D-08, on the Java side: forward only, no batch, a bundle from the start, the block recorded.
  exactly(`${n}: the Java status history`, j.statusTrail.join(' → ') === 'submitted → confirmed', j.statusTrail);
  exactly(`${n}: the Java record and a batch`, j.batchTrail.join() === 'no batch' && j.last.batch_id === null && j.last.leaf_index === null, [j.batchTrail, j.last]);
  exactly(`${n}: the Java bundle_available`, j.first.bundle_available === true && j.availableTrail.join() === 'true', { first: j.first.bundle_available, then: j.availableTrail });
  exactly(`${n}: the Java record of the block`, j.confirmedKeys === 'block_height,block_hash,confirmations' && j.blockAgrees === true && j.rowHasItsBlock === true, [j.confirmedKeys, j.blockAgrees, j.rowHasItsBlock]);

  // D-08, on the reference side: swept into a batch.
  exactly(`${n}: the reference status history`, r.statusTrail[0] === 'submitted' && r.statusTrail.at(-1) === 'confirmed' && r.statusTrail.every((s) => ['submitted', 'batched', 'confirmed'].includes(s)), r.statusTrail);
  sawBatched += r.statusTrail.includes('batched') ? 1 : 0;
  exactly(`${n}: the reference record and a batch`, r.batchTrail.join(' → ') === 'no batch → in a batch' && r.last.batch_id === 'uuid' && r.last.leaf_index === 'number', [r.batchTrail, r.last]);
  exactly(`${n}: the reference bundle_available`, r.first.bundle_available === false && r.availableTrail.join(' → ') === 'false → true', { first: r.first.bundle_available, then: r.availableTrail });
  const withBlock = r.confirmedKeys === 'block_height,block_hash,confirmations' && r.blockAgrees === true && r.rowHasItsBlock === true;
  const withoutBlock = r.confirmedKeys === 'confirmations' && r.blockAgrees === false && r.rowHasItsBlock === false;
  exactly(`${n}: the reference record of the block`, withBlock || withoutBlock, [r.confirmedKeys, r.blockAgrees, r.rowHasItsBlock]);
  refWithBlock += withBlock ? 1 : 0;

  // And with exactly those fields set aside, nothing else differs: the last answer, the bundle, the row.
  same(`${n}: the last answer, but for the batch fields`, r.last.shape.replace('batch_id:uuid', 'batch_id:null').replace('leaf_index:number', 'leaf_index:null'), j.last.shape);
  same(`${n}: the bundle, but for the block of the confirmation`, withBlock ? r.bundle : r.bundle.replace('confirmed:{confirmations:number}', BLOCK), j.bundle);
  same(`${n}: the row, but for the batch fields and the block`,
    r.row.replace('batch_id:text', 'batch_id:null').replace('leaf_index:number', 'leaf_index:null').replace('block_height:null block_hash:null', withBlock ? 'block_height:null block_hash:null' : 'block_height:number block_hash:text'), j.row);
}
exactly('the Java service made no batch, proof or further transaction', J.rows.batchesMade === 0 && J.rows.proofs === 0 && J.rows.batchAnchors === 0 && java.cost.fees.batchAnchors === 0, J.rows);
exactly('the reference made a batch, a proof and a transaction for what it swept',
  R.rows.batchesMade >= 1 && R.rows.proofs === R.documents.length && R.rows.batchAnchors === R.rows.batchesMade && ref.cost.fees.batchAnchors > 0, R.rows);

for (const u of unexpected) console.log(`DIFF  ${u}`);
const n = R.documents.length;
console.log(`${ref.schema} / ${java.schema}: ${n} documents each — the same first answer, bundle before and after the block, verifier links, reveal size and fee, and refusal by the node; `
  + `different as D-08 says: the reference swept ${n} of ${n} into ${R.rows.batchesMade} batch${R.rows.batchesMade === 1 ? '' : 'es'} (status ${[...new Set(R.documents.map((d) => d.statusTrail.join(' → ')))].join(' | ')}; `
  + `batch_id and leaf_index set; ${R.rows.batchAnchors} more transaction${R.rows.batchAnchors === 1 ? '' : 's'}, ${ref.cost.fees.batchAnchors} sat), said bundle_available false until then, `
  + `and recorded the block of the confirmation for ${refWithBlock} of ${n}; the Java service: ${[...new Set(J.documents.map((d) => d.statusTrail.join(' → ')))].join(' | ')}, no batch, `
  + `bundle_available true from the first answer, the block recorded for ${J.documents.filter((d) => d.rowHasItsBlock).length} of ${n}; fees ${ref.cost.total} sat against ${java.cost.total} — `
  + `${unexpected.length === 0 ? 'nothing else differs' : `${unexpected.length} thing(s) not as expected`}`);
process.exit(unexpected.length === 0 ? 0 : 1);
