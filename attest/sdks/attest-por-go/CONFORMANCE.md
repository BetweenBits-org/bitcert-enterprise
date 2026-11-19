# Conformance of the Go SDK

What this SDK was held to, the result of the last run, and every place where
the specification was found ambiguous or at odds with its vectors or with the
reference implementation.

## Last run

`bin/por-example conformance --vectors ../../fixtures/por`, on 2026-11-17 with
Go 1.22.2 (linux/amd64), against the specification and vectors as they stood
then (`SPEC.md` SHA-256 `44b6852877f06223…`, vectors generated
2026-11-17 02:08 UTC):

```
jcs pass 13 fail 0
amounts pass 44 fail 0
leaves pass 6 fail 0
trees pass 14 fail 0
statement pass 8 fail 0
intake pass 13 fail 0
snapshot-dir pass 5 fail 0
```

103 vectors, none failing. The same runner is part of `go test ./...`
(`conformance/`), where a second test alters the vectors in 29 ways and
requires each alteration to be noticed by its own group and by no other.

| Group | File | What one vector is | Count |
|---|---|---|---|
| `jcs` | `jcs.json` | a value and its canonical text (11); a document that must be refused (2) | 13 |
| `amounts` | `amounts.json` | a conversion (20); a refusal and its code (24) | 44 |
| `leaves` | `leaves.json` | an account: its `user_ref_hash`, salt and leaf hash, and — through the ledger builder and `BuildTree` — the root and the opening of a tree of that one account | 6 |
| `trees` | `trees.json` | the empty node's hash (1); a tree: root, leaf count, totals, leaf order, every level's hashes, and each listed proof issued by index, found by account reference and verified (5); a proof that must fail (8) | 14 |
| `statement` | `statement.json` | canonical form; commitment; the published signature verifies; a signature made here with the test key verifies and the key's public half matches; the submission is read, verifies and is written back; two altered forms must not verify; the statement built from its tree (`trees.json`, the case with the same root) has the same canonical form | 8 |
| `intake` | `intake.json`, `intake/*.csv` | a file: for the five accepted ones the layout, counts, totals, holders, ignored columns, file SHA-256 and rows, and the same rows offered to the ledger builder give the same ledger; for the eight refused ones the exact list of (line, code) | 13 |
| `snapshot-dir` | `snapshot-dir/`, `snapshot-dir.*.json` | the reference's directory loads and rebuilds root, leaf count and totals; the commitment; the statement rebuilt from the loaded tree; the customer's proof file; the openings for a challenge | 5 |

Beyond the vectors, the tests compare this SDK's files with the reference's
byte for byte: built from `intake/long.csv` and from `intake/wide.csv` with the
vector seed, `snapshot.json`, `tree.json`, `seed.hex` and `leaves.jsonl` are
identical to `snapshot-dir/`, and so are the proof file for `U-100008` and the
openings for leaves 0, 3 and 7.

Once, by hand (2026-11-17, reference at Node 22.22.0), the example program was
also run side by side with the reference's command line on five exports: the
vectors' `dialect.csv`, `wide-ignore.csv` and `mapped.csv`; a 2,000-account
long file with CRLF line ends, quoted and non-ASCII account references,
padded amounts, assets declared as `USDT,BTC,ETH` and each account's rows in
shuffled order; and an 800-account wide file whose columns are in another
order than declared, with a column to ignore. In all five the four private
files were identical byte for byte. Each side then issued three customers'
proofs from the directory the other had written — identical files — and each
verified the other's. A submission signed by this SDK passed the reference's
`validateSubmission` and `verifySnapshotSignature`, and `submission.json`
differed from the reference's only in the signature's own 86 characters. That
comparison is not part of the automated tests, which do not depend on Node.

## Where prose and vectors disagree

The vectors were followed; the prose is what needs correcting.

1. **§8, the customer's proof file.** The prose gives its `proof` member as
   "§5", and §5's leaf has `user_ref_hash`, `salt` and `balances`. In
   `snapshot-dir.proof-U-100008.json` the leaf also carries `user_ref`, as its
   first member (the reference spreads the stored leaf into it). This SDK
   writes the file as the vector has it. Openings sent to the platform have
   no `user_ref`, as §9 requires.

2. **§7, "After the rows".** The prose says a header and no account is
   `no_accounts`, and no header at all is `empty_file`. In the vectors both are
   reported only when nothing else was: `bad-quote.csv`, `bad-header.csv`,
   `bad-unrecognised.csv` and `bad-wide-header.csv` have a header and no
   account and list only their own problem; `bad-encoding.csv` yields no
   header and lists only `file_encoding`. Implemented as in the vectors.

## Where the prose leaves a choice

Each entry says what was chosen. Where the reference implementation behaves
differently from the prose, the prose was followed unless stated. What is said
below about the reference was observed by running it, unchanged, on the cases
described (Node 22.22.0, 2026-11-17).

### Canonical JSON (§1)

3. **A number written with a fraction or exponent that is a whole number**
   (`1.0`, `1e2`). The prose makes a fraction or an exponent an error. The
   reference reads the document with `JSON.parse`, which discards the
   spelling, and writes `1` and `100`. No vector covers it. This SDK follows
   the prose and refuses, so it will not sign or commit to a statement
   carrying such a number, where the reference would.

4. **Half of a surrogate pair** (`"\ud800"`). The prose says nothing is
   escaped beyond the quote, the backslash and the control characters. The
   reference's `JSON.stringify` writes a lone surrogate as the escape
   `\ud800`, and elsewhere its UTF-8 encoder turns one into U+FFFD. A lone
   surrogate has no UTF-8 form, so this SDK refuses a document that contains
   one.

5. **A member name twice in one object.** Unspecified. JavaScript keeps the
   last; this SDK refuses the document, so that no two readers can keep
   different halves of it.

### Amounts (§2)

6. **"Longer than 62 characters".** The unit is not stated. The reference
   counts UTF-16 code units, and so does this SDK. It matters only for a value
   containing characters outside the Basic Multilingual Plane, which is
   refused either way; the difference would be `amount_too_long` against
   `amount_format`.

7. **The order of the checks gives text containing `e` the code
   `amount_exponent`** (`none`, `true`, `ten`), since the exponent check comes
   before the format check. Prose and reference agree; it is noted because the
   code reads oddly for input that is not a number at all.

### Trees and proofs (§5)

8. **Bits of `leaf_index` above the path are not checked.** The verification
   compares bit `k` of the index with the direction of sibling `k`, for each
   sibling. A proof with four siblings therefore verifies for index `i` and
   for `i + 16` alike, although the reference's commentary says a proof cannot
   stand for another position. This SDK implements the verification as
   specified, no stricter; a statement's `leaf_count` bounds the index. The
   specification could require `leaf_index < 2^(number of siblings)`.

9. **A `dir` that is neither `left` nor `right`.** The reference treats
   anything but `left` as `right`. This SDK refuses the proof.

### The statement (§6)

10. **`asof`: "any ISO 8601 instant".** The reference accepts whatever
    JavaScript's `Date.parse` reads, which includes a date without a time, a
    time without a zone (read as local time) and non-ISO forms. This SDK
    accepts an RFC 3339 date-time with a zone (`2026-11-16T00:00:00Z`,
    `2026-11-16T09:00:00+09:00`, with up to nine fractional digits or none)
    and refuses the rest: without a zone the text does not name one instant.
    Every form it accepts was checked to be one `Date.parse` accepts too.

11. **How much of the shape is checked.** The reference's
    `validateSnapshotStatement` checks the schema, the institution id, `asof`,
    that `assets` is a non-empty array, `tree.algo`, `tree.root`,
    `tree.leaf_count >= 1` and that totals look like integers — coercing them
    to strings first, so a total written as a JSON number passes. It does not
    look at `params`, `tree.padding`, the contents of `assets`,
    `generated_at`, or the upper bound of `leaf_count` (the platform checks
    that one separately). This SDK checks everything §6 states: totals must be
    strings, each asset a valid symbol with 0–36 decimals and no symbol twice,
    `totals` listing exactly the listed assets, `tree.padding`, both `params`
    strings, `leaf_count <= 2147483647`, `generated_at` an instant,
    `exchange.name` a string, and the shape of `reserves.entries`. It does not
    require `reserves.note` to be the fixed sentence when reading (it writes
    that sentence): the note is informational and is covered by the signature
    whatever it says. A statement this SDK accepts is one the reference
    accepts; the reverse does not hold.

12. **Members this version does not know** are kept and are part of the
    canonical form, as in the reference (which canonicalises the parsed
    document). Unspecified, but anything else would change the signed bytes.

13. **The exchange id** is not constrained by the specification. This SDK
    refuses one that is empty, not UTF-8, or contains a control character: it
    is followed by a line break in the hashed text, so an id containing one
    could collide with another exchange's accounts.

### Reading an export (§7)

14. **A syntax error after earlier problems.** The prose says reading stops at
    a `csv_syntax` error "keeping the problems found so far". The reference
    parses a chunk of the file at a time and loses the records of the chunk in
    which a quote-inside-a-field or text-after-a-closing-quote error is
    thrown; for a file under 64 KiB that is every record, so it reports
    `csv_syntax` alone and never reads the header. This SDK follows the prose,
    record by record: `[amount_negative at 2, csv_syntax at 3]` where the
    reference gives `[csv_syntax at 3]`. The two agree whenever no earlier row
    had a problem, and for a file that ends inside quotes.

15. **A file that is not UTF-8 after earlier problems.** The prose says such a
    file "is the problem `file_encoding`". What the reference reports beside
    it depends on where its 64 KiB chunks fall and on whether the invalid
    bytes are in the middle of the file (nothing else is reported, not even
    for earlier rows of the same chunk) or a sequence cut off at its end
    (everything before it is). This SDK reports `file_encoding` alone, always,
    with no layout, rows or accounts: what was read of the file was read under
    a wrong assumption about all of it.

16. **A lone CR.** The prose says records end in LF or CRLF. The reference
    also ends a record at a CR that no LF follows, and counts it as a line.
    This SDK does the same; inside quotes a CR is data and is not counted.

17. **An unclosed quote in a large file.** Not in the specification: the
    reference refuses a quoted field longer than 1,048,576 UTF-16 code units
    as `csv_syntax` at the line the record began on. This SDK does the same,
    counting the same way.

18. **`header_missing_asset` and its exception.** The prose exempts "an asset
    whose only near-match differs by letter case, which was already reported
    as an unknown column". The reference exempts an asset whenever any header
    column equals it ignoring case — including the account column, a column
    the caller named in the ignore list, or another declared asset that
    differs only by case. In those cases the asset has no column, nothing is
    reported, the file is accepted and the asset counts as zero for every
    account: with assets `BTC,ETH` and `ignoreColumns: ["btc"]`, the header
    `account_id,btc,ETH` is read without a problem and without a BTC balance.
    This SDK applies the exemption only when the near-match was in fact
    reported as `header_unknown_column`, and reports `header_missing_asset`
    otherwise. This looks like a defect in the reference rather than an
    ambiguity.

19. **The delimiter** is "a single character" — one UTF-16 code unit in the
    reference. This SDK takes one code point up to U+FFFF, other than `"`, CR
    and LF.

20. **How many problems are kept.** Unspecified. The reference keeps the first
    50 and counts all; so does this SDK (`MaxProblems`).

21. **The figures of a refused ledger.** The reference still reports totals,
    holders and zero-balance accounts computed from the rows that were
    accepted. This SDK leaves them unset when the report is not OK: they are
    not the ledger's figures.

22. **Rows from code that a file cannot contain.** A Go string can hold bytes
    that are not UTF-8. An account reference that does is refused with this
    SDK's own code, `account_encoding`; an amount that does is
    `amount_format`. A ledger with more accounts than a statement can declare
    (2,147,483,647) is refused with `too_many_accounts`, at line 0.

### The private files (§8)

23. **The order of members keyed by asset** in the files (`totals`,
    `balances`, `sums`) is not specified. This SDK writes the declared order,
    and in `leaves.jsonl` the order the ledger gave each account's balances,
    which is what the reference does — except that JavaScript lists member
    names that look like array indices (`"42"`) first, in numeric order. For
    an asset whose symbol is such a number the two layouts differ. Nothing
    hashed or signed is affected, because canonical JSON sorts names; the
    `leaves_sha256` of a directory is that of its own file.

24. **Loading checks more than the prose asks.** Besides the checksum and the
    rebuilt root and leaf count, this SDK requires each leaf's
    `user_ref_hash` to be the hash of its `user_ref` under the header's
    `exchange_id` (a proof issued from a leaf where it is not fails the
    customer's check of their own reference), the rebuilt totals to equal the
    header's, and `snapshot.json` to commit to the rebuilt tree. It requires
    `leaves_file` to be `leaves.jsonl`: the reference opens whatever path the
    header names, which lets a header point outside the directory.

25. **`tree.json` is written with mode 0600** like the other two private
    files, as the reference does; the table in §8 gives a mode for
    `leaves.jsonl` and `seed.hex` only.

26. **The first version of `tree.json`** (`stonehash.por-tree.v1`, the whole
    tree in one file) is read by the reference and is not in the
    specification. This SDK does not read it.

27. **`receipt.json`** is described as "what the platform answered" without
    its members. This SDK's example writes `schema`, `snapshot_id`, `status`,
    `spot_check`, `sampled_accounts`, `attestation_id`, `commitment`, `root`,
    `platform`, `public_url`, `received_at` and `anchor`; the reference's
    command line also writes `verify_page` and `anchor_confirmed_at`.

### The API (§9)

28. **How many leaves a challenge names** is not in §9. The platform's source
    draws `min(8, leaf_count)`. This SDK refuses to answer a challenge of more
    than eight (`challenge_refused`), so that a fault on the other side cannot
    turn a sample into an export of the ledger; if the platform's number ever
    grows, `MaxSpotCheckLeaves` has to grow with it.

29. **A rejected spot check** is `422 { "status": "REJECTED", "problems" }`,
    with no `error` code. This SDK reports it as an `APIError` with status 422
    and the code `openings_rejected` (the reference client's name for it), the
    platform's reasons in `Problems`.

30. **A spot-check submission of a statement the platform already holds** is
    not described. The platform's source answers every spot-check submission
    with a new snapshot and a new challenge; this SDK treats any answer
    without a challenge as `unexpected_response` and opens nothing.

31. **`GET /v1/remit/meta` needs no key**, and this SDK sends none to it. The
    reference client sends the key with every request.

## Not covered by any vector

Checked by this SDK's own tests only: the platform client (against a stand-in
platform inside the test process — it has not been run against a live
deployment), the refusal of damaged snapshot directories, the Signer hook, and
ledgers larger than the vectors' (an independent, deliberately plain
implementation of §4 and §5 is compared with the tree for 1 to 70 accounts;
300,000 accounts were built for the measurements in the README).
