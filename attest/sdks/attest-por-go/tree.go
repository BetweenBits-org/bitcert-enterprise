package por

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"slices"
	"strconv"
)

// Tree is the Merkle sum tree over a ledger: the half of the protocol that
// runs inside the exchange.
//
// Every node carries a hash and a sum per asset, and each hash covers its
// children's sums, so the one root commits to the set of accounts and to the
// total of every asset at once. Leaves are ordered by their hashed reference,
// which makes the tree a function of the data alone: rebuilding from the same
// ledger and seed reproduces the same root, which is what turns "we can
// re-derive it for the auditor" from a promise into a property.
//
// Nothing a Tree hands out for the platform contains an account reference.
// A Tree is immutable once built and safe for concurrent use.
type Tree struct {
	exchangeID string
	assets     []string
	// members are the assets in canonical member order, each with the JSON
	// text that precedes its amount in a sums object.
	members []sumMember
	// leaves are in tree order: leaves[i] is the leaf at index i.
	leaves []leaf
	// levels[0] is the leaf level and the last level is the root alone.
	levels []level
}

// leaf is one account as the tree holds it. The balances are the ledger's own
// storage, taken over rather than copied.
type leaf struct {
	refHash hash
	salt    hash
	account
}

// level is one row of nodes. A padding node is never stored: it is implied
// after the last node of a level whose count is odd.
type level struct {
	// hashes is sha256.Size bytes per node.
	hashes []byte
	// sums is one amount per node and asset. It is nil at the leaf level,
	// where a node's sums are its leaf's balances.
	sums []big.Int
}

func (lv *level) count() int { return len(lv.hashes) / sha256.Size }

func (lv *level) hash(i int) []byte { return lv.hashes[i*sha256.Size : (i+1)*sha256.Size] }

// sumMember is one asset's place in the canonical JSON of a sums object.
type sumMember struct {
	asset int
	// lead is `{"SYMBOL":"` for the first member and `","SYMBOL":"` after it.
	lead []byte
}

// BuildTree derives each account's leaf and folds the ledger into a tree.
//
// exchangeID is the institution id the platform knows the exchange by; it is
// part of every hashed reference. seed is the snapshot's 32-byte secret (see
// NewSeed). The ledger's rows are not copied: the tree refers to the same
// balances the ledger holds.
func BuildTree(exchangeID string, seed []byte, ledger *Ledger) (*Tree, error) {
	if err := checkExchangeID(exchangeID); err != nil {
		return nil, err
	}
	if err := checkSeed(seed); err != nil {
		return nil, err
	}
	if ledger == nil || len(ledger.accounts) == 0 {
		return nil, errorf(CodeEmptyLedger, "there are no accounts; a snapshot of nothing is not evidence")
	}

	leaves := make([]leaf, len(ledger.accounts))
	mac := hmac.New(sha256.New, seed)
	text := append([]byte(userDomain+exchangeID), '\n')
	prefix := len(text)
	for i := range ledger.accounts {
		a := &ledger.accounts[i]
		text = append(text[:prefix], a.ref...)
		leaves[i].refHash = sha256.Sum256(text)
		mac.Reset()
		mac.Write(text[prefix:])
		mac.Sum(leaves[i].salt[:0])
		leaves[i].account = *a
	}
	tree, err := newTree(exchangeID, symbolsOf(ledger.assets), leaves)
	if err != nil {
		return nil, err
	}
	return tree, nil
}

// newTree orders the leaves and folds them. The leaves' balances must already
// be non-negative amounts of the listed assets, each asset at most once.
func newTree(exchangeID string, assets []string, leaves []leaf) (*Tree, *Error) {
	if len(leaves) == 0 {
		return nil, errorf(CodeEmptyLedger, "there are no leaves; a snapshot of nothing is not evidence")
	}
	if len(leaves) > maxLeafCount {
		return nil, errorf(CodeInvalidOption, "%d accounts is more than a statement can declare (%d)", len(leaves), maxLeafCount)
	}
	byHash := func(a, b leaf) int { return bytes.Compare(a.refHash[:], b.refHash[:]) }
	if !slices.IsSortedFunc(leaves, byHash) {
		slices.SortFunc(leaves, byHash)
	}
	for i := 1; i < len(leaves); i++ {
		if leaves[i].refHash == leaves[i-1].refHash {
			return nil, errorf(CodeDuplicateLeaf, "two leaves carry the hashed reference %s...; an account may appear once",
				hex.EncodeToString(leaves[i].refHash[:8]))
		}
	}

	t := &Tree{exchangeID: exchangeID, assets: slices.Clone(assets), leaves: leaves}
	order := make([]int, len(assets))
	for i := range order {
		order[i] = i
	}
	// Symbols are ASCII, for which byte order is the canonical member order.
	slices.SortFunc(order, func(a, b int) int { return bytes.Compare([]byte(assets[a]), []byte(assets[b])) })
	for k, asset := range order {
		lead := `{"`
		if k > 0 {
			lead = `","`
		}
		t.members = append(t.members, sumMember{asset: asset, lead: []byte(lead + assets[asset] + `":"`)})
	}
	t.fold()
	return t, nil
}

// fold computes every level from the leaves up.
func (t *Tree) fold() {
	width := len(t.assets)
	left, right := make([]*big.Int, width), make([]*big.Int, width)
	none := make([]*big.Int, width)
	for i := range none {
		none[i] = zero
	}
	msg := make([]byte, 0, 512)

	bottom := level{hashes: make([]byte, len(t.leaves)*sha256.Size)}
	for i := range t.leaves {
		t.leafSums(i, left)
		msg = append(msg[:0], leafDomain...)
		msg = append(msg, t.leaves[i].salt[:]...)
		msg = append(msg, t.leaves[i].refHash[:]...)
		msg = t.appendSums(msg, left)
		h := sha256.Sum256(msg)
		copy(bottom.hash(i), h[:])
	}
	t.levels = []level{bottom}

	var sum big.Int
	for depth := 0; t.levels[depth].count() > 1; depth++ {
		below := &t.levels[depth]
		parents := (below.count() + 1) / 2
		above := level{hashes: make([]byte, parents*sha256.Size), sums: make([]big.Int, parents*width)}
		for p := 0; p < parents; p++ {
			t.nodeSums(depth, 2*p, left)
			rightHash, rightSums := emptyNodeHash[:], none
			if 2*p+1 < below.count() {
				t.nodeSums(depth, 2*p+1, right)
				rightHash, rightSums = below.hash(2*p+1), right
			}
			msg = append(msg[:0], nodeDomain...)
			msg = append(msg, below.hash(2*p)...)
			msg = append(msg, rightHash...)
			msg = t.appendSums(msg, left)
			msg = t.appendSums(msg, rightSums)
			h := sha256.Sum256(msg)
			copy(above.hash(p), h[:])
			for a := 0; a < width; a++ {
				sum.Add(left[a], rightSums[a])
				setCompact(&above.sums[p*width+a], &sum)
			}
		}
		t.levels = append(t.levels, above)
	}
}

// leafSums points into[a] at leaf i's balance of each asset, or at zero.
func (t *Tree) leafSums(i int, into []*big.Int) {
	for a := range into {
		into[a] = zero
	}
	held := t.leaves[i].held
	for j := range held {
		into[held[j].asset] = &held[j].amount
	}
}

// nodeSums points into[a] at the sums of node i of a level.
func (t *Tree) nodeSums(depth, i int, into []*big.Int) {
	if depth == 0 {
		t.leafSums(i, into)
		return
	}
	sums := t.levels[depth].sums[i*len(into):]
	for a := range into {
		into[a] = &sums[a]
	}
}

// appendSums appends the canonical JSON of a sums object: every asset, in
// member order, each amount a decimal string. It writes the same bytes as the
// general canonical writer does for the same object, without building one for
// each of the two million nodes of a million-account tree.
func (t *Tree) appendSums(dst []byte, sums []*big.Int) []byte {
	for _, m := range t.members {
		dst = append(dst, m.lead...)
		if amount := sums[m.asset]; amount.IsUint64() {
			dst = strconv.AppendUint(dst, amount.Uint64(), 10)
		} else {
			dst = amount.Append(dst, 10)
		}
	}
	return append(dst, '"', '}')
}

// ExchangeID returns the institution id the leaves were hashed under.
func (t *Tree) ExchangeID() string { return t.exchangeID }

// Assets returns the asset symbols, in declared order.
func (t *Tree) Assets() []string { return slices.Clone(t.assets) }

// LeafCount returns the number of accounts. Padding is not counted.
func (t *Tree) LeafCount() int { return len(t.leaves) }

// Root returns the root hash, 64 lowercase hexadecimal characters.
func (t *Tree) Root() string {
	return hex.EncodeToString(t.levels[len(t.levels)-1].hash(0))
}

// Totals returns the sum of every asset over all accounts, in declared order.
func (t *Tree) Totals() Balances {
	return t.sums(len(t.levels)-1, 0)
}

// sums returns the sums of node i of a level as fresh amounts; the padding
// node's are zero.
func (t *Tree) sums(depth, i int) Balances {
	at := make([]*big.Int, len(t.assets))
	if i < t.levels[depth].count() {
		t.nodeSums(depth, i, at)
	} else {
		for a := range at {
			at[a] = zero
		}
	}
	out := make(Balances, len(t.assets))
	for a, symbol := range t.assets {
		out[a] = Balance{Asset: symbol, Amount: new(big.Int).Set(at[a])}
	}
	return out
}

// Proof returns the inclusion proof of the leaf at an index, as it is opened
// to the platform in a spot check: the hashed reference, the salt, the
// balances and the path — and no account reference.
func (t *Tree) Proof(index int) (*Proof, error) {
	if index < 0 || index >= len(t.leaves) {
		return nil, errorf(CodeIndexOutOfRange, "leaf index %d is outside the tree (0..%d)", index, len(t.leaves)-1)
	}
	lf := &t.leaves[index]
	p := &Proof{
		LeafIndex: index,
		Leaf: LeafOpening{
			UserRefHash: hex.EncodeToString(lf.refHash[:]),
			Salt:        hex.EncodeToString(lf.salt[:]),
			Balances:    t.sums(0, index),
		},
		Siblings: make([]Sibling, 0, len(t.levels)-1),
	}
	at := index
	for depth := 0; depth < len(t.levels)-1; depth++ {
		lv := &t.levels[depth]
		beside := at ^ 1
		sibling := Sibling{Sums: t.sums(depth, beside), Dir: Right}
		if beside < at {
			sibling.Dir = Left
		}
		if beside < lv.count() {
			sibling.Hash = hex.EncodeToString(lv.hash(beside))
		} else {
			sibling.Hash = EmptyNodeHash()
		}
		p.Siblings = append(p.Siblings, sibling)
		at /= 2
	}
	return p, nil
}

// ProofFor returns the inclusion proof of one account, for the customer the
// account belongs to. It is Proof with the customer's own reference added to
// the leaf, which is why it must go to that customer and nowhere else.
func (t *Tree) ProofFor(userRef string) (*Proof, error) {
	index, ok := t.IndexOf(userRef)
	if !ok {
		return nil, errorf(CodeUnknownAccount, "no leaf belongs to account %s", quote(userRef))
	}
	p, err := t.Proof(index)
	if err != nil {
		return nil, err
	}
	p.Leaf.UserRef = userRef
	return p, nil
}

// IndexOf returns the leaf index of an account.
//
// The leaves are ordered by hashed reference, so the account is found by
// hashing the reference and searching, with no index of references to keep.
func (t *Tree) IndexOf(userRef string) (int, bool) {
	want := userRefHash(t.exchangeID, userRef)
	i, found := slices.BinarySearchFunc(t.leaves, want, func(lf leaf, h hash) int { return bytes.Compare(lf.refHash[:], h[:]) })
	if !found || t.leaves[i].ref != userRef {
		return 0, false
	}
	return i, true
}

// UserRef returns the account reference of the leaf at an index. It is for
// the exchange's own use — issuing every customer's proof in turn — and must
// not travel with anything sent to the platform.
func (t *Tree) UserRef(index int) (string, error) {
	if index < 0 || index >= len(t.leaves) {
		return "", errorf(CodeIndexOutOfRange, "leaf index %d is outside the tree (0..%d)", index, len(t.leaves)-1)
	}
	return t.leaves[index].ref, nil
}

// LevelHashes returns every node hash, level by level from the leaves to the
// root. A level with an odd number of nodes, other than the root's, ends in
// the padding node's hash, as the reference implementation stores it.
//
// It exists to compare a tree with another implementation's; it allocates a
// string per node.
func (t *Tree) LevelHashes() [][]string {
	out := make([][]string, len(t.levels))
	for depth := range t.levels {
		lv := &t.levels[depth]
		hashes := make([]string, 0, lv.count()+1)
		for i := 0; i < lv.count(); i++ {
			hashes = append(hashes, hex.EncodeToString(lv.hash(i)))
		}
		if lv.count()%2 == 1 && depth < len(t.levels)-1 {
			hashes = append(hashes, EmptyNodeHash())
		}
		out[depth] = hashes
	}
	return out
}
