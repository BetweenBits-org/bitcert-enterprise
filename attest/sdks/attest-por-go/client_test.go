package por_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	por "stonehash.com/attest/por"
	"stonehash.com/attest/por/internal/platformtest"
)

// These tests see the SDK as a caller does: through its exported names only.

const (
	exchangeID = "KR-EX-0a1b2c"
	apiKey     = "sk_test_3f9c0b7e5a1d4c2b"
)

var assets = []por.Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}, {Symbol: "USDT", Decimals: 6}}

// exchange is one exchange's side of a snapshot: its ledger folded into a
// tree, the statement signed with its key.
type exchange struct {
	tree       *por.Tree
	submission *por.Submission
	spki       string
	accounts   []string
}

func newExchange(t *testing.T, accounts int) *exchange {
	t.Helper()
	ledger, err := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Decimal})
	if err != nil {
		t.Fatal(err)
	}
	e := &exchange{}
	for i := 0; i < accounts; i++ {
		ref := fmt.Sprintf("customer-%04d@example.test", i)
		e.accounts = append(e.accounts, ref)
		if err := ledger.AddAccount(ref, map[string]string{"BTC": fmt.Sprintf("0.%08d", i+1), "USDT": fmt.Sprint(i * 10)}); err != nil {
			t.Fatal(err)
		}
	}
	checked, report := ledger.Finish()
	if !report.OK {
		t.Fatal(report.Problems)
	}
	seed, err := por.NewSeed()
	if err != nil {
		t.Fatal(err)
	}
	if e.tree, err = por.BuildTree(exchangeID, seed, checked); err != nil {
		t.Fatal(err)
	}
	statement, err := por.NewStatement(por.StatementConfig{Name: "Sample Exchange", AsOf: "2026-11-16T00:00:00Z", Assets: assets}, e.tree, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := por.NewKeySigner(key)
	if err != nil {
		t.Fatal(err)
	}
	if e.submission, err = por.NewSubmission(statement, signer); err != nil {
		t.Fatal(err)
	}
	e.spki = signer.PublicSPKI()
	return e
}

func newPlatform(t *testing.T, e *exchange) (*platformtest.Platform, *por.Client) {
	t.Helper()
	platform := platformtest.New(t)
	platform.Keys[exchangeID] = e.spki
	client, err := por.NewClient(por.ClientConfig{BaseURL: platform.URL + "/", APIKey: apiKey, PollInterval: 2 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	return platform, client
}

// private returns everything about the exchange's accounts that must not
// travel: references, hashed references and salts.
func (e *exchange) private(t *testing.T) (references, pseudonyms []string) {
	t.Helper()
	for _, ref := range e.accounts {
		proof, err := e.tree.ProofFor(ref)
		if err != nil {
			t.Fatal(err)
		}
		references = append(references, ref)
		pseudonyms = append(pseudonyms, proof.Leaf.UserRefHash, proof.Leaf.Salt)
	}
	return references, pseudonyms
}

func apiError(t *testing.T, err error) *por.APIError {
	t.Helper()
	var refused *por.APIError
	if !errors.As(err, &refused) {
		t.Fatalf("got %v (%T), want an *por.APIError", err, err)
	}
	return refused
}

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var refusal *por.Error
	if !errors.As(err, &refusal) {
		t.Fatalf("got %v (%T), want a *por.Error", err, err)
	}
	return refusal.Code
}

func TestSubmitSendsTheStatementAndItsSignatureAndNothingElse(t *testing.T) {
	e := newExchange(t, 20)
	platform, client := newPlatform(t, e)
	ctx := context.Background()

	result, err := client.Submit(ctx, e.submission)
	if err != nil {
		t.Fatal(err)
	}
	if result.SnapshotID != "snap-1" || result.Status != por.StatusAccepted || result.AttestationID != "att-snap-1" ||
		result.SpotCheck || result.SampledAccounts != 0 || result.Already || result.Openings != nil {
		t.Errorf("result: %+v", result)
	}

	// Exactly one request with a body, and the body is the submission.
	bodies := platform.Bodies()
	if len(bodies) != 1 {
		t.Fatalf("%d requests carried a body, want 1", len(bodies))
	}
	sent := bodies[0]
	statement, _ := e.submission.Statement.MarshalJSON()
	sig, _ := e.submission.Sig.MarshalJSON()
	if want := `{"statement":` + string(statement) + `,"sig":` + string(sig) + `}`; string(sent.Body) != want {
		t.Errorf("the request body is\n %s\nwant\n %s", sent.Body, want)
	}
	if sent.Method != "POST" || sent.Path != "/v1/por/snapshots" || sent.Authorization != "Bearer "+apiKey || sent.ContentType != "application/json" {
		t.Errorf("the request: %s %s, %q, %q", sent.Method, sent.Path, sent.Authorization, sent.ContentType)
	}
	references, pseudonyms := e.private(t)
	for _, secret := range append(references, pseudonyms...) {
		if strings.Contains(string(sent.Body), secret) {
			t.Fatalf("the request carries %q: no reference, hashed reference or salt may leave by default", secret)
		}
	}

	// The same statement again is the same snapshot.
	again, err := client.Submit(ctx, e.submission)
	if err != nil || !again.Already || again.SnapshotID != result.SnapshotID {
		t.Errorf("the same submission again: %+v, %v", again, err)
	}
}

func TestRegisteredKeyNeedsNoAPIKey(t *testing.T) {
	e := newExchange(t, 2)
	platform, _ := newPlatform(t, e)
	keyless, err := por.NewClient(por.ClientConfig{BaseURL: platform.URL})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	spki, err := keyless.RegisteredKey(ctx, exchangeID)
	if err != nil || spki != e.spki {
		t.Fatalf("got %q, %v", spki, err)
	}
	if err := por.VerifyStatementSignature(e.submission.Statement, e.submission.Sig, spki); err != nil {
		t.Errorf("the submission against the registered key: %v", err)
	}
	for _, id := range []string{"KR-EX-unknown", "VN-BANK-other", ""} {
		if _, err := keyless.RegisteredKey(ctx, id); codeOf(t, err) != por.CodeInstitutionUnregistered {
			t.Errorf("institution %q: %v", id, err)
		}
	}
	// Everything else needs the key, and says so without calling.
	before := len(platform.Requests())
	if _, err := keyless.Submit(ctx, e.submission); codeOf(t, err) != por.CodeNoAPIKey {
		t.Errorf("Submit without a key: %v", err)
	}
	if _, err := keyless.Status(ctx, "snap-1"); codeOf(t, err) != por.CodeNoAPIKey {
		t.Errorf("Status without a key: %v", err)
	}
	if len(platform.Requests()) != before {
		t.Error("a call that needs a key was sent without one")
	}
}

// The registry is public: the key is not sent to it even when there is one.
func TestRegistryIsNotSentTheKey(t *testing.T) {
	e := newExchange(t, 2)
	platform, client := newPlatform(t, e)
	if _, err := client.RegisteredKey(context.Background(), exchangeID); err != nil {
		t.Fatal(err)
	}
	if got := platform.Requests()[0]; got.Path != "/v1/remit/meta" || got.Authorization != "" {
		t.Errorf("GET %s carried Authorization %q", got.Path, got.Authorization)
	}
}

func TestSpotCheckOpensTheChallengedLeavesAndNeverAReference(t *testing.T) {
	e := newExchange(t, 20)
	platform, client := newPlatform(t, e)
	platform.Challenge = []int{0, 3, 7, 19}

	result, err := client.SubmitWithSpotCheck(context.Background(), e.submission, e.tree)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != por.StatusVerified || !result.SpotCheck || result.SampledAccounts != 4 || result.AttestationID != "att-snap-1" || len(result.Openings) != 4 {
		t.Errorf("result: %+v", result)
	}

	bodies := platform.Bodies()
	if len(bodies) != 2 || bodies[0].Path != "/v1/por/snapshots" || bodies[1].Path != "/v1/por/snapshots/snap-1/openings" {
		t.Fatalf("requests with a body: %+v", bodies)
	}
	var first map[string]json.RawMessage
	if err := json.Unmarshal(bodies[0].Body, &first); err != nil || string(first["spot_check"]) != "true" || len(first) != 3 {
		t.Errorf("the first request asks for the spot check: %s", bodies[0].Body)
	}
	var second struct {
		Openings []struct {
			LeafIndex int                        `json:"leaf_index"`
			Leaf      map[string]json.RawMessage `json:"leaf"`
			Siblings  []map[string]any           `json:"siblings"`
		} `json:"openings"`
	}
	if err := json.Unmarshal(bodies[1].Body, &second); err != nil {
		t.Fatal(err)
	}
	var opened []int
	for _, o := range second.Openings {
		opened = append(opened, o.LeafIndex)
		// Pseudonymous: the hashed reference, the salt and the balances.
		if len(o.Leaf) != 3 || o.Leaf["user_ref_hash"] == nil || o.Leaf["salt"] == nil || o.Leaf["balances"] == nil {
			t.Errorf("an opened leaf has the members %v", reflect.ValueOf(o.Leaf).MapKeys())
		}
	}
	if !reflect.DeepEqual(opened, platform.Challenge) {
		t.Errorf("leaves %v were opened; %v were asked for", opened, platform.Challenge)
	}
	references, _ := e.private(t)
	for _, r := range bodies {
		for _, ref := range references {
			if strings.Contains(string(r.Body), ref) {
				t.Fatalf("%s carries the account reference %q", r.Path, ref)
			}
		}
		if strings.Contains(string(r.Body), "user_ref\"") {
			t.Fatalf("%s has a user_ref member", r.Path)
		}
	}
	// What the result says was sent is what was sent.
	record, err := json.Marshal(map[string]any{"openings": result.Openings})
	if err != nil || string(record) != string(bodies[1].Body) {
		t.Errorf("the result's openings are not the request's:\n got  %s\n want %s", record, bodies[1].Body)
	}
	// Only the challenged leaves' pseudonyms left; the other sixteen did not.
	for i, ref := range e.accounts {
		proof, _ := e.tree.ProofFor(ref)
		challenged := false
		for _, c := range platform.Challenge {
			challenged = challenged || c == proof.LeafIndex
		}
		if got := strings.Contains(string(bodies[1].Body), proof.Leaf.Salt); got != challenged {
			t.Errorf("account %d (leaf %d): its salt was sent = %v, challenged = %v", i, proof.LeafIndex, got, challenged)
		}
	}
}

func TestSpotCheckThatThePlatformRejectsStillSaysWhatWasOpened(t *testing.T) {
	e := newExchange(t, 20)
	platform, client := newPlatform(t, e)
	platform.Challenge = []int{1, 2}
	// The platform finds fault with whatever it is shown.
	platform.Override = func(r platformtest.Request) *platformtest.Answer {
		if strings.HasSuffix(r.Path, "/openings") {
			return &platformtest.Answer{Status: 422, Body: `{"snapshot_id":"snap-1","status":"REJECTED","problems":["leaf 1: the sums do not add up","leaf 2: too"]}`}
		}
		return nil
	}
	result, err := client.SubmitWithSpotCheck(context.Background(), e.submission, e.tree)
	refused := apiError(t, err)
	if refused.Status != 422 || refused.Code != "openings_rejected" || len(refused.Problems) != 2 || !strings.Contains(refused.Message, "the sums do not add up") {
		t.Errorf("the refusal: %+v", refused)
	}
	if result == nil || result.SnapshotID != "snap-1" || result.Status != por.StatusRejected || len(result.Openings) != 2 || result.AttestationID != "" {
		t.Errorf("what left the machine has to be on record even so: %+v", result)
	}
}

func TestSpotCheckRefusesAChallengeItShouldNotAnswer(t *testing.T) {
	e := newExchange(t, 20)
	for name, c := range map[string]struct {
		challenge string
		code      string
	}{
		"more leaves than a sample":    {`[0,1,2,3,4,5,6,7,8]`, por.CodeChallengeRefused},
		"the whole ledger":             {`[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]`, por.CodeChallengeRefused},
		"a position outside the tree":  {`[0,20]`, por.CodeUnexpectedResponse},
		"a negative position":          {`[-1]`, por.CodeUnexpectedResponse},
		"a position twice":             {`[4,4]`, por.CodeUnexpectedResponse},
		"a position that is no number": {`["4"]`, por.CodeUnexpectedResponse},
		"a fractional position":        {`[1.5]`, por.CodeUnexpectedResponse},
		"no position":                  {`[]`, por.CodeUnexpectedResponse},
		"no list":                      {`null`, por.CodeUnexpectedResponse},
	} {
		platform, client := newPlatform(t, e)
		platform.Override = func(r platformtest.Request) *platformtest.Answer {
			if r.Path == "/v1/por/snapshots" {
				return &platformtest.Answer{Status: 201, Body: `{"snapshot_id":"snap-9","status":"CHALLENGED","spot_check":true,"challenge":{"indices":` + c.challenge + `}}`}
			}
			return nil
		}
		result, err := client.SubmitWithSpotCheck(context.Background(), e.submission, e.tree)
		if result != nil || codeOf(t, err) != c.code {
			t.Errorf("%s: %+v, %v; want %s", name, result, err, c.code)
		}
		if len(platform.Bodies()) != 1 {
			t.Errorf("%s: something was sent in answer to the challenge", name)
		}
	}
	if por.MaxSpotCheckLeaves != 8 {
		t.Errorf("the SDK opens at most %d leaves; the README says eight", por.MaxSpotCheckLeaves)
	}

	// A tree that is not the statement's is not opened at all.
	other := newExchange(t, 20)
	platform, client := newPlatform(t, e)
	result, err := client.SubmitWithSpotCheck(context.Background(), e.submission, other.tree)
	if result != nil || codeOf(t, err) != por.CodeTreeMismatch || len(platform.Requests()) != 0 {
		t.Errorf("another tree: %+v, %v, %d requests", result, err, len(platform.Requests()))
	}
	if _, err := client.SubmitWithSpotCheck(context.Background(), e.submission, nil); codeOf(t, err) != por.CodeInvalidOption {
		t.Errorf("no tree: %v", err)
	}
}

func TestSubmissionsThePlatformAnswersUnexpectedly(t *testing.T) {
	e := newExchange(t, 4)
	for name, c := range map[string]struct {
		body string
		code string
	}{
		"a challenge nobody asked for": {`{"snapshot_id":"s","status":"CHALLENGED","spot_check":true,"challenge":{"indices":[0]}}`, por.CodeSpotCheckRequired},
		"accepted without a record":    {`{"snapshot_id":"s","status":"ACCEPTED"}`, por.CodeUnexpectedResponse},
		"another state":                {`{"snapshot_id":"s","status":"QUEUED","attestation_id":"a"}`, por.CodeUnexpectedResponse},
		"no snapshot id":               {`{"status":"ACCEPTED","attestation_id":"a"}`, por.CodeUnexpectedResponse},
		"not an object":                {`[]`, por.CodeUnexpectedResponse},
		"not JSON":                     {`<html>ok</html>`, por.CodeUnexpectedResponse},
		"nothing":                      {``, por.CodeUnexpectedResponse},
	} {
		platform, client := newPlatform(t, e)
		platform.Override = func(platformtest.Request) *platformtest.Answer {
			return &platformtest.Answer{Status: 201, Body: c.body}
		}
		if result, err := client.Submit(context.Background(), e.submission); result != nil || codeOf(t, err) != c.code {
			t.Errorf("%s: %+v, %v; want %s", name, result, err, c.code)
		}
	}
	// With a spot check asked for, an answer without a challenge opens nothing.
	platform, client := newPlatform(t, e)
	platform.Override = func(platformtest.Request) *platformtest.Answer {
		return &platformtest.Answer{Status: 200, Body: `{"snapshot_id":"s","status":"ACCEPTED","attestation_id":"a","already":true}`}
	}
	if result, err := client.SubmitWithSpotCheck(context.Background(), e.submission, e.tree); result != nil || codeOf(t, err) != por.CodeUnexpectedResponse {
		t.Errorf("no challenge: %+v, %v", result, err)
	}
	if len(platform.Bodies()) != 1 {
		t.Error("something was opened without a challenge")
	}
}

func TestRefusalsCarryStatusCodeAndMessage(t *testing.T) {
	e := newExchange(t, 4)
	for name, c := range map[string]struct {
		answer  platformtest.Answer
		status  int
		code    string
		message string
	}{
		"a named refusal":         {platformtest.Answer{Status: 400, Body: `{"error":"invalid_statement","message":"tree.root must be 64 lowercase hex"}`}, 400, "invalid_statement", "tree.root must be 64 lowercase hex"},
		"no subscription":         {platformtest.Answer{Status: 403, Body: `{"error":"subscription_required","message":"proof of reserves is not enabled"}`}, 403, "subscription_required", "proof of reserves is not enabled"},
		"a conflict":              {platformtest.Answer{Status: 409, Body: `{"error":"wrong_state","message":"snapshot is VERIFIED"}`}, 409, "wrong_state", "snapshot is VERIFIED"},
		"a refusal with no words": {platformtest.Answer{Status: 401, Body: `{"error":"unauthorized"}`}, 401, "unauthorized", "HTTP 401"},
		"a proxy's error page":    {platformtest.Answer{Status: 502, Body: `<html>Bad Gateway</html>`}, 502, "error", "HTTP 502"},
		"an empty failure":        {platformtest.Answer{Status: 500}, 500, "error", "HTTP 500"},
		"a redirect":              {platformtest.Answer{Status: 307, Body: `{}`}, 307, "redirect", "not followed"},
	} {
		platform, client := newPlatform(t, e)
		answer := c.answer
		platform.Override = func(platformtest.Request) *platformtest.Answer { return &answer }
		_, err := client.Submit(context.Background(), e.submission)
		refused := apiError(t, err)
		if refused.Status != c.status || refused.Code != c.code || !strings.Contains(refused.Message, c.message) {
			t.Errorf("%s: %+v", name, refused)
		}
		if !strings.Contains(err.Error(), c.code) || !strings.Contains(err.Error(), fmt.Sprint(c.status)) {
			t.Errorf("%s: the error reads %q", name, err)
		}
	}
	// The real refusals of the stand-in, end to end.
	platform, client := newPlatform(t, e)
	platform.Keys[exchangeID] = newExchange(t, 1).spki
	_, err := client.Submit(context.Background(), e.submission)
	if refused := apiError(t, err); refused.Status != 400 || refused.Code != "invalid_signature" {
		t.Errorf("signed with a key the platform does not hold: %+v", refused)
	}
	delete(platform.Keys, exchangeID)
	_, err = client.Submit(context.Background(), e.submission)
	if refused := apiError(t, err); refused.Status != 403 || refused.Code != "institution_mismatch" {
		t.Errorf("an unregistered exchange: %+v", refused)
	}
	_, err = client.Status(context.Background(), "snap-404")
	if refused := apiError(t, err); refused.Status != 404 || refused.Code != "not_found" {
		t.Errorf("an unknown snapshot: %+v", refused)
	}
}

func TestEveryRequestOpensItsOwnConnection(t *testing.T) {
	e := newExchange(t, 12)
	platform, client := newPlatform(t, e)
	platform.Challenge = []int{5}
	ctx := context.Background()
	client.RegisteredKey(ctx, exchangeID)
	result, err := client.SubmitWithSpotCheck(ctx, e.submission, e.tree)
	if err != nil {
		t.Fatal(err)
	}
	client.Status(ctx, result.SnapshotID)
	client.WaitAnchored(ctx, result.SnapshotID, time.Second)
	requests := platform.Requests()
	if len(requests) != 5 || platform.Connections() != len(requests) {
		t.Errorf("%d requests over %d connections; each request should open its own", len(requests), platform.Connections())
	}
	for _, r := range requests {
		if !r.Close {
			t.Errorf("%s %s did not ask for its connection to be closed", r.Method, r.Path)
		}
	}

	// The same holds over a caller's own HTTP client, pooled as Go's default is.
	platform, _ = newPlatform(t, e)
	own, err := por.NewClient(por.ClientConfig{BaseURL: platform.URL, APIKey: apiKey, HTTPClient: &http.Client{}})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if _, err := own.RegisteredKey(ctx, exchangeID); err != nil {
			t.Fatal(err)
		}
	}
	if platform.Connections() != 4 {
		t.Errorf("4 requests over a caller's client used %d connections", platform.Connections())
	}
}

func TestPathParametersAreEscaped(t *testing.T) {
	e := newExchange(t, 2)
	platform, client := newPlatform(t, e)
	id := "a/b c?d#e%2F../é"
	client.Status(context.Background(), id)
	const escaped = "a%2Fb%20c%3Fd%23e%252F..%2F%C3%A9"
	if got := platform.Requests()[0].Path; got != "/v1/por/snapshots/"+escaped {
		t.Errorf("the request went to %s", got)
	}
	if got, want := client.PublicURL(id), platform.URL+"/v1/public/por/snapshots/"+escaped; got != want {
		t.Errorf("PublicURL: %s, want %s", got, want)
	}
	if client.BaseURL() != platform.URL {
		t.Errorf("BaseURL %q keeps the trailing slash it was given", client.BaseURL())
	}
}

// The key is in the Authorization header and nowhere else: not in an error,
// not in what a client or its configuration prints as.
func TestTheAPIKeyStaysOutOfErrorsAndOutput(t *testing.T) {
	e := newExchange(t, 4)
	ctx := context.Background()
	var said []string
	say := func(err error) {
		t.Helper()
		if err == nil {
			t.Fatal("expected an error")
		}
		said = append(said, err.Error(), fmt.Sprintf("%v|%+v|%#v|%q", err, err, err, err))
	}

	platform, client := newPlatform(t, e)
	platform.Override = func(r platformtest.Request) *platformtest.Answer {
		// A platform that echoes nothing back; the client must not add it either.
		return &platformtest.Answer{Status: 401, Body: `{"error":"unauthorized","message":"the API key is not valid"}`}
	}
	_, err := client.Submit(ctx, e.submission)
	say(err)
	_, err = client.Status(ctx, "snap-1")
	say(err)
	_, err = client.SubmitWithSpotCheck(ctx, e.submission, e.tree)
	say(err)
	_, err = client.WaitAnchored(ctx, "snap-1", time.Second)
	say(err)

	// A platform that is not there.
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	unreachable, _ := por.NewClient(por.ClientConfig{BaseURL: gone.URL, APIKey: apiKey})
	_, err = unreachable.Submit(ctx, e.submission)
	if say(err); codeOf(t, err) != por.CodeUnreachable {
		t.Errorf("an unreachable platform: %v", err)
	}
	// A platform that does not answer in time.
	platform, _ = newPlatform(t, e)
	var waiting atomic.Int32
	platform.Override = func(platformtest.Request) *platformtest.Answer {
		waiting.Add(1)
		time.Sleep(300 * time.Millisecond)
		return &platformtest.Answer{Status: 200, Body: `{}`}
	}
	impatient, _ := por.NewClient(por.ClientConfig{BaseURL: platform.URL, APIKey: apiKey, RequestTimeout: 20 * time.Millisecond})
	_, err = impatient.Submit(ctx, e.submission)
	if say(err); codeOf(t, err) != por.CodeUnreachable || !errors.Is(err, context.DeadlineExceeded) || waiting.Load() != 1 {
		t.Errorf("a slow platform: %v", err)
	}
	// A key that cannot be sent is refused without being repeated.
	for _, bad := range []string{apiKey + "\n", "sk test", apiKey + "\r\nX-Injected: 1", "sk_é"} {
		_, err := por.NewClient(por.ClientConfig{BaseURL: platform.URL, APIKey: bad})
		if say(err); codeOf(t, err) != por.CodeInvalidOption {
			t.Errorf("key %q: %v", bad, err)
		}
	}
	// Credentials pasted into the URL are refused without being repeated.
	_, err = por.NewClient(por.ClientConfig{BaseURL: "https://user:" + apiKey + "@attest.example", APIKey: apiKey})
	say(err)
	_, err = por.NewClient(por.ClientConfig{BaseURL: "https://attest.example/?key=" + apiKey, APIKey: apiKey})
	say(err)

	cfg := por.ClientConfig{BaseURL: platform.URL, APIKey: apiKey}
	printed, _ := json.Marshal(cfg)
	said = append(said, fmt.Sprintf("%v|%+v|%#v|%s", client, client, client, client), fmt.Sprintf("%v|%+v|%#v|%s", *client, *client, *client, *client),
		fmt.Sprintf("%v|%+v|%#v|%s", cfg, cfg, cfg, cfg), fmt.Sprintf("%v|%+v", &cfg, &cfg), string(printed))
	for _, text := range said {
		if strings.Contains(text, apiKey) || strings.Contains(text, apiKey[3:]) {
			t.Errorf("the API key appears in %q", text)
		}
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	e := newExchange(t, 2)
	elsewhere, _ := newPlatform(t, e)
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirecting.Close()

	for name, httpClient := range map[string]*http.Client{"the SDK's own": nil, "a caller's": {}} {
		client, _ := por.NewClient(por.ClientConfig{BaseURL: redirecting.URL, APIKey: apiKey, HTTPClient: httpClient})
		_, err := client.Submit(context.Background(), e.submission)
		if refused := apiError(t, err); refused.Status != 307 || refused.Code != "redirect" {
			t.Errorf("over %s HTTP client: %+v", name, refused)
		}
		if httpClient != nil && httpClient.CheckRedirect != nil {
			t.Error("the caller's HTTP client was changed")
		}
	}
	if n := len(elsewhere.Requests()); n != 0 {
		t.Errorf("%d requests, with the key, followed the redirect to another address", n)
	}
}

func TestStatusAndWaitAnchored(t *testing.T) {
	e := newExchange(t, 6)
	platform, client := newPlatform(t, e)
	ctx := context.Background()
	result, err := client.Submit(ctx, e.submission)
	if err != nil {
		t.Fatal(err)
	}
	platform.PendingPolls = 3

	status, err := client.Status(ctx, result.SnapshotID)
	if err != nil {
		t.Fatal(err)
	}
	statement := e.submission.Statement
	if status.SnapshotID != "snap-1" || status.Status != por.StatusAccepted || status.SpotCheck || status.Root != statement.Root() ||
		status.LeafCount != 6 || status.Commitment != statement.Commitment() || status.AttestationID != "att-snap-1" ||
		status.AnchorStatus != "pending" || status.Anchored() || status.Totals.Amount("USDT").String() != statement.Totals().Amount("USDT").String() {
		t.Errorf("status: %+v", status)
	}
	// The whole answer is kept, the members this version does not read included.
	if !strings.Contains(string(status.Raw), `"created_at": "2026-11-16T01:00:00.000Z"`) || !json.Valid(status.Raw) {
		t.Errorf("the raw answer: %s", status.Raw)
	}

	anchored, err := client.WaitAnchored(ctx, result.SnapshotID, 5*time.Second)
	if err != nil || !anchored.Anchored() || anchored.AnchorStatus != por.AnchorConfirmed {
		t.Fatalf("waiting: %+v, %v", anchored, err)
	}
	if polls := len(platform.Requests()) - 2; polls != 3 {
		t.Errorf("%d status calls while waiting, want 3 (two pending, then confirmed)", polls)
	}

	// Not confirmed in time is a timeout, and waiting again is safe.
	platform.PendingPolls = 1 << 30
	_, err = client.WaitAnchored(ctx, result.SnapshotID, 15*time.Millisecond)
	if codeOf(t, err) != por.CodeAnchorTimeout {
		t.Errorf("a wait that runs out: %v", err)
	}
	// The caller's context ends a wait at once.
	cancelled, cancel := context.WithCancel(ctx)
	go func() { time.Sleep(10 * time.Millisecond); cancel() }()
	started := time.Now()
	_, err = client.WaitAnchored(cancelled, result.SnapshotID, time.Minute)
	if !errors.Is(err, context.Canceled) || time.Since(started) > 5*time.Second {
		t.Errorf("a cancelled wait: %v after %s", err, time.Since(started))
	}
	// A rejected snapshot will never be anchored; the wait says so instead of running out.
	platform.Override = func(platformtest.Request) *platformtest.Answer {
		return &platformtest.Answer{Status: 200, Body: `{"snapshot_id":"snap-1","status":"REJECTED","spot_check":true,"attestation":null,"ratio":0.25}`}
	}
	_, err = client.WaitAnchored(ctx, result.SnapshotID, time.Minute)
	if codeOf(t, err) != por.CodeSnapshotRejected {
		t.Errorf("a rejected snapshot: %v", err)
	}
	rejected, err := client.Status(ctx, result.SnapshotID)
	if err != nil || rejected.AttestationID != "" || rejected.Anchored() || !strings.Contains(string(rejected.Raw), `"ratio": 0.25`) {
		t.Errorf("a status with no anchoring record and a fraction in it: %+v, %v", rejected, err)
	}
	for name, body := range map[string]string{
		"no status":                 `{"snapshot_id":"s"}`,
		"a total that is a number":  `{"snapshot_id":"s","status":"ACCEPTED","totals":{"BTC":5}}`,
		"a leaf count that is text": `{"snapshot_id":"s","status":"ACCEPTED","leaf_count":"12"}`,
		"an oversized answer":       `{"snapshot_id":"s","status":"ACCEPTED","pad":"` + strings.Repeat("x", 9<<20) + `"}`,
	} {
		answer := body
		platform.Override = func(platformtest.Request) *platformtest.Answer {
			return &platformtest.Answer{Status: 200, Body: answer}
		}
		if got, err := client.Status(ctx, "s"); got != nil || codeOf(t, err) != por.CodeUnexpectedResponse {
			t.Errorf("%s: %+v, %v", name, got, err)
		}
	}
}

func TestNewClientChecksItsConfiguration(t *testing.T) {
	for _, base := range []string{"", "attest.example", "ftp://attest.example", "https://", "https://attest.example/#frag", "https://attest.example?x=1", "://nope", "https://user@attest.example"} {
		if _, err := por.NewClient(por.ClientConfig{BaseURL: base, APIKey: apiKey}); codeOf(t, err) != por.CodeInvalidOption {
			t.Errorf("base URL %q: %v", base, err)
		}
	}
	for _, cfg := range []por.ClientConfig{
		{BaseURL: "https://attest.example", RequestTimeout: -time.Second},
		{BaseURL: "https://attest.example", PollInterval: -time.Second},
	} {
		if _, err := por.NewClient(cfg); codeOf(t, err) != por.CodeInvalidOption {
			t.Errorf("%v: %v", cfg, err)
		}
	}
	client, err := por.NewClient(por.ClientConfig{BaseURL: "https://attest.example/base///"})
	if err != nil || client.BaseURL() != "https://attest.example/base" || client.PublicURL("s1") != "https://attest.example/base/v1/public/por/snapshots/s1" {
		t.Errorf("a base URL with a path: %v, %v", client, err)
	}
	if _, err := client.Submit(context.Background(), nil); codeOf(t, err) != por.CodeInvalidSubmission {
		t.Errorf("no submission: %v", err)
	}
	if _, err := client.Submit(context.Background(), &por.Submission{}); codeOf(t, err) != por.CodeInvalidSubmission {
		t.Errorf("an empty submission: %v", err)
	}
}

// The seed of a tree is not something a statement, a submission or a proof
// can give away.
func TestNothingSentOrIssuedContainsTheSeed(t *testing.T) {
	seed, _ := por.NewSeed()
	ledger, _ := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Base})
	ledger.Add("only", "BTC", "5")
	checked, _ := ledger.Finish()
	tree, err := por.BuildTree(exchangeID, seed, checked)
	if err != nil {
		t.Fatal(err)
	}
	statement, _ := por.NewStatement(por.StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: assets}, tree, time.Now())
	proof, _ := tree.ProofFor("only")
	text, _ := json.Marshal([]any{statement, proof})
	if strings.Contains(string(text), hex.EncodeToString(seed)) || strings.Contains(fmt.Sprintf("%v %+v", tree, statement), hex.EncodeToString(seed)) {
		t.Error("the seed appears in what is issued")
	}
}
