package por

import (
	"fmt"
	"strings"
)

// Error is how this package says no.
//
// Code is stable: it is the value to switch on, and for everything the
// specification names (amounts, accounts, the CSV dialect, headers, rows) it
// is the specification's own code. Message is for a person. Line is set when
// the refusal is about one row of a ledger: the 1-based line of a file, or
// the 1-based ordinal of the call when rows came from code. It is 0
// otherwise.
type Error struct {
	Code    string
	Message string
	Line    int

	cause error
}

func (e *Error) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("line %d: %s: %s", e.Line, e.Code, e.Message)
	}
	return e.Code + ": " + e.Message
}

// Unwrap returns the error this one was caused by, if any: the file system's,
// the network's, a Signer's.
func (e *Error) Unwrap() error { return e.cause }

func errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

func wrap(code string, cause error, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...) + ": " + cause.Error(), cause: cause}
}

// Amounts (specification §2).
const (
	CodeAmountEmpty          = "amount_empty"
	CodeAmountTooLong        = "amount_too_long"
	CodeAmountNegative       = "amount_negative"
	CodeAmountExponent       = "amount_exponent"
	CodeAmountGrouping       = "amount_grouping"
	CodeAmountFractionInBase = "amount_fraction_in_base"
	CodeAmountPrecision      = "amount_precision"
	CodeAmountFormat         = "amount_format"
)

// Accounts and rows (specification §3 and §7).
const (
	CodeAccountEmpty            = "account_empty"
	CodeAccountWhitespace       = "account_whitespace"
	CodeAccountControlCharacter = "account_control_character"
	CodeAccountTooLong          = "account_too_long"
	CodeUnknownAsset            = "unknown_asset"
	CodeDuplicateRow            = "duplicate_row"
	CodeDuplicateAccount        = "duplicate_account"
	CodeFieldCount              = "field_count"
	CodeNoAccounts              = "no_accounts"
)

// The file and its header (specification §7).
const (
	CodeFileEncoding        = "file_encoding"
	CodeCSVSyntax           = "csv_syntax"
	CodeEmptyFile           = "empty_file"
	CodeHeaderEmptyName     = "header_empty_name"
	CodeHeaderDuplicate     = "header_duplicate"
	CodeHeaderNoAccount     = "header_no_account"
	CodeHeaderUnrecognised  = "header_unrecognised"
	CodeHeaderMissingColumn = "header_missing_column"
	CodeHeaderUnknownColumn = "header_unknown_column"
	CodeHeaderMissingAsset  = "header_missing_asset"
)

// Refusals the specification leaves to each SDK to name.
const (
	// CodeAccountEncoding: an account reference passed from code is not valid
	// UTF-8. A file cannot produce it (the file as a whole is refused with
	// file_encoding); a Go string can.
	CodeAccountEncoding = "account_encoding"
	// CodeInvalidOption: the caller's own configuration — assets, unit,
	// delimiter, exchange id, seed, time, URL — is not usable.
	CodeInvalidOption = "invalid_option"
	// CodeTooManyAccounts: the ledger has more accounts than a statement can
	// declare (2147483647).
	CodeTooManyAccounts = "too_many_accounts"
	// CodeLedgerClosed: a row was offered after Finish.
	CodeLedgerClosed = "ledger_closed"
	// CodeEmptyLedger: a tree was asked of no accounts.
	CodeEmptyLedger = "empty_ledger"
	// CodeDuplicateLeaf: two leaves carry the same user_ref_hash.
	CodeDuplicateLeaf = "duplicate_leaf"
	// CodeInvalidBalance: a balance is not a non-negative integer.
	CodeInvalidBalance = "invalid_balance"
	// CodeIndexOutOfRange: a row or leaf index is outside the ledger or tree.
	CodeIndexOutOfRange = "index_out_of_range"
	// CodeUnknownAccount: no leaf belongs to the account reference given.
	CodeUnknownAccount = "unknown_account"
	// CodeInvalidProof: a proof is malformed or does not lead to the root and totals.
	CodeInvalidProof = "invalid_proof"
	// CodeInvalidJSON: a document is not JSON, or is JSON of the wrong shape.
	CodeInvalidJSON = "invalid_json"
	// CodeNotCanonical: a value has no canonical JSON form (a fraction, an
	// integer beyond 2^53 − 1).
	CodeNotCanonical = "not_canonical"
	// CodeInvalidStatement: a snapshot statement does not have the shape of §6.
	CodeInvalidStatement = "invalid_statement"
	// CodeInvalidSubmission: a submission is not a statement and a signature.
	CodeInvalidSubmission = "invalid_submission"
	// CodeInvalidSignature: a signature is malformed or does not verify.
	CodeInvalidSignature = "invalid_signature"
	// CodeInvalidKey: a key is unreadable or is not ECDSA P-256.
	CodeInvalidKey = "invalid_key"
	// CodeSigner: the Signer failed.
	CodeSigner = "signer_failed"
	// CodeIO: a file could not be read or written.
	CodeIO = "io"
	// CodeSnapshotExists: the directory holds another snapshot's seed.
	CodeSnapshotExists = "snapshot_exists"
	// CodeSnapshotDamaged: a private file is missing, malformed or
	// inconsistent with the others.
	CodeSnapshotDamaged = "snapshot_damaged"
	// CodeLeavesChecksum: leaves.jsonl is not the file tree.json recorded.
	CodeLeavesChecksum = "leaves_checksum_mismatch"
	// CodeRootMismatch: the leaves do not rebuild the recorded root.
	CodeRootMismatch = "root_mismatch"
	// CodeTreeMismatch: a tree is not the one a statement commits to.
	CodeTreeMismatch = "tree_mismatch"
)

// Refusals raised by the Client without the platform having said so. What the
// platform itself refuses arrives as an *APIError.
const (
	// CodeNoAPIKey: the call needs an API key and the client has none.
	CodeNoAPIKey = "no_api_key"
	// CodeUnreachable: no answer was received.
	CodeUnreachable = "unreachable"
	// CodeUnexpectedResponse: the answer is not what §9 describes.
	CodeUnexpectedResponse = "unexpected_response"
	// CodeInstitutionUnregistered: the registry lists no signing key for the exchange.
	CodeInstitutionUnregistered = "institution_unregistered"
	// CodeSpotCheckRequired: a submission that did not ask for a spot check
	// was answered with a challenge.
	CodeSpotCheckRequired = "spot_check_required"
	// CodeChallengeRefused: the challenge asks for more than this SDK opens.
	CodeChallengeRefused = "challenge_refused"
	// CodeSnapshotRejected: the platform rejected the snapshot.
	CodeSnapshotRejected = "snapshot_rejected"
	// CodeAnchorTimeout: the anchor was not confirmed within the time allowed.
	CodeAnchorTimeout = "anchor_timeout"
	// CodeCancelled: the caller's context ended a wait.
	CodeCancelled = "cancelled"
)

// quote renders a value taken from the caller's data for an error message:
// printable text stays readable, and anything that could break a log line or
// is not valid UTF-8 is escaped.
func quote(s string) string {
	return fmt.Sprintf("%q", s)
}

func quoteAll(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = quote(v)
	}
	return strings.Join(quoted, ", ")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
