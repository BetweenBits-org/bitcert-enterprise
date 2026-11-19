/**
 * Vectors that hold the Java core's Bitcoin code for inscriptions — secp256k1
 * and BIP340, taproot, the inscription envelope, the reveal transaction — to
 * the code it replaces (`apps/core/src/btc/{secp256k1,taproot,inscription,tx}.ts`)
 * and to BIP340's own published vectors.
 *
 *   node apps/core-java/tools/make-btc-vectors.mjs          write src/test/resources/vectors/btc.json
 *   node apps/core-java/tools/make-btc-vectors.mjs --check  fail when the file on disk differs
 *
 * Nothing here is random at run time: keys, messages and documents come from
 * a fixed seed and signatures are made with stated auxiliary randomness, so
 * every run writes the same file. Large byte strings are stored as their
 * length and SHA-256; the Java test builds the same bytes and compares those.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  G, N, bigintTo32, bytesToBigint, hasEvenY, liftX, pointAdd, pointMul, schnorrSign, schnorrVerify, taggedHash, xOnly, xOnlyPubkey,
} from '../../core/src/btc/secp256k1.ts';
import {
  ephemeralSecret, pushData, serializeWitness, tapSighash, tapleafHash, taprootSingleLeaf, wtxidOf,
} from '../../core/src/btc/taproot.ts';
import {
  MAX_PUSH, NUMS_INTERNAL_KEY, buildInscription, chunk, envelopeScript, inscriptionLeafScript, protocolTagFor,
} from '../../core/src/btc/inscription.ts';
import { opReturnScript, serializeLegacy, txidOf } from '../../core/src/btc/tx.ts';
import { extractWitnessItems, parseEnvelope } from '../../../packages/attest-verify/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/btc.json');
const FIXTURE = path.resolve(HERE, '../../../fixtures/conformance/07-witness-unified');
const TAMPERED = path.resolve(HERE, '../../../fixtures/conformance/08-tampered-witness');
const check = process.argv.includes('--check');

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const big = (v) => v.toString(16).padStart(64, '0');
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const refusal = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message }; } };
const point = (p) => (p === null ? null : { x: big(p.x), y: big(p.y) });

// A fixed seed: the same "random" bytes on every run.
let seed = 0x6d2b79f5;
const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const random = (n) => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = next() & 0xff; return out; };
/** The document of a given size that both sides can build: byte i is (i·31 + size) mod 256. */
const documentOf = (size) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + size) & 0xff);

// ── curve ───────────────────────────────────────────────────────────────────

const scalars = [0n, 1n, 2n, 3n, 5n, N - 1n, N, N + 1n, N + 7n, 2n ** 255n, 2n ** 256n - 1n, ...Array.from({ length: 24 }, () => bytesToBigint(random(32)))];
const multiples = scalars.map((k) => ({ k: k.toString(16), point: point(pointMul(k)) }));
const sums = [];
for (const [a, b] of [[1n, 1n], [1n, 2n], [2n, N - 2n], [5n, N - 5n], [7n, 7n], [N - 1n, 1n], [N - 1n, N - 1n], [0n, 9n], [9n, 0n], [0n, 0n],
  ...Array.from({ length: 12 }, () => [bytesToBigint(random(32)), bytesToBigint(random(32))])]) {
  sums.push({ a: a.toString(16), b: b.toString(16), sum: point(pointAdd(pointMul(a), pointMul(b))) });
}
const mixed = Array.from({ length: 8 }, () => {
  const k = bytesToBigint(random(32)); const base = bytesToBigint(random(32));
  return { k: k.toString(16), base: base.toString(16), point: point(pointMul(k, pointMul(base))) };
});
const lifts = [0n, 1n, 2n, 3n, 4n, P - 1n, P, P + 1n, 2n ** 256n - 1n, G.x,
  0xEEFDEA4CD0B44C0C96D7A5EB4C1F8C8D0C0C7B4C77A52D43E4A1BE1DF4A3C1B2n, 0xDFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659n,
  ...Array.from({ length: 30 }, () => bytesToBigint(random(32)))].map((x) => {
  const p = liftX(x);
  return { x: x.toString(16), point: point(p), evenY: p === null ? null : hasEvenY(p) };
});
const tagged = [];
for (const tag of ['TapLeaf', 'TapTweak', 'TapSighash', 'BIP0340/aux', 'BIP0340/nonce', 'BIP0340/challenge', '', 'a tag with spaces and é']) {
  for (const parts of [[], [new Uint8Array(0)], [new Uint8Array([0])], [random(32)], [random(1), random(64), random(5)]]) {
    tagged.push({ tag, parts: parts.map(hex), hash: hex(taggedHash(tag, ...parts)) });
  }
}

// ── BIP340 ──────────────────────────────────────────────────────────────────

/** index, secret, pubkey, aux, message, signature — the signing vectors of BIP340 itself. */
const OFFICIAL = [
  ['0000000000000000000000000000000000000000000000000000000000000003', 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    '0000000000000000000000000000000000000000000000000000000000000000', '0000000000000000000000000000000000000000000000000000000000000000',
    'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0'],
  ['B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF', 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    '0000000000000000000000000000000000000000000000000000000000000001', '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A'],
  ['C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9', 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906', '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7'],
  ['0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710', '25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517',
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    '7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3'],
].map(([secret, pubkey, aux, msg, sig]) => ({ secret: secret.toLowerCase(), pubkey: pubkey.toLowerCase(), aux: aux.toLowerCase(), msg: msg.toLowerCase(), sig: sig.toLowerCase() }));
for (const [i, v] of OFFICIAL.entries()) {
  if (hex(xOnlyPubkey(bytes(v.secret))) !== v.pubkey || hex(schnorrSign(bytes(v.msg), bytes(v.secret), bytes(v.aux))) !== v.sig) {
    throw new Error(`the reference does not reproduce BIP340 vector ${i} — the vector was copied wrongly, or the reference is broken`);
  }
}
const GOOD = OFFICIAL[1];
const FIELD_P = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';
const ORDER_N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
const flip = (h, at) => h.slice(0, at) + ((parseInt(h[at], 16) ^ 1).toString(16)) + h.slice(at + 1);
const verifications = [
  ...OFFICIAL.map((v, i) => ({ name: `official vector ${i}`, sig: v.sig, msg: v.msg, pubkey: v.pubkey })),
  { name: 'official vector 4 (a signature made elsewhere)',
    sig: '00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c6376afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4',
    msg: '4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703', pubkey: 'd69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9' },
  { name: 'a public key that is not on the curve', sig: GOOD.sig, msg: GOOD.msg, pubkey: 'eefdea4cd0b44c0c96d7a5eb4c1f8c8d0c0c7b4c77a52d43e4a1be1df4a3c1b2' },
  { name: 'r equal to the field prime', sig: FIELD_P + GOOD.sig.slice(64), msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 's equal to the group order', sig: GOOD.sig.slice(0, 64) + ORDER_N, msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'a signature one byte short', sig: GOOD.sig.slice(0, 126), msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'a signature one byte long', sig: `${GOOD.sig}00`, msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'a public key one byte short', sig: GOOD.sig, msg: GOOD.msg, pubkey: GOOD.pubkey.slice(0, 62) },
  { name: 'a public key of zero', sig: GOOD.sig, msg: GOOD.msg, pubkey: '00'.repeat(32) },
  { name: 'a public key equal to the field prime', sig: GOOD.sig, msg: GOOD.msg, pubkey: FIELD_P },
  { name: 'one bit of the message changed', sig: GOOD.sig, msg: flip(GOOD.msg, 63), pubkey: GOOD.pubkey },
  { name: 'one bit of r changed', sig: flip(GOOD.sig, 10), msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'one bit of s changed', sig: flip(GOOD.sig, 100), msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'the signature of another key', sig: OFFICIAL[2].sig, msg: OFFICIAL[2].msg, pubkey: GOOD.pubkey },
  { name: 'a signature of zeros', sig: '00'.repeat(64), msg: GOOD.msg, pubkey: GOOD.pubkey },
  { name: 'an empty message under a signature for another', sig: GOOD.sig, msg: '', pubkey: GOOD.pubkey },
].map((c) => ({ ...c, ok: schnorrVerify(bytes(c.sig), bytes(c.msg), bytes(c.pubkey)) }));
const signings = [];
for (const length of [0, 1, 31, 32, 33, 64, 100, 1000]) {
  for (let i = 0; i < 3; i++) {
    const secret = ephemeralSecret(() => random(32)); const msg = random(length); const aux = i === 0 ? new Uint8Array(32) : random(32);
    const sig = schnorrSign(msg, secret, aux);
    if (!schnorrVerify(sig, msg, xOnlyPubkey(secret))) throw new Error('the reference does not verify its own signature');
    signings.push({ secret: hex(secret), msg: hex(msg), aux: hex(aux), pubkey: hex(xOnlyPubkey(secret)), sig: hex(sig) });
  }
}
const secrets = ['00'.repeat(32), `${'00'.repeat(31)}01`, big(N - 1n), big(N), big(N + 1n), 'ff'.repeat(32), '', '01', `${'00'.repeat(32)}01`, hex(random(32))].map((secret) => {
  const r = refusal(() => hex(xOnlyPubkey(bytes(secret))));
  return { secret, pubkey: r.value ?? null, error: r.error ?? null };
});
const ephemeral = [
  [big(N), big(5n)], ['00'.repeat(32), big(N + 3n), 'ff'.repeat(32), big(N - 1n)], [`${'00'.repeat(31)}09`], Array.from({ length: 64 }, () => 'ff'.repeat(32)),
  [...Array.from({ length: 63 }, () => '00'.repeat(32)), big(2n)],
].map((draws) => {
  let at = 0;
  const r = refusal(() => hex(ephemeralSecret(() => bytes(draws[at++]))));
  return { draws, secret: r.value ?? null, error: r.error ?? null, drawn: at };
});

// ── taproot ─────────────────────────────────────────────────────────────────

const pushes = [0, 1, 2, 74, 75, 76, 77, 254, 255, 256, 257, 519, 520, 521, 65534, 65535, 65536, 70000].map((size) => {
  const r = refusal(() => pushData(documentOf(size)));
  return { size, length: r.value?.length ?? null, head: r.value ? hex(r.value.subarray(0, Math.min(4, r.value.length))) : null, sha256: r.value ? sha(r.value) : null, error: r.error ?? null };
});
const leaves = [0, 1, 34, 252, 253, 254, 600, 65535, 65536, 70000].map((size) => ({ size, tapleaf: hex(tapleafHash(documentOf(size))) }));
const outputs = [];
const parities = new Set();
for (let i = 0; i < 28; i++) {
  const internal = i === 0 ? NUMS_INTERNAL_KEY : i < 20 ? xOnlyPubkey(ephemeralSecret(() => random(32))) : random(32);
  const script = documentOf(20 + i * 7);
  const r = refusal(() => taprootSingleLeaf(internal, script));
  if (r.value) parities.add(r.value.parity);
  outputs.push({ internal: hex(internal), scriptSize: script.length,
    output: r.value ? { outputKey: hex(r.value.outputKey), parity: r.value.parity, scriptPubKey: hex(r.value.scriptPubKey), controlBlock: hex(r.value.controlBlock), tapleaf: hex(r.value.tapleaf) } : null,
    error: r.error ?? null });
}
outputs.push({ internal: 'aa'.repeat(31), scriptSize: 10, output: null, error: refusal(() => taprootSingleLeaf(bytes('aa'.repeat(31)), documentOf(10))).error });
if (parities.size !== 2) throw new Error('the taproot cases do not show both parities');
if (!outputs.some((o) => o.error === 'internal key is not on the curve')) throw new Error('no taproot case has an internal key off the curve');

const txid = (i) => hex(createHash('sha256').update(`prev ${i}`).digest());
const P2TR = (fill) => `5120${fill.repeat(32)}`;
const sighashCases = [
  { inputs: [{ txid: txid(0), vout: 0, sequence: 0xfffffffd }], outputs: [{ value: 0, script: hex(opReturnScript(new Uint8Array(32).fill(9))) }, { value: 1000, script: P2TR('ab') }],
    prevouts: [{ value: 9000, script: P2TR('cd') }], inputIndex: 0, tapleaf: hex(random(32)) },
  { inputs: [{ txid: txid(1), vout: 1 }], outputs: [{ value: 4000, script: P2TR('11') }], prevouts: [{ value: 9000, script: P2TR('22') }], inputIndex: 0, tapleaf: hex(random(32)) },
  { inputs: [{ txid: txid(2), vout: 0 }, { txid: txid(3), vout: 4294967295, sequence: 0 }], outputs: [{ value: 2100000000000000, script: P2TR('33') }, { value: 4294967296, script: '' }],
    prevouts: [{ value: 4294967297, script: P2TR('44') }, { value: 1, script: '0014' + '55'.repeat(20) }], inputIndex: 1, tapleaf: hex(random(32)), version: 1, locktime: 500000 },
  { inputs: [{ txid: txid(4), vout: 7, sequence: 0xfffffffd }], outputs: [], prevouts: [{ value: 546, script: P2TR('66') }], inputIndex: 0, tapleaf: hex(random(32)), version: 2, locktime: 4294967295 },
  { inputs: [{ txid: txid(5), vout: 0 }], outputs: [{ value: 1, script: '51' }], prevouts: [], inputIndex: 0, tapleaf: hex(random(32)) },
].map((c) => {
  const r = refusal(() => hex(tapSighash(
    c.inputs.map((i) => ({ txid: i.txid, vout: i.vout, ...(i.sequence !== undefined ? { sequence: i.sequence } : {}) })),
    c.outputs.map((o) => ({ value: o.value, scriptPubKey: bytes(o.script) })),
    c.prevouts.map((p) => ({ value: p.value, scriptPubKey: bytes(p.script) })), c.inputIndex, bytes(c.tapleaf), c.version ?? 2, c.locktime ?? 0)));
  return { ...c, sighash: r.value ?? null, error: r.error ?? null };
});

// ── the envelope ────────────────────────────────────────────────────────────

const TYPES = ['text/plain', 'application/pdf', 'application/octet-stream', 'text/plain; charset=utf-8; name=문서', `x/${'t'.repeat(300)}`];
const envelopes = [];
for (const size of [0, 1, 75, 76, 255, 256, 519, 520, 521, 1039, 1040, 1041, 1560, 3000, 5000, 100000]) {
  for (const [i, contentType] of TYPES.entries()) {
    if (size > 1041 && i > 1) continue;
    const tag = i % 2 === 0 ? 'bcrt' : 'bc';
    const script = envelopeScript(tag, contentType, documentOf(size));
    envelopes.push({ size, tag, contentType, chunks: chunk(documentOf(size)).map((c) => c.length).filter((n, at, all) => at < 2 || at === all.length - 1),
      chunkCount: chunk(documentOf(size)).length, length: script.length, sha256: sha(script), hex: script.length <= 200 ? hex(script) : null });
  }
}
const leafKey = xOnlyPubkey(ephemeralSecret(() => random(32)));
const leafScripts = [1, 520, 521, 4000].map((size) => {
  const s = inscriptionLeafScript(leafKey, 'bcrt', 'application/pdf', documentOf(size));
  return { pubkey: hex(leafKey), size, length: s.length, sha256: sha(s) };
});
leafScripts.push({ pubkey: 'aa'.repeat(31), size: 1, length: null, sha256: null, error: refusal(() => inscriptionLeafScript(bytes('aa'.repeat(31)), 'bcrt', 'text/plain', documentOf(1))).error });
const builds = [
  { size: 3, contentType: 'text/plain', tag: 'bcrt' }, { size: 700, contentType: 'application/pdf', tag: 'bc' }, { size: 0, contentType: 'text/plain', tag: 'bcrt' },
  { size: 1, contentType: '', tag: 'bcrt' }, { size: 1, contentType: 'x'.repeat(520), tag: 'bcrt' }, { size: 1, contentType: 'x'.repeat(521), tag: 'bcrt' },
  { size: 1, contentType: '문'.repeat(520), tag: 'bcrt' }, { size: 1, contentType: 'text/plain', tag: 't'.repeat(521) }, { size: 0, contentType: '', tag: 'bcrt' },
  { size: 1, contentType: 'é'.repeat(260), tag: 'bcrt' }, { size: 1, contentType: 'é'.repeat(261), tag: 'bcrt' }, { size: 1, contentType: 'text/plain', tag: '문'.repeat(174) },
  { size: 1, contentType: `${'x'.repeat(516)}😀`, tag: 'bcrt' }, { size: 1, contentType: `${'x'.repeat(517)}😀`, tag: 'bcrt' }, { size: 1, contentType: `${'x'.repeat(519)}😀`, tag: 'bcrt' },
  { size: 100000, contentType: 'text/plain', tag: 'bcrt' }, { size: 100001, contentType: 'text/plain', tag: 'bcrt' },
  { size: 100001, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 100001 }, { size: 5001, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 5000 },
  { size: 5000, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 5000 }, { size: 2, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 1 },
  { size: 3500001, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 9000000 }, { size: 1, contentType: 'text/plain', tag: 'bcrt', maxBodyBytes: 0 },
].map((c) => {
  const r = refusal(() => buildInscription({ xOnlyPubkey: leafKey, body: documentOf(c.size), contentType: c.contentType, protocolTag: c.tag,
    ...(c.maxBodyBytes !== undefined ? { maxBodyBytes: c.maxBodyBytes } : {}) }));
  const v = r.value;
  // The reference measures the content type and the tag in UTF-16 units; the script holds UTF-8 bytes, and a push of more
  // than 520 of them is invalid on the chain. Where the reference builds such a script, the Java service refuses (D-09).
  const overOnePush = Buffer.byteLength(c.contentType, 'utf8') > MAX_PUSH || Buffer.byteLength(c.tag, 'utf8') > MAX_PUSH;
  return { ...c, pubkey: hex(leafKey), error: r.error ?? null, pushOver520Bytes: Boolean(v) && overOnePush, built: v ? { leafHex: v.leafHex, leafScriptLength: v.leafScript.length, leafScriptSha256: sha(v.leafScript),
    outputKey: hex(v.taproot.outputKey), parity: v.taproot.parity, scriptPubKey: hex(v.taproot.scriptPubKey), controlBlock: hex(v.taproot.controlBlock),
    tapleaf: hex(v.taproot.tapleaf), contentType: v.contentType, protocolTag: v.protocolTag, bodyLength: v.bodyLength } : null };
});
if (builds.filter((b) => b.pushOver520Bytes).length < 3) throw new Error('the builds do not show the cases the Java service refuses');
const tags = ['regtest', 'mainnet', 'testnet', 'signet'].map((network) => ({ network, tag: protocolTagFor(network) }));

// ── the reveal transaction, whole ───────────────────────────────────────────

const reveals = [];
for (const [size, contentType] of [[1, 'text/plain'], [300, 'text/plain'], [521, 'application/pdf'], [1177, 'application/pdf'], [4000, 'application/octet-stream']]) {
  const secret = ephemeralSecret(() => random(32));
  const body = documentOf(size);
  const ins = buildInscription({ xOnlyPubkey: xOnlyPubkey(secret), body, contentType, protocolTag: 'bcrt' });
  const revealOut = { value: 1000, scriptPubKey: bytes(P2TR('ab')) };
  const anchorOut = { value: 0, scriptPubKey: opReturnScript(bytes(ins.leafHex)) };
  const placeholder = [{ txid: '00'.repeat(32), vout: 0, sequence: 0xfffffffd }];
  const base = serializeLegacy(placeholder, [anchorOut, revealOut]).length;
  const total = serializeWitness(placeholder, [anchorOut, revealOut], [[new Uint8Array(64), ins.leafScript, ins.taproot.controlBlock]]).length;
  const vsize = Math.ceil((base * 3 + total) / 4);
  const commitValue = 1000 + vsize * 2;
  const inputs = [{ txid: txid(size), vout: size % 3, sequence: 0xfffffffd }];
  const prevouts = [{ value: commitValue, scriptPubKey: ins.taproot.scriptPubKey }];
  const sighash = tapSighash(inputs, [anchorOut, revealOut], prevouts, 0, ins.taproot.tapleaf);
  const aux = random(32);
  const signature = schnorrSign(sighash, secret, aux);
  const raw = serializeWitness(inputs, [anchorOut, revealOut], [[signature, ins.leafScript, ins.taproot.controlBlock]]);
  // The independent verifier's own parser must give the document back.
  const items = extractWitnessItems(hex(raw), 0);
  const env = items && parseEnvelope(items[1]);
  if (!env || hex(env.body) !== hex(body)) throw new Error('the verifier does not recover the document from the reference reveal');
  reveals.push({ secret: hex(secret), size, contentType, tag: 'bcrt', revealScript: P2TR('ab'), commitTxid: inputs[0].txid, commitVout: inputs[0].vout, vsize, commitValue,
    sighash: hex(sighash), aux: hex(aux), signature: hex(signature), length: raw.length, sha256: sha(raw), hex: raw.length <= 400 ? hex(raw) : null,
    txid: txidOf(serializeLegacy(inputs, [anchorOut, revealOut])), wtxid: wtxidOf(raw) });
}

// ── the conformance fixture ─────────────────────────────────────────────────

const bundle = JSON.parse(readFileSync(path.join(FIXTURE, 'bundle.json'), 'utf8'));
const original = new Uint8Array(readFileSync(path.join(FIXTURE, 'original.pdf')));
const witness = extractWitnessItems(bundle.anchor.reveal_tx_hex, 0);
const tampered = JSON.parse(readFileSync(path.join(TAMPERED, 'bundle.json'), 'utf8'));
const tamperedBody = parseEnvelope(extractWitnessItems(tampered.anchor.reveal_tx_hex, 0)[1]).body;
const fixture = {
  directory: 'fixtures/conformance/07-witness-unified',
  leafScriptSha256: sha(witness[1]), leafScriptLength: witness[1].length, controlBlock: hex(witness[2]),
  // What the reference answers when asked to commit the fixture's script to the fixture's internal key. (The fixture is a
  // known-answer document for the envelope: its key is a made-up x and its signature was never checked by a node.)
  commitment: (() => {
    const r = refusal(() => taprootSingleLeaf(witness[2].subarray(1), witness[1]));
    return r.value ? { controlBlock: hex(r.value.controlBlock), outputKey: hex(r.value.outputKey), error: null } : { controlBlock: null, outputKey: null, error: r.error };
  })(),
  contentType: bundle.anchor.witness_envelope.content_type, protocolTag: bundle.anchor.witness_envelope.protocol_tag,
  leafBytes: bundle.record.leaf_bytes, originalLength: original.length, originalSha256: sha(original),
  tampered: { directory: 'fixtures/conformance/08-tampered-witness', leafBytes: tampered.record.leaf_bytes, bodySha256: sha(tamperedBody), bodyLength: tamperedBody.length },
};
if (sha(parseEnvelope(witness[1]).body) !== fixture.leafBytes) throw new Error('the fixture\'s witness no longer holds its document');
if (fixture.tampered.bodySha256 === fixture.tampered.leafBytes) throw new Error('the tampered fixture is not tampered');
if (hex(inscriptionLeafScript(witness[2].subarray(1), fixture.protocolTag, fixture.contentType, original)) !== hex(witness[1])) {
  throw new Error('the reference no longer reproduces the fixture\'s tapscript');
}

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-btc-vectors.mjs from apps/core/src/btc and BIP340\'s published vectors. Do not edit by hand. A document of size n is the bytes (i*31 + n) mod 256.',
  maxPush: MAX_PUSH, nums: hex(NUMS_INTERNAL_KEY), order: big(N),
  multiples, sums, mixed, lifts, tagged, official: OFFICIAL, verifications, signings, secrets, ephemeral,
  pushes, leaves, outputs, sighashCases, envelopes, leafScripts, builds, tags, reveals, fixture,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('btc.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`btc.json is current (${signings.length + OFFICIAL.length} signatures, ${envelopes.length} envelopes, ${reveals.length} reveals)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${multiples.length + sums.length + mixed.length} curve cases, ${lifts.length} lift_x, ${tagged.length} tagged hashes, `
    + `${OFFICIAL.length} official + ${signings.length} signatures, ${verifications.length} verifications (${verifications.filter((v) => v.ok).length} valid), ${outputs.length} taproot outputs, `
    + `${sighashCases.length} sighashes, ${envelopes.length} envelopes, ${builds.length} builds (${builds.filter((b) => b.error).length} refused), ${reveals.length} reveals, ${(text.length / 1000).toFixed(0)} kB`);
}
