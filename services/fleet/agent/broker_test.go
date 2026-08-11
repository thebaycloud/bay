package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// FLEET_ENDPOINT is the full sync URL, so the broker's address is derived from
// it rather than configured separately — one endpoint to set on a node, not two
// that can disagree. Derivation that is wrong in a way nobody notices is exactly
// how a node ends up POSTing an app's secret names somewhere unintended, so the
// rule is strict: the shape we know, or nothing.
func TestBrokerURLIsDerivedFromTheSyncEndpoint(t *testing.T) {
	if got := brokerURL("https://cp.example/api/fleet/sync"); got != "https://cp.example/api/fleet/secrets" {
		t.Fatalf("got %q", got)
	}
	if got := brokerURL(""); got != "" {
		t.Fatalf("no endpoint means no broker, got %q", got)
	}
	// The last path segment is replaced rather than a "/sync" suffix demanded.
	// `agent.env` was added to the live systemd unit by hand and is in no file
	// in this repository, so its exact value cannot be checked from here — and a
	// strict rule guarded by log.Fatalf meets Restart=always and becomes a crash
	// loop, leaving every sandbox on the node unsupervised. Replacement keeps
	// the host and the path prefix, so the worst case is a 404 from the right
	// control plane rather than secret names sent somewhere unintended.
	if got := brokerURL("https://cp.example/api/fleet/other"); got != "https://cp.example/api/fleet/secrets" {
		t.Fatalf("got %q", got)
	}
	// A bare origin has no path to replace; "https://cp.example/secrets" would
	// be a guess at a route rather than a derivation from one.
	if got := brokerURL("https://cp.example"); got != "" {
		t.Fatalf("a bare origin is not an endpoint, got %q", got)
	}
}

func TestBrokerAsksForOneAppsSecretsAndReturnsValues(t *testing.T) {
	var seen struct {
		Node  string   `json:"node"`
		Slug  string   `json:"slug"`
		Names []string `json:"names"`
	}
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &seen)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"values":{"app-shop-DATABASE_URL":"postgres://real"}}`))
	}))
	defer srv.Close()

	got, err := resolveViaBroker(srv.URL, "tok", "n1", "shop",
		map[string]string{"DATABASE_URL": "app-shop-DATABASE_URL"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// Keyed by ENV NAME, not by secret id: the caller puts these into a process
	// environment, and the id is an implementation detail of where it came from.
	if got["DATABASE_URL"] != "postgres://real" {
		t.Fatalf("got %v", got)
	}
	if seen.Node != "n1" || seen.Slug != "shop" {
		t.Fatalf("the broker must be told who is asking and for what: %+v", seen)
	}
	if len(seen.Names) != 1 || seen.Names[0] != "app-shop-DATABASE_URL" {
		t.Fatalf("names should be the secret ids: %+v", seen.Names)
	}
	if auth != "Bearer tok" {
		t.Fatalf("auth %q", auth)
	}
}

// A refusal is not a transport failure and must not read like one. The broker
// answers 403 with a reason — "not placed", "lease expired" — and that reason is
// what tells an operator whether the spec is stale or the lease was lost.
// classifyStartError reads these strings; a summary would cost the distinction.
func TestBrokerRefusalKeepsTheReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"the lease on shop at n1 expired 4s ago"}`))
	}))
	defer srv.Close()

	_, err := resolveViaBroker(srv.URL, "tok", "n1", "shop", map[string]string{"D": "app-shop-D"})
	if err == nil {
		t.Fatal("a refusal must be an error")
	}
	if !strings.Contains(err.Error(), "lease") {
		t.Fatalf("the reason must survive: %v", err)
	}
}

// An app with no secrets must not make a network call at all — every start
// would otherwise pay a round trip for nothing.
func TestNoSecretsMeansNoRequest(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer srv.Close()

	got, err := resolveViaBroker(srv.URL, "tok", "n1", "shop", nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
	if called {
		t.Fatal("no secrets should mean no request")
	}
}

// A broker that answers 200 but omits a name is a partial environment, which is
// the failure the agent's "a secret that cannot be resolved fails the start"
// rule exists to prevent: the process comes up, passes a health check on "/",
// and fails every request that touches data.
func TestAMissingValueFailsRatherThanStartsPartial(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"values":{"app-shop-A":"1"}}`))
	}))
	defer srv.Close()

	_, err := resolveViaBroker(srv.URL, "tok", "n1", "shop",
		map[string]string{"A": "app-shop-A", "B": "app-shop-B"})
	if err == nil || !strings.Contains(err.Error(), "app-shop-B") {
		t.Fatalf("the missing name must be named: %v", err)
	}
}

// classifyStartError matches on strings THIS package formats, and the header of
// fault.go warns that a test hand-writing the format proves only that the mirror
// matches itself. So these go through the real producer: an httptest broker
// answers, resolveViaBroker writes the error, and the classifier reads it.
//
// A rewording of broker.go's fmt.Errorf now fails here rather than silently
// degrading every secret failure to FaultUnknown.
func TestBrokerErrorsClassifyToTheRightSideOfTheFence(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   Fault
		why    string
	}{
		{
			name: "refusal", status: 403,
			body: `{"error":"the lease on shop at n1 expired 4s ago"}`,
			want: FaultNode,
			why:  "a lost lease is the platform's business, never the app's",
		},
		{
			// The broker preserves Secret Manager's own message, so the inner
			// `secret <id>: 404` shape survives being wrapped — which is what
			// keeps "the app named a secret nobody created" the app's fault
			// even now that a second service sits in the middle.
			name: "app named a secret that does not exist", status: 502,
			body: `{"error":"secret app-shop-D: 404 {\"error\":{\"status\":\"NOT_FOUND\"}}"}`,
			want: FaultApp,
			why:  "a 404 is the spec naming a secret nobody created",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			_, err := resolveViaBroker(srv.URL, "tok", "n1", "shop", map[string]string{"D": "app-shop-D"})
			if got := classifyStartError(err); got != c.want {
				t.Fatalf("%s: got %v, want %v — %s (error was: %v)", c.name, got, c.want, c.why, err)
			}
		})
	}
}

// A broker that cannot be reached at all carries no status, so it classifies as
// unknown — and that is correct rather than a gap. faultDetail only sends text
// for a CLASSIFIED fault, and an unreachable broker's error is a Go transport
// message; calling it a node fault would be right by luck and would widen what
// leaves the node on the strength of a guess.
func TestAnUnreachableBrokerIsNotClassified(t *testing.T) {
	_, err := resolveViaBroker("http://127.0.0.1:1/api/fleet/secrets", "tok", "n1", "shop",
		map[string]string{"D": "app-shop-D"})
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if got := classifyStartError(err); got != FaultUnknown {
		t.Fatalf("got %v", got)
	}
}
