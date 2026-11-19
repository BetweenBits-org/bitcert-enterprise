// The same ledger written four ways — long CSV, wide CSV, sheet CSV, JSON — must read to the same totals and
// build to the same root. Random ledgers, deterministic from the seed in the file.  node equiv.mjs
import { CsvLedgerReader, readAccountsJson, buildPorTree, leafFromRow, estimateTreeFigures } from '../../src/index.ts';
let seedState = 20261117;
const rnd = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const POOL = ['BTC', 'ETH', 'USDT', 'btc', '1INCH', '1000SATS', 'BTC.b', 'USD-C', 'constructor', 'toString', 'valueOf', 'A_B', '007', '42', 'x'.repeat(32), 'T001', 'wBTC', 'stETH', 'a', 'Z'];
const REFS = ['U-', 'acct-', '김민수-', 'user "q" ', 'a,b ', '😀', 'x-y', '__proto__', 'constructor'];
const q = (s) => (/[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s);
const seed = Buffer.alloc(32, 9);
let cases = 0, mismatches = [], underEstimates = [];
for (let c = 0; c < 260; c++) {
  const nAssets = 1 + Math.floor(rnd() * 40);
  const symbols = [];
  while (symbols.length < nAssets) { const s = rnd() < 0.5 ? pick(POOL) : 'S' + Math.floor(rnd() * 1e6).toString(36); if (!symbols.some((x) => x.toLowerCase() === s.toLowerCase())) symbols.push(s); }
  const assets = symbols.map((symbol) => ({ symbol, decimals: pick([0, 2, 6, 8, 8, 18, 36]) }));
  const nAcc = 1 + Math.floor(rnd() * 200);
  const accounts = [];
  const seen = new Set();
  for (let i = 0; i < nAcc; i++) {
    let ref = (pick(REFS) + i).trim();
    if (rnd() < 0.02) ref = pick(['__proto__', 'constructor', 'toString']);
    if (seen.has(ref)) ref = ref + '#' + i;
    seen.add(ref);
    const bal = Object.create(null);   // an asset may be called `constructor`: the harness must not answer with Object's
    for (const a of assets) {
      const r = rnd();
      if (r < 0.55) continue;                       // not held: absent / empty cell
      if (r < 0.62) { bal[a.symbol] = pick(['0', '0.0', '00']).slice(0, a.decimals === 0 ? 1 : 99); continue; }
      const whole = String(Math.floor(rnd() * 10 ** pick([1, 3, 9, 15])));
      const fracLen = Math.floor(rnd() * (a.decimals + 1));
      let frac = ''; for (let k = 0; k < fracLen; k++) frac += Math.floor(rnd() * 10);
      bal[a.symbol] = frac ? whole + '.' + frac : whole;
    }
    accounts.push({ ref, bal });
  }
  const o = { assets, amounts: 'decimal' };
  const long = ['account_id,asset,balance', ...accounts.flatMap((a) => (Object.keys(a.bal).length ? Object.entries(a.bal).map(([s, v]) => [q(a.ref), s, v].join(',')) : [[q(a.ref), symbols[0], '0'].join(',')]))].join('\n') + '\n';
  const wide = ['account_id,' + symbols.join(','), ...accounts.map((a) => [q(a.ref), ...symbols.map((s) => a.bal[s] ?? '')].join(','))].join('\r\n');
  const sheet = ['rn,id,' + symbols.flatMap((s) => ['e_' + s, 'd_' + s, s, 'vl_' + s, 'm_' + s, 'pm_' + s]).join(',') + ',total_net_balance_usdt',
    ...accounts.map((a, i) => [i, q(a.ref), ...symbols.flatMap((s) => [a.bal[s] ?? '', pick(['0', '', '0.0']).slice(0, 1), a.bal[s] ?? '0', '0', '0', '0']), '1.5'].join(','))].join('\n');
  const json = JSON.stringify(accounts.map((a) => ({ id: a.ref, assets: a.bal })));
  const read = (text, layout) => { const r = new CsvLedgerReader({ ...o, ...(layout ? { layout } : {}) }); r.pushText(text); return r.end(); };
  const got = { long: read(long), wide: read(wide), sheet: read(sheet), json: readAccountsJson(json, o) };
  const summary = Object.fromEntries(Object.entries(got).map(([k, r]) => {
    if (!r.report.ok) return [k, { bad: r.report.problems.slice(0, 2) }];
    const leaves = r.rows.map((row) => leafFromRow('EX-1', seed, row));
    const tree = buildPorTree(leaves, symbols);
    let figures = 0; for (const level of tree.levels) for (const n of level) figures += Object.keys(n.sums).length;
    const held = r.rows.reduce((n, row) => n + Object.values(row.balances).filter((v) => v !== '0').length, 0) / r.rows.length;
    if (figures > estimateTreeFigures(r.rows.length, symbols.length, held) * 1.0001 + 1) underEstimates.push([c, k, figures, estimateTreeFigures(r.rows.length, symbols.length, held)]);
    return [k, { layout: r.report.layout, accounts: r.report.accounts, zero: r.report.zero_balance_accounts, totals: r.report.totals, holders: r.report.holders, root: tree.root }];
  }));
  cases++;
  const ref = JSON.stringify({ ...summary.wide, layout: 0 });
  for (const k of ['long', 'sheet', 'json']) if (JSON.stringify({ ...summary[k], layout: 0 }) !== ref) mismatches.push([c, k, JSON.stringify(summary[k]).slice(0, 300), ref.slice(0, 200)]);
  if (summary.long.layout !== 'long' || summary.wide.layout !== 'wide' || summary.sheet.layout !== 'sheet' || summary.json.layout !== 'json') mismatches.push([c, 'layout', JSON.stringify(Object.values(summary).map((x) => x.layout ?? x.bad))]);
}
console.log(JSON.stringify({ cases, mismatches: mismatches.length, first: mismatches.slice(0, 3), estimate_below_actual: underEstimates.length, e: underEstimates.slice(0, 3) }));
process.exit(mismatches.length === 0 && underEstimates.length === 0 ? 0 : 1);
