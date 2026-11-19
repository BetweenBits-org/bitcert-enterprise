package por

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
)

// Layout is the shape of a balance export.
type Layout string

const (
	// Long: one row per account and asset — account_id,asset,balance.
	Long Layout = "long"
	// Wide: one row per account, a column per asset — account_id,BTC,ETH,USDT.
	Wide Layout = "wide"
)

// Columns names the header columns of an export that does not use the
// standard names. An empty field keeps the standard one: "account_id",
// "asset", "balance".
type Columns struct {
	Account string
	Asset   string
	Balance string
}

// CSVOptions says how to read a balance export.
type CSVOptions struct {
	// Assets is every asset the snapshot covers, in the order the statement
	// will list them.
	Assets []Asset
	// Amounts says how the file writes amounts. It has no default.
	Amounts AmountUnit
	// Layout, when empty, is decided from the header.
	Layout Layout
	// Columns renames the header columns.
	Columns Columns
	// IgnoreColumns lists columns of a wide file that are neither the account
	// nor an asset. An unknown column in a wide file might be an asset, so it
	// has to be named here to be passed over.
	IgnoreColumns []string
	// Delimiter is ',' when zero.
	Delimiter rune
	// MaxProblems is how many problems the report keeps; every one is
	// counted. Zero means 50.
	MaxProblems int
}

// ReadCSVFile reads and checks a balance export.
//
// The file is streamed: it is never held in memory as a whole, and its
// SHA-256 is taken in the same pass. The error is non-nil only when the file
// could not be read or the options are unusable; what is wrong with the
// file's contents is in the Report, and the Ledger is nil unless the Report
// is OK. Nothing is built from a file that did not read cleanly.
func ReadCSVFile(path string, opts CSVOptions) (*Ledger, *Report, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, wrap(CodeIO, err, "the export could not be opened")
	}
	defer f.Close()
	return ReadCSV(f, opts)
}

// ReadCSV is ReadCSVFile for an export that arrives as a stream.
func ReadCSV(src io.Reader, opts CSVOptions) (*Ledger, *Report, error) {
	if opts.Layout != "" && opts.Layout != Long && opts.Layout != Wide {
		return nil, nil, errorf(CodeInvalidOption, "the layout is %q or %q", Long, Wide)
	}
	delimiter := opts.Delimiter
	if delimiter == 0 {
		delimiter = ','
	}
	if err := checkDelimiter(delimiter); err != nil {
		return nil, nil, err
	}
	ledger, err := NewLedgerBuilder(LedgerOptions{Assets: opts.Assets, Amounts: opts.Amounts, MaxProblems: opts.MaxProblems})
	if err != nil {
		return nil, nil, err
	}

	digest := sha256.New()
	var size byteCounter
	hashed := io.TeeReader(src, io.MultiWriter(digest, &size))
	records := newCSVReader(hashed, delimiter)

	in := intake{ledger: ledger, opts: opts, layout: opts.Layout}
	var encoding *csvFault
	for {
		rec, ok, fault, err := records.next()
		if err != nil {
			return nil, nil, wrap(CodeIO, err, "the export could not be read")
		}
		if fault != nil {
			if fault.code == CodeFileEncoding {
				encoding = fault
			} else {
				ledger.problem(fault.line, fault.code, fault.message)
			}
			break
		}
		if !ok {
			break
		}
		in.record(rec)
	}
	// Reading may have stopped early; the checksum is of the whole file.
	if _, err := io.Copy(io.Discard, hashed); err != nil {
		return nil, nil, wrap(CodeIO, err, "the export could not be read")
	}
	sum := hex.EncodeToString(digest.Sum(nil))

	if encoding != nil {
		// Whatever was made of the rows before the offending byte was made
		// under the wrong assumption about the whole file, so it is not
		// reported alongside.
		return nil, &Report{
			FileSHA256: sum, FileBytes: int64(size), ProblemCount: 1,
			Problems: []Problem{{Line: encoding.line, Code: encoding.code, Message: encoding.message}},
		}, nil
	}
	if !in.sawHeader && ledger.problemCount == 0 {
		ledger.problem(0, CodeEmptyFile, "the file has no header row")
	}
	ledger.finish(in.dataRows)
	report := ledger.report
	report.Layout = in.layout
	report.IgnoredColumns = in.ignored
	report.FileSHA256 = sum
	report.FileBytes = int64(size)
	return ledger.ledger, report, nil
}

type byteCounter int64

func (c *byteCounter) Write(p []byte) (int, error) {
	*c += byteCounter(len(p))
	return len(p), nil
}

// intake interprets the records of one file: the header, then each row.
type intake struct {
	ledger *LedgerBuilder
	opts   CSVOptions

	sawHeader bool
	// headerOK: the header could be used, so the rows are examined.
	headerOK bool
	header   []string
	layout   Layout
	// account, asset and balance are column positions; asset and balance are
	// -1 in a wide file.
	account, asset, balance int
	// assetColumns are a wide file's asset columns, in column order.
	assetColumns []assetColumn
	ignored      []string
	dataRows     int
	cells        []cell
}

type assetColumn struct {
	field int
	asset int32
}

func (in *intake) record(rec csvRecord) {
	if !in.sawHeader {
		in.sawHeader = true
		in.headerOK = in.readHeader(rec)
		return
	}
	// Without a usable header the rows cannot be interpreted; the file is
	// still read to its end, for its syntax and its checksum.
	if !in.headerOK {
		return
	}
	in.dataRows++
	if len(rec.fields) != len(in.header) {
		in.ledger.problem(rec.line, CodeFieldCount, strconv.Itoa(len(rec.fields))+" "+plural(len(rec.fields), "field", "fields")+
			", but the header has "+strconv.Itoa(len(in.header)))
		return
	}
	ref := rec.fields[in.account]
	if in.layout == Long {
		in.ledger.longRow(rec.line, ref, rec.fields[in.asset], rec.fields[in.balance])
		return
	}
	in.cells = in.cells[:0]
	for _, c := range in.assetColumns {
		in.cells = append(in.cells, cell{asset: c.asset, text: rec.fields[c.field]})
	}
	in.ledger.wideRow(rec.line, ref, in.cells, nil)
}

// readHeader applies the header rules of specification §7 in their order. A
// header problem ends interpretation: it returns false and no row is examined.
func (in *intake) readHeader(rec csvRecord) bool {
	problem := func(code, message string) bool {
		in.ledger.problem(rec.line, code, message)
		return false
	}
	in.header = make([]string, len(rec.fields))
	for i, f := range rec.fields {
		in.header[i] = trim(f)
	}
	seen := make(map[string]bool, len(in.header))
	for _, name := range in.header {
		if name == "" {
			return problem(CodeHeaderEmptyName, "the header has a column with no name")
		}
		if seen[lowerASCII(name)] {
			return problem(CodeHeaderDuplicate, "the header names "+quote(name)+" twice")
		}
		seen[lowerASCII(name)] = true
	}

	want := Columns{Account: "account_id", Asset: "asset", Balance: "balance"}
	if in.opts.Columns.Account != "" {
		want.Account = in.opts.Columns.Account
	}
	if in.opts.Columns.Asset != "" {
		want.Asset = in.opts.Columns.Asset
	}
	if in.opts.Columns.Balance != "" {
		want.Balance = in.opts.Columns.Balance
	}
	find := func(name string) int {
		return slices.IndexFunc(in.header, func(h string) bool { return lowerASCII(h) == lowerASCII(name) })
	}
	in.account, in.asset, in.balance = find(want.Account), find(want.Asset), find(want.Balance)
	found := "found: " + strings.Join(in.header, ", ")

	if in.account < 0 {
		hint := "; state the account column's name if it is called something else"
		if len(in.header) == 1 && strings.ContainsAny(in.header[0], ";\t|") {
			hint = "; the file may use another delimiter, which has to be stated"
		}
		return problem(CodeHeaderNoAccount, "no "+quote(want.Account)+" column in the header ("+found+")"+hint)
	}

	symbols := symbolsOf(in.ledger.assets)
	if in.layout == "" {
		assetLike := false
		for i, h := range in.header {
			if _, near := in.ledger.byLower[lowerASCII(h)]; near && i != in.account {
				assetLike = true
			}
		}
		switch {
		case in.asset >= 0 && in.balance >= 0:
			in.layout = Long
		case assetLike:
			in.layout = Wide
		case in.asset >= 0 || in.balance >= 0:
			in.layout = Long
		default:
			// Naming one layout here would send the reader after the wrong fix.
			return problem(CodeHeaderUnrecognised, "the header matches neither layout ("+found+"). Long: "+
				want.Account+","+want.Asset+","+want.Balance+" (one row per account and asset). Wide: "+
				want.Account+" and one column per declared asset ("+strings.Join(symbols, ", ")+
				"). Columns with other names can be mapped by stating the asset and balance column names.")
		}
	}

	if in.layout == Long {
		if in.asset < 0 || in.balance < 0 {
			var missing []string
			if in.asset < 0 {
				missing = append(missing, quote(want.Asset))
			}
			if in.balance < 0 {
				missing = append(missing, quote(want.Balance))
			}
			return problem(CodeHeaderMissingColumn, "the long layout needs the "+plural(len(missing), "column", "columns")+" "+
				strings.Join(missing, " and ")+" ("+found+"); state the column's name if it is called something else")
		}
		for i, h := range in.header {
			// In the long layout an unrelated column cannot hide a balance,
			// so it is passed over and reported.
			if i != in.account && i != in.asset && i != in.balance {
				in.ignored = append(in.ignored, h)
			}
		}
		return true
	}

	// Wide: every other column is an asset, or has been named as ignorable.
	in.asset, in.balance = -1, -1
	ignorable := make(map[string]bool, len(in.opts.IgnoreColumns))
	for _, c := range in.opts.IgnoreColumns {
		ignorable[lowerASCII(c)] = true
	}
	ok := true
	present := make(map[string]bool, len(symbols))
	// reportedNear holds, folded, the columns refused for differing from a
	// declared asset by letter case only. For such an asset the column is the
	// problem to report, not its absence.
	reportedNear := map[string]bool{}
	for i, h := range in.header {
		if i == in.account {
			continue
		}
		if at, declared := in.ledger.position[h]; declared {
			in.assetColumns = append(in.assetColumns, assetColumn{field: i, asset: at})
			present[h] = true
			continue
		}
		if ignorable[lowerASCII(h)] {
			in.ignored = append(in.ignored, h)
			continue
		}
		ok = false
		if near, isNear := in.ledger.byLower[lowerASCII(h)]; isNear {
			reportedNear[lowerASCII(h)] = true
			problem(CodeHeaderUnknownColumn, "column "+quote(h)+" differs from the declared asset "+near+
				" only by letter case; asset symbols are matched exactly")
			continue
		}
		problem(CodeHeaderUnknownColumn, "column "+quote(h)+
			" is not a declared asset; declare it if it is a balance, or name it as a column to ignore if it is not")
	}
	for _, symbol := range symbols {
		// A declared asset with no column would silently count as zero.
		if !present[symbol] && !reportedNear[lowerASCII(symbol)] {
			ok = false
			problem(CodeHeaderMissingAsset, "declared asset "+symbol+" has no column; do not declare it if the exchange holds none")
		}
	}
	return ok
}
