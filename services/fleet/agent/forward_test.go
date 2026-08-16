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

func TestAForwardedHopIsSigned(t *testing.T) {
	// The gate deletes the caller's signature before proxying — the tenant's app
	// must never learn it — and the next node's gate demands one. So a forwarded
	// request arrived unsigned and was refused: `x-supersonic-router: forwarded,
	// unsigned`, a 403 for an app that was up, on the very path forwarding
	// exists to serve.
	var seen string
	far := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("x-supersonic-edge")
		w.WriteHeader(200)
	}))
	defer far.Close()

	rt := NewRouter("supersonic.cv", "the-edge-secret")
	rt.table.mu.Lock()
	rt.table.byslug = map[string][]Route{"elsewhere": {{Slug: "elsewhere", Addr: far.Listener.Addr().String(), Healthy: true, Peer: true}}}
	rt.table.mu.Unlock()

	req := httptest.NewRequest("GET", "http://elsewhere.supersonic.cv/", nil)
	req.Header.Set("x-supersonic-edge", "the-edge-secret")
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("got %d", rec.Code)
	}
	if seen != "the-edge-secret" {
		t.Errorf("the hop reached the next node unsigned: %q", seen)
	}
}

func TestALocalHopStillLosesTheSecret(t *testing.T) {
	// The reason the delete exists: with the secret, a tenant's app could reach
	// every other app on the node. Signing peer hops must not weaken that.
	var seen string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("x-supersonic-edge")
		w.WriteHeader(200)
	}))
	defer app.Close()

	rt := NewRouter("supersonic.cv", "the-edge-secret")
	rt.table.mu.Lock()
	rt.table.byslug = map[string][]Route{"mine": {{Slug: "mine", Addr: app.Listener.Addr().String(), Healthy: true}}}
	rt.table.mu.Unlock()

	req := httptest.NewRequest("GET", "http://mine.supersonic.cv/", nil)
	req.Header.Set("x-supersonic-edge", "the-edge-secret")
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if seen != "" {
		t.Errorf("the app was handed the platform's secret: %q", seen)
	}
}

// A process that has started but not yet passed its first probe must not hide
// the copy still serving elsewhere.
//
// This is the ordering `writeRoutes` builds — healthy local, then peer, then
// unhealthy local — asserted at the router, which is where it has to hold. The
// table used to be "local first, whatever its health", so during a rollout or a
// rollback the node that had just started the incoming version answered 503
// "This app is not healthy" while the outgoing version was still up on another
// machine. Measured on a live rollback: 400 requests, exactly one 503, carrying
// `x-supersonic-router: unhealthy` at the instant the previous version returned.
func TestAHealthyPeerBeatsAnUnhealthyLocalRoute(t *testing.T) {
	far := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("the version that is actually up"))
	}))
	defer far.Close()

	// The order `writeRoutes` produces for this situation.
	rt, _ := routerOver(t, []Route{
		{Slug: "app", Addr: far.Listener.Addr().String(), Healthy: true, Peer: true},
		{Slug: "app", Addr: "127.0.0.1:1", Healthy: false},
	})

	req := httptest.NewRequest("GET", "http://app.supersonic.cv/", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("a starting local process shadowed a serving peer: got %d", rec.Code)
	}
	if got := rec.Header().Get("X-Supersonic-Router"); got != "forwarded" {
		t.Errorf("the request should have been forwarded to the node that can serve it: got %q", got)
	}
}

// …and with nowhere else to send it, the unhealthy local route still answers.
//
// The point of keeping it rather than dropping it: "this app is not healthy" is
// a true and useful answer, and "not on this node" would be a false one from the
// machine that is holding the app.
func TestAnUnhealthyLocalRouteStillAnswersWhenItIsTheOnlyOne(t *testing.T) {
	rt, _ := routerOver(t, []Route{{Slug: "app", Addr: "127.0.0.1:1", Healthy: false}})

	req := httptest.NewRequest("GET", "http://app.supersonic.cv/", nil)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)

	if rec.Code != 503 {
		t.Fatalf("an app that is down everywhere should say so: got %d", rec.Code)
	}
	if got := rec.Header().Get("X-Supersonic-Router"); got != "unhealthy" {
		t.Errorf("the reason should be the app's health, not a routing miss: got %q", got)
	}
}

func TestADrainingAppStopsTakingNewRequestsButKeepsRunning(t *testing.T) {
	// The window this closes, measured: a deploy reported "live" and the version
	// it replaced went on answering for about ten seconds — anyone the load
	// balancer happened to send to the old version's node got the old version,
	// because that node still held a healthy local route for it and local wins.
	//
	// Draining is now "cannot serve" for routing purposes even though the process
	// is healthy and still running. The process keeps running so the requests
	// already inside it can finish; what stops is new ones arriving.
	local := []Route{{Slug: "app", Addr: "127.0.0.1:9", Healthy: true}}
	peers := []PeerRoute{{Slug: "app", Addr: "10.0.0.2:8080"}}

	// Not draining: the local route wins and no peer is offered at all.
	got := mergeRoutes(local, peers, nil)
	if len(got) != 1 || got[0].Peer {
		t.Fatalf("a healthy local route must hold the slug: %+v", got)
	}

	// Draining: the peer is offered first, and the outgoing version is kept
	// behind it rather than dropped.
	got = mergeRoutes(local, peers, []string{"app"})
	if len(got) != 2 {
		t.Fatalf("expected the peer and the draining local route: %+v", got)
	}
	if !got[0].Peer {
		t.Errorf("new requests must go to the version that replaced it: %+v", got[0])
	}
	if got[1].Peer || got[1].Slug != "app" {
		t.Errorf("the draining route must be kept as the fallback: %+v", got[1])
	}
}

func TestADrainingAppWithNoReplacementStillServes(t *testing.T) {
	// Draining without anywhere to send the traffic must not black-hole the app.
	// The planner only drains once a replacement is ready, so this should not
	// happen — and "should not happen" is exactly the condition worth pinning,
	// because the cost of being wrong is an app that answers nothing at all.
	got := mergeRoutes([]Route{{Slug: "app", Addr: "127.0.0.1:9", Healthy: true}}, nil, []string{"app"})
	if len(got) != 1 || got[0].Peer {
		t.Fatalf("the draining route is the only one there is, and must still serve: %+v", got)
	}
}

func TestOnlyAppsThatHaveWrittenSomethingCountAsHavingData(t *testing.T) {
	// The directory is created for EVERY app before the bind mount, so its
	// existence says nothing at all — which is why this asks whether it has an
	// entry in it. Getting that wrong would pin every app on the node and stop
	// the reconciler moving anything, which is the opposite failure and just as
	// bad: a node dies and nothing recovers.
	root := t.TempDir()
	empty := filepath.Join(root, "empty", "data")
	full := filepath.Join(root, "full", "data")
	for _, d := range []string{empty, full} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(full, "sqlite.db"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	a := &Agent{live: map[string]*live{
		"empty--web.": {app: App{Slug: "empty", DataDir: empty}, proc: Process{Name: "web"}},
		"full--web.":  {app: App{Slug: "full", DataDir: full}, proc: Process{Name: "web"}},
		"none--web.":  {app: App{Slug: "none", DataDir: ""}, proc: Process{Name: "web"}},
	}}

	got := a.reportWithData()
	if len(got) != 1 || got[0] != "full" {
		t.Fatalf("only the app that wrote something should be pinned: got %v", got)
	}
}
