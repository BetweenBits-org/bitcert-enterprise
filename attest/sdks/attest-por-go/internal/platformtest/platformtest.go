// Package platformtest is a stand-in for the platform, for tests: it speaks
// the published contract (specification §9) and remembers every request it
// was sent.
//
// The claims under test are about what leaves the machine — by default the
// statement and its signature and nothing else; with a spot check, the
// challenged openings and never an account reference — so the stand-in keeps
// the bodies exactly as they arrived. It reads them with encoding/json and
// not with the SDK's own reader, so that the two cannot share a mistake about
// the wire format.
package platformtest

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	por "stonehash.com/attest/por"
)

// Request is one request as the platform received it.
type Request struct {
	Method string
	// Path is the request path as sent, escapes included.
	Path          string
	Authorization string
	ContentType   string
	Body          []byte
	// Close is true when the client asked for the connection not to be kept.
	Close bool
}

// Answer is a canned reply: a status and a body.
type Answer struct {
	Status int
	Body   string
}

// Platform is a running stand-in. Set its fields before the first request.
type Platform struct {
	// URL is the platform's origin.
	URL string
	// Keys are the registered signing keys by institution id (SPKI, base64).
	Keys map[string]string
	// Challenge is the leaf positions a spot check asks for.
	Challenge []int
	// PendingPolls is how many status calls see the anchor still pending.
	PendingPolls int
	// Override, when it returns an Answer, replaces what the platform would
	// have said to that request.
	Override func(Request) *Answer

	mu          sync.Mutex
	requests    []Request
	connections int
	snapshots   map[string]*snapshot
	polls       int
}

type snapshot struct {
	statement *por.Statement
	status    string
	challenge []int
}

// New starts a stand-in on a port of its own. It is closed when the test ends.
func New(t testing.TB) *Platform {
	t.Helper()
	p := &Platform{Keys: map[string]string{}, snapshots: map[string]*snapshot{}}
	server := httptest.NewUnstartedServer(http.HandlerFunc(p.serve))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			p.mu.Lock()
			p.connections++
			p.mu.Unlock()
		}
	}
	server.Start()
	t.Cleanup(server.Close)
	p.URL = server.URL
	return p
}

// Requests returns every request received so far, in order.
func (p *Platform) Requests() []Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.requests)
}

// Bodies returns the requests that carried a body.
func (p *Platform) Bodies() []Request {
	var out []Request
	for _, r := range p.Requests() {
		if len(r.Body) > 0 {
			out = append(out, r)
		}
	}
	return out
}

// Connections returns how many connections were opened to the platform.
func (p *Platform) Connections() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connections
}

func (p *Platform) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	request := Request{
		Method: r.Method, Path: r.URL.EscapedPath(), Authorization: r.Header.Get("Authorization"),
		ContentType: r.Header.Get("Content-Type"), Body: body, Close: r.Close,
	}
	p.mu.Lock()
	p.requests = append(p.requests, request)
	p.mu.Unlock()

	if p.Override != nil {
		if canned := p.Override(request); canned != nil {
			w.WriteHeader(canned.Status)
			io.WriteString(w, canned.Body)
			return
		}
	}
	status, answer := p.answer(request, r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(answer)
}

func refusal(status int, code, message string) (int, any) {
	return status, map[string]any{"error": code, "message": message}
}

func (p *Platform) answer(r Request, path string) (int, any) {
	if r.Method == http.MethodGet && path == "/v1/remit/meta" {
		institutions := []map[string]any{{"id": "VN-BANK-other", "role": "BANK"}}
		for id, key := range p.Keys {
			institutions = append(institutions, map[string]any{"id": id, "signing_spki": key, "role": "EXCHANGE"})
		}
		return http.StatusOK, map[string]any{"product": "stand-in", "institutions": institutions, "rate": 1.5}
	}
	if !strings.HasPrefix(r.Authorization, "Bearer ") || len(r.Authorization) == len("Bearer ") {
		return refusal(http.StatusUnauthorized, "unauthorized", "a bearer API key is required")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	rest, isSnapshot := strings.CutPrefix(path, "/v1/por/snapshots")
	switch {
	case r.Method == http.MethodPost && isSnapshot && rest == "":
		return p.submit(r.Body)
	case r.Method == http.MethodPost && isSnapshot && strings.HasSuffix(rest, "/openings"):
		return p.openings(strings.TrimSuffix(strings.TrimPrefix(rest, "/"), "/openings"), r.Body)
	case r.Method == http.MethodGet && isSnapshot && strings.HasPrefix(rest, "/"):
		return p.status(strings.TrimPrefix(rest, "/"))
	}
	return refusal(http.StatusNotFound, "not_found", "no route for "+r.Method+" "+path)
}

func (p *Platform) submit(body []byte) (int, any) {
	var sent map[string]json.RawMessage
	if err := json.Unmarshal(body, &sent); err != nil || sent["statement"] == nil || sent["sig"] == nil {
		return refusal(http.StatusBadRequest, "missing_field", "statement and sig are required")
	}
	for member := range sent {
		if member != "statement" && member != "sig" && member != "spot_check" {
			return refusal(http.StatusBadRequest, "invalid_field", "unexpected member "+member)
		}
	}
	spotCheck := false
	if raw, ok := sent["spot_check"]; ok {
		if err := json.Unmarshal(raw, &spotCheck); err != nil {
			return refusal(http.StatusBadRequest, "invalid_field", "spot_check must be true or false")
		}
	}
	statement, err := por.ParseStatement(sent["statement"])
	if err != nil {
		return refusal(http.StatusBadRequest, "invalid_statement", err.Error())
	}
	key, registered := p.Keys[statement.InstitutionID()]
	if !registered {
		return refusal(http.StatusForbidden, "institution_mismatch", "statement names "+statement.InstitutionID())
	}
	var sig por.Signature
	if err := json.Unmarshal(sent["sig"], &sig); err != nil || por.VerifyStatementSignature(statement, &sig, key) != nil {
		return refusal(http.StatusBadRequest, "invalid_signature", "sig does not verify over the statement with the registered EXCHANGE key")
	}

	if spotCheck {
		id := fmt.Sprintf("snap-%d", len(p.snapshots)+1)
		p.snapshots[id] = &snapshot{statement: statement, status: por.StatusChallenged, challenge: slices.Clone(p.Challenge)}
		return http.StatusCreated, map[string]any{
			"snapshot_id": id, "status": por.StatusChallenged, "spot_check": true,
			"challenge": map[string]any{"indices": p.Challenge, "issued_at": "2026-11-16T01:00:00.000Z", "expires_at": "2026-11-16T02:00:00.000Z"},
		}
	}
	for id, held := range p.snapshots {
		if held.status == por.StatusAccepted && held.statement.Commitment() == statement.Commitment() {
			return http.StatusOK, map[string]any{"snapshot_id": id, "status": por.StatusAccepted, "spot_check": false, "attestation_id": "att-" + id, "note": "held", "already": true}
		}
	}
	id := fmt.Sprintf("snap-%d", len(p.snapshots)+1)
	p.snapshots[id] = &snapshot{statement: statement, status: por.StatusAccepted}
	return http.StatusCreated, map[string]any{"snapshot_id": id, "status": por.StatusAccepted, "spot_check": false, "attestation_id": "att-" + id, "note": "anchoring"}
}

func (p *Platform) openings(id string, body []byte) (int, any) {
	held, ok := p.snapshots[id]
	if !ok {
		return refusal(http.StatusNotFound, "not_found", "no snapshot "+id)
	}
	if held.status != por.StatusChallenged {
		return refusal(http.StatusConflict, "wrong_state", "snapshot is "+held.status)
	}
	var sent struct {
		Openings []json.RawMessage `json:"openings"`
	}
	if err := json.Unmarshal(body, &sent); err != nil || sent.Openings == nil {
		return refusal(http.StatusBadRequest, "missing_field", "openings[] is required")
	}
	var problems []string
	var indices []int
	for i, raw := range sent.Openings {
		if strings.Contains(string(raw), `"user_ref"`) {
			problems = append(problems, fmt.Sprintf("opening %d carries an account reference", i))
		}
		proof, err := por.ParseProof(raw)
		if err != nil {
			problems = append(problems, fmt.Sprintf("opening %d: %v", i, err))
			continue
		}
		indices = append(indices, proof.LeafIndex)
		if err := por.VerifyProof(proof, held.statement.Root(), held.statement.Totals()); err != nil {
			problems = append(problems, fmt.Sprintf("leaf %d: %v", proof.LeafIndex, err))
		}
	}
	slices.Sort(indices)
	if want := slices.Clone(held.challenge); !slices.Equal(indices, sorted(want)) {
		problems = append(problems, fmt.Sprintf("openings must cover exactly the challenged indices %v (got %v)", want, indices))
	}
	if len(problems) > 0 {
		held.status = por.StatusRejected
		return http.StatusUnprocessableEntity, map[string]any{"snapshot_id": id, "status": por.StatusRejected, "problems": problems}
	}
	held.status = por.StatusVerified
	return http.StatusOK, map[string]any{"snapshot_id": id, "status": por.StatusVerified, "sampled_leaves": len(indices), "attestation_id": "att-" + id, "note": "anchoring"}
}

func sorted(values []int) []int {
	slices.Sort(values)
	return values
}

func (p *Platform) status(id string) (int, any) {
	held, ok := p.snapshots[id]
	if !ok {
		return refusal(http.StatusNotFound, "not_found", "no snapshot "+id)
	}
	p.polls++
	var attestation any
	if held.status == por.StatusAccepted || held.status == por.StatusVerified {
		state := "pending"
		if p.polls > p.PendingPolls {
			state = "confirmed"
		}
		attestation = map[string]any{"id": "att-" + id, "status": state}
	}
	totals := map[string]string{}
	for _, b := range held.statement.Totals() {
		totals[b.Asset] = b.Amount.String()
	}
	return http.StatusOK, map[string]any{
		"snapshot_id": id, "status": held.status, "spot_check": held.status != por.StatusAccepted,
		"exchange": held.statement.InstitutionID(), "asof": held.statement.AsOf(),
		"root": held.statement.Root(), "leaf_count": held.statement.LeafCount(), "totals": totals,
		"commitment": held.statement.Commitment(), "attestation": attestation, "created_at": "2026-11-16T01:00:00.000Z",
	}
}
