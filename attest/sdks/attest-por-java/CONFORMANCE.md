# Conformance — Java SDK 0.1.0

Against `fixtures/por/SPEC.md` and the vectors beside it, as they stood on
2026-11-17 (SPEC.md last changed 02:06 UTC; it includes the paragraph "Rows
from code, with no file").

## Vector results

Last run: 2026-11-17, OpenJDK 11.0.33, Linux x86-64, with
`bin/por-example conformance --vectors ../../fixtures/por` (exit code 0).

| Group | Vector file | Passed | Failed | What is checked |
|---|---|---|---|---|
| `jcs` | `jcs.json` | 13 | 0 | 11 canonical texts, 2 rejects |
| `amounts` | `amounts.json` | 44 | 0 | 20 conversions, 24 refusals by code |
| `leaves` | `leaves.json` | 6 | 0 | `user_ref_hash`, `salt` and `leaf_hash` of each case |
| `trees` | `trees.json` | 14 | 0 | the empty node; 5 trees (root, totals, leaf count, order, every level's hashes, every listed proof, lookup by reference); 8 proofs that must fail |
| `statement` | `statement.json` | 8 | 0 | validity, canonical text, commitment, the signature verifies, 2 that must not, the submission file, a fresh signature with the test key (and the public key derived from it) |
| `intake` | `intake.json`, `intake/*.csv` | 13 | 0 | 5 files that read (layout, rows, accounts, zero-balance accounts, totals, holders, ignored columns, SHA-256, the rows themselves), 8 that are refused (problems by line and code, no rows) |
| `snapshot-dir` | `snapshot-dir/`, `snapshot-dir.*.json` | 5 | 0 | load (root, totals, leaf count, exchange id); the statement's commitment; the proof file for `U-100008`; the openings for 0, 3, 7; and writing — see below |
| `database-path` | (the example's own) | 2 | 0 | the sample ledger fed through `LedgerBuilder.add` and through `addAccount` reaches the root the file reaches |

The seven groups of the specification: 103 checks, 103 passed; with the
example's own two, 105 of 105. The test suite (`./run-tests.sh`) ran 88
tests, 88 passed.

Three of these go further than the vectors ask, and hold:

- **The proof file is the vector's file byte for byte**, not only the same
  JSON value.
- **A directory written here is the vector's directory byte for byte**:
  built from `intake/long.csv` with the vector's seed and `generated_at`,
  `snapshot.json`, `leaves.jsonl`, `seed.hex` and `tree.json` are identical
  to those under `snapshot-dir/`.
- The one value that cannot be reproduced, the ECDSA signature (a fresh
  nonce each time), is checked by verifying the vector's and by verifying a
  new one.

## Checked against the reference itself

Beyond the vectors, the reference command line
(`packages/attest-por/src/cli.ts`) was run beside this SDK:

- 750 generated exports (both layouts, renamed columns, four delimiters,
  CRLF and lone-CR line ends, byte-order marks, quoted fields, asset symbols
  that are all digits, several dozen kinds of malformed amount and account,
  header mistakes, injected stray quotes and non-UTF-8 bytes, files of
  several 64 KiB blocks). For each: `ok`, layout, rows, accounts, zero-balance
  accounts, totals, holders, ignored columns, the kept problems by line and
  code, the problem count, the file's size and SHA-256 — and, for the 43 that
  read cleanly, the four files of the built directory byte for byte.
  **704 agree in everything; the other 46 differ only in the two situations
  described under items 1 and 2 below.**
- One export of 300,000 accounts (680,424 rows): the same root and totals,
  and identical `leaves.jsonl` (74.9 MB), `tree.json` and `seed.hex`.
- Proof files: for 24 of the generated ledgers (some with all-digit asset
  symbols) the proof file of one account is identical byte for byte, the
  reference verifies the proof issued here and this SDK verifies the
  reference's.
- Signatures: a submission signed here verifies in the reference
  (`verifySnapshotSignature`, and `validateSubmission` finds nothing), and one
  signed by the reference over a statement built here verifies here; both
  compute the same commitment.

These runs are not part of the test suite — they need the reference and
Node — but the generator's findings are pinned as tests where they matter.

## Where the specification is ambiguous or wrong

Each item says what the prose says, what the reference does, and what this
SDK does. Items 1–3 change what a reader of a bad file is told; the rest are
edges.

### Differences from the reference that remain

**1. §7, `csv_syntax`: "keeping the problems found so far".** The reference
keeps them only from earlier 64 KiB chunks of the file. A syntax error
raised in mid-file (a quote inside an unquoted field, text after a closing
quote, a quoted field over the size bound) discards every record of the
chunk it is in — including the header — because the parser returns a
chunk's records only when the whole chunk has parsed. Only "the file ends
inside quotes", raised at the end, keeps them. For

```
account_id,asset,balance
u1,BTC,-1
u2,BTC,"1"x
```

the reference reports `3 csv_syntax` alone, with layout null and 0 rows; for
the same file ending in `u2,BTC,"1` it reports `2 amount_negative` and
`3 csv_syntax`. *This SDK follows the prose in both cases*: every record
before the offending character is read, and its problems are kept. (45 of the
750 generated files differ from the reference for this reason and no other:
in each, the reference's problems are the first of this SDK's and the syntax
error is at the same line.)

**2. §7 header rule 5, the exception to `header_missing_asset`.** The prose
exempts "an asset whose only near-match differs by letter case, which was
already reported as an unknown column". The reference exempts an asset
whenever *any* header name equals it ignoring case — also when that column
was not reported at all: when it is on the caller's ignore list, when it is
the account column, or when it is another declared asset's own column. The
file is then accepted with a declared asset that has no column, and its
total is silently zero:

| Declared | Header | Options | Reference | This SDK |
|---|---|---|---|---|
| BTC, ETH, USDT | `account_id,btc,ETH,USDT` | ignore `btc` | accepted, BTC total 0 | `header_missing_asset` |
| BTC, ETH, USDT | `btc,ETH,USDT` | account column `btc` | accepted, BTC total 0 | `header_missing_asset` |
| btc, BTC, X | `account_id,btc,X` | — | accepted, BTC total 0 | `header_missing_asset` |

*This SDK follows the prose*: the exemption applies only when the
differently-cased column was reported as `header_unknown_column`. That is
also the reading under which nothing that changes a total is decided
silently. (One of the 750 generated files, the third row of the table.)

### Where the prose is silent and this SDK follows the reference

**3. §7, `file_encoding`: what else is reported.** The prose says only that
such a file "is the problem `file_encoding` at line 0". The reference decodes
in chunks of 65,536 bytes and treats a chunk holding invalid bytes as
contributing nothing: problems found in *earlier* chunks stay in the report,
`file_encoding` is appended, and nothing from that chunk on is read. A
character cut off by the end of the file is found after everything before it
was read. After a `csv_syntax` error no further chunk is decoded, so invalid
bytes later in the file are not reported. *This SDK does the same, with the
same block size*, so both report the same problems for the same file
(verified on generated files of several blocks). The specification should
say which problems accompany `file_encoding`; as it is, the answer depends
on a buffer size.

**4. §7 dialect: a bound on quoted fields.** The reference raises
`csv_syntax`, at the line where the record began, when a quoted field
exceeds 1,048,576 UTF-16 code units. The prose has no such rule. *Same here.*
Without it one stray quote reads the rest of the file into a single field.

**5. §7 dialect: a lone CR.** "Records end in LF or CRLF." The reference
also ends a record at a CR that no LF follows, and counts it as a line.
Inside quotes only LF counts as a line. *Same here.*

**6. §7 header rule 1.** Read literally, an empty name and a repeated name
could both be reported. The reference reports one problem: whichever comes
first in column order. *Same here.*

**7. §7 "After the rows": `no_accounts` and `empty_file`.** The prose reads
as if "a header and no account" always gives `no_accounts`. The vectors show
otherwise (`bad-header`, `bad-unrecognised`, `bad-quote`, `bad-wide-header`
have a header, no account and no `no_accounts`): both problems are added
only when there is no other problem. *Same here; the vectors decide.* The
same holds for "With no accepted account at the end: `no_accounts`" in the
paragraph on rows from code.

**8. §2, "longer than 62 characters".** The reference counts UTF-16 code
units. *Same here.* It only matters for text with characters outside the
basic plane, which is refused either way, but under `amount_too_long` or
another code depending on the count used.

**9. §8, the proof file's `proof.leaf`.** The prose refers to §5, whose leaf
has `user_ref_hash`, `salt`, `balances`. The vector
(`snapshot-dir.proof-U-100008.json`) also has `user_ref` inside `proof.leaf`.
*This SDK writes the vector's form* (byte for byte) and reads both.

**10. §8, file modes.** The prose gives mode 0600 for `leaves.jsonl` and
`seed.hex`. The reference also sets it on `tree.json`. *Same here.*

**11. §8, the bytes of the private files.** The prose defines what the files
hold, not how the JSON is written: indentation, the order of members, the
order of an account's balances in `leaves.jsonl` (the reference writes them
in the order the ledger gave them), the escaping of non-ASCII text. And
JavaScript lists keys that are array indices (an asset named `42`) before
all others. *This SDK reproduces the reference's bytes in all of these*
(verified as above), so `leaves_sha256` is the same from either. Loading
does not depend on any of it; another SDK may legitimately write other
bytes.

**12. §9, a rejected spot check.** The `422` answer carries `status` and
`problems` but no `error` code. This SDK raises it as `PorApiException` with
code `openings_rejected`, the problems in the message and the answer in
`body()`. The number of challenged leaves is not stated in the
specification; the SDK opens whatever positions it is given, and refuses a
position outside the tree before opening anything.

### Where this SDK is stricter than the reference

None of these changes a byte of anything this SDK produces; they concern
input no SDK writes.

**13. §1, numbers.** "A number with a fraction, an exponent, or outside that
range is an error." The reference reads JSON through JavaScript numbers and
cannot tell `1.0` or `1e2` from `1`: it canonicalises `{"x":1.0,"y":1e2}` as
`{"x":1,"y":100}`. *This SDK refuses them*, as the prose says. The two
`rejects` vectors pass either way.

**14. §1, text with no UTF-8 encoding and repeated keys.** Neither is
covered. For an unpaired surrogate the reference writes an escape
(`"\ud800"`) into the canonical text; RFC 8785 makes it an error. *This SDK
refuses it in canonical JSON.* For `{"root":"a","root":"b"}` the reference
keeps the last value; *this SDK refuses to read a document with a repeated
key*, since readers disagree on which value counts.

**15. §3, an account reference with an unpaired surrogate.** It cannot occur
in a file (the file is refused as `file_encoding`), but it can in a Java
`String` handed to `LedgerBuilder`. The reference would hash a replacement
character in its place. *This SDK refuses the row with the code
`account_encoding`*, which is not among the specification's codes.

**16. §5, verification: positions above the path.** The check "bit k of
`leaf_index` equals the side of sibling k" covers only as many bits as there
are siblings. A valid proof for leaf 1 of a tree with three levels below the
root also verifies with `leaf_index` 41, in the reference and, *as the
specification is written, here*. The specification should require
`leaf_index < 2^(number of siblings)`.

**17. §5, a proof of another shape.** The verification paragraph does not
say that a proof which is not of the shape given just above it fails. The
reference, being untyped, lets some through: a `dir` that is neither `left`
nor `right` counts as `right` (a `right` renamed `banana` still verifies),
and a balance written as a JSON number passes the integer test. *This SDK
refuses any proof not of the given shape* before hashing: `dir` must be
`left` or `right`; hashes 64 lowercase hex; amounts decimal strings without
sign or leading zero; `leaf_index` an integer from 0 to 2^31 − 2; at most 31
siblings (a snapshot has at most 2^31 − 1 leaves).

**18. §6, `asof`: "any ISO 8601 instant".** The reference accepts whatever
JavaScript's `Date.parse` accepts — `2026-11-16`, `Nov 16 2026`, a time
without an offset — which no other language reproduces. *This SDK accepts an
ISO 8601 date and time with an offset* (`java.time.OffsetDateTime.parse`:
`2026-11-16T00:00:00Z`, `2026-11-16T09:00:00+09:00`). A statement the
reference built with a date-only `asof` is therefore refused by this SDK's
`validate()`, `sign` and `submit`.

**19. §6, how much of the shape is checked.** The reference's
`validateSnapshotStatement` checks the schema, the institution id, `asof`,
that `assets` is non-empty, the algorithm, the root, that the leaf count is
at least 1, and that each total *as text* is an integer. It accepts a
statement with no `params`, no `generated_at`, another `padding`, and a
total written as a JSON number (`5`, which canonicalises differently from
`"5"`). *This SDK's `validate()` checks the whole shape of §6*: the two
fixed `params` strings, `padding`, `leaf_count` up to 2147483647, each asset's
symbol and decimal places, one total per listed asset and no other, totals
as canonical decimal strings, the form of `generated_at`, and `reserves`
with its fixed `note` when present. Members the specification does not name
are left alone and stay part of what is hashed and signed.

**20. §4, the exchange id.** No constraint is stated. It is followed by a
line break in the hashed text, so *this SDK refuses an id that is empty or
holds a control character.*

**21. §8, an older layout.** The reference still reads directories of the
earlier `stonehash.por-tree.v1` layout, which the specification does not
describe. *This SDK reads `v2` only*, and requires `leaves_file` to be
`leaves.jsonl` rather than following a path from the header.

### Additions of this SDK

Not in the specification, and not affecting any output:

- `SnapshotDirectory.write` refuses to replace a snapshot that has a receipt
  with one of a different seed or root (`snapshot_exists`); the reference
  overwrites. Without a receipt it overwrites too. It also refuses a seed
  that does not reproduce the tree's salts, and a file system without
  owner-only permissions.
- `submitWithSpotCheck` refuses, before anything is sent, a tree that is not
  the statement's (`tree_mismatch`).
- Null arguments to `LedgerBuilder.add` are treated as empty text.
- `CsvLedger.read` refuses options that give the account, asset and balance
  columns the same name (`invalid_option`); the reference goes on and reads
  one column in two roles.

## No errors found in the vectors

Every vector passes as published. The one caveat is in the nature of ECDSA:
`statement.json`'s `signature` cannot be regenerated, only verified.
