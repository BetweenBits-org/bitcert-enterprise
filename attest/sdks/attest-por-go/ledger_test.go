package por

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func newBuilder(t *testing.T, change ...func(*LedgerOptions)) *LedgerBuilder {
	t.Helper()
	opts := LedgerOptions{Assets: btcEthUsdt, Amounts: Decimal}
	for _, f := range change {
		f(&opts)
	}
	b, err := NewLedgerBuilder(opts)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The ledger of the vectors three ways — the file, long rows from code, wide
// rows from code — is one ledger.
func TestLedgerBuilderFollowsTheRulesOfTheFile(t *testing.T) {
	fromFile, report, err := ReadCSVFile(vectorsDir(t)+"/intake/long.csv", CSVOptions{Assets: btcEthUsdt, Amounts: Decimal})
	if err != nil || !report.OK {
		t.Fatalf("%v %+v", err, report)
	}
	viaAdd := sampleLedger(t)
	if got, want := rowsOf(t, viaAdd), rowsOf(t, fromFile); !reflect.DeepEqual(got, want) {
		t.Errorf("rows from Add:\n got  %q\n want %q", got, want)
	}

	wide := newBuilder(t)
	amounts := map[string]map[string]string{}
	var order []string
	for i := 0; i < fromFile.Len(); i++ {
		row, _ := fromFile.Row(i)
		order = append(order, row.UserRef)
		amounts[row.UserRef] = map[string]string{}
		for _, b := range row.Balances {
			// Smallest units back to the figure a ledger prints.
			text, err := FromBaseUnits(b.Amount, btcEthUsdt[slices.IndexFunc(btcEthUsdt, func(a Asset) bool { return a.Symbol == b.Asset })].Decimals)
			if err != nil {
				t.Fatal(err)
			}
			amounts[row.UserRef][b.Asset] = text
		}
	}
	for _, ref := range order {
		if err := wide.AddAccount(ref, amounts[ref]); err != nil {
			t.Fatal(err)
		}
	}
	viaAccount, wideReport := wide.Finish()
	if !wideReport.OK || wideReport.Accounts != 12 || wideReport.DataRows != 12 || totalsOf(wideReport.Totals) != totalsOf(report.Totals) {
		t.Errorf("wide rows: %+v", wideReport)
	}
	for _, ledger := range []*Ledger{fromFile, viaAdd, viaAccount} {
		tree, err := BuildTree(testExchange, testSeed(t), ledger)
		if err != nil || tree.Root() != sampleRoot {
			t.Errorf("root %v, %v; want %s", tree, err, sampleRoot)
		}
	}
}

func TestLedgerBuilderReportsARefusedRowAtTheOrdinalOfItsCall(t *testing.T) {
	l := newBuilder(t)
	accepted := func(err error, want bool) {
		t.Helper()
		if (err == nil) != want {
			t.Fatalf("accepted = %v (%v), want %v", err == nil, err, want)
		}
	}
	accepted(l.Add("u1", "BTC", "0.5"), true)
	accepted(l.Add("u1", "BTC", "1"), false)                                                     // 2 duplicate_row
	accepted(l.Add(" u2", "BTC", "1"), false)                                                    // 3 account_whitespace
	accepted(l.Add("u3", "DOGE", "1"), false)                                                    // 4 unknown_asset
	accepted(l.Add("u4", "ETH", "0.0000000000000000001"), false)                                 // 5 amount_precision
	accepted(l.AddAccount("u5", map[string]string{"BTC": "1", "SHIB": "9", "DOGE": "5"}), false) // 6 unknown_asset, both named
	accepted(l.AddAccount("u1", map[string]string{"ETH": "1"}), false)                           // 7 duplicate_account: u1 already has a value
	accepted(l.AddAccount("u6", map[string]string{"USDT": "-3"}), false)                         // 8 amount_negative
	accepted(l.AddAccount("u7", map[string]string{"BTC": "", "USDT": "2.5"}), true)              // an empty value is "holds none"
	accepted(l.Add("u7", "ETH", "1"), false)                                                     // 10 duplicate_row: the wide row set every asset
	accepted(l.AddAccount("u4", nil), false)                                                     // 11 duplicate_account: the refused row still counts
	accepted(l.AddAccount("u6", map[string]string{"USDT": "3"}), true)                           // a refused wide row left nothing behind
	accepted(l.AddAccount("u8", map[string]string{"BTC": "x", "ETH": "1", "USDT": "-1"}), false) // 13, twice

	ledger, report := l.Finish()
	if ledger != nil {
		t.Fatal("a refused ledger yields nothing")
	}
	wantProblems(t, report, "2:duplicate_row", "3:account_whitespace", "4:unknown_asset", "5:amount_precision",
		"6:unknown_asset", "7:duplicate_account", "8:amount_negative", "10:duplicate_row", "11:duplicate_account",
		"13:amount_format", "13:amount_negative")
	if !strings.Contains(report.Problems[4].Message, `"DOGE", "SHIB" are not declared assets`) {
		t.Errorf("undeclared assets are named in ascending order: %s", report.Problems[4].Message)
	}
	if report.DataRows != 13 || report.ProblemCount != 11 || report.Layout != "" || report.FileSHA256 != "" {
		t.Errorf("report: %+v", report)
	}
}

func TestLedgerBuilderReturnsWhatItRecorded(t *testing.T) {
	l := newBuilder(t)
	err := l.Add("u1", "BTC", "-1")
	var refusal *Error
	if !errors.As(err, &refusal) || refusal.Code != CodeAmountNegative || refusal.Line != 1 || !strings.HasPrefix(refusal.Message, "BTC: ") {
		t.Fatalf("got %#v", err)
	}
	if !strings.HasPrefix(err.Error(), "line 1: amount_negative: ") {
		t.Errorf("the error reads %q", err)
	}
	// A wide row can be refused for several amounts; all of them come back.
	err = l.AddAccount("u2", map[string]string{"BTC": "x", "USDT": "1e3"})
	if !errors.As(err, &refusal) || refusal.Code != CodeAmountFormat || refusal.Line != 2 {
		t.Fatalf("the first of the joined errors: %#v", err)
	}
	if !strings.Contains(err.Error(), CodeAmountFormat) || !strings.Contains(err.Error(), CodeAmountExponent) {
		t.Errorf("both refusals should be in %q", err)
	}
	_, report := l.Finish()
	wantProblems(t, report, "1:amount_negative", "2:amount_format", "2:amount_exponent")
}

func TestLedgerBuilderWithNoAccountsAndAfterFinish(t *testing.T) {
	l := newBuilder(t)
	ledger, report := l.Finish()
	if ledger != nil {
		t.Fatal("a ledger of nothing")
	}
	wantProblems(t, report, "0:no_accounts")
	wantCode(t, l.Add("u1", "BTC", "1"), CodeLedgerClosed)
	wantCode(t, l.AddAccount("u1", nil), CodeLedgerClosed)
	// Finishing again changes nothing.
	again, sameReport := l.Finish()
	if again != nil || sameReport != report || sameReport.DataRows != 0 {
		t.Errorf("a second Finish gave %v, %+v", again, sameReport)
	}

	fine := newBuilder(t)
	if err := fine.AddAccount("only", map[string]string{"USDT": "2.5"}); err != nil {
		t.Fatal(err)
	}
	ledger, report = fine.Finish()
	if !report.OK || !reflect.DeepEqual(rowsOf(t, ledger), []string{"only BTC=0 ETH=0 USDT=2500000"}) {
		t.Errorf("got %v, %+v", rowsOf(t, ledger), report)
	}
	if first, _ := fine.Finish(); first != ledger {
		t.Error("a second Finish built another ledger")
	}
}

func TestLedgerBuilderRefusesAnAccountThatIsNotUTF8(t *testing.T) {
	l := newBuilder(t)
	wantCode(t, l.Add("caf\xe9", "BTC", "1"), CodeAccountEncoding)
	wantCode(t, l.AddAccount("\xff\xfe", nil), CodeAccountEncoding)
	_, report := l.Finish()
	wantProblems(t, report, "1:account_encoding", "2:account_encoding")
	for _, p := range report.Problems {
		if strings.ContainsAny(p.Message, "\xe9\xff") {
			t.Errorf("the message carries the raw bytes: %q", p.Message)
		}
	}
}

func TestLedgerBuilderOptionsAreChecked(t *testing.T) {
	for name, opts := range map[string]LedgerOptions{
		"no assets":         {Amounts: Base},
		"no unit":           {Assets: btcEthUsdt},
		"an unknown unit":   {Assets: btcEthUsdt, Amounts: "satoshi"},
		"a bad symbol":      {Assets: []Asset{{"BTC/USD", 8}}, Amounts: Base},
		"too many decimals": {Assets: []Asset{{"BTC", 80}}, Amounts: Base},
		"a symbol twice":    {Assets: []Asset{{"BTC", 8}, {"BTC", 8}}, Amounts: Base},
		"negative cap":      {Assets: btcEthUsdt, Amounts: Base, MaxProblems: -5},
	} {
		if _, err := NewLedgerBuilder(opts); codeOf(t, err) != CodeInvalidOption {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestLedgerRowsAreCopies(t *testing.T) {
	ledger := sampleLedger(t)
	row, err := ledger.Row(0)
	if err != nil {
		t.Fatal(err)
	}
	row.Balances[0].Amount.SetInt64(-1)
	ledger.Assets()[0].Symbol = "XXX"
	again, _ := ledger.Row(0)
	if again.Balances[0].Amount.String() != "50000000" || ledger.Assets()[0].Symbol != "BTC" {
		t.Error("changing what Row or Assets returned changed the ledger")
	}
	for _, i := range []int{-1, ledger.Len()} {
		if _, err := ledger.Row(i); codeOf(t, err) != CodeIndexOutOfRange {
			t.Errorf("Row(%d): %v", i, err)
		}
	}
}

func TestLedgerKeepsLargeAmountsExactly(t *testing.T) {
	// Amounts on both sides of every word boundary math/big has.
	l := newBuilder(t, func(o *LedgerOptions) { o.Amounts = Base })
	amounts := []string{"0", "1", "9999999999999999999", "18446744073709551615", "18446744073709551616",
		"340282366920938463463374607431768211455", "340282366920938463463374607431768211456", strings.Repeat("9", 62)}
	total := new(big.Int)
	for i, a := range amounts {
		if err := l.Add(fmt.Sprintf("u%d", i), "ETH", a); err != nil {
			t.Fatal(err)
		}
		n, _ := new(big.Int).SetString(a, 10)
		total.Add(total, n)
	}
	ledger, report := l.Finish()
	if !report.OK || report.Totals.Amount("ETH").Cmp(total) != 0 {
		t.Fatalf("total %v, want %v", report.Totals.Amount("ETH"), total)
	}
	for i, a := range amounts {
		if row, _ := ledger.Row(i); row.Balances[0].Amount.String() != a {
			t.Errorf("row %d holds %s, want %s", i, row.Balances[0].Amount, a)
		}
	}
	tree, err := BuildTree(testExchange, testSeed(t), ledger)
	if err != nil || tree.Totals().Amount("ETH").Cmp(total) != 0 {
		t.Fatalf("the tree's total is %v (%v), want %v", tree.Totals().Amount("ETH"), err, total)
	}
}

// Random ledgers, good rows and bad, offered to the builder and written out
// as a file: the same problems at the same rows, and the same ledger.
func TestLedgerBuilderAndFileAgreeOnRandomLedgers(t *testing.T) {
	rng := rand.New(rand.NewSource(7919))
	pick := func(options ...string) string { return options[rng.Intn(len(options))] }
	account := func() string {
		if rng.Intn(12) == 0 {
			return pick("", " padded", "tab\tinside", strings.Repeat("x", 300), "trailing ")
		}
		return pick("u", "acct-", "고객-", "say \"hi\" ") + fmt.Sprint(rng.Intn(25))
	}
	amount := func() string {
		if rng.Intn(10) == 0 {
			return pick("", "-1", "1e3", "1,0", "0.1234567891234567891", "abc", "5.", "1 000", strings.Repeat("7", 70))
		}
		return pick(fmt.Sprintf("%d.%0*d", rng.Intn(1000), 1+rng.Intn(6), rng.Intn(10)), fmt.Sprint(rng.Intn(100000)), " 2 ", ".5", "000")
	}
	field := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
	// The file's line is the call's ordinal plus the header.
	shifted := func(report *Report) []string {
		out := []string{}
		for _, p := range report.Problems {
			line := p.Line
			if line > 0 {
				line--
			}
			out = append(out, fmt.Sprintf("%d:%s:%s", line, p.Code, p.Message))
		}
		return out
	}
	compare := func(round int, shape string, fromCode, fromFile *Ledger, codeReport, fileReport *Report) {
		t.Helper()
		byCall := []string{}
		for _, p := range codeReport.Problems {
			byCall = append(byCall, fmt.Sprintf("%d:%s:%s", p.Line, p.Code, p.Message))
		}
		if !slices.Equal(byCall, shifted(fileReport)) {
			t.Fatalf("round %d, %s rows: problems differ\n code %q\n file %q", round, shape, byCall, shifted(fileReport))
		}
		if codeReport.OK != fileReport.OK || codeReport.Accounts != fileReport.Accounts || codeReport.DataRows != fileReport.DataRows ||
			totalsOf(codeReport.Totals) != totalsOf(fileReport.Totals) || !reflect.DeepEqual(codeReport.Holders, fileReport.Holders) ||
			codeReport.ZeroBalanceAccounts != fileReport.ZeroBalanceAccounts {
			t.Fatalf("round %d, %s rows: reports differ\n code %+v\n file %+v", round, shape, codeReport, fileReport)
		}
		if codeReport.OK && !reflect.DeepEqual(rowsOf(t, fromCode), rowsOf(t, fromFile)) {
			t.Fatalf("round %d, %s rows: ledgers differ", round, shape)
		}
	}

	accepted := 0
	for round := 0; round < 400; round++ {
		rows := 1 + rng.Intn(30)
		unlimited := func(o *LedgerOptions) { o.MaxProblems = 1000 }

		long, csv := newBuilder(t, unlimited), strings.Builder{}
		csv.WriteString("account_id,asset,balance\n")
		for i := 0; i < rows; i++ {
			ref, asset, text := account(), pick("BTC", "ETH", "USDT", "BTC", "ETH", "USDT", "DOGE", "btc", " ETH "), amount()
			if rng.Intn(4) > 0 {
				// Mostly clean, so that whole ledgers are accepted often enough to be compared.
				ref, asset, text = fmt.Sprintf("clean-%d-%d", i, rng.Intn(3)), pick("BTC", "ETH", "USDT"), fmt.Sprint(rng.Intn(50))
			}
			long.Add(ref, asset, text)
			csv.WriteString(field(ref) + "," + field(asset) + "," + field(text) + "\n")
		}
		fromCode, codeReport := long.Finish()
		fromFile, fileReport, err := ReadCSV(strings.NewReader(csv.String()), CSVOptions{Assets: btcEthUsdt, Amounts: Decimal, MaxProblems: 1000})
		if err != nil {
			t.Fatal(err)
		}
		compare(round, "long", fromCode, fromFile, codeReport, fileReport)
		if codeReport.OK {
			accepted++
		}

		wide, csv := newBuilder(t, unlimited), strings.Builder{}
		csv.WriteString("account_id,BTC,ETH,USDT\n")
		for i := 0; i < rows; i++ {
			ref, cells := account(), map[string]string{}
			for _, a := range btcEthUsdt {
				switch rng.Intn(5) {
				case 0:
					// Left out of the map: an empty cell in the file.
				case 1:
					cells[a.Symbol] = amount()
				default:
					cells[a.Symbol] = fmt.Sprint(rng.Intn(50))
				}
			}
			wide.AddAccount(ref, cells)
			csv.WriteString(field(ref) + "," + field(cells["BTC"]) + "," + field(cells["ETH"]) + "," + field(cells["USDT"]) + "\n")
		}
		fromCode, codeReport = wide.Finish()
		fromFile, fileReport, err = ReadCSV(strings.NewReader(csv.String()), CSVOptions{Assets: btcEthUsdt, Amounts: Decimal, MaxProblems: 1000})
		if err != nil {
			t.Fatal(err)
		}
		compare(round, "wide", fromCode, fromFile, codeReport, fileReport)
		if codeReport.OK {
			accepted++
		}
	}
	if accepted < 20 {
		t.Fatalf("only %d of the random ledgers were accepted; the comparison of rows barely ran", accepted)
	}
}

// The limit is the number of leaves a statement can declare; here it is
// lowered so that it can be reached.
func TestLedgerBuilderRefusesMoreAccountsThanAStatementCanDeclare(t *testing.T) {
	l := newBuilder(t)
	l.maxAccounts = 3
	for i := 0; i < 3; i++ {
		if err := l.Add(fmt.Sprintf("u%d", i), "BTC", "1"); err != nil {
			t.Fatal(err)
		}
	}
	// More rows for accounts already there are no more accounts.
	if err := l.Add("u0", "ETH", "1"); err != nil {
		t.Fatal(err)
	}
	wantCode(t, l.Add("u3", "BTC", "1"), CodeTooManyAccounts)
	wantCode(t, l.AddAccount("u4", nil), CodeTooManyAccounts)
	ledger, report := l.Finish()
	if ledger != nil {
		t.Fatal("a ledger that was cut short")
	}
	// Said once, about the ledger as a whole.
	wantProblems(t, report, "0:too_many_accounts")
}
