package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The audience and `format=full` are BOTH load-bearing and both easy to lose.
//
// The audience is what stops a token minted for this fleet being replayed at
// some other service, and `format=full` is the only reason the payload carries
// `google.compute_engine.instance_name` at all. A token requested without it is
// still valid and still signed by Google, and proves nothing about WHICH
// machine — which is the entire thing this exists to prove.
func TestIdentityRequestAsksForTheFullFormatAndOurAudience(t *testing.T) {
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.RawQuery
		if r.Header.Get("Metadata-Flavor") != "Google" {
			t.Errorf("metadata requires the flavour header; got %q", r.Header.Get("Metadata-Flavor"))
		}
		_, _ = w.Write([]byte("a.b.c"))
	}))
	defer srv.Close()

	identityBase = srv.URL
	defer func() { identityBase = defaultIdentityBase }()
	identityCache = identityToken{}

	tok, err := nodeIdentityToken()
	if err != nil || tok != "a.b.c" {
		t.Fatalf("got %q, %v", tok, err)
	}
	if !strings.Contains(asked, "format=full") {
		t.Fatalf("format=full missing from %q", asked)
	}
	if !strings.Contains(asked, "audience=https%3A%2F%2Fsupersonic.cv%2Ffleet") {
		t.Fatalf("audience missing or unescaped in %q", asked)
	}
}

// Minted once and reused until it is nearly expired. A token per request would
// put a metadata round trip on the sync loop, which runs every ten seconds on
// every node, to re-fetch a string that is valid for an hour.
func TestIdentityTokenIsCachedUntilItIsNearlyExpired(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte("x.y.z"))
	}))
	defer srv.Close()

	identityBase = srv.URL
	defer func() { identityBase = defaultIdentityBase }()
	identityCache = identityToken{}

	for i := 0; i < 5; i++ {
		if _, err := nodeIdentityToken(); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one mint, got %d", calls)
	}

	// Nearly expired is refreshed EARLY rather than on expiry: a token that dies
	// in flight is a request the control plane refuses for a reason that has
	// nothing to do with the node.
	identityCache.expires = time.Now().Add(30 * time.Second)
	if _, err := nodeIdentityToken(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected a refresh, got %d calls", calls)
	}
}

// An unreachable metadata server is not fatal. The shared FLEET_TOKEN still
// authenticates every call this token accompanies, so the worst case of failing
// to mint one is the security this adds, not the fleet's ability to work.
func TestIdentityFailureIsNotFatal(t *testing.T) {
	identityBase = "http://127.0.0.1:1"
	defer func() { identityBase = defaultIdentityBase }()
	identityCache = identityToken{}

	tok, err := nodeIdentityToken()
	if err == nil {
		t.Fatal("expected an error from an unreachable metadata server")
	}
	if tok != "" {
		t.Fatalf("a failed mint must yield no token, got %q", tok)
	}
}
