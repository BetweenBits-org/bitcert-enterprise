/**
 * Writes the vectors the Java SDK's proof-file check (`AnchorProof`) is held
 * to: what the reference verifier — `verifyBundle` of
 * `packages/attest-verify`, read here and never written — answers for a set of
 * proof files, sound and tampered with.
 *
 *   node sdks/attest-remit-java/tools/make-anchor-golden.mjs          write src/test/resources/golden/anchor.json
 *   node sdks/attest-remit-java/tools/make-anchor-golden.mjs --check  fail when the file on disk differs
 *
 * The proof files are the conformance fixtures under `fixtures/conformance`
 * (synthetic, regtest), each as it stands and with one thing changed. Every
 * case is embedded whole, so the Java test needs nothing but the file.
 *
 * For a form of proof file the Java SDK does not re-verify (a witness
 * inscription, a daily row with a chain entry or reconciliation figures, a
 * signed statement) the vector records that the reference verifier does have
 * an answer, and the Java test expects "not supported" — never a pass.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../../packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/conformance');
const OUT = path.resolve(HERE, '../src/test/resources/golden/anchor.json');
const check = process.argv.includes('--check');

const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name, 'bundle.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
/** The hex text with one nibble changed at `at` (counted from the end when negative). */
const flip = (hex, at = 0) => {
  const i = at < 0 ? hex.length + at : at;
  return hex.slice(0, i) + (hex[i] === '0' ? '1' : '0') + hex.slice(i + 1);
};
const change = (bundle, fn) => { const copy = clone(bundle); fn(copy); return copy; };

const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

/**
 * A one-record batch anchored by a transaction with no witness data: one
 * input, one output whose script is `opcode`, then `push` (the bytes that
 * announce the data), then the 53-byte BC01 payload.
 */
function crafted(push, opcode = 0x6a) {
  const leaf = sha256(Buffer.from('a crafted record'));
  const root = sha256(Buffer.from([0x00]), leaf);
  const payload = Buffer.concat([Buffer.from('BC01'), Buffer.from([0x01]), root, Buffer.alloc(16, 0x11)]);
  const script = Buffer.concat([Buffer.from([opcode]), Buffer.from(push), payload]);
  const tx = Buffer.concat([
    Buffer.from('02000000', 'hex'), Buffer.from([0x01]), Buffer.alloc(32, 0x22), Buffer.from('00000000', 'hex'),
    Buffer.from([0x00]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([0x01]), Buffer.alloc(8, 0x00), Buffer.from([script.length]), script,
    Buffer.from('00000000', 'hex'),
  ]);
  return {
    schema: 'bitcert-proof-bundle/v1', bitcoin_network: 'regtest',
    record: { kind: 'attestation', leaf_bytes: leaf.toString('hex') },
    merkle: { leaf_index: 0, root: root.toString('hex'), siblings: [], directions: [] },
    anchor: {
      reveal_txid: Buffer.from(sha256(sha256(tx))).reverse().toString('hex'),
      reveal_tx_hex: tx.toString('hex'),
      op_return_payload_hex: payload.toString('hex'),
    },
  };
}

const plain = load('01-attestation-file');
const cases = [
  ['a proof file as issued', plain],
  ['another one, whose original was tampered with (the file itself is sound)', load('03-tampered-original')],
  ['upper-case hex is the same bytes', change(plain, (b) => {
    b.merkle.root = b.merkle.root.toUpperCase();
    b.anchor.reveal_txid = b.anchor.reveal_txid.toUpperCase();
    b.anchor.op_return_payload_hex = b.anchor.op_return_payload_hex.toUpperCase();
  })],
  ['the record changed', change(plain, (b) => { b.record.leaf_bytes = flip(b.record.leaf_bytes); })],
  ['the stated root changed', change(plain, (b) => { b.merkle.root = flip(b.merkle.root, -1); })],
  ['a sibling changed', change(plain, (b) => { b.merkle.siblings[0] = flip(b.merkle.siblings[0], 5); })],
  ['a sibling on the wrong side', change(plain, (b) => { b.merkle.directions[0] = b.merkle.directions[0] === 'left' ? 'right' : 'left'; })],
  ['a sibling left out', change(plain, (b) => { b.merkle.siblings.pop(); b.merkle.directions.pop(); })],
  ['siblings and directions of different lengths', change(plain, (b) => { b.merkle.directions.pop(); })],
  ['a direction that is neither side', change(plain, (b) => { b.merkle.directions[0] = 'up'; })],
  ['a sibling that is not 32 bytes', change(plain, (b) => { b.merkle.siblings[0] = b.merkle.siblings[0].slice(2); })],
  ['a record that is not 32 bytes', change(plain, (b) => { b.record.leaf_bytes = b.record.leaf_bytes.slice(2); })],
  ['no merkle section', change(plain, (b) => { delete b.merkle; })],
  ['the stated anchor payload commits another root', change(plain, (b) => { b.anchor.op_return_payload_hex = flip(b.anchor.op_return_payload_hex, 20); })],
  ['an anchor payload with no magic', change(plain, (b) => { b.anchor.op_return_payload_hex = `00${b.anchor.op_return_payload_hex.slice(2)}`; })],
  ['an anchor payload cut short', change(plain, (b) => { b.anchor.op_return_payload_hex = b.anchor.op_return_payload_hex.slice(0, -2); })],
  ['the stated txid changed', change(plain, (b) => { b.anchor.reveal_txid = flip(b.anchor.reveal_txid, 3); })],
  ['the raw transaction changed in its last byte', change(plain, (b) => { b.anchor.reveal_tx_hex = flip(b.anchor.reveal_tx_hex, -1); })],
  ['the raw transaction cut short', change(plain, (b) => { b.anchor.reveal_tx_hex = b.anchor.reveal_tx_hex.slice(0, -8); })],
  ['no raw transaction: the txid cannot be bound', change(plain, (b) => { delete b.anchor.reveal_tx_hex; })],
  ['no preimage rule declared', change(plain, (b) => { delete b.record.preimage; })],
  ['a preimage rule nobody knows', change(plain, (b) => { b.record.preimage.scheme = 'sha512-file'; })],
  ['a schema nobody knows', change(plain, (b) => { b.schema = 'bitcert-proof-bundle/v9'; })],
  ['no schema', change(plain, (b) => { delete b.schema; })],
  // A transaction without witness data, and the anchor payload pushed each way a script can push 53 bytes.
  ['a legacy transaction, direct push', crafted([0x35])],
  ['a legacy transaction, OP_PUSHDATA1', crafted([0x4c, 0x35])],
  ['a legacy transaction, OP_PUSHDATA2', crafted([0x4d, 0x35, 0x00])],
  ['a legacy transaction, OP_PUSHDATA4', crafted([0x4e, 0x35, 0x00, 0x00, 0x00])],
  // A push whose declared length has its top bit set carries nothing: the payload is not in that output.
  ['a push with an impossible length', crafted([0x4e, 0x35, 0x00, 0x00, 0x80])],
  ['a push that declares more than the script holds', crafted([0x4c, 0x40])],
  ['an output that is not OP_RETURN', crafted([0x35], 0x51)],
  // Forms of proof file the Java SDK does not re-verify. It must say so, and not pass them.
  ['a daily balance row', load('02-daily-balance'), 'another form'],
  ['a daily row with its day root', load('06-daily-day-root'), 'another form'],
  ['an original inscribed in the witness', load('07-witness-unified'), 'another form'],
];

const out = cases.map(([name, bundle, form]) => {
  let expected;
  try {
    const report = verifyBundle(bundle, {});
    expected = { verified: report.verified, checks: report.checks.map((c) => `${c.id}:${c.state}`) };
  } catch (e) {
    // The reference verifier gives up on a file it cannot walk; whoever calls it reports that as a failure.
    expected = { verified: false, threw: true };
  }
  return { name, java: form ? 'unsupported' : 'same', bundle, expected };
});

const text = `${JSON.stringify({ note: 'Generated by tools/make-anchor-golden.mjs from the reference verifier. Do not edit by hand.', cases: out }, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('anchor.json differs from what the reference verifier answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`anchor.json is current (${out.length} cases)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${out.length} cases`);
  for (const c of out) console.log(`  ${c.expected.verified ? 'verified' : 'not     '}  ${c.name}  ${c.expected.threw ? '(threw)' : c.expected.checks.join(' ')}`);
}
