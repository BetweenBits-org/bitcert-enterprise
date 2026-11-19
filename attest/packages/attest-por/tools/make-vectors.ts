/**
 * Conformance vectors for the proof-of-reserves SDKs.
 *
 * The exchange-side SDK exists in several languages, and every one of them
 * has to arrive at the same 32 bytes from the same ledger — a root that
 * differs by language is two different statements about one set of
 * liabilities. These files are how that is held: this TypeScript package is
 * the reference, the vectors are what it produces, and each other SDK runs
 * them in its own test suite.
 *
 *   node packages/attest-por/tools/make-vectors.ts          regenerate
 *
 * Everything is deterministic except one thing. An ECDSA signature uses a
 * fresh nonce, so signing again gives different bytes; the signature in
 * `statement.json` is therefore kept if it still verifies and only made anew
 * when it does not. `test/vectors.test.ts` fails if the reference and the
 * files drift apart.
 *
 * The key under `test-key` is a TEST key, published on purpose. It is
 * registered nowhere and must never be.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { jcsString, porEmptyNode, porLeafHash, verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import {
  AmountError, buildPorTree, buildSnapshotStatement, leafFromRow, porSnapshotCommitment,
  provePorLeaf, publicSpkiBase64, readAccountsJson, readLiabilitiesCsv, signSnapshotStatement, toBaseUnits,
  verifySnapshotSignature,
} from '../src/index.ts';
import type { IntakeOptions, LiabilityRow, PorSignature, PorSnapshotStatement } from '../src/index.ts';

const HERE = import.meta.dirname;
const OUT = path.resolve(HERE, '../../../fixtures/por');
const SAMPLES = path.resolve(HERE, '../samples');
const CLI = path.resolve(HERE, '../src/cli.ts');
const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const EXCHANGE = 'KR-EX-0a1b2c';
const ASSETS3 = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
/** The two tree formats. Everything that was a vector before v2 existed stays a v1 vector, byte for byte. */
const V1 = 'merkle-sum-sha256-v1' as const;
const V2 = 'merkle-sum-sha256-v2' as const;

const write = (name: string, value: unknown): void => {
  const file = path.join(OUT, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const writeText = (name: string, text: string | Buffer): void => {
  const file = path.join(OUT, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// ── canonical JSON ─────────────────────────────────────────────────────────
const jcsValues: [string, unknown][] = [
  ['keys are sorted, whitespace removed', { b: '2', a: '1', c: { z: 1, y: [3, 2, 1] } }],
  ['empty containers', { o: {}, a: [], s: '' }],
  ['integers, booleans and null', { zero: 0, neg: -1, max: 9007199254740991, min: -9007199254740991, t: true, f: false, n: null }],
  ['a string is written as it is, in UTF-8: Korean, an accent, an emoji', { name: '한빛 거래소', note: 'café ☕ 😀' }],
  ['the two characters that must be escaped', { s: 'say "hi" \\ bye' }],
  ['control characters: the five short forms, the rest as \\u00xx in lower case', { s: '\b\f\n\r\t\u0000\u0001\u001f' }],
  ['not escaped: slash, DEL, U+2028, U+2029', { s: '/\u007f  ' }],
  // Sorted by UTF-16 code unit, not by code point: the emoji (D83D DE00) sorts before U+E000.
  ['keys sort by UTF-16 code unit', { '': 'private use', '😀': 'emoji', 'a': 'ascii', 'Z': 'upper', '가': 'hangul' }],
  ['keys that look like numbers sort as text', { '10': 'a', '9': 'b', '1': 'c' }],
  ['nested arrays keep their order', [[3, 'b'], [1, 'a'], { k: [true, null] }]],
  ['a balances object', { USDT: '1500250000', BTC: '50000000', ETH: '0' }],
];
write('jcs.json', {
  about: 'Canonical JSON (the RFC 8785 subset this protocol uses). `canonical` is the exact text; the bytes hashed are its UTF-8 encoding.',
  cases: jcsValues.map(([name, value]) => ({ name, value, canonical: jcsString(value as never) })),
  rejects: [
    { name: 'a number with a fraction', json: '{"x":1.5}' },
    { name: 'an integer beyond 2^53 - 1', json: '{"x":9007199254740992}' },
  ],
});

// ── amounts ────────────────────────────────────────────────────────────────
const amountOk: [string, number, 'decimal' | 'base'][] = [
  ['0.5', 8, 'decimal'], ['1', 8, 'decimal'], ['0', 8, 'decimal'], ['0.00000001', 8, 'decimal'], ['.5', 8, 'decimal'],
  [' 12.50 ', 2, 'decimal'], ['007.10', 2, 'decimal'], ['1234', 0, 'decimal'], ['1234.000', 0, 'decimal'],
  ['0.500000000000000000', 8, 'decimal'], ['21.12345678', 8, 'decimal'], ['0.000000000000000001', 18, 'decimal'],
  ['123456789012345678901234567890.123456789012345678', 18, 'decimal'], ['0.0', 0, 'decimal'], ['00', 8, 'decimal'],
  ['50000000', 8, 'base'], ['00050', 8, 'base'], ['0', 0, 'base'], [' 7 ', 6, 'base'],
  ['340282366920938463463374607431768211455', 18, 'base'],
];
const amountBad: [string, number, 'decimal' | 'base'][] = [
  ['0.123456789', 8, 'decimal'], ['0.1', 0, 'decimal'], ['-1', 8, 'decimal'], ['−1', 8, 'decimal'], ['1e-8', 8, 'decimal'],
  ['1E5', 8, 'decimal'], ['1,000.5', 8, 'decimal'], ['1 000', 8, 'decimal'], ['1_000', 8, 'decimal'], ['', 8, 'decimal'],
  ['   ', 8, 'decimal'], ['5.', 8, 'decimal'], ['.', 8, 'decimal'], ['+5', 8, 'decimal'], ['abc', 8, 'decimal'],
  ['NaN', 8, 'decimal'], ['0x10', 8, 'decimal'], ['1.2.3', 8, 'decimal'], ['9'.repeat(80), 8, 'decimal'],
  ['0.5', 8, 'base'], ['-5', 8, 'base'], ['1e3', 8, 'base'], ['12a', 8, 'base'], ['', 8, 'base'],
];
write('amounts.json', {
  about: 'Exported text to a base-unit integer string. Exact or refused: nothing is rounded.',
  cases: amountOk.map(([text, decimals, unit]) => ({ text, decimals, unit, base: toBaseUnits(text, decimals, unit) })),
  errors: amountBad.map(([text, decimals, unit]) => {
    try {
      toBaseUnits(text, decimals, unit);
    } catch (e) {
      if (e instanceof AmountError) return { text, decimals, unit, code: e.code };
      throw e;
    }
    throw new Error(`expected "${text}" to be refused`);
  }),
});

// ── leaves ─────────────────────────────────────────────────────────────────
const seed = Buffer.from(SEED, 'hex');
const symbols3 = ASSETS3.map((a) => a.symbol);
const leafRows: { user_ref: string; balances: Record<string, string> }[] = [
  { user_ref: 'U-100001', balances: { BTC: '50000000', ETH: '12500000000000000000', USDT: '1500250000' } },
  { user_ref: 'U-100002', balances: { BTC: '12345' } },
  { user_ref: 'kim, 민수', balances: { USDT: '1' } },
  { user_ref: '😀 account', balances: {} },
  { user_ref: '00000000-0000-4000-8000-000000000001', balances: { ETH: '1' } },
  { user_ref: 'a'.repeat(256), balances: { BTC: '0', ETH: '0', USDT: '0' } },
];
write('leaves.json', {
  about: 'From a ledger row to a leaf. The leaf hash is taken over the balances with every asset present ("0" where the account holds none).',
  exchange_id: EXCHANGE,
  seed_hex: SEED,
  assets: symbols3,
  cases: leafRows.map((row) => {
    const leaf = leafFromRow(EXCHANGE, seed, row);
    const normalised = Object.fromEntries(symbols3.map((s) => [s, row.balances[s] ?? '0']));
    return {
      user_ref: row.user_ref, balances: row.balances,
      user_ref_hash: leaf.user_ref_hash, salt: leaf.salt,
      normalised_balances: normalised,
      leaf_hash: porLeafHash(leaf.salt, leaf.user_ref_hash, normalised),
    };
  }),
});

// ── trees and proofs ───────────────────────────────────────────────────────
function ledger(n: number, assets: string[]): { user_ref: string; balances: Record<string, string> }[] {
  return Array.from({ length: n }, (_, i) => {
    const balances: Record<string, string> = {};
    assets.forEach((a, j) => {
      // Deterministic and uneven: some accounts hold nothing of an asset, some hold large amounts.
      const v = (BigInt(i + 1) * BigInt(7919 * (j + 1)) * 10n ** BigInt((i * (j + 3)) % 19)) % 10n ** 24n;
      if ((i + j) % 4 !== 0) balances[a] = v.toString();
    });
    return { user_ref: `acct-${String(i + 1).padStart(5, '0')}`, balances };
  });
}
const treeCases: { name: string; assets: string[]; rows: { user_ref: string; balances: Record<string, string> }[] }[] = [
  { name: 'one account: the root is the leaf', assets: ['BTC'], rows: ledger(1, ['BTC']) },
  { name: 'two accounts', assets: symbols3, rows: ledger(2, symbols3) },
  { name: 'three accounts: one empty node pads the first level', assets: symbols3, rows: ledger(3, symbols3) },
  { name: 'five accounts: padding at two levels', assets: symbols3, rows: ledger(5, symbols3) },
  { name: 'thirty-three accounts, five assets', assets: ['A1', 'B2', 'C3', 'D4', 'E5'], rows: ledger(33, ['A1', 'B2', 'C3', 'D4', 'E5']) },
];
const buildCase = (c: (typeof treeCases)[number], algo: typeof V1 | typeof V2) => {
  const leaves = c.rows.map((r) => leafFromRow(EXCHANGE, seed, r));
  const tree = buildPorTree(leaves, c.assets, { algo });
  const sorted = [...leaves].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const picks = [...new Set([0, 1, Math.floor(sorted.length / 2), sorted.length - 1])].filter((i) => i < sorted.length);
  const proofs = picks.map((i) => {
    const { user_ref: _private, ...opening } = sorted[i]!;
    const proof = provePorLeaf(tree, i, opening);
    if (!verifyPorInclusion(proof, { root: tree.root, totals: tree.totals }).ok) throw new Error('reference proof does not verify');
    return { user_ref: sorted[i]!.user_ref, leaf_index: i, proof };
  });
  return {
    name: c.name, exchange_id: EXCHANGE, seed_hex: SEED, assets: c.assets, rows: c.rows,
    leaf_count: tree.leaf_count, root: tree.root, totals: tree.totals,
    order: sorted.map((l) => l.user_ref),
    level_hashes: tree.levels.map((level) => level.map((n) => n.hash)),
    proofs,
  };
};
const builtTrees = treeCases.map((c) => buildCase(c, V1));
const base = builtTrees[3]!.proofs[1]!.proof;
const mutate = (f: (p: PorInclusionProof) => void): PorInclusionProof => {
  const copy = JSON.parse(JSON.stringify(base)) as PorInclusionProof;
  f(copy);
  return copy;
};
const invalid: { why: string; proof: PorInclusionProof }[] = [
  { why: 'a balance was changed', proof: mutate((p) => { p.leaf.balances['BTC'] = (BigInt(p.leaf.balances['BTC'] ?? '0') + 1n).toString(); }) },
  { why: 'a sibling sum was changed', proof: mutate((p) => { p.siblings[0]!.sums['ETH'] = (BigInt(p.siblings[0]!.sums['ETH'] ?? '0') + 1n).toString(); }) },
  { why: 'the index was changed', proof: mutate((p) => { p.leaf_index = p.leaf_index ^ 1; }) },
  { why: 'a sibling direction was flipped', proof: mutate((p) => { p.siblings[1]!.dir = p.siblings[1]!.dir === 'left' ? 'right' : 'left'; }) },
  { why: 'a sibling hash was changed', proof: mutate((p) => { p.siblings[0]!.hash = p.siblings[0]!.hash.replace(/^./, (c) => (c === 'f' ? '0' : 'f')); }) },
  { why: 'a negative balance', proof: mutate((p) => { p.leaf.balances['USDT'] = '-1'; }) },
  { why: 'the salt was changed', proof: mutate((p) => { p.leaf.salt = '00'.repeat(32); }) },
  { why: 'a sibling was dropped', proof: mutate((p) => { p.siblings.pop(); }) },
];
for (const x of invalid) {
  if (verifyPorInclusion(x.proof, { root: builtTrees[3]!.root, totals: builtTrees[3]!.totals }).ok) throw new Error(`"${x.why}" still verifies`);
}
write('trees.json', {
  about: 'Leaves are ordered by user_ref_hash; a level with an odd number of nodes gets one empty node; `level_hashes[0]` is the leaf level as stored (padded).',
  empty_node_hash: porEmptyNode(['BTC']).hash,
  cases: builtTrees,
  invalid_proofs: { against: { root: builtTrees[3]!.root, totals: builtTrees[3]!.totals }, proofs: invalid },
});

// ── the v2 tree: only what is held is written ──────────────────────────────
// The same ledgers, and one that lists far more assets than anyone holds —
// which is the case v2 exists for, and the one a port is most likely to get
// wrong by writing a zero somewhere.
const listed = Array.from({ length: 120 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`);
const sparse = Array.from({ length: 41 }, (_, i) => ({
  user_ref: `acct-${String(i + 1).padStart(5, '0')}`,
  // Up to three assets each; every seventh account holds nothing at all.
  balances: i % 7 === 6 ? {} : Object.fromEntries([0, 1, 2].filter((k) => (i + k) % 5 !== 0)
    .map((k) => [listed[(i * 11 + k * 37) % listed.length]!, (BigInt(i + 1) * 1000003n * BigInt(k + 1)).toString()])),
}));
const v2Cases = [
  ...treeCases,
  { name: 'forty-one accounts, 120 listed assets, at most three held each, some accounts empty', assets: listed, rows: sparse },
];
const builtV2 = v2Cases.map((c) => buildCase(c, V2));
// What is listed and not held leaves no trace in a v2 root.
const sparseLeaves = sparse.map((r) => leafFromRow(EXCHANGE, seed, r));
const heldOnly = [...new Set(sparse.flatMap((r) => Object.keys(r.balances)))].sort();
if (buildPorTree(sparseLeaves, heldOnly, { algo: V2 }).root !== builtV2[builtV2.length - 1]!.root) {
  throw new Error('a v2 root changed with the list of assets nobody holds');
}
const v2Statement = buildSnapshotStatement({
  institutionId: EXCHANGE, name: 'Sample Exchange', asof: '2026-11-16T00:00:00Z',
  assets: listed.map((symbol) => ({ symbol, decimals: 8 })),
}, buildPorTree(sparseLeaves, listed, { algo: V2 }), new Date('2026-11-16T01:02:03.456Z'));
write('trees-v2.json', {
  about: 'The v2 tree (`merkle-sum-sha256-v2`): hashes exactly as in trees.json, but a leaf carries only the balances that are not zero, a node only the sums that are not zero, and the empty node carries none. The statement still lists a total for every declared asset. `same_root_when_listing_only` is the last case rebuilt with only the assets somebody holds declared: the root must not change.',
  algo: V2,
  empty_node: porEmptyNode([]),
  cases: builtV2,
  same_root_when_listing_only: { assets: heldOnly, root: builtV2[builtV2.length - 1]!.root },
  statement: { of_case: builtV2[builtV2.length - 1]!.name, statement: v2Statement, canonical: jcsString(v2Statement as never), commitment: porSnapshotCommitment(v2Statement) },
});

// ── statement, commitment, signature ───────────────────────────────────────
const sample = builtTrees[4]!;
const sampleLeaves = sample.rows.map((r) => leafFromRow(EXCHANGE, seed, r));
const sampleTree = buildPorTree(sampleLeaves, sample.assets, { algo: V1 });
const statement: PorSnapshotStatement = buildSnapshotStatement({
  institutionId: EXCHANGE, name: '한빛 거래소 (Hanbit Exchange)', asof: '2026-11-16T00:00:00Z',
  assets: sample.assets.map((symbol, i) => ({ symbol, decimals: [8, 18, 6, 0, 2][i]! })),
  reserves: {
    mode: 'DECLARED',
    entries: [{ chain: 'eip155:1', asset: 'C3', address: '0x00000000000000000000000000000000000000aa', token_contract: '0x00000000000000000000000000000000000000bb' }],
    note: 'Addresses declared by the exchange; balances are measured on chain by verifiers. Address-control proof is out of sandbox scope.',
  },
}, sampleTree, new Date('2026-11-16T01:02:03.456Z'));

const statementFile = path.join(OUT, 'statement.json');
const previous = existsSync(statementFile)
  ? JSON.parse(readFileSync(statementFile, 'utf8')) as { test_key: { private_pkcs8_pem: string; public_spki_base64: string }; signature: PorSignature }
  : null;
const pem = previous?.test_key.private_pkcs8_pem
  ?? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const key = createPrivateKey(pem);
const spki = publicSpkiBase64(key);
const signature = previous && verifySnapshotSignature(statement, previous.signature, spki)
  ? previous.signature
  : signSnapshotStatement(statement, key);
const tampered = JSON.parse(JSON.stringify(statement)) as PorSnapshotStatement;
tampered.totals[sample.assets[0]!] = '1';
write('statement.json', {
  about: 'The signed bytes are the UTF-8 of `signing_domain` followed by `canonical`; the signature is ECDSA P-256 over SHA-256, the 64 bytes r||s, base64url without padding. The commitment is SHA-256 over `commitment_domain` followed by `canonical`.',
  statement,
  canonical: jcsString(statement as never),
  commitment_domain: 'STONEHASH-POR-V1\n',
  commitment: porSnapshotCommitment(statement),
  signing_domain: 'stonehash:remit:event:v1\n',
  test_key: {
    warning: 'TEST KEY — published on purpose, registered nowhere. Never use it for anything else.',
    private_pkcs8_pem: pem,
    public_spki_base64: spki,
  },
  signature,
  submission: { schema: 'stonehash.por-submission.v1', statement, sig: signature },
  must_not_verify: [
    { why: 'a total in the statement was changed', statement: tampered, signature },
    { why: 'the signature was changed', statement, signature: { ...signature, sig: signature.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } },
  ],
});

// ── intake (CSV) ───────────────────────────────────────────────────────────
const longOpts = { assets: ASSETS3, amounts: 'decimal' as const };
const intakeCases: { name: string; file: string; text: string | Buffer; options: Omit<IntakeOptions, 'assets'> & { assets: typeof ASSETS3 } }[] = [
  { name: 'the long layout', file: 'intake/long.csv', text: readFileSync(path.join(SAMPLES, 'balances.long.csv')), options: longOpts },
  { name: 'the wide layout — the same ledger', file: 'intake/wide.csv', text: readFileSync(path.join(SAMPLES, 'balances.wide.csv')), options: longOpts },
  { name: 'CRLF, a byte-order mark, quoted fields, an extra column', file: 'intake/dialect.csv',
    text: '﻿account_id,asset,balance,updated_at\r\n"kim, 민수",BTC,"0.5",2026-11-16\r\n"say ""hi""",ETH,1,2026-11-16\r\n\r\nplain,USDT,2.5,x', options: longOpts },
  { name: 'columns under other names, semicolons, smallest units', file: 'intake/mapped.csv',
    text: 'USER_ID;currency;amount\nu1;BTC;50000000\nu2;USDT;7\n',
    options: { assets: ASSETS3, amounts: 'base', delimiter: ';', columns: { account: 'user_id', asset: 'currency', balance: 'amount' } } },
  { name: 'wide, with a column named as ignorable', file: 'intake/wide-ignore.csv',
    text: 'account_id,BTC,ETH,USDT,memo\nu1,1,,0.5,vip\nu2,,2,,\n', options: { ...longOpts, ignoreColumns: ['memo'] } },
  { name: 'every row has something wrong with it', file: 'intake/bad-rows.csv',
    text: ['account_id,asset,balance', 'u1,BTC,0.123456789', 'u2,BTC,-1', ' u3,BTC,1', ',BTC,1', 'u4,BTC', 'u5,BTC,1e3', 'u6,BTC,', 'u7,DOGE,1', 'u8,btc,1', 'u9,BTC,1', 'u9,BTC,2', 'ok,BTC,2'].join('\n') + '\n',
    options: longOpts },
  { name: 'wide: an unknown column, and a declared asset with no column', file: 'intake/bad-wide-header.csv',
    text: 'account_id,BTC,ETH,DOGE\nu1,1,1,5\n', options: longOpts },
  { name: 'wide: the same account twice', file: 'intake/bad-wide-duplicate.csv',
    text: 'account_id,BTC,ETH,USDT\nu1,1,1,1\nu1,2,2,2\n', options: longOpts },
  { name: 'no account column', file: 'intake/bad-header.csv', text: 'user,asset,balance\nu1,BTC,1\n', options: longOpts },
  { name: 'a header that matches neither layout', file: 'intake/bad-unrecognised.csv', text: 'account_id,currency,amount\nu1,BTC,1\n', options: longOpts },
  { name: 'an unpaired quote', file: 'intake/bad-quote.csv', text: 'account_id,asset,balance\nu1,BTC,"1\n', options: longOpts },
  { name: 'not UTF-8', file: 'intake/bad-encoding.csv',
    text: Buffer.concat([Buffer.from('account_id,asset,balance\n'), Buffer.from([0xb0, 0xa1]), Buffer.from(',BTC,1\n')]), options: longOpts },
  { name: 'a header and nothing else', file: 'intake/bad-empty.csv', text: 'account_id,asset,balance\n', options: longOpts },
];
// The balance sheet some exchanges already export: an equity and a debt column
// per asset. A list of its own, because a port may leave this layout out — and
// the ports written before it existed must go on passing `cases` untouched.
const sheetCases: typeof intakeCases = [
  { name: 'the sheet layout — the same ledger', file: 'intake/sheet.csv',
    text: readFileSync(path.join(SAMPLES, 'balances.sheet.csv')), options: longOpts },
  { name: 'sheet: a debt that is not zero is refused, however it is written', file: 'intake/bad-sheet-debt.csv',
    text: 'rn,id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT\n1,u1,1,0,,,2,0.00\n2,u2,2,0.5,,,,\n3,u3,3,,1,0.000000000000000001,,\n', options: longOpts },
  { name: 'sheet: the balance of an undeclared asset, and a column of no known kind', file: 'intake/bad-sheet-header.csv',
    text: 'id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT,e_DOGE,d_DOGE,note\nu1,1,0,1,0,1,0,5,0,x\n', options: longOpts },
  { name: 'sheet: a debt cell the amount rules cannot read', file: 'intake/bad-sheet-debt-format.csv',
    text: 'id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT\nu1,1,-0,,,,\nu2,1,x,,,,\nu3,1,0.000000001,,,,\n', options: longOpts },
  { name: 'two assets called e_x and d_x are a wide file, not a sheet', file: 'intake/wide-e-d-names.csv',
    text: 'account_id,e_x,d_x\nu1,1,2\nu2,,3\n',
    options: { assets: [{ symbol: 'e_x', decimals: 0 }, { symbol: 'd_x', decimals: 0 }] as never, amounts: 'decimal' } },
  { name: 'sheet: a declared asset with no equity column', file: 'intake/bad-sheet-missing.csv',
    text: 'id,e_BTC,d_BTC,e_ETH,d_ETH\nu1,1,0,1,0\n', options: longOpts },
];
// The same ledger as a JSON array of accounts, and the ways that shape goes wrong.
const jsonCases: { name: string; file: string; text: string }[] = [
  { name: 'accounts as JSON — the same ledger', file: 'intake/accounts.json', text: readFileSync(path.join(SAMPLES, 'accounts.json'), 'utf8') },
  { name: 'JSON: an amount given as a number, an undeclared asset, an account twice, a negative amount', file: 'intake/bad-accounts.json',
    text: JSON.stringify([
      { id: 'u1', assets: { BTC: 0.5 } }, { id: 'u2', assets: { DOGE: '1' } }, { id: 'u3', assets: { BTC: '1' } },
      { id: 'u3', assets: { ETH: '1' } }, { id: 'u4', assets: { USDT: '-1' } }, { assets: { BTC: '1' } }, 'u6',
    ], null, 1) + '\n' },
  { name: 'JSON: both spellings of a field, and a key written twice', file: 'intake/bad-accounts-ambiguous.json',
    text: '[\n {"id": "u1", "account_id": "u9", "assets": {"BTC": "1"}},\n {"id": "u2", "assets": {"BTC": "1"}, "balances": {"BTC": "2"}},\n'
      + ' {"id": "u3", "assets": {"BTC": "1", "ETH": "1", "BTC": "2"}},\n {"id": "u4", "id": "u5", "assets": {"BTC": "1"}},\n {"id": "u6", "assets": {"BTC": "3"}, "tier": "vip"}\n]\n' },
  { name: 'JSON: not an array', file: 'intake/bad-shape.json', text: '{"u1": {"BTC": "1"}}\n' },
  { name: 'JSON: not JSON', file: 'intake/bad-syntax.json', text: '[{"id": "u1", "assets": {"BTC": "1"}},\n' },
];
/**
 * `cases` were published before a row stopped carrying its zeros, and the
 * ports written against them compare rows as they stand. So there a row of
 * a one-row-per-account file is still written out in full — every declared
 * asset, "0" where the account holds none. It says the same thing either
 * way (§7 of SPEC.md): what changed is only how much the reference keeps in
 * memory for an exchange that lists hundreds of assets.
 */
function inFull(rows: LiabilityRow[], symbols: string[]): LiabilityRow[] {
  return rows.map((r) => ({ user_ref: r.user_ref, balances: Object.fromEntries(symbols.map((sym) => [sym, r.balances[sym] ?? '0'])) }));
}
async function intakeResults(cases: typeof intakeCases, o: { rowsInFull: boolean }): Promise<unknown[]> {
  const out = [];
  for (const c of cases) {
    writeText(c.file, c.text);
    const { rows, report } = await readLiabilitiesCsv(path.join(OUT, c.file), c.options);
    const options = {
      assets: c.options.assets, amounts: c.options.amounts,
      ...(c.options.layout ? { layout: c.options.layout } : {}),
      ...(c.options.columns ? { columns: c.options.columns } : {}),
      ...(c.options.ignoreColumns ? { ignore_columns: c.options.ignoreColumns } : {}),
      ...(c.options.delimiter ? { delimiter: c.options.delimiter } : {}),
    };
    out.push(report.ok
      ? { name: c.name, file: c.file, options, ok: true, layout: report.layout, data_rows: report.rows, accounts: report.accounts,
        zero_balance_accounts: report.zero_balance_accounts, totals: report.totals, holders: report.holders,
        ignored_columns: report.ignored_columns, file_sha256: report.input.sha256,
        rows: o.rowsInFull && report.layout !== 'long' ? inFull(rows, c.options.assets.map((a) => a.symbol)) : rows }
      : { name: c.name, file: c.file, options, ok: false, problems: report.problems.map((p) => ({ line: p.line, code: p.code })) });
  }
  return out;
}
const intakeOut = await intakeResults(intakeCases, { rowsInFull: true });
const sheetOut = await intakeResults(sheetCases, { rowsInFull: false });
const jsonOut = jsonCases.map((c) => {
  writeText(c.file, c.text);
  const { rows, report } = readAccountsJson(c.text, longOpts);
  const options = { assets: longOpts.assets, amounts: longOpts.amounts };
  return report.ok
    ? { name: c.name, file: c.file, options, ok: true, layout: report.layout, data_rows: report.rows, accounts: report.accounts,
      zero_balance_accounts: report.zero_balance_accounts, totals: report.totals, holders: report.holders,
      ignored_columns: report.ignored_columns, rows }
    : { name: c.name, file: c.file, options, ok: false, problems: report.problems.map((p) => ({ line: p.line, code: p.code })) };
});
write('intake.json', {
  about: 'Reading a balance export. `rows` are in order of first appearance; a file with any problem yields no rows. `line` is the 1-based line of the file, 0 for a problem with the file as a whole. In a row, an asset that is absent and an asset given as "0" say the same thing, and rows are compared with that in mind: `cases` (the long and wide layouts, which every port reads) write a wide row out in full, as they always have; `sheet_cases` and `json_cases` write only what the account holds. `sheet_cases` are for the sheet layout and `json_cases` for a JSON array of accounts, where `line` is the position of the account in the array, counted from one; a port may leave either reader out and skips its list.',
  cases: intakeOut,
  sheet_cases: sheetOut,
  json_cases: jsonOut,
});

// ── a whole snapshot directory, as the reference command line writes it ────
const dir = path.join(OUT, 'snapshot-dir');
rmSync(dir, { recursive: true, force: true });
execFileSync('node', [CLI, 'build', '--csv', path.join(SAMPLES, 'balances.long.csv'), '--amounts', 'decimal',
  '--assets', 'BTC:8,ETH:18,USDT:6', '--exchange', EXCHANGE, '--name', 'Sample Exchange',
  '--asof', '2026-11-16T00:00:00Z', '--seed-hex', SEED, '--tree-format', 'v1', '--out', dir]);
rmSync(path.join(dir, 'build-report.json'));
// `generated_at` is the time of the build; pin it so the directory, and so the commitment, is reproducible.
const snapPath = path.join(dir, 'snapshot.json');
const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as PorSnapshotStatement;
snap.generated_at = '2026-11-16T01:02:03.456Z';
writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n');
execFileSync('node', [CLI, 'prove', '--tree', dir, '--user-ref', 'U-100008', '--out', path.join(OUT, 'snapshot-dir.proof-U-100008.json')]);
execFileSync('node', [CLI, 'open', '--tree', dir, '--indices', '0,3,7', '--out', path.join(OUT, 'snapshot-dir.openings-0-3-7.json')]);
write('snapshot-dir.expected.json', {
  about: 'What any SDK must get from `snapshot-dir/`: load it, rebuild the tree from leaves.jsonl, and arrive at this root; then issue this proof and these openings.',
  exchange_id: EXCHANGE, seed_hex: SEED,
  root: snap.tree.root, totals: snap.totals, leaf_count: snap.tree.leaf_count,
  commitment: porSnapshotCommitment(snap),
  proof_file: 'snapshot-dir.proof-U-100008.json',
  openings_file: 'snapshot-dir.openings-0-3-7.json',
});

// The same directory in the v2 format, which is what the command line writes unless told otherwise.
const dir2 = path.join(OUT, 'snapshot-dir-v2');
rmSync(dir2, { recursive: true, force: true });
execFileSync('node', [CLI, 'build', '--csv', path.join(SAMPLES, 'balances.long.csv'), '--amounts', 'decimal',
  '--assets', 'BTC:8,ETH:18,USDT:6', '--exchange', EXCHANGE, '--name', 'Sample Exchange',
  '--asof', '2026-11-16T00:00:00Z', '--seed-hex', SEED, '--out', dir2]);
rmSync(path.join(dir2, 'build-report.json'));
const snap2Path = path.join(dir2, 'snapshot.json');
const snap2 = JSON.parse(readFileSync(snap2Path, 'utf8')) as PorSnapshotStatement;
snap2.generated_at = '2026-11-16T01:02:03.456Z';
writeFileSync(snap2Path, JSON.stringify(snap2, null, 2) + '\n');
execFileSync('node', [CLI, 'prove', '--tree', dir2, '--user-ref', 'U-100008', '--out', path.join(OUT, 'snapshot-dir-v2.proof-U-100008.json')]);
execFileSync('node', [CLI, 'prove', '--tree', dir2, '--user-ref', 'U-100012', '--out', path.join(OUT, 'snapshot-dir-v2.proof-U-100012.json')]);
execFileSync('node', [CLI, 'open', '--tree', dir2, '--indices', '0,3,7', '--out', path.join(OUT, 'snapshot-dir-v2.openings-0-3-7.json')]);
write('snapshot-dir-v2.expected.json', {
  about: 'What any SDK must get from `snapshot-dir-v2/` — the same ledger and seed as `snapshot-dir/`, in the v2 tree. `tree.json` names the format; a directory whose `tree.json` names none is v1. U-100012 holds nothing: its proof carries an empty balances object.',
  exchange_id: EXCHANGE, seed_hex: SEED, algo: snap2.tree.algo,
  root: snap2.tree.root, totals: snap2.totals, leaf_count: snap2.tree.leaf_count,
  commitment: porSnapshotCommitment(snap2),
  proof_files: ['snapshot-dir-v2.proof-U-100008.json', 'snapshot-dir-v2.proof-U-100012.json'],
  openings_file: 'snapshot-dir-v2.openings-0-3-7.json',
});

console.log(`wrote vectors → ${OUT}`);
