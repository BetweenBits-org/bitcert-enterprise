package por

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
)

func readText(t *testing.T, text string, change ...func(*CSVOptions)) (*Ledger, *Report) {
	t.Helper()
	opts := CSVOptions{Assets: btcEthUsdt, Amounts: Decimal}
	for _, f := range change {
		f(&opts)
	}
	ledger, report, err := ReadCSV(strings.NewReader(text), opts)
	if err != nil {
		t.Fatalf("ReadCSV: %v", err)
	}
	if report.OK != (ledger != nil) {
		t.Fatalf("OK is %v but the ledger is %v: a ledger exists exactly when the report is OK", report.OK, ledger)
	}
	if report.ProblemCount < len(report.Problems) || report.OK != (report.ProblemCount == 0) {
		t.Fatalf("inconsistent report: %+v", report)
	}
	return ledger, report
}

func problemsOf(report *Report) []string {
	out := []string{}
	for _, p := range report.Problems {
		out = append(out, fmt.Sprintf("%d:%s", p.Line, p.Code))
	}
	return out
}

func wantProblems(t *testing.T, report *Report, want ...string) {
	t.Helper()
	if got := problemsOf(report); !slices.Equal(got, want) {
		t.Fatalf("problems are %v, want %v\n%+v", got, want, report.Problems)
	}
}

// rowsOf renders a ledger's rows as text: "account BTC=1 ETH=2".
func rowsOf(t *testing.T, ledger *Ledger) []string {
	t.Helper()
	out := []string{}
	for i := 0; i < ledger.Len(); i++ {
		row, err := ledger.Row(i)
		if err != nil {
			t.Fatal(err)
		}
		line := row.UserRef
		for _, b := range row.Balances {
			line += " " + b.Asset + "=" + b.Amount.String()
		}
		out = append(out, line)
	}
	return out
}

func totalsOf(b Balances) string {
	parts := []string{}
	for _, e := range b {
		parts = append(parts, e.Asset+"="+e.Amount.String())
	}
	return strings.Join(parts, " ")
}

func TestIntakeLongLayout(t *testing.T) {
	text := "account_id,asset,balance\nu1,BTC,0.5\nu1,ETH,2\nu2,USDT,10.25\nu3,BTC,0\n"
	ledger, report := readText(t, text)
	wantProblems(t, report)
	if report.Layout != Long || report.DataRows != 4 || report.Accounts != 3 || report.ZeroBalanceAccounts != 1 {
		t.Errorf("report: %+v", report)
	}
	if got, want := totalsOf(report.Totals), "BTC=50000000 ETH=2000000000000000000 USDT=10250000"; got != want {
		t.Errorf("totals %s, want %s", got, want)
	}
	if want := map[string]int{"BTC": 1, "ETH": 1, "USDT": 1}; !reflect.DeepEqual(report.Holders, want) {
		t.Errorf("holders %v, want %v", report.Holders, want)
	}
	// Each account has the balances it was given, in the order it was given them.
	want := []string{"u1 BTC=50000000 ETH=2000000000000000000", "u2 USDT=10250000", "u3 BTC=0"}
	if got := rowsOf(t, ledger); !reflect.DeepEqual(got, want) {
		t.Errorf("rows %q, want %q", got, want)
	}
	sum := sha256.Sum256([]byte(text))
	if report.FileSHA256 != hex.EncodeToString(sum[:]) || report.FileBytes != int64(len(text)) {
		t.Errorf("the file is identified as %s, %d bytes", report.FileSHA256, report.FileBytes)
	}
}

func TestIntakeWideLayout(t *testing.T) {
	// Columns in another order than declared: each row keeps the file's.
	ledger, report := readText(t, "account_id,USDT,BTC,ETH\nu1,,0.5,2\nu2,10.25,,\n")
	wantProblems(t, report)
	if report.Layout != Wide || report.DataRows != 2 || report.Accounts != 2 {
		t.Errorf("report: %+v", report)
	}
	if got, want := totalsOf(report.Totals), "BTC=50000000 ETH=2000000000000000000 USDT=10250000"; got != want {
		t.Errorf("totals %s, want %s (in declared order)", got, want)
	}
	// An empty cell is "holds none": every asset has a value.
	want := []string{"u1 USDT=0 BTC=50000000 ETH=2000000000000000000", "u2 USDT=10250000 BTC=0 ETH=0"}
	if got := rowsOf(t, ledger); !reflect.DeepEqual(got, want) {
		t.Errorf("rows %q, want %q", got, want)
	}
	_, report = readText(t, "account_id,BTC,ETH,USDT\nu1, \t,1, 2 \n")
	wantProblems(t, report)
}

func TestIntakeColumnsAreMappedNeverGuessed(t *testing.T) {
	text := "USER_ID,currency,amount,updated_at\nu1,BTC,1,2026-11-16\n"
	_, report := readText(t, text, func(o *CSVOptions) { o.Columns = Columns{Account: "user_id", Asset: "Currency", Balance: "AMOUNT"} })
	wantProblems(t, report)
	// In the long layout an extra column cannot hide a balance.
	if !reflect.DeepEqual(report.IgnoredColumns, []string{"updated_at"}) {
		t.Errorf("ignored columns: %v", report.IgnoredColumns)
	}
	_, report = readText(t, "user_id,currency,amount\nu1,BTC,1\n")
	wantProblems(t, report, "1:header_no_account")
	_, report = readText(t, "account_id,currency,amount\nu1,BTC,1\n")
	wantProblems(t, report, "1:header_unrecognised")
	if report.Layout != "" || report.DataRows != 0 {
		t.Errorf("no layout was settled and no row examined: %+v", report)
	}
	// Names are trimmed and compared ignoring ASCII case only.
	_, report = readText(t, " Account_ID ,ASSET, Balance\nu1,BTC,1\n")
	wantProblems(t, report)
	_, report = readText(t, "account_ıd,asset,balance\nu1,BTC,1\n")
	wantProblems(t, report, "1:header_no_account")
}

func TestIntakeHeaderRules(t *testing.T) {
	for _, c := range []struct {
		name   string
		header string
		change func(*CSVOptions)
		want   []string
	}{
		{"an empty name", "account_id,,balance", nil, []string{"1:header_empty_name"}},
		{"an empty name is reported before a repeat that follows it", "a,,a", nil, []string{"1:header_empty_name"}},
		{"a repeated name, ignoring case", "account_id,asset,Asset", nil, []string{"1:header_duplicate"}},
		{"a repeat is reported before a missing account column", "x,asset,x", nil, []string{"1:header_duplicate"}},
		{"another delimiter", "account_id;asset;balance", nil, []string{"1:header_no_account"}},
		{"long by both columns, even with an asset-named column", "account_id,asset,balance,BTC", nil, nil},
		{"wide by an asset column", "account_id,BTC,ETH,USDT", nil, nil},
		{"wide by an asset column that differs by case", "account_id,btc,ETH,USDT", nil, []string{"1:header_unknown_column"}},
		{"long by one of its two columns", "account_id,asset", nil, []string{"1:header_missing_column"}},
		{"long by the other", "account_id,balance,note", nil, []string{"1:header_missing_column"}},
		{"neither", "account_id,note", nil, []string{"1:header_unrecognised"}},
		{"long stated, both missing", "account_id,BTC,ETH,USDT", func(o *CSVOptions) { o.Layout = Long }, []string{"1:header_missing_column"}},
		{"wide stated: the long columns are unknown ones", "account_id,asset,balance", func(o *CSVOptions) { o.Layout = Wide },
			[]string{"1:header_unknown_column", "1:header_unknown_column", "1:header_missing_asset", "1:header_missing_asset", "1:header_missing_asset"}},
		{"unknown columns in column order, then missing assets in declared order", "x,account_id,USDT,y", nil,
			[]string{"1:header_unknown_column", "1:header_unknown_column", "1:header_missing_asset", "1:header_missing_asset"}},
		{"an ignorable column", "account_id,BTC,ETH,USDT,Memo", func(o *CSVOptions) { o.IgnoreColumns = []string{"memo"} }, nil},
		{"a declared asset wins over the ignore list", "account_id,BTC,ETH,USDT", func(o *CSVOptions) { o.IgnoreColumns = []string{"BTC"} }, nil},
		// The asset has no column and nothing reported one: it would
		// silently count as zero for every account.
		{"a near-match that was ignored, not reported", "account_id,btc,ETH,USDT", func(o *CSVOptions) { o.IgnoreColumns = []string{"btc"} },
			[]string{"1:header_missing_asset"}},
		{"an account column named like an asset", "btc,ETH,USDT", func(o *CSVOptions) { o.Columns.Account = "btc" }, []string{"1:header_missing_asset"}},
	} {
		opts := []func(*CSVOptions){}
		if c.change != nil {
			opts = append(opts, c.change)
		}
		_, report := readText(t, c.header+"\nu1,BTC,1\n", opts...)
		got := problemsOf(report)
		// The data row is only there to follow the header; its own problems
		// are not this test's subject.
		header := []string{}
		for _, p := range got {
			if strings.HasPrefix(p, "1:") {
				header = append(header, p)
			}
		}
		want := c.want
		if want == nil {
			want = []string{}
		}
		if !reflect.DeepEqual(header, want) {
			t.Errorf("%s (%q): header problems %v, want %v", c.name, c.header, header, want)
		}
		if len(want) > 0 && (report.DataRows != 0 || len(got) != len(want)) {
			t.Errorf("%s: a header problem ends interpretation, yet rows were examined: %v", c.name, got)
		}
	}
}

func TestIntakeNothingThatCouldChangeATotalIsDecidedSilently(t *testing.T) {
	// An asset nobody declared: a problem, not a dropped row.
	_, report := readText(t, "account_id,asset,balance\nu1,DOGE,5\n")
	wantProblems(t, report, "2:unknown_asset")
	if !strings.Contains(report.Problems[0].Message, "left out of the totals") {
		t.Errorf("message: %s", report.Problems[0].Message)
	}
	// Letter case is not folded: "btc" may or may not be the declared BTC.
	_, report = readText(t, "account_id,asset,balance\nu1,btc,5\n")
	if wantProblems(t, report, "2:unknown_asset"); !strings.Contains(report.Problems[0].Message, "only by letter case") {
		t.Errorf("message: %s", report.Problems[0].Message)
	}
	// The asset cell is trimmed; the symbol is then matched exactly.
	_, report = readText(t, "account_id,asset,balance\nu1, BTC ,5\n")
	wantProblems(t, report)
	// A second row for the same account and asset: a problem, not a sum.
	_, report = readText(t, "account_id,asset,balance\nu1,BTC,1\nu1,ETH,1\nu1,BTC,2\n")
	wantProblems(t, report, "4:duplicate_row")
	// A row whose amount was refused still counts as that pair's row.
	_, report = readText(t, "account_id,asset,balance\nu1,BTC,x\nu1,BTC,2\n")
	wantProblems(t, report, "2:amount_format", "3:duplicate_row")
	// In the wide layout an unknown column might be an asset.
	_, report = readText(t, "account_id,BTC,ETH,USDT,DOGE\nu1,1,1,1,5\n")
	wantProblems(t, report, "1:header_unknown_column")
	// ... and a declared asset with no column would silently count as zero.
	_, report = readText(t, "account_id,BTC,ETH\nu1,1,1\n")
	wantProblems(t, report, "1:header_missing_asset")
	_, report = readText(t, "account_id,BTC,ETH,USDT\nu1,1,1,1\nu1,2,2,2\n")
	wantProblems(t, report, "3:duplicate_account")
	// A wide row with a refused cell is not an accepted row: the account may come again.
	_, report = readText(t, "account_id,BTC,ETH,USDT\nu1,-1,x,1e3\nu1,2,2,2\nu1,3,3,3\n")
	wantProblems(t, report, "2:amount_negative", "2:amount_format", "2:amount_exponent", "4:duplicate_account")
}

func TestIntakeReportsEveryProblemAndYieldsNoRows(t *testing.T) {
	ledger, report := readText(t, strings.Join([]string{
		"account_id,asset,balance",
		"u1,BTC,0.123456789", // 2 precision
		"u2,BTC,-1",          // 3 negative
		" u3,BTC,1",          // 4 padded identifier
		",BTC,1",             // 5 empty identifier
		"u4,BTC",             // 6 field count
		"u5,BTC,1e3",         // 7 exponent
		"u6,BTC,",            // 8 empty amount
		"u7,BTC,2",           // fine
		"u8,BTC,1,extra",     // 10 field count
	}, "\n")+"\n")
	if ledger != nil {
		t.Fatal("a ledger was built from the rows that happened to parse")
	}
	wantProblems(t, report, "2:amount_precision", "3:amount_negative", "4:account_whitespace", "5:account_empty",
		"6:field_count", "7:amount_exponent", "8:amount_empty", "10:field_count")
	if report.ProblemCount != 8 || report.DataRows != 9 {
		t.Errorf("counts: %+v", report)
	}
	// No figures from a ledger that did not read cleanly.
	if report.Totals != nil || report.Holders != nil || report.ZeroBalanceAccounts != 0 {
		t.Errorf("a refused ledger states totals: %+v", report)
	}

	// The kept list is capped; the count is not.
	many := "account_id,asset,balance\n" + strings.Repeat("u,BTC,-1\n", 120)
	_, report = readText(t, many)
	if len(report.Problems) != 50 || report.ProblemCount != 120 {
		t.Errorf("by default %d problems are kept of %d", len(report.Problems), report.ProblemCount)
	}
	_, report = readText(t, many, func(o *CSVOptions) { o.MaxProblems = 5 })
	if len(report.Problems) != 5 || report.ProblemCount != 120 || report.Problems[4].Line != 6 {
		t.Errorf("MaxProblems 5: %d kept of %d", len(report.Problems), report.ProblemCount)
	}
}

func TestIntakeIdentifiersAreUsedByteForByte(t *testing.T) {
	ledger, report := readText(t, "account_id,asset,balance\n\"kim, 민수\",BTC,1\n\"say \"\"hi\"\"\",ETH,1\nu 1,BTC,1\n__proto__,BTC,1\n"+strings.Repeat("x", 256)+",BTC,1\n")
	wantProblems(t, report)
	want := []string{"kim, 민수", `say "hi"`, "u 1", "__proto__", strings.Repeat("x", 256)}
	for i, ref := range want {
		if row, _ := ledger.Row(i); row.UserRef != ref {
			t.Errorf("row %d is %q, want %q", i, row.UserRef, ref)
		}
	}
	for _, c := range []struct{ id, code string }{
		{"\"a\nb\"", CodeAccountControlCharacter},
		{"a\x7fb", CodeAccountControlCharacter},
		{"a\tb", CodeAccountControlCharacter},
		// Whitespace at the ends is reported as that, even when it is a control character.
		{"\tab", CodeAccountWhitespace},
		{"\"ab\n\"", CodeAccountWhitespace},
		{"ab\U00003000", CodeAccountWhitespace},
		{"\"\"", CodeAccountEmpty},
		{"\" \"", CodeAccountWhitespace},
		{strings.Repeat("x", 257), CodeAccountTooLong},
		// 86 three-byte characters are 258 bytes.
		{strings.Repeat("가", 86), CodeAccountTooLong},
	} {
		_, report := readText(t, "account_id,asset,balance\n"+c.id+",BTC,1\n")
		if got := problemsOf(report); len(got) != 1 || !strings.HasSuffix(got[0], ":"+c.code) {
			t.Errorf("identifier %q: %v, want %s", c.id, got, c.code)
		}
	}
	// 85 three-byte characters are 255 bytes: within the limit.
	_, report = readText(t, "account_id,asset,balance\n"+strings.Repeat("가", 85)+",BTC,1\n")
	wantProblems(t, report)
}

func TestIntakeFileLevelFailuresAreProblemsNotErrors(t *testing.T) {
	_, report := readText(t, "")
	wantProblems(t, report, "0:empty_file")
	_, report = readText(t, "\n\r\n\n")
	wantProblems(t, report, "0:empty_file")
	_, report = readText(t, "account_id,asset,balance\n")
	wantProblems(t, report, "0:no_accounts")
	// "No accounts" is said only when nothing else was: a refused row is the story.
	_, report = readText(t, "account_id,asset,balance\nu1,BTC\n")
	wantProblems(t, report, "2:field_count")
	_, report = readText(t, "account_id,asset,balance\nu1,BTC,\"1\n")
	wantProblems(t, report, "2:csv_syntax")
	_, report = readText(t, "account_id;asset;balance\nu1;BTC;1\n", func(o *CSVOptions) { o.Delimiter = ';' })
	wantProblems(t, report)
	_, report = readText(t, "account_id\tasset\tbalance\nu1\tBTC\t1\n", func(o *CSVOptions) { o.Delimiter = '\t' })
	wantProblems(t, report)
}

// Reading stops at a syntax error, keeping what was found before it; the
// checksum is still that of the whole file.
func TestIntakeStopsAtASyntaxErrorKeepingEarlierProblems(t *testing.T) {
	text := "account_id,asset,balance\nu1,BTC,-1\nu2,BTC,1\"2\nu3,DOGE,1\n"
	_, report := readText(t, text)
	wantProblems(t, report, "2:amount_negative", "3:csv_syntax")
	sum := sha256.Sum256([]byte(text))
	if report.FileSHA256 != hex.EncodeToString(sum[:]) || report.FileBytes != int64(len(text)) {
		t.Errorf("the checksum covers %d bytes: %s", report.FileBytes, report.FileSHA256)
	}
	// After a header that could not be used the file is still read to its end.
	_, report = readText(t, "id,asset,balance\nu1,BTC,1\nu2,\"x\"y\n")
	wantProblems(t, report, "1:header_no_account", "3:csv_syntax")
}

// A file that is not UTF-8 is that one problem: whatever was made of its
// rows was made under the wrong assumption about the whole file.
func TestIntakeAFileThatIsNotUTF8IsOnlyThat(t *testing.T) {
	text := "account_id,asset,balance\nu1,BTC,-1\n\xb0\xa1,BTC,1\nu3,BTC,1\n"
	ledger, report := readText(t, text)
	wantProblems(t, report, "0:file_encoding")
	if ledger != nil || report.ProblemCount != 1 || report.DataRows != 0 || report.Accounts != 0 || report.Layout != "" {
		t.Errorf("report: %+v", report)
	}
	sum := sha256.Sum256([]byte(text))
	if report.FileSHA256 != hex.EncodeToString(sum[:]) {
		t.Errorf("the checksum is not the whole file's")
	}
	_, report = readText(t, "account_id,asset,balance\nu1,BTC,1\xea\xb0")
	wantProblems(t, report, "0:file_encoding")
}

func TestIntakeOptionsAreChecked(t *testing.T) {
	read := func(o CSVOptions) error {
		_, _, err := ReadCSV(strings.NewReader("account_id,asset,balance\nu1,BTC,1\n"), o)
		return err
	}
	wantCode(t, read(CSVOptions{Assets: btcEthUsdt}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Amounts: Decimal}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: []Asset{{"BTC", 8}, {"BTC", 8}}, Amounts: Decimal}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: []Asset{{"B TC", 8}}, Amounts: Decimal}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: []Asset{{"BTC", 37}}, Amounts: Decimal}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: btcEthUsdt, Amounts: Decimal, Layout: "tall"}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: btcEthUsdt, Amounts: Decimal, Delimiter: '"'}), CodeInvalidOption)
	wantCode(t, read(CSVOptions{Assets: btcEthUsdt, Amounts: Decimal, MaxProblems: -1}), CodeInvalidOption)
	if err := read(CSVOptions{Assets: btcEthUsdt, Amounts: Decimal}); err != nil {
		t.Fatal(err)
	}
}

func TestIntakeReadFailuresAreErrors(t *testing.T) {
	broken := errors.New("the disk went away")
	src := io.MultiReader(strings.NewReader("account_id,asset,balance\nu1,BTC,1\n"), iotest.ErrReader(broken))
	ledger, report, err := ReadCSV(src, CSVOptions{Assets: btcEthUsdt, Amounts: Decimal})
	if ledger != nil || report != nil || !errors.Is(err, broken) {
		t.Fatalf("got %v, %v, %v", ledger, report, err)
	}
	wantCode(t, err, CodeIO)
	// ... also when the failure comes after reading has already stopped.
	src = io.MultiReader(strings.NewReader("a\n\"x\"y\n"), iotest.ErrReader(broken))
	if _, _, err := ReadCSV(src, CSVOptions{Assets: btcEthUsdt, Amounts: Decimal}); !errors.Is(err, broken) {
		t.Fatalf("got %v", err)
	}
	_, _, err = ReadCSVFile(filepath.Join(t.TempDir(), "missing.csv"), CSVOptions{Assets: btcEthUsdt, Amounts: Decimal})
	wantCode(t, err, CodeIO)
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the cause is lost: %v", err)
	}
}

func TestReadCSVFileStreamsALargeExport(t *testing.T) {
	// Larger than any buffer on the way, with a multi-byte character at
	// every position a buffer boundary can fall on.
	path := filepath.Join(t.TempDir(), "balances.csv")
	var b strings.Builder
	b.WriteString("account_id,asset,balance\n")
	const accounts = 30000
	for i := 0; i < accounts; i++ {
		fmt.Fprintf(&b, "고객-%d,BTC,0.%08d\n고객-%d,USDT,%d\n", i, i+1, i, i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	ledger, report, err := ReadCSVFile(path, CSVOptions{Assets: btcEthUsdt, Amounts: Decimal})
	if err != nil || !report.OK {
		t.Fatalf("%v %+v", err, report)
	}
	if ledger.Len() != accounts || report.DataRows != 2*accounts || report.FileBytes != int64(b.Len()) {
		t.Errorf("read %d accounts from %d rows, %d bytes", ledger.Len(), report.DataRows, report.FileBytes)
	}
	// 1 + 2 + ... + accounts satoshi.
	if got, want := report.Totals.Amount("BTC").Int64(), int64(accounts)*(accounts+1)/2; got != want {
		t.Errorf("BTC total %d, want %d", got, want)
	}
	sum := sha256.Sum256([]byte(b.String()))
	if report.FileSHA256 != hex.EncodeToString(sum[:]) {
		t.Error("the checksum is not the file's")
	}
}
