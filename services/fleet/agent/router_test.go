package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

const testSecret = "edge-secret-for-tests"

// withRoute puts one healthy route in the table without going through a file.
func withRoute(rt *Router, slug, addr string) {
	rt.table.mu.Lock()
	rt.table.byslug = map[string][]Route{slug: {{Slug: slug, Addr: addr, Healthy: true}}}
	rt.table.mu.Unlock()
}

func TestHealthPathStaysOpenWhenASecretIsSet(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	rt.ServeHTTP(w, httptest.NewRequest("GET", fleetHealthPath, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("health check got %d, want 200 — the load balancer cannot send a secret, "+
			"and gating this drains the backend", w.Code)
	}
}

func TestUnsignedRequestIsRefused(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	rt.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
	if got := w.Header().Get("X-Supersonic-Router"); got != "unsigned" {
		t.Fatalf("marker %q, want %q", got, "unsigned")
	}
}

func TestWrongSecretIsRefused(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", "not-the-secret")
	rt.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
}

func TestSignedRequestReachesTheRoutingTable(t *testing.T) {
	// The table is empty, so "miss" is proof the request got PAST the gate.
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", testSecret)
	rt.ServeHTTP(w, r)
	if got := w.Header().Get("X-Supersonic-Router"); got != "miss" {
		t.Fatalf("marker %q, want %q — a signed request must reach the table", got, "miss")
	}
}

func TestNoSecretConfiguredMeansNoEnforcement(t *testing.T) {
	// This is what lets the binary ship before the proxy that signs.
	rt := NewRouter("supersonic.cv", "")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	rt.ServeHTTP(w, r)
	if got := w.Header().Get("X-Supersonic-Router"); got != "miss" {
		t.Fatalf("marker %q, want %q — an unset secret must not enforce", got, "miss")
	}
}

func TestTheSecretIsReadTrimmed(t *testing.T) {
	// The proxy's copy of the same secret loses its whitespace for free: Go's
	// header parser trims the received value. Untrimmed here, the two copies
	// differ by a byte nobody can see and every fleet request 403s forever.
	t.Setenv("FLEET_EDGE_SECRET", " \t"+testSecret+"\n")
	if got := edgeSecretFromEnv(); got != testSecret {
		t.Fatalf("edgeSecretFromEnv() did not trim; got %d bytes, want %d", len(got), len(testSecret))
	}
}

func TestAWhitespaceOnlySecretDoesNotEnforce(t *testing.T) {
	// A rotation that writes `FLEET_EDGE_SECRET=` and a newline leaves the gate
	// OFF rather than enforcing a secret no caller can ever send. Both are bad;
	// this one is at least the state the startup log names out loud.
	t.Setenv("FLEET_EDGE_SECRET", "   \n")
	rt := NewRouter("supersonic.cv", edgeSecretFromEnv())
	if rt.edgeSecret != "" {
		t.Fatalf("a whitespace-only secret survived as %d bytes", len(rt.edgeSecret))
	}
}

func TestTheSecretIsNeverForwardedToTheApp(t *testing.T) {
	var seen string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("x-supersonic-edge")
		w.WriteHeader(http.StatusOK)
	}))
	defer app.Close()

	u, err := url.Parse(app.URL)
	if err != nil {
		t.Fatal(err)
	}

	rt := NewRouter("supersonic.cv", testSecret)
	withRoute(rt, "a8ebb", u.Host)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", testSecret)
	rt.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("proxied request got %d, want 200", w.Code)
	}
	if seen != "" {
		t.Fatalf("the app received the edge secret; it must be stripped before proxying")
	}
}
