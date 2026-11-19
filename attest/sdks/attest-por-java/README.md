# StoneHash Attest — proof of reserves SDK for Java

A library that runs **inside your own back end**. It takes your ledger
straight from your database query, builds the Merkle sum tree of your
customers' balances on your machine, and produces the one thing that is
sent to the platform: a signed statement holding the root, the total per
asset, the number of accounts and the as-of time. The platform checks the
signature and anchors a commitment to that statement. Nothing about any
account leaves your building unless you ask for a spot check.

It is the Java counterpart of the reference SDK (`@stonehash/attest-por`,
TypeScript) and is held to the same specification and the same conformance
vectors: from the same ledger and seed it produces the same root, the same
statement and commitment, the same proofs, and byte for byte the same
private files.

- Package `com.stonehash.attest.por`, version 0.1.0.
- No dependencies: the JDK only (`java.base` and `java.net.http`).
- Money is `java.math.BigInteger` or exact decimal text from end to end. No
  `double`, no rounding, anywhere.
- One unchecked exception family, `PorException`, with a stable `code()`.

## Requirements

- A JDK 11 or newer to build (`javac`, `jar`), Java 11 or newer to run.
  Built with `javac --release 11`.
- A file system with POSIX permissions for the snapshot's private files
  (they are written with mode 0600; writing them elsewhere is refused).
- Verified on OpenJDK 11.0.33, Linux x86-64. It has not been run on another
  JDK or operating system. The public API uses plain JDK types (`List`,
  `Map`, `String`, `BigInteger`, `byte[]`, `Duration`, `Path`) so that it
  can be called from Kotlin and Scala unchanged, but it has not been
  compiled against either here.

## Adding it to your project

This SDK is **not on a public registry**. It is distributed as a
downloadable archive from the Developer Hub of your platform deployment.
Unpack the archive and build the jar:

```sh
./build.sh
# dist/stonehash-attest-por-0.1.0.jar           the library (no dependencies)
# dist/stonehash-attest-por-0.1.0-sources.jar   its sources, for your IDE
```

Then put the jar on your class path:

```sh
javac -cp dist/stonehash-attest-por-0.1.0.jar YourCode.java
java  -cp dist/stonehash-attest-por-0.1.0.jar:. YourCode
```

In a build managed by Maven or Gradle, add the jar the way your organisation
adds any artifact that does not come from a public registry: publish it to
your own repository manager, or reference the file. For reference, the usual
forms are below — they were not run on the machine this SDK was built on,
which has neither tool:

```sh
mvn install:install-file -Dfile=dist/stonehash-attest-por-0.1.0.jar \
    -Dsources=dist/stonehash-attest-por-0.1.0-sources.jar \
    -DgroupId=com.stonehash -DartifactId=attest-por -Dversion=0.1.0 -Dpackaging=jar
```

```kotlin
dependencies { implementation(files("libs/stonehash-attest-por-0.1.0.jar")) }
```

The jar's manifest names the module `com.stonehash.attest.por` for use on a
module path.

## Inside your system

The whole of a snapshot, in the order it happens. `BASE` is your platform
deployment's origin.

```java
import com.stonehash.attest.por.*;

List<AssetSpec> assets = AssetSpec.parseList("BTC:8,ETH:18,USDT:6");

// 1. The ledger, straight from your own query. No file in between.
LedgerBuilder builder = new LedgerBuilder(assets, AmountUnit.DECIMAL);
try (ResultSet rs = statement.executeQuery(
        "SELECT user_id, currency, SUM(available + locked) AS balance "
      + "FROM balances GROUP BY user_id, currency")) {
    while (rs.next()) {
        builder.add(rs.getString("user_id"), rs.getString("currency"), rs.getString("balance"));
    }
}
Ledger ledger = builder.finish();
if (!ledger.ok()) {
    for (Problem p : ledger.report().problems()) {
        log.error("row {} {} {}", p.line(), p.code(), p.message());
    }
    throw new IllegalStateException(ledger.report().problemCount() + " problems; nothing was built");
}
// Compare these with your own books before going on.
log.info("{} accounts, totals {}", ledger.report().accounts(), ledger.report().totals());

// 2. The tree and the statement.
String exchangeId = "KR-EX-0a1b2c";              // your institution id on the platform
byte[] seed = Leaves.newSeed();                  // this snapshot's secret
PorTree tree = PorTree.build(exchangeId, seed, ledger);
Statement snapshot = Statement.builder()
        .exchange(exchangeId, "Sample Exchange")
        .asof("2026-11-16T00:00:00Z")            // when the ledger was read
        .assets(ledger.assets())
        .tree(tree)
        .build();
Path dir = Paths.get("snapshots/2026-11-16");
SnapshotDirectory.write(dir, tree, seed, snapshot);       // what you keep; see below

// 3. Sign. A key file here; an HSM or a KMS is the next section.
Signer signer = Signers.fromPkcs8Pem(pemText);
Submission submission = Submission.sign(snapshot, signer);
SnapshotDirectory.writeSubmission(dir, submission);       // byte for byte what will be sent

// 4. Hand it to the platform.
PorClient client = PorClient.builder(System.getenv("BASE"))
        .apiKey(System.getenv("STONEHASH_API_KEY"))
        .build();
if (!submission.verifies(client.registeredKey(exchangeId))) {
    throw new IllegalStateException("not signed with the key registered for this exchange; nothing was sent");
}
SubmitResult result = client.submit(submission);          // the statement and its signature, nothing else
Receipt receipt = Receipt.of(result, snapshot, client, Instant.now());
SnapshotDirectory.writeReceipt(dir, receipt);

// 5. Later: has the anchor been confirmed?
client.waitAnchored(result.snapshotId(), Duration.ofMinutes(10));
SnapshotDirectory.writeReceipt(dir, receipt.anchorConfirmed());
```

`examples/PorExample.java` holds the same steps as small named functions,
compiled and tested; `bin/por-example` runs it from the command line.

### The ledger rules

`add(account, asset, amount)` is one row per account and asset;
`addAccount(account, Map<asset, amount>)` is one row per account. They apply
the rules of the specification's CSV intake unchanged, and a refused row is
a `Problem` whose `line()` is the 1-based ordinal of the call. Rows may
arrive in any order.

- Read the amount as **text** — `rs.getString(...)` or
  `rs.getBigDecimal(...).toPlainString()` — and say whether it is the unit
  people read (`AmountUnit.DECIMAL`: `0.5` is half a coin) or the smallest
  unit (`AmountUnit.BASE`). The conversion is exact or refused
  (`amount_precision`, `amount_negative`, `amount_exponent`, ...).
- An asset you did not declare is `unknown_asset`, not a dropped row.
- A second row for the same account and asset is `duplicate_row`, not a
  sum. Sum in your query, where the decision can be reviewed.
- An account reference is used byte for byte; one with leading or trailing
  whitespace is `account_whitespace`, not trimmed into a different one.
- A null account, asset or amount is treated as empty text and refused under
  the matching rule; in `addAccount` a missing, null or empty amount is
  "holds none".
- `finish()` returns rows only if nothing at all was refused. The report
  keeps the first 50 problems (`maxProblems`) and counts all of them.

Reading a CSV export instead is `CsvLedger.read(path, new CsvOptions(assets,
AmountUnit.DECIMAL))`; the file is streamed, and the report also carries the
layout, the ignored columns and the file's SHA-256.

## Signing with an HSM or a KMS

The library needs one operation from whatever holds your key, so the key
stays where you keep it. Implement `Signer` — the exact bytes to sign in,
the 64 bytes `r ‖ s` out:

```java
Signer kms = message -> {
    byte[] der = myKms.sign("exchange-signing-key", "ECDSA_SHA_256", message);  // ECDSA P-256 over SHA-256
    return Signers.derToRaw(der);                                               // DER to r ‖ s
};
Submission submission = Submission.sign(snapshot, kms);
```

The signature is ES256: ECDSA over P-256, with SHA-256 of the message. A
service that takes a digest is given the SHA-256 of `message`. Most services
and PKCS#11 tokens answer in DER; `Signers.derToRaw` converts. A signer that
returns anything other than 64 bytes is refused before an envelope exists.

This was tested with a stand-in service (a key held outside the library that
signs in DER), not against a real HSM or cloud KMS.

`Signers.fromPkcs8Pem` reads an unencrypted PKCS#8 file
(`-----BEGIN PRIVATE KEY-----`) and gives a `KeySigner`, whose
`publicKeySpkiBase64()` is the form the platform registers — compare it with
`client.registeredKey(exchangeId)`.

## Proofs for your customers

```java
ProofFile proof = ProofFile.issue(SnapshotDirectory.readStatement(dir),
                                  SnapshotDirectory.load(dir), "U-100008");
SnapshotDirectory.writeProofFile(Paths.get("proof-U-100008.json"), proof);
```

`SnapshotDirectory.load` checks `leaves.jsonl` against the checksum in
`tree.json` and rebuilds the tree; it refuses to return one whose root,
totals or account count differ from the recorded ones, so a proof is never
issued from a damaged or mixed-up snapshot. It reads a directory written by
this SDK or by the reference SDK (verified with the vectors' `snapshot-dir/`,
which the TypeScript SDK wrote).

What the customer, or their auditor, runs — offline, with nothing but the
proof file and the published statement:

```java
ProofFile received = SnapshotDirectory.readProofFile(Paths.get("proof-U-100008.json"));
boolean holds = received.verify(publishedStatement).ok()
        && received.referenceMatches(publishedStatement.institutionId());
```

## Which files to keep, and why

`SnapshotDirectory.write` leaves one directory per snapshot.

| File | Holds | Mode | Why you keep it |
|---|---|---|---|
| `leaves.jsonl` | one line per account: its reference, hashed reference, salt, balances | 0600 | Proofs are issued from it. It is the only place the salts are stored. |
| `seed.hex` | the 32 bytes every salt was derived from | 0600 | With it and the same ledger rows, `leaves.jsonl` can be rebuilt. |
| `tree.json` | the root, totals, account count and the checksum of `leaves.jsonl` | 0600 | What a load is checked against. |
| `snapshot.json` | the statement | default | What was signed; needed to issue and check proofs. |
| `submission.json` | the statement and its signature | default | Exactly what was sent. |
| `receipt.json` | the platform's answer: snapshot id, status, public URL | default | Where to look the snapshot up. |
| `openings.json` | the openings sent in answer to a spot check | default | An exact record of the account-level data that left. Only after a spot check. |

**Lose `leaves.jsonl` and `seed.hex` and no customer's proof can be issued
for that snapshot again.** The anchored statement stays valid and becomes
uncheckable. Back the directory up as you would the ledger itself, and keep
it as private: `leaves.jsonl` is your customer list with balances.

`write` refuses to replace a snapshot that has a receipt — one the platform
has taken — with another (a different seed or root): a new snapshot goes into
a new directory. A directory without a receipt is overwritten. The directory
itself is created with your process's default permissions; only the three
files above are restricted.

## What leaves the building

By default — `client.submit(submission)` — one request with a body:

- the statement: the schema name, your institution id and name, the as-of
  time, the assets with their decimal places, the tree's algorithm name,
  the **number of accounts** and the **root**, the **total per asset**, two
  fixed strings naming how references and salts are derived, the reserve
  addresses if you declared any, and the time the statement was built;
- the signature envelope: `ES256`, your institution id, your name, the
  signature.

No account reference, no balance, no salt, no leaf.

With a spot check — `client.submitWithSpotCheck(submission, tree)` — the
same request with `"spot_check": true`, then a second one answering the
platform's challenge. The platform names leaf positions (its code draws
eight per snapshot, or every leaf when there are fewer; the SDK opens exactly
the positions it is given, whatever their number). For each of them the SDK sends an
opening: the leaf's position, its **hashed** account reference, its salt,
**that account's balance in every asset**, and for each level of the tree
the neighbouring node's hash, sums and side. That is account-level data
leaving the building, pseudonymously. The account reference itself is never
in an opening. `SubmitResult.openings()` returns exactly what was sent.

Before either, `client.registeredKey(id)` fetches the platform's public
registry (nothing of yours is sent). `status` and `waitAnchored` send the
snapshot id. The API key travels in the `Authorization` header of each
request and nowhere else; it is in no URL, no exception message and no
`toString()`.

The tree, the leaves, the seed and the ledger are never sent by anything in
this library.

The sandbox anchors to a private test chain. A sandbox anchor shows the
mechanism working; it is not publicly verifiable.

## The platform client

- Refusals arrive as `PorApiException` with `status()`, the platform's
  `code()` (`invalid_signature`, `subscription_required`, `wrong_state`, ...)
  and its message. `unreachable`, `invalid_response` and `anchor_timeout`
  are this client's own codes, with status 0 when no answer arrived.
- **Connections.** The platform closes a connection that has been idle for
  five seconds. Every POST is sent by an `HttpClient` created for it alone,
  so it can only travel on a connection opened for it, and it is never sent
  twice. GETs share one client; one that fails before a complete answer
  arrives is sent once more on a new connection. (Not a client per request
  throughout: on Java 11 an `HttpClient` cannot be closed, and each
  discarded one keeps its selector thread until the garbage collector
  reclaims it.) Both are covered by tests against a stand-in server that
  closes idle connections and drops requests on reused ones.
- Timeouts: 10 s to connect, 120 s per request by default; both settable.
  Redirects are not followed. An answer larger than 8 MiB is abandoned.
- A `PorClient` is immutable and may be shared between threads. Make one and
  keep it: each holds an `HttpClient` of its own.
- Path parameters are percent-encoded.

## Measured size

Build time and peak memory from in-memory rows (text, as a database prints
them) through `LedgerBuilder` and `PorTree.build`, three assets, about three
balances in four held. One run each on a shared 4-core x86-64 machine,
OpenJDK 11.0.33, measured with `./measure.sh` (GNU `time -v`; "peak memory"
is the process's maximum resident set size):

| Accounts | Heap limit | Ledger + tree | Peak memory |
|---|---|---|---|
| 100,000 | `-Xmx2g` | 1.5 s (0.5 + 1.0) | 481 MiB |
| 300,000 | `-Xmx2g` | 2.8 s (0.8 + 2.0) | 1,348 MiB |
| 100,000 | `-Xmx96m` | 1.5 s | 205 MiB |
| 300,000 | `-Xmx256m` | 2.9 s | 376 MiB |

The first two rows are what the JVM takes when it is allowed 2 GB — it
collects garbage late — and varied by 85 and 154 MiB between two runs; the
last two show the same builds completing in far less. After the build, the heap holds
62–78 MB for 100,000 accounts and 224 MB for 300,000 (the input rows, the
ledger and the tree together).

The whole example on a 300,000-account CSV export (680,424 rows, 19.9 MB):
`bin/por-example build` took 3.7 s and 1.1 GiB peak under `-Xmx2g`, and wrote
a 74.9 MB `leaves.jsonl`. The reference SDK built the same export to the
same root, and its `leaves.jsonl`, `tree.json` and `seed.hex` were identical
byte for byte.

Nothing larger than 300,000 accounts has been run. Memory grows with
accounts × assets: every node of the tree carries a sum for every asset. The
hard limit of the data structures is 67,108,862 accounts with up to 32
assets (one Java array per tree level).

`LedgerBuilder` keeps one entry per account and nothing per call; `PorTree`
shares the ledger's rows rather than copying them. Give the JVM more heap
for a larger ledger: `POR_JAVA_OPTS=-Xmx4g bin/por-example build ...`.

## The example program

```
bin/por-example build   --csv FILE --amounts decimal|base --assets BTC:8,ETH:18 --exchange ID --name NAME
                        --asof ISO --out DIR [--seed-hex HEX64] [--generated-at ISO] [--layout long|wide]
                        [--delimiter C] [--col-account N] [--col-asset N] [--col-balance N] [--ignore-columns a,b]
bin/por-example sign    --dir DIR --key PEMFILE
bin/por-example submit  --dir DIR --core URL [--spot-check] [--wait] [--timeout-sec N]
bin/por-example status  --core URL --snapshot ID
bin/por-example prove   --dir DIR --user-ref REF --out FILE
bin/por-example verify-proof --proof FILE --snapshot FILE
bin/por-example conformance --vectors DIR
```

The API key for `submit` and `status` is read from the environment variable
`STONEHASH_API_KEY`. Exit codes: 0 done; 1 a mistake on the command line, a
file that is missing or cannot be used, or a refusal by the platform; 2 an
export with problems (`build`), a proof that fails (`verify-proof`), or a
failed vector (`conformance`).

`build` prints `root`, `totals` (canonical JSON) and `commitment`; for an
export with problems it prints one `line <n> <code> <message>` per problem
on standard error and writes nothing. `submit` checks the signature against
the registered key before sending, and prints `snapshot <id> <STATUS>`.
The launcher switches to a UTF-8 locale when the current one is not, because
Java decodes its arguments in the locale's character set.

## What it does not do

- It does not create or register signing keys; the platform's console does.
- It does not read encrypted key files, or SEC1 (`EC PRIVATE KEY`) files.
- It does not measure reserves, and it does not check the anchor itself: it
  reports what the platform says about it.
- It does not retry a POST, ever, and does not follow redirects.
- It does not encrypt the private files or manage their backup; it restricts
  their mode and refuses a file system that cannot do that.
- It does not read snapshot directories of the older `stonehash.por-tree.v1`
  layout.
- It does not read exports that are not UTF-8, and it does not guess a
  delimiter, a layout it was told otherwise about, or an amount unit.
- `LedgerBuilder` is for one thread. `PorTree`, `Statement` and `PorClient`
  are immutable and may be shared.
- It has not been run against a live platform deployment from here: the
  client is tested against a stand-in that follows the published API.

## Building and testing

```sh
./build.sh        # dist/*.jar and the example
./run-tests.sh    # builds, then runs the test suite and the vectors
bin/por-example conformance --vectors ../../fixtures/por
```

`run-tests.sh` expects the specification and vectors in `../../fixtures/por`
(set `POR_VECTORS` otherwise). The last run: 88 tests, 88 passed. See
`CONFORMANCE.md` for the vector results and for where the specification is
ambiguous.
