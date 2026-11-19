// Package por is the exchange's side of StoneHash Attest proof of reserves,
// as a library to run inside the exchange's own systems.
//
// An exchange builds a Merkle sum tree of its customers' balances on its own
// machines and gives the platform one signed statement: the root of the tree,
// the total of every asset, the number of accounts and the time the ledger
// was read. The platform checks the signature and anchors a commitment to the
// statement. By default nothing about any account leaves the exchange.
//
// A snapshot goes through these steps, each one a call:
//
//	rows of the ledger   LedgerBuilder (from your own query) or ReadCSVFile
//	         ↓           every row checked; any problem and there is no ledger
//	Ledger               BuildTree, with a seed from NewSeed
//	         ↓
//	Tree                 NewStatement
//	         ↓
//	Statement            NewSubmission, with a Signer (a key file, an HSM, a KMS)
//	         ↓
//	Submission           Client.Submit, or Client.SubmitWithSpotCheck
//
// WriteSnapshotDir keeps what the exchange needs afterwards: the leaves and
// the seed, from which a customer's inclusion proof is issued for as long as
// the snapshot is of interest (LoadSnapshotDir, Tree.ProofFor,
// WriteProofFile). VerifyProof is what the customer, or their auditor, runs.
//
// Three rules hold throughout.
//
// Amounts are whole numbers of an asset's smallest unit, held as *big.Int
// and written as decimal strings. A conversion from a ledger's text is exact
// or it is refused; nothing is rounded.
//
// Nothing that could change a total is decided silently. An asset that was
// not declared, a second row for the same account and asset, an account
// reference with stray padding, a negative amount: each is a problem with a
// stable code, and a ledger with any problem builds nothing.
//
// Refusals are values. Every error this package creates is an *Error whose
// Code is stable; what the platform refuses is an *APIError. Nothing panics
// on bad input.
//
// The byte-level rules — canonical JSON, the leaf and node hashes, the
// statement, the signature, the CSV dialect, the private files, the API —
// are those of the specification this SDK is tested against; its section
// numbers are quoted in the comments. The package has no dependency outside
// the standard library.
package por
