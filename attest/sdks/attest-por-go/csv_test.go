package por

import (
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
)

// utf8BOM is the byte-order mark as a UTF-8 file carries it.
const utf8BOM = "\xEF\xBB\xBF"

type parsedRecord struct {
	Line   int
	Fields []string
}

// parseCSV reads every record of src. The fault, if any, is where reading stopped.
func parseCSV(t *testing.T, src io.Reader, delimiter rune) ([]parsedRecord, *csvFault) {
	t.Helper()
	reader := newCSVReader(src, delimiter)
	var out []parsedRecord
	for {
		rec, ok, fault, err := reader.next()
		if err != nil {
			t.Fatalf("read error: %v", err)
		}
		if fault != nil || !ok {
			return out, fault
		}
		out = append(out, parsedRecord{rec.line, append([]string(nil), rec.fields...)})
	}
}

func fieldsOf(t *testing.T, text string) [][]string {
	t.Helper()
	records, fault := parseCSV(t, strings.NewReader(text), ',')
	if fault != nil {
		t.Fatalf("%q: %+v", text, fault)
	}
	out := [][]string{}
	for _, r := range records {
		out = append(out, r.Fields)
	}
	return out
}

func TestCSVDialect(t *testing.T) {
	cases := []struct {
		text string
		want [][]string
	}{
		{"a,b\n1,2\n", [][]string{{"a", "b"}, {"1", "2"}}},
		// The last record need not end in a line break.
		{"a,b\r\n1,2", [][]string{{"a", "b"}, {"1", "2"}}},
		{utf8BOM + "a,b\n", [][]string{{"a", "b"}}},
		// Only the first one is a byte-order mark.
		{utf8BOM + utf8BOM + "a\n", [][]string{{utf8BOM + "a"}}},
		{"a" + utf8BOM + "\n", [][]string{{"a" + utf8BOM}}},
		{`"x,1","say ""hi""",""` + "\n", [][]string{{"x,1", `say "hi"`, ""}}},
		// A trailing delimiter is an empty last field, not a missing one.
		{"a,\n", [][]string{{"a", ""}}},
		{",\n", [][]string{{"", ""}}},
		// A line with nothing on it is skipped; one with a space is a record.
		{"a\n\n\r\n \nb\n", [][]string{{"a"}, {" "}, {"b"}}},
		{`""` + "\n", [][]string{{""}}},
		// A lone CR ends a record too; inside quotes it is data.
		{"a,b\rc,d\r", [][]string{{"a", "b"}, {"c", "d"}}},
		{"\"a\rb\",\"c\r\nd\"\n", [][]string{{"a\rb", "c\r\nd"}}},
		{`"a"` + "\r\n" + `"b"`, [][]string{{"a"}, {"b"}}},
		{"", [][]string{}},
		{"\n\n", [][]string{}},
		{"한글,😀\n", [][]string{{"한글", "😀"}}},
		// U+FFFD written in the file is a character like any other.
		{"\xEF\xBF\xBD\n", [][]string{{"\xEF\xBF\xBD"}}},
	}
	for _, c := range cases {
		if got := fieldsOf(t, c.text); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q:\n got  %q\n want %q", c.text, got, c.want)
		}
	}
	records, _ := parseCSV(t, strings.NewReader("a;b|c\n"), ';')
	if !reflect.DeepEqual(records, []parsedRecord{{1, []string{"a", "b|c"}}}) {
		t.Errorf("semicolon delimiter: %+v", records)
	}
	records, _ = parseCSV(t, strings.NewReader("a·b\n"), '·')
	if !reflect.DeepEqual(records, []parsedRecord{{1, []string{"a", "b"}}}) {
		t.Errorf("a delimiter outside ASCII: %+v", records)
	}
}

func TestCSVRecordsKnowTheLineTheyStartOn(t *testing.T) {
	records, fault := parseCSV(t, strings.NewReader("h\n\"two\nlines\"\nnext\n\n\r\nlast"), ',')
	want := []parsedRecord{{1, []string{"h"}}, {2, []string{"two\nlines"}}, {4, []string{"next"}}, {7, []string{"last"}}}
	if fault != nil || !reflect.DeepEqual(records, want) {
		t.Fatalf("got %+v, %+v; want %+v", records, fault, want)
	}
}

func TestCSVRefusesWhatASpreadsheetWouldGuessAt(t *testing.T) {
	cases := []struct {
		text     string
		code     string
		line     int
		fragment string
		before   int // records read before the fault
	}{
		{"a,b\n1,2\"3\n", CodeCSVSyntax, 2, "inside an unquoted field", 1},
		{"a\n\"x\"y\n", CodeCSVSyntax, 2, "after a closing quote", 1},
		{"a\n\"x\" ,y\n", CodeCSVSyntax, 2, "after a closing quote", 1},
		// At the line the record began on, not the line the file ended on.
		{"a\n\"never closed\nmore\n", CodeCSVSyntax, 2, "ends inside a quoted field", 1},
		{"a\nb\n\"line 3\n\n\nx\"y", CodeCSVSyntax, 6, "after a closing quote", 2},
		{"a\n\xb0\xa1,1\n", CodeFileEncoding, 0, "UTF-8", 1},
		// Truncated, overlong and surrogate encodings are not UTF-8 either.
		{"a\n\xea\xb0", CodeFileEncoding, 0, "UTF-8", 1},
		{"\xc0\xafa\n", CodeFileEncoding, 0, "UTF-8", 0},
		{"\xed\xa0\x80\n", CodeFileEncoding, 0, "UTF-8", 0},
		{"\"\xff\"\n", CodeFileEncoding, 0, "UTF-8", 0},
	}
	for _, c := range cases {
		records, fault := parseCSV(t, strings.NewReader(c.text), ',')
		if fault == nil {
			t.Errorf("%q: read as %+v, want a fault", c.text, records)
			continue
		}
		if fault.code != c.code || fault.line != c.line || !strings.Contains(fault.message, c.fragment) || len(records) != c.before {
			t.Errorf("%q: fault %+v after %d records; want %s at line %d mentioning %q after %d", c.text, *fault, len(records), c.code, c.line, c.fragment, c.before)
		}
	}
}

// Buffer boundaries inside CRLF, inside "", inside a multi-byte character and
// after a closing quote are where a streaming reader goes wrong.
func TestCSVDoesNotDependOnHowTheInputArrives(t *testing.T) {
	text := utf8BOM + "id,note\r\n1,\"a \"\"b\"\" c\"\r\n2,\"line\r\nbreak 한글\"\r\n\r\n3,plain 😀"
	whole, fault := parseCSV(t, strings.NewReader(text), ',')
	if fault != nil || len(whole) != 4 {
		t.Fatalf("got %+v, %+v", whole, fault)
	}
	for name, src := range map[string]io.Reader{
		"a byte at a time":    iotest.OneByteReader(strings.NewReader(text)),
		"half of each read":   iotest.HalfReader(strings.NewReader(text)),
		"data with the EOF":   iotest.DataErrReader(strings.NewReader(text)),
		"timeouts in between": &flakyReader{src: strings.NewReader(text)},
	} {
		if got, fault := parseCSV(t, src, ','); fault != nil || !reflect.DeepEqual(got, whole) {
			t.Errorf("%s: got %+v, %+v", name, got, fault)
		}
	}
}

// flakyReader returns nothing at all on every other call, as a slow pipe may.
type flakyReader struct {
	src   io.Reader
	calls int
}

func (f *flakyReader) Read(p []byte) (int, error) {
	if f.calls++; f.calls%2 == 0 {
		return 0, nil
	}
	return f.src.Read(p[:min(len(p), 3)])
}

func TestCSVAQuotedFieldThatNeverClosesIsStoppedEarly(t *testing.T) {
	// Just inside the limit is data.
	inside := "h\n\"" + strings.Repeat("x", maxQuotedField) + "\"\n"
	if records, fault := parseCSV(t, strings.NewReader(inside), ','); fault != nil || len(records) != 2 {
		t.Fatalf("a quoted field of the maximum length: %d records, %+v", len(records), fault)
	}
	// One past it is an unbalanced quote, reported where the record began,
	// long before the end of the input.
	body := strings.Repeat("row,row\n", maxQuotedField/8+1)
	records, fault := parseCSV(t, strings.NewReader("h\nok\n\""+body+strings.Repeat("y", 1<<20)), ',')
	if fault == nil || fault.code != CodeCSVSyntax || fault.line != 3 || !strings.Contains(fault.message, "never closes") || len(records) != 2 {
		t.Fatalf("got %d records and %+v", len(records), fault)
	}
	// The length is counted as the reference counts it: in UTF-16 code units.
	astral := "h\n\"" + strings.Repeat("😀", maxQuotedField/2) + "\"\n"
	if _, fault := parseCSV(t, strings.NewReader(astral), ','); fault != nil {
		t.Fatalf("%d astral characters are exactly the limit: %+v", maxQuotedField/2, fault)
	}
	if _, fault := parseCSV(t, strings.NewReader("h\n\""+strings.Repeat("😀", maxQuotedField/2)+"x\"\n"), ','); fault == nil {
		t.Fatal("one unit past the limit was accepted")
	}
}

func TestCSVDelimiterIsChecked(t *testing.T) {
	for _, d := range []rune{'"', '\n', '\r', 0x1F600, 0xD800, -1, 0x110000} {
		if err := checkDelimiter(d); err == nil || err.Code != CodeInvalidOption {
			t.Errorf("delimiter %U: %v", d, err)
		}
	}
	for _, d := range []rune{',', ';', '\t', '|', ' ', '·', 0xFFFD} {
		if err := checkDelimiter(d); err != nil {
			t.Errorf("delimiter %q: %v", d, err)
		}
	}
}

func TestCSVPassesOnAReadFailure(t *testing.T) {
	broken := errors.New("the disk went away")
	reader := newCSVReader(io.MultiReader(strings.NewReader("a,b\n1,"), iotest.ErrReader(broken)), ',')
	if _, ok, fault, err := reader.next(); !ok || fault != nil || err != nil {
		t.Fatalf("the first record: %v %+v %v", ok, fault, err)
	}
	if _, _, _, err := reader.next(); !errors.Is(err, broken) {
		t.Fatalf("got %v, want the read failure", err)
	}
	if _, ok, fault, err := reader.next(); ok || fault != nil || err != nil {
		t.Fatalf("after a failure the reader is finished: %v %+v %v", ok, fault, err)
	}
}

func ExampleReadCSV() {
	export := "account_id,asset,balance\nu1,BTC,0.5\nu1,ETH,2\nu2,BTC,-1\n"
	_, report, err := ReadCSV(strings.NewReader(export), CSVOptions{
		Assets:  []Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}},
		Amounts: Decimal,
	})
	if err != nil {
		fmt.Println(err)
		return
	}
	for _, p := range report.Problems {
		fmt.Printf("line %d %s\n", p.Line, p.Code)
	}
	// Output: line 4 amount_negative
}
