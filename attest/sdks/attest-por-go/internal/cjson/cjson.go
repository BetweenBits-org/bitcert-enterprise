// Package cjson is the JSON this protocol speaks: one strict reader and three
// writers that differ only in layout.
//
// encoding/json is not used for any byte this SDK hashes, signs or checks,
// for reasons that each change a result silently:
//
//   - it escapes <, >, & and U+2028/U+2029 when writing, and sorts map keys
//     by byte, where canonical JSON escapes none of those and sorts by UTF-16
//     code unit;
//   - it replaces invalid UTF-8 and lone surrogates with U+FFFD when reading,
//     so a document can come back different from the one that was signed;
//   - it keeps the last of two members with the same name without saying so;
//   - it loses the order of an object's members, and the files this SDK
//     writes are laid out the way the reference implementation lays them out.
//
// A document is held as plain Go values: nil, bool, int64, Number, string,
// []any and Object.
package cjson

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"unicode/utf8"
)

// MaxSafeInteger is 2^53 − 1, the largest integer every JSON implementation
// reads back exactly. Canonical JSON refuses anything beyond it.
const MaxSafeInteger = 1<<53 - 1

// maxDepth bounds nesting so that a hostile document cannot exhaust the
// stack. The deepest document of the protocol nests five levels.
const maxDepth = 200

// linearScanLimit is the object size up to which a repeated member name is
// found by looking through the members read so far.
const linearScanLimit = 16

// Member is one name and value of an Object.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object with its members in the order they were written.
type Object []Member

// Get returns the value of the member named key.
func (o Object) Get(key string) (any, bool) {
	for _, m := range o {
		if m.Key == key {
			return m.Value, true
		}
	}
	return nil, false
}

// Number is a JSON number that is not an integer within ±MaxSafeInteger, kept
// exactly as it was written. The reader produces it so that a platform answer
// carrying a ratio or a timestamp in seconds can still be read; canonical
// JSON refuses it.
type Number string

// SyntaxError reports where a document stopped being JSON.
type SyntaxError struct {
	Offset int
	Msg    string
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("invalid JSON at byte %d: %s", e.Offset, e.Msg)
}

// Parse reads exactly one JSON document.
//
// It refuses what a lenient reader would repair: bytes that are not UTF-8, an
// escaped surrogate without its pair, a raw control character inside a
// string, two members with the same name in one object, a byte-order mark,
// and anything after the document other than whitespace.
func Parse(data []byte) (any, error) {
	p := parser{data: data}
	p.skipSpace()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.pos != len(p.data) {
		return nil, p.fail("unexpected content after the document")
	}
	return v, nil
}

type parser struct {
	data []byte
	pos  int
}

func (p *parser) fail(msg string) error {
	return &SyntaxError{Offset: p.pos, Msg: msg}
}

func (p *parser) skipSpace() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (any, error) {
	if depth > maxDepth {
		return nil, p.fail("nested too deeply")
	}
	if p.pos >= len(p.data) {
		return nil, p.fail("unexpected end of input")
	}
	switch c := p.data[p.pos]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		return p.string()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		return true, p.literal("true")
	case c == 'f':
		return false, p.literal("false")
	case c == 'n':
		return nil, p.literal("null")
	default:
		return nil, p.fail("unexpected character")
	}
}

func (p *parser) literal(word string) error {
	if len(p.data)-p.pos < len(word) || string(p.data[p.pos:p.pos+len(word)]) != word {
		return p.fail("unexpected character")
	}
	p.pos += len(word)
	return nil
}

func (p *parser) object(depth int) (any, error) {
	p.pos++ // {
	obj := Object{}
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return obj, nil
	}
	// Names seen so far, once there are too many to look through one by one:
	// a balances object has a member per listed asset.
	var seen map[string]struct{}
	for {
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.fail("expected a member name")
		}
		at := p.pos
		key, err := p.string()
		if err != nil {
			return nil, err
		}
		dup := false
		if seen != nil {
			_, dup = seen[key]
			seen[key] = struct{}{}
		} else {
			_, dup = obj.Get(key)
			if len(obj) == linearScanLimit {
				seen = make(map[string]struct{}, 2*linearScanLimit)
				for _, m := range obj {
					seen[m.Key] = struct{}{}
				}
				seen[key] = struct{}{}
			}
		}
		if dup {
			// Which of the two a reader keeps is not something every
			// language agrees on, so neither is kept.
			p.pos = at
			return nil, p.fail("member " + strconv.Quote(key) + " appears twice in one object")
		}
		p.skipSpace()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, p.fail("expected ':' after a member name")
		}
		p.pos++
		p.skipSpace()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		obj = append(obj, Member{Key: key, Value: v})
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, p.fail("unexpected end of input inside an object")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return obj, nil
		default:
			return nil, p.fail("expected ',' or '}'")
		}
	}
}

func (p *parser) array(depth int) (any, error) {
	p.pos++ // [
	arr := []any{}
	p.skipSpace()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return arr, nil
	}
	for {
		p.skipSpace()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		arr = append(arr, v)
		p.skipSpace()
		if p.pos >= len(p.data) {
			return nil, p.fail("unexpected end of input inside an array")
		}
		switch p.data[p.pos] {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return arr, nil
		default:
			return nil, p.fail("expected ',' or ']'")
		}
	}
}

func (p *parser) number() (any, error) {
	start := p.pos
	if p.data[p.pos] == '-' {
		p.pos++
	}
	digits := func() int {
		n := 0
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			p.pos++
			n++
		}
		return n
	}
	intStart := p.pos
	if digits() == 0 {
		return nil, p.fail("expected a digit")
	}
	if p.data[intStart] == '0' && p.pos-intStart > 1 {
		p.pos = intStart
		return nil, p.fail("a number may not have leading zeros")
	}
	integer := true
	if p.pos < len(p.data) && p.data[p.pos] == '.' {
		integer = false
		p.pos++
		if digits() == 0 {
			return nil, p.fail("expected a digit after the decimal point")
		}
	}
	if p.pos < len(p.data) && (p.data[p.pos] == 'e' || p.data[p.pos] == 'E') {
		integer = false
		p.pos++
		if p.pos < len(p.data) && (p.data[p.pos] == '+' || p.data[p.pos] == '-') {
			p.pos++
		}
		if digits() == 0 {
			return nil, p.fail("expected a digit in the exponent")
		}
	}
	text := string(p.data[start:p.pos])
	if integer {
		// A literal too long for int64 is out of the safe range as well.
		if n, err := strconv.ParseInt(text, 10, 64); err == nil && n >= -MaxSafeInteger && n <= MaxSafeInteger {
			return n, nil
		}
	}
	return Number(text), nil
}

func (p *parser) string() (string, error) {
	p.pos++ // opening quote
	// Most strings have no escape; those are sliced out without a copy pass.
	start := p.pos
	for p.pos < len(p.data) {
		c := p.data[p.pos]
		if c == '"' {
			s := p.data[start:p.pos]
			if !utf8.Valid(s) {
				return "", p.invalidUTF8(start)
			}
			p.pos++
			return string(s), nil
		}
		if c == '\\' {
			break
		}
		if c < 0x20 {
			return "", p.fail("a control character inside a string must be escaped")
		}
		p.pos++
	}
	buf := append([]byte(nil), p.data[start:p.pos]...)
	for p.pos < len(p.data) {
		c := p.data[p.pos]
		switch {
		case c == '"':
			if !utf8.Valid(buf) {
				return "", p.invalidUTF8(start)
			}
			p.pos++
			return string(buf), nil
		case c < 0x20:
			return "", p.fail("a control character inside a string must be escaped")
		case c != '\\':
			buf = append(buf, c)
			p.pos++
		default:
			var err error
			if buf, err = p.escape(buf); err != nil {
				return "", err
			}
		}
	}
	return "", p.fail("unexpected end of input inside a string")
}

func (p *parser) invalidUTF8(start int) error {
	p.pos = start
	return p.fail("a string is not valid UTF-8")
}

// escape reads one backslash sequence at p.pos and appends what it stands for.
func (p *parser) escape(buf []byte) ([]byte, error) {
	if p.pos+1 >= len(p.data) {
		return nil, p.fail("unexpected end of input inside a string")
	}
	c := p.data[p.pos+1]
	switch c {
	case '"', '\\', '/':
		p.pos += 2
		return append(buf, c), nil
	case 'b':
		p.pos += 2
		return append(buf, '\b'), nil
	case 'f':
		p.pos += 2
		return append(buf, '\f'), nil
	case 'n':
		p.pos += 2
		return append(buf, '\n'), nil
	case 'r':
		p.pos += 2
		return append(buf, '\r'), nil
	case 't':
		p.pos += 2
		return append(buf, '\t'), nil
	case 'u':
	default:
		return nil, p.fail("unknown escape sequence")
	}
	r, ok := p.hex4(p.pos + 2)
	if !ok {
		return nil, p.fail(`\u must be followed by four hexadecimal digits`)
	}
	size := 6
	switch {
	case r >= 0xDC00 && r <= 0xDFFF:
		return nil, p.fail("an escaped low surrogate has no high surrogate before it")
	case r >= 0xD800 && r <= 0xDBFF:
		// A pair of escapes is one character. Half a pair is no character at
		// all: it has no UTF-8 form, so the bytes hashed for it would be
		// whatever each implementation chose to substitute.
		low, ok := rune(0), false
		if p.pos+7 < len(p.data) && p.data[p.pos+6] == '\\' && p.data[p.pos+7] == 'u' {
			low, ok = p.hex4(p.pos + 8)
		}
		if !ok || low < 0xDC00 || low > 0xDFFF {
			return nil, p.fail("an escaped high surrogate has no low surrogate after it")
		}
		r = 0x10000 + (r-0xD800)<<10 + (low - 0xDC00)
		size = 12
	}
	p.pos += size
	return utf8.AppendRune(buf, r), nil
}

func (p *parser) hex4(at int) (rune, bool) {
	if at+4 > len(p.data) {
		return 0, false
	}
	var r rune
	for _, c := range p.data[at : at+4] {
		switch {
		case c >= '0' && c <= '9':
			r = r<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			r = r<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			r = r<<4 | rune(c-'A'+10)
		default:
			return 0, false
		}
	}
	return r, true
}

// Canonical writes v as canonical JSON: the subset of RFC 8785 the protocol
// uses. Members are sorted by name, compared as UTF-16 code units; there is
// no whitespace; a number is an integer within ±MaxSafeInteger or an error.
// The result is what gets hashed and signed.
func Canonical(v any) ([]byte, error) {
	return appendValue(nil, v, layoutCanonical, 0)
}

// Compact writes v on one line with members in the order they are held —
// what JavaScript's JSON.stringify(v) produces.
func Compact(v any) ([]byte, error) {
	return appendValue(nil, v, layoutCompact, 0)
}

// Indent writes v over several lines with two-space indentation and members
// in the order they are held — what JSON.stringify(v, null, 2) produces, so
// that a file this SDK writes is laid out like the reference's.
func Indent(v any) ([]byte, error) {
	return appendValue(nil, v, layoutIndent, 0)
}

type layout int

const (
	layoutCanonical layout = iota
	layoutCompact
	layoutIndent
)

func appendValue(dst []byte, v any, l layout, depth int) ([]byte, error) {
	if depth > maxDepth {
		return nil, errors.New("value is nested too deeply")
	}
	switch v := v.(type) {
	case nil:
		return append(dst, "null"...), nil
	case bool:
		return strconv.AppendBool(dst, v), nil
	case int64:
		if v < -MaxSafeInteger || v > MaxSafeInteger {
			return nil, fmt.Errorf("integer %d is beyond 2^53-1 in magnitude", v)
		}
		return strconv.AppendInt(dst, v, 10), nil
	case Number:
		if l == layoutCanonical {
			return nil, fmt.Errorf("number %s is not an integer of at most 2^53-1 in magnitude; canonical JSON carries amounts as decimal strings", string(v))
		}
		return append(dst, v...), nil
	case string:
		return AppendString(dst, v)
	case []any:
		return appendArray(dst, v, l, depth)
	case Object:
		return appendObject(dst, v, l, depth)
	default:
		return nil, fmt.Errorf("a %T is not a JSON value", v)
	}
}

func appendArray(dst []byte, arr []any, l layout, depth int) ([]byte, error) {
	if len(arr) == 0 {
		return append(dst, "[]"...), nil
	}
	dst = append(dst, '[')
	var err error
	for i, item := range arr {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = appendBreak(dst, l, depth+1)
		if dst, err = appendValue(dst, item, l, depth+1); err != nil {
			return nil, err
		}
	}
	dst = appendBreak(dst, l, depth)
	return append(dst, ']'), nil
}

func appendObject(dst []byte, obj Object, l layout, depth int) ([]byte, error) {
	if len(obj) == 0 {
		return append(dst, "{}"...), nil
	}
	members := obj
	if l == layoutCanonical {
		members = append(Object(nil), obj...)
		slices.SortFunc(members, func(a, b Member) int { return CompareUTF16(a.Key, b.Key) })
		for i := 1; i < len(members); i++ {
			// The reader refuses a repeated name; a value assembled in code
			// could still carry one, and sorted it sits next to itself.
			if members[i].Key == members[i-1].Key {
				return nil, fmt.Errorf("member %s appears twice in one object", strconv.Quote(members[i].Key))
			}
		}
	}
	dst = append(dst, '{')
	var err error
	for i, m := range members {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = appendBreak(dst, l, depth+1)
		if dst, err = AppendString(dst, m.Key); err != nil {
			return nil, err
		}
		dst = append(dst, ':')
		if l == layoutIndent {
			dst = append(dst, ' ')
		}
		if dst, err = appendValue(dst, m.Value, l, depth+1); err != nil {
			return nil, err
		}
	}
	dst = appendBreak(dst, l, depth)
	return append(dst, '}'), nil
}

func appendBreak(dst []byte, l layout, depth int) []byte {
	if l != layoutIndent {
		return dst
	}
	dst = append(dst, '\n')
	for i := 0; i < depth; i++ {
		dst = append(dst, ' ', ' ')
	}
	return dst
}

// CompareUTF16 orders two strings as sequences of UTF-16 code units, which is
// the order RFC 8785 prescribes for member names. It returns a negative
// number, zero or a positive number as a sorts before, with or after b.
//
// It differs from comparing the UTF-8 bytes in one place only: a character
// outside the Basic Multilingual Plane is two surrogates starting at
// D800–DBFF, so it sorts before U+E000–U+FFFF although its code point is
// higher.
func CompareUTF16(a, b string) int {
	for len(a) > 0 && len(b) > 0 {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			if ua, ub := leadUnit(ra), leadUnit(rb); ua != ub {
				return int(ua - ub)
			}
			// Same high surrogate: the low surrogates order as the code points do.
			return int(ra - rb)
		}
		a, b = a[na:], b[nb:]
	}
	return len(a) - len(b)
}

// leadUnit is the first UTF-16 code unit of r.
func leadUnit(r rune) rune {
	if r < 0x10000 {
		return r
	}
	return 0xD800 + (r-0x10000)>>10
}

// AppendString appends s as a JSON string. It escapes exactly what RFC 8785
// escapes — the quote, the backslash and the control characters below U+0020
// — and writes everything else as itself, U+007F, U+2028 and U+2029 included.
//
// A string that is not valid UTF-8 is an error: there is no JSON text for it,
// and substituting U+FFFD would write a different string from the one given.
func AppendString(dst []byte, s string) ([]byte, error) {
	if !utf8.ValidString(s) {
		return nil, fmt.Errorf("string %s is not valid UTF-8", strconv.QuoteToASCII(s))
	}
	const hex = "0123456789abcdef"
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			continue
		}
		dst = append(dst, s[start:i]...)
		start = i + 1
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\t':
			dst = append(dst, '\\', 't')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\r':
			dst = append(dst, '\\', 'r')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xF])
		}
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"'), nil
}
