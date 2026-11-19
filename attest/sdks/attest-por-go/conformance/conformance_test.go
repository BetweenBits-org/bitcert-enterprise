package conformance

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// vectorsDir is where the vectors are: POR_VECTORS when set, otherwise the
// fixtures of the repository this SDK is developed in.
func vectorsDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("POR_VECTORS")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "fixtures", "por")
	}
	if _, err := os.Stat(filepath.Join(dir, "jcs.json")); err != nil {
		t.Fatalf("the conformance vectors were not found in %s; set POR_VECTORS to the directory that holds SPEC.md and its vector files", dir)
	}
	return dir
}

func TestEveryVectorPasses(t *testing.T) {
	groups, err := Run(vectorsDir(t))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"jcs", "amounts", "leaves", "trees", "statement", "intake", "snapshot-dir"}
	if len(groups) != len(want) {
		t.Fatalf("%d groups ran, want %d", len(groups), len(want))
	}
	for i, g := range groups {
		if g.Name != want[i] {
			t.Errorf("group %d is %q, want %q", i, g.Name, want[i])
		}
		if g.Passed == 0 {
			t.Errorf("%s: no vector ran", g.Name)
		}
		for _, failure := range g.Failures {
			t.Errorf("%s: %s", g.Name, failure)
		}
		t.Log(g.Describe())
	}
}

func TestAMissingVectorFileIsAnError(t *testing.T) {
	if _, err := Run(t.TempDir()); err == nil {
		t.Fatal("an empty directory ran without an error")
	}
}

// A runner that cannot fail proves nothing. Each alteration below changes
// what one vector expects; the group it belongs to has to notice, and no
// other group may.
func TestAnAlteredVectorIsNoticed(t *testing.T) {
	vectors := vectorsDir(t)
	for _, c := range []struct {
		group, file, old, new string
	}{
		{"jcs", "jcs.json", `{\"a\":\"1\",\"b\":\"2\"`, `{\"b\":\"2\",\"a\":\"1\"`},
		{"jcs", "jcs.json", `"json": "{\"x\":1.5}"`, `"json": "{\"x\":15}"`},
		{"amounts", "amounts.json", `"base": "50000000"`, `"base": "50000001"`},
		{"amounts", "amounts.json", `"code": "amount_precision"`, `"code": "amount_format"`},
		{"amounts", "amounts.json", `"text": "-1"`, `"text": "1"`},
		{"leaves", "leaves.json", `"salt": "fcdae57f`, `"salt": "0cdae57f`},
		{"leaves", "leaves.json", `"leaf_hash": "a7246fc9`, `"leaf_hash": "07246fc9`},
		{"leaves", "leaves.json", `"user_ref_hash": "88542b15`, `"user_ref_hash": "08542b15`},
		{"trees", "trees.json", `"empty_node_hash": "13fc76d4`, `"empty_node_hash": "03fc76d4`},
		{"trees", "trees.json", `"root": "96ad89d0`, `"root": "06ad89d0`},
		{"trees", "trees.json", `"leaf_count": 33`, `"leaf_count": 34`},
		{"trees", "trees.json", `"dir": "left"`, `"dir": "right"`},
		{"statement", "statement.json", `"commitment": "bdfd821d`, `"commitment": "0dfd821d`},
		{"statement", "statement.json", `"sig": "qk-I`, `"sig": "Ak-I`},
		{"statement", "statement.json", `"public_spki_base64": "MFkw`, `"public_spki_base64": "MFkx`},
		{"intake", "intake.json", `"code": "duplicate_row"`, `"code": "duplicate_account"`},
		{"intake", "intake.json", `"line": 12`, `"line": 11`},
		{"intake", "intake.json", `"data_rows": 20`, `"data_rows": 21`},
		{"intake", "intake.json", `"zero_balance_accounts": 1`, `"zero_balance_accounts": 0`},
		{"intake", "intake.json", `"BTC": 6`, `"BTC": 7`},
		{"intake", "intake.json", `"updated_at"`, `"updated"`},
		{"intake", "intake.json", `"file_sha256": "51874c3b`, `"file_sha256": "01874c3b`},
		{"intake", "intake.json", `"USDT": "250000000000"`, `"USDT": "250000000001"`},
		{"intake", filepath.Join("intake", "long.csv"), "U-100002,BTC,0.00012345", "U-100002,BTC,0.00012346"},
		{"snapshot-dir", "snapshot-dir.expected.json", `"commitment": "4245836f`, `"commitment": "0245836f`},
		{"snapshot-dir", "snapshot-dir.expected.json", `"leaf_count": 12`, `"leaf_count": 13`},
		{"snapshot-dir", "snapshot-dir.proof-U-100008.json", `"dir": "left"`, `"dir": "right"`},
		{"snapshot-dir", "snapshot-dir.openings-0-3-7.json", `"USDT": "4200500000"`, `"USDT": "4200500001"`},
		{"snapshot-dir", filepath.Join("snapshot-dir", "leaves.jsonl"), `"BTC":"1"`, `"BTC":"2"`},
	} {
		altered := t.TempDir()
		copyTree(t, altered, vectors)
		path := filepath.Join(altered, c.file)
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		after := strings.Replace(string(before), c.old, c.new, 1)
		if after == string(before) {
			t.Fatalf("%s does not contain %s; the vectors changed and this test needs another alteration", c.file, c.old)
		}
		if err := os.WriteFile(path, []byte(after), 0o644); err != nil {
			t.Fatal(err)
		}
		groups, err := Run(altered)
		if err != nil {
			t.Fatal(err)
		}
		for _, g := range groups {
			if noticed := g.Failed > 0; noticed != (g.Name == c.group) {
				t.Errorf("%s: %s → %s: group %s has %d failures %v", c.file, c.old, c.new, g.Name, g.Failed, g.Failures)
			}
		}
	}
}

// copyTree copies a directory of files, so that a test can alter the copy.
func copyTree(t *testing.T, to, from string) {
	t.Helper()
	err := filepath.WalkDir(from, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(to, relative), 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(to, relative), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}
