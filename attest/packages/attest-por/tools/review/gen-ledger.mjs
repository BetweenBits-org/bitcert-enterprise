// node gen-ledger.mjs <accounts> <listed> <held> <out.csv> [assets-file] [wide|long]
//
// The ledgers behind the "Verified sizes" table of the balance-file guide: each row of that table is
// `measure.mjs` (beside this file) run on such a file.
// Every account holds `held` of the `listed` assets (the first two are common to all, as a stable-coin and
// a major are). `long` (the default) writes one row per account and asset; `wide` writes the standard
// shape, one row per account with a column per listed asset.
import { createWriteStream, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const [accounts, listed, held, out, assetsFile, shape = 'long'] = process.argv.slice(2);
const N = Number(accounts), A = Number(listed), K = Number(held);
let seed = 20261117;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const w = createWriteStream(out);
w.write(shape === 'wide' ? `account_id,${Array.from({ length: A }, (_, a) => `A${a}`).join(',')}\n` : 'account_id,asset,balance\n');
let rows = 0;
for (let i = 0; i < N; i++) {
  const mine = new Set(K >= A ? Array.from({ length: A }, (_, a) => a) : [0, 1].slice(0, Math.min(2, K)));
  while (mine.size < Math.min(K, A)) mine.add(2 + Math.floor(rnd() * (A - 2)));
  let chunk = '';
  if (shape === 'wide') {
    const cells = new Array(A).fill('');
    for (const a of mine) cells[a] = (rnd() * 1000).toFixed(8);
    chunk = `U-${1000000 + i},${cells.join(',')}\n`;
    rows++;
  } else {
    for (const a of mine) { chunk += `U-${1000000 + i},A${a},${(rnd() * 1000).toFixed(8)}\n`; rows++; }
  }
  if (!w.write(chunk)) await once(w, 'drain');
}
w.end();
await once(w, 'finish');
if (assetsFile) writeFileSync(assetsFile, 'symbol,decimals\n' + Array.from({ length: A }, (_, a) => `A${a},8`).join('\n') + '\n');
console.log(JSON.stringify({ accounts: N, listed: A, held: K, rows }));
