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

// The edge signature has to be accepted under both spellings while the rename
// is in flight. This agent runs on a VM image: a node provisioned before the
// rename knows only the old header and keeps serving until somebody re-images
// it, while a redeployed proxy may already be sending the new one. Getting it
// wrong in either direction is not a degradation — every request becomes
// "unsigned" and every app on the fleet returns 403.
func TestEdgeSignatureAcceptsBothHeaderNames(t *testing.T) {
	rt := &Router{edgeSecret: "s3cret"}

	for _, tc := range []struct {
		name   string
		header string
		value  string
		want   bool
	}{
		{"new name", "x-bay-edge", "s3cret", true},
		{"old name", "x-supersonic-edge", "s3cret", true},
		{"new name, wrong value", "x-bay-edge", "nope", false},
		{"old name, wrong value", "x-supersonic-edge", "nope", false},
		{"no header at all", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := http.NewRequest("GET", "/", nil)
			if tc.header != "" {
				r.Header.Set(tc.header, tc.value)
			}
			if got := rt.edgeSignatureOK(r); got != tc.want {
				t.Fatalf("edgeSignatureOK = %v, want %v", got, tc.want)
			}
		})
	}
}

// Both spellings are stripped before the tenant's app sees the request. A node
// receives both while the proxy sends both, so deleting only the one that
// matched would hand the app the secret it was just checked against — and with
// it, the ability to reach every other app on the node.
func TestBothEdgeHeadersAreStrippedFromTheApp(t *testing.T) {
	r, _ := http.NewRequest("GET", "/", nil)
	r.Header.Set(edgeHeader, "s3cret")
	r.Header.Set(legacyEdgeHeader, "s3cret")

	r.Header.Del(edgeHeader)
	r.Header.Del(legacyEdgeHeader)

	for _, h := range []string{edgeHeader, legacyEdgeHeader} {
		if v := r.Header.Get(h); v != "" {
			t.Fatalf("%s survived with %q — the app can read the edge secret", h, v)
		}
	}
}
