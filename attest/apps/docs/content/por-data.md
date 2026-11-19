# Proof of Reserves: Preparing the Balance File

You export one balance file from your ledger and hand it to the SDK, and the
snapshot is anchored — the call is under "Anchoring a snapshot" in
[Proof of Reserves](#por). This page is about that file: what shape it has to
be in, how to export it from your ledger, what counts as a balance, how you
are told when something is wrong with it, and what you keep once it has been
anchored.

The balance file and your accounts never leave your server. The platform is
not sent the ledger and does not connect to your database. What it receives
is the statement (root, per-asset totals, number of accounts) and its
signature.

To look at a file before wiring anything up, put it into the **Proof of
Reserves** screen of the console. The browser reads it with the same code,
builds the root and has it anchored, and the file is not uploaded. That
screen takes up to 100,000 accounts; a larger ledger is anchored from your
own server with the SDK.

## File format

A UTF-8 file. **The standard is a CSV with one row per account and one
column per asset.**

```
account_id,BTC,ETH,USDT
U-100001,0.50000000,12.5,
U-100002,,,1500.25
```

The first column is `account_id`; every other column is named by an asset's
symbol. An asset the account does not hold is an empty cell, or 0. If you are
writing a new export, write this one — the example is
`samples/balances.wide.csv` in the SDK.

A file you already export in another shape can be used as it is. The three
shapes below are read too, and one ledger gives the same root whichever shape
it is exported in. A CSV is told apart by its header row, or stated with the
option `layout: 'wide' | 'long' | 'sheet'` (`wide` is the standard shape).
There is an example of each in the SDK's `samples/`.

**Long CSV — one row per account and asset**

```
account_id,asset,balance
U-100001,BTC,0.50000000
U-100001,ETH,12.5
U-100002,USDT,1500.25
```

What a single `GROUP BY` gives from a database.

**Sheet CSV — one row per account, a balance and a debt column per asset**

```
id,e_BTC,d_BTC,e_ETH,d_ETH,e_USDT,d_USDT
U-100001,0.50000000,0,12.5,0,,0
U-100002,,0,,0,1500.25,0
```

If you already export a balance sheet with a balance and a debt side by side
for every asset, that file can be used as it is. A header that has both
`e_<asset>` and `d_<asset>` for one asset is read as this shape.

- The account column is `account_id`, or `id` when there is none.
- `e_<asset>` is the balance in that asset.
- `d_<asset>` (the debt) must be empty or zero on every row. One row where it
  is not, and the file is refused with `debt_not_supported` — a debt is
  neither subtracted from the balance nor passed over ("What counts as a
  balance" below).
- The other columns of an asset (`<asset>`, `vl_<asset>`, `m_<asset>`,
  `pm_<asset>`) and `rn` and `total_net_balance_usdt` are not read, and are
  reported as skipped.

**JSON — an array of accounts** (a file whose name ends in `.json` is read as this)

```json
[
  {"id": "U-100001", "assets": {"BTC": "0.50000000", "ETH": "12.5"}},
  {"id": "U-100002", "assets": {"USDT": "1500.25"}}
]
```

- An amount is a **string**. A JSON number (`0.5`) is refused with
  `amount_not_text` — a number cannot carry every digit of a balance, and
  nothing would say which digits were lost.
- The account is named by `id` (or `account_id`) and its balances by `assets`
  (or `balances`). An account that gives both spellings is refused rather
  than one being picked.
- A name written twice in one object is refused with `json_duplicate_key`. A
  JSON reader keeps the last value, so the earlier balance would drop out
  without a word.
- An asset the account does not hold need not be written. Any other field is
  skipped and reported.
- A problem is located by the account's position in the array, not by a line
  number.
- The whole file is read at once. For millions of accounts, CSV is the shape.

| Item | Rule |
|---|---|
| `account_id` | The identifier you can tell the customer. Used exactly as written; leading or trailing whitespace is refused, because trimming it would make a different identifier. Up to 256 bytes, no line breaks or control characters |
| Asset symbol | The name of an asset's column (in the long shape, the value under `asset`) must match a symbol in `assets`, letter case included. An asset that is not listed is an error — dropping it silently would lower the total |
| Amount | A number, zero or above. How it is written is always stated with `amounts` (below) |
| One account | One row (in the long shape, one row per account and asset). A second is an error — whether they add up is decided in your query |
| Empty cell | "Holds none" (0). In the long shape, an error |
| Other columns | Only columns named in `ignoreColumns` are ignored, because an unnamed column might be an asset. The long shape ignores other columns and reports them |
| Delimiter and quotes | Comma. Another delimiter with `delimiter` (`'\t'` for a tab). A value containing a comma is wrapped in double quotes |

**How amounts are written — `amounts` cannot be left out.** Whether `1`
means one bitcoin or one satoshi is something only your ledger knows.

| Value | How the file writes it | Example (0.5 BTC) |
|---|---|---|
| `decimal` | A decimal in the unit people read | `0.5`, `0.50000000` |
| `base` | A whole number of the smallest unit | `50000000` |

The conversion is exact or it is refused. Nothing is rounded or truncated — a
non-zero digit below the asset's precision (`0.123456789` BTC) is an error.
Exponent notation (`1e-8`), grouping separators (`1,000`) and negative values
are errors too.

If the account column has another name, name it rather than editing the file:
`columns: { account: 'user_id' }` (and, for the long shape,
`asset: 'currency'` and `balance: 'amount'`).

**The asset list.** Exchanges list different assets, so the list is yours to
state. A symbol starts with a letter or digit and is made of letters, digits,
`.`, `_` and `-`, up to 32 characters (`BTC`, `1INCH`, `BTC.b`); decimal
places run from 0 to 36. A few are written out in the code; dozens or
hundreds are kept in a file and read from it
(`assets: readAssetList('assets.csv')`):

```
symbol,decimals
BTC,8
ETH,18
USDT,6
```

The list has to cover every asset in the file — an asset that is not listed
is an error. The other way round is fine: an asset nobody holds may be listed
(outside the long shape its column has to be there, empty or not). It
appears in the statement with a total of 0, and the root is the same whether
it is listed or not.

## Exporting from your ledger

The platform does not connect to your database. Export a result of this shape
to CSV with the database client you already use. Table and column names, and
the three assets, are placeholders for your own.

```sql
-- PostgreSQL
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT btrim(user_id::text) AS account_id,
       SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END)::text AS "BTC",
       SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END)::text AS "ETH",
       SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END)::text AS "USDT"
FROM balances
GROUP BY user_id;
COMMIT;
```

```sql
-- MySQL / MariaDB
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION WITH CONSISTENT SNAPSHOT;
SELECT TRIM(CAST(user_id AS CHAR)) AS account_id,
       CAST(SUM(CASE WHEN currency = 'BTC'  THEN available + locked ELSE 0 END) AS CHAR) AS BTC,
       CAST(SUM(CASE WHEN currency = 'ETH'  THEN available + locked ELSE 0 END) AS CHAR) AS ETH,
       CAST(SUM(CASE WHEN currency = 'USDT' THEN available + locked ELSE 0 END) AS CHAR) AS USDT
FROM balances
GROUP BY user_id;
COMMIT;
```

An asset column has to be named exactly as the symbol is written in
`assets`, letter case included. PostgreSQL lower-cases a column name that
is not quoted, hence `"BTC"`. With too many assets to write the SELECT list
by hand, generate the query from the asset list — or export one row per
account and asset (the long shape) instead: that takes no asset list, a
single `GROUP BY user_id, currency`, and is read as it is. That query, and
the ones for Oracle and SQL Server, are in the SDK's
`samples/export-queries.sql`.
Whatever the database, the query has four things to keep.

1. **One row per account.** Several wallets of one customer are summed in
   the query (`GROUP BY`).
2. **Everything you owe back.** A balance locked in an open order or waiting
   for a withdrawal is still the customer's (`available + locked`).
3. **Amounts as text.** A floating-point type on the way out changes digits.
4. **One point in time.** Run the whole export in a single consistent-read
   transaction and write that time as `asof`.

## What counts as a balance

What is a liability is yours to decide; record the rule you decide on. The
SDK adds up the file it is given and judges nothing.

- **Negative balances** are refused. Settle or exclude a margin debt or an
  overdrawn account by your own rule before exporting. The SDK does not turn
  it into zero for you.
- **Zero balances** are accepted as they are. Include a zero-balance account
  and that customer can confirm they are "in, at zero"; leave it out and no
  proof can be issued to them.
- **Debt** is not subtracted. A snapshot states what each account is owed,
  not what is left after its borrowings. The debt columns of a sheet file
  must be zero for every account, and one account where they are not refuses
  the whole file. Proving a netted figure would mean proving, account by
  account, that the collateral covers the loan — which a hash tree alone
  cannot show.
- **An account that is not in the file** is not in the root. The root speaks
  only for what the file holds.

## When something is wrong with the file

A root is never built from a file with a problem in it. `anchorBalanceFile`
writes nothing and sends nothing; it throws `PorLedgerError`, and the error's
`report.problems` has, for each problem, the line (`line`), a code (`code`)
and what is wrong (`message`). To check a file without anchoring it, only
read it:

```ts
import { fromBaseUnits, readLiabilitiesCsv } from './packages/attest-por/src/index.ts';

const assets = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
const { report } = await readLiabilitiesCsv('packages/attest-por/samples/balances.wide.csv', { assets, amounts: 'decimal' });

console.log(report.ok, report.layout, report.accounts);          // true 'wide' 12
for (const a of assets) console.log(a.symbol, fromBaseUnits(report.totals[a.symbol] ?? '0', a.decimals), report.holders[a.symbol]);
for (const p of report.problems) console.log(p.line, p.code, p.message);
```

**Compare the totals with your ledger's.** These figures go into the
statement as they are, and are signed. A JSON file is read with
`readLiabilitiesJson`, and a problem in it is located by the account's
position in the array instead of a line number.

| Code | Meaning | What to do |
|---|---|---|
| `amount_precision` | More precise than the asset's decimal places | Check the places in `assets`, or the ledger value |
| `amount_negative` | Negative | Settle or exclude by your rule, then export |
| `amount_exponent` · `amount_grouping` · `amount_format` | Exponent notation, grouping separator, not a number | Export the amount column as text |
| `amount_fraction_in_base` | A decimal point under `base` | `amounts: 'decimal'` |
| `unknown_asset` | An asset not in `assets` | Add it to the list, or exclude it in the query |
| `duplicate_row` · `duplicate_account` | The same account (and asset) twice | Sum in the query |
| `account_whitespace` · `account_empty` | Padding around the identifier, empty identifier | `TRIM` in the query |
| `header_*` | The header matches no layout, a column for an asset that is not listed, or a listed asset with no column | Rename the columns, or state them with `columns` and `layout` |
| `debt_not_supported` | Sheet layout: an account whose debt (`d_`) is not zero | "What counts as a balance" above |
| `amount_not_text` | JSON: an amount written as a number | Export amounts as strings |
| `json_syntax` · `json_shape` · `json_duplicate_key` | Not JSON, not an array of accounts, a name written twice in one object | Compare with the JSON example under "File format" |
| `csv_syntax` | Unpaired quote | Export again as CSV |
| `file_encoding` | Not UTF-8 | Export again as UTF-8 |
| `too_large` (the error's `code`) | More than the memory this run may use | "Verified sizes" below |


## What you keep: the proof file and the balance file

Anchoring leaves **one proof file** (at the path given as `proofFile`, mode
0600). What you keep is that file and the balance file that was anchored,
unchanged — those two, and nothing else. The proof file the console's Proof
of Reserves screen hands back is in the same format, so the SDK opens it as
its own, and a proof file the SDK wrote can be checked against its balance
file on the console's Verify screen.

| In the proof file | What it is |
|---|---|
| `statement` · `sig` · `snapshot_id` | The statement that was signed and submitted, its signature, and the id the platform gave the snapshot |
| `seed` | The 32-byte seed the per-account salts are derived from — **the one secret in the file** |
| `source` | The balance file's name, size and SHA-256, the shape it was read in (`layout`) and how amounts are written (`amounts`) |

It holds no account and no balance, but it holds the seed: keep it where the
balance file is kept, and do not publish it. **Lose either file and no
customer proof can be issued for that snapshot again** — the anchored root
stays valid and nobody can check themselves against it. Put both in your
backups.

With both, the snapshot is rebuilt as it was ("Issuing a customer's proof" in
[Proof of Reserves](#por)). An account identifier goes into the tree as a
hash, and its balances are hashed together with a per-account salt — the
formulas:

```
user_ref_hash = SHA256("STONEHASH-POR-USER-V1\n" + exchange_id + "\n" + account_id)
salt          = HMAC-SHA256(seed, account_id)
```

The tree writes only the balances accounts actually hold (`tree.algo` in the
statement: `merkle-sum-sha256-v2`). A zero balance, and an asset nobody
holds, take up no room in it, so with hundreds of listed assets the size of
the tree follows the number of balances held. Snapshots in the earlier format
(`merkle-sum-sha256-v1`), and the directory an earlier version of the SDK
left for each snapshot (`leaves.jsonl` and the rest), go on being accepted,
verified and read (`loadTreeDir`).

## Verified sizes

The tree is built in memory. What it needs follows the number of accounts and
the number of balances they actually hold — an asset that is listed but
rarely held costs next to nothing.

| Assets listed | Held per account (average) | Accounts accepted (about) — Node's default memory setting |
|---|---|---|
| 3 | 3 (all) | 1,050,000 |
| 50 | 4 | 740,000 |
| 500 | 5 | 540,000 |
| 500 | 20 | 250,000 |

These are the estimate the SDK makes before it starts; an input over the
limit is refused before any work is done (`PorLedgerError`,
`code: 'too_large'`). What has been measured (a 16 GB server, files in the
standard shape):

| Ledger | Balance file | The anchoring call | Opening the snapshot again | Peak memory | One customer proof |
|---|---|---|---|---|---|
| 1,000,000 accounts · 3 assets, all held | 46 MB | 63 s | 61 s | 2.9 GB | 4 kB |
| 300,000 accounts · 500 assets, 5 held each | 163 MB | 37 s | 40 s | 2.1 GB | 146 kB |
| 100,000 accounts · 500 assets, 20 held each | 71 MB | 28 s | 29 s | 1.4 GB | 153 kB |
| 100,000 accounts · 500 assets, 5 held each | 54 MB | 12 s | 13 s | 1.1 GB | 122 kB |
| 100,000 accounts · 3 assets, all held | 5 MB | 5 s | 6 s | 0.7 GB | 3 kB |

"The anchoring call" runs from reading the file to writing the proof file,
network time left out. "Opening the snapshot again" is rebuilding the tree
from the two files; once it is open, a customer's proof takes under a second.
Peak memory is for one process making both calls in turn. The same ledger exported with one row per account and asset (the long shape) is a much smaller file (163 MB → 39 MB at 500 assets and 300,000 accounts) and takes about as long. A
customer's proof carries a subtotal per asset along its path, so with
hundreds of assets one runs past a hundred kilobytes. Running Node with a
higher memory limit (`--max-old-space-size`) raises what is accepted by as
much. Beyond 300,000 accounts at 500 assets the figures are estimates, not
measurements.
