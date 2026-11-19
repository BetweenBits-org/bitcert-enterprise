package por

import (
	"encoding/json"
	"math/big"
	"reflect"
	"strings"
	"testing"
)

// cloneProof copies a proof deeply, so that a test can alter the copy.
func cloneProof(t *testing.T, p *Proof) *Proof {
	t.Helper()
	text, err := p.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	copied, err := ParseProof(text)
	if err != nil {
		t.Fatal(err)
	}
	return copied
}

func TestVerifyProofRefusesEveryAlteration(t *testing.T) {
	tree := sampleTree(t)
	root, totals := tree.Root(), tree.Totals()
	flip := func(hex string) string {
		if hex[0] == 'f' {
			return "0" + hex[1:]
		}
		return "f" + hex[1:]
	}
	for index := 0; index < tree.LeafCount(); index++ {
		base, err := tree.Proof(index)
		if err != nil || VerifyProof(base, root, totals) != nil {
			t.Fatalf("leaf %d: the untouched proof does not hold", index)
		}
		alterations := map[string]func(p *Proof){
			"a balance raised":       func(p *Proof) { p.Leaf.Balances[0].Amount.Add(p.Leaf.Balances[0].Amount, big.NewInt(1)) },
			"a balance negative":     func(p *Proof) { p.Leaf.Balances[2].Amount.SetInt64(-1) },
			"a balance dropped":      func(p *Proof) { p.Leaf.Balances = p.Leaf.Balances[1:] },
			"a balance added":        func(p *Proof) { p.Leaf.Balances = append(p.Leaf.Balances, Balance{"DOGE", big.NewInt(0)}) },
			"a balance listed twice": func(p *Proof) { p.Leaf.Balances = append(p.Leaf.Balances, p.Leaf.Balances[0]) },
			"the salt":               func(p *Proof) { p.Leaf.Salt = flip(p.Leaf.Salt) },
			"the salt in upper case": func(p *Proof) { p.Leaf.Salt = strings.ToUpper(p.Leaf.Salt) },
			"the hashed reference":   func(p *Proof) { p.Leaf.UserRefHash = flip(p.Leaf.UserRefHash) },
			"the index":              func(p *Proof) { p.LeafIndex ^= 1 },
			"a negative index":       func(p *Proof) { p.LeafIndex = -1 },
			"a sibling hash":         func(p *Proof) { p.Siblings[1].Hash = flip(p.Siblings[1].Hash) },
			"a sibling hash cut":     func(p *Proof) { p.Siblings[0].Hash = p.Siblings[0].Hash[:63] },
			"a sibling sum":          func(p *Proof) { p.Siblings[2].Sums[1].Amount.Add(p.Siblings[2].Sums[1].Amount, big.NewInt(1)) },
			"a sibling sum negative": func(p *Proof) { p.Siblings[0].Sums[0].Amount.SetInt64(-5) },
			"a sibling sum missing":  func(p *Proof) { p.Siblings[0].Sums[0].Amount = nil },
			"a direction flipped": func(p *Proof) {
				if p.Siblings[1].Dir == Left {
					p.Siblings[1].Dir = Right
				} else {
					p.Siblings[1].Dir = Left
				}
			},
			"a direction unknown": func(p *Proof) { p.Siblings[0].Dir = "up" },
			"a sibling dropped":   func(p *Proof) { p.Siblings = p.Siblings[:len(p.Siblings)-1] },
			"a sibling repeated":  func(p *Proof) { p.Siblings = append(p.Siblings, p.Siblings[len(p.Siblings)-1]) },
			"siblings swapped":    func(p *Proof) { p.Siblings[0], p.Siblings[1] = p.Siblings[1], p.Siblings[0] },
		}
		for name, alter := range alterations {
			p := cloneProof(t, base)
			alter(p)
			if err := VerifyProof(p, root, totals); codeOf(t, err) != CodeInvalidProof {
				t.Errorf("leaf %d, %s: %v", index, name, err)
			}
		}
		// The proof is against this root and these totals, not others.
		other := tree.Totals()
		other[1].Amount.Add(other[1].Amount, big.NewInt(1))
		for name, err := range map[string]error{
			"another root":     VerifyProof(base, flip(root), totals),
			"an empty root":    VerifyProof(base, "", totals),
			"totals raised":    VerifyProof(base, root, other),
			"a total dropped":  VerifyProof(base, root, totals[:2]),
			"a total added":    VerifyProof(base, root, append(tree.Totals(), Balance{"DOGE", big.NewInt(1)})),
			"a total negative": VerifyProof(base, root, Balances{{"BTC", big.NewInt(-1)}}),
			"no proof":         VerifyProof(nil, root, totals),
		} {
			if codeOf(t, err) != CodeInvalidProof {
				t.Errorf("leaf %d, %s: %v", index, name, err)
			}
		}
	}
}

// Specification §5 checks the index bit by bit against the siblings, one bit
// per level. Bits above the last level have no sibling to be checked against,
// so they are not: the verification is the specification's, no stricter. A
// statement's leaf_count is what bounds an index.
func TestVerifyProofChecksTheIndexAsFarAsThePathGoes(t *testing.T) {
	tree := sampleTree(t)
	p, _ := tree.Proof(5)
	for bit := 0; bit < len(p.Siblings); bit++ {
		altered := cloneProof(t, p)
		altered.LeafIndex ^= 1 << bit
		if err := VerifyProof(altered, tree.Root(), tree.Totals()); codeOf(t, err) != CodeInvalidProof {
			t.Errorf("bit %d of the index flipped: %v", bit, err)
		}
	}
	beyond := cloneProof(t, p)
	beyond.LeafIndex += 1 << len(p.Siblings)
	if err := VerifyProof(beyond, tree.Root(), tree.Totals()); err != nil {
		t.Errorf("a bit above the path: %v", err)
	}
}

// An asset missing on either side counts as zero, and the order assets are
// listed in does not matter: both are how specification §5 compares.
func TestVerifyProofComparesTotalsByAsset(t *testing.T) {
	tree := sampleTree(t)
	p, _ := tree.Proof(4)
	totals := tree.Totals()
	reordered := Balances{totals[2], totals[0], totals[1]}
	if err := VerifyProof(p, tree.Root(), reordered); err != nil {
		t.Errorf("totals in another order: %v", err)
	}
	withZero := append(tree.Totals(), Balance{"DOGE", big.NewInt(0)})
	if err := VerifyProof(p, tree.Root(), withZero); err != nil {
		t.Errorf("a zero total for an asset the tree does not list: %v", err)
	}
}

func TestProofJSONRoundTripAndLayout(t *testing.T) {
	tree := sampleTree(t)
	opening, _ := tree.Proof(3)
	text, err := json.Marshal(opening)
	if err != nil {
		t.Fatal(err)
	}
	// Laid out as specification §5 has it; no account reference in an opening.
	if !strings.HasPrefix(string(text), `{"leaf_index":3,"leaf":{"user_ref_hash":"695ea9f1`) || strings.Contains(string(text), "user_ref\"") {
		t.Errorf("an opening reads %s", text)
	}
	var back Proof
	if err := json.Unmarshal(text, &back); err != nil || !reflect.DeepEqual(&back, opening) {
		t.Errorf("round trip: %v\n got  %+v\n want %+v", err, back, opening)
	}
	own, _ := tree.ProofFor("U-100008")
	text, _ = json.Marshal(own)
	if !strings.HasPrefix(string(text), `{"leaf_index":3,"leaf":{"user_ref":"U-100008","user_ref_hash":"695ea9f1`) {
		t.Errorf("a customer's proof reads %s", text)
	}
	if got := cloneProof(t, own); got.Leaf.UserRef != "U-100008" || VerifyProof(got, tree.Root(), tree.Totals()) != nil {
		t.Errorf("a customer's proof read back: %+v", got)
	}
	// Balances keep their order through encoding/json as well.
	text, _ = json.Marshal(struct{ Totals Balances }{Balances{{"USDT", big.NewInt(1)}, {"BTC", big.NewInt(2)}}})
	if string(text) != `{"Totals":{"USDT":"1","BTC":"2"}}` {
		t.Errorf("balances inside a caller's struct: %s", text)
	}
}

func TestParseProofChecksTheShape(t *testing.T) {
	tree := sampleTree(t)
	p, _ := tree.Proof(0)
	good, _ := p.MarshalJSON()
	if _, err := ParseProof(good); err != nil {
		t.Fatal(err)
	}
	h := strings.Repeat("a", 64)
	sibling := `{"hash":"` + h + `","sums":{"BTC":"1"},"dir":"left"}`
	leaf := `{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":"1"}}`
	for name, text := range map[string]string{
		"not JSON":                       `{"leaf_index":`,
		"an array":                       `[]`,
		"no index":                       `{"leaf":` + leaf + `,"siblings":[]}`,
		"an index that is a string":      `{"leaf_index":"0","leaf":` + leaf + `,"siblings":[]}`,
		"an index with a fraction":       `{"leaf_index":0.0,"leaf":` + leaf + `,"siblings":[]}`,
		"a negative index":               `{"leaf_index":-1,"leaf":` + leaf + `,"siblings":[]}`,
		"an index beyond any tree":       `{"leaf_index":2147483647,"leaf":` + leaf + `,"siblings":[]}`,
		"no leaf":                        `{"leaf_index":0,"siblings":[]}`,
		"no siblings":                    `{"leaf_index":0,"leaf":` + leaf + `}`,
		"a balance that is a number":     `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":1}},"siblings":[]}`,
		"a balance with leading zero":    `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":"007"}},"siblings":[]}`,
		"a negative balance":             `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":"-1"}},"siblings":[]}`,
		"a balance with a sign":          `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":"+1"}},"siblings":[]}`,
		"an empty balance":               `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{"BTC":""}},"siblings":[]}`,
		"balances that are an array":     `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + h + `","balances":[]},"siblings":[]}`,
		"a salt in upper case":           `{"leaf_index":0,"leaf":{"user_ref_hash":"` + h + `","salt":"` + strings.ToUpper(h) + `","balances":{}},"siblings":[]}`,
		"a short hash":                   `{"leaf_index":0,"leaf":{"user_ref_hash":"abc","salt":"` + h + `","balances":{}},"siblings":[]}`,
		"a reference that is a number":   `{"leaf_index":0,"leaf":{"user_ref":7,"user_ref_hash":"` + h + `","salt":"` + h + `","balances":{}},"siblings":[]}`,
		"a sibling that is a string":     `{"leaf_index":0,"leaf":` + leaf + `,"siblings":["x"]}`,
		"a direction that is neither":    `{"leaf_index":0,"leaf":` + leaf + `,"siblings":[` + strings.Replace(sibling, "left", "up", 1) + `]}`,
		"a sibling sum that is a number": `{"leaf_index":0,"leaf":` + leaf + `,"siblings":[` + strings.Replace(sibling, `"1"`, `1`, 1) + `]}`,
		"a member twice":                 `{"leaf_index":0,"leaf_index":1,"leaf":` + leaf + `,"siblings":[]}`,
	} {
		if p, err := ParseProof([]byte(text)); codeOf(t, err) != CodeInvalidProof {
			t.Errorf("%s: read as %+v, %v", name, p, err)
		}
	}
	// Members this version does not know are passed over.
	if _, err := ParseProof([]byte(`{"leaf_index":0,"note":1.5,"leaf":` + leaf + `,"siblings":[` + sibling + `]}`)); err != nil {
		t.Errorf("an unknown member: %v", err)
	}
}

func TestBalancesJSON(t *testing.T) {
	var b Balances
	if err := json.Unmarshal([]byte(`{"USDT":"10","BTC":"0","ETH":"340282366920938463463374607431768211456"}`), &b); err != nil {
		t.Fatal(err)
	}
	if totalsOf(b) != "USDT=10 BTC=0 ETH=340282366920938463463374607431768211456" || b.Amount("BTC").Sign() != 0 || b.Amount("DOGE") != nil {
		t.Errorf("read as %s", totalsOf(b))
	}
	for _, text := range []string{`{"BTC":1}`, `{"BTC":"1.0"}`, `{"BTC":"1e3"}`, `{"BTC":" 1"}`, `{"BTC":"00"}`, `{"BTC":null}`, `["BTC"]`, `"1"`, `{"BTC":"1","BTC":"1"}`} {
		var b Balances
		if err := json.Unmarshal([]byte(text), &b); err == nil {
			t.Errorf("%s: read as %s", text, totalsOf(b))
		}
	}
	for name, bad := range map[string]Balances{
		"a negative amount": {{"BTC", big.NewInt(-1)}},
		"no amount":         {{"BTC", nil}},
		"an asset twice":    {{"BTC", big.NewInt(1)}, {"BTC", big.NewInt(2)}},
	} {
		if text, err := json.Marshal(bad); err == nil {
			t.Errorf("%s: written as %s", name, text)
		}
	}
	if text, err := json.Marshal(Balances{}); err != nil || string(text) != "{}" {
		t.Errorf("no balances: %s, %v", text, err)
	}
}
