package por

import (
	"encoding/hex"
	"slices"
	"strings"
	"unicode/utf8"
)

// isSpace reports whether r is whitespace as the specification fixes it:
// U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029,
// U+202F, U+205F, U+3000 and U+FEFF.
//
// It is spelled out instead of taken from the unicode package because the two
// differ (unicode.IsSpace has U+0085 and lacks U+FEFF), and a difference here
// changes which exports are accepted.
func isSpace(r rune) bool {
	switch {
	case r >= 0x0009 && r <= 0x000D, r == 0x0020, r == 0x00A0, r == 0x1680,
		r >= 0x2000 && r <= 0x200A, r == 0x2028, r == 0x2029, r == 0x202F,
		r == 0x205F, r == 0x3000, r == 0xFEFF:
		return true
	}
	return false
}

// trim removes the specification's whitespace from both ends.
func trim(s string) string {
	return strings.TrimFunc(s, isSpace)
}

// lowerASCII folds A–Z to a–z and nothing else. Names are compared "ignoring
// case" in every language's SDK, and full Unicode case folding is not the
// same function in any two of them.
func lowerASCII(s string) string {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if c := b[j]; c >= 'A' && c <= 'Z' {
					b[j] = c + ('a' - 'A')
				}
			}
			return string(b)
		}
	}
	return s
}

// utf16Len is the length of s in UTF-16 code units, the unit in which the
// reference implementation measures text. A byte that is not UTF-8 counts as
// one.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16Units(r)
	}
	return n
}

func utf16Units(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// isHex64 reports whether s is a SHA-256 value as the protocol writes one: 64
// lowercase hexadecimal characters.
func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// hasControl reports whether s contains a code point below U+0020 or U+007F.
func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c == 0x7F {
			return true
		}
	}
	return false
}

// firstRune returns the first code point of a non-empty string.
func firstRune(s string) rune {
	r, _ := utf8.DecodeRuneInString(s)
	return r
}

// appendHex appends src in lowercase hexadecimal.
func appendHex(dst, src []byte) []byte {
	n := len(dst)
	dst = slices.Grow(dst, hex.EncodedLen(len(src)))[:n+hex.EncodedLen(len(src))]
	hex.Encode(dst[n:], src)
	return dst
}
