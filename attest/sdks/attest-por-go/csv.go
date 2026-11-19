package por

import (
	"bufio"
	"io"
	"unicode/utf8"
)

// A CSV reader for one job: reading an exchange's balance export without
// guessing.
//
// The file decides a liability total that is then signed and anchored, so the
// reader's bias is the opposite of a spreadsheet's. A spreadsheet shows
// something for every input; this stops, with the line number, at the first
// thing it would otherwise have to interpret — a quote in the middle of a
// field, text after a closing quote, bytes that are not UTF-8. Each of those
// is a file two programs would read differently, and that is how a total
// comes to differ from the ledger it was exported from. encoding/csv is not
// used for that reason: it has lenient modes, reports positions differently,
// and decodes nothing strictly.
//
// The dialect is the one of specification §7: UTF-8 with or without a
// byte-order mark; records end in LF or CRLF; a line with nothing on it is
// skipped; a field may be wrapped in double quotes, and may then contain the
// delimiter, line breaks and "" for a quote.

// byteOrderMark may open a UTF-8 file; it is not part of the first header name.
const byteOrderMark = 0xFEFF

// maxQuotedField is the length, in UTF-16 code units as the reference counts
// it, beyond which a quoted field is taken for an unbalanced quote rather
// than data. Without it one stray quote would pull the rest of a ledger into
// a single field.
const maxQuotedField = 1 << 20

// csvRecord is one record. fields is only valid until the next call to next.
type csvRecord struct {
	// line is the 1-based physical line the record starts on.
	line   int
	fields []string
}

// csvFault is a reason the file cannot be read further.
type csvFault struct {
	code    string
	line    int
	message string
}

type csvState int

const (
	// atFieldStart: nothing of the current field has been read.
	atFieldStart csvState = iota
	inUnquoted
	inQuoted
	// afterQuote: a quote was read inside a quoted field; the next character
	// says whether it was the first half of "" or the end of the field.
	afterQuote
)

type csvReader struct {
	src       *bufio.Reader
	delimiter rune

	state csvState
	// line is the physical line being read; recordLine is where the current
	// record began (they differ inside a quoted field that spans lines).
	line       int
	recordLine int
	// started: the first character, where a byte-order mark may sit, is past.
	started bool
	// afterCR: the last character was a CR that ended a record, so an LF
	// right after it belongs to the same line ending.
	afterCR bool
	// blank: the current record has no content, no quote and no delimiter.
	blank bool
	// quotedUnits is the length so far of the quoted field being read.
	quotedUnits int
	field       []byte
	fields      []string
	done        bool
}

func newCSVReader(src io.Reader, delimiter rune) *csvReader {
	return &csvReader{src: bufio.NewReaderSize(src, 64<<10), delimiter: delimiter, line: 1, recordLine: 1, blank: true}
}

// checkDelimiter refuses a delimiter the dialect cannot use. Beyond the Basic
// Multilingual Plane is refused because the reference takes one UTF-16 code
// unit, and a setting one SDK accepts and another does not is a ledger only
// one of them can read.
func checkDelimiter(d rune) *Error {
	if d == '"' || d == '\n' || d == '\r' || d > 0xFFFF || !utf8.ValidRune(d) {
		return errorf(CodeInvalidOption, "the delimiter must be a single character other than a quote or a line break")
	}
	return nil
}

// next returns the following record. At the end of the input ok is false.
// A fault ends the reading: the record it sits in is not returned. err is a
// failure of the underlying reader.
func (c *csvReader) next() (rec csvRecord, ok bool, fault *csvFault, err error) {
	if c.done {
		return csvRecord{}, false, nil, nil
	}
	for {
		r, size, readErr := c.src.ReadRune()
		if readErr == io.EOF {
			c.done = true
			if c.state == inQuoted {
				return csvRecord{}, false, &csvFault{CodeCSVSyntax, c.recordLine,
					`the file ends inside a quoted field (an unpaired " in this record)`}, nil
			}
			rec, ok = c.endRecord()
			return rec, ok, nil, nil
		}
		if readErr != nil {
			c.done = true
			return csvRecord{}, false, nil, readErr
		}
		if r == utf8.RuneError && size == 1 {
			// A file in another encoding must stop here. Decoded leniently,
			// every account identifier with a non-ASCII character would
			// silently become a different identifier, and the people it
			// belongs to could never match their proof.
			c.done = true
			return csvRecord{}, false, &csvFault{CodeFileEncoding, 0, "the file is not valid UTF-8; export it as UTF-8"}, nil
		}
		if !c.started {
			c.started = true
			if r == byteOrderMark {
				continue
			}
		}
		if c.afterCR {
			c.afterCR = false
			if r == '\n' {
				continue
			}
		}

		if c.state == inQuoted {
			if r == '"' {
				c.state = afterQuote
				continue
			}
			if r == '\n' {
				c.line++
			}
			c.field = utf8.AppendRune(c.field, r)
			if c.quotedUnits += utf16Units(r); c.quotedUnits > maxQuotedField {
				c.done = true
				return csvRecord{}, false, &csvFault{CodeCSVSyntax, c.recordLine,
					`a quoted field never closes (check for an unpaired " in this record)`}, nil
			}
			continue
		}
		if c.state == afterQuote {
			if r == '"' {
				c.field = append(c.field, '"')
				c.quotedUnits++
				c.state = inQuoted
				continue
			}
			// The quote closed the field; only a delimiter or a line end may follow.
			if r != c.delimiter && r != '\n' && r != '\r' {
				c.done = true
				return csvRecord{}, false, &csvFault{CodeCSVSyntax, c.line,
					"unexpected " + quote(string(r)) + ` after a closing quote (a quote inside a quoted field is written "")`}, nil
			}
			c.state = inUnquoted
		}

		switch r {
		case c.delimiter:
			c.fields = append(c.fields, string(c.field))
			c.field = c.field[:0]
			c.state = atFieldStart
			c.blank = false
		case '\n', '\r':
			c.afterCR = r == '\r'
			rec, ok = c.endRecord()
			c.line++
			c.recordLine = c.line
			if ok {
				return rec, true, nil, nil
			}
		case '"':
			if c.state != atFieldStart {
				c.done = true
				return csvRecord{}, false, &csvFault{CodeCSVSyntax, c.line,
					`a " inside an unquoted field (wrap the whole field in quotes and write the quote as "")`}, nil
			}
			c.state = inQuoted
			c.quotedUnits = 0
			c.blank = false
		default:
			c.field = utf8.AppendRune(c.field, r)
			c.state = inUnquoted
			c.blank = false
		}
	}
}

// endRecord closes the record being read. A line with nothing on it is not a
// record.
func (c *csvReader) endRecord() (csvRecord, bool) {
	rec, ok := csvRecord{}, !c.blank
	if ok {
		c.fields = append(c.fields, string(c.field))
		rec = csvRecord{line: c.recordLine, fields: c.fields}
	}
	c.field = c.field[:0]
	c.fields = c.fields[:0]
	c.state = atFieldStart
	c.blank = true
	return rec, ok
}
