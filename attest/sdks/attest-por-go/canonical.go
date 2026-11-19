package por

import "stonehash.com/attest/por/internal/cjson"

// CanonicalJSON returns the canonical form of a JSON document: the subset of
// RFC 8785 the protocol hashes and signs (specification §1). Members are
// sorted by name, compared as UTF-16 code units; nothing is escaped that need
// not be; there is no whitespace.
//
// It is an error, not something to format, when the document holds a number
// with a fraction or an exponent, or an integer beyond ±(2^53 − 1): amounts
// travel as decimal strings precisely so that no implementation has to agree
// with another about how a number is printed. A document that is not strict
// JSON — a repeated member name, bytes that are not UTF-8, half of a
// surrogate pair — is refused as well.
func CanonicalJSON(doc []byte) ([]byte, error) {
	v, err := cjson.Parse(doc)
	if err != nil {
		return nil, wrap(CodeInvalidJSON, err, "the document")
	}
	out, err := cjson.Canonical(v)
	if err != nil {
		return nil, wrap(CodeNotCanonical, err, "the document")
	}
	return out, nil
}
