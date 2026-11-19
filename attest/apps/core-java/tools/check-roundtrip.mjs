/**
 * The agreement test, verifier half: every bundle the Java producer wrote
 * (RoundTripProducerTest → target/roundtrip/) is handed to the published
 * TypeScript verifier, which shares no code with the producer.
 *
 *   node apps/core-java/tools/check-roundtrip.mjs
 *
 * Required of each bundle: verified, links A, B and C1 pass, link C2 is
 * skipped (no chain is involved, and a verifier must say so), the network is
 * the one the producer wrote. And of each tampered variant: it fails, in the
 * link that was tampered with, while the links that still hold still pass.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../../packages/attest-verify/src/index.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../target/roundtrip');
const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const failures = [];
const states = (r) => r.checks.map((c) => `${c.state} ${c.id}`).join(' | ');
const expect = (ok, what) => { if (!ok) failures.push(what); };
let tampered = 0;
for (const entry of manifest.bundles) {
  const bundle = JSON.parse(readFileSync(path.join(DIR, entry.bundle), 'utf8'));
  const original = new Uint8Array(Buffer.from(entry.original, 'base64'));
  const r = verifyBundle(bundle, { originalBytes: original });
  expect(r.verified === true && r.links.A === 'pass' && r.links.B === 'pass' && r.links.C1 === 'pass' && r.links.C2 === 'skip' && r.network === entry.network,
    `${entry.bundle}: ${states(r)} (network ${r.network})`);

  // Another document: link A fails, the anchor is still perfectly good.
  const other = verifyBundle(bundle, { originalBytes: new Uint8Array(Buffer.from('another document')) });
  expect(other.verified === false && other.links.A === 'fail' && other.links.B === 'pass' && other.links.C1 === 'pass', `${entry.bundle} with another document: ${states(other)}`);
  // One bit of the root: the path no longer leads to it.
  const root = structuredClone(bundle);
  root.merkle.root = (root.merkle.root[0] === '0' ? '1' : '0') + root.merkle.root.slice(1);
  const badRoot = verifyBundle(root, { originalBytes: original });
  expect(badRoot.verified === false && badRoot.links.B === 'fail', `${entry.bundle} with a changed root: ${states(badRoot)}`);
  // One byte of the payload: it is no longer what the transaction carries.
  const payload = structuredClone(bundle);
  payload.anchor.op_return_payload_hex = payload.anchor.op_return_payload_hex.slice(0, -2) + (payload.anchor.op_return_payload_hex.endsWith('00') ? '01' : '00');
  const badPayload = verifyBundle(payload, { originalBytes: original });
  expect(badPayload.verified === false, `${entry.bundle} with a changed payload: ${states(badPayload)}`);
  // Another transaction id: the bytes do not hash to it.
  const txid = structuredClone(bundle);
  txid.anchor.reveal_txid = 'ee'.repeat(32);
  const badTxid = verifyBundle(txid, { originalBytes: original });
  expect(badTxid.verified === false && badTxid.links.C1 === 'fail', `${entry.bundle} with another txid: ${states(badTxid)}`);
  tampered += 4;
}
// A proof moved onto another record of the same batch: same root, wrong path.
const a = JSON.parse(readFileSync(path.join(DIR, 'batch-3-doc-0.json'), 'utf8'));
const b = JSON.parse(readFileSync(path.join(DIR, 'batch-3-doc-1.json'), 'utf8'));
const forged = structuredClone(b); forged.merkle = a.merkle;
const moved = verifyBundle(forged, {});
expect(moved.verified === false && moved.links.B === 'fail', `a proof moved onto another record: ${states(moved)}`);

// ── signed anchors: the leaf is the hash of a statement, and the statement names the document ──────────────────
// The file a reader holds is checked against what the statement names: its own document passes, another document
// fails (and the anchor is still as good as ever), and with no document nothing is said about one.
const ANOTHER = new Uint8Array(Buffer.from('another document'));
const check = (r, id) => r.checks.find((c) => c.id === id);
let held = 0;
for (const entry of manifest.signed ?? []) {
  const bundle = JSON.parse(readFileSync(path.join(DIR, entry.bundle), 'utf8'));
  const original = new Uint8Array(Buffer.from(entry.original, 'base64'));
  expect(bundle.record.preimage.scheme === 'sha256-signed-statement/v1' && bundle.record.preimage.statement.issuer.algorithm === entry.algorithm, `${entry.bundle}: not a signed anchor of ${entry.algorithm}`);
  const own = verifyBundle(structuredClone(bundle), { originalBytes: original });
  expect(own.verified === true && own.links.A === 'pass' && own.links.B === 'pass' && own.links.C1 === 'pass' && own.links.C2 === 'skip' && check(own, 'preimage')?.detail?.documentOk === true,
    `${entry.bundle} with its own document: ${states(own)}`);
  const other = verifyBundle(structuredClone(bundle), { originalBytes: ANOTHER });
  expect(other.verified === false && other.links.A === 'fail' && other.links.B === 'pass' && other.links.C1 === 'pass'
    && check(other, 'preimage')?.state === 'fail' && check(other, 'preimage')?.detail?.selfOk === true && check(other, 'preimage')?.detail?.documentOk === false,
  `${entry.bundle} with another document: ${states(other)}`);
  const none = verifyBundle(structuredClone(bundle));
  expect(none.verified === true && none.links.A === 'skip' && none.links.B === 'pass' && none.links.C1 === 'pass'
    && check(none, 'preimage')?.state === 'warn' && check(none, 'preimage')?.gating === false && check(none, 'preimage')?.detail?.selfOk === true,
  `${entry.bundle} with no document: ${states(none)}`);
  // One character of what was signed: the statement is no longer the one that was anchored, with the document or without.
  const edited = structuredClone(bundle);
  edited.record.preimage.statement.issued_at = '2026-11-18T06:00:00.001Z';
  for (const input of [{ originalBytes: original }, {}]) {
    const r = verifyBundle(structuredClone(edited), input);
    expect(r.verified === false && r.links.A === 'fail' && r.links.B === 'pass' && r.links.C1 === 'pass', `${entry.bundle} with an edited statement: ${states(r)}`);
  }
  const root = structuredClone(bundle);
  root.merkle.root = (root.merkle.root[0] === '0' ? '1' : '0') + root.merkle.root.slice(1);
  const badRoot = verifyBundle(root, { originalBytes: original });
  expect(badRoot.verified === false && badRoot.links.B === 'fail' && badRoot.links.A === 'pass', `${entry.bundle} with a changed root: ${states(badRoot)}`);
  const txid = structuredClone(bundle);
  txid.anchor.reveal_txid = 'ee'.repeat(32);
  const badTxid = verifyBundle(txid, { originalBytes: original });
  expect(badTxid.verified === false && badTxid.links.C1 === 'fail', `${entry.bundle} with another txid: ${states(badTxid)}`);
  held += 7;
}

// ── inscriptions: the document rides in the transaction ────────────────────────────────────────────────────────
// The bundle verifies by itself. A file given beside it has to be that document.
for (const entry of manifest.inscribed ?? []) {
  const bundle = JSON.parse(readFileSync(path.join(DIR, entry.bundle), 'utf8'));
  const original = new Uint8Array(Buffer.from(entry.original, 'base64'));
  const alone = verifyBundle(structuredClone(bundle));
  expect(alone.witnessMode === true && alone.verified === true && alone.links.A === 'pass' && alone.links.B === 'skip' && alone.links.C1 === 'pass' && alone.links.C2 === 'skip'
    && check(alone, 'witness-original')?.detail?.bodyBytes === original.length && check(alone, 'supplied-original') === undefined, `${entry.bundle} by itself: ${states(alone)}`);
  const own = verifyBundle(structuredClone(bundle), { originalBytes: original });
  expect(own.verified === true && own.links.A === 'pass' && own.links.C1 === 'pass' && check(own, 'supplied-original')?.state === 'pass', `${entry.bundle} with its own document: ${states(own)}`);
  const other = verifyBundle(structuredClone(bundle), { originalBytes: ANOTHER });
  expect(other.verified === false && other.links.A === 'fail' && other.links.B === 'skip' && other.links.C1 === 'pass'
    && check(other, 'supplied-original')?.state === 'fail' && check(other, 'witness-original')?.state === 'pass', `${entry.bundle} with another document: ${states(other)}`);
  // One byte of the document inside the witness: the transaction id does not cover the witness, the anchored digest does.
  // (A document of a few bytes is not looked for: its bytes can as well be found in the part the transaction id covers.)
  const at = original.length < 8 ? -1 : bundle.anchor.reveal_tx_hex.indexOf(Buffer.from(original.subarray(0, 8)).toString('hex'));
  expect(at > 0 || original.length < 8, `${entry.bundle}: the document is not where the witness should hold it`);
  if (at > 0) {
    const flipped = structuredClone(bundle);
    const hex = flipped.anchor.reveal_tx_hex;
    flipped.anchor.reveal_tx_hex = hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
    for (const input of [{}, { originalBytes: original }]) {
      const r = verifyBundle(structuredClone(flipped), input);
      expect(r.verified === false && r.links.A === 'fail' && r.links.C1 === 'pass', `${entry.bundle} with a byte of the witness changed: ${states(r)}`);
    }
  }
  const txid = structuredClone(bundle);
  txid.anchor.reveal_txid = 'ee'.repeat(32);
  const badTxid = verifyBundle(txid, {});
  expect(badTxid.verified === false && badTxid.links.C1 === 'fail', `${entry.bundle} with another txid: ${states(badTxid)}`);
  const leaf = structuredClone(bundle);
  leaf.record.leaf_bytes = 'ee'.repeat(32);
  const badLeaf = verifyBundle(leaf, {});
  expect(badLeaf.verified === false && badLeaf.links.A === 'fail', `${entry.bundle} with another leaf: ${states(badLeaf)}`);
  held += at > 0 ? 7 : 5;
}

for (const f of failures.slice(0, 20)) console.error(`FAIL ${f}`);
console.log(`${manifest.bundles.length} bundles from the Java producer under the TypeScript verifier, ${tampered + 1} tampered variants: ${failures.length === 0 ? 'all as required' : `${failures.length} not as required`}`);
console.log(`${(manifest.signed ?? []).length} signed anchors and ${(manifest.inscribed ?? []).length} inscriptions from the Java producer, ${held} readings with their own document, another one and none: ${failures.length === 0 ? 'all as required' : 'see above'}`);
process.exit(failures.length === 0 ? 0 : 1);
