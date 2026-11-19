/**
 * Reading an exchange's export: the CSV dialect, the amount conversion and
 * the intake rules.
 *
 * These tests are about refusal as much as about reading. Everything here
 * feeds a liability total that is signed and anchored, so the cases that
 * matter most are the ones where a lenient reader would have produced a
 * number anyway: a ninth decimal place, a second row for the same account,
 * a column that might have been an asset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsvError, CsvParser } from '../src/csv.ts';
import type { CsvRecord } from '../src/csv.ts';
import { AmountError, fromBaseUnits, toBaseUnits } from '../src/amounts.ts';
import { LedgerBuilder, parseAssetSpecs, readLiabilitiesCsv } from '../src/intake.ts';
import type { IntakeOptions } from '../src/intake.ts';
import { checkCapacity } from '../src/limits.ts';

const parse = (text: string, delimiter = ','): CsvRecord[] => {
  const p = new CsvParser(delimiter);
  return [...p.push(text), ...p.end()];
};

test('csv: plain, quoted, escaped, CRLF, byte-order mark, blank lines', () => {
  assert.deepEqual(parse('a,b\n1,2\n').map((r) => r.fields), [['a', 'b'], ['1', '2']]);
  // The last record need not end in a line break.
  assert.deepEqual(parse('a,b\r\n1,2').map((r) => r.fields), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parse('﻿a,b\n').map((r) => r.fields), [['a', 'b']]);
  assert.deepEqual(parse('"x,1","say ""hi""",""\n').map((r) => r.fields), [['x,1', 'say "hi"', '']]);
  assert.deepEqual(parse('a\n\n\r\nb\n').map((r) => [r.line, r.fields[0]]), [[1, 'a'], [4, 'b']]);
  // A trailing delimiter is an empty last field, not a missing one.
  assert.deepEqual(parse('a,\n').map((r) => r.fields), [['a', '']]);
  assert.deepEqual(parse('a;b\n', ';').map((r) => r.fields), [['a', 'b']]);
});

test('csv: a record keeps the line it started on across quoted line breaks', () => {
  const recs = parse('h\n"two\nlines"\nnext\n');
  assert.deepEqual(recs.map((r) => [r.line, r.fields[0]]), [[1, 'h'], [2, 'two\nlines'], [4, 'next']]);
});

test('csv: what a spreadsheet would guess at is refused, with the line', () => {
  const fails = (text: string, line: number, re: RegExp): void => {
    assert.throws(() => parse(text), (e: unknown) => e instanceof CsvError && e.line === line && re.test(e.message), text);
  };
  fails('a,b\n1,2"3\n', 2, /inside an unquoted field/);
  fails('a\n"x"y\n', 2, /after a closing quote/);
  fails('a\n"never closed\nmore\n', 2, /ends inside a quoted field/);
  assert.throws(() => new CsvParser('"'), /delimiter/);
});

test('csv: the result does not depend on where the input was cut', () => {
  // Chunk boundaries inside CRLF, inside "", and after a closing quote are
  // where a streaming parser goes wrong; try every cut point.
  const text = '﻿id,note\r\n1,"a ""b"" c"\r\n2,"line\r\nbreak"\r\n\r\n3,plain';
  const whole = parse(text);
  assert.equal(whole.length, 4);
  for (let cut = 0; cut <= text.length; cut++) {
    const p = new CsvParser();
    const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut)), ...p.end()];
    assert.deepEqual(got, whole, `cut at ${cut}`);
  }
});

test('amounts: decimal values land exactly on the integer grid', () => {
  const d = (v: string, decimals: number): string => toBaseUnits(v, decimals, 'decimal');
  assert.equal(d('0.5', 8), '50000000');
  assert.equal(d('1', 8), '100000000');
  assert.equal(d('0', 8), '0');
  assert.equal(d('0.00000001', 8), '1');
  assert.equal(d('.5', 8), '50000000', 'what some databases print for one half');
  assert.equal(d(' 12.50 ', 2), '1250', 'padding around a number is not part of it');
  assert.equal(d('007.10', 2), '710');
  assert.equal(d('1234', 0), '1234');
  assert.equal(d('1234.000', 0), '1234');
  // A DECIMAL(36,18) column prints eighteen places for an eight-place asset.
  assert.equal(d('0.500000000000000000', 8), '50000000');
  assert.equal(d('123456789012345678901234567890.123456789012345678', 18), '123456789012345678901234567890123456789012345678');
});

test('amounts: anything that would need a decision is an error with a code', () => {
  const code = (v: string, decimals: number, unit: 'decimal' | 'base' = 'decimal'): string => {
    try { toBaseUnits(v, decimals, unit); } catch (e) { if (e instanceof AmountError) return e.code; throw e; }
    return 'accepted';
  };
  assert.equal(code('0.123456789', 8), 'amount_precision', 'a ninth place is value the tree cannot hold');
  assert.equal(code('0.1', 0), 'amount_precision');
  assert.equal(code('-1', 8), 'amount_negative');
  assert.equal(code('−1', 8), 'amount_negative', 'the typographic minus too');
  assert.equal(code('1e-8', 8), 'amount_exponent');
  assert.equal(code('1E5', 8), 'amount_exponent');
  assert.equal(code('1,000.5', 8), 'amount_grouping');
  assert.equal(code('1 000', 8), 'amount_grouping');
  assert.equal(code('', 8), 'amount_empty');
  assert.equal(code('   ', 8), 'amount_empty');
  assert.equal(code('5.', 8), 'amount_format');
  assert.equal(code('.', 8), 'amount_format');
  assert.equal(code('+5', 8), 'amount_format');
  assert.equal(code('abc', 8), 'amount_format');
  assert.equal(code('NaN', 8), 'amount_format');
  assert.equal(code('0x10', 8), 'amount_format');
  assert.equal(code('9'.repeat(80), 8), 'amount_too_long');
  // Declared as smallest units: a decimal point means the declaration is wrong.
  assert.equal(code('0.5', 8, 'base'), 'amount_fraction_in_base');
  assert.equal(code('50000000', 8, 'base'), 'accepted');
  assert.equal(toBaseUnits('00050', 8, 'base'), '50');
});

test('amounts: base units print back as the figure a person reads', () => {
  assert.equal(fromBaseUnits('50000000', 8), '0.5');
  assert.equal(fromBaseUnits('1', 8), '0.00000001');
  assert.equal(fromBaseUnits('0', 8), '0');
  assert.equal(fromBaseUnits('1234', 0), '1234');
  assert.equal(fromBaseUnits('114050000000000000001', 18), '114.050000000000000001');
  for (const v of ['0.5', '21.12345678', '0.00000001', '3']) {
    assert.equal(fromBaseUnits(toBaseUnits(v, 8, 'decimal'), 8), v);
  }
});

test('asset list: BTC:8,ETH:18 parses; mistakes are named', () => {
  assert.deepEqual(parseAssetSpecs('BTC:8, ETH:18,KRW:0').assets,
    [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'KRW', decimals: 0 }]);
  assert.match(parseAssetSpecs('BTC').problems.join(), /BTC:8/);
  assert.match(parseAssetSpecs('BTC:8,BTC:8').problems.join(), /twice/);
  assert.match(parseAssetSpecs('BTC:80').problems.join(), /decimal places/);
  assert.match(parseAssetSpecs('비트:8').problems.join(), /letters, digits/);
  assert.match(parseAssetSpecs('').problems.join(), /no assets/);
});

const ASSETS = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
const base: IntakeOptions = { assets: ASSETS, amounts: 'decimal' };

async function intake(text: string, o: Partial<IntakeOptions> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-intake-'));
  try {
    const file = path.join(dir, 'balances.csv');
    writeFileSync(file, text);
    return await readLiabilitiesCsv(file, { ...base, ...o });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const codes = (r: Awaited<ReturnType<typeof intake>>): string[] => r.report.problems.map((p) => `${p.line}:${p.code}`);

test('intake: the long layout — one row per account and asset', async () => {
  const r = await intake('account_id,asset,balance\nu1,BTC,0.5\nu1,ETH,2\nu2,USDT,10.25\nu3,BTC,0\n');
  assert.equal(r.report.ok, true);
  assert.equal(r.report.layout, 'long');
  assert.equal(r.report.rows, 4);
  assert.equal(r.report.accounts, 3);
  assert.equal(r.report.zero_balance_accounts, 1, 'an account with only zeros is still an account');
  assert.deepEqual(r.report.totals, { BTC: '50000000', ETH: '2000000000000000000', USDT: '10250000' });
  assert.deepEqual(r.report.holders, { BTC: 1, ETH: 1, USDT: 1 });
  assert.deepEqual(r.rows, [
    { user_ref: 'u1', balances: { BTC: '50000000', ETH: '2000000000000000000' } },
    { user_ref: 'u2', balances: { USDT: '10250000' } },
    { user_ref: 'u3', balances: { BTC: '0' } },
  ]);
  assert.match(r.report.input.sha256, /^[0-9a-f]{64}$/);
});

test('intake: the wide layout — one row per account, an empty cell is "holds none"', async () => {
  const r = await intake('account_id,BTC,ETH,USDT\nu1,0.5,2,\nu2,,,10.25\n');
  assert.equal(r.report.ok, true);
  assert.equal(r.report.layout, 'wide');
  assert.deepEqual(r.report.totals, { BTC: '50000000', ETH: '2000000000000000000', USDT: '10250000' });
  // A row carries what the account holds; an empty cell and a zero are both "holds none", and neither is kept.
  assert.deepEqual(r.rows[1], { user_ref: 'u2', balances: { USDT: '10250000' } });
});

test('intake: columns under other names are mapped, never guessed', async () => {
  const text = 'USER_ID,currency,amount,updated_at\nu1,BTC,1,2026-11-16\n';
  const mapped = await intake(text, { columns: { account: 'user_id', asset: 'currency', balance: 'amount' } });
  assert.equal(mapped.report.ok, true);
  assert.deepEqual(mapped.report.ignored_columns, ['updated_at'], 'in the long layout an extra column cannot hide a balance');
  // Unmapped, the same header matches neither layout; the message names both.
  const unmapped = await intake('user_id,currency,amount\nu1,BTC,1\n');
  assert.deepEqual(codes(unmapped), ['1:header_no_account']);
  const half = await intake('account_id,currency,amount\nu1,BTC,1\n');
  assert.deepEqual(codes(half), ['1:header_unrecognised']);
  assert.match(half.report.problems[0]!.message, /--col-asset/);
});

test('intake: nothing that could change a total is decided silently', async () => {
  // An asset nobody declared: an error, not a dropped row.
  const undeclared = await intake('account_id,asset,balance\nu1,DOGE,5\n');
  assert.deepEqual(codes(undeclared), ['2:unknown_asset']);
  assert.match(undeclared.report.problems[0]!.message, /left out of the totals/);
  // Letter case is not folded: "btc" may or may not be the declared BTC.
  assert.match((await intake('account_id,asset,balance\nu1,btc,5\n')).report.problems[0]!.message, /only by letter case/);
  // A second row for the same account and asset: an error, not a sum.
  assert.deepEqual(codes(await intake('account_id,asset,balance\nu1,BTC,1\nu1,ETH,1\nu1,BTC,2\n')), ['4:duplicate_row']);
  // In the wide layout an unknown column might be an asset.
  const wide = await intake('account_id,BTC,ETH,USDT,DOGE\nu1,1,1,1,5\n');
  assert.deepEqual(codes(wide), ['1:header_unknown_column']);
  assert.equal((await intake('account_id,BTC,ETH,USDT,memo\nu1,1,1,1,x\n', { ignoreColumns: ['memo'] })).report.ok, true);
  // …and a declared asset with no column would silently count as zero.
  assert.deepEqual(codes(await intake('account_id,BTC,ETH\nu1,1,1\n')), ['1:header_missing_asset']);
  assert.deepEqual(codes(await intake('account_id,BTC,ETH,USDT\nu1,1,1,1\nu1,2,2,2\n')), ['3:duplicate_account']);
});

test('intake: a file with any problem produces no rows, and reports every problem', async () => {
  const r = await intake([
    'account_id,asset,balance',
    'u1,BTC,0.123456789',     // 2 precision
    'u2,BTC,-1',              // 3 negative
    ' u3,BTC,1',              // 4 padded id
    ',BTC,1',                 // 5 empty id
    'u4,BTC',                 // 6 field count
    'u5,BTC,1e3',             // 7 exponent
    'u6,BTC,',                // 8 empty amount
    'u7,BTC,2',               // fine
  ].join('\n') + '\n');
  assert.equal(r.report.ok, false);
  assert.deepEqual(r.rows, [], 'never a tree from the rows that happened to parse');
  assert.deepEqual(codes(r), ['2:amount_precision', '3:amount_negative', '4:account_whitespace', '5:account_empty',
    '6:field_count', '7:amount_exponent', '8:amount_empty']);
  assert.equal(r.report.problem_count, 7);

  // The kept list is capped; the count is not.
  const many = await intake('account_id,asset,balance\n' + Array.from({ length: 30 }, (_, i) => `u${i},BTC,-1`).join('\n') + '\n', { maxProblems: 5 });
  assert.equal(many.report.problems.length, 5);
  assert.equal(many.report.problem_count, 30);
});

test('intake: identifiers are used byte for byte', async () => {
  // Quoted, with a comma and non-ASCII: the identifier is the field as written.
  const r = await intake('account_id,asset,balance\n"kim, 민수",BTC,1\n');
  assert.equal(r.rows[0]!.user_ref, 'kim, 민수');
  // A line break inside one would let it pass for another exchange's.
  assert.deepEqual(codes(await intake('account_id,asset,balance\n"a\nb",BTC,1\n')), ['2:account_control_character']);
  assert.deepEqual(codes(await intake(`account_id,asset,balance\n${'x'.repeat(300)},BTC,1\n`)), ['2:account_too_long']);
  // Keys that are special on a JavaScript object are ordinary identifiers here.
  const odd = await intake('account_id,asset,balance\n__proto__,BTC,1\nconstructor,BTC,2\n');
  assert.equal(odd.report.ok, true);
  assert.deepEqual(odd.rows.map((x) => x.user_ref), ['__proto__', 'constructor']);
});

test('intake: file-level failures are problems, not exceptions', async () => {
  assert.deepEqual(codes(await intake('')), ['0:empty_file']);
  assert.deepEqual(codes(await intake('account_id,asset,balance\n')), ['0:no_accounts']);
  assert.deepEqual(codes(await intake('account_id,asset,balance\nu1,BTC,"1\n')), ['2:csv_syntax']);
  assert.deepEqual(codes(await intake('account_id;asset;balance\nu1;BTC;1\n')), ['1:header_no_account']);
  assert.match((await intake('account_id;asset;balance\nu1;BTC;1\n')).report.problems[0]!.message, /--delimiter/);
  assert.equal((await intake('account_id;asset;balance\nu1;BTC;1\n', { delimiter: ';' })).report.ok, true);
  assert.deepEqual(codes(await intake('account_id,asset,asset\n')), ['1:header_duplicate']);
  // Not UTF-8 (CP949 "가"): refused rather than decoded into different identifiers.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-intake-'));
  try {
    const file = path.join(dir, 'cp949.csv');
    writeFileSync(file, Buffer.concat([Buffer.from('account_id,asset,balance\n'), Buffer.from([0xb0, 0xa1]), Buffer.from(',BTC,1\n')]));
    const r = await readLiabilitiesCsv(file, base);
    assert.deepEqual(r.report.problems.map((p) => `${p.line}:${p.code}`), ['0:file_encoding']);
    assert.match(r.report.problems[0]!.message, /UTF-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const capped = await intake('account_id,asset,balance\nu1,BTC,1\nu2,BTC,1\nu3,BTC,1\n', { maxAccounts: 2 });
  assert.deepEqual(codes(capped), ['0:too_many_accounts']);
});

test('intake: amounts declared as smallest units are whole numbers', async () => {
  const ok = await intake('account_id,asset,balance\nu1,BTC,50000000\n', { amounts: 'base' });
  assert.deepEqual(ok.report.totals, { BTC: '50000000', ETH: '0', USDT: '0' });
  assert.deepEqual(ok.report.assets_without_balance, ['ETH', 'USDT']);
  assert.deepEqual(codes(await intake('account_id,asset,balance\nu1,BTC,0.5\n', { amounts: 'base' })), ['2:amount_fraction_in_base']);
});

test('capacity: said before the work starts, against the memory this process may use', () => {
  const GB = 1024 ** 3;
  assert.equal(checkCapacity(100_000, 3, 4 * GB).ok, true);
  const big = checkCapacity(5_000_000, 3, 4 * GB);
  assert.equal(big.ok, false);
  assert.match(big.message!, /max-old-space-size/);
  // The cost follows what is held, not what is listed: a hundred listed assets
  // cost little when an account holds three of them, and a great deal when
  // every account holds every one (which is also what the v1 tree costs).
  const held3 = checkCapacity(100_000, 100, 4 * GB, 3).estimate_mb;
  assert.ok(held3 < 1.6 * checkCapacity(100_000, 3, 4 * GB).estimate_mb, `${held3} MB for 3 of 100`);
  assert.ok(checkCapacity(100_000, 100, 4 * GB).estimate_mb > 3 * held3);
  assert.equal(checkCapacity(300_000, 500, 4 * GB, 5).ok, true, 'the measured case: 300,000 accounts holding five of 500');
  // One million accounts with three assets is the measured case; it has to fit the default heap.
  assert.equal(checkCapacity(1_000_000, 3, 4 * GB).ok, true);
  assert.equal(checkCapacity(1_000_000, 30, 4 * GB).ok, false);
  assert.ok(checkCapacity(0, 3, 4 * GB).max_accounts > 1_000_000);
});

test('ledger builder: rows straight from a query follow the rules of the file, with no file', async () => {
  // The same ledger three ways: the sample file, long rows from code, wide rows from code.
  const fromFile = await readLiabilitiesCsv(path.resolve(import.meta.dirname, '../samples/balances.long.csv'), base);
  assert.equal(fromFile.report.ok, true);

  const text = readFileSync(path.resolve(import.meta.dirname, '../samples/balances.long.csv'), 'utf8');
  const lines = text.trim().split('\n').slice(1).map((l) => l.split(','));
  const a = new LedgerBuilder(base);
  for (const [id, asset, amount] of lines) a.add(id!, asset!, amount!);
  const viaAdd = a.finish();
  assert.equal(viaAdd.report.ok, true);
  assert.deepEqual(viaAdd.rows, fromFile.rows, 'the same rows as the file gave');
  assert.deepEqual(viaAdd.report.totals, fromFile.report.totals);
  assert.equal(viaAdd.report.rows, 20);

  const byAccount = new Map<string, Record<string, string>>();
  for (const [id, asset, amount] of lines) byAccount.set(id!, { ...(byAccount.get(id!) ?? {}), [asset!]: amount! });
  const b = new LedgerBuilder(base);
  for (const [id, balances] of byAccount) b.addAccount(id, balances);
  const viaAccount = b.finish();
  assert.deepEqual(viaAccount.report.totals, fromFile.report.totals);
  assert.equal(viaAccount.report.accounts, 12);
});

test('ledger builder: a refused row is a problem at the ordinal of the call, and the ledger yields nothing', () => {
  const l = new LedgerBuilder(base);
  assert.equal(l.add('u1', 'BTC', '0.5'), true);
  assert.equal(l.add('u1', 'BTC', '1'), false);                    // 2 duplicate_row
  assert.equal(l.add(' u2', 'BTC', '1'), false);                   // 3 account_whitespace
  assert.equal(l.add('u3', 'DOGE', '1'), false);                   // 4 unknown_asset
  assert.equal(l.add('u4', 'ETH', '0.0000000000000000001'), false); // 5 amount_precision
  assert.equal(l.addAccount('u5', { BTC: '1', DOGE: '5', SHIB: '9' }), false); // 6 unknown_asset, both named
  assert.equal(l.addAccount('u1', { ETH: '1' }), false);           // 7 duplicate_account: u1 already has a value
  assert.equal(l.addAccount('u6', new Map([['USDT', '-3']])), false); // 8 amount_negative
  assert.equal(l.addAccount('u7', { BTC: '', USDT: '2.5' }), true);   // an empty value is "holds none"
  assert.equal(l.add('u7', 'USDT', '1'), false);                   // 10 duplicate_row: u7 was given whole
  assert.equal(l.add('u7', 'BTC', '1'), false);                    // 11 duplicate_row: even for an asset it holds none of
  const { rows, report } = l.finish();
  assert.deepEqual(rows, []);
  assert.deepEqual(report.problems.map((p) => `${p.line}:${p.code}`), [
    '2:duplicate_row', '3:account_whitespace', '4:unknown_asset', '5:amount_precision',
    '6:unknown_asset', '7:duplicate_account', '8:amount_negative', '10:duplicate_row', '11:duplicate_row',
  ]);
  assert.match(report.problems[4]!.message, /"DOGE", "SHIB" are not declared assets/);
  assert.equal(report.rows, 11);

  assert.deepEqual(new LedgerBuilder(base).finish().report.problems.map((p) => `${p.line}:${p.code}`), ['0:no_accounts']);
  const fine = new LedgerBuilder(base);
  fine.addAccount('only', { USDT: '2.5' });
  // What is held, and nothing written for what is not.
  assert.deepEqual(fine.finish().rows, [{ user_ref: 'only', balances: { USDT: '2500000' } }]);
});
