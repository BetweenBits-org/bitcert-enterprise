package por

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"unicode/utf8"
)

// Domain tags of specification §4 and §5. The empty node's has no line break.
const (
	userDomain  = "STONEHASH-POR-USER-V1\n"
	leafDomain  = "STONEHASH-POR-LEAF-V1\n"
	nodeDomain  = "STONEHASH-POR-NODE-V1\n"
	emptyDomain = "STONEHASH-POR-EMPTY-V1"
)

// SeedSize is the length in bytes of a snapshot's seed.
const SeedSize = 32

type hash = [sha256.Size]byte

// emptyNodeHash pads a level with an odd number of nodes. Padding, not
// duplication: repeating the last node, as Bitcoin does, would count its
// balance twice in the parent's sum.
var emptyNodeHash = sha256.Sum256([]byte(emptyDomain))

// EmptyNodeHash returns the hash of the node that pads an odd level.
func EmptyNodeHash() string {
	return hex.EncodeToString(emptyNodeHash[:])
}

// NewSeed draws the seed of a new snapshot from the system's random source.
//
// One seed per snapshot, kept by the exchange and by nobody else: every
// account's salt is derived from it, so losing it (together with the leaves
// file) ends the ability to issue proofs for that snapshot, and disclosing it
// lets anyone who knows an account reference test guesses at its balances.
func NewSeed() ([]byte, error) {
	seed := make([]byte, SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, wrap(CodeIO, err, "the system's random source could not be read")
	}
	return seed, nil
}

func checkSeed(seed []byte) *Error {
	if len(seed) != SeedSize {
		return errorf(CodeInvalidOption, "the seed must be %d bytes, not %d", SeedSize, len(seed))
	}
	return nil
}

// checkExchangeID refuses an exchange id that could not stand in the hashed
// text. It is followed there by a line break and the account reference, so
// one containing a line break could pass for a different exchange's accounts.
func checkExchangeID(id string) *Error {
	if id == "" || !utf8.ValidString(id) || hasControl(id) {
		return errorf(CodeInvalidOption, "the exchange id %s must be non-empty UTF-8 text without control characters", quote(id))
	}
	return nil
}

// UserRefHash is the pseudonymous form of an account reference:
//
//	SHA256("STONEHASH-POR-USER-V1\n" + exchangeID + "\n" + userRef)
//
// It is deterministic, so a customer who knows their own reference can
// recompute it and recognise their leaf; the reference itself never appears
// in the tree.
func UserRefHash(exchangeID, userRef string) string {
	h := userRefHash(exchangeID, userRef)
	return hex.EncodeToString(h[:])
}

func userRefHash(exchangeID, userRef string) hash {
	text := make([]byte, 0, len(userDomain)+len(exchangeID)+1+len(userRef))
	text = append(text, userDomain...)
	text = append(text, exchangeID...)
	text = append(text, '\n')
	text = append(text, userRef...)
	return sha256.Sum256(text)
}

// DeriveSalt is the per-account salt, HMAC-SHA256(seed, userRef). It blinds
// the balances inside the leaf hash. Because it is derived rather than
// random, the exchange keeps one 32-byte seed per snapshot, not one secret
// per account.
func DeriveSalt(seed []byte, userRef string) (string, error) {
	if err := checkSeed(seed); err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(userRef))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// LeafHash is the hash of one leaf:
//
//	SHA256("STONEHASH-POR-LEAF-V1\n" ‖ salt ‖ userRefHash ‖ JCS(balances))
//
// salt and userRefHash are 64 lowercase hexadecimal characters. balances is
// hashed as given: in a tree it carries every asset of the snapshot, with
// zero for those the account does not hold.
func LeafHash(salt, userRefHash string, balances Balances) (string, error) {
	saltBytes, err := decodeHash(salt, "salt")
	if err != nil {
		return "", err
	}
	refHash, err := decodeHash(userRefHash, "user_ref_hash")
	if err != nil {
		return "", err
	}
	if err := balances.check("balances"); err != nil {
		return "", err
	}
	canonical, err := balances.canonical()
	if err != nil {
		return "", err
	}
	h := leafHash(saltBytes, refHash, canonical)
	return hex.EncodeToString(h[:]), nil
}

func leafHash(salt, refHash hash, canonicalBalances []byte) hash {
	msg := make([]byte, 0, len(leafDomain)+2*sha256.Size+len(canonicalBalances))
	msg = append(msg, leafDomain...)
	msg = append(msg, salt[:]...)
	msg = append(msg, refHash[:]...)
	msg = append(msg, canonicalBalances...)
	return sha256.Sum256(msg)
}

// decodeHash reads 64 lowercase hexadecimal characters. Upper case is
// refused: the same bytes would otherwise have two spellings, and the
// documents that carry them are compared as text.
func decodeHash(s, what string) (hash, *Error) {
	var h hash
	if !isHex64(s) {
		return h, errorf(CodeInvalidProof, "%s must be 64 lowercase hexadecimal characters", what)
	}
	hex.Decode(h[:], []byte(s))
	return h, nil
}
