package por

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"os"
	"strings"

	"stonehash.com/attest/por/internal/cjson"
)

// The statement says "these were our liabilities at this time"; the signature
// is what makes it the exchange's statement rather than anyone's. Signing is
// its own step, apart from sending, for two reasons that both come from how
// an exchange runs: the machine that holds the signing key is often not the
// machine allowed to open a connection to the internet, and before anything
// leaves the building somebody will want to read it. A Submission is what
// was signed and is byte for byte what is sent; there is no second payload
// assembled later from things the reviewer did not see.

// signatureAlg names ECDSA over P-256 with SHA-256.
const signatureAlg = "ES256"

const submissionSchema = "stonehash.por-submission.v1"

// signatureSize is r‖s: two 32-byte big-endian integers.
const signatureSize = 64

// Signer produces the exchange's signature.
//
// Sign receives the exact bytes to be signed and returns the ECDSA signature
// over their SHA-256 digest, on curve P-256, as 64 bytes: r then s, each 32
// bytes big-endian (the "raw" or IEEE P1363 form — not DER).
//
// This is the hook for a key that must not leave an HSM or a KMS: implement
// Sign with one call to the device. If the device's client is a
// crypto.Signer, as Go's PKCS #11 and cloud KMS clients usually are,
// CryptoSigner adapts it.
type Signer interface {
	Sign(message []byte) (signature []byte, err error)
}

// SignerFunc lets a function be a Signer.
type SignerFunc func(message []byte) ([]byte, error)

// Sign calls f.
func (f SignerFunc) Sign(message []byte) ([]byte, error) { return f(message) }

// CryptoSigner adapts a crypto.Signer holding a P-256 key. Such a signer is
// given the SHA-256 digest and answers in ASN.1 DER, which is converted to
// r‖s here.
func CryptoSigner(signer crypto.Signer) Signer {
	return SignerFunc(func(message []byte) ([]byte, error) {
		if pub, ok := signer.Public().(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() {
			return nil, errNotP256()
		}
		digest := sha256.Sum256(message)
		der, err := signer.Sign(rand.Reader, digest[:], crypto.SHA256)
		if err != nil {
			return nil, err
		}
		var sig struct{ R, S *big.Int }
		if rest, err := asn1.Unmarshal(der, &sig); err != nil || len(rest) != 0 {
			return nil, errorf(CodeInvalidSignature, "the signer did not return an ASN.1 ECDSA signature")
		}
		return rawSignature(sig.R, sig.S)
	})
}

// rawSignature writes r‖s, each left-padded to 32 bytes.
func rawSignature(r, s *big.Int) ([]byte, error) {
	if r == nil || s == nil || r.Sign() <= 0 || s.Sign() <= 0 || r.BitLen() > 256 || s.BitLen() > 256 {
		return nil, errorf(CodeInvalidSignature, "the signer returned values that are not a P-256 signature")
	}
	out := make([]byte, signatureSize)
	r.FillBytes(out[:signatureSize/2])
	s.FillBytes(out[signatureSize/2:])
	return out, nil
}

func errNotP256() *Error {
	return errorf(CodeInvalidKey, "the signing key must be an ECDSA P-256 key (ES256), the kind the platform registers")
}

// KeySigner is a Signer over a private key held in this process.
type KeySigner struct {
	key *ecdsa.PrivateKey
}

// NewKeySigner wraps an ECDSA P-256 private key.
func NewKeySigner(key *ecdsa.PrivateKey) (*KeySigner, error) {
	if key == nil || key.Curve != elliptic.P256() {
		return nil, errNotP256()
	}
	return &KeySigner{key: key}, nil
}

// ParsePrivateKeyPEM reads a private key in PEM form: PKCS #8
// ("BEGIN PRIVATE KEY"), or the SEC 1 form OpenSSL writes for an EC key
// ("BEGIN EC PRIVATE KEY"). An encrypted key is not read; decrypt it where
// it is kept, or use a Signer over the device that holds it.
func ParsePrivateKeyPEM(data []byte) (*KeySigner, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errorf(CodeInvalidKey, "the key is not in PEM form")
	}
	var parsed any
	var err error
	switch block.Type {
	case "PRIVATE KEY":
		parsed, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		parsed, err = x509.ParseECPrivateKey(block.Bytes)
	default:
		return nil, errorf(CodeInvalidKey, "the PEM block is a %s, not an unencrypted private key", quote(block.Type))
	}
	if err != nil {
		// The parser's message can quote key material; it is not passed on.
		return nil, errorf(CodeInvalidKey, "the PEM block does not hold a readable private key")
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errNotP256()
	}
	return NewKeySigner(key)
}

// LoadPrivateKeyFile reads a PEM private key from a file.
func LoadPrivateKeyFile(path string) (*KeySigner, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, wrap(CodeIO, err, "the signing key could not be read")
	}
	return ParsePrivateKeyPEM(data)
}

// Sign signs message with the key.
func (k *KeySigner) Sign(message []byte) ([]byte, error) {
	digest := sha256.Sum256(message)
	r, s, err := ecdsa.Sign(rand.Reader, k.key, digest[:])
	if err != nil {
		return nil, err
	}
	return rawSignature(r, s)
}

// PublicSPKI returns the key's public half as the platform registers it:
// SubjectPublicKeyInfo DER, base64.
func (k *KeySigner) PublicSPKI() string {
	// Marshalling a valid P-256 public key cannot fail.
	der, _ := x509.MarshalPKIXPublicKey(&k.key.PublicKey)
	return base64.StdEncoding.EncodeToString(der)
}

// Signature is the envelope a statement's signature travels in.
type Signature struct {
	// Alg is always "ES256".
	Alg string
	// KeyID is the exchange's institution id; it names the registered key the
	// platform checks against.
	KeyID string
	// Issuer is the exchange's name.
	Issuer string
	// Sig is the 64 bytes r‖s, base64url without padding.
	Sig string
}

// SignStatement signs a statement and returns the envelope.
//
// What is signed is "stonehash:remit:event:v1\n" followed by the statement's
// canonical JSON — the platform's published event signature.
func SignStatement(st *Statement, signer Signer) (*Signature, error) {
	if st == nil || signer == nil {
		return nil, errorf(CodeInvalidOption, "signing takes a statement and a signer")
	}
	raw, err := signer.Sign(st.signingInput())
	if err != nil {
		return nil, wrap(CodeSigner, err, "the statement could not be signed")
	}
	if len(raw) != signatureSize {
		return nil, errorf(CodeSigner, "the signer returned %d bytes; an ES256 signature is the %d bytes r||s, not DER", len(raw), signatureSize)
	}
	return &Signature{
		Alg:    signatureAlg,
		KeyID:  st.institutionID,
		Issuer: st.name,
		Sig:    base64.RawURLEncoding.EncodeToString(raw),
	}, nil
}

// VerifyStatementSignature checks a signature against a public key given as
// the platform registers it (SubjectPublicKeyInfo DER, base64). It returns
// nil only if the key signed exactly this statement.
//
// The platform runs the same check on arrival. Running it first, against the
// key the registry holds for the exchange, turns "the wrong key was used"
// from a rejected request into a message on the machine where it can be
// fixed.
func VerifyStatementSignature(st *Statement, sig *Signature, spkiBase64 string) error {
	if st == nil || sig == nil {
		return errorf(CodeInvalidSignature, "there is no statement or no signature to check")
	}
	if sig.Alg != signatureAlg {
		return errorf(CodeInvalidSignature, "the signature algorithm is %s, not %s", quote(sig.Alg), signatureAlg)
	}
	raw, ok := decodeSignature(sig.Sig)
	if !ok {
		return errorf(CodeInvalidSignature, "sig must be the %d bytes r||s in base64url without padding", signatureSize)
	}
	der, err := base64.StdEncoding.DecodeString(padBase64(spkiBase64))
	if err != nil {
		return errorf(CodeInvalidKey, "the public key is not base64")
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return errorf(CodeInvalidKey, "the public key is not a SubjectPublicKeyInfo")
	}
	pub, isECDSA := parsed.(*ecdsa.PublicKey)
	if !isECDSA || pub.Curve != elliptic.P256() {
		return errorf(CodeInvalidKey, "the public key is not an ECDSA P-256 key")
	}
	digest := sha256.Sum256(st.signingInput())
	r, s := new(big.Int).SetBytes(raw[:signatureSize/2]), new(big.Int).SetBytes(raw[signatureSize/2:])
	if !ecdsa.Verify(pub, digest[:], r, s) {
		return errorf(CodeInvalidSignature, "the signature does not verify over the statement with this key")
	}
	return nil
}

// decodeSignature reads r‖s from base64url without padding. The alphabet is
// checked first because the decoder would skip line breaks, and a signature
// the platform refuses must not pass here.
func decodeSignature(text string) ([]byte, bool) {
	for i := 0; i < len(text); i++ {
		c := text[i]
		if !(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-' && c != '_' {
			return nil, false
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(text)
	return raw, err == nil && len(raw) == signatureSize
}

// padBase64 restores the padding a registry may have trimmed, and drops line
// breaks a PEM-style wrapping may have left in.
func padBase64(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimRight(s, "=")
	return s + strings.Repeat("=", (4-len(s)%4)%4)
}

func (s *Signature) value() cjson.Object {
	return cjson.Object{
		{Key: "alg", Value: s.Alg},
		{Key: "key_id", Value: s.KeyID},
		{Key: "issuer", Value: s.Issuer},
		{Key: "sig", Value: s.Sig},
	}
}

// MarshalJSON writes the envelope.
func (s *Signature) MarshalJSON() ([]byte, error) {
	out, err := cjson.Compact(s.value())
	if err != nil {
		return nil, wrap(CodeInvalidSignature, err, "the signature cannot be written")
	}
	return out, nil
}

// UnmarshalJSON reads an envelope.
func (s *Signature) UnmarshalJSON(data []byte) error {
	r, err := parseDocument(data, CodeInvalidSignature, "sig.")
	if err != nil {
		return err
	}
	read, err := signatureFrom(r)
	if err != nil {
		return err
	}
	*s = *read
	return nil
}

func signatureFrom(r reader) (*Signature, *Error) {
	s := &Signature{}
	var err *Error
	if s.Alg, err = r.str("alg"); err != nil {
		return nil, err
	}
	if s.Alg != signatureAlg {
		return nil, errorf(r.code, "%salg must be %s", r.prefix, signatureAlg)
	}
	if s.KeyID, err = r.str("key_id"); err != nil {
		return nil, err
	}
	if s.Issuer, err = r.str("issuer"); err != nil {
		return nil, err
	}
	if s.Sig, err = r.str("sig"); err != nil {
		return nil, err
	}
	if _, ok := decodeSignature(s.Sig); !ok {
		return nil, errorf(r.code, "%ssig must be %d bytes in base64url without padding", r.prefix, signatureSize)
	}
	return s, nil
}

// Submission is the statement together with its signature: "the file that is
// sent". It holds no account and no balance.
type Submission struct {
	Statement *Statement
	Sig       *Signature
}

// NewSubmission signs a statement and returns it with its signature.
func NewSubmission(st *Statement, signer Signer) (*Submission, error) {
	sig, err := SignStatement(st, signer)
	if err != nil {
		return nil, err
	}
	return &Submission{Statement: st, Sig: sig}, nil
}

func (s *Submission) check() *Error {
	if s == nil || s.Statement == nil || s.Sig == nil {
		return errorf(CodeInvalidSubmission, "a submission is a statement and its signature")
	}
	return nil
}

func (s *Submission) value() cjson.Object {
	return cjson.Object{
		{Key: "schema", Value: submissionSchema},
		{Key: "statement", Value: s.Statement.doc},
		{Key: "sig", Value: s.Sig.value()},
	}
}

// MarshalJSON writes the submission on one line.
func (s *Submission) MarshalJSON() ([]byte, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	out, err := cjson.Compact(s.value())
	if err != nil {
		return nil, wrap(CodeInvalidSubmission, err, "the submission cannot be written")
	}
	return out, nil
}

// UnmarshalJSON reads and checks a submission.
func (s *Submission) UnmarshalJSON(data []byte) error {
	read, err := ParseSubmission(data)
	if err != nil {
		return err
	}
	*s = *read
	return nil
}

// ParseSubmission reads a submission from JSON and checks its shape: a
// statement of specification §6 and a 64-byte ES256 signature. Whether the
// signature verifies is VerifyStatementSignature's question.
func ParseSubmission(data []byte) (*Submission, error) {
	r, err := parseDocument(data, CodeInvalidSubmission, "")
	if err != nil {
		return nil, err
	}
	if schema, err := r.str("schema"); err != nil || schema != submissionSchema {
		return nil, errorf(CodeInvalidSubmission, "schema must be %s", submissionSchema)
	}
	statement, _ := r.obj.Get("statement")
	st, err := statementFrom(statement)
	if err != nil {
		return nil, err
	}
	sigDoc, err := r.object("sig")
	if err != nil {
		return nil, err
	}
	sig, err := signatureFrom(sigDoc)
	if err != nil {
		return nil, err
	}
	return &Submission{Statement: st, Sig: sig}, nil
}
