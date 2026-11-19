/**
 * Two runs of tools/check-anchoring.mjs — one through the reference service,
 * one through the Java service — compared in what does not depend on timing:
 * how many records, that all are confirmed and all bundles verify, one anchor
 * transaction per batch, the shape of every kind of row (which columns hold
 * a value, of what kind) and of every bundle (its keys, in order).
 *
 *   node apps/core-java/tools/compare-anchoring.mjs <reference.json> <java.json>
 *
 * How the records fell into batches is not compared: that depends on when a
 * cycle of the worker met a burst of requests. The rule behind it is checked
 * by each run itself (order of arrival), and exactly — the same batches from
 * the same records — by tools/compare-sealing.mjs.
 */
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const differences = [];
const walk = (x, y, where) => {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${where}.${k}`);
    return;
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    for (const v of x) if (!y.includes(v)) differences.push(`${where}: only the reference has\n    ${v}`);
    for (const v of y) if (!x.includes(v)) differences.push(`${where}: only the Java service has\n    ${v}`);
    return;
  }
  differences.push(`${where}: reference ${JSON.stringify(x)}, Java ${JSON.stringify(y)}`);
};
walk(a.summary, b.summary, 'summary');
for (const d of differences) console.log(d);
const kinds = Object.values(a.summary.shapes).reduce((n, v) => n + v.length, 0);
console.log(`${a.schema} / ${b.schema}: ${a.summary.records} records each, ${kinds} kinds of row and ${a.summary.bundleKeys.length} kinds of bundle compared — `
  + `${differences.length === 0 ? 'the same' : `${differences.length} difference(s)`} (batches fell ${a.timing.batchSizes.join('+')} / ${b.timing.batchSizes.join('+')})`);
process.exit(differences.length === 0 ? 0 : 1);
