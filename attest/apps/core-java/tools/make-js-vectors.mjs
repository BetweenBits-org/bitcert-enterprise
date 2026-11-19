/**
 * Vectors that hold `com.stonehash.attest.core.json.Js` to JavaScript:
 * JSON.parse, JSON.stringify (compact and with two spaces), String(number),
 * Number(string), trim().
 *
 *   node apps/core-java/tools/make-js-vectors.mjs          write src/test/resources/vectors/js-json.json
 *   node apps/core-java/tools/make-js-vectors.mjs --check  fail when the file on disk differs
 *
 * Text under test is stored as the hex of its UTF-16 code units, so that the
 * vector file itself is plain ASCII and reading it proves nothing about the
 * reader being tested. Nothing here is random at run time: the "random"
 * numbers come from a fixed seed, so every run writes the same file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/js-json.json');
const check = process.argv.includes('--check');

const hex16 = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('');
const bitsOf = (d) => { const b = Buffer.alloc(8); b.writeDoubleBE(d); return Number.isNaN(d) ? '7ff8000000000000' : b.toString('hex'); };
const fromBits = (h) => Buffer.from(h, 'hex').readDoubleBE();

// ── JSON.parse / JSON.stringify ─────────────────────────────────────────────

const texts = [
  // values of every kind
  '{}', '[]', '""', '0', '-0', 'true', 'false', 'null', '[null]', '{"a":null}', ' \t\n\r {"a" : [ 1 , 2 ] } \r\n',
  '{"a":1,"b":[true,false,null,"x",{"c":{}},[]],"d":{"e":[[],[[]],{}]}}',
  // numbers
  '1', '-1', '1.5', '-1.5', '1e3', '1E3', '1e+3', '1e-3', '1.0', '1.50', '0.1', '0.30000000000000004', '100', '1e21', '1e20', '123456789012345678901234567890',
  '1e-7', '0.000001', '0.0000001', '5e-324', '1.7976931348623157e308', '1e999', '-1e999', '2e-400', '9007199254740993', '0.1e1', '12345678901234567890',
  '4.35', '0.000035', '1.005', '123456.789e3', '0e0', '-0.0', '0E+00',
  // not numbers
  '01', '-', '+1', '1.', '.5', '1e', '1e+', '0x10', 'NaN', 'Infinity', '-Infinity', '1_000', '1 2', '--1', '1.e3', '00', '-01', '１',
  // strings
  '"abc"', '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\u0041\\u00e9\\ud83d\\ude00"', '"\\ud800"', '"\\udc00x"', '"a\\ud800\\ud800\\udc00b"', '"é😀  \u007f"',
  '"\\u00"', '"\\uD83D"', '"\\x41"', '"\\a"', '"a\nb"', '"a\tb"', '"unterminated', '"\\', "'single'", '"\\u004g"', '"\\uＡ０００"', '"\u0000"', '"\u001f"', '" "',
  '"\\u0000\\u0001\\u001f\\u007f\\u0080\\u2028\\ufeff"', '"<script>&\'"',
  // objects: order, duplicates, names
  '{"b":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"2":"two","b":1,"1":"one","a":2,"0":"zero"}', '{"10":1,"9":2,"01":3,"1.5":4,"-1":5,"4294967294":6,"4294967295":7,"4294967296":8}',
  '{"__proto__":1,"constructor":2,"toString":3}', '{"a":{"2":1,"1":2},"b":[{"1":1,"0":0}]}', '{"":1}', '{"a":1,"a":{"b":2}}', '{"1":1,"1":2,"0":3}',
  '{"\\u0061":1,"a":2}', '{"é":1,"😀":2}',
  // not objects
  '{', '}', '{"a"}', '{"a":}', '{"a":1,}', '{,}', '{a:1}', '{"a":1 "b":2}', '{"a":1,,"b":2}', '{1:2}', '{"a":1}}',
  // arrays
  '[1,2,3]', '[[[[[[[[[[]]]]]]]]]]', '[1,[2,[3,[4]]]]', '[ ]', '[,]', '[1,]', '[1 2]', '[', ']', '[1,,2]',
  // around the value
  '', ' ', '﻿{}', '{}﻿', '{} {}', 'nul', 'tru', 'truee', 'null null', 'undefined', ' {}', '{}\u000b', ' []',
  // a little depth, well inside any limit
  '['.repeat(200) + ']'.repeat(200), '{"a":'.repeat(100) + '1' + '}'.repeat(100),
];
const parse = texts.map((text) => {
  try {
    const v = JSON.parse(text);
    return { text: hex16(text), ok: true, compact: hex16(JSON.stringify(v)), pretty: hex16(JSON.stringify(v, null, 2)) };
  } catch {
    return { text: hex16(text), ok: false };
  }
});

// ── String(number) ──────────────────────────────────────────────────────────

const numbers = new Map();
const note = (d) => { if (!Number.isNaN(d)) numbers.set(bitsOf(d), String(d)); };
[0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 0.5, 1.5, 100, 1e21, 1e20, 1e22, 123456789012345680000, 1e-6, 1e-7, 1.5e-7, 0.000001234, 5e-324, 2.2250738585072014e-308,
  2.225073858507201e-308, 1.7976931348623157e308, Infinity, -Infinity, 2 ** 53, 2 ** 53 - 1, 2 ** 53 + 2, 2 ** 63, 2 ** 64, -(2 ** 63), 4.35, 0.000035, 1.005,
  9.5e-7, 9.999999e20, 9.9999999999999999e20, 1.7976931348623157e308, 4.9e-324, 1 / 3, 2 / 3, Math.PI, Math.E, 1e15, 1e16, 1e17, 123456789.123456789, 0.1 + 0.7,
  5e-7, 0.00001, 12345678.9, 1.0000000000000002, 0.9999999999999999, 8.41e21, 2.5e-5, 1e100, 1.1e-10].forEach(note);
for (let e = -330; e <= 310; e++) { note(Number(`1e${e}`)); note(Number(`9.5e${e}`)); note(Number(`1.2345e${e}`)); }
for (let p = -1074; p <= 1023; p += 1) { const d = 2 ** p; note(d); if (p % 7 === 0) { note(d * (1 + 2 ** -52)); note(d * (1 - 2 ** -53)); } }
for (let i = 1; i <= 2000; i++) { note(i / 100); note(i / 1000); note(i * 1e17); note(i / 7); }
{
  // A fixed seed: the same bit patterns on every run.
  let seed = 0x9e3779b9;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 6000; i++) {
    const b = Buffer.alloc(8); b.writeUInt32BE(next(), 0); b.writeUInt32BE(next(), 4);
    note(b.readDoubleBE());
  }
  for (let i = 0; i < 3000; i++) {
    const digits = 1 + (next() % 17);
    let s = ''; for (let k = 0; k < digits; k++) s += String(next() % 10);
    note(Number(`${s}e${(next() % 60) - 30}`));
  }
}
const numberCases = [...numbers.entries()].map(([bits, text]) => ({ bits, text }));
for (const c of numberCases) if (String(fromBits(c.bits)) !== c.text) throw new Error(`bits do not read back: ${c.bits}`);

// ── Number(string), trim ────────────────────────────────────────────────────

const numeric = ['', ' ', '0', '-0', '+0', '12', ' 12 ', '\t12\n', '12.5', '12.', '.5', '-.5', '+.5e1', '1e3', '1E3', '1e+3', '1e-3', '1e', 'e3', '1e3.5', '0x10', '0X1f', '0x', '0xg',
  '-0x10', '+0x10', '0o17', '0O17', '0o8', '0b101', '0B101', '0b2', '0b', 'Infinity', '+Infinity', '-Infinity', 'infinity', 'INFINITY', 'Infinity ', 'NaN', 'nan', '1f', '1d', '1L',
  '0x1p3', '1_000', '1,000', '1 000', '１２', '٣', '12abc', 'abc', '--1', '+-1', '1..2', '1.2.3', ' 12 ', '﻿7', '​7', ' 7', '7　', '᠎7', '\u00857',
  '1e1000', '-1e1000', '1e-1000', '9007199254740993', '0.1', '00012', '-00012.50', '0x7fffffffffffffffffff', '0b' + '1'.repeat(70), '25', '2.5', '-1', '100.9', '1e2', '0.99', '1.0e0',
  '25abc', 'limit', 'true', 'null', '[]', '{}', '0.', '.', '+', '-', '. 5', '5 .', '1e 3', '\n', '\r\n12\r\n', '+12', '- 12'];
const toNumber = numeric.map((text) => ({ text: hex16(text), bits: bitsOf(Number(text)) }));
const trims = ['', ' ', ' a ', '\ta\n', ' a ', '﻿a﻿', ' a ', '　a ', '  a  ', '​a​', '\u0085a\u0085', '᠎a', 'a b', '\u000b\u000ca\r',
  ' NOTPROVIDED\n', '\u001fa\u001f', '\u0000a'];
const trim = trims.map((text) => ({ text: hex16(text), trimmed: hex16(text.trim()) }));
const keys = ['', '0', '1', '01', '10', '-1', '1.5', '4294967294', '4294967295', '4294967296', '99999999999', 'a', '1a', ' 1', '00', '９', '2147483648', '1e3', '0x1'];
const arrayIndex = keys.map((key) => ({ key: hex16(key), index: Object.keys({ zzz: 0, [key]: 1 })[0] === key && key !== 'zzz' }));

// ── Date.toISOString ────────────────────────────────────────────────────────

const instants = [0, 1, 999, 1000, 1763337600000, 1763337600001, 1763337600010, 1763337600100, 1763337599999, 946684800000, 951782400000, 4102444799999, 253402300799999,
  86399999, 1700000000000, 1709251199999, 1709251200000, -1, -62135596800000];
const times = instants.map((ms) => ({ ms, text: new Date(ms).toISOString() }));

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-js-vectors.mjs from Node itself. Do not edit by hand. Text is the hex of UTF-16 code units.',
  node: process.version.split('.')[0],
  parse, numbers: numberCases, toNumber, trim, arrayIndex, times,
}, null, 0)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('js-json.json differs from what Node answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`js-json.json is current (${parse.length} texts, ${numberCases.length} numbers)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${parse.length} texts (${parse.filter((c) => c.ok).length} parse), ${numberCases.length} numbers, `
    + `${toNumber.length} Number(), ${trim.length} trim, ${arrayIndex.length} keys, ${times.length} times, ${(text.length / 1000).toFixed(0)} kB`);
}
