// Reads the rows table of testAmountsAreComparedDigitByDigit out of the Java test and maps each row with the
// reference: every row's "taken" and "outcome" must be what the reference answers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapSwiftPayment } from '../../../../../packages/attest-remit/src/index.ts';
import { payment } from './expect.ts';
// The Java test of this repository by default; another copy of it when its path is given.
const src = readFileSync(process.argv[2] ?? fileURLToPath(new URL('../../../src/test/java/com/stonehash/attest/remit/swift/SwiftMappingTest.java', import.meta.url)), 'utf8');
const body = src.slice(src.indexOf('static void testAmountsAreComparedDigitByDigit'), src.indexOf('List<String> failures', src.indexOf('static void testAmountsAreComparedDigitByDigit')));
/** A Java string literal's value: \uXXXX is replaced before anything else, as javac does. */
const java = (lit: string): string => {
  const pre = lit.replace(/(?<!\\)((?:\\\\)*)\\u([0-9a-fA-F]{4})/g, (_m, bs, hex) => bs + String.fromCharCode(parseInt(hex, 16)));
  return pre.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
};
const rows = [...body.matchAll(/\{("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\}/g)].map((m) => [java(m[1]!), java(m[2]!), java(m[3]!), java(m[4]!)]);
let bad = 0;
for (const [i, s, takenWant, outcomeWant] of rows) {
  const m = mapSwiftPayment(payment('pacs008', JSON.stringify({ instructedAmount: { currency: 'USD', value: i }, amount: { currency: 'USD', value: i }, settlementAmount: { currency: 'USD', value: s } })));
  const f = m.fields.find((x) => x.target === 'trade.amount');
  const issue = m.issues.find((x) => x.target === 'trade.amount');
  const src2 = f?.source ?? issue?.source;
  const taken = src2 === 'CdtTrfTxInf/InstdAmt' ? 'instructed' : src2 === 'CdtTrfTxInf/IntrBkSttlmAmt' ? 'settled' : String(src2);
  const outcome = f ? m.input!.tradeAmount : 'refused';
  const ok = taken === takenWant && outcome === outcomeWant && m.issues.length === (f ? 0 : 1);
  if (!ok) { bad++; console.log('MISMATCH', JSON.stringify([i, s]), 'java says', takenWant, outcomeWant, '— reference', taken, outcome, m.issues.length); }
}
console.log(`${rows.length} rows, ${bad} mismatches`);
