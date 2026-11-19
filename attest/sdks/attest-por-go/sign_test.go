package por

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newKey(t testing.TB) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func newSigner(t testing.TB) *KeySigner {
	t.Helper()
	signer, err := NewKeySigner(newKey(t))
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func pemOf(t testing.TB, blockType string, der []byte, err error) []byte {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
}

func spkiOf(t testing.TB, public any) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(der)
}

func TestSignAndVerifyStatement(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	signer := newSigner(t)
	sig, err := SignStatement(st, signer)
	if err != nil {
		t.Fatal(err)
	}
	if sig.Alg != "ES256" || sig.KeyID != testExchange || sig.Issuer != "Sample Exchange" || len(sig.Sig) != 86 || strings.ContainsAny(sig.Sig, "+/=") {
		t.Errorf("envelope: %+v", sig)
	}
	if err := VerifyStatementSignature(st, sig, signer.PublicSPKI()); err != nil {
		t.Fatalf("its own signature: %v", err)
	}
	// Signing again gives other bytes (a fresh nonce) that verify as well.
	again, _ := SignStatement(st, signer)
	if again.Sig == sig.Sig || VerifyStatementSignature(st, again, signer.PublicSPKI()) != nil {
		t.Error("a second signature should differ and verify")
	}

	// Another key, another statement, another signature: none verifies.
	wantCode(t, VerifyStatementSignature(st, sig, newSigner(t).PublicSPKI()), CodeInvalidSignature)
	other, _ := NewStatement(StatementConfig{Name: "Sample Exchange", AsOf: "2026-11-17T00:00:00Z", Assets: btcEthUsdt}, sampleTree(t), sampleBuiltAt)
	wantCode(t, VerifyStatementSignature(other, sig, signer.PublicSPKI()), CodeInvalidSignature)
	flipped := *sig
	flipped.Sig = swapFirst(sig.Sig)
	wantCode(t, VerifyStatementSignature(st, &flipped, signer.PublicSPKI()), CodeInvalidSignature)

	// The envelope is checked before the arithmetic.
	for name, alter := range map[string]func(*Signature){
		"another algorithm": func(s *Signature) { s.Alg = "ES384" },
		"an empty sig":      func(s *Signature) { s.Sig = "" },
		"a padded sig":      func(s *Signature) { s.Sig += "==" },
		"standard base64":   func(s *Signature) { s.Sig = strings.Repeat("+", 86) },
		"a line break":      func(s *Signature) { s.Sig = s.Sig[:40] + "\n" + s.Sig[40:] },
		"63 bytes":          func(s *Signature) { s.Sig = s.Sig[:84] },
		"65 bytes":          func(s *Signature) { s.Sig += "AA" },
		"DER, not r and s": func(s *Signature) {
			der, _ := ecdsa.SignASN1(rand.Reader, newKey(t), make([]byte, 32))
			s.Sig = base64.RawURLEncoding.EncodeToString(der)
		},
	} {
		altered := *sig
		alter(&altered)
		if err := VerifyStatementSignature(st, &altered, signer.PublicSPKI()); codeOf(t, err) != CodeInvalidSignature {
			t.Errorf("%s: %v", name, err)
		}
	}
	wantCode(t, VerifyStatementSignature(nil, sig, signer.PublicSPKI()), CodeInvalidSignature)
	wantCode(t, VerifyStatementSignature(st, nil, signer.PublicSPKI()), CodeInvalidSignature)
}

func swapFirst(s string) string {
	if s[0] == 'A' {
		return "B" + s[1:]
	}
	return "A" + s[1:]
}

func TestVerifyStatementSignatureChecksTheKey(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	signer := newSigner(t)
	sig, _ := SignStatement(st, signer)
	spki := signer.PublicSPKI()

	// A registry may trim the padding or wrap the lines.
	for name, form := range map[string]string{
		"without padding": strings.TrimRight(spki, "="),
		"wrapped":         spki[:40] + "\r\n" + spki[40:] + "\n",
	} {
		if err := VerifyStatementSignature(st, sig, form); err != nil {
			t.Errorf("the key %s: %v", name, err)
		}
	}
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	rsaKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	edPublic, _, _ := ed25519.GenerateKey(rand.Reader)
	for name, key := range map[string]string{
		"nothing":         "",
		"not base64":      "!!!",
		"not a key":       base64.StdEncoding.EncodeToString([]byte("hello")),
		"a P-384 key":     spkiOf(t, &p384.PublicKey),
		"an RSA key":      spkiOf(t, &rsaKey.PublicKey),
		"an Ed25519 key":  spkiOf(t, edPublic),
		"a key cut short": spki[:len(spki)-8],
		"a private key":   base64.StdEncoding.EncodeToString(mustPKCS8(t, newKey(t))),
		"url-safe base64": base64.URLEncoding.EncodeToString(mustDecode(t, spki)) + "-_",
	} {
		if err := VerifyStatementSignature(st, sig, key); codeOf(t, err) != CodeInvalidKey {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func mustPKCS8(t testing.TB, key any) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func mustDecode(t testing.TB, text string) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// hsm stands in for a key that never leaves a device: it is a crypto.Signer,
// which is what Go's PKCS #11 and cloud KMS clients are.
type hsm struct {
	key   *ecdsa.PrivateKey
	calls int
	fail  error
}

func (h *hsm) Public() crypto.PublicKey { return &h.key.PublicKey }

func (h *hsm) Sign(_ io.Reader, digest []byte, opts crypto.SignerOpts) ([]byte, error) {
	h.calls++
	if h.fail != nil {
		return nil, h.fail
	}
	if opts.HashFunc() != crypto.SHA256 || len(digest) != 32 {
		return nil, errors.New("the device was not given a SHA-256 digest")
	}
	return ecdsa.SignASN1(rand.Reader, h.key, digest)
}

func TestSignerHookForAnHSM(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))

	device := &hsm{key: newKey(t)}
	sig, err := SignStatement(st, CryptoSigner(device))
	if err != nil || device.calls != 1 {
		t.Fatalf("signing through a crypto.Signer: %v, %d calls", err, device.calls)
	}
	if err := VerifyStatementSignature(st, sig, spkiOf(t, device.Public())); err != nil {
		t.Fatalf("a signature made by the device: %v", err)
	}

	// The same, written out: a function from the bytes to sign to r and s.
	key := newKey(t)
	var signed []byte
	byHand := SignerFunc(func(message []byte) ([]byte, error) {
		signed = message
		return (&KeySigner{key: key}).Sign(message)
	})
	sig, err = SignStatement(st, byHand)
	if err != nil || VerifyStatementSignature(st, sig, spkiOf(t, &key.PublicKey)) != nil {
		t.Fatalf("signing through a function: %v", err)
	}
	if want := "stonehash:remit:event:v1\n" + string(st.Canonical()); string(signed) != want {
		t.Errorf("the signer was given\n %q\nwant\n %q", signed, want)
	}

	broken := errors.New("the device is locked")
	device.fail = broken
	_, err = SignStatement(st, CryptoSigner(device))
	if wantCode(t, err, CodeSigner); !errors.Is(err, broken) {
		t.Errorf("the device's own error is lost: %v", err)
	}
	for name, signer := range map[string]Signer{
		"DER where r and s belong": SignerFunc(func(m []byte) ([]byte, error) { return ecdsa.SignASN1(rand.Reader, key, make([]byte, 32)) }),
		"nothing":                  SignerFunc(func([]byte) ([]byte, error) { return nil, nil }),
		"65 bytes":                 SignerFunc(func([]byte) ([]byte, error) { return make([]byte, 65), nil }),
	} {
		if _, err := SignStatement(st, signer); codeOf(t, err) != CodeSigner {
			t.Errorf("a signer returning %s: %v", name, err)
		}
	}
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	_, err = SignStatement(st, CryptoSigner(&hsm{key: p384}))
	wantCode(t, err, CodeSigner)
	rsaKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	_, err = SignStatement(st, CryptoSigner(rsaKey))
	wantCode(t, err, CodeSigner)
	_, err = SignStatement(st, CryptoSigner(&garbageSigner{device}))
	wantCode(t, err, CodeSigner)
	_, err = SignStatement(nil, byHand)
	wantCode(t, err, CodeInvalidOption)
	_, err = SignStatement(st, nil)
	wantCode(t, err, CodeInvalidOption)
}

// garbageSigner answers with bytes that are not a signature.
type garbageSigner struct{ *hsm }

func (garbageSigner) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return []byte("not asn.1"), nil
}

func TestPrivateKeyFromPEM(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	key := newKey(t)
	sec1, err := x509.MarshalECPrivateKey(key)
	for name, text := range map[string][]byte{
		"PKCS #8":             pemOf(t, "PRIVATE KEY", mustPKCS8(t, key), nil),
		"SEC 1":               pemOf(t, "EC PRIVATE KEY", sec1, err),
		"text before the key": append([]byte("# signing key\n"), pemOf(t, "PRIVATE KEY", mustPKCS8(t, key), nil)...),
	} {
		signer, err := ParsePrivateKeyPEM(text)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		sig, err := SignStatement(st, signer)
		if err != nil || signer.PublicSPKI() != spkiOf(t, &key.PublicKey) || VerifyStatementSignature(st, sig, signer.PublicSPKI()) != nil {
			t.Errorf("%s: the key read is not the key written (%v)", name, err)
		}
	}

	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	rsaKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	_, edKey, _ := ed25519.GenerateKey(rand.Reader)
	secret := mustPKCS8(t, key)
	for name, text := range map[string][]byte{
		"not PEM":            []byte("not a key"),
		"an empty file":      nil,
		"a public key":       pemOf(t, "PUBLIC KEY", mustDecode(t, spkiOf(t, &key.PublicKey)), nil),
		"an encrypted key":   pemOf(t, "ENCRYPTED PRIVATE KEY", secret, nil),
		"a damaged key":      pemOf(t, "PRIVATE KEY", secret[:len(secret)-9], nil),
		"SEC 1 under PKCS 8": pemOf(t, "PRIVATE KEY", sec1, nil),
		"a P-384 key":        pemOf(t, "PRIVATE KEY", mustPKCS8(t, p384), nil),
		"an RSA key":         pemOf(t, "PRIVATE KEY", mustPKCS8(t, rsaKey), nil),
		"an Ed25519 key":     pemOf(t, "PRIVATE KEY", mustPKCS8(t, edKey), nil),
	} {
		signer, err := ParsePrivateKeyPEM(text)
		if codeOf(t, err) != CodeInvalidKey || signer != nil {
			t.Errorf("%s: %v, %v", name, signer, err)
			continue
		}
		// Whatever was wrong with it, the message does not quote the file.
		body := base64.StdEncoding.EncodeToString(secret)
		if strings.Contains(err.Error(), body[:16]) || strings.Contains(err.Error(), body[len(body)-16:]) {
			t.Errorf("%s: the error quotes key material: %v", name, err)
		}
	}
	if _, err := NewKeySigner(nil); codeOf(t, err) != CodeInvalidKey {
		t.Errorf("no key: %v", err)
	}
	if _, err := NewKeySigner(p384); codeOf(t, err) != CodeInvalidKey {
		t.Errorf("a P-384 key: %v", err)
	}

	path := filepath.Join(t.TempDir(), "signing-key.pem")
	if err := os.WriteFile(path, pemOf(t, "PRIVATE KEY", secret, nil), 0o600); err != nil {
		t.Fatal(err)
	}
	if signer, err := LoadPrivateKeyFile(path); err != nil || signer.PublicSPKI() != spkiOf(t, &key.PublicKey) {
		t.Errorf("from a file: %v", err)
	}
	_, err = LoadPrivateKeyFile(path + ".missing")
	wantCode(t, err, CodeIO)
}

func TestSubmissionIsTheStatementAndItsSignature(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	signer := newSigner(t)
	sub, err := NewSubmission(st, signer)
	if err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(sub)
	if err != nil {
		t.Fatal(err)
	}
	statement, _ := st.MarshalJSON()
	want := `{"schema":"stonehash.por-submission.v1","statement":` + string(statement) +
		`,"sig":{"alg":"ES256","key_id":"KR-EX-0a1b2c","issuer":"Sample Exchange","sig":"` + sub.Sig.Sig + `"}}`
	if string(text) != want {
		t.Errorf("the submission reads\n %s\nwant\n %s", text, want)
	}
	back, err := ParseSubmission(text)
	if err != nil || back.Statement.Commitment() != sampleCommitment || *back.Sig != *sub.Sig {
		t.Fatalf("read back: %+v, %v", back, err)
	}
	if err := VerifyStatementSignature(back.Statement, back.Sig, signer.PublicSPKI()); err != nil {
		t.Errorf("read back, the signature: %v", err)
	}

	alter := func(old, new string) string {
		if !strings.Contains(string(text), old) {
			t.Fatalf("the submission has no %q", old)
		}
		return strings.Replace(string(text), old, new, 1)
	}
	for name, c := range map[string]struct{ text, code string }{
		"not JSON":             {`{`, CodeInvalidSubmission},
		"another schema":       {alter(`por-submission.v1`, `por-submission.v9`), CodeInvalidSubmission},
		"no schema":            {alter(`"schema":"stonehash.por-submission.v1",`, ``), CodeInvalidSubmission},
		"no statement":         {alter(`"statement":`, `"claim":`), CodeInvalidStatement},
		"an invalid statement": {alter(`"leaf_count":12`, `"leaf_count":0`), CodeInvalidStatement},
		"no signature":         {alter(`,"sig":{"alg"`, `,"signature":{"alg"`), CodeInvalidSubmission},
		"another algorithm":    {alter(`"alg":"ES256"`, `"alg":"RS256"`), CodeInvalidSubmission},
		"a short signature":    {alter(sub.Sig.Sig, sub.Sig.Sig[:80]), CodeInvalidSubmission},
		"no key id":            {alter(`"key_id":"KR-EX-0a1b2c",`, ``), CodeInvalidSubmission},
	} {
		got, err := ParseSubmission([]byte(c.text))
		if codeOf(t, err) != c.code {
			t.Errorf("%s: read as %v, %v; want %s", name, got, err, c.code)
		}
	}
	var viaJSON Submission
	if err := json.Unmarshal(text, &viaJSON); err != nil || viaJSON.Statement.Root() != sampleRoot {
		t.Errorf("through encoding/json: %v", err)
	}
	if _, err := json.Marshal(&Submission{Statement: st}); err == nil {
		t.Error("a submission without a signature was written")
	}
	_, err = NewSubmission(st, SignerFunc(func([]byte) ([]byte, error) { return nil, errors.New("no") }))
	wantCode(t, err, CodeSigner)
}
