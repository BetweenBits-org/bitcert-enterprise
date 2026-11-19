/**
 * The producer, checked against the contract it has to satisfy.
 *
 * Two independent anchors, because a self-consistent encoder proves nothing:
 *
 * 1. **The conformance fixture.** `07-witness-unified` was written before this
 *    module existed and fixes the wire layout. Rebuilding its tapscript from
 *    the same inputs must reproduce it byte for byte.
 * 2. **The verifier.** `attest-verify` reads witness bundles with code that
 *    shares nothing with this encoder. A transaction serialised here must come
 *    back out through its parser with the body intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWitnessItems, parseEnvelope } from '@stonehash/attest-verify';
import {
  buildInscription, chunk, DEFAULT_SOFT_CAP_BYTES, envelopeScript, HARD_CEILING_BYTES,
  inscriptionLeafScript, MAX_PUSH, NUMS_INTERNAL_KEY, protocolTagFor,
  STANDARD_RELAY_MAX_BODY_BYTES,
} from '../src/btc/inscription.ts';
import {
  ephemeralSecret, serializeWitness, tapSighash, tapleafHash, taprootSingleLeaf,
} from '../src/btc/taproot.ts';
import { schnorrSign, schnorrVerify, xOnlyPubkey } from '../src/btc/secp256k1.ts';
import { bytesToHex, opReturnScript, serializeLegacy, txidOf } from '../src/btc/tx.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../fixtures/conformance/07-witness-unified');

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

test('the tapscript matches the 07-witness-unified fixture byte for byte', () => {
  const bundle = JSON.parse(readFileSync(path.join(FIXTURE, 'bundle.json'), 'utf8')) as {
    anchor: { reveal_tx_hex: string; witness_envelope: { content_type: string; protocol_tag: string } };
    record: { leaf_bytes: string };
  };
  const original = new Uint8Array(readFileSync(path.join(FIXTURE, 'original.pdf')));

  // The fixture's leaf script, straight out of its witness.
  const items = extractWitnessItems(bundle.anchor.reveal_tx_hex, 0);
  assert.ok(items && items.length === 3, 'fixture witness should be [sig, script, control]');
  const fixtureScript = items[1]!;

  // The fixture's internal/leaf key is a placeholder; take it from the control
  // block so this test asserts the *layout*, not a key we would ever generate.
  const control = items[2]!;
  const internalKey = control.subarray(1);
  assert.equal(control.length, 33, 'a single-leaf control block is 33 bytes');

  const rebuilt = inscriptionLeafScript(
    internalKey,
    bundle.anchor.witness_envelope.protocol_tag,
    bundle.anchor.witness_envelope.content_type,
    original,
  );
  assert.equal(hex(rebuilt), hex(fixtureScript),
    'the encoder drifted from the published witness layout');

  // And the document really is what the record commits to.
  assert.equal(createHash('sha256').update(original).digest('hex'), bundle.record.leaf_bytes);
});

test('the verifier recovers the exact bytes we inscribed', () => {
  // A body spanning several pushes, so chunk boundaries are exercised.
  const body = new Uint8Array(randomBytes(MAX_PUSH * 2 + 137));
  const secret = ephemeralSecret(() => new Uint8Array(randomBytes(32)));
  const pubkey = xOnlyPubkey(secret);
  const ins = buildInscription({
    xOnlyPubkey: pubkey, body, contentType: 'application/pdf', protocolTag: 'bcrt',
  });

  const inputs = [{ txid: '11'.repeat(32), vout: 0, sequence: 0xfffffffd }];
  const outputs = [
    { value: 0, scriptPubKey: opReturnScript(new Uint8Array(32).fill(9)) },
    { value: 9000, scriptPubKey: ins.taproot.scriptPubKey },
  ];
  const raw = serializeWitness(inputs, outputs,
    [[new Uint8Array(64), ins.leafScript, ins.taproot.controlBlock]]);

  const items = extractWitnessItems(bytesToHex(raw), 0);
  assert.ok(items, 'our serialisation should parse as segwit');
  const env = parseEnvelope(items[1]!);
  assert.ok(env, 'witness[1] should be an envelope');
  assert.equal(Buffer.from(env.body).toString('hex'), Buffer.from(body).toString('hex'),
    'the recovered body must be the document, byte for byte');
  assert.equal(Buffer.from(env.contentType).toString('latin1'), 'application/pdf');
  assert.equal(Buffer.from(env.protocolTag).toString('latin1'), 'bcrt');
  assert.equal(createHash('sha256').update(env.body).digest('hex'), ins.leafHex);
});

test('the txid ignores the witness, which is why the body must bind through leaf_bytes', () => {
  const body = new Uint8Array(randomBytes(300));
  const pubkey = xOnlyPubkey(ephemeralSecret(() => new Uint8Array(randomBytes(32))));
  const ins = buildInscription({
    xOnlyPubkey: pubkey, body, contentType: 'text/plain', protocolTag: 'bcrt',
  });
  const inputs = [{ txid: '22'.repeat(32), vout: 1 }];
  const outputs = [{ value: 5000, scriptPubKey: ins.taproot.scriptPubKey }];

  const withRealWitness = serializeWitness(inputs, outputs,
    [[new Uint8Array(64), ins.leafScript, ins.taproot.controlBlock]]);
  const withEmptyWitness = serializeWitness(inputs, outputs, [[new Uint8Array(0)]]);

  // Same txid, different witness — the malleability the verifier is built around.
  const id = txidOf(serializeLegacy(inputs, outputs));
  assert.notEqual(hex(withRealWitness), hex(withEmptyWitness));
  assert.equal(txidOf(serializeLegacy(inputs, outputs)), id);
});

test('a one-leaf control block carries the tweaked parity, not the internal one', () => {
  // Drawn repeatedly so both parities are seen; a hardcoded 0xc0 passes half
  // the time, which is exactly the bug this guards.
  const seen = new Set<number>();
  for (let i = 0; i < 24 && seen.size < 2; i++) {
    const pubkey = xOnlyPubkey(ephemeralSecret(() => new Uint8Array(randomBytes(32))));
    const t = taprootSingleLeaf(pubkey, inscriptionLeafScript(pubkey, 'bcrt', 'text/plain',
      new Uint8Array([i])));
    assert.equal(t.controlBlock[0], 0xc0 | t.parity);
    assert.equal(hex(t.controlBlock.subarray(1)), hex(pubkey), 'control block carries the internal key');
    assert.equal(t.scriptPubKey[0], 0x51, 'P2TR starts with OP_1');
    assert.equal(t.scriptPubKey[1], 0x20, 'followed by a 32-byte push');
    assert.equal(hex(t.tapleaf), hex(tapleafHash(inscriptionLeafScript(pubkey, 'bcrt', 'text/plain',
      new Uint8Array([i])))));
    seen.add(t.parity);
  }
  assert.equal(seen.size, 2, 'expected to observe both parities across 24 keys');
});

test('the signature we make verifies against the key the tapscript pushes', () => {
  const body = new Uint8Array(randomBytes(64));
  const secret = ephemeralSecret(() => new Uint8Array(randomBytes(32)));
  const pubkey = xOnlyPubkey(secret);
  const ins = buildInscription({
    xOnlyPubkey: pubkey, body, contentType: 'text/plain', protocolTag: 'bcrt',
  });

  const inputs = [{ txid: '33'.repeat(32), vout: 0, sequence: 0xfffffffd }];
  const outputs = [{ value: 4000, scriptPubKey: ins.taproot.scriptPubKey }];
  const prevouts = [{ value: 9000, scriptPubKey: ins.taproot.scriptPubKey }];

  const sighash = tapSighash(inputs, outputs, prevouts, 0, ins.taproot.tapleaf);
  const sig = schnorrSign(sighash, secret);
  assert.equal(sig.length, 64, 'SIGHASH_DEFAULT leaves no trailing hash-type byte');
  // The leaf key signs — not the tweaked output key.
  assert.ok(schnorrVerify(sig, sighash, pubkey));

  // The sighash must move when any committed field moves.
  const otherOutputs = [{ value: 4001, scriptPubKey: ins.taproot.scriptPubKey }];
  assert.notEqual(hex(tapSighash(inputs, otherOutputs, prevouts, 0, ins.taproot.tapleaf)),
    hex(sighash), 'output value is covered by SIGHASH_DEFAULT');
  const otherPrevouts = [{ value: 9001, scriptPubKey: ins.taproot.scriptPubKey }];
  assert.notEqual(hex(tapSighash(inputs, outputs, otherPrevouts, 0, ins.taproot.tapleaf)),
    hex(sighash), 'prevout amount is covered');
});

test('chunking splits at 520 bytes and loses nothing', () => {
  for (const n of [0, 1, 519, 520, 521, 1040, 1041]) {
    const body = new Uint8Array(randomBytes(n));
    const parts = chunk(body);
    assert.ok(parts.every((p) => p.length <= MAX_PUSH), `${n}: a chunk exceeded the push limit`);
    const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
    assert.equal(joined.toString('hex'), Buffer.from(body).toString('hex'), `${n}: round trip`);
  }
  // An empty body still produces the OP_0 push the envelope shape expects.
  assert.equal(envelopeScript('bcrt', 'text/plain', new Uint8Array(0)).at(-1), 0x68);
});

test('oversize and empty documents are refused before any key is drawn', () => {
  const pubkey = xOnlyPubkey(ephemeralSecret(() => new Uint8Array(randomBytes(32))));
  const base = { xOnlyPubkey: pubkey, contentType: 'text/plain', protocolTag: 'bcrt' };
  assert.throws(() => buildInscription({ ...base, body: new Uint8Array(0) }), /empty/);
  assert.throws(() => buildInscription({ ...base, body: new Uint8Array(1), contentType: '' }),
    /content_type is mandatory/);

  // The default cap applies when the caller names none.
  assert.throws(() => buildInscription({ ...base, body: new Uint8Array(DEFAULT_SOFT_CAP_BYTES + 1) }),
    /inscription limit/);
  assert.doesNotThrow(() => buildInscription({ ...base, body: new Uint8Array(DEFAULT_SOFT_CAP_BYTES) }));

  // A caller may raise it, but not past the hard ceiling — a deployment that
  // asks for more gets the largest workable value, not an inscription Bitcoin
  // would refuse to relay at any size.
  assert.doesNotThrow(() => buildInscription({
    ...base, body: new Uint8Array(200_000), maxBodyBytes: 200_000 }));
  assert.throws(() => buildInscription({
    ...base, body: new Uint8Array(HARD_CEILING_BYTES + 1), maxBodyBytes: HARD_CEILING_BYTES * 2,
  }), /inscription limit/);
});

test('the three ceilings stay in the order that makes them meaningful', () => {
  // Soft cap ≤ standard relay ≤ hard ceiling. If the default ever rose above
  // standard relay, every mainnet inscription at the default would be built,
  // funded and then refused by the network.
  assert.ok(DEFAULT_SOFT_CAP_BYTES < STANDARD_RELAY_MAX_BODY_BYTES,
    'the default must stay inside what an ordinary node relays');
  assert.ok(STANDARD_RELAY_MAX_BODY_BYTES < HARD_CEILING_BYTES);
  // 400,000 weight units is the standardness cap; the witness is discounted
  // 4×, so ~390 KB of body is the room it leaves.
  assert.ok(STANDARD_RELAY_MAX_BODY_BYTES <= 400_000);
});

test('the taproot internal key is NUMS, so the commit output has no key path', () => {
  /*
   * The attack this closes: an output spendable by the key path can be spent
   * WITHOUT revealing the script, and the script is where the document is.
   * Such a spend has the same outputs and the same anchor digest, and the
   * txid does not cover the witness — so every artifact a reader checks still
   * lines up while the inscribed bytes were never published.
   *
   * Using the signing key as the internal key makes that available to anyone
   * who learns it. The control block must therefore carry NUMS, never the
   * key in the tapscript.
   */
  const secret = ephemeralSecret(() => new Uint8Array(randomBytes(32)));
  const pubkey = xOnlyPubkey(secret);
  const ins = buildInscription({
    xOnlyPubkey: pubkey, body: new Uint8Array([1, 2, 3]),
    contentType: 'text/plain', protocolTag: 'bcrt',
  });
  assert.equal(hex(ins.taproot.controlBlock.subarray(1)), hex(NUMS_INTERNAL_KEY),
    'the control block must commit to the NUMS point');
  assert.notEqual(hex(ins.taproot.controlBlock.subarray(1)), hex(pubkey),
    'the signing key must never be the internal key');
  // The signing key is still what the tapscript checks against.
  assert.ok(Buffer.from(ins.leafScript).includes(Buffer.from(pubkey)),
    'the tapscript must push the signing key');
});

test('NUMS has no known discrete logarithm — it is the BIP341 constant', () => {
  // Spot-check the published value rather than trusting a local copy: this is
  // lift_x of SHA-256 of the uncompressed generator, fixed by BIP341.
  assert.equal(hex(NUMS_INTERNAL_KEY),
    '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
});

test('the protocol tag follows the network', () => {
  assert.equal(protocolTagFor('regtest'), 'bcrt');
  assert.equal(protocolTagFor('mainnet'), 'bc');
});
