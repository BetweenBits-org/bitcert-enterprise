package por

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"stonehash.com/attest/por/internal/cjson"
)

// Direction says on which side of the path a sibling sits.
type Direction string

const (
	Left  Direction = "left"
	Right Direction = "right"
)

// Proof shows that one leaf is in a tree: the leaf, and the sibling met at
// each level on the way up to the root. Because every sibling carries its
// sums and every hash covers them, the same proof shows that the tree's
// totals include the leaf's balances.
type Proof struct {
	LeafIndex int
	Leaf      LeafOpening
	Siblings  []Sibling
}

// LeafOpening is what a leaf was hashed from.
type LeafOpening struct {
	// UserRef is the account's own reference. It is set only in the proof an
	// exchange hands the customer it belongs to (Tree.ProofFor); openings
	// given to the platform never carry it.
	UserRef     string
	UserRefHash string
	Salt        string
	// Balances has every asset of the snapshot, zero where the account holds
	// none.
	Balances Balances
}

// Sibling is the node beside the path at one level. Dir is the side the
// sibling is on.
type Sibling struct {
	Hash string
	Sums Balances
	Dir  Direction
}

// VerifyProof checks an inclusion proof against a root and totals taken from
// a snapshot statement. It returns nil only if the path leads to exactly
// that root and the sums along it add up to exactly those totals.
//
// The totals comparison is not a nicety: the sums that arrive at the root are
// recomputed from the leaf and the siblings, so they equal the declared
// liabilities only if every sibling's sums were honest inputs to every hash
// on the path. The index is checked against the sibling directions as well,
// so a valid proof cannot be passed off as evidence for another position.
func VerifyProof(p *Proof, root string, totals Balances) error {
	if p == nil {
		return errorf(CodeInvalidProof, "there is no proof")
	}
	if p.LeafIndex < 0 {
		return errorf(CodeInvalidProof, "leaf_index %d is negative", p.LeafIndex)
	}
	salt, err := decodeHash(p.Leaf.Salt, "leaf.salt")
	if err != nil {
		return err
	}
	refHash, err := decodeHash(p.Leaf.UserRefHash, "leaf.user_ref_hash")
	if err != nil {
		return err
	}
	if err := checkProofBalances(p.Leaf.Balances, "leaf.balances"); err != nil {
		return err
	}
	if err := checkProofBalances(totals, "totals"); err != nil {
		return err
	}
	canonical, err := p.Leaf.Balances.canonical()
	if err != nil {
		return err
	}

	node, sums := leafHash(salt, refHash, canonical), p.Leaf.Balances
	var problems []string
	for level, sib := range p.Siblings {
		where := fmt.Sprintf("siblings[%d]", level)
		sibHash, err := decodeHash(sib.Hash, where+".hash")
		if err != nil {
			return err
		}
		if err := checkProofBalances(sib.Sums, where+".sums"); err != nil {
			return err
		}
		if sib.Dir != Left && sib.Dir != Right {
			return errorf(CodeInvalidProof, "%s.dir must be %q or %q", where, Left, Right)
		}
		// Bit k of the index says which child the path was at level k; a
		// sibling on the left means the path was the right child.
		pathIsRight := p.LeafIndex>>level&1 == 1
		if (sib.Dir == Left) != pathIsRight {
			problems = append(problems, fmt.Sprintf("%s.dir contradicts leaf_index %d", where, p.LeafIndex))
		}
		sibCanonical, err := sib.Sums.canonical()
		if err != nil {
			return err
		}
		nodeCanonical, err := sums.canonical()
		if err != nil {
			return err
		}
		if sib.Dir == Left {
			node, sums = nodeHash(sibHash, node, sibCanonical, nodeCanonical), addBalances(sib.Sums, sums)
		} else {
			node, sums = nodeHash(node, sibHash, nodeCanonical, sibCanonical), addBalances(sums, sib.Sums)
		}
	}

	if computed := hex.EncodeToString(node[:]); computed != root {
		problems = append(problems, fmt.Sprintf("the path leads to root %s..., not the declared %s...", computed[:16], leadingRunes(root, 16)))
	}
	if !equalAmounts(sums, totals) {
		problems = append(problems, fmt.Sprintf("the sums along the path are %s, not the declared totals %s", describe(sums), describe(totals)))
	}
	if len(problems) > 0 {
		return errorf(CodeInvalidProof, "%s", strings.Join(problems, "; "))
	}
	return nil
}

func checkProofBalances(b Balances, where string) *Error {
	if err := b.check(where); err != nil {
		return errorf(CodeInvalidProof, "%s", err.Message)
	}
	return nil
}

// nodeHash is the hash of an inner node:
// SHA256("STONEHASH-POR-NODE-V1\n" ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums)).
func nodeHash(left, right hash, leftSums, rightSums []byte) hash {
	msg := make([]byte, 0, len(nodeDomain)+2*sha256.Size+len(leftSums)+len(rightSums))
	msg = append(msg, nodeDomain...)
	msg = append(msg, left[:]...)
	msg = append(msg, right[:]...)
	msg = append(msg, leftSums...)
	msg = append(msg, rightSums...)
	return sha256.Sum256(msg)
}

// addBalances adds two sets of sums asset by asset, over every asset either
// side lists. The result shares no amount with its inputs.
func addBalances(a, b Balances) Balances {
	out := make(Balances, 0, len(a))
	for _, e := range a {
		sum := new(big.Int).Set(e.Amount)
		if other := b.Amount(e.Asset); other != nil {
			sum.Add(sum, other)
		}
		out = append(out, Balance{Asset: e.Asset, Amount: sum})
	}
	for _, e := range b {
		if a.Amount(e.Asset) == nil {
			out = append(out, Balance{Asset: e.Asset, Amount: new(big.Int).Set(e.Amount)})
		}
	}
	return out
}

func describe(b Balances) string {
	text, err := cjson.Compact(b.value())
	if err != nil {
		return "(unprintable)"
	}
	return string(text)
}

// value is the proof as a JSON document, laid out as the reference lays it
// out. user_ref appears only when the proof carries one.
func (p *Proof) value() cjson.Object {
	leaf := make(cjson.Object, 0, 4)
	if p.Leaf.UserRef != "" {
		leaf = append(leaf, cjson.Member{Key: "user_ref", Value: p.Leaf.UserRef})
	}
	leaf = append(leaf,
		cjson.Member{Key: "user_ref_hash", Value: p.Leaf.UserRefHash},
		cjson.Member{Key: "salt", Value: p.Leaf.Salt},
		cjson.Member{Key: "balances", Value: p.Leaf.Balances.value()},
	)
	siblings := make([]any, len(p.Siblings))
	for i, s := range p.Siblings {
		siblings[i] = cjson.Object{
			{Key: "hash", Value: s.Hash},
			{Key: "sums", Value: s.Sums.value()},
			{Key: "dir", Value: string(s.Dir)},
		}
	}
	return cjson.Object{
		{Key: "leaf_index", Value: int64(p.LeafIndex)},
		{Key: "leaf", Value: leaf},
		{Key: "siblings", Value: siblings},
	}
}

// pseudonymous returns the proof as it may be shown to anyone but the
// account's owner: without the account reference.
func (p *Proof) pseudonymous() *Proof {
	opened := *p
	opened.Leaf.UserRef = ""
	return &opened
}

// check refuses a proof that could not be written as a document.
func (p *Proof) check() *Error {
	if p == nil {
		return errorf(CodeInvalidProof, "there is no proof")
	}
	if err := checkProofBalances(p.Leaf.Balances, "leaf.balances"); err != nil {
		return err
	}
	for i, s := range p.Siblings {
		if err := checkProofBalances(s.Sums, fmt.Sprintf("siblings[%d].sums", i)); err != nil {
			return err
		}
	}
	return nil
}

// MarshalJSON writes the proof as specification §5 lays it out.
func (p *Proof) MarshalJSON() ([]byte, error) {
	if err := p.check(); err != nil {
		return nil, err
	}
	out, err := cjson.Compact(p.value())
	if err != nil {
		return nil, wrap(CodeInvalidProof, err, "the proof cannot be written")
	}
	return out, nil
}

// UnmarshalJSON reads a proof, refusing one that is not of the shape of
// specification §5.
func (p *Proof) UnmarshalJSON(data []byte) error {
	read, err := ParseProof(data)
	if err != nil {
		return err
	}
	*p = *read
	return nil
}

// ParseProof reads an inclusion proof from JSON. It checks the shape only —
// that hashes are hashes and amounts are non-negative integers written as
// strings; whether the proof holds is VerifyProof's question.
func ParseProof(data []byte) (*Proof, error) {
	r, err := parseDocument(data, CodeInvalidProof, "")
	if err != nil {
		return nil, err
	}
	p, err := proofFrom(r)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// maxLeafCount is the most leaves a statement can declare (specification §6).
const maxLeafCount = 1<<31 - 1

func proofFrom(r reader) (*Proof, *Error) {
	index, err := r.integer("leaf_index")
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= maxLeafCount {
		return nil, errorf(r.code, "%sleaf_index %d is outside 0..%d", r.prefix, index, maxLeafCount-1)
	}
	leaf, err := r.object("leaf")
	if err != nil {
		return nil, err
	}
	p := &Proof{LeafIndex: int(index)}
	if p.Leaf.UserRef, err = leaf.optStr("user_ref"); err != nil {
		return nil, err
	}
	if p.Leaf.UserRefHash, err = leaf.hash("user_ref_hash"); err != nil {
		return nil, err
	}
	if p.Leaf.Salt, err = leaf.hash("salt"); err != nil {
		return nil, err
	}
	if p.Leaf.Balances, err = leaf.balances("balances"); err != nil {
		return nil, err
	}
	siblings, err := r.array("siblings")
	if err != nil {
		return nil, err
	}
	p.Siblings = make([]Sibling, len(siblings))
	for i, item := range siblings {
		s, err := r.item("siblings", i, item)
		if err != nil {
			return nil, err
		}
		if p.Siblings[i].Hash, err = s.hash("hash"); err != nil {
			return nil, err
		}
		if p.Siblings[i].Sums, err = s.balances("sums"); err != nil {
			return nil, err
		}
		dir, err := s.str("dir")
		if err != nil {
			return nil, err
		}
		if dir != string(Left) && dir != string(Right) {
			return nil, errorf(r.code, "%sdir must be %q or %q", s.prefix, Left, Right)
		}
		p.Siblings[i].Dir = Direction(dir)
	}
	return p, nil
}
