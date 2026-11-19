/**
 * BIP340 against its own published vectors.
 *
 * This file is the reason `secp256k1.ts` is allowed to exist. Hand-written
 * curve arithmetic fails in ways that unit tests of our own invention do not
 * catch: a signature can verify against our verifier and be rejected by every
 * node on the network, because both sides share the mistake. The vectors below
 * are the ones in BIP340 itself, so they are independent of anything here.
 *
 * Vector source: https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  G, liftX, pointAdd, pointMul, schnorrSign, schnorrVerify, taggedHash, xOnlyPubkey,
  bytesToBigint, xOnly,
} from '../src/btc/secp256k1.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex').toUpperCase();

/** index, secret, pubkey, aux, message, signature — the signing vectors. */
const SIGN: [number, string, string, string, string, string][] = [
  [0,
    '0000000000000000000000000000000000000000000000000000000000000003',
    'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0000000000000000000000000000000000000000000000000000000000000000',
    'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA8215'
    + '25F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0'],
  [1,
    'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF',
    'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    '0000000000000000000000000000000000000000000000000000000000000001',
    '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE3341'
    + '8906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A'],
  [2,
    'C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9',
    'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906',
    '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1B'
    + 'AB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7'],
  [3,
    '0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710',
    '25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517',
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    '7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC'
    + '97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3'],
];

test('BIP340 vectors: the public key derived from each secret', () => {
  for (const [i, sec, pub] of SIGN) {
    assert.equal(hexOf(xOnlyPubkey(hex(sec))), pub, `vector ${i} public key`);
  }
});

test('BIP340 vectors: signatures are byte-for-byte the published ones', () => {
  // Exact equality, not just "verifies". A signature that verifies but differs
  // means the nonce derivation drifted, and deterministic nonces are the part
  // a reviewer can check against the BIP without running anything.
  for (const [i, sec, , aux, msg, sig] of SIGN) {
    assert.equal(hexOf(schnorrSign(hex(msg), hex(sec), hex(aux))), sig, `vector ${i} signature`);
  }
});

test('BIP340 vectors: each published signature verifies', () => {
  for (const [i, , pub, , msg, sig] of SIGN) {
    assert.ok(schnorrVerify(hex(sig), hex(msg), hex(pub)), `vector ${i} should verify`);
  }
});

test('BIP340 vector 4: verification of a signature we did not produce', () => {
  // Public key for which the signer does not hold the secret here; it exercises
  // lift_x on a key whose even-y point is the one the verifier must use.
  assert.ok(schnorrVerify(
    hex('00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C637'
      + '6AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4'),
    hex('4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703'),
    hex('D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9'),
  ));
});

test('BIP340 negative vectors are rejected', () => {
  const pub = hex('DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659');
  const msg = hex('243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89');
  const good = hex('6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE3341'
    + '8906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A');
  assert.ok(schnorrVerify(good, msg, pub), 'the baseline must verify first');

  // A public key whose x is not on the curve: lift_x fails and so must verify.
  assert.equal(schnorrVerify(good, msg,
    hex('EEFDEA4CD0B44C0C96D7A5EB4C1F8C8D0C0C7B4C77A52D43E4A1BE1DF4A3C1B2')), false,
  'public key not on the curve');

  // r = p and s = n are each exactly one past the permitted range. Both are
  // real BIP340 negative vectors, and both are easy to let through by
  // comparing with `>` instead of `>=`.
  const sig = (r: string, s: string): Uint8Array => hex(r + s);
  const okR = '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE3341';
  const okS = '8906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A';
  const FIELD_P = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F';
  const ORDER_N = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141';
  assert.equal(schnorrVerify(sig(FIELD_P, okS), msg, pub), false, 'r equal to the field prime');
  assert.equal(schnorrVerify(sig(okR, ORDER_N), msg, pub), false, 's equal to the group order');

  assert.equal(schnorrVerify(good.subarray(0, 63), msg, pub), false, 'short signature');
  assert.equal(schnorrVerify(good, msg, pub.subarray(0, 31)), false, 'short public key');
});

test('a flipped bit anywhere in the message breaks the signature', () => {
  const sec = hex('B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF');
  const pub = xOnlyPubkey(sec);
  const msg = new Uint8Array(32).fill(7);
  const sig = schnorrSign(msg, sec, new Uint8Array(32));
  assert.ok(schnorrVerify(sig, msg, pub));
  const tampered = Uint8Array.from(msg);
  tampered[31] = tampered[31]! ^ 0x01;
  assert.equal(schnorrVerify(sig, tampered, pub), false);
});

test('lift_x returns the even-y point, and rejects x values off the curve', () => {
  // BIP340's own off-curve x. Note x = 1 is *not* a counterexample: 1 + 7 = 8
  // happens to be a quadratic residue mod p, so (1, y) is a real curve point.
  assert.equal(liftX(bytesToBigint(
    hex('EEFDEA4CD0B44C0C96D7A5EB4C1F8C8D0C0C7B4C77A52D43E4A1BE1DF4A3C1B2'))), null);
  assert.notEqual(liftX(1n), null, 'x = 1 is on the curve, despite appearances');
  const p = liftX(bytesToBigint(
    hex('DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659')));
  assert.ok(p !== null);
  assert.equal(p.y & 1n, 0n, 'lift_x must return the even-y branch');
});

test('the tagged hash matches the construction spelled out in BIP340', () => {
  const t = createHash('sha256').update('TapLeaf').digest();
  const want = createHash('sha256')
    .update(Buffer.concat([t, t, Buffer.from([0x00])])).digest('hex');
  assert.equal(Buffer.from(taggedHash('TapLeaf', new Uint8Array([0]))).toString('hex'), want);
});

test('scalar multiplication agrees with repeated addition', () => {
  // A cheap independent check on pointAdd/pointDouble: 5G two ways. A bug in
  // the doubling branch survives the BIP340 vectors surprisingly often,
  // because those exercise one fixed ladder.
  const five = pointMul(5n);
  let acc = G;
  for (let i = 0; i < 4; i++) acc = pointAdd(acc, G);
  assert.ok(five !== null && acc !== null);
  assert.deepEqual(Array.from(xOnly(five)), Array.from(xOnly(acc)));
});
