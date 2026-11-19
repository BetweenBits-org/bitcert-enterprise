package por

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"stonehash.com/attest/por/internal/cjson"
)

// The exchange's private record of a snapshot (specification §8): what it
// keeps, and how it is read back.
//
// A snapshot is only useful to a customer for as long as the exchange can
// still issue that customer's proof, and a proof needs the leaf's salt and
// its neighbours all the way up. The tree itself is not stored. It is a
// function of the leaves, so it is rebuilt when a proof is needed — and the
// rebuilt root is compared with the recorded one before anything is issued
// from it. A leaves file that was edited, truncated or mixed up with another
// day's fails that comparison instead of producing proofs that do not verify.

// Files of a snapshot directory.
const (
	// StatementFile holds the statement: root and totals. With its signature
	// it is the only part that is ever sent anywhere.
	StatementFile = "snapshot.json"
	// SubmissionFile holds the statement and its signature, once signed.
	SubmissionFile = "submission.json"
	// LeavesFile holds one line per account, in tree order: its reference,
	// its hash, its salt, its balances. Private.
	LeavesFile = "leaves.jsonl"
	// SeedFile holds the secret every salt was derived from. Private.
	SeedFile = "seed.hex"
	// TreeFile is a small header naming the root and the leaves file. Private.
	TreeFile = "tree.json"
	// ReceiptFile holds what the platform answered to a submission.
	ReceiptFile = "receipt.json"
	// OpeningsFile records, after a spot check, exactly what was opened to
	// the platform.
	OpeningsFile = "openings.json"
)

const (
	treeHeaderSchema = "stonehash.por-tree.v2"
	proofFileSchema  = "stonehash.por-proof.v1"
	openingsSchema   = "stonehash.por-openings.v1"
	receiptSchema    = "stonehash.por-receipt.v1"
)

const (
	// privateMode is for files that name accounts or hold the seed.
	privateMode fs.FileMode = 0o600
	publicMode  fs.FileMode = 0o644
)

// maxLeafLine bounds one line of the leaves file. A line holds one account's
// reference and balances; one longer than this is damage, not data.
const maxLeafLine = 16 << 20

// WriteSnapshotDir writes the private files of a snapshot that has just been
// built: snapshot.json, leaves.jsonl, tree.json and seed.hex. The leaves
// file is streamed, a line at a time. leaves.jsonl, seed.hex and tree.json
// are readable by their owner only.
//
// Keep the directory. Without leaves.jsonl and seed.hex no customer's proof
// can be issued for the snapshot again; the anchored root stays valid and
// becomes uncheckable. For that reason a directory that already holds a
// different seed is refused rather than overwritten.
func WriteSnapshotDir(dir string, st *Statement, tree *Tree, seed []byte) error {
	if st == nil || tree == nil {
		return errorf(CodeInvalidOption, "a snapshot directory is written from a statement and its tree")
	}
	if err := st.matches(tree); err != nil {
		return err
	}
	if err := checkSeed(seed); err != nil {
		return err
	}
	// A seed that is not the tree's would be kept as if it could re-derive
	// the salts, and found useless only on the day it was needed.
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(tree.leaves[0].ref))
	if !hmac.Equal(mac.Sum(nil), tree.leaves[0].salt[:]) {
		return errorf(CodeTreeMismatch, "the seed is not the one the tree's salts were derived from")
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return wrap(CodeIO, err, "the snapshot directory could not be created")
	}
	seedHex := hex.EncodeToString(seed) + "\n"
	switch existing, err := os.ReadFile(filepath.Join(dir, SeedFile)); {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return wrap(CodeIO, err, "the directory's %s could not be read", SeedFile)
	case string(existing) != seedHex:
		return errorf(CodeSnapshotExists,
			"%s already holds a snapshot built with a different seed; write this one to a new directory: replacing %s and %s would make that snapshot's proofs impossible to issue",
			dir, SeedFile, LeavesFile)
	}

	digest := sha256.New()
	err := writeFile(filepath.Join(dir, LeavesFile), privateMode, func(w io.Writer) error {
		return tree.writeLeaves(io.MultiWriter(w, digest))
	})
	if err != nil {
		return err
	}
	header := cjson.Object{
		{Key: "schema", Value: treeHeaderSchema},
		{Key: "exchange_id", Value: tree.exchangeID},
		{Key: "assets", Value: stringsValue(tree.assets)},
		{Key: "leaf_count", Value: int64(tree.LeafCount())},
		{Key: "root", Value: tree.Root()},
		{Key: "totals", Value: tree.Totals().value()},
		{Key: "leaves_file", Value: LeavesFile},
		{Key: "leaves_sha256", Value: hex.EncodeToString(digest.Sum(nil))},
	}
	if err := writeJSONFile(filepath.Join(dir, TreeFile), privateMode, header); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, SeedFile), privateMode, func(w io.Writer) error {
		_, err := io.WriteString(w, seedHex)
		return err
	}); err != nil {
		return err
	}
	// Last: its presence says the private files beside it are complete.
	return writeJSONFile(filepath.Join(dir, StatementFile), publicMode, st.doc)
}

func stringsValue(items []string) []any {
	out := make([]any, len(items))
	for i, s := range items {
		out[i] = s
	}
	return out
}

// writeLeaves writes the leaves file: a line per leaf, in tree order, with
// zero balances left out. Each line is the JSON the general writer would
// produce for the same object; it is assembled directly because there is one
// for every account.
func (t *Tree) writeLeaves(w io.Writer) error {
	out := bufio.NewWriterSize(w, 1<<20)
	line := make([]byte, 0, 512)
	var err error
	for i := range t.leaves {
		lf := &t.leaves[i]
		line = append(line[:0], `{"user_ref":`...)
		if line, err = cjson.AppendString(line, lf.ref); err != nil {
			return wrap(CodeInvalidJSON, err, "leaf %d", i)
		}
		line = append(line, `,"user_ref_hash":"`...)
		line = appendHex(line, lf.refHash[:])
		line = append(line, `","salt":"`...)
		line = appendHex(line, lf.salt[:])
		line = append(line, `","balances":{`...)
		first := true
		for j := range lf.held {
			h := &lf.held[j]
			if h.amount.Sign() == 0 {
				continue
			}
			if !first {
				line = append(line, ',')
			}
			first = false
			line = append(line, '"')
			line = append(line, t.assets[h.asset]...)
			line = append(line, `":"`...)
			line = h.amount.Append(line, 10)
			line = append(line, '"')
		}
		line = append(line, "}}\n"...)
		if _, err := out.Write(line); err != nil {
			return err
		}
	}
	return out.Flush()
}

// writeFile writes a file so that it is either absent, the previous version
// or complete: to a temporary name in the same directory, flushed to disk,
// then renamed. The mode is set outright because the mode at creation is
// subject to the umask.
func writeFile(path string, mode fs.FileMode, write func(io.Writer) error) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return wrap(CodeIO, err, "%s could not be created", filepath.Base(path))
	}
	// CreateTemp gives 0600, so nothing is readable by others while it is written.
	err = write(tmp)
	if err == nil {
		err = tmp.Chmod(mode)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		var refusal *Error
		if errors.As(err, &refusal) {
			return refusal
		}
		return wrap(CodeIO, err, "%s could not be written", filepath.Base(path))
	}
	return nil
}

// writeJSONFile writes a document the way the reference lays its files out:
// indented by two spaces, with a final line break.
func writeJSONFile(path string, mode fs.FileMode, doc any) error {
	text, err := cjson.Indent(doc)
	if err != nil {
		return wrap(CodeInvalidJSON, err, "%s cannot be written", filepath.Base(path))
	}
	text = append(text, '\n')
	return writeFile(path, mode, func(w io.Writer) error {
		_, err := w.Write(text)
		return err
	})
}

// Snapshot is a snapshot directory read back: the statement and the tree
// rebuilt from the leaves.
type Snapshot struct {
	Statement *Statement
	Tree      *Tree
}

// LoadSnapshotDir reads a snapshot directory — this SDK's or another
// language's — and rebuilds its tree.
//
// Nothing is returned unless the directory is whole: leaves.jsonl has the
// checksum tree.json recorded, every leaf's hashed reference is the hash of
// its reference, the leaves rebuild the recorded root, leaf count and totals,
// and snapshot.json commits to that same tree. Issuing a proof from a tree
// that is not the anchored one would hand a customer a file that fails, and
// leave them to conclude the exchange left them out.
func LoadSnapshotDir(dir string) (*Snapshot, error) {
	header, err := readTreeHeader(filepath.Join(dir, TreeFile))
	if err != nil {
		return nil, err
	}
	leaves, sum, err := readLeaves(filepath.Join(dir, LeavesFile), header)
	if err != nil {
		return nil, err
	}
	if sum != header.leavesSHA256 {
		return nil, errorf(CodeLeavesChecksum,
			"%s is not the file this snapshot was built from (its checksum differs from the one recorded in %s)", LeavesFile, TreeFile)
	}
	tree, refusal := newTree(header.exchangeID, header.assets, leaves)
	if refusal != nil {
		return nil, refusal
	}
	if tree.Root() != header.root || tree.LeafCount() != header.leafCount || !equalAmounts(tree.Totals(), header.totals) {
		return nil, errorf(CodeRootMismatch, "the leaves do not reproduce the root, leaf count and totals recorded in %s; refusing to issue anything from them", TreeFile)
	}
	st, err := ReadStatementFile(filepath.Join(dir, StatementFile))
	if err != nil {
		return nil, err
	}
	if refusal := st.matches(tree); refusal != nil {
		return nil, errorf(CodeTreeMismatch, "%s does not belong to the leaves beside it: %s", StatementFile, refusal.Message)
	}
	return &Snapshot{Statement: st, Tree: tree}, nil
}

type treeHeader struct {
	exchangeID   string
	assets       []string
	leafCount    int
	root         string
	totals       Balances
	leavesSHA256 string
}

func readTreeHeader(path string) (*treeHeader, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errorf(CodeSnapshotDamaged, "%s has no %s; it is not a snapshot directory", filepath.Dir(path), TreeFile)
	}
	if err != nil {
		return nil, wrap(CodeIO, err, "%s could not be read", TreeFile)
	}
	r, refusal := parseDocument(data, CodeSnapshotDamaged, TreeFile+": ")
	if refusal != nil {
		return nil, refusal
	}
	h := &treeHeader{}
	if schema, _ := r.str("schema"); schema != treeHeaderSchema {
		return nil, errorf(CodeSnapshotDamaged, "%s: schema is %s; this version reads %s", TreeFile, quote(schema), treeHeaderSchema)
	}
	// The name is fixed, and is not taken from the file: a header must not be
	// able to point the reader at another path.
	if name, _ := r.str("leaves_file"); name != LeavesFile {
		return nil, errorf(CodeSnapshotDamaged, "%s: leaves_file must be %s", TreeFile, LeavesFile)
	}
	if h.exchangeID, refusal = r.str("exchange_id"); refusal != nil {
		return nil, refusal
	}
	if refusal = checkExchangeID(h.exchangeID); refusal != nil {
		return nil, errorf(CodeSnapshotDamaged, "%s: %s", TreeFile, refusal.Message)
	}
	assets, refusal := r.array("assets")
	if refusal != nil {
		return nil, refusal
	}
	seen := map[string]bool{}
	for _, item := range assets {
		symbol, ok := item.(string)
		if !ok || !validSymbol(symbol) || seen[symbol] {
			return nil, errorf(CodeSnapshotDamaged, "%s: assets must be distinct asset symbols", TreeFile)
		}
		seen[symbol] = true
		h.assets = append(h.assets, symbol)
	}
	count, refusal := r.integer("leaf_count")
	if refusal != nil {
		return nil, refusal
	}
	if count < 1 || count > maxLeafCount {
		return nil, errorf(CodeSnapshotDamaged, "%s: leaf_count must be between 1 and %d", TreeFile, maxLeafCount)
	}
	h.leafCount = int(count)
	if h.root, refusal = r.hash("root"); refusal != nil {
		return nil, refusal
	}
	if h.totals, refusal = r.balances("totals"); refusal != nil {
		return nil, refusal
	}
	if h.leavesSHA256, refusal = r.hash("leaves_sha256"); refusal != nil {
		return nil, refusal
	}
	return h, nil
}

// readLeaves streams the leaves file, returning the leaves and the SHA-256
// of the file's bytes.
//
// A line that cannot be read is reported only if the checksum turns out to
// match: when it does not, the file is simply not the one recorded, and that
// is the more useful thing to say.
func readLeaves(path string, header *treeHeader) ([]leaf, string, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", errorf(CodeSnapshotDamaged, "%s is missing; without it no proof can be issued for this snapshot", LeavesFile)
	}
	if err != nil {
		return nil, "", wrap(CodeIO, err, "%s could not be opened", LeavesFile)
	}
	defer f.Close()

	position := make(map[string]int32, len(header.assets))
	for i, symbol := range header.assets {
		position[symbol] = int32(i)
	}
	digest := sha256.New()
	in := bufio.NewReaderSize(io.TeeReader(f, digest), 1<<20)
	// The count comes from a file; it sizes the slice only up to a bound, so
	// a damaged header cannot ask for all the memory there is.
	leaves := make([]leaf, 0, min(header.leafCount, 1<<20))
	var damage *Error
	for n := 1; ; n++ {
		line, readErr := readLine(in)
		if readErr != nil && readErr != io.EOF {
			var refusal *Error
			if errors.As(readErr, &refusal) {
				return nil, "", refusal
			}
			return nil, "", wrap(CodeIO, readErr, "%s could not be read", LeavesFile)
		}
		if len(line) > 0 && damage == nil {
			lf, refusal := leafFrom(line, header.exchangeID, position)
			if refusal != nil {
				damage = errorf(CodeSnapshotDamaged, "%s line %d: %s", LeavesFile, n, refusal.Message)
			} else {
				leaves = append(leaves, lf)
			}
		}
		if readErr == io.EOF {
			break
		}
	}
	sum := hex.EncodeToString(digest.Sum(nil))
	if damage != nil && sum == header.leavesSHA256 {
		return nil, "", damage
	}
	return leaves, sum, nil
}

// readLine returns the next line without its line break. At the end of the
// input it returns what was left, with io.EOF.
func readLine(in *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := in.ReadSlice('\n')
		if len(line)+len(part) > maxLeafLine {
			return nil, errorf(CodeSnapshotDamaged, "%s has a line longer than %d bytes", LeavesFile, maxLeafLine)
		}
		if err == bufio.ErrBufferFull {
			line = append(line, part...)
			continue
		}
		if line != nil {
			part = append(line, part...)
		}
		return bytes.TrimRight(part, "\r\n"), err
	}
}

// leafFrom reads one line of the leaves file.
func leafFrom(line []byte, exchangeID string, position map[string]int32) (leaf, *Error) {
	var lf leaf
	v, parseErr := cjson.Parse(line)
	if parseErr != nil {
		return lf, errorf(CodeSnapshotDamaged, "%s", parseErr)
	}
	obj, ok := v.(cjson.Object)
	if !ok {
		return lf, errorf(CodeSnapshotDamaged, "not a JSON object")
	}
	r := reader{code: CodeSnapshotDamaged, obj: obj}
	var err *Error
	if lf.ref, err = r.str("user_ref"); err != nil {
		return lf, err
	}
	refHash, err := r.hash("user_ref_hash")
	if err != nil {
		return lf, err
	}
	hex.Decode(lf.refHash[:], []byte(refHash))
	// A leaf filed under a hash that is not its reference's would give its
	// customer a proof that fails the check of their own reference.
	if lf.refHash != userRefHash(exchangeID, lf.ref) {
		return lf, errorf(CodeSnapshotDamaged, "user_ref_hash is not the hash of user_ref for exchange %s", quote(exchangeID))
	}
	salt, err := r.hash("salt")
	if err != nil {
		return lf, err
	}
	hex.Decode(lf.salt[:], []byte(salt))
	balances, err := r.balances("balances")
	if err != nil {
		return lf, err
	}
	lf.held = make([]holding, len(balances))
	for i, b := range balances {
		asset, listed := position[b.Asset]
		if !listed {
			return lf, errorf(CodeSnapshotDamaged, "holds %s, which %s does not list", quote(b.Asset), TreeFile)
		}
		lf.held[i].asset = asset
		setCompact(&lf.held[i].amount, b.Amount)
	}
	return lf, nil
}

// ReadStatementFile reads and checks a snapshot statement from a file.
func ReadStatementFile(path string) (*Statement, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, wrap(CodeIO, err, "the statement could not be read")
	}
	return ParseStatement(data)
}

// WriteSubmission writes submission.json into a snapshot directory: the
// statement and its signature, and nothing else. The file is everything a
// submission without a spot check sends.
func WriteSubmission(dir string, sub *Submission) error {
	if err := sub.check(); err != nil {
		return err
	}
	return writeJSONFile(filepath.Join(dir, SubmissionFile), publicMode, sub.value())
}

// ReadSubmission reads submission.json from a snapshot directory.
func ReadSubmission(dir string) (*Submission, error) {
	data, err := os.ReadFile(filepath.Join(dir, SubmissionFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errorf(CodeIO, "%s has no %s; sign the statement first", dir, SubmissionFile)
	}
	if err != nil {
		return nil, wrap(CodeIO, err, "%s could not be read", SubmissionFile)
	}
	return ParseSubmission(data)
}

// ProofFile is what this SDK reads of the file an exchange hands one
// customer: the proof, and the account it says it is for. The file's own copy
// of the root and totals is for people; a proof is never verified against it.
type ProofFile struct {
	// UserRef is the customer's own account reference, when the file names it.
	UserRef string
	Proof   *Proof
}

// MarshalProofFile lays out a customer's proof file. The proof must be the
// customer's own (Tree.ProofFor): it carries their account reference.
func MarshalProofFile(st *Statement, p *Proof) ([]byte, error) {
	if st == nil {
		return nil, errorf(CodeInvalidOption, "a proof file is written against a statement")
	}
	if err := p.check(); err != nil {
		return nil, err
	}
	if p.Leaf.UserRef == "" {
		return nil, errorf(CodeInvalidProof, "a customer's proof file names the customer's own account; issue the proof with Tree.ProofFor")
	}
	exchange, _ := st.doc.Get("exchange")
	totals, _ := st.doc.Get("totals")
	text, err := cjson.Indent(cjson.Object{
		{Key: "schema", Value: proofFileSchema},
		{Key: "exchange", Value: exchange},
		{Key: "asof", Value: st.asOf},
		{Key: "root", Value: st.root},
		{Key: "totals", Value: totals},
		{Key: "leaf_count", Value: int64(st.leafCount)},
		{Key: "user_ref", Value: p.Leaf.UserRef},
		{Key: "proof", Value: p.value()},
	})
	if err != nil {
		return nil, wrap(CodeInvalidProof, err, "the proof file cannot be written")
	}
	return append(text, '\n'), nil
}

// WriteProofFile writes a customer's proof file. It is readable by its owner
// only: it names an account and states its balances.
func WriteProofFile(path string, st *Statement, p *Proof) error {
	text, err := MarshalProofFile(st, p)
	if err != nil {
		return err
	}
	return writeFile(path, privateMode, func(w io.Writer) error {
		_, err := w.Write(text)
		return err
	})
}

// ParseProofFile reads a customer's proof file.
func ParseProofFile(data []byte) (*ProofFile, error) {
	r, err := parseDocument(data, CodeInvalidProof, "")
	if err != nil {
		return nil, err
	}
	if r.has("schema") {
		if schema, _ := r.str("schema"); schema != proofFileSchema {
			return nil, errorf(CodeInvalidProof, "schema is %s; this version reads %s", quote(schema), proofFileSchema)
		}
	}
	f := &ProofFile{}
	proof, err := r.object("proof")
	if err != nil {
		return nil, err
	}
	if f.Proof, err = proofFrom(proof); err != nil {
		return nil, err
	}
	if f.UserRef, err = r.optStr("user_ref"); err != nil {
		return nil, err
	}
	return f, nil
}

// ReadProofFile reads a customer's proof file from disk.
func ReadProofFile(path string) (*ProofFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, wrap(CodeIO, err, "the proof file could not be read")
	}
	return ParseProofFile(data)
}

// MarshalOpenings lays out the record of a spot check: the proofs that were
// opened to the platform. Account references are never part of it.
func MarshalOpenings(openings []*Proof) ([]byte, error) {
	items := make([]any, len(openings))
	for i, p := range openings {
		if err := p.check(); err != nil {
			return nil, err
		}
		items[i] = p.pseudonymous().value()
	}
	text, err := cjson.Indent(cjson.Object{
		{Key: "schema", Value: openingsSchema},
		{Key: "openings", Value: items},
	})
	if err != nil {
		return nil, wrap(CodeInvalidProof, err, "the openings cannot be written")
	}
	return append(text, '\n'), nil
}

// WriteOpenings writes openings.json into a snapshot directory: an exact
// record of the account-level data that left the building.
func WriteOpenings(dir string, openings []*Proof) error {
	text, err := MarshalOpenings(openings)
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, OpeningsFile), privateMode, func(w io.Writer) error {
		_, err := w.Write(text)
		return err
	})
}

// Receipt is what the exchange keeps of a submission: what was sent, where,
// and what the platform answered.
type Receipt struct {
	SnapshotID string
	// Status is ACCEPTED (anchored on the signature alone) or VERIFIED (a
	// spot check passed first).
	Status    string
	SpotCheck bool
	// SampledAccounts is the number of leaves opened to the platform: zero
	// unless a spot check was asked for.
	SampledAccounts int
	AttestationID   string
	Commitment      string
	Root            string
	// Platform is the base URL the submission went to.
	Platform  string
	PublicURL string
	// ReceivedAt is when the platform's answer arrived.
	ReceivedAt time.Time
	// Anchor is AnchorPending or AnchorConfirmed.
	Anchor string
}

// States of a receipt's anchor.
const (
	AnchorPending   = "pending"
	AnchorConfirmed = "confirmed"
)

// WriteReceipt writes receipt.json into a snapshot directory.
func WriteReceipt(dir string, r Receipt) error {
	if r.Anchor != AnchorPending && r.Anchor != AnchorConfirmed {
		return errorf(CodeInvalidOption, "a receipt's anchor is %q or %q", AnchorPending, AnchorConfirmed)
	}
	return writeJSONFile(filepath.Join(dir, ReceiptFile), publicMode, cjson.Object{
		{Key: "schema", Value: receiptSchema},
		{Key: "snapshot_id", Value: r.SnapshotID},
		{Key: "status", Value: r.Status},
		{Key: "spot_check", Value: r.SpotCheck},
		{Key: "sampled_accounts", Value: int64(r.SampledAccounts)},
		{Key: "attestation_id", Value: r.AttestationID},
		{Key: "commitment", Value: r.Commitment},
		{Key: "root", Value: r.Root},
		{Key: "platform", Value: r.Platform},
		{Key: "public_url", Value: r.PublicURL},
		{Key: "received_at", Value: r.ReceivedAt.UTC().Format(timestampLayout)},
		{Key: "anchor", Value: r.Anchor},
	})
}

// ParseSeed reads a seed from its hexadecimal form, as seed.hex holds it.
func ParseSeed(text string) ([]byte, error) {
	seed, err := hex.DecodeString(strings.TrimRight(text, "\r\n"))
	if err != nil || len(seed) != SeedSize {
		return nil, errorf(CodeInvalidOption, "a seed is %d hexadecimal characters", 2*SeedSize)
	}
	return seed, nil
}
