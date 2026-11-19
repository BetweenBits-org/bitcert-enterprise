/**
 * Are two schemas the same structure? Compares two dumps (tools/dump-schema.mjs)
 * catalogue row by catalogue row: tables, columns, indexes, foreign keys, checks.
 *
 *   node apps/core-java/tools/compare-schema.mjs <expected.json> <actual.json>
 *
 * The table Flyway keeps its own record in is left out, and so is the name
 * of the schema. Tables that migrations after the baseline added
 * (tools/added-by-migrations.json) are set aside and named: the question
 * here is whether the tables the live schema has are the same — a table this
 * service added is an addition, not a difference. Any other table that only
 * one side has is a difference. Exit status 1 when anything differs.
 */
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const ADDED = JSON.parse(readFileSync(new URL('./added-by-migrations.json', import.meta.url), 'utf8')).tables;
const OWN = new Set(['flyway_schema_history', ...Object.keys(ADDED)]);
const rows = (dump, kind, key) => new Map(dump[kind].filter((r) => !OWN.has(r.t)).map((r) => [key(r), JSON.stringify(r)]));
const added = [...new Set([...a.tables, ...b.tables].map((r) => r.t).filter((t) => t in ADDED))].sort();
const kinds = [
  ['tables', (r) => r.t], ['columns', (r) => `${r.t}.${r.c}`], ['statistics', (r) => `${r.t}.${r.i}#${r.seq}`],
  ['fks', (r) => `${r.t}.${r.n}#${r.pos}`], ['checks', (r) => `${r.t}.${r.n}`],
];
let differences = 0;
const counts = [];
for (const [kind, key] of kinds) {
  const x = rows(a, kind, key);
  const y = rows(b, kind, key);
  for (const [k, v] of x) {
    if (!y.has(k)) { differences++; console.log(`${kind}: ${k} is missing — expected ${v}`); } else if (y.get(k) !== v) { differences++; console.log(`${kind}: ${k} differs\n  expected ${v}\n  actual   ${y.get(k)}`); }
  }
  for (const k of y.keys()) if (!x.has(k)) { differences++; console.log(`${kind}: ${k} is not expected — ${y.get(k)}`); }
  counts.push(`${x.size} ${kind}`);
}
if (JSON.stringify(a.schema) !== JSON.stringify(b.schema)) { differences++; console.log(`schema defaults differ: ${JSON.stringify(a.schema)} / ${JSON.stringify(b.schema)}`); }
console.log(differences === 0 ? `the same structure: ${counts.join(', ')} (${a.database} / ${b.database})${added.length ? `; added by migrations: ${added.join(', ')}` : ''}` : `${differences} difference(s) between ${a.database} and ${b.database}`);
process.exit(differences === 0 ? 0 : 1);
