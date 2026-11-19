package por

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"stonehash.com/attest/por/internal/cjson"
)

// writeSample writes the sample snapshot into a new directory.
func writeSample(t *testing.T) (dir string, tree *Tree, st *Statement) {
	t.Helper()
	tree = sampleTree(t)
	st = sampleStatement(t, tree)
	dir = filepath.Join(t.TempDir(), "snapshot")
	if err := WriteSnapshotDir(dir, st, tree, testSeed(t)); err != nil {
		t.Fatal(err)
	}
	return dir, tree, st
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func modeOf(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestSnapshotDirIsWrittenAndReadBack(t *testing.T) {
	// Whatever the umask says, the private files are private.
	dir, tree, st := writeSample(t)
	for file, mode := range map[string]fs.FileMode{LeavesFile: 0o600, SeedFile: 0o600, TreeFile: 0o600, StatementFile: 0o644, "": 0o700} {
		if got := modeOf(t, filepath.Join(dir, file)); got != mode {
			t.Errorf("%q has mode %o, want %o", file, got, mode)
		}
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if want := []string{LeavesFile, SeedFile, StatementFile, TreeFile}; !slices.Equal(names, want) {
		t.Errorf("the directory holds %v, want %v and nothing left over", names, want)
	}
	if got := readFile(t, filepath.Join(dir, SeedFile)); got != hex.EncodeToString(testSeed(t))+"\n" {
		t.Errorf("seed.hex holds %q", got)
	}
	// The statement names no account; the leaves file names them all.
	if strings.Contains(readFile(t, filepath.Join(dir, StatementFile)), "U-1000") || strings.Contains(readFile(t, filepath.Join(dir, TreeFile)), "U-1000") {
		t.Error("an account reference outside the leaves file")
	}

	loaded, err := LoadSnapshotDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Tree.Root() != tree.Root() || loaded.Tree.LeafCount() != 12 || loaded.Tree.ExchangeID() != testExchange ||
		totalsOf(loaded.Tree.Totals()) != totalsOf(tree.Totals()) || loaded.Statement.Commitment() != st.Commitment() {
		t.Fatalf("read back: root %s, commitment %s", loaded.Tree.Root(), loaded.Statement.Commitment())
	}
	for i := 0; i < tree.LeafCount(); i++ {
		ref, _ := tree.UserRef(i)
		want, _ := tree.ProofFor(ref)
		got, err := loaded.Tree.ProofFor(ref)
		if err != nil {
			t.Fatal(err)
		}
		wantText, _ := want.MarshalJSON()
		if gotText, _ := got.MarshalJSON(); string(gotText) != string(wantText) {
			t.Fatalf("the proof for %q from the loaded tree differs:\n got  %s\n want %s", ref, gotText, wantText)
		}
	}
}

// The files are laid out as the reference lays them out: for the sample
// ledger they are the reference's own, byte for byte.
func TestSnapshotDirIsByteForByteTheReferences(t *testing.T) {
	vectors := vectorsDir(t)
	dir, tree, st := writeSample(t)
	for _, file := range []string{StatementFile, TreeFile, SeedFile, LeavesFile} {
		if got, want := readFile(t, filepath.Join(dir, file)), readFile(t, filepath.Join(vectors, "snapshot-dir", file)); got != want {
			t.Errorf("%s differs from the reference's:\n got  %s\n want %s", file, got, want)
		}
	}
	proof, err := tree.ProofFor("U-100008")
	if err != nil {
		t.Fatal(err)
	}
	file, err := MarshalProofFile(st, proof)
	if want := readFile(t, filepath.Join(vectors, "snapshot-dir.proof-U-100008.json")); err != nil || string(file) != want {
		t.Errorf("the proof file differs from the reference's (%v):\n got  %s\n want %s", err, file, want)
	}
	var openings []*Proof
	for _, i := range []int{0, 3, 7} {
		p, _ := tree.Proof(i)
		openings = append(openings, p)
	}
	text, err := MarshalOpenings(openings)
	if want := readFile(t, filepath.Join(vectors, "snapshot-dir.openings-0-3-7.json")); err != nil || string(text) != want {
		t.Errorf("the openings differ from the reference's (%v):\n got  %s\n want %s", err, text, want)
	}

	// And the reference's directory, read by this SDK, is the same snapshot.
	loaded, err := LoadSnapshotDir(filepath.Join(vectors, "snapshot-dir"))
	if err != nil || loaded.Tree.Root() != sampleRoot || loaded.Statement.Commitment() != sampleCommitment {
		t.Fatalf("the reference's directory: %v", err)
	}
}

// fixChecksum makes tree.json agree with leaves.jsonl again, as someone who
// edited the leaves and wanted the edit to pass would.
func fixChecksum(t *testing.T, dir string) {
	t.Helper()
	sum := sha256.Sum256([]byte(readFile(t, filepath.Join(dir, LeavesFile))))
	header := readFile(t, filepath.Join(dir, TreeFile))
	fixed := regexp.MustCompile(`"leaves_sha256": "[0-9a-f]{64}"`).ReplaceAllString(header, `"leaves_sha256": "`+hex.EncodeToString(sum[:])+`"`)
	if fixed == header && !strings.Contains(header, hex.EncodeToString(sum[:])) {
		t.Fatal("tree.json has no checksum to fix")
	}
	if err := os.WriteFile(filepath.Join(dir, TreeFile), []byte(fixed), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSnapshotDirRefusesWhatIsNotWhole(t *testing.T) {
	edit := func(file string, change func(string) string) func(*testing.T, string) {
		return func(t *testing.T, dir string) {
			path := filepath.Join(dir, file)
			before := readFile(t, path)
			after := change(before)
			if after == before {
				t.Fatalf("the edit of %s changed nothing", file)
			}
			if err := os.WriteFile(path, []byte(after), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	replace := func(file, old, new string) func(*testing.T, string) {
		return edit(file, func(s string) string { return strings.Replace(s, old, new, 1) })
	}
	remove := func(file string) func(*testing.T, string) {
		return func(t *testing.T, dir string) {
			if err := os.Remove(filepath.Join(dir, file)); err != nil {
				t.Fatal(err)
			}
		}
	}
	dropLine := edit(LeavesFile, func(s string) string { return s[strings.Index(s, "\n")+1:] })
	doubleLine := edit(LeavesFile, func(s string) string { return s[:strings.Index(s, "\n")+1] + s })
	otherStatement := func(t *testing.T, dir string) {
		b := newBuilder(t)
		b.Add("someone-else", "BTC", "1")
		ledger, _ := b.Finish()
		tree, err := BuildTree(testExchange, testSeed(t), ledger)
		if err != nil {
			t.Fatal(err)
		}
		text, _ := sampleStatement(t, tree).MarshalJSON()
		if err := os.WriteFile(filepath.Join(dir, StatementFile), text, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	for _, c := range []struct {
		name    string
		damage  func(*testing.T, string)
		refix   bool // tree.json's checksum is made to match again
		code    string
		mention string
	}{
		{"a balance edited", replace(LeavesFile, `"2112345678"`, `"2112345679"`), false, CodeLeavesChecksum, "not the file this snapshot was built from"},
		{"a balance edited and the checksum with it", replace(LeavesFile, `"2112345678"`, `"2112345679"`), true, CodeRootMismatch, "do not reproduce"},
		{"a leaf removed", dropLine, true, CodeRootMismatch, "do not reproduce"},
		{"a leaf twice", doubleLine, true, CodeDuplicateLeaf, "once"},
		{"a salt edited", edit(LeavesFile, func(s string) string { return strings.Replace(s, `"salt":"2c2b`, `"salt":"0000`, 1) }), true, CodeRootMismatch, ""},
		{"a reference edited", replace(LeavesFile, `"user_ref":"U-100008"`, `"user_ref":"U-100009x"`), true, CodeSnapshotDamaged, "line 4: user_ref_hash is not the hash of user_ref"},
		{"a truncated line", edit(LeavesFile, func(s string) string { return s[:len(s)-40] }), false, CodeLeavesChecksum, ""},
		{"a truncated line and the checksum with it", edit(LeavesFile, func(s string) string { return s[:len(s)-40] }), true, CodeSnapshotDamaged, "line 12"},
		{"a balance that is a number", replace(LeavesFile, `"BTC":"1000000"`, `"BTC":1000000`), true, CodeSnapshotDamaged, "line 1: balances.BTC"},
		{"a balance in an asset that is not listed", replace(LeavesFile, `"BTC":"1000000"`, `"DOGE":"1000000"`), true, CodeSnapshotDamaged, "does not list"},
		{"a line that is not an object", edit(LeavesFile, func(s string) string { return "[]\n" + s }), true, CodeSnapshotDamaged, "line 1: not a JSON object"},
		{"no leaves file", remove(LeavesFile), false, CodeSnapshotDamaged, "missing"},
		{"an empty leaves file", edit(LeavesFile, func(string) string { return "" }), true, CodeEmptyLedger, ""},
		{"no header", remove(TreeFile), false, CodeSnapshotDamaged, "not a snapshot directory"},
		{"a header that is not JSON", edit(TreeFile, func(s string) string { return s[:len(s)-3] }), false, CodeSnapshotDamaged, TreeFile},
		{"the first version's header", replace(TreeFile, "por-tree.v2", "por-tree.v1"), false, CodeSnapshotDamaged, "this version reads"},
		{"a header pointing elsewhere", replace(TreeFile, `"leaves_file": "leaves.jsonl"`, `"leaves_file": "../../etc/passwd"`), false, CodeSnapshotDamaged, "leaves_file"},
		{"a header with another root", replace(TreeFile, sampleRoot, strings.Repeat("0", 64)), false, CodeRootMismatch, ""},
		{"a header with another total", replace(TreeFile, `"BTC": "2463358024"`, `"BTC": "2463358025"`), false, CodeRootMismatch, ""},
		{"a header with another leaf count", replace(TreeFile, `"leaf_count": 12`, `"leaf_count": 13`), false, CodeRootMismatch, ""},
		{"a header for another exchange", replace(TreeFile, testExchange, "KR-EX-other"), false, CodeSnapshotDamaged, "user_ref_hash is not the hash"},
		{"a header with an asset that is not a symbol", replace(TreeFile, `"BTC",`, `"B TC",`), false, CodeSnapshotDamaged, "assets"},
		{"no statement", remove(StatementFile), false, CodeIO, ""},
		{"a statement that is not one", replace(StatementFile, "por-snapshot.v1", "por-snapshot.v0"), false, CodeInvalidStatement, "schema"},
		{"another snapshot's statement", otherStatement, false, CodeTreeMismatch, "does not belong to the leaves beside it"},
	} {
		dir, _, _ := writeSample(t)
		c.damage(t, dir)
		if c.refix {
			fixChecksum(t, dir)
		}
		loaded, err := LoadSnapshotDir(dir)
		if loaded != nil || codeOf(t, err) != c.code {
			t.Errorf("%s: loaded %v with %v; want %s", c.name, loaded, err, c.code)
			continue
		}
		if !strings.Contains(err.Error(), c.mention) {
			t.Errorf("%s: the message does not mention %q: %v", c.name, c.mention, err)
		}
	}
	_, err := LoadSnapshotDir(filepath.Join(t.TempDir(), "nowhere"))
	wantCode(t, err, CodeSnapshotDamaged)
}

// What another writer may do differently and still mean the same snapshot.
func TestLoadSnapshotDirReadsWhatAnotherWriterMayWrite(t *testing.T) {
	rewrite := func(t *testing.T, change func(lines []string) string) *Snapshot {
		t.Helper()
		dir, _, _ := writeSample(t)
		path := filepath.Join(dir, LeavesFile)
		lines := strings.Split(strings.TrimSuffix(readFile(t, path), "\n"), "\n")
		if err := os.WriteFile(path, []byte(change(lines)), 0o600); err != nil {
			t.Fatal(err)
		}
		fixChecksum(t, dir)
		loaded, err := LoadSnapshotDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		return loaded
	}
	for name, change := range map[string]func([]string) string{
		"leaves in another order": func(lines []string) string { slices.Reverse(lines); return strings.Join(lines, "\n") + "\n" },
		"blank lines":             func(lines []string) string { return "\n" + strings.Join(lines, "\n\n") + "\n\n" },
		"no final line break":     func(lines []string) string { return strings.Join(lines, "\n") },
		"CRLF line endings":       func(lines []string) string { return strings.Join(lines, "\r\n") + "\r\n" },
		"zero balances written out": func(lines []string) string {
			return strings.Replace(strings.Join(lines, "\n")+"\n", `"balances":{}`, `"balances":{"USDT":"0","BTC":"0"}`, 1)
		},
		"members in another order, with one more": func(lines []string) string {
			return strings.Replace(strings.Join(lines, "\n")+"\n", `{"user_ref":"U-100006",`, `{"note":[1.5],"user_ref": "U-100006" ,`, 1)
		},
	} {
		loaded := rewrite(t, change)
		if loaded.Tree.Root() != sampleRoot {
			t.Errorf("%s: root %s", name, loaded.Tree.Root())
		}
		if at, ok := loaded.Tree.IndexOf("U-100008"); !ok || at != 3 {
			t.Errorf("%s: U-100008 is at %d (%v)", name, at, ok)
		}
	}
}

// What the README says about the files to keep: the leaves file is enough to
// issue proofs, and the seed with the same ledger is enough to write the
// leaves file again.
func TestWhatCanBeLostAndWhatCannot(t *testing.T) {
	dir, tree, st := writeSample(t)
	leaves := readFile(t, filepath.Join(dir, LeavesFile))
	seed := readFile(t, filepath.Join(dir, SeedFile))

	if err := os.Remove(filepath.Join(dir, SeedFile)); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSnapshotDir(dir)
	if err != nil {
		t.Fatalf("without seed.hex: %v", err)
	}
	if p, err := loaded.Tree.ProofFor("U-100001"); err != nil || VerifyProof(p, st.Root(), st.Totals()) != nil {
		t.Errorf("a proof issued without seed.hex: %v", err)
	}

	// The leaves file lost, the seed and the ledger kept: the same file again.
	kept, err := ParseSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	rebuilt, err := BuildTree(testExchange, kept, sampleLedger(t))
	if err != nil || rebuilt.Root() != tree.Root() {
		t.Fatalf("rebuilt from the ledger and the seed: %v", err)
	}
	var again bytes.Buffer
	if err := rebuilt.writeLeaves(&again); err != nil || again.String() != leaves {
		t.Errorf("the leaves file written again differs (%v)", err)
	}
	// With another seed the ledger alone does not lead back to the root.
	other, _ := NewSeed()
	if stranger, _ := BuildTree(testExchange, other, sampleLedger(t)); stranger.Root() == tree.Root() {
		t.Error("the root does not depend on the seed")
	}
}

func TestWriteSnapshotDirDoesNotReplaceAnotherSeed(t *testing.T) {
	dir, tree, st := writeSample(t)
	before := readFile(t, filepath.Join(dir, LeavesFile))
	// The same snapshot again is the same files.
	if err := WriteSnapshotDir(dir, st, tree, testSeed(t)); err != nil {
		t.Fatalf("writing the same snapshot again: %v", err)
	}
	// Another build of the same ledger draws another seed: the directory is taken.
	otherSeed, _ := NewSeed()
	otherTree, _ := BuildTree(testExchange, otherSeed, sampleLedger(t))
	err := WriteSnapshotDir(dir, sampleStatement(t, otherTree), otherTree, otherSeed)
	wantCode(t, err, CodeSnapshotExists)
	if readFile(t, filepath.Join(dir, LeavesFile)) != before || readFile(t, filepath.Join(dir, SeedFile)) != hex.EncodeToString(testSeed(t))+"\n" {
		t.Fatal("the refused write changed the directory")
	}
	if loaded, err := LoadSnapshotDir(dir); err != nil || loaded.Tree.Root() != sampleRoot {
		t.Fatalf("the earlier snapshot no longer loads: %v", err)
	}
	// A seed file that cannot be made sense of is not overwritten either.
	if err := os.WriteFile(filepath.Join(dir, SeedFile), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantCode(t, WriteSnapshotDir(dir, st, tree, testSeed(t)), CodeSnapshotExists)
}

func TestWriteSnapshotDirChecksWhatItIsGiven(t *testing.T) {
	tree := sampleTree(t)
	st := sampleStatement(t, tree)
	dir := filepath.Join(t.TempDir(), "s")
	wantCode(t, WriteSnapshotDir(dir, nil, tree, testSeed(t)), CodeInvalidOption)
	wantCode(t, WriteSnapshotDir(dir, st, nil, testSeed(t)), CodeInvalidOption)
	wantCode(t, WriteSnapshotDir(dir, st, tree, testSeed(t)[:16]), CodeInvalidOption)
	wrongSeed := testSeed(t)
	wrongSeed[0] ^= 0xff
	wantCode(t, WriteSnapshotDir(dir, st, tree, wrongSeed), CodeTreeMismatch)
	otherSeed, _ := NewSeed()
	otherTree, _ := BuildTree(testExchange, otherSeed, sampleLedger(t))
	wantCode(t, WriteSnapshotDir(dir, st, otherTree, otherSeed), CodeTreeMismatch)
	if _, err := os.Stat(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("a refused write left a directory behind: %v", err)
	}
	// A place that cannot be written is an error, not a panic or a partial directory.
	blocker := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocker, nil, 0o600)
	wantCode(t, WriteSnapshotDir(filepath.Join(blocker, "s"), st, tree, testSeed(t)), CodeIO)
}

// The leaves file is assembled by hand, a line per account. Each line has to
// be what the general writer produces for the same object.
func TestLeavesFileIsWrittenAsTheGeneralWriterWould(t *testing.T) {
	rng := rand.New(rand.NewSource(49979687))
	assets := []string{"USDT", "BTC", "ETH", "a.b-c_d"}
	rows := randomRows(rng, 60, assets)
	for i, ref := range []string{`say "hi"`, `back\slash`, "한글 계정", "😀", "a/b", "tab-free <>&", "é", "\U0001F600\U00002028x"} {
		rows[i].ref = ref
	}
	tree, err := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, assets, rows))
	if err != nil {
		t.Fatal(err)
	}
	var written bytes.Buffer
	if err := tree.writeLeaves(&written); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(written.String(), "\n"), "\n")
	if len(lines) != tree.LeafCount() {
		t.Fatalf("%d lines for %d leaves", len(lines), tree.LeafCount())
	}
	held := map[string]map[string]*big.Int{}
	for _, row := range rows {
		held[row.ref] = row.balances
	}
	for i, line := range lines {
		ref, _ := tree.UserRef(i)
		p, _ := tree.Proof(i)
		balances := cjson.Object{}
		// Zero balances are left out; the others keep the order the ledger gave them.
		for _, a := range assets {
			if v, ok := held[ref][a]; ok && v.Sign() != 0 {
				balances = append(balances, cjson.Member{Key: a, Value: v.String()})
			}
		}
		want, err := cjson.Compact(cjson.Object{
			{Key: "user_ref", Value: ref}, {Key: "user_ref_hash", Value: p.Leaf.UserRefHash},
			{Key: "salt", Value: p.Leaf.Salt}, {Key: "balances", Value: balances},
		})
		if err != nil || line != string(want) {
			t.Fatalf("line %d (%v):\n got  %s\n want %s", i+1, err, line, want)
		}
	}

	// Written and read back through the files, the tree is the same tree.
	st, err := NewStatement(StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: []Asset{{"USDT", 6}, {"BTC", 8}, {"ETH", 18}, {"a.b-c_d", 0}}}, tree, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "s")
	if err := WriteSnapshotDir(dir, st, tree, testSeed(t)); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSnapshotDir(dir)
	if err != nil || loaded.Tree.Root() != tree.Root() {
		t.Fatalf("read back: %v", err)
	}
	for _, row := range rows[:8] {
		if _, err := loaded.Tree.ProofFor(row.ref); err != nil {
			t.Errorf("account %q is not found in the loaded tree: %v", row.ref, err)
		}
	}
}

func TestProofFile(t *testing.T) {
	dir, tree, st := writeSample(t)
	path := filepath.Join(dir, "proof-U-100001.json")
	own, _ := tree.ProofFor("U-100001")
	if err := WriteProofFile(path, st, own); err != nil {
		t.Fatal(err)
	}
	if modeOf(t, path) != 0o600 {
		t.Errorf("a proof file names an account and its balances; mode %o", modeOf(t, path))
	}
	file, err := ReadProofFile(path)
	if err != nil || file.UserRef != "U-100001" || file.Proof.Leaf.UserRef != "U-100001" {
		t.Fatalf("read back: %+v, %v", file, err)
	}
	if err := VerifyProof(file.Proof, st.Root(), st.Totals()); err != nil {
		t.Errorf("the proof read back: %v", err)
	}
	// A customer's file is the customer's own proof; an opening is not one.
	opening, _ := tree.Proof(0)
	_, err = MarshalProofFile(st, opening)
	wantCode(t, err, CodeInvalidProof)
	_, err = MarshalProofFile(nil, own)
	wantCode(t, err, CodeInvalidOption)
	_, err = MarshalProofFile(st, nil)
	wantCode(t, err, CodeInvalidProof)

	good := readFile(t, path)
	// Only the proof is needed to read one; a schema, if stated, has to be this one.
	minimal, _ := opening.MarshalJSON()
	if f, err := ParseProofFile([]byte(`{"proof":` + string(minimal) + `}`)); err != nil || f.UserRef != "" {
		t.Errorf("a file with the proof alone: %+v, %v", f, err)
	}
	for name, text := range map[string]string{
		"not JSON":                `{"proof":`,
		"no proof":                `{"schema":"stonehash.por-proof.v1","user_ref":"x"}`,
		"another schema":          strings.Replace(good, "por-proof.v1", "por-proof.v2", 1),
		"a reference as a number": strings.Replace(good, `"user_ref": "U-100001",`, `"user_ref": 100001,`, 1),
		"a negative balance":      strings.Replace(good, `"BTC": "50000000"`, `"BTC": "-50000000"`, 1),
	} {
		if f, err := ParseProofFile([]byte(text)); codeOf(t, err) != CodeInvalidProof {
			t.Errorf("%s: read as %+v, %v", name, f, err)
		}
	}
	_, err = ReadProofFile(path + ".missing")
	wantCode(t, err, CodeIO)
}

func TestOpeningsNeverCarryAnAccountReference(t *testing.T) {
	dir, tree, _ := writeSample(t)
	var proofs []*Proof
	for i := 0; i < tree.LeafCount(); i++ {
		ref, _ := tree.UserRef(i)
		own, _ := tree.ProofFor(ref) // the customer's own, reference included
		proofs = append(proofs, own)
	}
	if err := WriteOpenings(dir, proofs); err != nil {
		t.Fatal(err)
	}
	written := readFile(t, filepath.Join(dir, OpeningsFile))
	if strings.Contains(written, "user_ref\"") || strings.Contains(written, "U-1000") {
		t.Fatalf("the record of what was opened names accounts:\n%s", written)
	}
	if !strings.HasPrefix(written, "{\n  \"schema\": \"stonehash.por-openings.v1\",\n  \"openings\": [\n    {\n      \"leaf_index\": 0,") || modeOf(t, filepath.Join(dir, OpeningsFile)) != 0o600 {
		t.Errorf("openings.json starts %q", written[:80])
	}
	if proofs[0].Leaf.UserRef == "" {
		t.Error("writing the openings changed the caller's proofs")
	}
	if _, err := MarshalOpenings([]*Proof{nil}); codeOf(t, err) != CodeInvalidProof {
		t.Errorf("no proof: %v", err)
	}
}

func TestSubmissionAndReceiptFiles(t *testing.T) {
	dir, _, st := writeSample(t)
	_, err := ReadSubmission(dir)
	if wantCode(t, err, CodeIO); !strings.Contains(err.Error(), "sign the statement first") {
		t.Errorf("before signing: %v", err)
	}
	signer := newSigner(t)
	sub, _ := NewSubmission(st, signer)
	if err := WriteSubmission(dir, sub); err != nil {
		t.Fatal(err)
	}
	// The file is the statement file with the signature beside it.
	statement := strings.TrimSuffix(readFile(t, filepath.Join(dir, StatementFile)), "\n")
	want := "{\n  \"schema\": \"stonehash.por-submission.v1\",\n  \"statement\": " + strings.ReplaceAll(statement, "\n", "\n  ") +
		",\n  \"sig\": {\n    \"alg\": \"ES256\",\n    \"key_id\": \"KR-EX-0a1b2c\",\n    \"issuer\": \"Sample Exchange\",\n    \"sig\": \"" + sub.Sig.Sig + "\"\n  }\n}\n"
	if got := readFile(t, filepath.Join(dir, SubmissionFile)); got != want {
		t.Errorf("submission.json:\n got  %s\n want %s", got, want)
	}
	back, err := ReadSubmission(dir)
	if err != nil || VerifyStatementSignature(back.Statement, back.Sig, signer.PublicSPKI()) != nil {
		t.Fatalf("read back: %v", err)
	}
	wantCode(t, WriteSubmission(dir, &Submission{Statement: st}), CodeInvalidSubmission)

	receipt := Receipt{
		SnapshotID: "snap-1", Status: StatusVerified, SpotCheck: true, SampledAccounts: 8, AttestationID: "att-1",
		Commitment: st.Commitment(), Root: st.Root(), Platform: "https://attest.example", PublicURL: "https://attest.example/v1/public/por/snapshots/snap-1",
		ReceivedAt: time.Date(2026, 11, 16, 10, 0, 0, 987_654_321, time.FixedZone("KST", 9*3600)), Anchor: AnchorPending,
	}
	if err := WriteReceipt(dir, receipt); err != nil {
		t.Fatal(err)
	}
	want = `{
  "schema": "stonehash.por-receipt.v1",
  "snapshot_id": "snap-1",
  "status": "VERIFIED",
  "spot_check": true,
  "sampled_accounts": 8,
  "attestation_id": "att-1",
  "commitment": "` + sampleCommitment + `",
  "root": "` + sampleRoot + `",
  "platform": "https://attest.example",
  "public_url": "https://attest.example/v1/public/por/snapshots/snap-1",
  "received_at": "2026-11-16T01:00:00.987Z",
  "anchor": "pending"
}
`
	if got := readFile(t, filepath.Join(dir, ReceiptFile)); got != want {
		t.Errorf("receipt.json:\n got  %s\n want %s", got, want)
	}
	receipt.Anchor = "anchored"
	wantCode(t, WriteReceipt(dir, receipt), CodeInvalidOption)
}

func TestParseSeed(t *testing.T) {
	text := hex.EncodeToString(testSeed(t))
	for _, form := range []string{text, text + "\n", text + "\r\n", strings.ToUpper(text)} {
		if seed, err := ParseSeed(form); err != nil || !bytes.Equal(seed, testSeed(t)) {
			t.Errorf("%q: %x, %v", form, seed, err)
		}
	}
	for _, form := range []string{"", text[:62], text + "00", " " + text, strings.Replace(text, "0", "g", 1), "0x" + text[2:]} {
		if seed, err := ParseSeed(form); codeOf(t, err) != CodeInvalidOption {
			t.Errorf("%q: %x, %v", form, seed, err)
		}
	}
}

// A snapshot large enough to cross every buffer on the way out and back in.
func TestSnapshotDirWithManyAccounts(t *testing.T) {
	const accounts = 20000
	b := newBuilder(t)
	for i := 0; i < accounts; i++ {
		b.Add(fmt.Sprintf("account-%06d", i), "BTC", fmt.Sprintf("0.%08d", i))
		if i%3 == 0 {
			b.Add(fmt.Sprintf("account-%06d", i), "ETH", fmt.Sprintf("%d.5", i))
		}
	}
	ledger, report := b.Finish()
	if !report.OK {
		t.Fatal(report.Problems)
	}
	tree, err := BuildTree(testExchange, testSeed(t), ledger)
	if err != nil {
		t.Fatal(err)
	}
	st := sampleStatement(t, tree)
	dir := filepath.Join(t.TempDir(), "large")
	if err := WriteSnapshotDir(dir, st, tree, testSeed(t)); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSnapshotDir(dir)
	if err != nil || loaded.Tree.Root() != tree.Root() || loaded.Tree.LeafCount() != accounts {
		t.Fatalf("read back: %v", err)
	}
	for _, ref := range []string{"account-000000", "account-012345", "account-019999"} {
		p, err := loaded.Tree.ProofFor(ref)
		if err != nil || VerifyProof(p, st.Root(), st.Totals()) != nil {
			t.Errorf("the proof for %s from the loaded tree: %v", ref, err)
		}
	}
}
