/**
 * Vectors that hold the Java core's check of offered key material to the
 * reference (`apps/core/src/remit/sign.ts`: publicKeyProblem,
 * es256PublicKeyProblem): what is refused as a private key, what is not a
 * public key at all, what is a public key of another kind — with the code
 * and the sentence a client is answered.
 *
 *   node apps/core-java/tools/make-key-vectors.mjs          write src/test/resources/vectors/keys.json
 *   node apps/core-java/tools/make-key-vectors.mjs --check  fail when the file on disk differs
 *
 * Keys are random, so the material the cases are built from is made once and
 * kept (src/test/resources/vectors/key-materials.json). These are test keys:
 * the private halves in that file protect nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyProblem, es256PublicKeyProblem } from '../../core/src/remit/sign.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../src/test/resources/vectors');
const OUT = path.join(DIR, 'keys.json');
const MATERIALS = path.join(DIR, 'key-materials.json');
const check = process.argv.includes('--check');

let m;
if (existsSync(MATERIALS)) {
  m = JSON.parse(readFileSync(MATERIALS, 'utf8'));
} else {
  const b64 = (k, type, format = 'der') => k.export({ format, type }).toString(format === 'der' ? 'base64' : 'utf8');
  const ec = (namedCurve, extra = {}) => generateKeyPairSync('ec', { namedCurve, ...extra });
  const p256 = ec('prime256v1');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pss = generateKeyPairSync('rsa-pss', { modulusLength: 2048, hashAlgorithm: 'sha256', mgf1HashAlgorithm: 'sha256', saltLength: 32 });
  const ed = generateKeyPairSync('ed25519');
  m = {
    note: 'Made once by apps/core-java/tools/make-key-vectors.mjs and kept: keys are random. Test keys; the private halves here protect nothing.',
    spki: {
      p256: b64(p256.publicKey, 'spki'), p384: b64(ec('secp384r1').publicKey, 'spki'), p521: b64(ec('secp521r1').publicKey, 'spki'),
      secp256k1: b64(ec('secp256k1').publicKey, 'spki'), brainpoolP256r1: b64(ec('brainpoolP256r1').publicKey, 'spki'),
      p256Explicit: b64(ec('prime256v1', { paramEncoding: 'explicit' }).publicKey, 'spki'),
      rsa: b64(rsa.publicKey, 'spki'), rsa1024: b64(generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey, 'spki'), rsaPss: b64(pss.publicKey, 'spki'),
      ed25519: b64(ed.publicKey, 'spki'), ed448: b64(generateKeyPairSync('ed448').publicKey, 'spki'),
      x25519: b64(generateKeyPairSync('x25519').publicKey, 'spki'), x448: b64(generateKeyPairSync('x448').publicKey, 'spki'),
      dsa: b64(generateKeyPairSync('dsa', { modulusLength: 2048, divisorLength: 256 }).publicKey, 'spki'),
    },
    pem: { p256Public: b64(p256.publicKey, 'spki', 'pem'), rsaPublicPkcs1: b64(rsa.publicKey, 'pkcs1', 'pem') },
    other: { rsaPublicPkcs1: b64(rsa.publicKey, 'pkcs1') },
    private: {
      p256Pkcs8: b64(p256.privateKey, 'pkcs8'), p256Sec1: b64(p256.privateKey, 'sec1'), rsaPkcs8: b64(rsa.privateKey, 'pkcs8'), rsaPkcs1: b64(rsa.privateKey, 'pkcs1'),
      ed25519Pkcs8: b64(ed.privateKey, 'pkcs8'), rsaPssPkcs8: b64(pss.privateKey, 'pkcs8'), secp256k1Sec1: b64(ec('secp256k1').privateKey, 'sec1'),
      p256Pkcs8Pem: b64(p256.privateKey, 'pkcs8', 'pem'), p256Sec1Pem: b64(p256.privateKey, 'sec1', 'pem'), rsaPkcs1Pem: b64(rsa.privateKey, 'pkcs1', 'pem'),
      p256Pkcs8Encrypted: p256.privateKey.export({ format: 'der', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'test' }).toString('base64'),
      p256Pkcs8EncryptedPem: p256.privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'test' }),
    },
  };
  writeFileSync(MATERIALS, `${JSON.stringify(m, null, 1)}\n`);
}

const url = (b) => b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = (b) => Buffer.from(b, 'base64');
const p256 = m.spki.p256;
// The same P-256 point in its compressed form: a public key the algorithm identifier still calls P-256.
const compressed = (() => {
  const der = bytes(p256);
  const point = der.subarray(der.length - 65);
  const head = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
  return Buffer.concat([head, Buffer.from([point[64] & 1 ? 0x03 : 0x02]), point.subarray(1, 33)]).toString('base64');
})();
const offCurve = (() => { const der = Buffer.from(bytes(p256)); der[der.length - 1] ^= 0x01; return der.toString('base64'); })();
const cases = [
  ...Object.entries(m.spki).map(([k, v]) => [`SPKI ${k}`, v]),
  ...Object.entries(m.private).map(([k, v]) => [`private ${k}`, v]),
  ['PEM public key (SPKI)', m.pem.p256Public], ['PEM public key (PKCS#1)', m.pem.rsaPublicPkcs1], ['RSA public key as PKCS#1 DER', m.other.rsaPublicPkcs1],
  ['P-256 in base64url', url(p256)], ['P-256 with line breaks', p256.replace(/(.{20})/g, '$1\n')], ['P-256 with spaces around', `  ${p256}  `], ['P-256 with tabs inside', p256.replace(/(.{30})/g, '$1\t')],
  ['P-256 without its padding', p256.replace(/=+$/, '')], ['P-256 with too much padding', `${p256}==`], ['P-256 with text after the padding', `${p256.replace(/=*$/, '==')}AAAA`],
  ['P-256 cut short', p256.slice(0, 60)], ['P-256 with one byte more', Buffer.concat([bytes(p256), Buffer.from([0])]).toString('base64')],
  ['P-256 with sixteen bytes more', Buffer.concat([bytes(p256), Buffer.alloc(16, 7)]).toString('base64')], ['P-256 twice', Buffer.concat([bytes(p256), bytes(p256)]).toString('base64')],
  ['P-256, compressed point', compressed], ['P-256, a point off the curve', offCurve], ['P-256 with a character outside the alphabet', `${p256.slice(0, 10)}!${p256.slice(10)}`],
  ['P-256 with a comment', `${p256} # production key`], ['P-256 mentioning PRIVATE KEY', `${p256} PRIVATE KEY`], ['the words private key in lower case', `${p256} private key`],
  ['empty', ''], ['one space', ' '], ['AAAA', 'AAAA'], ['not base64 at all', '!!! not a key !!!'], ['a hex digest', 'ab'.repeat(32)], ['a JWK', '{"kty":"EC","crv":"P-256"}'],
  ['random bytes', Buffer.alloc(91, 0x5a).toString('base64')], ['a DER sequence of nothing', 'MAA='], ['a certificate-like header', 'MIIB'],
  ['PRIVATE KEY alone', 'PRIVATE KEY'], ['an armoured block with nothing inside', '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----'],
];
const keys = cases.map(([name, text]) => ({ name, text, any: publicKeyProblem(text), es256: es256PublicKeyProblem(text) }));

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-key-vectors.mjs from apps/core/src/remit/sign.ts. Do not edit by hand.',
  keys,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('keys.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`keys.json is current (${keys.length} offered keys)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${keys.length} offered keys`);
  for (const k of keys) console.log(`  ${k.name.padEnd(44)} any=${k.any ? k.any.code : 'ok'}  es256=${k.es256 ? `${k.es256.code}: ${k.es256.message.replace(/^not an ES256 key: ES256 is ECDSA on P-256, and this one is /, '… ')}`.slice(0, 80) : 'ok'}`);
}
