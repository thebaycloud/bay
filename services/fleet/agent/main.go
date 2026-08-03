package main

// supersonicd — the fleet host agent.
//
// One reconcile loop: read desired state, compare it to what is running, make
// the difference go away. Everything else in this binary serves that loop.
//
// Pull-based on purpose. The agent asks for desired state and caches the answer
// on disk; it is never pushed to. A control plane that is down must not be able
// to take running apps with it, and an agent that starts on a node whose network
// is not up yet must still bring back what was running before.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/core/content"
	"github.com/opencontainers/go-digest"
	"github.com/opencontainers/image-spec/identity"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

const (
	resolvConfPath = "/run/supersonic/resolv.conf"
	statePath      = "/srv/state/desired.json"
	routesPath     = "/srv/state/routes.json"
	dataRoot       = "/srv/apps"
)

// App is one thing this node has been told to run.
type App struct {
	Slug        string            `json:"slug"`
	Image       string            `json:"image"`
	Command     []string          `json:"command,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	// Secrets maps an environment variable name to a Secret Manager secret id.
	// Resolved at start; the values never touch node disk or config.json.
	Secrets     map[string]string `json:"secrets,omitempty"`
	Port        int               `json:"port"`
	MemoryBytes int64             `json:"memoryBytes"`
	CPUShares   uint64            `json:"cpuShares"`
	HealthPath  string            `json:"healthPath,omitempty"`
	// DataDir is the app's writable directory on local SSD, mounted at /data.
	// Empty means the app gets no persistent disk.
	DataDir string `json:"-"`
	// LogPath is where the sandbox's stdout and stderr land.
	LogPath string `json:"-"`
}

type Desired struct {
	Apps []App `json:"apps"`
}

// Route is what the router needs: a slug and where to send it.
type Route struct {
	Slug    string `json:"slug"`
	Addr    string `json:"addr"`
	Healthy bool   `json:"healthy"`
	Since   int64  `json:"since"`
}

type live struct {
	app   App
	net   *SandboxNet
	index int
	ok    bool
	since time.Time
}

type Agent struct {
	rt   *Runtime
	src  *Source
	mu   sync.Mutex
	live map[string]*live
	// writeMu serialises publishing the routing table. Starts run concurrently
	// and each publishes on completion, so without this two goroutines share one
	// temp path and the rename can land a half-written file — a node briefly
	// serving 502s for every app it holds.
	writeMu sync.Mutex
	slots   map[int]string
	desired Desired
}

func main() {
	var (
		addr       = flag.String("addr", "127.0.0.1:9900", "status and control API address")
		routerAddr = flag.String("router", ":8080", "app traffic address (behind the load balancer)")
		rootDomain = flag.String("domain", "supersonic.cv", "wildcard domain apps are served under")
		interval   = flag.Duration("interval", 10*time.Second, "reconcile interval")
	)
	flag.Parse()

	if err := os.MkdirAll("/run/supersonic", 0o755); err != nil {
		log.Fatalf("state dir: %v", err)
	}
	if err := writeResolvConf(); err != nil {
		log.Fatalf("resolv.conf: %v", err)
	}
	if err := EnsureBridge(); err != nil {
		log.Fatalf("bridge: %v", err)
	}

	rt, err := NewRuntime()
	if err != nil {
		log.Fatalf("runtime: %v", err)
	}

	// Identity is best-effort. A node that cannot read its own metadata can still
	// serve from the local file, which is what the lab does — refusing to start
	// would make the agent undebuggable off a GCE instance.
	src := &Source{
		Endpoint: os.Getenv("FLEET_ENDPOINT"),
		Token:    os.Getenv("FLEET_TOKEN"),
		Local:    statePath,
	}
	if src.Endpoint != "" {
		id, ierr := Identify()
		if ierr != nil {
			log.Fatalf("identity: %v", ierr)
		}
		src.Identity = id
		log.Printf("node %s in %s (%s), %d cpus, %.0f GiB",
			id.Name, id.Zone, id.InternalIP, id.CPUs, float64(id.MemoryBytes)/(1<<30))
	} else {
		log.Printf("no FLEET_ENDPOINT set; reading desired state from %s", statePath)
	}

	a := &Agent{rt: rt, src: src, live: map[string]*live{}, slots: map[int]string{}}

	go a.serve(*addr)
	go NewRouter(*rootDomain).Serve(*routerAddr, routesPath)

	// Health runs on its own clock. Folding it into the reconcile pass would tie
	// how fast the router learns an app is sick to how long a reconcile takes,
	// and a reconcile that is starting fifty apps takes a while.
	go func() {
		for {
			time.Sleep(5 * time.Second)
			a.probeAll()
			if err := a.writeRoutes(); err != nil {
				log.Printf("publish routes: %v", err)
			}
		}
	}()

	log.Printf("supersonicd up; reconciling every %s", *interval)
	for {
		if err := a.reconcileOnce(); err != nil {
			log.Printf("reconcile: %v", err)
		}
		time.Sleep(*interval)
	}
}

// writeResolvConf gives sandboxes a resolver.
//
// The metadata server at 169.254.169.254 is GCE's DNS, and provision.sh's
// nftables rules keep port 53 open to it from the forward hook precisely so this
// works from inside a sandbox while the credentials API on port 80 stays shut.
func writeResolvConf() error {
	return os.WriteFile(resolvConfPath,
		[]byte("nameserver 169.254.169.254\noptions ndots:1\n"), 0o644)
}

func (a *Agent) loadDesired() (Desired, error) {
	d, err := a.src.Fetch()
	if err != nil {
		return d, err
	}
	for i := range d.Apps {
		if d.Apps[i].Port == 0 {
			d.Apps[i].Port = 8080
		}
		if d.Apps[i].MemoryBytes == 0 {
			// Matches DEFAULT_SCALE.memory (2Gi) so an app that never declared
			// anything gets what Cloud Run was giving it.
			d.Apps[i].MemoryBytes = 2 << 30
		}
		if d.Apps[i].CPUShares == 0 {
			d.Apps[i].CPUShares = 1024
		}
		if d.Apps[i].HealthPath == "" {
			d.Apps[i].HealthPath = "/"
		}
		d.Apps[i].DataDir = filepath.Join(dataRoot, d.Apps[i].Slug, "data")
		d.Apps[i].LogPath = filepath.Join(dataRoot, d.Apps[i].Slug, "app.log")
	}
	return d, nil
}

// slotFor assigns a stable per-node index, which decides the sandbox's address.
// Stable across restarts for as long as the app stays placed here, so a restart
// does not renumber every app on the node.
func (a *Agent) slotFor(slug string) int {
	for i, s := range a.slots {
		if s == slug {
			return i
		}
	}
	for i := 0; i < 60000; i++ {
		if _, taken := a.slots[i]; !taken {
			a.slots[i] = slug
			return i
		}
	}
	return -1
}

func (a *Agent) reconcileOnce() error {
	d, err := a.loadDesired()
	if err != nil {
		return err
	}

	a.mu.Lock()
	a.desired = d
	want := map[string]App{}
	for _, app := range d.Apps {
		want[app.Slug] = app
	}
	have := make([]string, 0, len(a.live))
	for slug := range a.live {
		have = append(have, slug)
	}
	a.mu.Unlock()

	// Remove what is no longer wanted, before starting anything new: on a node
	// near its memory ceiling, starting first would be the difference between a
	// clean swap and an OOM.
	for _, slug := range have {
		if _, ok := want[slug]; !ok {
			log.Printf("%s: removing (no longer desired)", slug)
			a.rt.Stop(slug)
			a.mu.Lock()
			if l, ok := a.live[slug]; ok {
				delete(a.slots, l.index)
			}
			delete(a.live, slug)
			a.mu.Unlock()
		}
	}

	// Work out what needs starting, then start it CONCURRENTLY.
	//
	// Serially was the first version and it does not survive contact with a real
	// node: each start includes an image pull, so bringing up 25 apps took
	// minutes, and because routes were only published after the whole pass
	// finished, the routing table stayed empty the entire time while the apps
	// themselves were up and listening. A node rebooting with 200 placed apps
	// would have been down for as long as it took to walk the list.
	todo := []App{}
	for _, app := range d.Apps {
		a.mu.Lock()
		l, running := a.live[app.Slug]
		a.mu.Unlock()

		if running {
			// Restart on a changed image or command. Comparing the whole spec
			// would restart on every irrelevant field; these two are what
			// actually mean "this is a different program".
			if l.app.Image == app.Image && sameStrings(l.app.Command, app.Command) {
				if st, err := runscStatus(app.Slug); err == nil && st.Status == "running" {
					continue
				}
				log.Printf("%s: not running, restarting", app.Slug)
			} else {
				log.Printf("%s: image or command changed, restarting", app.Slug)
			}
			a.rt.Stop(app.Slug)
			a.mu.Lock()
			delete(a.slots, l.index)
			delete(a.live, app.Slug)
			a.mu.Unlock()
		}
		todo = append(todo, app)
	}

	if len(todo) > 0 {
		a.startMany(todo)
	}

	a.probeAll()
	return a.writeRoutes()
}

// startMany brings up a set of apps concurrently and publishes each one the
// moment it is serving, rather than at the end of the batch.
func (a *Agent) startMany(apps []App) {
	// Bounded. Each start is an image pull plus a sandbox boot, and letting two
	// hundred of those run at once turns a node reboot into a thundering herd
	// against Artifact Registry and the disk.
	limit := runtime.NumCPU()
	if limit > 8 {
		limit = 8
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup

	for _, app := range apps {
		wg.Add(1)
		go func(app App) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if err := os.MkdirAll(app.DataDir, 0o755); err != nil {
				log.Printf("%s: data dir: %v", app.Slug, err)
				return
			}
			if err := os.MkdirAll(filepath.Dir(app.LogPath), 0o755); err != nil {
				log.Printf("%s: log dir: %v", app.Slug, err)
				return
			}

			a.mu.Lock()
			idx := a.slotFor(app.Slug)
			a.mu.Unlock()

			start := time.Now()
			net, err := a.rt.Start(app, idx)
			if err != nil {
				log.Printf("%s: start failed: %v", app.Slug, err)
				a.mu.Lock()
				delete(a.slots, idx)
				a.mu.Unlock()
				return
			}
			log.Printf("%s: running at %s (%.1fs)", app.Slug, net.IP, time.Since(start).Seconds())

			a.mu.Lock()
			a.live[app.Slug] = &live{app: app, net: net, index: idx, since: time.Now()}
			a.mu.Unlock()

			// Publish immediately. An app that is serving and absent from the
			// routing table is indistinguishable, from outside, from an app that
			// is down.
			if err := a.writeRoutes(); err != nil {
				log.Printf("%s: publish routes: %v", app.Slug, err)
			}
		}(app)
	}
	wg.Wait()
}

// probeAll health-checks every running app.
//
// Not a gate on "did the deploy work" — that stays in the control plane, which
// already has verify-app.ts's verdict logic including the body regex. This only
// answers "should the router send traffic here right now".
func (a *Agent) probeAll() {
	a.mu.Lock()
	targets := make([]*live, 0, len(a.live))
	for _, l := range a.live {
		targets = append(targets, l)
	}
	a.mu.Unlock()

	var wg sync.WaitGroup
	for _, l := range targets {
		wg.Add(1)
		go func(l *live) {
			defer wg.Done()
			url := fmt.Sprintf("http://%s:%d%s", l.net.IP, l.app.Port, l.app.HealthPath)
			c := &http.Client{Timeout: 5 * time.Second}
			resp, err := c.Get(url)
			ok := false
			if err == nil {
				io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				resp.Body.Close()
				ok = resp.StatusCode < 500
			}
			a.mu.Lock()
			l.ok = ok
			a.mu.Unlock()
		}(l)
	}
	wg.Wait()
}

// writeRoutes publishes the local routing table.
//
// Written atomically. The router reads this file on every change, and a partial
// read during a rewrite would be a node briefly serving 502s for every app it
// holds.
func (a *Agent) writeRoutes() error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()

	a.mu.Lock()
	routes := make([]Route, 0, len(a.live))
	for slug, l := range a.live {
		routes = append(routes, Route{
			Slug:    slug,
			Addr:    fmt.Sprintf("%s:%d", l.net.IP, l.app.Port),
			Healthy: l.ok,
			Since:   l.since.Unix(),
		})
	}
	a.mu.Unlock()
	sort.Slice(routes, func(i, j int) bool { return routes[i].Slug < routes[j].Slug })

	b, err := json.MarshalIndent(routes, "", "  ")
	if err != nil {
		return err
	}
	tmp := routesPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, routesPath)
}

func (a *Agent) serve(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		type item struct {
			Slug    string `json:"slug"`
			Image   string `json:"image"`
			Addr    string `json:"addr"`
			Healthy bool   `json:"healthy"`
			Status  string `json:"status"`
		}
		out := []item{}
		for slug, l := range a.live {
			st, _ := runscStatus(slug)
			out = append(out, item{
				Slug: slug, Image: l.app.Image,
				Addr:    fmt.Sprintf("%s:%d", l.net.IP, l.app.Port),
				Healthy: l.ok, Status: st.Status,
			})
		}
		a.mu.Unlock()
		sort.Slice(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok\n")
	})
	log.Printf("api on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("api: %v", err)
	}
}

// --- helpers ---------------------------------------------------------------

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func identityChainID(diffIDs []digest.Digest) string {
	return identity.ChainID(diffIDs).String()
}

func content_ReadBlob(ctx context.Context, cd *client.Client, desc ocispec.Descriptor) ([]byte, error) {
	return content.ReadBlob(ctx, cd.ContentStore(), desc)
}

// metadataToken fetches the node's service account access token.
func metadataToken() (string, error) {
	req, _ := http.NewRequest("GET",
		"http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", nil)
	req.Header.Set("Metadata-Flavor", "Google")
	c := &http.Client{Timeout: 5 * time.Second,
		Transport: &http.Transport{DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return "", err
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("metadata returned no access token")
	}
	return tok.AccessToken, nil
}
