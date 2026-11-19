/**
 * Vectors that hold the producer side of the Java core — Merkle tree, BC01
 * payload, transaction bytes, bundle assembly, canonical JSON, the signed
 * statement — to the code it replaces (`apps/core/src/{merkle,btc,bundle}`,
 * `packages/attest-verify/src/{jcs,statement}.ts`).
 *
 *   node apps/core-java/tools/make-format-vectors.mjs          write src/test/resources/vectors/format.json
 *   node apps/core-java/tools/make-format-vectors.mjs --check  fail when the file on disk differs
 *
 * Signatures are random, so the signed statements the cases start from are
 * made once and kept (src/test/resources/vectors/statement-keys.json: two
 * test keys and what they signed). Everything else is derived from them and
 * from fixed inputs, so every run writes the same file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, createSign, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MerkleTree } from '../../core/src/merkle/tree.ts';
import { encodeBc01, uuidToBytes } from '../../core/src/btc/bc01.ts';
import { encodeVarint, uintLE } from '../../core/src/btc/varint.ts';
import { opReturnScript, serializeLegacy, txidOf } from '../../core/src/btc/tx.ts';
import { assembleBundle } from '../../core/src/bundle/assemble.ts';
import { jcsString } from '../../../packages/attest-verify/src/jcs.ts';
import { statementLeaf, statementSigningInput, verifyStatement, buildStatement } from '../../../packages/attest-verify/src/statement.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../src/test/resources/vectors');
const OUT = path.join(DIR, 'format.json');
const KEYS = path.join(DIR, 'statement-keys.json');
const check = process.argv.includes('--check');
const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (s) => createHash('sha256').update(s).digest();
const refusal = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message, engine: !(e.constructor === Error) }; } };

// ── Merkle ──────────────────────────────────────────────────────────────────

const merkle = [];
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 100, 1024]) {
  const leaves = Array.from({ length: n }, (_, i) => sha256(`leaf ${n}/${i}`));
  const tree = MerkleTree.fromLeaves(leaves);
  const indices = n <= 33 ? leaves.map((_, i) => i) : [0, 1, 2, Math.floor(n / 2), n - 2, n - 1];
  merkle.push({ n, leaves: n <= 33 ? leaves.map(hex) : null, seed: `leaf ${n}/`, root: tree.rootHex(),
    proofs: indices.map((i) => { const p = tree.proof(i); return { index: i, siblings: p.siblings, directions: p.directions }; }) });
}
const merkleRefused = [
  { leaves: [] }, { leaves: ['00'.repeat(31)] }, { leaves: ['00'.repeat(33)] }, { leaves: ['aa'.repeat(32), 'bb'.repeat(32), 'aa'.repeat(32)] },
  { leaves: ['aa'.repeat(32), 'AA'.repeat(32)] }, { leaves: ['aa'.repeat(32), ''] },
].map((c) => ({ ...c, error: refusal(() => MerkleTree.fromLeaves(c.leaves.map((h) => Buffer.from(h, 'hex')))).error }));

// ── BC01, varint, transaction ───────────────────────────────────────────────

const bc01 = [['00'.repeat(32), '00000000-0000-0000-0000-000000000000'], ['ab'.repeat(32), '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10'],
  [hex(sha256('root')), 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'], [hex(sha256('r2')), '3f1c9a527b0e4d6a9c1f2e8b5a7d4c10']]
  .map(([root, uuid]) => ({ root, uuid, payload: hex(encodeBc01(Buffer.from(root, 'hex'), uuidToBytes(uuid))) }));
const uuids = ['', 'abc', '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c1', '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c100', '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '--3f1c9a527b0e4d6a9c1f2e8b5a7d4c10--']
  .map((uuid) => { const r = refusal(() => hex(uuidToBytes(uuid))); return { uuid, bytes: r.value ?? null, error: r.error ?? null }; });
const varints = [0, 1, 0xfc, 0xfd, 0xfe, 0xff, 0x100, 0xffff, 0x10000, 0xffffffff, 0x100000000, 2 ** 40, 2 ** 53 - 1]
  .map((n) => ({ n, varint: hex(encodeVarint(n)), le4: hex(uintLE(n % 2 ** 32, 4)), le8: hex(uintLE(n, 8)) }));
const scripts = [0, 1, 53, 75, 76, 80, 255].map((n) => ({ payload: 'c3'.repeat(n), script: hex(opReturnScript(Buffer.alloc(n, 0xc3))) }));
const P2TR = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xab)]);
const txs = [
  { inputs: [{ txid: '11'.repeat(32), vout: 0 }], outputs: [{ value: 0, script: hex(opReturnScript(Buffer.alloc(53, 7))) }, { value: 9000, script: hex(P2TR) }] },
  { inputs: [{ txid: hex(sha256('a')), vout: 1 }, { txid: hex(sha256('b')), vout: 4294967295, scriptSig: 'deadbeef', sequence: 4294967293 }],
    outputs: [{ value: 2100000000000000, script: hex(P2TR) }, { value: 4294967296, script: '' }, { value: 4294967295, script: '6a' }], version: 1, locktime: 500000 },
  { inputs: [], outputs: [] },
  { inputs: Array.from({ length: 253 }, (_, i) => ({ txid: hex(sha256(`in${i}`)), vout: i })), outputs: [{ value: 1, script: '51' }] },
].map((t) => {
  const legacy = serializeLegacy(t.inputs.map((i) => ({ txid: i.txid, vout: i.vout, ...(i.scriptSig !== undefined ? { scriptSig: Buffer.from(i.scriptSig, 'hex') } : {}), ...(i.sequence !== undefined ? { sequence: i.sequence } : {}) })),
    t.outputs.map((o) => ({ value: o.value, scriptPubKey: Buffer.from(o.script, 'hex') })), t.version ?? 2, t.locktime ?? 0);
  return { ...t, legacy: hex(legacy), txid: txidOf(legacy) };
});

// ── bundle assembly ─────────────────────────────────────────────────────────

const proof = MerkleTree.fromLeaves([sha256('a'), sha256('b'), sha256('c')]).proof(2);
const anchor = { txid: 'ab'.repeat(32), rawTxHex: '0200', payloadHex: 'cd'.repeat(53) };
const base = { leafBytesHex: hex(sha256('doc')), anchor, network: 'regtest', generatedAt: '2026-11-18T06:00:00.000Z' };
const merkleIn = { root: proof.root, siblings: proof.siblings, directions: proof.directions, leafIndex: proof.leafIndex };
const sampleStatement = { schema: 'stonehash-attestation-statement/v1', document: { sha256: hex(sha256('doc')) }, issuer: { key_id: 'k', algorithm: 'ES256', public_key: 'AA' }, issued_at: '2026-11-18T06:00:00.000Z', signature: 'sig' };
const bundles = [
  base, { ...base, merkle: merkleIn }, { ...base, contentType: 'application/pdf', merkle: merkleIn }, { ...base, contentType: '', descriptor: {} },
  { ...base, descriptor: { batch_id: 'b', note: 'n', nested: { a: [1, 2, { b: null }] } }, merkle: merkleIn },
  { ...base, statement: sampleStatement, merkle: merkleIn }, { ...base, statement: sampleStatement, contentType: 'text/plain', descriptor: { 2: 'two', a: 1, 1: 'one' } },
  { ...base, merkle: merkleIn, anchor: { ...anchor, confirmed: { blockHeight: 10149, blockHash: 'ef'.repeat(32), confirmations: 3 } } },
  { ...base, anchor: { ...anchor, confirmed: {} } }, { ...base, anchor: { ...anchor, confirmed: { blockHeight: 0, blockHash: '', confirmations: 0 } } },
  { ...base, anchor: { ...anchor, confirmed: { confirmations: 1 } } }, { ...base, anchor: { ...anchor, confirmed: { blockHash: 'ef'.repeat(32) } } },
  { ...base, network: 'mainnet', anchor: { ...anchor, witnessEnvelope: { inputIndex: 0 } }, commitTxid: '12'.repeat(32) },
  { ...base, anchor: { ...anchor, witnessEnvelope: { inputIndex: 1, contentType: 'application/pdf', protocolTag: 'stonehash' }, confirmed: { blockHeight: 5 } }, commitTxid: '' },
  { ...base, anchor: { ...anchor, witnessEnvelope: { inputIndex: 0, contentType: '', protocolTag: '' } }, contentType: 'application/pdf', merkle: merkleIn, commitTxid: '34'.repeat(32) },
].map((input) => ({ input, json: JSON.stringify(assembleBundle(input), null, 2) }));

// ── canonical JSON ──────────────────────────────────────────────────────────

const canonicalTexts = ['{}', '[]', 'null', 'true', '"x"', '5', '5.0', '-0', '0', '1e3', '9007199254740991', '-9007199254740991', '9007199254740992', '1.5', '1e21', '-1e-7', '1e400',
  '{"b":1,"a":2,"aa":3,"A":4,"":5,"1":6,"10":7,"2":8}', '{"é":1,"e":2,"z":3,"\\ud83d\\ude00":4,"\\uffff":5}', '{"a":{"c":[1,{"b":2,"a":[true,false,null]}],"b":"x"}}',
  '"\\u0000\\u001f\\"\\\\/\\u007f\\u2028é😀"', '"\\ud800"', '{"\\udc00":"\\ud83d"}', '[1,[2,[3,[4,[5]]]]]', '{"a":1.0,"b":2e0,"c":[3.5]}', '[[[1.25]]]', '{"amount":"12500.00","scale":2,"flag":0}',
  '{"a":1,"a":2}', '{"__proto__":1,"constructor":2}', '[0.1]', '[123456789012345678]', '{"n":-1.0e0}'];
const canonical = canonicalTexts.map((text) => { const r = refusal(() => jcsString(JSON.parse(text))); return { text, canonical: r.value ?? null, error: r.error ?? null }; });

// ── the signed statement ────────────────────────────────────────────────────

const b64url = (b) => Buffer.from(b).toString('base64url');
let keys;
if (existsSync(KEYS)) {
  keys = JSON.parse(readFileSync(KEYS, 'utf8'));
} else {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const ed = generateKeyPairSync('ed25519');
  const spki = (k) => k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const core = (alg, key, extra = {}) => buildStatement({ documentSha256: hex(sha256('the document')), keyId: `${alg.toLowerCase()}-test-key`, algorithm: alg, publicKeySpkiBase64: spki(key), issuedAt: '2026-11-18T06:00:00.000Z', ...extra });
  const sign = (c, key, alg) => {
    const s = createSign('SHA256'); s.update(statementSigningInput(c));
    return b64url(alg === 'ES256' ? s.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' }) : s.sign(key.privateKey));
  };
  const es = core('ES256', ec, { contentType: 'application/pdf' });
  const rs = core('RS256', rsa);
  keys = {
    note: 'Made once by apps/core-java/tools/make-format-vectors.mjs and kept: signatures are random. Test keys; they sign nothing real.',
    es256: { spki: spki(ec), signed: { ...es, signature: sign(es, ec, 'ES256') } },
    rs256: { spki: spki(rsa), signed: { ...rs, signature: sign(rs, rsa, 'RS256') } },
    otherKeys: { p384: spki(p384), secp256k1: spki(k1), ed25519: spki(ed), secondP256: spki(generateKeyPairSync('ec', { namedCurve: 'P-256' })) },
  };
  writeFileSync(KEYS, `${JSON.stringify(keys, null, 1)}\n`);
}
// A key written the short way: its point compressed to one coordinate and a sign. Added to the kept file once.
if (!keys.es256Compressed) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  const point = der.subarray(der.length - 65);
  const header = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
  const compressed = Buffer.concat([header, Buffer.from([2 + (point[64] & 1)]), point.subarray(1, 33)]).toString('base64');
  const core = buildStatement({ documentSha256: hex(sha256('the document')), keyId: 'es256-compressed-key', algorithm: 'ES256', publicKeySpkiBase64: compressed, issuedAt: '2026-11-18T06:00:00.000Z' });
  const s = createSign('SHA256'); s.update(statementSigningInput(core));
  keys.es256Compressed = { spki: compressed, uncompressed: der.toString('base64'), signed: { ...core, signature: b64url(s.sign({ key: pair.privateKey, dsaEncoding: 'ieee-p1363' })) } };
  writeFileSync(KEYS, `${JSON.stringify(keys, null, 1)}\n`);
}
const ES = keys.es256.signed;
const RS = keys.rs256.signed;
const EC = keys.es256Compressed.signed;
const compress = (spkiBase64) => { const der = Buffer.from(spkiBase64, 'base64'); const p = der.subarray(der.length - 65);
  return Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), Buffer.from([2 + (p[64] & 1)]), p.subarray(1, 33)]).toString('base64'); };
const hybrid = (spkiBase64) => { const der = Buffer.from(spkiBase64, 'base64'); const out = Buffer.from(der); out[out.length - 65] = 6 + (der[der.length - 1] & 1); return out.toString('base64'); };
const offCurve = (() => { const der = Buffer.from(compress(keys.es256.spki), 'base64'); for (let i = 0; i < 64; i++) { const t = Buffer.from(der); t[t.length - 1] ^= i + 1;
  try { createPublicKey({ key: t, format: 'der', type: 'spki' }); } catch { return t.toString('base64'); } } return null; })();
const set = (o, pathKeys, value) => { const c = structuredClone(o); let at = c; for (const k of pathKeys.slice(0, -1)) at = at[k]; if (value === undefined) delete at[pathKeys.at(-1)]; else at[pathKeys.at(-1)] = value; return c; };
const std = (s) => Buffer.from(s, 'base64url').toString('base64');
const statementCases = [
  ['ES256 as signed', ES], ['RS256 as signed', RS],
  ['ES256, signature in standard base64 with padding', set(ES, ['signature'], std(ES.signature))], ['ES256, key in base64url', set(ES, ['issuer', 'public_key'], b64url(Buffer.from(ES.issuer.public_key, 'base64')))],
  ['ES256, signature with white space', set(ES, ['signature'], `${ES.signature.slice(0, 20)}\n${ES.signature.slice(20)}`)], ['ES256, signature with a trailing line end', set(ES, ['signature'], `${ES.signature}\n`)],
  ['ES256, padded signature with a trailing space', set(ES, ['signature'], `${std(ES.signature)} `)],
  ['ES256, another document', set(ES, ['document', 'sha256'], hex(sha256('another')))], ['ES256, another time', set(ES, ['issued_at'], '2026-11-18T06:00:00.001Z')],
  ['ES256, another key id', set(ES, ['issuer', 'key_id'], 'someone-else')], ['ES256, a field added', set(ES, ['extra'], 'x')], ['ES256, content type removed', set(ES, ['document', 'content_type'], undefined)],
  ['ES256, signature of another statement', set(ES, ['signature'], RS.signature)], ['ES256, one bit of the signature changed', set(ES, ['signature'], (ES.signature[0] === 'A' ? 'B' : 'A') + ES.signature.slice(1))],
  ['ES256, signature cut short', set(ES, ['signature'], ES.signature.slice(0, 40))], ['ES256, signature too long', set(ES, ['signature'], `${ES.signature}AAAA`)], ['ES256, signature of zeros', set(ES, ['signature'], b64url(Buffer.alloc(64)))],
  ['ES256, signature as DER', set(ES, ['signature'], b64url(Buffer.from('3006020101020101', 'hex')))],
  ['ES256, another P-256 key', set(ES, ['issuer', 'public_key'], keys.otherKeys.secondP256)], ['ES256 with a P-384 key', set(ES, ['issuer', 'public_key'], keys.otherKeys.p384)],
  ['ES256 with a secp256k1 key', set(ES, ['issuer', 'public_key'], keys.otherKeys.secp256k1)], ['ES256 with an Ed25519 key', set(ES, ['issuer', 'public_key'], keys.otherKeys.ed25519)],
  ['ES256 with the RSA key', set(ES, ['issuer', 'public_key'], RS.issuer.public_key)], ['RS256 with the EC key', set(RS, ['issuer', 'public_key'], ES.issuer.public_key)],
  ['ES256 declared RS256', set(ES, ['issuer', 'algorithm'], 'RS256')], ['RS256 declared ES256', set(RS, ['issuer', 'algorithm'], 'ES256')],
  ['RS256, one bit of the signature changed', set(RS, ['signature'], (RS.signature[5] === 'A' ? 'B' : 'A') + RS.signature.slice(1))], ['RS256, signature cut short', set(RS, ['signature'], RS.signature.slice(0, 100))],
  ['ES256 signed under a compressed public key', EC], ['ES256, compressed key, one bit of the signature changed', set(EC, ['signature'], (EC.signature[0] === 'A' ? 'B' : 'A') + EC.signature.slice(1))],
  ['ES256, compressed key written out in full instead', set(EC, ['issuer', 'public_key'], keys.es256Compressed.uncompressed)],
  ['ES256 as signed, its key written compressed instead', set(ES, ['issuer', 'public_key'], compress(ES.issuer.public_key))],
  ['ES256 as signed, its key written in the hybrid form', set(ES, ['issuer', 'public_key'], hybrid(ES.issuer.public_key))],
  ...(offCurve ? [['ES256 with a compressed point that is not on the curve', set(ES, ['issuer', 'public_key'], offCurve)]] : []),
  ['a key that is not base64', set(ES, ['issuer', 'public_key'], '!!!not base64!!!')], ['a key that is base64 of nothing', set(ES, ['issuer', 'public_key'], 'AAAA')], ['a signature that is not base64', set(ES, ['signature'], '***')],
  ['a signature of one character too many', set(ES, ['signature'], 'AAAAA')], ['a signature with padding in the middle', set(ES, ['signature'], 'AA==AAAA')],
  ['no signature', set(ES, ['signature'], undefined)], ['an empty signature', set(ES, ['signature'], '')], ['a signature that is null', set(ES, ['signature'], null)], ['a signature that is a number', set(ES, ['signature'], 5)],
  ['a signature that is zero', set(ES, ['signature'], 0)], ['a signature that is a list', set(ES, ['signature'], [ES.signature])], ['a signature that is true', set(ES, ['signature'], true)],
  ['another schema', set(ES, ['schema'], 'stonehash-attestation-statement/v2')], ['no schema', set(ES, ['schema'], undefined)], ['a schema that is a number', set(ES, ['schema'], 1)],
  ['no document', set(ES, ['document'], undefined)], ['a document that is null', set(ES, ['document'], null)], ['a document that is text', set(ES, ['document'], 'abc')], ['a document that is a list', set(ES, ['document'], [])],
  ['no digest', set(ES, ['document', 'sha256'], undefined)], ['a digest in upper case', set(ES, ['document', 'sha256'], ES.document.sha256.toUpperCase())], ['a digest too short', set(ES, ['document', 'sha256'], 'abc')],
  ['a digest with a line end', set(ES, ['document', 'sha256'], `${ES.document.sha256}\n`)], ['a digest that is a number', set(ES, ['document', 'sha256'], 5)], ['a digest that is null', set(ES, ['document', 'sha256'], null)],
  ['a digest inside a list', set(ES, ['document', 'sha256'], [ES.document.sha256])], ['a digest that is an object', set(ES, ['document', 'sha256'], {})],
  ['no issuer', set(ES, ['issuer'], undefined)], ['an issuer that is null', set(ES, ['issuer'], null)], ['an issuer that is text', set(ES, ['issuer'], 'bank')],
  ['no key id', set(ES, ['issuer', 'key_id'], undefined)], ['an empty key id', set(ES, ['issuer', 'key_id'], '')], ['a key id that is zero', set(ES, ['issuer', 'key_id'], 0)], ['a key id that is a number', set(ES, ['issuer', 'key_id'], 7)],
  ['a key id that is an object', set(ES, ['issuer', 'key_id'], { a: 1 })], ['a key id that is a list', set(ES, ['issuer', 'key_id'], ['k', 'l'])],
  ['no algorithm', set(ES, ['issuer', 'algorithm'], undefined)], ['algorithm es256', set(ES, ['issuer', 'algorithm'], 'es256')], ['algorithm EdDSA', set(ES, ['issuer', 'algorithm'], 'EdDSA')],
  ['an algorithm that is null', set(ES, ['issuer', 'algorithm'], null)], ['an algorithm that is a number', set(ES, ['issuer', 'algorithm'], 256)], ['an algorithm that is a list', set(ES, ['issuer', 'algorithm'], ['ES256'])],
  ['an algorithm that is an object', set(ES, ['issuer', 'algorithm'], { name: 'ES256' })],
  ['no public key', set(ES, ['issuer', 'public_key'], undefined)], ['an empty public key', set(ES, ['issuer', 'public_key'], '')], ['a public key that is a number', set(ES, ['issuer', 'public_key'], 5)],
  ['no time', set(ES, ['issued_at'], undefined)], ['a time that is null', set(ES, ['issued_at'], null)], ['a time that is a number', set(ES, ['issued_at'], 1763337600000)], ['a time that is true', set(ES, ['issued_at'], true)],
  ['a fraction in the statement', set(ES, ['weight'], 1.5)], ['a number beyond the safe range', set(ES, ['count'], 9007199254740992)], ['a whole number in the statement', set(ES, ['count'], 3)],
  ['a nested fraction', set(ES, ['document', 'pages'], [1, 2.5])], ['half a surrogate pair in a value', set(ES, ['note'], '\ud800')], ['a null in the statement', set(ES, ['note'], null)],
];
const times = ['2026-11-18T06:00:00.000Z', '2026-11-18T06:00:00Z', '2026-11-18T06:00Z', '2026-11-18T06:00:00.1Z', '2026-11-18T06:00:00.123456Z', '2026-11-18T06:00:00+09:00', '2026-11-18T06:00:00-00:00',
  '2026-11-18T06:00:00', '2026-11-18T06:00', '2026-11-18', '2026-11', '2026', '+002026-11-18T06:00:00Z', '-000001-01-01T00:00:00Z', '-000000-01-01T00:00:00Z', '2026-11-18T24:00:00Z', '2026-11-18T24:00:01Z',
  '2026-11-18T23:59:60Z', '2026-13-01', '2026-02-30', '2026-02-29', '2024-02-29', '2026-11-31T00:00:00Z', '2026-11-18T06:00:00+24:00', '2026-11-18T06:00:00+23:59', '2026-11-18T06:00:00+09:60', '0000-01-01T00:00:00Z',
  '275760-09-13T00:00:00Z', '+275760-09-13T00:00:00Z', '+275760-09-13T00:00:00.001Z', '', ' ', 'now', 'yesterday', '2026-11-18 06:00:00', '2026-11-18 06:00:00Z', '2026/11/18', '11/18/2026', 'Nov 18, 2026', 'Wed, 18 Nov 2026 06:00:00 GMT',
  '18 Nov 2026', '2026-11-18T06:00:00+0900', '2026-11-18T06:00:00 +09:00', '2026-11-18t06:00:00z', '20261118', '20261118T060000Z', '1763337600000', '2026-11-18T06:00:00.Z', '2026-11-18T6:00:00Z', '2026-1-8', '2026-11-18T06:00:00,5Z',
  ' 2026-11-18T06:00:00Z', '2026-11-18T06:00:00Z ', '2026-11-18T06:00:00ZZ', '2026-W47-3', '2026-322', 'T06:00:00Z', '06:00', '2026-11-18T', '0', '1', '99', '100', 'null', 'undefined', '２０２６-11-18'];
for (const t of times) statementCases.push([`issued at ${JSON.stringify(t)}`, set(ES, ['issued_at'], t)]);

const OURS = ['Invalid character', 'Invalid key type', 'Named curve mismatch', 'Invalid keyData', 'statement schema must be', 'document.sha256 must be', 'issuer.key_id is required', 'unsupported algorithm: ', 'issuer.public_key is required', 'issued_at must be',
  'a signed statement needs its signature', 'jcs: ', 'The string to be decoded is not correctly encoded.'];
const ours = (message) => OURS.some((p) => message.startsWith(p));
const statements = [];
for (const [name, statement] of statementCases) {
  // As a request brings it: what JSON drops is dropped before the reference sees it.
  const s = JSON.parse(JSON.stringify(statement));
  const leaf = refusal(() => statementLeaf(s));
  const anchored = leaf.value ?? '00'.repeat(32);
  const verdict = await verifyStatement(s, anchored);
  const elsewhere = await verifyStatement(s, 'ff'.repeat(32));
  statements.push({
    name, statement: s,
    leaf: leaf.value ?? null, leafError: leaf.error ?? null, leafErrorIsOurs: leaf.error ? ours(leaf.error) : null,
    verdict: { ...verdict, error: verdict.error ?? null }, verdictErrorIsOurs: verdict.error ? ours(verdict.error) : null,
    leafOkElsewhere: elsewhere.leafOk,
    signingInput: refusal(() => hex(statementSigningInput(s))).value ?? null,
  });
}

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-format-vectors.mjs from apps/core/src and packages/attest-verify/src. Do not edit by hand.',
  merkle, merkleRefused, bc01, uuids, varints, scripts, txs, bundles, canonical, statements,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('format.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`format.json is current (${statements.length} statements, ${bundles.length} bundles)`);
} else {
  writeFileSync(OUT, text);
  const v = statements.map((s) => s.verdict);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${merkle.length} trees, ${bundles.length} bundles, ${canonical.length} canonical texts, ${txs.length} transactions, `
    + `${statements.length} statements (${v.filter((x) => x.signatureOk).length} verify, ${statements.filter((s) => s.leafError).length} refused, `
    + `${statements.filter((s) => s.leafErrorIsOurs === false || s.verdictErrorIsOurs === false).length} in the engine's words), ${(text.length / 1000).toFixed(0)} kB`);
}
