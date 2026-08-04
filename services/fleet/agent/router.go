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
// What is deliberately NOT here yet: visibility and access control. Private and
// workspace-scoped apps, `app_grants`, the session cookie and the overlay
// injection all live in `services/proxy` and are moving here in step 4 of
// docs/VM-FLEET.md. Until they do, this router refuses to serve anything the
// control plane has not marked public, so the gap is a closed door rather than
// an open one.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type routerTable struct {
	mu     sync.RWMutex
	byslug map[string]Route
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
	m := make(map[string]Route, len(routes))
	for _, r := range routes {
		m[r.Slug] = r
	}
	t.mu.Lock()
	t.byslug = m
	t.loaded = time.Now()
	t.mu.Unlock()
	return nil
}

func (t *routerTable) get(slug string) (Route, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	r, ok := t.byslug[slug]
	return r, ok
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
	for _, r := range t.byslug {
		if r.Healthy {
			healthy++
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
	proxy      *httputil.ReverseProxy
}

func NewRouter(rootDomain string) *Router {
	rt := &Router{
		table:      &routerTable{byslug: map[string]Route{}},
		rootDomain: rootDomain,
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
			w.Header().Set("X-Supersonic-Router", "upstream-error")
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

func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == fleetHealthPath {
		// Healthy means "this node's router is serving", not "some app is up".
		// Draining a node is done by taking it out of the backend, not by
		// failing this.
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "ok %d routes\n", rt.table.size())
		return
	}

	// `x-supersonic-slug` FIRST, Host second.
	//
	// This is what lets an app move to the fleet without touching the edge proxy
	// at all. `services/proxy` already sends this header — it is how the shared
	// static server has always known which tenant a request belongs to — and it
	// has to, because by the time the proxy forwards, Host is the upstream's
	// host, not `<slug>.supersonic.cv`. Routing on Host alone would mean every
	// proxied request arriving here as "no app here".
	//
	// Trusting a client-supplied header is only safe because nothing reaches this
	// port except the load balancer, whose firewall rule admits Google's health
	// check and proxy ranges only. If this port is ever exposed directly, this
	// header stops being trustworthy and the proxy has to sign it.
	slug := strings.TrimSpace(r.Header.Get("x-supersonic-slug"))
	if slug == "" {
		slug = slugFromHost(r.Host, rt.rootDomain)
	}
	if slug == "" {
		w.Header().Set("X-Supersonic-Router", "no-slug")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, page(404, "No app here.",
			"Apps are served at &lt;name&gt;."+rt.rootDomain+"."))
		return
	}

	route, ok := rt.table.get(slug)
	if !ok {
		// Mark every response the ROUTER generates, so a caller can tell one from
		// a response the app generated. Without this a routing miss and an app's
		// own 404 are the same three digits — and the cutover script was using
		// exactly that to decide whether an app was live on the fleet.
		w.Header().Set("X-Supersonic-Router", "miss")
		// Not on this node. Once placement is fleet-wide this becomes a forward
		// to the node that holds it; until then, saying so plainly beats a
		// generic 404 that looks like the app does not exist.
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, page(404, "Not on this node.",
			"This app is not placed here. Fleet-wide forwarding is not wired up yet."))
		return
	}
	if !route.Healthy {
		w.Header().Set("X-Supersonic-Router", "unhealthy")
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
