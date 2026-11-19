package cjson

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func mustParse(t *testing.T, text string) any {
	t.Helper()
	v, err := Parse([]byte(text))
	if err != nil {
		t.Fatalf("Parse(%q): %v", text, err)
	}
	return v
}

func TestParseKeepsOrderAndTypes(t *testing.T) {
	got := mustParse(t, ` { "b" : [1, -0, 2.5, 1e3, 9007199254740992, true, false, null], "a" : {"z":"\u00e9\ud83d\ude00\n"} } `)
	want := Object{
		{Key: "b", Value: []any{int64(1), int64(0), Number("2.5"), Number("1e3"), Number("9007199254740992"), true, false, nil}},
		{Key: "a", Value: Object{{Key: "z", Value: "é😀\n"}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

func TestParseRefusesWhatALenientReaderRepairs(t *testing.T) {
	cases := map[string]string{
		"empty input":                  ``,
		"only whitespace":              `  `,
		"a byte-order mark":            "\uFEFF{}",
		"content after the document":   `{} {}`,
		"a trailing comma":             `[1,]`,
		"a missing comma":              `[1 2]`,
		"single quotes":                `{'a':1}`,
		"an unquoted name":             `{a:1}`,
		"a repeated name":              `{"a":1,"a":2}`,
		"a leading zero":               `01`,
		"a bare minus":                 `-`,
		"a point with no digits":       `1.`,
		"an exponent with no digits":   `1e`,
		"a leading plus":               `+1`,
		"NaN":                          `NaN`,
		"a raw line break in a string": "\"a\nb\"",
		"a raw tab in a string":        "\"a\tb\"",
		"an unknown escape":            `"\x41"`,
		"a short unicode escape":       `"\u12"`,
		"a lone high surrogate":        `"\ud83d"`,
		"a high surrogate then text":   `"\ud83dabc"`,
		"a lone low surrogate":         `"\ude00"`,
		"two high surrogates":          `"\ud83d\ud83d"`,
		"an unterminated string":       `"abc`,
		"an unterminated object":       `{"a":1`,
		"an unterminated array":        `[1`,
		"a truncated literal":          `tru`,
		"bytes that are not UTF-8":     "\"\xb0\xa1\"",
		"an overlong encoding":         "\"\xc0\xaf\"",
		"an encoded surrogate":         "\"\xed\xa0\x80\"",
		"nesting beyond the limit":     strings.Repeat("[", maxDepth+2) + strings.Repeat("]", maxDepth+2),
	}
	for name, text := range cases {
		if v, err := Parse([]byte(text)); err == nil {
			t.Errorf("%s: Parse(%q) = %#v, want an error", name, text, v)
		}
	}
}

func TestParseFindsARepeatedNameInAWideObject(t *testing.T) {
	// Past linearScanLimit the reader switches to a set; a repeat has to be
	// caught on both sides of the switch and across it.
	for _, n := range []int{2, linearScanLimit - 1, linearScanLimit, linearScanLimit + 1, 3 * linearScanLimit} {
		for dupOf := 0; dupOf < n; dupOf += max(1, n/5) {
			var b strings.Builder
			b.WriteByte('{')
			for i := 0; i < n; i++ {
				fmt.Fprintf(&b, `"k%d":%d,`, i, i)
			}
			fmt.Fprintf(&b, `"k%d":0}`, dupOf)
			if _, err := Parse([]byte(b.String())); err == nil {
				t.Errorf("%d members, k%d repeated: accepted", n, dupOf)
			}
		}
		var b strings.Builder
		b.WriteByte('{')
		for i := 0; i < n; i++ {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `"k%d":%d`, i, i)
		}
		b.WriteByte('}')
		v := mustParse(t, b.String())
		if len(v.(Object)) != n {
			t.Errorf("%d distinct members: read %d", n, len(v.(Object)))
		}
	}
}

func TestParseAgreesWithEncodingJSONOnOrdinaryDocuments(t *testing.T) {
	docs := []string{
		`{"schema":"x","n":12,"list":[{"a":"1"},{"b":[]}],"empty":{},"t":true,"z":null}`,
		`"plain"`, `0`, `-17`, `[]`, `{}`, `[[[["deep"]]]]`,
		`{"esc":"\"\\\/\b\f\n\r\t\u0041\u00e9\u2028"}`,
		`{"한글":"값","emoji":"😀","pair":"\ud83d\ude00"}`,
	}
	for _, doc := range docs {
		var want any
		if err := json.Unmarshal([]byte(doc), &want); err != nil {
			t.Fatal(err)
		}
		if got := plain(mustParse(t, doc)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got  %#v\n want %#v", doc, got, want)
		}
	}
}

// plain converts a parsed document to what encoding/json would have produced.
func plain(v any) any {
	switch v := v.(type) {
	case int64:
		return float64(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = plain(item)
		}
		return out
	case Object:
		out := make(map[string]any, len(v))
		for _, m := range v {
			out[m.Key] = plain(m.Value)
		}
		return out
	default:
		return v
	}
}

func TestCanonical(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"b":"2","a":"1","c":{"z":1,"y":[3,2,1]}}`, `{"a":"1","b":"2","c":{"y":[3,2,1],"z":1}}`},
		{`{"o":{},"a":[],"s":""}`, `{"a":[],"o":{},"s":""}`},
		{`{"max":9007199254740991,"min":-9007199254740991,"zero":-0}`, `{"max":9007199254740991,"min":-9007199254740991,"zero":0}`},
		{`{"s":"\u0000\u0001\u0008\u0009\u000a\u000b\u000c\u000d\u001f\u007f\u2028\u2029\/<>&"}`,
			"{\"s\":\"\\u0000\\u0001\\b\\t\\n\\u000b\\f\\r\\u001f\u007f\u2028\u2029/<>&\"}"},
		// U+E000 is one code unit above every surrogate; the emoji is two surrogates.
		{`{"\ue000":1,"😀":2,"a":3,"Z":4,"가":5}`, "{\"Z\":4,\"a\":3,\"가\":5,\"😀\":2,\"\ue000\":1}"},
		{`{"10":"a","9":"b","1":"c"}`, `{"1":"c","10":"a","9":"b"}`},
		{`[null,true,false]`, `[null,true,false]`},
	}
	for _, c := range cases {
		got, err := Canonical(mustParse(t, c.in))
		if err != nil {
			t.Errorf("Canonical(%s): %v", c.in, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("Canonical(%s)\n got  %s\n want %s", c.in, got, c.want)
		}
	}
}

func TestCanonicalRefusesWhatItCannotWriteExactly(t *testing.T) {
	for _, text := range []string{`1.5`, `{"x":1.0}`, `{"x":1e2}`, `[9007199254740992]`, `-9007199254740992`, `123456789012345678901234567890`} {
		if got, err := Canonical(mustParse(t, text)); err == nil {
			t.Errorf("Canonical(%s) = %s, want an error", text, got)
		}
	}
	for name, v := range map[string]any{
		"an integer beyond the safe range": int64(MaxSafeInteger + 1),
		"a Go int":                         7,
		"a float":                          1.0,
		"a string that is not UTF-8":       "\xff",
		"a name that is not UTF-8":         Object{{Key: "\xff", Value: nil}},
		"a repeated name":                  Object{{Key: "a", Value: nil}, {Key: "a", Value: nil}},
	} {
		if got, err := Canonical(v); err == nil {
			t.Errorf("%s: Canonical = %s, want an error", name, got)
		}
	}
}

func TestCompareUTF16MatchesTheCodeUnits(t *testing.T) {
	words := []string{"", "a", "ab", "b", "Z", "가", "\ud7ff", "\ue000", "\uffff", "😀", "😀a", "\U00010000", "\U0010ffff", "a😀", "a\ue000", "é"}
	for _, a := range words {
		for _, b := range words {
			want := compareUnits(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
			if got := sign(CompareUTF16(a, b)); got != want {
				t.Errorf("CompareUTF16(%q, %q) = %d, want %d", a, b, got, want)
			}
		}
	}
}

func compareUnits(a, b []uint16) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return sign(int(a[i]) - int(b[i]))
		}
	}
	return sign(len(a) - len(b))
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}

func TestCompactAndIndentKeepOrderAndMatchJSONStringify(t *testing.T) {
	v := mustParse(t, `{"schema":"s","list":[1,{"b":"x","a":[]},[]],"empty":{},"n":2.50,"s":"a\"b"}`)
	compact, err := Compact(v)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"schema":"s","list":[1,{"b":"x","a":[]},[]],"empty":{},"n":2.50,"s":"a\"b"}`; string(compact) != want {
		t.Errorf("Compact:\n got  %s\n want %s", compact, want)
	}
	indented, err := Indent(v)
	if err != nil {
		t.Fatal(err)
	}
	// The layout of JSON.stringify(value, null, 2).
	want := `{
  "schema": "s",
  "list": [
    1,
    {
      "b": "x",
      "a": []
    },
    []
  ],
  "empty": {},
  "n": 2.50,
  "s": "a\"b"
}`
	if string(indented) != want {
		t.Errorf("Indent:\n got  %s\n want %s", indented, want)
	}
	// Whatever the layout, reading it back gives the same document.
	for _, text := range [][]byte{compact, indented} {
		if back := mustParse(t, string(text)); !reflect.DeepEqual(back, v) {
			t.Errorf("%s does not read back as the value it was written from", text)
		}
	}
}

func TestWritersRefuseValuesThatAreNotJSON(t *testing.T) {
	for _, v := range []any{struct{}{}, map[string]any{}, []string{"a"}, 3, "\xc3\x28"} {
		if _, err := Compact(v); err == nil {
			t.Errorf("Compact(%#v): no error", v)
		}
		if _, err := Indent(v); err == nil {
			t.Errorf("Indent(%#v): no error", v)
		}
	}
}
