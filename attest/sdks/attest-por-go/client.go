package por

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"stonehash.com/attest/por/internal/cjson"
)

// The exchange's side of the platform API (specification §9).
//
// What is transmitted, in full:
//
//   - by default, the statement and its signature: root, totals, the number
//     of accounts, the as-of time. No account, no balance, no leaf. The
//     platform checks the signature and anchors.
//   - with a spot check, the same, and then — for the leaves the platform
//     picks at random, eight at most — each one's hashed reference, salt and
//     balances, with the sums beside it up the tree. That is account-level
//     data leaving the building, pseudonymously, which is why a spot check
//     is something the exchange asks for and not something it gets.
//
// The tree and every account reference stay in this process either way.

// MaxSpotCheckLeaves is the most leaves this SDK opens in answer to one
// challenge. The platform asks for eight; a challenge asking for more is
// refused, so that a fault on the other side cannot turn a sample into an
// export of the ledger.
const MaxSpotCheckLeaves = 8

const (
	defaultRequestTimeout = 30 * time.Second
	defaultPollInterval   = 2 * time.Second
	// maxResponseBytes bounds what is read of an answer. The largest answer
	// of the API is a few kilobytes.
	maxResponseBytes = 8 << 20
)

// ClientConfig says where the platform is and how to reach it.
type ClientConfig struct {
	// BaseURL is the deployment's origin, such as https://attest.example.
	BaseURL string
	// APIKey authenticates the exchange. It may be empty for a client that
	// only reads the key registry or builds public URLs. It is sent in the
	// Authorization header of the calls that need it and nowhere else: it is
	// in no URL, no error and no log.
	APIKey string `json:"-"`
	// HTTPClient, when set, carries the requests — for an outbound proxy, a
	// private certificate authority or client certificates. Redirects are
	// never followed whatever it says, so the key is not sent to an address
	// the caller did not name, and every request closes its connection.
	HTTPClient *http.Client
	// RequestTimeout bounds one request. Zero means 30 seconds.
	RequestTimeout time.Duration
	// PollInterval is the pause between status calls while waiting for an
	// anchor. Zero means 2 seconds.
	PollInterval time.Duration
}

// String describes the configuration without the API key, so that a
// configuration that ends up in a log line does not take the key with it.
func (c ClientConfig) String() string {
	state := "no API key"
	if c.APIKey != "" {
		state = "API key set"
	}
	return fmt.Sprintf("por.ClientConfig{BaseURL: %q, %s}", c.BaseURL, state)
}

// GoString is String: the %#v form does not print the key either.
func (c ClientConfig) GoString() string { return c.String() }

// Client talks to the platform. It is safe for concurrent use.
type Client struct {
	base    string
	apiKey  string
	http    *http.Client
	timeout time.Duration
	poll    time.Duration
}

// String names the client by the platform it talks to, and by nothing else.
// It and GoString have value receivers so that a client printed through a
// pointer or as a copy is covered alike.
func (c Client) String() string { return "por.Client(" + c.base + ")" }

// GoString is String: the %#v form does not print the key either.
func (c Client) GoString() string { return c.String() }

// APIError is a refusal by the platform: the HTTP status it answered with,
// its error code and its message.
//
// Codes worth handling by name: invalid_statement, invalid_signature,
// invalid_field (400); subscription_required, institution_mismatch (403);
// wrong_state, challenge_expired (409). A spot check whose openings the
// platform rejects is status 422 with code "openings_rejected" and the
// platform's reasons in Problems.
type APIError struct {
	Status   int
	Code     string
	Message  string
	Problems []string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("the platform refused (%s, HTTP %d): %s", e.Code, e.Status, e.Message)
}

// NewClient checks the configuration and returns a client. No request is made.
func NewClient(cfg ClientConfig) (*Client, error) {
	base := strings.TrimRight(cfg.BaseURL, "/")
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		// The URL is not echoed: a malformed one is where a pasted credential ends up.
		return nil, errorf(CodeInvalidOption, "the platform URL must be an http(s) origin such as https://attest.example, with no credentials, query or fragment")
	}
	for i := 0; i < len(cfg.APIKey); i++ {
		if c := cfg.APIKey[i]; c <= ' ' || c >= 0x7F {
			return nil, errorf(CodeInvalidOption, "the API key contains a character that cannot be sent in a header (check for a line break or a space around it)")
		}
	}
	if cfg.RequestTimeout < 0 || cfg.PollInterval < 0 {
		return nil, errorf(CodeInvalidOption, "timeouts cannot be negative")
	}
	c := &Client{base: base, apiKey: cfg.APIKey, timeout: cfg.RequestTimeout, poll: cfg.PollInterval}
	if c.timeout == 0 {
		c.timeout = defaultRequestTimeout
	}
	if c.poll == 0 {
		c.poll = defaultPollInterval
	}
	if cfg.HTTPClient != nil {
		// A copy, so the caller's client keeps its own redirect policy.
		own := *cfg.HTTPClient
		c.http = &own
	} else {
		c.http = &http.Client{Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			// One connection per request. Calls here are minutes apart at a
			// large ledger — a tree is rebuilt between two of them — and the
			// platform closes idle connections after five seconds. This
			// client makes a handful of calls a day; reuse buys nothing.
			DisableKeepAlives: true,
		}}
	}
	c.http.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return c, nil
}

// PublicURL returns the address of a snapshot's public verification material.
func (c *Client) PublicURL(snapshotID string) string {
	return c.base + "/v1/public/por/snapshots/" + url.PathEscape(snapshotID)
}

// BaseURL returns the platform's origin as the client uses it.
func (c *Client) BaseURL() string { return c.base }

// call makes one request and returns the answer's status and JSON body.
// A status of 300 or above is returned as an *APIError.
func (c *Client) call(ctx context.Context, method, path string, authenticated bool, body any) (int, reader, error) {
	if authenticated && c.apiKey == "" {
		return 0, reader{}, errorf(CodeNoAPIKey, "this call needs an API key and the client was given none")
	}
	var payload io.Reader
	if body != nil {
		text, err := cjson.Compact(body)
		if err != nil {
			return 0, reader{}, wrap(CodeInvalidJSON, err, "the request cannot be written")
		}
		payload = bytes.NewReader(text)
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, payload)
	if err != nil {
		return 0, reader{}, errorf(CodeInvalidOption, "the request to %s could not be formed", path)
	}
	// Whatever the transport: the connection is not kept for the next call.
	req.Close = true
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	res, err := c.http.Do(req)
	if err != nil {
		// net/http reports the method and the URL, never a header.
		return 0, reader{}, wrap(CodeUnreachable, err, "no answer from the platform")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return 0, reader{}, wrap(CodeUnreachable, err, "the platform's answer to %s %s broke off", method, path)
	}
	if len(raw) > maxResponseBytes {
		return 0, reader{}, errorf(CodeUnexpectedResponse, "the answer to %s %s is larger than %d bytes", method, path, maxResponseBytes)
	}
	answer, parseErr := parseDocument(raw, CodeUnexpectedResponse, "")

	if res.StatusCode >= 300 {
		return res.StatusCode, reader{}, refusalFrom(res.StatusCode, answer, parseErr == nil)
	}
	if parseErr != nil {
		return res.StatusCode, reader{}, errorf(CodeUnexpectedResponse, "the answer to %s %s (HTTP %d) is not a JSON object", method, path, res.StatusCode)
	}
	return res.StatusCode, answer, nil
}

// refusalFrom turns an answer of 300 or above into an *APIError. The platform
// writes { "error": code, "message": text }; a rejected spot check is
// { "status": "REJECTED", "problems": [...] } instead.
func refusalFrom(status int, answer reader, isJSON bool) *APIError {
	e := &APIError{Status: status, Code: "error", Message: fmt.Sprintf("HTTP %d", status)}
	if status < 400 {
		e.Code = "redirect"
		e.Message = fmt.Sprintf("HTTP %d: the platform answered with a redirect, which is not followed", status)
		return e
	}
	if !isJSON {
		return e
	}
	if code, err := answer.str("error"); err == nil && code != "" {
		e.Code = code
	}
	if message, err := answer.str("message"); err == nil && message != "" {
		e.Message = message
	}
	if state, err := answer.str("status"); err == nil && state == "REJECTED" {
		e.Code = "openings_rejected"
		if problems, err := answer.array("problems"); err == nil {
			for _, p := range problems {
				if text, ok := p.(string); ok {
					e.Problems = append(e.Problems, text)
				}
			}
		}
		e.Message = "the platform rejected the openings"
		if len(e.Problems) > 0 {
			e.Message += ": " + strings.Join(e.Problems, "; ")
		}
	}
	return e
}

// RegisteredKey returns the public key the platform will check an exchange's
// signatures against: SubjectPublicKeyInfo DER, base64. It needs no API key.
func (c *Client) RegisteredKey(ctx context.Context, institutionID string) (string, error) {
	_, meta, err := c.call(ctx, http.MethodGet, "/v1/remit/meta", false, nil)
	if err != nil {
		return "", err
	}
	institutions, refusal := meta.array("institutions")
	if refusal != nil {
		return "", refusal
	}
	for i, item := range institutions {
		inst, refusal := meta.item("institutions", i, item)
		if refusal != nil {
			return "", refusal
		}
		if id, _ := inst.str("id"); id != institutionID {
			continue
		}
		if spki, _ := inst.optStr("signing_spki"); spki != "" {
			return spki, nil
		}
		break
	}
	return "", errorf(CodeInstitutionUnregistered, "%s has no signing key in the platform's registry", quote(institutionID))
}

// SubmitResult is the platform's answer to a submission.
type SubmitResult struct {
	SnapshotID    string
	AttestationID string
	// Status is ACCEPTED when the statement was anchored on its signature
	// alone, VERIFIED when a spot check passed first.
	Status string
	// SpotCheck is true when leaves were opened to the platform.
	SpotCheck bool
	// SampledAccounts is how many: zero unless SpotCheck.
	SampledAccounts int
	// Already is true when the platform held this exact statement and
	// answered with the earlier record.
	Already bool
	// Openings is exactly what was sent in answer to a challenge: the
	// account-level data that left the building. It is nil without one.
	Openings []*Proof
}

// Snapshot states (specification §9).
const (
	StatusAccepted   = "ACCEPTED"
	StatusChallenged = "CHALLENGED"
	StatusVerified   = "VERIFIED"
	StatusRejected   = "REJECTED"
)

func submissionBody(sub *Submission, spotCheck bool) cjson.Object {
	body := cjson.Object{
		{Key: "statement", Value: sub.Statement.doc},
		{Key: "sig", Value: sub.Sig.value()},
	}
	if spotCheck {
		body = append(body, cjson.Member{Key: "spot_check", Value: true})
	}
	return body
}

// Submit hands a signed statement to the platform. The statement and its
// signature are all that is sent. It returns once the platform has accepted
// the statement for anchoring; WaitAnchored follows the anchor from there.
func (c *Client) Submit(ctx context.Context, sub *Submission) (*SubmitResult, error) {
	if err := sub.check(); err != nil {
		return nil, err
	}
	status, answer, err := c.call(ctx, http.MethodPost, "/v1/por/snapshots", true, submissionBody(sub, false))
	if err != nil {
		return nil, err
	}
	result, refusal := submissionAnswer(answer)
	if refusal != nil {
		return nil, refusal
	}
	if result.Status == StatusChallenged {
		return nil, errorf(CodeSpotCheckRequired, "the platform answered with a challenge to a submission that did not ask for a spot check; snapshot %s was not anchored", quote(result.SnapshotID))
	}
	if result.Status != StatusAccepted || result.AttestationID == "" {
		return nil, errorf(CodeUnexpectedResponse, "the platform answered HTTP %d with status %s and no anchoring record", status, quote(result.Status))
	}
	return result, nil
}

// submissionAnswer reads what both kinds of submission are first answered
// with: the snapshot's id and state, and its anchoring record if it has one.
func submissionAnswer(answer reader) (*SubmitResult, *Error) {
	result := &SubmitResult{}
	var err *Error
	if result.SnapshotID, err = answer.str("snapshot_id"); err != nil {
		return nil, err
	}
	if result.Status, err = answer.str("status"); err != nil {
		return nil, err
	}
	if result.AttestationID, err = answer.optStr("attestation_id"); err != nil {
		return nil, err
	}
	already, _ := answer.obj.Get("already")
	result.Already = already == true
	return result, nil
}

// SubmitWithSpotCheck hands a signed statement to the platform and asks it to
// sample the tree before anchoring. The platform answers with a challenge —
// up to eight leaf positions — and the challenge is answered from the local
// tree with one inclusion proof per position. Each proof opens that leaf's
// hashed reference, salt and balances; none contains an account reference.
// The result's Openings is exactly what was sent.
//
// Nothing is sent if the tree is not the one the statement commits to, and
// nothing is opened if the challenge asks for more than MaxSpotCheckLeaves
// leaves.
//
// When the error is non-nil and the result is too, the openings were handed
// to the network but the platform did not confirm the snapshot: the result
// then says what left the machine (Openings) and for which snapshot, so that
// it can be recorded all the same.
func (c *Client) SubmitWithSpotCheck(ctx context.Context, sub *Submission, tree *Tree) (*SubmitResult, error) {
	if err := sub.check(); err != nil {
		return nil, err
	}
	if tree == nil {
		return nil, errorf(CodeInvalidOption, "a spot check is answered from the local tree")
	}
	if err := sub.Statement.matches(tree); err != nil {
		return nil, err
	}
	_, answer, err := c.call(ctx, http.MethodPost, "/v1/por/snapshots", true, submissionBody(sub, true))
	if err != nil {
		return nil, err
	}
	result, refusal := submissionAnswer(answer)
	if refusal != nil {
		return nil, refusal
	}
	if result.Status != StatusChallenged {
		return nil, errorf(CodeUnexpectedResponse, "a spot check was asked for and the platform answered %s without a challenge (snapshot %s)",
			quote(result.Status), quote(result.SnapshotID))
	}
	indices, refusal := challengeFrom(answer, tree.LeafCount())
	if refusal != nil {
		return nil, refusal
	}

	result.Openings = make([]*Proof, len(indices))
	sent := make([]any, len(indices))
	for i, index := range indices {
		p, err := tree.Proof(index)
		if err != nil {
			return nil, err
		}
		// Tree.Proof never carries a reference; this is the last line before
		// the wire, and it does not depend on that.
		result.Openings[i] = p.pseudonymous()
		sent[i] = result.Openings[i].value()
	}
	// From here on the openings have left the machine, whatever comes back.
	result.SpotCheck = true
	result.SampledAccounts = len(indices)
	_, answer, err = c.call(ctx, http.MethodPost, "/v1/por/snapshots/"+url.PathEscape(result.SnapshotID)+"/openings", true,
		cjson.Object{{Key: "openings", Value: sent}})
	if err != nil {
		var refused *APIError
		if errors.As(err, &refused) && refused.Code == "openings_rejected" {
			result.Status = StatusRejected
		}
		return result, err
	}
	state, refusal := answer.str("status")
	if refusal != nil {
		return result, refusal
	}
	if result.AttestationID, refusal = answer.optStr("attestation_id"); refusal != nil {
		return result, refusal
	}
	if state != StatusVerified || result.AttestationID == "" {
		return result, errorf(CodeUnexpectedResponse, "the platform answered the openings with status %s and no anchoring record", quote(state))
	}
	result.Status = state
	return result, nil
}

// challengeFrom reads the leaf positions the platform asks to see, refusing a
// challenge this SDK will not answer.
func challengeFrom(answer reader, leafCount int) ([]int, *Error) {
	challenge, err := answer.object("challenge")
	if err != nil {
		return nil, err
	}
	items, err := challenge.array("indices")
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, errorf(CodeUnexpectedResponse, "the challenge names no leaf")
	}
	if len(items) > MaxSpotCheckLeaves {
		return nil, errorf(CodeChallengeRefused, "the challenge asks for %d leaves; this SDK opens at most %d, and nothing was opened", len(items), MaxSpotCheckLeaves)
	}
	indices := make([]int, len(items))
	seen := map[int64]bool{}
	for i, item := range items {
		n, ok := item.(int64)
		if !ok || n < 0 || n >= int64(leafCount) || seen[n] {
			return nil, errorf(CodeUnexpectedResponse, "the challenge is not a list of distinct leaf positions within 0..%d", leafCount-1)
		}
		seen[n] = true
		indices[i] = int(n)
	}
	return indices, nil
}

// SnapshotStatus is what the platform holds for a snapshot.
type SnapshotStatus struct {
	SnapshotID string
	// Status is ACCEPTED, CHALLENGED, VERIFIED or REJECTED.
	Status     string
	SpotCheck  bool
	Root       string
	LeafCount  int
	Totals     Balances
	Commitment string
	// AttestationID and AnchorStatus describe the anchoring record; both are
	// empty while there is none. The anchor is confirmed when AnchorStatus is
	// "confirmed".
	AttestationID string
	AnchorStatus  string
	// Raw is the platform's whole answer, indented, with its members in the
	// order received — for the ones this version does not read.
	Raw []byte
}

// Anchored reports whether the snapshot's anchor is confirmed.
func (s *SnapshotStatus) Anchored() bool { return s.AnchorStatus == AnchorConfirmed }

// Status asks the platform what it holds for a snapshot: root, totals, and
// where its anchor stands.
func (c *Client) Status(ctx context.Context, snapshotID string) (*SnapshotStatus, error) {
	_, answer, err := c.call(ctx, http.MethodGet, "/v1/por/snapshots/"+url.PathEscape(snapshotID), true, nil)
	if err != nil {
		return nil, err
	}
	s := &SnapshotStatus{}
	var refusal *Error
	if s.SnapshotID, refusal = answer.str("snapshot_id"); refusal != nil {
		return nil, refusal
	}
	if s.Status, refusal = answer.str("status"); refusal != nil {
		return nil, refusal
	}
	spotCheck, _ := answer.obj.Get("spot_check")
	s.SpotCheck = spotCheck == true
	if s.Root, refusal = answer.optStr("root"); refusal != nil {
		return nil, refusal
	}
	if s.Commitment, refusal = answer.optStr("commitment"); refusal != nil {
		return nil, refusal
	}
	if count, ok := answer.obj.Get("leaf_count"); ok {
		n, isInt := count.(int64)
		if !isInt || n < 0 || n > maxLeafCount {
			return nil, errorf(CodeUnexpectedResponse, "leaf_count is not a number of leaves")
		}
		s.LeafCount = int(n)
	}
	if answer.has("totals") {
		if s.Totals, refusal = answer.balances("totals"); refusal != nil {
			return nil, refusal
		}
	}
	if attestation, ok := answer.obj.Get("attestation"); ok && attestation != nil {
		a, refusal := answer.object("attestation")
		if refusal != nil {
			return nil, refusal
		}
		if s.AttestationID, refusal = a.optStr("id"); refusal != nil {
			return nil, refusal
		}
		if s.AnchorStatus, refusal = a.optStr("status"); refusal != nil {
			return nil, refusal
		}
	}
	if s.Raw, err = cjson.Indent(answer.obj); err != nil {
		return nil, wrap(CodeUnexpectedResponse, err, "the platform's answer cannot be written back")
	}
	return s, nil
}

// WaitAnchored polls a snapshot until its anchor is confirmed and returns
// the status that showed it. It gives up with CodeAnchorTimeout once timeout
// has passed, and at once if the snapshot was rejected or ctx is cancelled.
// A snapshot that is not yet anchored when the wait ends is still in the
// platform's pipeline; waiting again is safe.
func (c *Client) WaitAnchored(ctx context.Context, snapshotID string, timeout time.Duration) (*SnapshotStatus, error) {
	deadline := time.Now().Add(timeout)
	for {
		status, err := c.Status(ctx, snapshotID)
		if err != nil {
			return nil, err
		}
		if status.Anchored() {
			return status, nil
		}
		if status.Status == StatusRejected {
			return nil, errorf(CodeSnapshotRejected, "snapshot %s was rejected by the platform; it will not be anchored", quote(snapshotID))
		}
		if time.Now().Add(c.poll).After(deadline) {
			return nil, errorf(CodeAnchorTimeout, "the anchor of snapshot %s was not confirmed within %s", quote(snapshotID), timeout)
		}
		pause := time.NewTimer(c.poll)
		select {
		case <-ctx.Done():
			pause.Stop()
			return nil, wrap(CodeCancelled, ctx.Err(), "waiting for the anchor of snapshot %s was cancelled", quote(snapshotID))
		case <-pause.C:
		}
	}
}
