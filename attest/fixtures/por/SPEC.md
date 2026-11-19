# Proof of Reserves — exchange-side specification

What an exchange-side SDK has to do, byte for byte, so that the root it
computes, the statement it signs and the proofs it issues are the ones the
platform and every other SDK arrive at. The reference implementation is
`@stonehash/attest-por` (TypeScript); the vectors beside this file are what it
produces. Where prose and vectors seem to disagree, the vectors are right and
the prose is a bug to report.

Conventions: `‖` is byte concatenation. `utf8(x)` is the UTF-8 encoding of a
string. Hashes are written as 64 lowercase hex characters. All integers that
carry value are **decimal strings**, never JSON numbers and never floats.

Two words are used with one fixed meaning throughout, because every language's
own notion of them differs slightly and a difference changes which files are
accepted:

- **whitespace** is exactly this set of code points: U+0009–U+000D, U+0020,
  U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000,
  U+FEFF. "Trimmed" means with those removed from both ends.
- **ignoring case** means the letters `A`–`Z` are treated as `a`–`z`, and
  nothing else is folded.

## 1. Canonical JSON (`JCS`)

The subset of RFC 8785 this protocol uses. Vectors: `jcs.json`.

- `null`, `true`, `false` as those words.
- Numbers: integers only, within ±(2^53 − 1), in plain decimal (`0`, `-1`,
  `9007199254740991`). A number with a fraction, an exponent, or outside that
  range is an **error**, not something to format.
- Strings: `"` + content + `"`. Escape exactly these: `"` as `\"`, `\` as
  `\\`, U+0008 `\b`, U+0009 `\t`, U+000A `\n`, U+000C `\f`, U+000D `\r`, and
  every other code point below U+0020 as `\u00xx` with lowercase hex. Nothing
  else is escaped: `/`, U+007F, U+2028, U+2029 and all non-ASCII characters
  are written as themselves.
- Arrays: `[` elements joined by `,` `]`, order kept.
- Objects: `{` members joined by `,` `}`; each member is the key (as a string,
  same escaping) `:` the value. Members are sorted by key, comparing **UTF-16
  code units** (so an astral character, which is two surrogates starting at
  D800–DBFF, sorts before U+E000). No whitespace anywhere.
- The bytes hashed or signed are the UTF-8 encoding of that text.

## 2. Amounts

A balance in the tree is a non-negative integer in the asset's smallest unit,
as a decimal string with no leading zeros (`"0"` for zero). An asset is
declared with its number of decimal places, 0 to 36.

Exported text becomes such a string by an exact conversion or not at all.
Vectors: `amounts.json`. Input is first trimmed. Then, in this order:

| Condition | Error code |
|---|---|
| empty | `amount_empty` |
| longer than 62 characters | `amount_too_long` |
| starts with `-` or `−` (U+2212) | `amount_negative` |
| contains `e` or `E` | `amount_exponent` |
| contains `,`, whitespace, `_` or `'` | `amount_grouping` |

Unit `base` (the file holds smallest units): digits only → strip leading zeros.
Matching `^\d*\.\d*$` instead → `amount_fraction_in_base`. Anything else →
`amount_format`.

Unit `decimal` (the file holds the unit people read): must match
`^(\d*)(?:\.(\d+))?$` with at least one digit overall, else `amount_format`
(so `.5` is accepted, `5.` and `+5` are not). Let `whole` be the first group
(`"0"` if empty) and `fraction` the second (empty if absent). If any character
of `fraction` beyond the first `decimals` characters is not `0` →
`amount_precision`. Result: `whole ‖ fraction[0:decimals] right-padded with
"0" to decimals`, leading zeros stripped.

## 3. Accounts and assets

- An asset symbol matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$` and is matched
  exactly, letter case included.
- An account reference (`user_ref`) is used byte for byte. It must be
  non-empty, have no leading or trailing whitespace, contain no code point
  below U+0020 and no U+007F, and be at most 256 bytes of UTF-8.

## 4. Leaves

Vectors: `leaves.json`.

```
user_ref_hash = SHA256( utf8("STONEHASH-POR-USER-V1\n" + exchange_id + "\n" + user_ref) )
salt          = HMAC-SHA256( key = seed (32 bytes), message = utf8(user_ref) )
leaf.hash     = SHA256( utf8("STONEHASH-POR-LEAF-V1\n") ‖ salt (32 bytes) ‖ user_ref_hash (32 bytes) ‖ JCS(balances) )
leaf.sums     = balances
```

`balances` here is the account's balances **as the tree format writes them**
(§5): in v1 an object with one member for every asset of the snapshot, `"0"`
where the account holds none; in v2 an object with a member only for each
asset the account holds — no member is ever `"0"`, and an account holding
nothing has `{}`.
`seed` is 32 random bytes chosen once per snapshot and kept by the exchange.
The salt rule is the SDK's convention (the statement records it in `params`);
verification needs only the salt itself.

## 5. The tree

Vectors: `trees.json` (v1), `trees-v2.json` (v2).

**Two formats.** They hash identically and differ only in what is written
for an asset that is not held.

| | `merkle-sum-sha256-v1` | `merkle-sum-sha256-v2` |
|---|---|---|
| a leaf's `balances` | every asset of the snapshot, `"0"` included | only the assets held; never a `"0"` |
| a node's `sums` | every asset, `"0"` included | only the assets whose sum is not zero |
| the empty node's `sums` | `"0"` for every asset | `{}` |
| `tree.padding` in the statement | `empty-zero` | `empty` |

v2 is what a new snapshot is built in. v1 is what the first snapshots were
built in; it stays readable and verifiable, and an SDK builds it only when
asked. The reason for v2 is cost: an exchange lists hundreds of assets while
an account holds a few, and v1 wrote a figure for every listed asset in every
node. In v2 a root is a function of what is held: declaring more assets that
nobody holds, or declaring them in another order, does not change it (the
last case of `trees-v2.json` pins this). In both formats the totals of the
same ledger are the same; the roots differ.

The steps below are for both; where they say "sums" they mean the format's.

1. Refuse an empty ledger. Refuse two leaves with the same `user_ref_hash`.
2. Sort the leaves ascending by `user_ref_hash` (hex strings; the same order
   as their bytes). The position in this order is the leaf's `leaf_index`.
3. Fold level by level until one node remains. At a level with an odd number
   of nodes, append one **empty node** first:
   `empty.hash = SHA256( utf8("STONEHASH-POR-EMPTY-V1") )` (no newline),
   `empty.sums` = `"0"` for every asset (v1), or `{}` (v2).
4. `node.hash = SHA256( utf8("STONEHASH-POR-NODE-V1\n") ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums) )`,
   `node.sums[a] = L.sums[a] + R.sums[a]`, exact, as decimal strings — in v1
   for every asset, in v2 for every asset present in `L.sums` or `R.sums`
   (balances are never negative, so such a sum is never zero).
5. The last node is the root: `root = node.hash`. `totals` is the root's sums
   with a member for **every** asset of the snapshot — in v2 the assets
   nobody holds are added as `"0"`, so the statement says zero out loud.
   `leaf_count` counts real leaves, not padding. A single leaf is its own root.

**Inclusion proof** for leaf `i`:

```json
{ "leaf_index": 7,
  "leaf": { "user_ref_hash": "…", "salt": "…", "balances": { "BTC": "…", "ETH": "0" } },
  "siblings": [ { "hash": "…", "sums": { … }, "dir": "left" | "right" }, … ] }
```

`leaf.balances` is written as the tree's format writes it (so in v2 the
example above would carry no `"ETH": "0"`). `siblings` runs from the leaf level upward, one
per level below the root; at each level the sibling is the node at index
`at XOR 1` (it may be the empty node), `dir` says which side the **sibling**
is on (`left` when its index is lower), then `at = floor(at / 2)`.

**Verification** against a declared `root` and `totals`: recompute the leaf
hash; for each sibling at level `k`, require `dir == "left"` exactly when bit
`k` of `leaf_index` is 1, require its hash to be 64 lowercase hex and its sums
to be non-negative integer strings, and fold (`sibling, node` when the sibling
is on the left; `node, sibling` otherwise). The proof holds only if the final
hash equals `root` **and** every asset's final sum equals `totals` (an asset
missing on either side counts as `"0"`). Vectors include proofs that must fail.

An asset is whatever the exchange calls it within the symbol rule of §3 —
including names a programming language's objects already answer to
(`constructor`, `toString`). "Missing" therefore means the object does not
itself have that member; an implementation must not let an inherited one
stand in for a balance. One name is refused wherever balances or sums are
read: `__proto__`.

## 6. The snapshot statement

Vectors: `statement.json`.

```json
{ "schema": "stonehash.por-snapshot.v1",
  "exchange": { "institution_id": "…", "name": "…" },
  "asof": "2026-11-16T00:00:00Z",
  "assets": [ { "symbol": "BTC", "decimals": 8 }, … ],
  "tree": { "algo": "merkle-sum-sha256-v2", "leaf_count": 12, "root": "…", "padding": "empty" },
  "totals": { "BTC": "…", … },
  "params": { "user_ref_hash": "sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)",
              "salt": "hmac-sha256(master_seed, user_ref)" },
  "reserves": { "mode": "DECLARED", "entries": [ { "chain": "…", "asset": "…", "address": "…", "token_contract": "…" } ], "note": "…" },
  "generated_at": "2026-11-16T01:02:03.456Z" }
```

`assets` keeps the declared order. `asof` is the instant the ledger was read,
as the exchange wrote it (any ISO 8601 instant). `generated_at` is when the
statement was built, UTC with milliseconds and `Z`. The two `params` strings
are fixed text, written exactly as above (the `\\n` in this JSON is a
backslash followed by `n` in the string). `reserves` is optional; when
present, each entry has string `chain`, `asset`, `address` and optionally
string `token_contract`, and `note` is the fixed sentence in the vector.
`leaf_count` is at most 2147483647.

```
commitment = SHA256( utf8("STONEHASH-POR-V1\n") ‖ JCS(statement) )
```

**Signature.** ECDSA over P-256 with SHA-256, over
`utf8("stonehash:remit:event:v1\n") ‖ JCS(statement)`. The signature travels
as the 64 bytes `r ‖ s` (each 32 bytes, big-endian — not DER), base64url
without padding, in an envelope:

```json
{ "alg": "ES256", "key_id": "<institution_id>", "issuer": "<exchange name>", "sig": "<base64url>" }
```

The platform verifies against the public key registered for the exchange
(SubjectPublicKeyInfo DER, base64). Because the signature and the commitment
are over `JCS(statement)`, re-indenting or re-ordering a statement file
changes neither.

**The file that is sent** (`submission.json`):

```json
{ "schema": "stonehash.por-submission.v1", "statement": { … }, "sig": { … } }
```

## 7. Reading a balance export (CSV)

Vectors: `intake.json` with the files under `intake/`. Its `cases` are the
long and wide layouts, which every port reads; `sheet_cases` and `json_cases`
are for the two readers a port may leave out (below), and a port without one
skips that list.

The shape an exchange is guided to is the wide layout — one row per account,
one column per asset (`intake/` and `samples/balances.wide.csv`). That is a
matter of what the guide and the console show first: the reader takes every
layout below on equal terms, and one ledger gives one root in any of them.

**A row** is an account and what it is owed: `{ "user_ref", "balances" }`,
`balances` in base units. An asset that is absent from `balances` and an
asset given as `"0"` say the same thing — the tree is the same either way
(§4) — so a port may produce either, and compares rows with that in mind.
`cases` write a wide row out in full, every declared asset with `"0"` where
the account holds none, as they did when they were first published; the two
newer lists write only what the account holds.

**Dialect.** UTF-8 (a leading byte-order mark is skipped); a file that is not
valid UTF-8 is the problem `file_encoding` at line 0. Records end in LF or
CRLF. A line with nothing on it is skipped. A field may be wrapped in double
quotes and may then contain the delimiter, line breaks and `""` for a quote.
Outside quotes a `"` is an error; so is any character other than the
delimiter or a line end after a closing quote; so is a file that ends inside
quotes. Those are `csv_syntax` — at the line of the offending character for
the first two, at the line where the record began for the third — and
reading stops there, keeping the problems found so far. The delimiter is `,`
unless stated. `line` is 1-based and counts physical lines.

**Header** (the first record; names are trimmed and compared ignoring case;
standard names `account_id`, `asset`, `balance`, each of which the caller may
rename):

1. an empty name → `header_empty_name`; a repeated name → `header_duplicate`;
2. no account column → `header_no_account`;
3. layout, when the caller did not state it: **long** if both the asset and
   balance columns are present; else **wide** if any other column equals a
   declared asset symbol ignoring case; else **long** if one of the two is
   present; else `header_unrecognised`;
4. long: a missing asset or balance column → `header_missing_column`. Other
   columns are ignored and reported.
5. wide: every column other than the account must equal a declared asset
   exactly, or be in the caller's ignore list (compared ignoring case); each
   other column → `header_unknown_column`, in column order. Then each
   declared asset with no column → `header_missing_asset`, in declared order —
   except an asset whose only near-match differs by letter case, which was
   already reported as an unknown column.

A header problem ends interpretation: no row is examined.

**Rows**, each checked in this order, the first failure ending that row:

Long: wrong number of fields → `field_count`; account (§3) →
`account_empty`, `account_whitespace`, `account_control_character`,
`account_too_long`; asset cell (trimmed) not declared → `unknown_asset`; the
account already has a row for that asset → `duplicate_row`; the amount (§2) →
its code. A row whose amount is refused still counts as that account's row
for that asset.

Wide: `field_count`; the account checks; the account already has an accepted
row → `duplicate_account`; then every asset cell in column order — an empty
cell (after trimming) is `"0"`, anything else is converted (§2), and each
refusal is reported. The row is accepted only if every cell was.

**After the rows:** a header and no account → `no_accounts` at line 0; no
header at all → `empty_file` at line 0.

**Rows from code, with no file.** An SDK also takes rows straight from the
exchange's own database query, through a ledger builder with two calls:
`add(account, asset, amount)` — the long row — and
`addAccount(account, { asset: amount, … })` — the wide row. They apply the row
checks above, unchanged, with two differences. `line` is the 1-based ordinal
of the call (every call counts, whichever form it used). And the wide form
has no header to have caught an undeclared asset, so after the account and
duplicate checks a map containing any key that is not a declared asset is one
`unknown_asset` problem for that row (naming the keys in ascending order);
an asset absent from the map, or present with an empty value, is `"0"`. The
two forms may be mixed: a long row for a pair that already has a value is
`duplicate_row`, and a wide row for an account that already has any value is
`duplicate_account`. With no accepted account at the end: `no_accounts`.

**Result.** If there is any problem, there are no rows: nothing is built from
a file that did not read cleanly. Otherwise the rows are the accounts in order
of first appearance, each with the balances it was given — long: one member
per row of the file; every form with one row per account (wide, sheet, JSON,
`addAccount`): a member only for each amount that is not zero — plus totals
per asset and the SHA-256 of the file's bytes. An account given whole, on one
row, is complete: a later long row for it is `duplicate_row` whichever asset
it names.

**The sheet layout** (`sheet_cases` in `intake.json`: `intake/sheet.csv`, the
`bad-sheet-*` files and `wide-e-d-names.csv`). Some
exchanges already export, for a proof of reserves of their own, one row per
account with a group of columns per asset: `e_<asset>` (what the account is
owed), `d_<asset>` (what it has borrowed), and others. That file is read as
it is:

- It is recognised, when no layout is stated, by a header that has both
  `e_<x>` and `d_<x>` for some `<x>`, is not a long header, and in which
  neither of those two columns is itself the name of a declared asset (two
  assets called `e_x` and `d_x` are a wide file). The prefixes are compared
  ignoring case; `<x>` is compared exactly, like every asset symbol.
- The account column is `account_id`, or `id` when there is no `account_id`
  and the caller named no column of its own.
- `e_<asset>` for a declared asset is that asset's balance, read by the same
  amount rules as a wide cell. `e_<x>` for an undeclared `<x>` is one
  `header_unknown_column`; the other columns of that `<x>` are not reported
  again. A declared asset with no `e_` column is `header_missing_asset`.
- `d_<asset>` for a declared asset must say "none" on every row. An empty
  cell says so; any other cell is read by the amount rules of §2, with the
  asset's decimals: a cell they refuse is that refusal (its code, the message
  beginning `<asset> debt: `), and a cell that reads to anything but `"0"` is
  the problem `debt_not_supported` for that row. A debt is neither
  subtracted nor ignored.
- `<asset>`, `vl_<asset>`, `m_<asset>`, `pm_<asset>` for a declared asset,
  and `rn` and `total_net_balance_usdt`, are skipped and listed among the
  ignored columns. Any other column is `header_unknown_column` unless the
  caller named it as ignorable. A column named as ignorable is skipped
  whatever it is; when it is the `e_<x>` of an undeclared `<x>`, that asset is
  left out on purpose and its other columns are skipped and listed with it.

**Accounts as JSON** (`json_cases` in `intake.json`). A file that is a JSON
array of `{ "id": "<account>", "assets": { "<asset>": "<amount>", … } }`
(`account_id` and `balances` are read as well) is the same ledger as the wide
layout and is fed to `addAccount` in array order; `line` is the position in
the array, counted from one. Not JSON → `json_syntax` at 0; not an array →
`json_shape` at 0; an element that is not an object, an `id` that is not a
string, `assets` that is not an object → `json_shape` at that position; an
amount that is not a string → `amount_not_text` (a JSON number cannot carry
every digit of a balance). Three more rules keep a balance from being lost
unsaid. An account giving both `id` and `account_id`, or both `assets` and
`balances`, is `json_shape`: neither is picked. An account in which any
object writes a key twice is `json_duplicate_key` and is not read (a JSON
parser keeps the last value and drops the first). Any other field of an
account is skipped and its name listed among the ignored columns. A port may
leave these two readers out; one that has them must give these results.

**The asset list** may be given as a file of `symbol,decimals` lines (a first
line reading `symbol,decimals` is a heading), for an exchange that lists more
assets than fit on a command line. It is still the exchange that states it.

## 8. The exchange's private files

One directory per snapshot. Vectors: `snapshot-dir/` with
`snapshot-dir.expected.json` (v1), and `snapshot-dir-v2/` with
`snapshot-dir-v2.expected.json` (v2). Any SDK must read a directory another wrote.

| File | Contents |
|---|---|
| `snapshot.json` | the statement (§6) |
| `submission.json` | statement and signature (§6), once signed |
| `leaves.jsonl` | one JSON object per line, in tree order: `user_ref`, `user_ref_hash`, `salt`, `balances` (zero balances omitted). Mode 0600 |
| `seed.hex` | the seed, 64 hex characters and a newline. Mode 0600 |
| `tree.json` | `{ "schema": "stonehash.por-tree.v2", "exchange_id", "assets", "leaf_count", "root", "totals", "leaves_file": "leaves.jsonl", "leaves_sha256" }` — `leaves_sha256` is the SHA-256 of the leaves file's bytes |
| `receipt.json` | what the platform answered (§9), written by the SDK |

`tree.json` of a v2 tree also has `"algo": "merkle-sum-sha256-v2"`, written
second, after `schema`. A `tree.json` with no `algo` is v1, and is written
exactly as it was before there were two formats.

Loading: check the leaves file against `leaves_sha256`, rebuild the tree from
the leaves in the format the header names, and refuse to issue anything if
the rebuilt root or leaf count differs from the header.

A customer's proof file:

```json
{ "schema": "stonehash.por-proof.v1", "exchange": { "institution_id", "name" }, "asof", "root", "totals",
  "leaf_count", "user_ref": "<the customer's own reference>", "proof": { … §5 … } }
```

### The snapshot's proof file

The directory above stores every leaf. The same snapshot can be kept as two
files instead: the balance export it was built from, which the exchange has
anyway, and one small file that holds everything else. The console writes
this file; the reference SDK reads it (`prove --snapshot-proof`).

```json
{ "schema": "stonehash.por-snapshot-proof.v1",
  "notice": "<a sentence saying the file is private>",
  "snapshot_id": "<the id the platform gave (§9)>",
  "platform": "<origin it was submitted to; optional>",
  "created_at": "<ISO instant>",
  "statement": { … §6, exactly as signed … },
  "sig": { "alg": "ES256", "key_id", "issuer", "sig" },
  "seed": "<64 hex characters>",
  "source": { "file", "bytes", "sha256", "layout": "long | wide | sheet | json", "amounts": "decimal | base",
              "columns"?: { "account"?, "asset"?, "balance"? }, "ignore_columns"?: [ … ], "delimiter"?: "<one character>" } }
```

`source` says which export the snapshot was built from and how it was read:
its name, size and SHA-256, the layout (§7; `json` for an array of
accounts), how amounts are written (§2), and — only when they were not the
defaults — the column names, the ignored columns and the delimiter. The file
holds no account and no balance. It holds the seed, so it is private.

**Reading it.** A file whose `schema` is `stonehash.por-proof.v1` is a
customer's proof given by mistake and is refused as such. `seed` is 64 hex
characters; `statement` passes §6's checks and each of its assets is a
symbol and a decimals figure the reader accepts (§3); `source.layout` and
`source.amounts` are among the values above.

**Rebuilding.** Read the export with the statement's `assets`, and
`source`'s layout, amounts and other options, by the rules of §7. Derive each
leaf from `statement.exchange.institution_id` and `seed` (§4) and build the
tree in the format `statement.tree.algo` names (§5). Then compare with the
statement: the root, the leaf count, and every asset's total. **If any
differs, nothing is issued** — the export is not the one that was anchored,
or the proof file has been altered. `source.sha256` is not the test (the
root is); it tells the two cases apart: an export whose bytes match it and
still rebuild another root means the proof file was changed.

## 9. The platform API

Base URL is the deployment's origin. Authentication:
`Authorization: Bearer <API key>`. Bodies and answers are JSON. Errors are
`{ "error": "<code>", "message": "…" }` with a 4xx/5xx status.

- `GET /v1/remit/meta` (no key needed) → `{ "institutions": [ { "id", "signing_spki", … } ], … }`.
  The entry whose `id` is the exchange's institution id carries the public
  key the platform will verify against (SPKI DER, base64).
- `POST /v1/por/snapshots` body `{ "statement", "sig" }` →
  `201 { "snapshot_id", "status": "ACCEPTED", "spot_check": false, "attestation_id", "reserves"?, "note" }`.
  The same signed statement again → `200` with the same fields and
  `"already": true`. Nothing about any account is sent.
- `POST /v1/por/snapshots` body `{ "statement", "sig", "spot_check": true }` →
  `201 { "snapshot_id", "status": "CHALLENGED", "spot_check": true, "challenge": { "indices": [..], "issued_at", "expires_at" } }`.
  Answer within the hour with
  `POST /v1/por/snapshots/{id}/openings` body `{ "openings": [ proof, … ] }`:
  one inclusion proof (§5) for exactly each challenged index, **without**
  `user_ref` anywhere → `200 { "status": "VERIFIED", "attestation_id", "sampled_leaves", … }`,
  or `422 { "status": "REJECTED", "problems": [..] }`.
- `GET /v1/por/snapshots/{id}` → `{ "snapshot_id", "status", "spot_check", "root", "leaf_count", "totals", "commitment", "attestation": { "id", "status" } | null, … }`.
  The anchor is confirmed when `attestation.status == "confirmed"`.
- `GET /v1/public/por/snapshots/{id}` (no key) → the public verification material.

Refusals worth handling by name: `400 invalid_statement`, `400 invalid_signature`,
`400 invalid_field`, `401`, `403 subscription_required`, `403 institution_mismatch`,
`409 wrong_state`, `409 challenge_expired`.

A client should open a new connection per request (or tolerate a pooled one
having been closed): calls can be minutes apart, and the server closes idle
connections after five seconds.
