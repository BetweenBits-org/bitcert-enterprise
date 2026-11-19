/**
 * Writes the baseline migration from a dump of the live schema.
 *
 *   node apps/core-java/tools/make-baseline.mjs <live.json> [--check]
 *
 * The tables are written as the server itself states them (SHOW CREATE
 * TABLE), in an order in which every table follows the tables it refers to.
 * The one thing left out is the running value of an AUTO_INCREMENT counter:
 * that is data, not structure. The previous service created these tables as
 * it started, a table or a column at a time, so what counts is the schema it
 * left — not the statements in its source.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/main/resources/db/migration/mysql/V1__baseline.sql');
const args = process.argv.slice(2);
const check = args.includes('--check');
const dump = JSON.parse(readFileSync(args.find((a) => !a.startsWith('--')), 'utf8'));

const refs = new Map(dump.creates.map((c) => [c.table, new Set()]));
for (const f of dump.fks) if (f.rt !== f.t) refs.get(f.t).add(f.rt);
const ordered = [];
const left = dump.creates.map((c) => c.table).sort();
while (left.length > 0) {
  const at = left.findIndex((t) => [...refs.get(t)].every((r) => ordered.includes(r)));
  if (at < 0) throw new Error(`tables refer to each other in a circle: ${left.join(', ')}`);
  ordered.push(left.splice(at, 1)[0]);
}
const ddl = new Map(dump.creates.map((c) => [c.table, c.ddl.replace(/ AUTO_INCREMENT=\d+/, '')]));
const text = `-- Version 1: the schema as the service this one replaces left it.
--
-- Taken from the live schema with SHOW CREATE TABLE (tools/dump-schema.mjs,
-- tools/make-baseline.mjs) — ${dump.creates.length} tables, MySQL ${dump.server.version.split('-')[0]}, utf8mb4_bin.
-- Do not edit: a schema built from this file is compared with the live one,
-- catalogue row by catalogue row (tools/compare-schema.mjs), and has to be
-- the same. On the live schema this version is not run; it is recorded as
-- already there (the baseline step). Everything after it is a migration of
-- its own.
--
-- Times are text columns holding UTC with milliseconds and a Z
-- (2026-11-18T06:00:00.000Z), compared and sorted as text.

${ordered.map((t) => `${ddl.get(t)};`).join('\n\n')}
`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('V1__baseline.sql differs from the dump given — the live schema has changed since the baseline was written; that change is a new migration, not an edit of version 1');
    process.exit(1);
  }
  console.log(`V1__baseline.sql is what the dump states (${ordered.length} tables)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${ordered.length} tables: ${ordered.join(' ')}`);
}
