package por

import (
	"errors"
	"math/big"
	"slices"
	"strconv"
	"unicode/utf8"

	"stonehash.com/attest/por/internal/cjson"
)

// maxAccountBytes bounds an account reference, in bytes of UTF-8.
const maxAccountBytes = 256

// defaultMaxProblems is how many problems a report keeps unless told otherwise.
const defaultMaxProblems = 50

// LedgerOptions declares what a ledger holds.
type LedgerOptions struct {
	// Assets is every asset the snapshot covers, in the order the statement
	// will list them. A balance in an asset not declared here is refused,
	// never dropped: dropping it would understate liabilities without a trace.
	Assets []Asset
	// Amounts says how the ledger writes amounts. It has no default.
	Amounts AmountUnit
	// MaxProblems is how many problems the report keeps; every one is
	// counted. Zero means 50.
	MaxProblems int
}

// Problem is one thing wrong with a ledger.
type Problem struct {
	// Line is the 1-based line of the file, or the 1-based ordinal of the
	// call when rows came from code. It is 0 for a problem with the ledger as
	// a whole.
	Line    int
	Code    string
	Message string
}

// Report says what a ledger added up to, or what was wrong with it.
//
// Its figures name no account. Its problems may: a problem's Message quotes
// the account reference or the amount it is about, so that the row can be
// found, and should be handled as the ledger itself is.
type Report struct {
	// OK is true when nothing at all was refused. Only then is there a Ledger.
	OK bool
	// Layout is the layout a file was read in; empty for rows from code, and
	// when a file's header did not settle it.
	Layout Layout
	// DataRows is the number of rows offered: data rows of a file (the header
	// is not one), or calls to the builder.
	DataRows int
	// Accounts is the number of distinct accounts seen.
	Accounts int
	// ZeroBalanceAccounts is how many accounts have every balance zero.
	ZeroBalanceAccounts int
	// Totals is the sum per asset in smallest units, in declared order.
	Totals Balances
	// Holders is, per asset, the number of accounts holding more than zero.
	// These three figures are stated only when OK: what the rows that
	// happened to be accepted add up to is not what the ledger adds up to.
	Holders map[string]int
	// IgnoredColumns are a file's columns that were not read.
	IgnoredColumns []string
	// FileSHA256 and FileBytes identify the file the figures came from.
	FileSHA256 string
	FileBytes  int64
	// ProblemCount counts every problem; Problems holds the first
	// MaxProblems of them, in the order they were found.
	ProblemCount int
	Problems     []Problem
}

// Row is one account of a ledger: its reference, and the balances the ledger
// gave for it, in the order it gave them.
type Row struct {
	UserRef  string
	Balances Balances
}

// account is a ledger row as it is stored. The tree takes these over as they
// are, so a ledger is never in memory twice.
type account struct {
	ref  string
	held []holding
}

// holding is one balance of one account. The amount is held by value and
// trimmed to its size (see setCompact): there is one of these for every
// balance of every account.
type holding struct {
	asset  int32
	amount big.Int
}

func (a *account) holds(asset int32) bool {
	for i := range a.held {
		if a.held[i].asset == asset {
			return true
		}
	}
	return false
}

// Ledger is a set of accounts that read cleanly: the input of BuildTree.
// It comes from LedgerBuilder.Finish, ReadCSV or ReadCSVFile, and exists only
// when their report is OK.
type Ledger struct {
	assets   []Asset
	accounts []account
}

// Assets returns the declared assets, in order.
func (l *Ledger) Assets() []Asset { return slices.Clone(l.assets) }

// Len returns the number of accounts.
func (l *Ledger) Len() int { return len(l.accounts) }

// Row returns the i-th account, in order of first appearance. The amounts are
// copies; changing them does not change the ledger.
func (l *Ledger) Row(i int) (Row, error) {
	if i < 0 || i >= len(l.accounts) {
		return Row{}, errorf(CodeIndexOutOfRange, "row %d is outside the ledger (0..%d)", i, len(l.accounts)-1)
	}
	a := &l.accounts[i]
	row := Row{UserRef: a.ref, Balances: make(Balances, len(a.held))}
	for j := range a.held {
		row.Balances[j] = Balance{Asset: l.assets[a.held[j].asset].Symbol, Amount: new(big.Int).Set(&a.held[j].amount)}
	}
	return row, nil
}

// LedgerBuilder takes a ledger one row at a time, straight from wherever the
// exchange keeps it — a database cursor, a message stream — with no file in
// between. It applies the rules a balance export is read by (specification
// §7), so the two ways in cannot come to disagree about a row:
//
//   - an asset that was not declared is a problem, not a dropped row;
//   - a second row for the same account and asset is a problem, not a sum —
//     whether two wallets of one customer add up is the exchange's decision,
//     made in its own query where it can be reviewed;
//   - an account reference is used byte for byte, so one with stray padding
//     is refused rather than trimmed into a different one;
//   - an amount is converted exactly or refused (see ToBaseUnits).
//
// Rows may arrive in any order. Each call returns what was wrong with its
// row, if anything, but the decision is taken at the end, on the whole
// ledger: Finish hands back a Ledger only when nothing at all was refused. A
// tree built from the rows that happened to be accepted would commit to a
// total nobody chose.
//
// A LedgerBuilder is not safe for concurrent use.
type LedgerBuilder struct {
	assets []Asset
	// position is each declared symbol's index in assets.
	position map[string]int32
	// byLower finds the declared symbol a cell differs from only by letter case.
	byLower map[string]string
	unit    AmountUnit

	accounts []account
	// byRef is each account's index in accounts.
	byRef map[string]int32
	// maxAccounts is the most accounts a statement can declare.
	maxAccounts int
	// overfull: an account beyond maxAccounts was offered, and reported.
	overfull bool

	maxProblems  int
	problemCount int
	problems     []Problem

	calls int
	// cells and parsed are scratch space for one wide row.
	cells   []cell
	parsed  []holding
	scratch big.Int

	closed bool
	ledger *Ledger
	report *Report
}

// cell is one asset's amount text in a wide row.
type cell struct {
	asset int32
	text  string
}

// NewLedgerBuilder starts an empty ledger.
func NewLedgerBuilder(opts LedgerOptions) (*LedgerBuilder, error) {
	if err := checkAssets(opts.Assets); err != nil {
		return nil, err
	}
	if err := checkUnit(opts.Amounts); err != nil {
		return nil, err
	}
	if opts.MaxProblems < 0 {
		return nil, errorf(CodeInvalidOption, "MaxProblems cannot be negative")
	}
	b := &LedgerBuilder{
		assets:      slices.Clone(opts.Assets),
		position:    make(map[string]int32, len(opts.Assets)),
		byLower:     make(map[string]string, len(opts.Assets)),
		unit:        opts.Amounts,
		byRef:       map[string]int32{},
		maxAccounts: maxLeafCount,
		maxProblems: opts.MaxProblems,
	}
	if b.maxProblems == 0 {
		b.maxProblems = defaultMaxProblems
	}
	for i, a := range b.assets {
		b.position[a.Symbol] = int32(i)
		b.byLower[lowerASCII(a.Symbol)] = a.Symbol
	}
	return b, nil
}

// Add offers one row per account and asset: the shape of
// SELECT account, asset, balance. amount is text, exactly as the ledger
// prints it — never a float.
//
// It returns nil when the row was accepted, and otherwise the *Error that was
// also recorded for Finish, whose Line is the ordinal of this call.
func (b *LedgerBuilder) Add(account, asset, amount string) error {
	if b.closed {
		return errClosed()
	}
	b.calls++
	if refusal := b.longRow(b.calls, account, asset, amount); refusal != nil {
		return refusal
	}
	return nil
}

// AddAccount offers one row per account: every balance of the account at
// once, as amount text per asset symbol. An asset left out, or given as an
// empty string, is "holds none" — what a NULL prints as. A symbol that was
// not declared is a problem.
//
// It returns nil when the row was accepted, and otherwise what was recorded
// for Finish: one *Error, or several joined when more than one amount was
// refused (errors.As finds the first).
func (b *LedgerBuilder) AddAccount(account string, amounts map[string]string) error {
	if b.closed {
		return errClosed()
	}
	b.calls++
	b.cells = b.cells[:0]
	for i, a := range b.assets {
		b.cells = append(b.cells, cell{asset: int32(i), text: amounts[a.Symbol]})
	}
	var undeclared []string
	for symbol := range amounts {
		if _, ok := b.position[symbol]; !ok {
			undeclared = append(undeclared, symbol)
		}
	}
	// Named in ascending order of UTF-16 code units, as the specification has it.
	slices.SortFunc(undeclared, cjson.CompareUTF16)
	return b.wideRow(b.calls, account, b.cells, undeclared)
}

func errClosed() *Error {
	return errorf(CodeLedgerClosed, "the ledger was finished; rows cannot be added to it any more")
}

// problem records one refusal and returns it as the error for its row.
func (b *LedgerBuilder) problem(line int, code, message string) *Error {
	b.problemCount++
	if len(b.problems) < b.maxProblems {
		b.problems = append(b.problems, Problem{Line: line, Code: code, Message: message})
	}
	return &Error{Code: code, Message: message, Line: line}
}

// accountProblem applies the rules of specification §3 in the order §7 lists
// their codes.
func accountProblem(ref string) (code, message string) {
	switch {
	case ref == "":
		return CodeAccountEmpty, "the account identifier is empty"
	case !utf8.ValidString(ref):
		// The identifier is hashed as UTF-8 and written to JSON; bytes that
		// are not UTF-8 would be a different identifier in every other tool.
		return CodeAccountEncoding, "account identifier " + quote(ref) + " is not valid UTF-8"
	case ref != trim(ref):
		return CodeAccountWhitespace, "account identifier " + quote(ref) +
			" has leading or trailing whitespace; trim it where the ledger is read, so the identifier is the one your customer knows"
	case hasControl(ref):
		// The identifier sits after a line break in the hashed text, so one
		// that contains a line break could be read as another exchange's.
		return CodeAccountControlCharacter, "account identifier " + quote(ref) + " contains a control character"
	case len(ref) > maxAccountBytes:
		return CodeAccountTooLong, "account identifier is longer than " + strconv.Itoa(maxAccountBytes) + " bytes"
	}
	return "", ""
}

// longRow is the row of the long layout, at a stated line. The checks run in
// a fixed order and the first failure ends the row.
func (b *LedgerBuilder) longRow(line int, ref, assetCell, amount string) *Error {
	if code, message := accountProblem(ref); code != "" {
		return b.problem(line, code, message)
	}
	symbol := trim(assetCell)
	asset, declared := b.position[symbol]
	if !declared {
		return b.problem(line, CodeUnknownAsset, b.undeclaredMessage(symbol))
	}
	at, known := b.byRef[ref]
	if !known {
		if refusal := b.full(); refusal != nil {
			return refusal
		}
		at = int32(len(b.accounts))
		b.accounts = append(b.accounts, account{ref: ref})
		b.byRef[ref] = at
	}
	acct := &b.accounts[at]
	// Looked up in the row being built anyway; a separate index of every
	// (account, asset) pair would double the memory of a large ledger.
	if acct.holds(asset) {
		return b.problem(line, CodeDuplicateRow, "account "+quote(ref)+" has more than one "+symbol+
			" row; one row per account and asset (sum them in the query if they are meant to add up)")
	}
	// The row is held even when its amount is unreadable, so that a later
	// row for the same pair is still a duplicate.
	acct.held = append(acct.held, holding{asset: asset})
	digits, refusal := baseUnitDigits(amount, b.assets[asset].Decimals, b.unit)
	if refusal != nil {
		return b.problem(line, refusal.Code, symbol+": "+refusal.Message)
	}
	b.store(&acct.held[len(acct.held)-1].amount, digits)
	return nil
}

func (b *LedgerBuilder) undeclaredMessage(symbol string) string {
	if near, ok := b.byLower[lowerASCII(symbol)]; ok {
		return "asset " + quote(symbol) + " differs from the declared " + near + " only by letter case; asset symbols are matched exactly"
	}
	return "asset " + quote(symbol) + " is not a declared asset; a balance in an undeclared asset would be left out of the totals"
}

// wideRow is the row of the wide layout, at a stated line. cells are the
// amounts in the order they are to be reported; undeclared are names the
// caller supplied that are not assets (a file's header has already refused
// those, so the file reader passes none).
func (b *LedgerBuilder) wideRow(line int, ref string, cells []cell, undeclared []string) error {
	if code, message := accountProblem(ref); code != "" {
		return b.problem(line, code, message)
	}
	if _, known := b.byRef[ref]; known {
		return b.problem(line, CodeDuplicateAccount, "account "+quote(ref)+" appears on more than one row")
	}
	if len(undeclared) > 0 {
		return b.problem(line, CodeUnknownAsset, quoteAll(undeclared)+" "+
			plural(len(undeclared), "is not a declared asset", "are not declared assets")+
			"; a balance in an undeclared asset would be left out of the totals")
	}
	b.parsed = b.parsed[:0]
	var refused []error
	for _, c := range cells {
		b.parsed = append(b.parsed, holding{asset: c.asset})
		if trim(c.text) == "" {
			continue
		}
		digits, refusal := baseUnitDigits(c.text, b.assets[c.asset].Decimals, b.unit)
		if refusal != nil {
			refused = append(refused, b.problem(line, refusal.Code, b.assets[c.asset].Symbol+": "+refusal.Message))
			continue
		}
		b.store(&b.parsed[len(b.parsed)-1].amount, digits)
	}
	if len(refused) > 0 {
		return errors.Join(refused...)
	}
	if refusal := b.full(); refusal != nil {
		return refusal
	}
	b.byRef[ref] = int32(len(b.accounts))
	b.accounts = append(b.accounts, account{ref: ref, held: slices.Clone(b.parsed)})
	return nil
}

// full refuses an account beyond the number a statement can declare. It is a
// problem with the ledger as a whole, recorded once.
func (b *LedgerBuilder) full() *Error {
	if len(b.accounts) < b.maxAccounts {
		return nil
	}
	message := "the ledger has more than " + strconv.Itoa(b.maxAccounts) + " accounts, the most a statement can declare"
	if b.overfull {
		return &Error{Code: CodeTooManyAccounts, Message: message}
	}
	b.overfull = true
	return b.problem(0, CodeTooManyAccounts, message)
}

// store parses digits (already checked: decimal, no leading zeros) into dst.
func (b *LedgerBuilder) store(dst *big.Int, digits string) {
	if len(digits) <= 19 {
		// Nineteen digits always fit sixty-four bits.
		n, _ := strconv.ParseUint(digits, 10, 64)
		dst.SetUint64(n)
		return
	}
	b.scratch.SetString(digits, 10)
	setCompact(dst, &b.scratch)
}

// setCompact stores src in dst with a backing array of exactly the size the
// value needs. math/big leaves room to grow in what it allocates, which suits
// arithmetic and is wasteful for millions of amounts that never change again.
func setCompact(dst, src *big.Int) {
	words := src.Bits()
	if len(words) == 0 {
		dst.SetBits(nil)
		return
	}
	dst.SetBits(append(make([]big.Word, 0, len(words)), words...))
}

// Finish closes the ledger. The Ledger is nil unless the Report is OK.
// Calling it again returns the same result.
func (b *LedgerBuilder) Finish() (*Ledger, *Report) {
	if !b.closed {
		b.finish(b.calls)
	}
	return b.ledger, b.report
}

// finish closes the ledger with a stated number of rows offered: the calls,
// or the data rows of a file, which a file's reader counts itself.
func (b *LedgerBuilder) finish(rowsOffered int) {
	b.closed = true
	if len(b.accounts) == 0 && b.problemCount == 0 {
		b.problem(0, CodeNoAccounts, "there are no accounts; a snapshot of nothing is not evidence")
	}
	b.report = &Report{
		OK:           b.problemCount == 0,
		DataRows:     rowsOffered,
		Accounts:     len(b.accounts),
		ProblemCount: b.problemCount,
		Problems:     b.problems,
	}
	accounts := b.accounts
	// The index was for finding duplicates; nothing after this point needs it.
	b.accounts, b.byRef = nil, nil
	if !b.report.OK {
		// No totals either: figures from the rows that happened to be
		// accepted are not the ledger's, and would look as if they were.
		return
	}

	totals := make([]big.Int, len(b.assets))
	holders := make([]int, len(b.assets))
	for i := range accounts {
		holdsSomething := false
		for j := range accounts[i].held {
			h := &accounts[i].held[j]
			if h.amount.Sign() == 0 {
				continue
			}
			holdsSomething = true
			totals[h.asset].Add(&totals[h.asset], &h.amount)
			holders[h.asset]++
		}
		if !holdsSomething {
			b.report.ZeroBalanceAccounts++
		}
	}
	b.report.Totals = make(Balances, len(b.assets))
	b.report.Holders = make(map[string]int, len(b.assets))
	for i, a := range b.assets {
		b.report.Totals[i] = Balance{Asset: a.Symbol, Amount: &totals[i]}
		b.report.Holders[a.Symbol] = holders[i]
	}
	b.ledger = &Ledger{assets: b.assets, accounts: accounts}
}
