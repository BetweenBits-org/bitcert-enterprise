package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	por "stonehash.com/attest/por"
	"stonehash.com/attest/por/internal/platformtest"
)

const (
	testExchange = "KR-EX-0a1b2c"
	testSeedHex  = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	testAPIKey   = "sk_test_7d1e9a40c3b2"
	sampleRoot   = "0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa"
)

// vectorsDir is where the published vectors are: POR_VECTORS when set,
// otherwise the fixtures of the repository this SDK is developed in.
func vectorsDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("POR_VECTORS")
	if dir == "" {
		dir = filepath.Join("..", "..", "..", "..", "fixtures", "por")
	}
	if _, err := os.Stat(filepath.Join(dir, "intake", "long.csv")); err != nil {
		t.Fatalf("the conformance vectors were not found in %s; set POR_VECTORS to the directory that holds SPEC.md and its vector files", dir)
	}
	return dir
}

type outcome struct {
	code           int
	stdout, stderr string
}

// cli runs the program as a shell would, with the given environment.
func cli(env map[string]string, args ...string) outcome {
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr, func(name string) string { return env[name] })
	return outcome{code, stdout.String(), stderr.String()}
}

func buildArgs(csv, out string) []string {
	return []string{"build", "--csv", csv, "--amounts", "decimal", "--assets", "BTC:8,ETH:18,USDT:6", "--exchange", testExchange,
		"--name", "Sample Exchange", "--asof", "2026-11-16T00:00:00Z", "--seed-hex", testSeedHex,
		"--generated-at", "2026-11-16T01:02:03.456Z", "--out", out}
}

// keyFile writes a new signing key and returns its public half as the
// platform registers it.
func keyFile(t *testing.T, path string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), 0o600); err != nil {
		t.Fatal(err)
	}
	public, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(public)
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// built makes a signed sample snapshot and a platform that knows its key.
func built(t *testing.T) (dir string, platform *platformtest.Platform, env map[string]string) {
	t.Helper()
	work := t.TempDir()
	dir = filepath.Join(work, "snapshot")
	if r := cli(nil, buildArgs(filepath.Join(vectorsDir(t), "intake", "long.csv"), dir)...); r.code != exitOK {
		t.Fatalf("build: exit %d\n%s", r.code, r.stderr)
	}
	spki := keyFile(t, filepath.Join(work, "signing-key.pem"))
	if r := cli(nil, "sign", "--dir", dir, "--key", filepath.Join(work, "signing-key.pem")); r.code != exitOK || r.stdout != "" || r.stderr != "" {
		t.Fatalf("sign: %+v", r)
	}
	platform = platformtest.New(t)
	platform.Keys[testExchange] = spki
	return dir, platform, map[string]string{"STONEHASH_API_KEY": testAPIKey}
}

func TestBuildPrintsRootTotalsAndCommitmentAndWritesTheDirectory(t *testing.T) {
	vectors := vectorsDir(t)
	for _, layout := range []string{"long", "wide"} {
		dir := filepath.Join(t.TempDir(), "out", "nested")
		r := cli(nil, buildArgs(filepath.Join(vectors, "intake", layout+".csv"), dir)...)
		want := "root " + sampleRoot + "\n" +
			`totals {"BTC":"2463358024","ETH":"114050000000000000001","USDT":"255810750000"}` + "\n" +
			"commitment 4245836fda6114c01d9fd50a9b9e5f84f41cb62f6d727abcb8c97bb6f41a6712\n"
		if r.code != exitOK || r.stdout != want || r.stderr != "" {
			t.Fatalf("%s layout: %+v\nwant stdout\n%s", layout, r, want)
		}
		// The directory is the reference's own, byte for byte.
		for _, file := range []string{por.StatementFile, por.TreeFile, por.SeedFile, por.LeavesFile} {
			if read(t, filepath.Join(dir, file)) != read(t, filepath.Join(vectors, "snapshot-dir", file)) {
				t.Errorf("%s layout: %s differs from the reference's", layout, file)
			}
		}
	}

	// Without a seed one is drawn; without a time the clock is read. Totals
	// are printed in canonical order whatever order the assets were declared in.
	dir := filepath.Join(t.TempDir(), "fresh")
	r := cli(nil, "build", "--csv", filepath.Join(vectors, "intake", "mapped.csv"), "--amounts", "base", "--assets", "USDT:6,ETH:18,BTC:8",
		"--exchange", testExchange, "--name", "한빛 거래소", "--asof", "2026-11-16T09:00:00+09:00", "--out", dir,
		"--delimiter", ";", "--col-account", "user_id", "--col-asset", "currency", "--col-balance", "amount")
	if r.code != exitOK || !strings.Contains(r.stdout, `totals {"BTC":"50000000","ETH":"0","USDT":"7"}`+"\n") {
		t.Fatalf("a mapped export: %+v", r)
	}
	if seed := read(t, filepath.Join(dir, por.SeedFile)); len(seed) != 65 || seed == testSeedHex+"\n" {
		t.Errorf("the seed drawn: %q", seed)
	}
	statement := read(t, filepath.Join(dir, por.StatementFile))
	if !strings.Contains(statement, `"name": "한빛 거래소"`) || !strings.Contains(statement, `"asof": "2026-11-16T09:00:00+09:00"`) ||
		!regexp.MustCompile(`"generated_at": "20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"`).MatchString(statement) {
		t.Errorf("the statement: %s", statement)
	}
	// A second build into the same place would draw another seed: refused.
	if again := cli(nil, "build", "--csv", filepath.Join(vectors, "intake", "mapped.csv"), "--amounts", "base", "--assets", "USDT:6,ETH:18,BTC:8",
		"--exchange", testExchange, "--name", "x", "--asof", "2026-11-16T00:00:00Z", "--out", dir,
		"--delimiter", ";", "--col-account", "user_id", "--col-asset", "currency", "--col-balance", "amount"); again.code != exitFailed || !strings.Contains(again.stderr, "different seed") {
		t.Errorf("building over another snapshot: %+v", again)
	}
	for name, args := range map[string][]string{
		"the wide layout with a column to ignore": {"--csv", filepath.Join(vectors, "intake", "wide-ignore.csv"), "--ignore-columns", " memo ,other"},
		"a layout stated":                         {"--csv", filepath.Join(vectors, "intake", "wide.csv"), "--layout", "wide"},
	} {
		full := append([]string{"build", "--amounts", "decimal", "--assets", "BTC:8,ETH:18,USDT:6", "--exchange", testExchange,
			"--name", "x", "--asof", "2026-11-16T00:00:00Z", "--out", filepath.Join(t.TempDir(), "o")}, args...)
		if r := cli(nil, full...); r.code != exitOK {
			t.Errorf("%s: %+v", name, r)
		}
	}
}

// Every refused export of the vectors: its problems on stderr, one a line,
// nothing written, exit 2.
func TestBuildOfABadExportPrintsEachProblemAndWritesNothing(t *testing.T) {
	vectors := vectorsDir(t)
	var intake struct {
		Cases []struct {
			Name, File string
			OK         bool `json:"ok"`
			Problems   []struct {
				Line int
				Code string
			}
		}
	}
	if err := json.Unmarshal([]byte(read(t, filepath.Join(vectors, "intake.json"))), &intake); err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`^line (\d+) ([a-z_]+) \S.*$`)
	checked := 0
	for _, c := range intake.Cases {
		if c.OK {
			continue
		}
		checked++
		out := filepath.Join(t.TempDir(), "never")
		r := cli(nil, buildArgs(filepath.Join(vectors, filepath.FromSlash(c.File)), out)...)
		if r.code != exitInvalid || r.stdout != "" || exists(out) {
			t.Errorf("%s: exit %d, stdout %q, directory written: %v", c.Name, r.code, r.stdout, exists(out))
		}
		var got, want []string
		for _, text := range strings.Split(strings.TrimSuffix(r.stderr, "\n"), "\n") {
			m := line.FindStringSubmatch(text)
			if m == nil {
				t.Errorf("%s: stderr line %q is not `line <n> <code> <message>`", c.Name, text)
				continue
			}
			got = append(got, m[1]+":"+m[2])
		}
		for _, p := range c.Problems {
			want = append(want, fmt.Sprintf("%d:%s", p.Line, p.Code))
		}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("%s: problems %v, want %v", c.Name, got, want)
		}
	}
	if checked < 8 {
		t.Fatalf("only %d refused exports were found in the vectors", checked)
	}

	// More problems than the report keeps: the rest are counted, not printed.
	many := filepath.Join(t.TempDir(), "many.csv")
	os.WriteFile(many, []byte("account_id,asset,balance\n"+strings.Repeat("u,BTC,-1\n", 60)), 0o600)
	r := cli(nil, buildArgs(many, filepath.Join(t.TempDir(), "never"))...)
	if lines := strings.Split(strings.TrimSuffix(r.stderr, "\n"), "\n"); r.code != exitInvalid || len(lines) != 51 || lines[50] != "... and 10 more" {
		t.Errorf("60 problems: exit %d, %d lines, last %q", r.code, len(lines), lines[len(lines)-1])
	}
}

func TestTheWholeHandOff(t *testing.T) {
	dir, platform, env := built(t)
	env["HOME"] = "/nonexistent"

	// Sending: one request with a body, and the body is the file that was signed.
	r := cli(env, "submit", "--dir", dir, "--core", platform.URL+"/")
	if r.code != exitOK || r.stdout != "snapshot snap-1 ACCEPTED\n" || r.stderr != "" {
		t.Fatalf("submit: %+v", r)
	}
	bodies := platform.Bodies()
	if len(bodies) != 1 || bodies[0].Authorization != "Bearer "+testAPIKey {
		t.Fatalf("requests with a body: %+v", bodies)
	}
	var sent, signed map[string]json.RawMessage
	json.Unmarshal(bodies[0].Body, &sent)
	json.Unmarshal([]byte(read(t, filepath.Join(dir, por.SubmissionFile))), &signed)
	if len(sent) != 2 || !sameJSON(sent["statement"], signed["statement"]) || !sameJSON(sent["sig"], signed["sig"]) {
		t.Errorf("what was sent is not the statement and signature of submission.json: %s", bodies[0].Body)
	}
	for _, private := range append(strings.Fields(strings.NewReplacer(`"`, " ", ",", " ", ":", " ", "{", " ", "}", " ").Replace(read(t, filepath.Join(dir, por.LeavesFile)))), testSeedHex) {
		if len(private) >= 8 && (strings.HasPrefix(private, "U-1000") || len(private) == 64) && strings.Contains(string(bodies[0].Body), private) {
			t.Fatalf("the request carries %q from the private files", private)
		}
	}
	if exists(filepath.Join(dir, por.OpeningsFile)) {
		t.Error("openings.json was written without a spot check")
	}

	// The receipt: exactly these members, in this order.
	receipt := read(t, filepath.Join(dir, por.ReceiptFile))
	wantReceipt := regexp.MustCompile(`^\{
  "schema": "stonehash\.por-receipt\.v1",
  "snapshot_id": "snap-1",
  "status": "ACCEPTED",
  "spot_check": false,
  "sampled_accounts": 0,
  "attestation_id": "att-snap-1",
  "commitment": "4245836fda6114c01d9fd50a9b9e5f84f41cb62f6d727abcb8c97bb6f41a6712",
  "root": "` + sampleRoot + `",
  "platform": "` + regexp.QuoteMeta(platform.URL) + `",
  "public_url": "` + regexp.QuoteMeta(platform.URL) + `/v1/public/por/snapshots/snap-1",
  "received_at": "20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",
  "anchor": "pending"
\}
$`)
	if !wantReceipt.MatchString(receipt) {
		t.Errorf("receipt.json:\n%s", receipt)
	}

	// Sent again and waited for: the same snapshot, its anchor confirmed.
	platform.PendingPolls = 1
	r = cli(env, "submit", "--dir", dir, "--core", platform.URL, "--wait", "--timeout-sec", "30")
	if r.code != exitOK || r.stdout != "snapshot snap-1 ACCEPTED\n" {
		t.Fatalf("submit --wait: %+v", r)
	}
	if receipt := read(t, filepath.Join(dir, por.ReceiptFile)); !strings.Contains(receipt, `"anchor": "confirmed"`) {
		t.Errorf("after the wait: %s", receipt)
	}

	r = cli(env, "status", "--core", platform.URL, "--snapshot", "snap-1")
	var status map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &status); r.code != exitOK || err != nil || status["root"] != sampleRoot || status["status"] != "ACCEPTED" {
		t.Errorf("status: %+v (%v)", r, err)
	}

	// The key is in the request header and nowhere a person or a file would see it.
	for _, text := range []string{r.stdout, r.stderr, receipt, read(t, filepath.Join(dir, por.SubmissionFile))} {
		if strings.Contains(text, testAPIKey) {
			t.Fatalf("the API key appears in output: %s", text)
		}
	}
}

func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && fmt.Sprint(x) == fmt.Sprint(y)
}

func TestSubmitWithASpotCheckRecordsWhatWasOpened(t *testing.T) {
	dir, platform, env := built(t)
	platform.Challenge = []int{0, 3, 7}
	r := cli(env, "submit", "--dir", dir, "--core", platform.URL, "--spot-check", "--wait")
	if r.code != exitOK || r.stdout != "snapshot snap-1 VERIFIED\n" || r.stderr != "" {
		t.Fatalf("submit --spot-check: %+v", r)
	}
	bodies := platform.Bodies()
	if len(bodies) != 2 || bodies[1].Path != "/v1/por/snapshots/snap-1/openings" {
		t.Fatalf("requests with a body: %+v", bodies)
	}
	if strings.Contains(string(bodies[1].Body), "U-1000") || strings.Contains(string(bodies[1].Body), `"user_ref"`) {
		t.Fatalf("the openings carry an account reference: %s", bodies[1].Body)
	}
	// The snapshot is the vectors' and so is the challenge: the record of
	// what was opened is the reference's own file.
	opened := read(t, filepath.Join(dir, por.OpeningsFile))
	if opened != read(t, filepath.Join(vectorsDir(t), "snapshot-dir.openings-0-3-7.json")) {
		t.Errorf("openings.json differs from the reference's:\n%s", opened)
	}
	var record, sent struct{ Openings json.RawMessage }
	json.Unmarshal([]byte(opened), &record)
	json.Unmarshal(bodies[1].Body, &sent)
	if !sameJSON(record.Openings, sent.Openings) {
		t.Error("openings.json is not what was sent")
	}
	receipt := read(t, filepath.Join(dir, por.ReceiptFile))
	for _, member := range []string{`"status": "VERIFIED"`, `"spot_check": true`, `"sampled_accounts": 3`, `"anchor": "confirmed"`} {
		if !strings.Contains(receipt, member) {
			t.Errorf("the receipt lacks %s:\n%s", member, receipt)
		}
	}

	// Openings the platform rejects left the building all the same, and are on record.
	dir, platform, env = built(t)
	platform.Challenge = []int{2}
	platform.Override = func(r platformtest.Request) *platformtest.Answer {
		if strings.HasSuffix(r.Path, "/openings") {
			return &platformtest.Answer{Status: 422, Body: `{"status":"REJECTED","problems":["leaf 2: no"]}`}
		}
		return nil
	}
	r = cli(env, "submit", "--dir", dir, "--core", platform.URL, "--spot-check")
	if r.code != exitFailed || r.stdout != "" || !strings.Contains(r.stderr, "openings_rejected") || !strings.Contains(r.stderr, "leaf 2: no") {
		t.Errorf("rejected openings: %+v", r)
	}
	if !strings.Contains(read(t, filepath.Join(dir, por.OpeningsFile)), `"leaf_index": 2`) || exists(filepath.Join(dir, por.ReceiptFile)) {
		t.Error("what was opened is not on record, or a receipt was written for a rejected snapshot")
	}

	// Leaves that are not the snapshot's are never opened: the directory is checked first.
	dir, platform, env = built(t)
	leaves := filepath.Join(dir, por.LeavesFile)
	os.WriteFile(leaves, []byte(strings.Replace(read(t, leaves), `"2112345678"`, `"2112345679"`, 1)), 0o600)
	r = cli(env, "submit", "--dir", dir, "--core", platform.URL, "--spot-check")
	if r.code != exitFailed || !strings.Contains(r.stderr, "not the file this snapshot was built from") || len(platform.Bodies()) != 0 {
		t.Errorf("edited leaves: %+v, %d requests with a body", r, len(platform.Bodies()))
	}
}

func TestSubmitStopsBeforeSendingWhenItShould(t *testing.T) {
	dir, platform, env := built(t)

	// No key: said here, and nothing is sent.
	for _, without := range []map[string]string{nil, {"STONEHASH_API_KEY": ""}} {
		if r := cli(without, "submit", "--dir", dir, "--core", platform.URL); r.code != exitFailed || !strings.Contains(r.stderr, "STONEHASH_API_KEY") {
			t.Errorf("no API key: %+v", r)
		}
	}
	// Signed with a key the platform does not hold.
	other := filepath.Join(t.TempDir(), "other.pem")
	keyFile(t, other)
	cli(nil, "sign", "--dir", dir, "--key", other)
	if r := cli(env, "submit", "--dir", dir, "--core", platform.URL); r.code != exitFailed || !strings.Contains(r.stderr, "not signed with the key registered") {
		t.Errorf("an unregistered key: %+v", r)
	}
	// An exchange the registry does not know.
	delete(platform.Keys, testExchange)
	if r := cli(env, "submit", "--dir", dir, "--core", platform.URL); r.code != exitFailed || !strings.Contains(r.stderr, "institution_unregistered") {
		t.Errorf("an unregistered exchange: %+v", r)
	}
	// Not signed at all.
	os.Remove(filepath.Join(dir, por.SubmissionFile))
	if r := cli(env, "submit", "--dir", dir, "--core", platform.URL); r.code != exitFailed || !strings.Contains(r.stderr, "sign the statement first") {
		t.Errorf("before signing: %+v", r)
	}
	if n := len(platform.Bodies()); n != 0 {
		t.Errorf("%d submissions were sent that should have been stopped", n)
	}
	// An anchor that is not confirmed in time: the snapshot was sent and says
	// so, the wait gives up, and the receipt still reads "pending".
	dir, platform, env = built(t)
	platform.PendingPolls = 1 << 30
	r := cli(env, "submit", "--dir", dir, "--core", platform.URL, "--wait", "--timeout-sec", "0.05")
	if r.code != exitFailed || r.stdout != "snapshot snap-1 ACCEPTED\n" || !strings.Contains(r.stderr, "anchor_timeout") ||
		!strings.Contains(read(t, filepath.Join(dir, por.ReceiptFile)), `"anchor": "pending"`) {
		t.Errorf("a wait that runs out: %+v", r)
	}
	// A platform that refuses is exit 1, with its code.
	dir, platform, env = built(t)
	platform.Override = func(r platformtest.Request) *platformtest.Answer {
		if r.Method == "POST" {
			return &platformtest.Answer{Status: 403, Body: `{"error":"subscription_required","message":"proof of reserves is not enabled for this organisation"}`}
		}
		return nil
	}
	if r := cli(env, "submit", "--dir", dir, "--core", platform.URL); r.code != exitFailed || !strings.Contains(r.stderr, "subscription_required") || !strings.Contains(r.stderr, "HTTP 403") {
		t.Errorf("a refusal: %+v", r)
	}
	if r := cli(env, "status", "--core", platform.URL, "--snapshot", "none"); r.code != exitFailed || !strings.Contains(r.stderr, "not_found") {
		t.Errorf("status of an unknown snapshot: %+v", r)
	}
}

func TestProveAndVerifyProof(t *testing.T) {
	vectors := vectorsDir(t)
	dir, _, _ := built(t)
	proof := filepath.Join(t.TempDir(), "proof.json")
	if r := cli(nil, "prove", "--dir", dir, "--user-ref", "U-100008", "--out", proof); r.code != exitOK || r.stdout != "" || r.stderr != "" {
		t.Fatalf("prove: %+v", r)
	}
	if read(t, proof) != read(t, filepath.Join(vectors, "snapshot-dir.proof-U-100008.json")) {
		t.Errorf("the proof file differs from the reference's:\n%s", read(t, proof))
	}
	statement := filepath.Join(dir, por.StatementFile)
	if r := cli(nil, "verify-proof", "--proof", proof, "--snapshot", statement); r.code != exitOK || r.stdout != "root+totals MATCH\n" || r.stderr != "" {
		t.Fatalf("verify-proof: %+v", r)
	}
	// The reference's proof against the reference's statement, too.
	if r := cli(nil, "verify-proof", "--proof", filepath.Join(vectors, "snapshot-dir.proof-U-100008.json"), "--snapshot", filepath.Join(vectors, "snapshot-dir", "snapshot.json")); r.code != exitOK || r.stdout != "root+totals MATCH\n" {
		t.Fatalf("the reference's proof: %+v", r)
	}

	altered := filepath.Join(t.TempDir(), "altered.json")
	for name, change := range map[string][2]string{
		"a balance":        {`"BTC": "2112345678"`, `"BTC": "2112345679"`},
		"a negative total": {`"USDT": "4200500000"`, `"USDT": "-4200500000"`},
		"the index":        {`"leaf_index": 3`, `"leaf_index": 2`},
		"a direction":      {`"dir": "left"`, `"dir": "right"`},
		"the salt":         {`"salt": "c9876e61`, `"salt": "09876e61`},
	} {
		text := strings.Replace(read(t, proof), change[0], change[1], 1)
		if text == read(t, proof) {
			t.Fatalf("%s: the alteration changed nothing", name)
		}
		os.WriteFile(altered, []byte(text), 0o600)
		if r := cli(nil, "verify-proof", "--proof", altered, "--snapshot", statement); r.code != exitInvalid || r.stdout != "root+totals FAIL\n" || r.stderr == "" {
			t.Errorf("%s altered: %+v", name, r)
		}
	}
	// A file that is not a proof does not hold; a file that is not there is another matter.
	os.WriteFile(altered, []byte("{}"), 0o600)
	if r := cli(nil, "verify-proof", "--proof", altered, "--snapshot", statement); r.code != exitInvalid || r.stdout != "root+totals FAIL\n" {
		t.Errorf("an empty object: %+v", r)
	}
	if r := cli(nil, "verify-proof", "--proof", altered+".missing", "--snapshot", statement); r.code != exitFailed || r.stdout != "" {
		t.Errorf("a missing proof: %+v", r)
	}
	if r := cli(nil, "verify-proof", "--proof", proof, "--snapshot", proof); r.code != exitFailed || r.stdout != "" {
		t.Errorf("a statement that is not one: %+v", r)
	}
	// A proof that holds but names another account is not this account's proof.
	os.WriteFile(altered, []byte(strings.Replace(read(t, proof), `"user_ref": "U-100008",`, `"user_ref": "U-100009",`, 1)), 0o600)
	if r := cli(nil, "verify-proof", "--proof", altered, "--snapshot", statement); r.code != exitInvalid || r.stdout != "root+totals MATCH\n" || !strings.Contains(r.stderr, "another account") {
		t.Errorf("another account's reference: %+v", r)
	}

	if r := cli(nil, "prove", "--dir", dir, "--user-ref", "nobody", "--out", altered); r.code != exitFailed || !strings.Contains(r.stderr, "unknown_account") {
		t.Errorf("an unknown account: %+v", r)
	}
	leaves := filepath.Join(dir, por.LeavesFile)
	os.WriteFile(leaves, []byte(strings.Replace(read(t, leaves), `"2112345678"`, `"2112345679"`, 1)), 0o600)
	if r := cli(nil, "prove", "--dir", dir, "--user-ref", "U-100008", "--out", altered); r.code != exitFailed || !strings.Contains(r.stderr, "not the file this snapshot was built from") {
		t.Errorf("edited leaves: %+v", r)
	}
}

func TestUsageMistakesAreSentencesAndExitOne(t *testing.T) {
	vectors := vectorsDir(t)
	csv := filepath.Join(vectors, "intake", "long.csv")
	out := filepath.Join(t.TempDir(), "never")
	base := buildArgs(csv, out)
	without := func(flag string) []string {
		var args []string
		for i := 0; i < len(base); i++ {
			if base[i] == flag {
				i++
				continue
			}
			args = append(args, base[i])
		}
		return args
	}
	with := func(flag, value string) []string { return append(without(flag), flag, value) }
	for name, c := range map[string]struct {
		args    []string
		mention string
	}{
		"no command":                     {nil, "usage:"},
		"an unknown command":             {[]string{"publish"}, `unknown command "publish"`},
		"an unknown option":              {append([]string{"build", "--cvs", csv}, base[1:]...), "cvs"},
		"a stray argument":               {append(base, "extra"), `unexpected argument "extra"`},
		"no unit":                        {without("--amounts"), "--amounts is required"},
		"a unit made up":                 {with("--amounts", "sats"), `"decimal"`},
		"no assets":                      {without("--assets"), "--assets is required"},
		"assets misspelt":                {with("--assets", "BTC,ETH:99"), "BTC:8"},
		"no exchange":                    {without("--exchange"), "--exchange is required"},
		"no output":                      {without("--out"), "--out is required"},
		"a date, not a time":             {with("--asof", "2026-11-16"), "2026-11-16T00:00:00Z"},
		"a bad building time":            {with("--generated-at", "yesterday"), "--generated-at"},
		"a short seed":                   {with("--seed-hex", "0011"), "64 hexadecimal"},
		"a layout made up":               {with("--layout", "tall"), `"long" or "wide"`},
		"a long delimiter":               {with("--delimiter", "::"), "single character"},
		"a missing export":               {with("--csv", csv+".missing"), "could not be opened"},
		"sign without a key":             {[]string{"sign", "--dir", "x"}, "--key is required"},
		"a wait of no length":            {[]string{"submit", "--dir", "x", "--core", "http://127.0.0.1:1", "--timeout-sec", "0"}, "seconds"},
		"a wait in minutes":              {[]string{"submit", "--dir", "x", "--core", "http://127.0.0.1:1", "--timeout-sec", "1m"}, "seconds"},
		"a platform URL that is not one": {[]string{"status", "--core", "attest.example", "--snapshot", "s"}, "http(s) origin"},
		"conformance nowhere":            {[]string{"conformance", "--vectors", out}, "could not be read"},
	} {
		env := map[string]string{"STONEHASH_API_KEY": testAPIKey}
		r := cli(env, c.args...)
		if r.code != exitFailed || r.stdout != "" || !strings.Contains(r.stderr, c.mention) || !strings.HasPrefix(r.stderr, "por-example: ") && name != "no command" {
			t.Errorf("%s: exit %d, stdout %q, stderr %q; want exit 1 mentioning %q", name, r.code, r.stdout, r.stderr, c.mention)
		}
		if strings.Contains(r.stderr, "goroutine ") || strings.Contains(r.stderr, testAPIKey) {
			t.Errorf("%s: stderr is not fit for a person: %q", name, r.stderr)
		}
	}
	if exists(out) {
		t.Error("a refused build wrote its directory")
	}
	for _, help := range []string{"help", "--help", "-h"} {
		if r := cli(nil, help); r.code != exitOK || !strings.HasPrefix(r.stdout, "usage: por-example") {
			t.Errorf("%s: %+v", help, r)
		}
	}
	// A key that is not one, and a statement that is not there.
	dir, _, _ := built(t)
	junk := filepath.Join(t.TempDir(), "junk.pem")
	os.WriteFile(junk, []byte("not a key"), 0o600)
	if r := cli(nil, "sign", "--dir", dir, "--key", junk); r.code != exitFailed || !strings.Contains(r.stderr, "not in PEM form") {
		t.Errorf("a junk key: %+v", r)
	}
	if r := cli(nil, "sign", "--dir", t.TempDir(), "--key", junk); r.code != exitFailed || !strings.Contains(r.stderr, "statement could not be read") {
		t.Errorf("no statement: %+v", r)
	}
}

func TestConformanceCommand(t *testing.T) {
	vectors := vectorsDir(t)
	r := cli(nil, "conformance", "--vectors", vectors)
	lines := strings.Split(strings.TrimSuffix(r.stdout, "\n"), "\n")
	if r.code != exitOK || r.stderr != "" || len(lines) != 7 {
		t.Fatalf("conformance: %+v", r)
	}
	line := regexp.MustCompile(`^(jcs|amounts|leaves|trees|statement|intake|snapshot-dir) pass [1-9]\d* fail 0$`)
	for _, text := range lines {
		if !line.MatchString(text) {
			t.Errorf("line %q", text)
		}
	}

	// Against vectors this build does not meet, it says which and exits 2.
	altered := t.TempDir()
	copyTree(t, altered, vectors)
	expected := filepath.Join(altered, "snapshot-dir.expected.json")
	os.WriteFile(expected, []byte(strings.Replace(read(t, expected), sampleRoot, strings.Repeat("0", 64), 1)), 0o644)
	r = cli(nil, "conformance", "--vectors", altered)
	if r.code != exitInvalid || !strings.Contains(r.stdout, "snapshot-dir pass 4 fail 1\n") || !strings.Contains(r.stderr, "snapshot-dir: ") || !strings.Contains(r.stderr, "database path: ") {
		t.Errorf("against altered vectors: %+v", r)
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

// The database path of this file and the file path arrive at one ledger.
func TestTheDatabasePathIsTheSameLedgerAsTheExport(t *testing.T) {
	vectors := vectorsDir(t)
	if err := databasePathAgrees(vectors); err != nil {
		t.Fatal(err)
	}
	fromQuery, report, err := ledgerFromDatabase(sampleResultSet, sampleAssets)
	if err != nil || !report.OK || report.DataRows != 20 || report.Accounts != 12 {
		t.Fatalf("%v %+v", err, report)
	}
	fromFile, fileReport, err := readExport(filepath.Join(vectors, "intake", "long.csv"), por.CSVOptions{Assets: sampleAssets, Amounts: por.Decimal})
	if err != nil || !fileReport.OK || fromFile.Len() != fromQuery.Len() {
		t.Fatalf("%v %+v", err, fileReport)
	}
	for i := 0; i < fromFile.Len(); i++ {
		a, _ := fromFile.Row(i)
		b, _ := fromQuery.Row(i)
		x, _ := json.Marshal(a)
		y, _ := json.Marshal(b)
		if string(x) != string(y) {
			t.Errorf("row %d: %s from the file, %s from the query", i, x, y)
		}
	}
	// A row the ledger refuses is reported at its place in the result set, and nothing is built.
	bad := append(append([]balanceRow{}, sampleResultSet[:5]...), balanceRow{"U-100003", "ETH", "1"}, balanceRow{"U-9", "BTC", "0.123456789"})
	ledger, report, err := ledgerFromDatabase(bad, sampleAssets)
	if err != nil || ledger != nil || report.OK || len(report.Problems) != 2 ||
		report.Problems[0].Line != 6 || report.Problems[0].Code != por.CodeDuplicateRow || report.Problems[1].Line != 7 || report.Problems[1].Code != por.CodeAmountPrecision {
		t.Errorf("%v %+v", err, report)
	}
}
