# StoneHash Attest — proof of reserves SDK for Go

The exchange's side of StoneHash Attest proof of reserves, as a Go library that
runs inside your own back-end.

Your system reads its own ledger and builds a Merkle sum tree of customer
balances on your own machines. What goes to the platform is one signed
statement: the root of the tree, the total of every asset, the number of
accounts and the time the ledger was read. The platform checks your signature
and anchors a commitment to that statement. By default nothing about any
account leaves your building.

From the same ledger this SDK arrives at the same bytes as the reference
implementation (TypeScript): the same root, the same statement, the same
proofs. It is held to the published conformance vectors, which are what every
language's SDK is held to; see [CONFORMANCE.md](CONFORMANCE.md).

- Module path: `stonehash.com/attest/por`, package `por`.
- No dependency outside the Go standard library.
- Amounts are `*big.Int` end to end. Nothing is a float, nothing is rounded.

## Requirements

- Go 1.21 or later. `go.mod` declares 1.21, so the compiler holds the code to
  that language version. It has been built and tested with Go 1.22.2 on
  Linux/amd64, and on nothing else.
- For signing: an ECDSA P-256 key, the public half of which is registered with
  the platform for your institution — as a PEM file, or in an HSM or KMS behind
  the `Signer` interface.
- For submitting: your institution id and an API key, and network access from
  the submitting machine to the platform. Reading the ledger, building the
  tree and signing need no network.

## Adding it to your project

The SDK is distributed as a downloadable archive from the platform's Developer
Hub. It is not published on a module proxy or any public registry, so the Go
tool cannot fetch it by its module path: you put the extracted directory beside
your code and point your module at it.

Extract the archive into your repository, for example to
`third_party/attest-por-go`, and from your module's root run:

```sh
go mod edit -require=stonehash.com/attest/por@v0.0.0 \
            -replace=stonehash.com/attest/por=./third_party/attest-por-go
```

That adds two lines to your `go.mod`:

```
require stonehash.com/attest/por v0.0.0

replace stonehash.com/attest/por => ./third_party/attest-por-go
```

and `import por "stonehash.com/attest/por"` now builds, with no network access.
The version is a placeholder: with a `replace` to a directory, the directory is
what is built. Upgrading is replacing the directory with a newer archive.

If your build uses a `vendor` directory, run `go mod vendor` after the step
above. It copies the packages you import into `vendor/stonehash.com/attest/por`,
and `go build` uses them from there.

Both ways are exercised by this SDK's own tests (`docs_test.go`), with the code
of this page.

## Inside your system

One function, from your ledger database to the platform. The rows come straight
from your own query; there is no export file in between.

```go
package reserves

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	por "stonehash.com/attest/por"
)

var assets = []por.Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}, {Symbol: "USDT", Decimals: 6}}

// PublishSnapshot reads the ledger inside one consistent-read transaction,
// commits to it, signs the statement and hands it to the platform. dir is a
// new directory for this snapshot's private files.
func PublishSnapshot(ctx context.Context, tx *sql.Tx, asOf time.Time, signer por.Signer, client *por.Client, dir string) (*por.SubmitResult, error) {
	// 1. The ledger, straight from your own query: one row per account and
	//    asset, the amount as text.
	rows, err := tx.QueryContext(ctx, `
		SELECT account_id, asset, CAST(SUM(available + locked) AS CHAR)
		  FROM balances
		 GROUP BY account_id, asset`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ledger, err := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Decimal})
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var account, asset, amount string
		if err := rows.Scan(&account, &asset, &amount); err != nil {
			return nil, err
		}
		// A refused row is reported by Finish, with its place in the result set.
		_ = ledger.Add(account, asset, amount)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	checked, report := ledger.Finish()
	if !report.OK {
		first := report.Problems[0]
		return nil, fmt.Errorf("the ledger was refused and nothing was built: %d problems, the first at row %d: %s: %s",
			report.ProblemCount, first.Line, first.Code, first.Message)
	}

	// 2. The tree and the statement. Nothing has left the process.
	seed, err := por.NewSeed()
	if err != nil {
		return nil, err
	}
	tree, err := por.BuildTree("KR-EX-0a1b2c", seed, checked) // your institution id
	if err != nil {
		return nil, err
	}
	statement, err := por.NewStatement(por.StatementConfig{
		Name: "Hanbit Exchange", AsOf: asOf.UTC().Format(time.RFC3339), Assets: assets,
	}, tree, time.Now())
	if err != nil {
		return nil, err
	}

	// 3. The private files, written before anything is sent.
	if err := por.WriteSnapshotDir(dir, statement, tree, seed); err != nil {
		return nil, err
	}

	// 4. Sign, and check the signature against the key the platform holds for
	//    you, so that a wrong key is found here and not by a refused request.
	submission, err := por.NewSubmission(statement, signer)
	if err != nil {
		return nil, err
	}
	registered, err := client.RegisteredKey(ctx, statement.InstitutionID())
	if err != nil {
		return nil, err
	}
	if err := por.VerifyStatementSignature(statement, submission.Sig, registered); err != nil {
		return nil, err
	}
	if err := por.WriteSubmission(dir, submission); err != nil {
		return nil, err
	}

	// 5. Submit: the statement and its signature, and nothing else.
	return client.Submit(ctx, submission)
}
```

The client and the signer are made once:

```go
package reserves

import (
	"os"

	por "stonehash.com/attest/por"
)

func newClientAndSigner() (*por.Client, por.Signer, error) {
	client, err := por.NewClient(por.ClientConfig{
		BaseURL: "https://attest.example", // your platform deployment
		APIKey:  os.Getenv("STONEHASH_API_KEY"),
	})
	if err != nil {
		return nil, nil, err
	}
	signer, err := por.LoadPrivateKeyFile("/etc/exchange/attest-signing-key.pem")
	if err != nil {
		return nil, nil, err
	}
	return client, signer, nil
}
```

What the rules of step 1 mean for your query:

- **One row per account and asset.** A second row for the same pair is the
  problem `duplicate_row`, not a sum. Whether two wallets of one customer add
  up is your decision; make it in the query (`GROUP BY`), where it can be
  reviewed. `AddAccount(account, map[asset]amount)` takes one row per account
  instead, if that is the shape you have.
- **Amounts as text**, exactly as the database prints them (`CAST(... AS CHAR)`,
  `::text`), never through `float64`. `por.Decimal` means the text says `0.5`
  for half a coin; `por.Base` means it holds whole numbers of the smallest
  unit. There is no default. A conversion is exact or refused: `0.123456789`
  for an eight-place asset is `amount_precision`, `1e-8` is `amount_exponent`,
  `1,000` is `amount_grouping`, `-1` is `amount_negative`.
- **Every asset declared.** A row in an asset that is not in `Assets` is
  `unknown_asset`, not a dropped row.
- **Account references byte for byte.** The reference is hashed into the leaf
  and your customer later uses the same reference to find their proof, so one
  with leading or trailing whitespace is refused (`account_whitespace`) rather
  than trimmed into a different one.
- **All or nothing.** `Finish` returns a ledger only if no row was refused. A
  problem's `Line` is the 1-based ordinal of the `Add` call; its `Message` may
  quote the account or amount concerned, so log it where the ledger itself may
  be seen.
- **One point in time.** Read the whole ledger in one consistent-read
  transaction and pass that time as `AsOf`.

`WaitAnchored(ctx, result.SnapshotID, timeout)` then polls until the platform
reports the anchor confirmed. On the sandbox the platform anchors to a private
test chain. A confirmed anchor there shows that the hand-off works; it is not
publicly verifiable evidence, because nobody outside the platform can inspect
that chain.

## What leaves the building

**By default** (`Client.Submit`): one request, `POST /v1/por/snapshots`, whose
body is the statement and its signature and nothing else. The statement holds
your institution id and name, the as-of time, the asset symbols with their
decimal places, the number of accounts, the root, the total per asset, two
fixed strings naming the hash rules, the time it was built, and — only if you
declared any — reserve addresses. No account reference, no balance of any
account, no hashed reference, no salt.

Around it: `RegisteredKey` is a `GET /v1/remit/meta` with no body and without
the API key; `Status` and `WaitAnchored` are `GET /v1/por/snapshots/{id}`. The
API key travels in the `Authorization` header of the calls that need it and
nowhere else: it is in no URL and no error message, and a `Client` or
`ClientConfig` printed with `%v` or `%+v` does not show it. Redirects are never
followed, so the key is not sent to an address you did not name. Every request
opens its own connection.

**With a spot check** (`Client.SubmitWithSpotCheck`), which you ask for and do
not get otherwise: the first request also carries `"spot_check": true`, the
platform answers with leaf positions, and a second request,
`POST /v1/por/snapshots/{id}/openings`, opens those leaves. For each
challenged leaf it carries

- its position in the tree, its hashed reference (`user_ref_hash`), its salt
  and its balance of every asset;
- for every level of the tree, the hash and the per-asset sums of the
  neighbouring subtree. At the lowest level that neighbour is one other
  account (unless it is the padding node), so that account's balances are
  disclosed as well — not its reference, hashed reference or salt.

It never carries an account reference. The SDK opens at most eight leaves per
challenge (`por.MaxSpotCheckLeaves`) and refuses a challenge that asks for
more, without opening anything. `SubmitResult.Openings` is exactly what was
sent; write it down with `WriteOpenings`.

Opened leaves are pseudonymous, not anonymous: `user_ref_hash` is an unsalted
SHA-256 of your institution id and the account reference, so someone who can
guess a reference can check the guess against it.

The seed, the leaves file and the salts of unopened leaves never leave, in
either mode.

## Signing with an HSM or a KMS

`por.Signer` is one method: the bytes to sign go in, and the ECDSA P-256 /
SHA-256 signature comes out as 64 bytes, `r` then `s`, each 32 bytes
big-endian — not DER.

If the client of your device is a `crypto.Signer` holding a P-256 key, as Go's
PKCS #11 and cloud KMS clients usually are, one call adapts it:
`por.CryptoSigner(deviceSigner)`. Otherwise write the method yourself:

```go
package reserves

import (
	"context"
	"crypto/sha256"
	"encoding/asn1"
	"errors"
	"math/big"

	por "stonehash.com/attest/por"
)

// kmsClient stands for your KMS or HSM client: it signs a SHA-256 digest
// with the exchange's P-256 key and answers in ASN.1 DER, as most do.
type kmsClient interface {
	SignDigest(ctx context.Context, keyID string, digest []byte) (der []byte, err error)
}

// kmsSigner makes that client a por.Signer.
func kmsSigner(ctx context.Context, kms kmsClient, keyID string) por.Signer {
	return por.SignerFunc(func(message []byte) ([]byte, error) {
		digest := sha256.Sum256(message)
		der, err := kms.SignDigest(ctx, keyID, digest[:])
		if err != nil {
			return nil, err
		}
		var sig struct{ R, S *big.Int }
		if _, err := asn1.Unmarshal(der, &sig); err != nil {
			return nil, err
		}
		if sig.R.BitLen() > 256 || sig.S.BitLen() > 256 {
			return nil, errors.New("the device did not return a P-256 signature")
		}
		raw := make([]byte, 64)
		sig.R.FillBytes(raw[:32])
		sig.S.FillBytes(raw[32:])
		return raw, nil
	})
}
```

Signing is a step of its own because the machine that holds the key is often
not the machine allowed to reach the internet: `NewSubmission` needs the
statement and the signer, not the ledger and not the network, and
`WriteSubmission` / `ReadSubmission` carry the result between the two. What is
signed is `"stonehash:remit:event:v1\n"` followed by the statement's canonical
JSON.

The built-in `LoadPrivateKeyFile` / `ParsePrivateKeyPEM` read an unencrypted
PKCS #8 key (`BEGIN PRIVATE KEY`) or the SEC 1 form OpenSSL writes
(`BEGIN EC PRIVATE KEY`). This SDK does not generate keys and does not register
them.

## Files to keep, and why

`WriteSnapshotDir` writes one directory per snapshot (created with mode 0700).

| File | Contents | Mode | Leaves the building |
|---|---|---|---|
| `snapshot.json` | the statement: root and totals | 0644 | yes, inside the submission |
| `submission.json` | the statement and its signature (`WriteSubmission`) | 0644 | yes — it is what `Submit` sends |
| `leaves.jsonl` | one line per account: reference, hashed reference, salt, balances | 0600 | never |
| `seed.hex` | the 32-byte seed every salt was derived from | 0600 | never |
| `tree.json` | a header: root, totals and the checksum of `leaves.jsonl` | 0600 | never |
| `receipt.json` | what the platform answered (`WriteReceipt`) | 0644 | — |
| `openings.json` | after a spot check, exactly what was opened (`WriteOpenings`) | 0600 | it is the record of what did |

**Keep `leaves.jsonl` and `seed.hex` for as long as customers may ask for their
proofs.** A proof needs the leaf's salt and its neighbours all the way up the
tree:

- with `leaves.jsonl` (and `tree.json`, `snapshot.json`) every proof can be
  issued; `seed.hex` is not read for that;
- with `seed.hex` and the same ledger rows, `leaves.jsonl` can be written
  again, byte for byte;
- lose both and no customer proof can be issued for that snapshot again. The
  anchored root stays valid and becomes uncheckable.

Keep `seed.hex` secret as well: with the seed, anyone who knows an account
reference can derive that account's salt and test guesses at its balances.

`WriteSnapshotDir` refuses a directory that already holds a different seed
(`snapshot_exists`) instead of overwriting it; give every snapshot its own
directory. Files are written to a temporary name, flushed and renamed, so a
file is absent, the previous version or complete.

`LoadSnapshotDir` reads a directory back — this SDK's or another language's —
and returns nothing unless it is whole: `leaves.jsonl` has the checksum
`tree.json` recorded, every leaf's hashed reference is the hash of its
reference, the leaves rebuild the recorded root, leaf count and totals, and
`snapshot.json` commits to that same tree.

## Customer proofs, and the spot check

```go
package reserves

import (
	"context"
	"errors"

	por "stonehash.com/attest/por"
)

// CustomerProof issues one customer's proof file from a stored snapshot.
func CustomerProof(dir, accountID string) ([]byte, error) {
	snapshot, err := por.LoadSnapshotDir(dir) // checksum and rebuilt root are verified here
	if err != nil {
		return nil, err
	}
	proof, err := snapshot.Tree.ProofFor(accountID)
	if err != nil {
		return nil, err
	}
	return por.MarshalProofFile(snapshot.Statement, proof)
}

// CheckProof is what the customer, or their auditor, runs: the proof file
// against the published statement. It needs no account and no network.
func CheckProof(proofFile, statementFile []byte) error {
	statement, err := por.ParseStatement(statementFile)
	if err != nil {
		return err
	}
	file, err := por.ParseProofFile(proofFile)
	if err != nil {
		return err
	}
	if err := por.VerifyProof(file.Proof, statement.Root(), statement.Totals()); err != nil {
		return err
	}
	// The proof holds. Is it about the account it names?
	if file.UserRef != "" && por.UserRefHash(statement.InstitutionID(), file.UserRef) != file.Proof.Leaf.UserRefHash {
		return errors.New("the proof is for another account")
	}
	return nil
}

// PublishWithSpotCheck submits a signed snapshot and lets the platform sample
// the tree before it anchors.
func PublishWithSpotCheck(ctx context.Context, client *por.Client, dir string) (*por.SubmitResult, error) {
	snapshot, err := por.LoadSnapshotDir(dir)
	if err != nil {
		return nil, err
	}
	submission, err := por.ReadSubmission(dir)
	if err != nil {
		return nil, err
	}
	result, err := client.SubmitWithSpotCheck(ctx, submission, snapshot.Tree)
	if result != nil {
		// What was opened to the platform, kept whether or not it then confirmed.
		if recordErr := por.WriteOpenings(dir, result.Openings); recordErr != nil {
			return nil, recordErr
		}
	}
	return result, err
}
```

`LoadSnapshotDir` rebuilds and checks the whole tree each time (see the
timings below). A service that issues many proofs should load once and keep
the `*por.Tree`: it is immutable and safe for concurrent use. `Tree.ProofFor`
gives the customer's own proof, with their reference in it; `Tree.Proof(i)` is
the pseudonymous form.

## Reading an export file instead

Where the ledger arrives as a file, `ReadCSVFile` applies the same rules to a
CSV export, streamed (the file is never held in memory as a whole) and hashed
in the same pass:

```go
package reserves

import (
	"fmt"

	por "stonehash.com/attest/por"
)

func ledgerFromExport(path string) (*por.Ledger, error) {
	ledger, report, err := por.ReadCSVFile(path, por.CSVOptions{Assets: assets, Amounts: por.Decimal})
	if err != nil {
		return nil, err // the file could not be read at all
	}
	if !report.OK {
		return nil, fmt.Errorf("%d problems in the export (sha256 %s), the first at line %d: %s",
			report.ProblemCount, report.FileSHA256, report.Problems[0].Line, report.Problems[0].Code)
	}
	return ledger, nil
}
```

Two layouts are read, decided from the header unless stated: long
(`account_id,asset,balance`, one row per account and asset) and wide
(`account_id,BTC,ETH,USDT`, one row per account). `CSVOptions` renames the
columns, sets the delimiter and names the columns of a wide file to pass over.
The report states the layout, data rows, accounts, zero-balance accounts,
totals and holders per asset, ignored columns, the file's SHA-256 and size,
and every problem as line, code and message (the first 50 are kept by default,
all are counted).

## The example program

`examples/por-example/main.go` is the integration example to read — each step
is one short function, including a clearly marked `ledgerFromDatabase` — and
the command line the cross-language tests drive. `bin/por-example` builds it
into `./.build` when needed and runs it.

```sh
bin/por-example build   --csv balances.csv --amounts decimal --assets BTC:8,ETH:18,USDT:6 \
                        --exchange KR-EX-0a1b2c --name "Hanbit Exchange" --asof 2026-11-16T00:00:00Z --out snapshots/2026-11-16
bin/por-example sign    --dir snapshots/2026-11-16 --key exchange-signing.key
STONEHASH_API_KEY=... bin/por-example submit --dir snapshots/2026-11-16 --core https://attest.example [--spot-check] [--wait]
STONEHASH_API_KEY=... bin/por-example status --core https://attest.example --snapshot ID
bin/por-example prove   --dir snapshots/2026-11-16 --user-ref U-100008 --out proof-U-100008.json
bin/por-example verify-proof --proof proof-U-100008.json --snapshot snapshots/2026-11-16/snapshot.json
bin/por-example conformance --vectors DIR
```

Exit codes: 0 done; 1 a usage mistake, a file that could not be read or
written, or a refusal by the platform; 2 the data did not pass a check (an
export with problems, a proof that does not hold, a vector that does not pass).

## Errors

Every error this package creates is a `*por.Error` with a stable `Code`, a
`Message`, and a `Line` when it is about one row. The codes for amounts,
accounts, the CSV dialect, headers and rows are the specification's
(`amount_precision`, `duplicate_row`, `header_missing_asset`, …); the rest are
listed in `errors.go`. What the platform refuses is a `*por.APIError` carrying
the HTTP status, the platform's error code and its message.

```go
package reserves

import (
	"errors"

	por "stonehash.com/attest/por"
)

func retryable(err error) bool {
	var refused *por.APIError
	if errors.As(err, &refused) {
		return refused.Status >= 500
	}
	var local *por.Error
	return errors.As(err, &local) && (local.Code == por.CodeUnreachable || local.Code == por.CodeAnchorTimeout)
}
```

## Size and speed, as measured

Measured with `scripts/measure.sh` on a 4-vCPU Intel Xeon Platinum 8488C
machine, Go 1.22.2, three assets, synthetic ledgers in which each account
holds each asset with probability three in four. The SDK uses one core. For
"rows to root" the time is from the first `Add` to the built tree, as the
measuring program reports it; for the other two it is the wall-clock time of
the whole command. Memory is the peak resident set of the whole process, as
`/usr/bin/time -v` reports it. The machine is shared with other services and
the times moved with its load, so each cell gives the lowest and highest of
the runs taken (four for the first row, two and three for the last two);
memory hardly moved.

| | 100,000 accounts (226,602 rows) | 300,000 accounts (678,850 rows) |
|---|---|---|
| **Rows to root** — rows already in memory, through `LedgerBuilder` and `BuildTree` | 0.37–0.72 s, peak 80–81 MB | 1.21–1.98 s, peak 232–240 MB |
| of which held by the SDK once built (ledger and tree) | 47 MB | 141 MB |
| **File to files** — `por-example build`: CSV read, tree, statement, directory written | 0.85–1.30 s, peak 71–78 MB (7 MB export, 25 MB leaves file) | 2.39–2.51 s, peak 195–196 MB (21 MB export, 73 MB leaves file) |
| **One proof** — `por-example prove`: directory read and checked, tree rebuilt, proof written | 0.58–0.84 s, peak 66–67 MB | 1.25–1.32 s, peak 185–187 MB |

The peak of "rows to root" includes the input rows themselves (19 MB and
56 MB), which a database cursor would not hold all at once.

What limits a snapshot:

- **Memory.** The whole ledger and tree are in memory: about 0.5 kB per account
  with three assets in these measurements. Every node of the tree carries a
  sum for every asset, so the figure grows with the number of assets; other
  numbers of assets were not measured.
- **Not measured beyond 300,000 accounts.** Larger ledgers have not been run
  with this SDK. Nothing in the code is known to stop them short of memory,
  but no figure is claimed for them.
- **By the format:** at most 2,147,483,647 accounts in a statement; an asset
  has 0 to 36 decimal places; an amount's text is at most 62 characters; an
  account reference at most 256 bytes of UTF-8.

## What it does not do

- It does not decide your business rules: which wallets add up, what happens
  to a negative balance, which accounts are in scope. It refuses what is
  ambiguous and says why.
- It does not generate or register signing keys, and does not read encrypted
  PEM keys.
- It does not prove control of reserve addresses or measure reserves. A
  statement can declare reserve addresses (`StatementConfig.Reserves`); the
  measuring is done by whoever verifies.
- It does not verify the platform's anchor. `Status` and `WaitAnchored` report
  what the platform says; checking an anchor independently is the verifier's
  job, and on the sandbox it cannot be done from outside at all.
- It does not deliver proofs to customers; it issues them (`ProofFor`,
  `MarshalProofFile`) and you serve them.
- It does not retry. A failed call returns its error. By the specification,
  the same signed statement submitted again is answered with the earlier
  record, so repeating a submission is safe; an interrupted spot check is not
  resumed — submit again.
- It does not keep the tree on disk or build it out of core, does not use more
  than one core, and does not read spreadsheet formats or the first version of
  `tree.json` (schema `stonehash.por-tree.v1`).

## What was verified, and how

- **Conformance:** every published vector passes — canonical JSON, amounts,
  leaves, trees and proofs, the statement, its commitment and signature, CSV
  intake, and a snapshot directory written by the reference. Results and the
  places where the specification is ambiguous are in
  [CONFORMANCE.md](CONFORMANCE.md).
- **Byte for byte:** for the sample ledger, `snapshot.json`, `tree.json`,
  `seed.hex`, `leaves.jsonl`, the customer's proof file and the openings file
  this SDK writes are identical to the reference's (automated). Run side by
  side with the reference's command line on five more exports, up to 2,000
  accounts, the private files were identical as well, each side read the
  other's directory and verified the other's proofs, and the reference
  verified a signature made here (once, by hand; see CONFORMANCE.md).
- **The platform client** was tested against a stand-in that implements the
  published API inside the test process. It has not been run against a live
  platform deployment from here.
- **Not verified:** any Go version other than 1.22.2, any platform other than
  Linux/amd64 (file modes are Unix modes), and ledgers above 300,000 accounts.

## Building and testing

```sh
go vet ./...
go test ./...
bin/por-example conformance --vectors DIR
scripts/measure.sh
```

The conformance vectors are not part of this directory. In the platform's
source tree they are in `fixtures/por`, two levels up, which is where the tests
look; anywhere else, set `POR_VECTORS` to the directory that holds `SPEC.md`
and the vector files. Without the vectors the tests that need them fail rather
than pass unchecked.

| Path | What it is |
|---|---|
| `*.go` | the library, package `por` |
| `internal/cjson` | the strict JSON reader and the canonical, compact and indented writers |
| `conformance/` | the vector runner, used by the tests and by `por-example conformance` |
| `examples/por-example/` | the integration example and interoperability program |
| `bin/por-example` | builds and runs it |
| `internal/platformtest` | the stand-in platform the tests talk to |
| `internal/measure`, `scripts/measure.sh` | how the figures above were taken |
