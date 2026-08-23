package main

// The node-local router: the data plane for app traffic.
//
// This is the piece that replaces the Cloud Run URL. Today `services/proxy`
// looks up `apps.run_url` in Postgres and forwards to a *.run.app address with
// an ID token in `x-serverless-authorization`. Here there is no Cloud Run to
// authenticate to and no database to ask: the routing table is a file this node
// already has, and the app is one hop away on the bridge.
//
// Reading a replicated file rather than querying Postgres per request is the
// whole point. A control plane that is down must not be able to stop a node
// serving traffic for apps that are running on it.
//
// What is deliberately NOT here: visibility and access control. Private and
// workspace-scoped apps, `app_grants`, the session cookie and the overlay
// injection all live in `services/proxy`.
//
// This router does NOT enforce any of that, and an earlier version of this
// comment claimed it did — "refuses to serve anything the control plane has not
// marked public". It never did: `desiredFor` selects on runtime alone and never
// reads `apps.visibility`, so private apps are placed here like any other. What
// keeps them private is that every request must come from the edge proxy, which
// does enforce it. That is what `edgeSecret` below is for, and it is the only
// thing standing between a placed app and the open internet.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type routerTable struct {
	mu sync.RWMutex
	// One slug can now have SEVERAL routes, split by path prefix: a repository
	// that is a frontend beside an API is two programs behind one address, and
	// once both run on this node the split has to happen here rather than at the
	// edge, which only knows the slug.
	//
	// Ordered longest-prefix-first at load, so lookup is the first match.
	byslug map[string][]Route
	loaded time.Time
}

func (t *routerTable) load(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var routes []Route
	if err := json.Unmarshal(b, &routes); err != nil {
		return err
	}
	m := make(map[string][]Route, len(routes))
	for _, r := range routes {
		m[r.Slug] = append(m[r.Slug], r)
	}
	// Longest prefix first. `/api` must be tried before `/`, or the frontend
	// mounted at the root would answer every API call — with an SPA's index.html,
	// which looks to the caller like the API returning HTML for no reason.
	for _, rs := range m {
		sort.SliceStable(rs, func(i, j int) bool { return len(rs[i].Prefix) > len(rs[j].Prefix) })
	}
	t.mu.Lock()
	t.byslug = m
	t.loaded = time.Now()
	t.mu.Unlock()
	return nil
}

// get returns the route for a slug and a request path.
//
// A route with no prefix serves everything, which is every app that has one
// program — the overwhelming majority, and the shape this had before prefixes
// existed.
func (t *routerTable) get(slug, path string) (Route, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	for _, r := range t.byslug[slug] {
		if prefixMatches(r.Prefix, path) {
			return r, true
		}
	}
	return Route{}, false
}

// prefixMatches is a match at a PATH BOUNDARY, never a string prefix.
//
// `/api` must match `/api` and `/api/things` and must not match `/apiary` —
// the same rule the edge proxy's routing table already keeps, restated here
// because this is now a second place that decides it.
func prefixMatches(prefix, path string) bool {
	if prefix == "" || prefix == "/" {
		return true
	}
	p := strings.TrimSuffix(prefix, "/")
	if !strings.HasPrefix(path, p) {
		return false
	}
	rest := path[len(p):]
	return rest == "" || strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, "?")
}

func (t *routerTable) size() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.byslug)
}

// summary is a cheap fingerprint of what the table actually says, so the watcher
// can tell "republished" from "changed".
func (t *routerTable) summary() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	healthy := 0
	for _, rs := range t.byslug {
		for _, r := range rs {
			if r.Healthy {
				healthy++
			}
		}
	}
	return fmt.Sprintf("%d healthy", healthy)
}

// slugFromHost pulls the app out of the Host header.
//
// `<slug>.supersonic.cv` today. The port is stripped because a Host header
// carries one whenever the client used a non-default port, and a slug with
// ":8080" glued to it matches nothing — which surfaces as a 404 for an app that
// is running perfectly.
func slugFromHost(host, rootDomain string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if !strings.HasSuffix(host, "."+rootDomain) {
		return ""
	}
	sub := strings.TrimSuffix(host, "."+rootDomain)
	// Only a single label is an app. `a.b.supersonic.cv` is not app "a.b".
	if sub == "" || strings.Contains(sub, ".") {
		return ""
	}
	return sub
}

type Router struct {
	table      *routerTable
	rootDomain string
	// edgeSecret is what the edge proxy signs its requests with.
	//
	// Empty means unenforced, deliberately: it lets this binary reach a node
	// before the proxy that sets the header, so the two deploys do not have to be
	// simultaneous. Turning it on is one line in /etc/supersonic/fleet.env and a
	// restart, and turning it off again is deleting that line.
	edgeSecret string
	proxy      *httputil.ReverseProxy
}

// edgeSecretFromEnv reads the gate's secret, trimmed.
//
// Trimmed because the two sides are not symmetrical about whitespace and the
// asymmetry is silent. Go's header parser strips the RECEIVED value, so a stray
// space or newline on the proxy's copy disappears on the wire; the same stray
// byte on this side is compared literally and makes the secret unmatchable
// forever — every fleet request 403s, and the difference between the two copies
// is invisible in any log. The secret reaches this node through a file written
// by a hand that may never have read the rollout runbook, and `openssl rand`
// emits a trailing newline by default.
func edgeSecretFromEnv() string {
	return strings.TrimSpace(os.Getenv("FLEET_EDGE_SECRET"))
}

func NewRouter(rootDomain, edgeSecret string) *Router {
	rt := &Router{
		table:      &routerTable{byslug: map[string][]Route{}},
		rootDomain: rootDomain,
		edgeSecret: edgeSecret,
	}

	rt.proxy = &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			// The Director only rewrites; target selection already happened in
			// ServeHTTP and rode in on the context.
			if t, ok := req.Context().Value(targetKey{}).(string); ok {
				u, _ := url.Parse("http://" + t)
				req.URL.Scheme = u.Scheme
				req.URL.Host = u.Host
			}
			// Tell the app what the outside world called it. Apps behind a proxy
			// generate absolute links from these, and Cloud Run set them, so an
			// app that stops receiving them starts emitting http:// links on an
			// https:// site.
			req.Header.Set("X-Forwarded-Proto", "https")
			if req.Header.Get("X-Forwarded-Host") == "" {
				req.Header.Set("X-Forwarded-Host", req.Host)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("router: upstream %s: %v", r.Host, err)
			setRouterStatus(w, "upstream-error")
			w.WriteHeader(http.StatusBadGateway)
			io.WriteString(w, page(502, "This app is not answering.",
				"It is placed on this node but did not respond. If it was just deployed, give it a moment."))
		},
		// A per-request timeout would break SSE and websockets, which is exactly
		// the class of app the fleet exists to support. The dial timeout bounds
		// the failure that actually matters — an app that is not listening.
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 32,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	return rt
}

type targetKey struct{}

func withTarget(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, targetKey{}, addr)
}

// fleetHealthPath is what the load balancer probes.
//
// Under a reserved prefix rather than at "/", because "/" belongs to whichever
// app the Host header names — and a health check that a tenant's app can answer
// is a health check that reports the node healthy for as long as one app happens
// to be up. The prefix is namespaced so it can never collide with an app's own
// route.
const fleetHealthPath = "/__fleet/healthz"

// forwardedHeader marks a request that has already crossed one node. It is the
// whole of the loop protection, so it is set on the way out and checked on the
// way in, and never trusted for anything else.
const forwardedHeader = "X-Supersonic-Forwarded"

// The edge signature, under both spellings.
//
// This agent runs on a VM image. A node provisioned before the rename knows
// only the old header, and it keeps serving until somebody re-images it — while
// a redeployed proxy may already be sending the new one. Getting this wrong in
// either direction is not a degradation: every request becomes "unsigned" and
// every app on the fleet returns 403.
const (
	edgeHeader       = "x-bay-edge"
	legacyEdgeHeader = "x-supersonic-edge"
)

// edgeSignatureOK reports whether the request carries the shared secret under
// either header name.
//
// Both are compared in constant time and both are always compared — no early
// return on the first match — so the work done here does not depend on which
// spelling arrived or on whether the first one was correct.
func (rt *Router) edgeSignatureOK(r *http.Request) bool {
	fresh := subtle.ConstantTimeCompare([]byte(r.Header.Get(edgeHeader)), []byte(rt.edgeSecret))
	legacy := subtle.ConstantTimeCompare([]byte(r.Header.Get(legacyEdgeHeader)), []byte(rt.edgeSecret))
	return fresh|legacy == 1
}

// setRouterStatus reports why the router did what it did, under both spellings.
//
// A response header, read by humans and by services/fleet/migrate.sh. Sending
// both keeps that script working across the rename.
func setRouterStatus(w http.ResponseWriter, status string) {
	w.Header().Set("X-Bay-Router", status)
	w.Header().Set("X-Supersonic-Router", status)
}

func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == fleetHealthPath {
		// Healthy means "this node's router is serving", not "some app is up".
		// Draining a node is done by taking it out of the backend, not by
		// failing this.
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "ok %d routes\n", rt.table.size())
		return
	}

	// Everything below this line must come from the edge proxy.
	//
	// The health path is handled above and stays open, because the load balancer's
	// health check cannot carry a secret and failing it drains the node out of the
	// backend — which takes every app on the fleet down.
	//
	// This gate is what the comment at the top of this file used to claim and did
	// not do. `x-supersonic-slug` is client-supplied and names any app on the
	// node; the load balancer in front of this port answers the open internet, so
	// without this anyone could reach a placed app around the proxy's session
	// check, decideAccess, app_grants and workspace scoping.
	if rt.edgeSecret != "" {
		if !rt.edgeSignatureOK(r) {
			setRouterStatus(w, "unsigned")
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, page(403, "Not through the front door.",
				"This node serves the edge proxy only."))
			return
		}
	}
	// The tenant's app is the one party on this path that must not learn the
	// secret: with it, an app could reach every other app on the node.
	//
	// BOTH spellings are deleted, not just the one that matched. A node running
	// this build receives both while the proxy sends both, and leaving the other
	// behind would hand the app the secret it was checked against.
	r.Header.Del(edgeHeader)
	r.Header.Del(legacyEdgeHeader)

	// `x-supersonic-slug` FIRST, Host second.
	//
	// This is what lets an app move to the fleet without touching the edge proxy
	// at all. `services/proxy` already sends this header — it is how the shared
	// static server has always known which tenant a request belongs to — and it
	// has to, because by the time the proxy forwards, Host is the upstream's
	// host, not `<slug>.supersonic.cv`. Routing on Host alone would mean every
	// proxied request arriving here as "no app here".
	//
	// How far `x-supersonic-slug` can be trusted depends on `edgeSecret`, and
	// only on that. With a secret set, this line runs only for a request the edge
	// proxy signed, so the slug is the proxy's word about which app this is. With
	// none set — bootstrap, which is the mode this binary ships in and stays in
	// for the whole window between rollout steps — nothing was checked above and
	// the slug is an unauthenticated client's claim, exactly as it was before the
	// gate existed. That is the pre-gate posture, deliberately kept so the two
	// deploys need not be simultaneous, and it is not a state to leave the node
	// in: until `edgeSecret` is set, anything that can reach this port can still
	// name any app on the node.
	slug := strings.TrimSpace(r.Header.Get("x-supersonic-slug"))
	if slug == "" {
		slug = slugFromHost(r.Host, rt.rootDomain)
	}
	if slug == "" {
		setRouterStatus(w, "no-slug")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, page(404, "No app here.",
			"Apps are served at &lt;name&gt;."+rt.rootDomain+"."))
		return
	}

	route, ok := rt.table.get(slug, r.URL.Path)
	if !ok {
		// Mark every response the ROUTER generates, so a caller can tell one from
		// a response the app generated. Without this a routing miss and an app's
		// own 404 are the same three digits — and the cutover script was using
		// exactly that to decide whether an app was live on the fleet.
		setRouterStatus(w, "miss")
		// Not on this node. Once placement is fleet-wide this becomes a forward
		// to the node that holds it; until then, saying so plainly beats a
		// generic 404 that looks like the app does not exist.
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, page(404, "Not on this node.",
			"This app is not placed on this machine, and no other machine claims it."))
		return
	}
	// A route to another node's router. Forwarded once and only once: two nodes
	// whose peer maps disagree — which is what one sync of skew looks like —
	// would otherwise pass a request between them until it timed out, and a
	// timeout is a much worse answer than a 404.
	if route.Peer {
		if r.Header.Get(forwardedHeader) != "" {
			setRouterStatus(w, "forward-loop")
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, page(404, "Not on this node.",
				"Another machine forwarded this here and this one does not hold it either."))
			return
		}
		r.Header.Set(forwardedHeader, "1")
		// Sign the hop. The gate above deleted the caller's signature — the
		// tenant's app must never learn it — and the next node's gate demands
		// one, so a forwarded request arrived unsigned and was refused with 403.
		// Measured: `x-supersonic-router: forwarded, unsigned`.
		//
		// The forwarding node signs as ITSELF rather than replaying what it was
		// given, which is also the honest thing: this hop is the node's request,
		// not the edge's, and a node with no secret configured forwards unsigned
		// and is refused — which is correct, because it should not be serving.
		if rt.edgeSecret != "" {
			r.Header.Set(edgeHeader, rt.edgeSecret)
			r.Header.Set(legacyEdgeHeader, rt.edgeSecret)
		}
		setRouterStatus(w, "forwarded")
	}
	if !route.Healthy {
		setRouterStatus(w, "unhealthy")
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, page(503, "This app is not healthy.",
			"It is running but failing its health check."))
		return
	}

	ctx := r.Context()
	ctx = withTarget(ctx, route.Addr)
	rt.proxy.ServeHTTP(w, r.WithContext(ctx))
}

// watch reloads the routing table whenever the agent republishes it.
//
// Polling the mtime rather than inotify: the file is rewritten by rename, which
// inotify reports as a directory event on a path that is recreated, and the
// number of ways to get that subtly wrong is larger than the cost of a stat
// every 500ms.
func (rt *Router) watch(path string) {
	var last time.Time
	var lastSum string
	for {
		if fi, err := os.Stat(path); err == nil && fi.ModTime() != last {
			if err := rt.table.load(path); err != nil {
				log.Printf("router: load %s: %v", path, err)
			} else {
				last = fi.ModTime()
				// The health loop republishes every 5s whether or not anything
				// changed, so logging on mtime alone writes a line every 5
				// seconds forever and buries everything else in the log.
				if sum := rt.table.summary(); sum != lastSum {
					log.Printf("router: %d routes (%s)", rt.table.size(), sum)
					lastSum = sum
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func (rt *Router) Serve(addr, routesFile string) {
	_ = rt.table.load(routesFile)
	go rt.watch(routesFile)
	log.Printf("router on %s for *.%s", addr, rt.rootDomain)
	// Say out loud whether the door is shut. Nothing else does, and the failure
	// this catches is quiet: `FLEET_EDGE_SECRET=` with an empty value — a
	// plausible outcome of a botched rotation — disables the gate while the
	// health check keeps answering 200 and every app keeps serving. Never the
	// secret itself, not even a prefix or a length: this log is world-readable to
	// anything that can read the journal.
	if rt.edgeSecret == "" {
		log.Printf("edge gate: OFF (no FLEET_EDGE_SECRET) — anything reaching this port can name any app")
	} else {
		log.Printf("edge gate: enforcing — x-supersonic-edge required on every request but %s", fleetHealthPath)
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           rt,
		ReadHeaderTimeout: 15 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("router: %v", err)
	}
}

func page(code int, title, detail string) string {
	return fmt.Sprintf(`<!doctype html><meta charset="utf-8">
<title>%d — Supersonic</title>
<style>
 body{font-family:ui-monospace,"SF Mono",Menlo,monospace;background:#0b0d10;color:#e6edf3;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .c{max-width:34rem;padding:2rem}
 h1{font-size:1rem;font-weight:600;margin:0 0 .5rem}
 p{color:#8b949e;line-height:1.6;margin:0}
 .n{color:#484f58;font-size:.75rem;letter-spacing:.08em;margin-bottom:1rem}
</style>
<div class="c"><div class="n">%d</div><h1>%s</h1><p>%s</p></div>`, code, code, title, detail)
}
