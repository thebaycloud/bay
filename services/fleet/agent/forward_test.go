package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// With one node the load balancer is always right by accident. With two it fans
// requests across machines without knowing where anything is, so roughly half of
// every app's traffic lands on a node that does not hold it — and the router
// answered `Not on this node`, a 404 for an app that is up. Adding a second
// machine was therefore a way to make the fleet worse.

func routerOver(t *testing.T, routes []Route) (*Router, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "routes.json")
	b, err := json.Marshal(routes)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	rt := NewRouter("supersonic.cv", "")
	if err := rt.table.load(path); err != nil {
		t.Fatalf("load: %v", err)
	}
	return rt, path
}

func TestPeerRouteIsForwardedOnce(t *testing.T) {
	// The far node answers, so this asserts on what the near one SENDS.
	var sawForwarded string
	far := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawForwarded = r.Header.Get(forwardedHeader)
		w.WriteHeader(200)
		_, _ = w.Write([]byte("far node answered"))
	}))
	defer far.Close()

	rt, _ := routerOver(t, []Route{{Slug: "elsewhere", Addr: far.Listener.Addr().String(), Healthy: true, Peer: true}})

	req := httptest.NewRequest("GET", "http://elsewhere.supersonic.cv/", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("a peer route should reach the other node: got %d", rec.Code)
	}
	if sawForwarded == "" {
		t.Error("the forward mark was not set — two nodes with skewed maps would loop until timeout")
	}
	if got := rec.Header().Get("X-Supersonic-Router"); got != "forwarded" {
		t.Errorf("a forwarded response should say so: got %q", got)
	}
}

func TestAForwardedRequestIsNotForwardedAgain(t *testing.T) {
	// One sync of skew is enough for two nodes to each think the other holds an
	// app. Passing the request back and forth until it times out is a far worse
	// answer than a 404, so the second hop refuses.
	far := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer far.Close()

	rt, _ := routerOver(t, []Route{{Slug: "elsewhere", Addr: far.Listener.Addr().String(), Healthy: true, Peer: true}})

	req := httptest.NewRequest("GET", "http://elsewhere.supersonic.cv/", nil)
	req.Header.Set(forwardedHeader, "1")
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("a second hop must not be taken: got %d", rec.Code)
	}
	if got := rec.Header().Get("X-Supersonic-Router"); got != "forward-loop" {
		t.Errorf("the refusal should be legible: got %q", got)
	}
}

func TestALocalRouteIsNotMarkedForwarded(t *testing.T) {
	// The mark is only for hops between nodes. Setting it on ordinary traffic
	// would make the loop guard fire on a request that never left the machine.
	var sawForwarded string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawForwarded = r.Header.Get(forwardedHeader)
		w.WriteHeader(200)
	}))
	defer app.Close()

	rt, _ := routerOver(t, []Route{{Slug: "mine", Addr: app.Listener.Addr().String(), Healthy: true}})

	req := httptest.NewRequest("GET", "http://mine.supersonic.cv/", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("a local route should still work: got %d", rec.Code)
	}
	if sawForwarded != "" {
		t.Error("a local hop must not be marked as forwarded")
	}
}

func TestAnUnknownSlugIsStillAMiss(t *testing.T) {
	// Forwarding is for apps the fleet holds SOMEWHERE. An app nobody claims must
	// stay a miss, or a typo becomes a request bounced around the fleet.
	rt, _ := routerOver(t, []Route{})
	req := httptest.NewRequest("GET", "http://nobody.supersonic.cv/", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d", rec.Code)
	}
	if got := rec.Header().Get("X-Supersonic-Router"); got != "miss" {
		t.Errorf("got %q", got)
	}
}

// One address, two programs. A repository that is a frontend beside an API used
// to be split across runtimes — the frontend on a node, the API on Cloud Run —
// because the node could route by slug and nothing else. Splitting by path is
// what lets both live on the machine that holds the app.

func TestLongestPrefixWins(t *testing.T) {
	// `/` must not answer `/api/things`. It would answer with an SPA's
	// index.html, which reads to the caller as the API returning HTML for no
	// reason — a failure that looks like the API's bug and is the router's.
	var hit string
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hit = "web"; w.WriteHeader(200) }))
	defer web.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { hit = "api"; w.WriteHeader(200) }))
	defer api.Close()

	rt, _ := routerOver(t, []Route{
		{Slug: "two", Addr: web.Listener.Addr().String(), Healthy: true, Prefix: "/"},
		{Slug: "two", Addr: api.Listener.Addr().String(), Healthy: true, Prefix: "/api"},
	})

	for path, want := range map[string]string{
		"/":           "web",
		"/about":      "web",
		"/api":        "api",
		"/api/things": "api",
	} {
		hit = ""
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, httptest.NewRequest("GET", "http://two.supersonic.cv"+path, nil))
		if hit != want {
			t.Errorf("%s went to %q, wanted %q", path, hit, want)
		}
	}
}

func TestPrefixMatchesAtABoundary(t *testing.T) {
	// `/apiary` is not under `/api`, and a string-prefix match would send it
	// there. The edge proxy already keeps this rule; this is now a second place
	// that decides it, so it is pinned in both.
	for _, c := range []struct {
		prefix, path string
		want         bool
	}{
		{"/api", "/api", true},
		{"/api", "/api/", true},
		{"/api", "/api/things", true},
		{"/api", "/apiary", false},
		{"/api", "/api-docs", false},
		{"/api/", "/api/things", true},
		{"/", "/anything", true},
		{"", "/anything", true},
	} {
		if got := prefixMatches(c.prefix, c.path); got != c.want {
			t.Errorf("prefixMatches(%q, %q) = %v, wanted %v", c.prefix, c.path, got, c.want)
		}
	}
}

func TestAnAppWithOnePrefixlessRouteStillServesEverything(t *testing.T) {
	// The shape every single-program app has, and the shape this had before
	// prefixes existed. It must not need one.
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer app.Close()
	rt, _ := routerOver(t, []Route{{Slug: "one", Addr: app.Listener.Addr().String(), Healthy: true}})

	for _, path := range []string{"/", "/deep/path", "/api"} {
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, httptest.NewRequest("GET", "http://one.supersonic.cv"+path, nil))
		if rec.Code != 200 {
			t.Errorf("%s got %d", path, rec.Code)
		}
	}
}
