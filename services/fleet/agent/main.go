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
	// Processes is what the app declares it runs. Empty means one implicit web
	// process — see processesOf, where that distinction is load-bearing.
	Processes []Process `json:"processes,omitempty"`
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

// work is one process of one app, queued to be started.
type work struct {
	app  App
	proc Process
}

// live is one running PROCESS, keyed in the agent by its sandbox id — so an app
// with a web process and two workers is three entries, not one.
type live struct {
	app   App
	proc  Process
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
	slots    map[int]string
	desired  Desired
	cron     *cronRunner
	cronJobs []cronJob
	// released records the image whose release process has already run, per app.
	//
	// Without it, release re-runs on every reconcile pass that finds any process
	// not yet up — which on a slow start means running a customer's migration
	// several times, concurrently with itself, and failing with "container
	// already exists". A release belongs to an IMAGE, so that is the key.
	released map[string]string
	// relFail counts consecutive release failures per slug@image, and relRunning
	// marks the ones currently executing off this goroutine.
	//
	// Both are keyed by slug@image rather than slug: a release belongs to an
	// IMAGE, so a new deploy is a new key and starts with a clean count, without
	// anything here having to notice that a deploy happened.
	relFail    *failTracker
	relRunning map[string]bool

	// startFail counts consecutive failed starts per sandbox id@image (Task 3),
	// cronFail counts consecutive cron failures per sandbox id (Task 4). Both
	// are declared here so the struct literal in Step 2 is written once.
	startFail *failTracker
	cronFail  *failTracker
}

// syncCron starts the once-a-minute tick the first time it is needed, and keeps
// the set of scheduled processes current.
//
// The ticker fires on the minute rather than every 60 seconds from start-up:
// "0 3 * * *" has to mean 03:00, not "03:00 plus however long ago this process
// happened to boot".
func (a *Agent) syncCron(d Desired) {
	type job struct {
		app  App
		proc Process
		sch  *Schedule
		loc  *time.Location
	}
	jobs := []job{}
	for _, app := range d.Apps {
		for _, p := range processesOf(app) {
			if p.Kind != KindCron {
				continue
			}
			sch, err := ParseSchedule(p.Schedule)
			if err != nil {
				log.Printf("%s: cron %s: %v — not scheduled", app.Slug, p.Name, err)
				continue
			}
			jobs = append(jobs, job{app: app, proc: p, sch: sch, loc: location(p.Timezone)})
		}
	}

	a.mu.Lock()
	if a.cron == nil {
		a.cron = newCronRunner()
		go func() {
			for {
				now := time.Now()
				next := now.Truncate(time.Minute).Add(time.Minute)
				time.Sleep(time.Until(next))
				a.fireDueCrons(time.Now())
			}
		}()
	}
	a.cronJobs = make([]cronJob, 0, len(jobs))
	for _, j := range jobs {
		a.cronJobs = append(a.cronJobs, cronJob{app: j.app, proc: j.proc, sch: j.sch, loc: j.loc})
	}
	a.mu.Unlock()
}

type cronJob struct {
	app  App
	proc Process
	sch  *Schedule
	loc  *time.Location
}

func (a *Agent) fireDueCrons(now time.Time) {
	a.mu.Lock()
	jobs := append([]cronJob{}, a.cronJobs...)
	runner := a.cron
	a.mu.Unlock()
	if runner == nil {
		return
	}

	for _, j := range jobs {
		local := now.In(j.loc)
		if !j.sch.Due(local) {
			continue
		}
		id := sandboxID(j.app.Slug, j.proc)
		if !runner.shouldFire(id, local) {
			continue
		}
		go func(j cronJob, id string) {
			defer runner.done(id)
			a.mu.Lock()
			idx := a.slotFor(id)
			a.mu.Unlock()
			log.Printf("%s: cron firing", id)
			if err := a.rt.RunToCompletion(j.app, j.proc, idx, 30*time.Minute); err != nil {
				log.Printf("%s: cron failed: %v", id, err)
			} else {
				log.Printf("%s: cron finished", id)
			}
			a.mu.Lock()
			delete(a.slots, idx)
			a.mu.Unlock()
		}(j, id)
	}
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

	// Clear anything a previous agent left behind, before the first reconcile.
	// The live set lives in memory, so on restart the agent knows about nothing
	// and a survivor is not adoptable — it just collides with every start
	// attempt from here on.
	if n := rt.ReapAll(); n > 0 {
		log.Printf("reaped %d sandbox(es) from a previous run", n)
	}

	a := &Agent{rt: rt, src: src, live: map[string]*live{}, slots: map[int]string{},
		released:   map[string]string{},
		relFail:    newFailTracker(),
		relRunning: map[string]bool{},
		startFail:  newFailTracker(),
		cronFail:   newFailTracker()}

	go a.serve(*addr)
	go NewRouter(*rootDomain, edgeSecretFromEnv()).Serve(*routerAddr, routesPath)

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

	// Expand every app into the processes it declares. The agent's unit of work
	// is a process, not an app.
	type unit struct {
		app  App
		proc Process
	}
	units := map[string]unit{} // sandbox id -> what should be running there
	for _, app := range d.Apps {
		for _, p := range processesOf(app) {
			// `release` is not a long-running unit; it is run before the others
			// and then it is gone. `cron` is owned by the scheduler.
			if p.Kind == KindRelease || p.Kind == KindCron {
				continue
			}
			units[sandboxID(app.Slug, p)] = unit{app: app, proc: p}
		}
	}

	a.mu.Lock()
	a.desired = d
	have := make([]string, 0, len(a.live))
	for id := range a.live {
		have = append(have, id)
	}
	a.mu.Unlock()

	// Remove what is no longer wanted, before starting anything new: on a node
	// near its memory ceiling, starting first would be the difference between a
	// clean swap and an OOM.
	for _, id := range have {
		if _, ok := units[id]; !ok {
			log.Printf("%s: removing (no longer desired)", id)
			a.rt.Stop(id)
			a.mu.Lock()
			if l, ok := a.live[id]; ok {
				delete(a.slots, l.index)
			}
			delete(a.live, id)
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
	todo := []work{}
	needRelease := map[string]App{}

	for id, u := range units {
		a.mu.Lock()
		l, running := a.live[id]
		a.mu.Unlock()

		if running {
			// Restart on a changed image or command. Comparing the whole spec
			// would restart on every irrelevant field; these two are what
			// actually mean "this is a different program".
			if l.app.Image == u.app.Image && sameStrings(l.proc.Command, u.proc.Command) {
				if st, err := runscStatus(id); err == nil && st.Status == "running" {
					continue
				}
				log.Printf("%s: not running, restarting", id)
			} else {
				log.Printf("%s: image or command changed, restarting", id)
				// A changed image means the release process has to run again
				// before anything serves the new one.
				needRelease[u.app.Slug] = u.app
			}
			a.rt.Stop(id)
			a.mu.Lock()
			delete(a.slots, l.index)
			delete(a.live, id)
			a.mu.Unlock()
		} else {
			needRelease[u.app.Slug] = u.app
		}
		todo = append(todo, work{app: u.app, proc: u.proc})
	}

	// Release runs to completion BEFORE its app starts, and a failure stops that
	// app coming up at all. A migration that failed followed by a web process
	// that starts anyway is how an app comes up against a half-migrated database.
	//
	// It runs OFF this goroutine. RunToCompletion carries a 30-minute timeout and
	// reconcileOnce is the only thing that reconciles any app on this node, so a
	// synchronous call here let one app's slow release stop the other nineteen.
	// While it is in flight its own app stays blocked, which is the property that
	// mattered; nothing else waits.
	blocked := map[string]bool{}
	now := time.Now()
	for slug, app := range needRelease {
		key := slug + "@" + app.Image

		a.mu.Lock()
		alreadyRan := a.released[slug] == app.Image
		inFlight := a.relRunning[key]
		a.mu.Unlock()

		if alreadyRan {
			continue
		}
		if inFlight {
			blocked[slug] = true
			continue
		}

		switch a.relFail.decide(key, now) {
		case actWait:
			blocked[slug] = true
			continue
		case actGiveUp:
			// Logged once per pass rather than once ever: until logs leave this
			// node (phase 1B) this line is the only way a human learns the app
			// is down on purpose rather than being retried.
			log.Printf("%s: release has failed %d times, not retrying — deploy a new image to reset",
				slug, maxAttempts)
			blocked[slug] = true
			continue
		}

		var rel Process
		found := false
		for _, p := range processesOf(app) {
			if p.Kind == KindRelease {
				rel, found = p, true
				break
			}
		}
		if !found {
			continue
		}

		blocked[slug] = true
		a.mu.Lock()
		a.relRunning[key] = true
		idx := a.slotFor(sandboxID(slug, rel))
		a.mu.Unlock()

		go func(slug, key string, app App, p Process, idx int) {
			log.Printf("%s: running release", slug)
			err := a.rt.RunToCompletion(app, p, idx, 30*time.Minute)

			a.mu.Lock()
			delete(a.relRunning, key)
			delete(a.slots, idx)
			if err == nil {
				a.released[slug] = app.Image
			}
			a.mu.Unlock()

			if err != nil {
				n := a.relFail.failWith(key, time.Now(), err.Error())
				log.Printf("%s: release FAILED (%d/%d), not starting the app: %v",
					slug, n, maxAttempts, err)
			} else {
				a.relFail.succeed(key)
				log.Printf("%s: release finished", slug)
			}
		}(slug, key, app, rel, idx)
	}

	start := make([]work, 0, len(todo))
	for _, t := range todo {
		if blocked[t.app.Slug] {
			continue
		}
		start = append(start, t)
	}
	if len(start) > 0 {
		a.startMany(start)
	}

	a.syncCron(d)
	a.probeAll()
	return a.writeRoutes()
}

// startMany brings up a set of processes concurrently and publishes each one
// the moment it is serving, rather than at the end of the batch.
func (a *Agent) startMany(items []work) {
	// Bounded. Each start is an image pull plus a sandbox boot, and letting two
	// hundred of those run at once turns a node reboot into a thundering herd
	// against Artifact Registry and the disk.
	limit := runtime.NumCPU()
	if limit > 8 {
		limit = 8
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup

	for _, it := range items {
		wg.Add(1)
		go func(it work) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			app, proc := it.app, it.proc
			id := sandboxID(app.Slug, proc)

			if err := os.MkdirAll(app.DataDir, 0o755); err != nil {
				log.Printf("%s: data dir: %v", app.Slug, err)
				return
			}
			if err := os.MkdirAll(filepath.Dir(app.LogPath), 0o755); err != nil {
				log.Printf("%s: log dir: %v", app.Slug, err)
				return
			}

			a.mu.Lock()
			idx := a.slotFor(id)
			a.mu.Unlock()

			started := time.Now()
			net, err := a.rt.Start(app, proc, idx)
			if err != nil {
				log.Printf("%s: start failed: %v", id, err)
				a.mu.Lock()
				delete(a.slots, idx)
				a.mu.Unlock()
				return
			}
			if proc.Kind == KindWeb {
				log.Printf("%s: running at %s (%.1fs)", id, net.IP, time.Since(started).Seconds())
			} else {
				log.Printf("%s: %s running (%.1fs)", id, proc.Kind, time.Since(started).Seconds())
			}

			a.mu.Lock()
			a.live[id] = &live{app: app, proc: proc, net: net, index: idx, since: time.Now()}
			a.mu.Unlock()

			// Publish immediately. An app that is serving and absent from the
			// routing table is indistinguishable, from outside, from an app that
			// is down.
			if err := a.writeRoutes(); err != nil {
				log.Printf("%s: publish routes: %v", id, err)
			}
		}(it)
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
		// Only a web process has a port to probe. A worker with no HTTP server
		// would fail every check and be marked unhealthy forever — which is the
		// exact defect the process model exists to remove.
		if l.proc.Kind != KindWeb {
			continue
		}
		targets = append(targets, l)
	}
	a.mu.Unlock()

	var wg sync.WaitGroup
	for _, l := range targets {
		wg.Add(1)
		go func(l *live) {
			defer wg.Done()
			hp := l.proc.HealthPath
			if hp == "" {
				hp = "/"
			}
			url := fmt.Sprintf("http://%s:%d%s", l.net.IP, effectivePort(l.app, l.proc), hp)
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
	for _, l := range a.live {
		// Only web processes are routable, and `visibility: internal` means
		// reachable by siblings but never published to the front door. A worker
		// has no port at all — routing to it would be routing to nothing.
		if l.proc.Kind != KindWeb || l.proc.Visibility == "internal" {
			continue
		}
		routes = append(routes, Route{
			Slug:    l.app.Slug,
			Addr:    fmt.Sprintf("%s:%d", l.net.IP, effectivePort(l.app, l.proc)),
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
			Kind    string `json:"kind"`
			Image   string `json:"image"`
			Addr    string `json:"addr"`
			Healthy bool   `json:"healthy"`
			Status  string `json:"status"`
		}
		out := []item{}
		for id, l := range a.live {
			st, _ := runscStatus(id)
			out = append(out, item{
				Slug: id, Image: l.app.Image, Kind: string(l.proc.Kind),
				Addr:    fmt.Sprintf("%s:%d", l.net.IP, effectivePort(l.app, l.proc)),
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
