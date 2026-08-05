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
	"strings"
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
	dataRoot       = "/srv/apps"
)

// routesPath is where the routing table is published for the router to read.
//
// A var rather than a const only so a test can drive reconcileOnce without
// writing to /srv on the machine running it. Nothing in the agent reassigns it.
var routesPath = "/srv/state/routes.json"

// App is one thing this node has been told to run.
type App struct {
	Slug    string            `json:"slug"`
	Image   string            `json:"image"`
	Command []string          `json:"command,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
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
	// ProcessIPs is where each of this app's OTHER processes is reachable, filled
	// in by the agent at start time — never by the control plane, which cannot
	// know it. A placement is written before anything is placed, so a sidecar's
	// address does not exist yet; the spec carries `${process:name}` and this is
	// what resolves it.
	ProcessIPs map[string]string `json:"-"`
}

type Desired struct {
	Apps []App `json:"apps"`
	// Peers is every app the FLEET holds that this node does not, and the router
	// address that reaches it. Absent from an older control plane, in which case
	// the node forwards nothing and behaves exactly as it did.
	Peers []PeerRoute `json:"peers,omitempty"`
}

// PeerRoute is one app on another node.
type PeerRoute struct {
	Slug string `json:"slug"`
	// The other node's ROUTER, not the app's sandbox: sandbox addresses are
	// per-node private ranges and mean nothing off the machine that made them.
	Addr string `json:"addr"`
}

// Route is what the router needs: a slug and where to send it.
type Route struct {
	Slug    string `json:"slug"`
	Addr    string `json:"addr"`
	Healthy bool   `json:"healthy"`
	Since   int64  `json:"since"`
	// Prefix is the path this route serves, when an app has more than one
	// program behind one address. Empty serves everything, which is every app
	// with a single program.
	Prefix string `json:"prefix,omitempty"`
	// Peer marks a route to ANOTHER NODE's router rather than to a sandbox on
	// this one. The router proxies to it the same way; the difference is that a
	// peer hop must not be forwarded a second time, or two nodes that disagree
	// about who holds an app would pass a request back and forth until it timed
	// out.
	Peer bool `json:"peer,omitempty"`
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
	// confirmed is the last time this process was OBSERVED running — not the
	// last time the agent believed it was.
	//
	// The distinction is the whole value of the field. `a.live` is a memory
	// belief: an entry is written on a successful start and removed on a pass
	// that notices the process gone, so between those two it says "running"
	// about a process that may have died seconds ago. Reporting that as a
	// positive signal would pass a deploy for a worker that crashed on boot.
	//
	// Only two places write it, and both have just watched runsc say "running":
	// Start's own poll (container.go), and reconcileOnce's liveness check. When
	// neither runs, this ages out and the process stops being reported — a node
	// that has stopped reconciling says nothing rather than vouching from
	// memory.
	confirmed time.Time
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
	// adopt holds sandboxes that outlived the previous agent and have not yet
	// been matched against desired state. reconcileOnce claims what it wants on
	// its first pass and stops the rest, so this is empty from then on — an entry
	// left here after that pass is a sandbox nothing desires.
	//
	// Their SLOTS are reserved in `slots` from the moment they are read, before
	// any of this is matched: an adopted sandbox already holds an address, and a
	// new start handed the same index would build a veth with a duplicate IP.
	adopt    map[string]Adopted
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
	// relFail counts consecutive release failures per slug@image: a release
	// belongs to an IMAGE, so a new deploy is a new key and starts with a clean
	// count, without anything here having to notice that a deploy happened.
	//
	// relRunning marks the ones currently executing off this goroutine, keyed by
	// bare slug rather than slug@image: the slot and the sandbox id it runs in
	// are per-slug, and so is the safety property — an app must stay blocked
	// while ITS release is in flight even if the image changed mid-release, or
	// a rollback to an already-released image would start the web process while
	// the previous image's migration is still writing.
	relFail    *failTracker
	relRunning map[string]bool

	// startFail counts consecutive failed starts per sandbox id@image (Task 3),
	// cronFail counts consecutive cron failures per sandbox id (Task 4). Both
	// are declared here so the struct literal in Step 2 is written once.
	startFail *failTracker
	cronFail  *failTracker

	// blocked is the set of apps whose release means nothing else of theirs may
	// run: its release is in flight, backing off, or has given up. Computed by
	// reconcileOnce and PUBLISHED here because the cron tick runs on its own
	// clock, off that goroutine, and needs the same answer rather than a second
	// implementation of it.
	blocked map[string]bool

	// quiet keeps the states that persist — a release or a start that has given
	// up, a cron blocked by its own release — legible without writing them to
	// the node's append-only log on every ten-second pass.
	quiet *logThrottle

	// faults is the most recent start failure per sandbox id, retained rather
	// than logged and dropped. Cleared when that id next starts successfully,
	// and when it stops being desired at all.
	//
	// The trackers next to it count; this remembers WHY, and whose fault it was.
	// A count tells an operator reading /status that something is wrong; only
	// this tells the control plane that the something was ours, which is what
	// keeps a repair agent out of a customer's repository over our own outage.
	faults map[string]ProcessFault
}

// forgetStaleCronRecords drops cron failure history for jobs this node is no
// longer scheduled to run.
//
// The removal loop in reconcileOnce cannot do this, and that is the ghost-record
// defect: it walks a.live, and a cron process is never IN a.live — `units`
// excludes KindCron on purpose, because the scheduler owns those. So an app
// removed after its cron had failed left its record behind forever, in the one
// view an operator consults to rule things out.
//
// Swept against the scheduled set rather than matched by prefix. The prefix it
// used to be, slug + "--", also matches every key of an app whose slug BEGINS
// with this one followed by "--". Nothing produces such a slug today — slugify
// collapses runs of hyphens and randomSlug emits five alphanumerics — but both
// rules live in a TypeScript file in another service, and this key scheme
// silently depended on them.
func (a *Agent) forgetStaleCronRecords(scheduled map[string]bool) {
	for id := range a.cronFail.report() {
		if !scheduled[id] {
			a.cronFail.succeed(id)
		}
	}
}

// forgetStaleStartRecords drops start failure history for processes this node
// is no longer asked to run.
//
// Newly load-bearing. Until the start path was bounded, a startFail record only
// ever existed for a process that had been live, and the removal loop could see
// every one of them. Now a process that has NEVER come up has a record too —
// that is the whole point of the bound — and the removal loop walks a.live, so
// it cannot see exactly the records the bound creates. Without this, the app an
// operator removes after reading "has failed to start 5 times" leaves its record
// in /status with nothing on the node left to explain it.
func (a *Agent) forgetStaleStartRecords(desired map[string]bool) {
	for key := range a.startFail.report() {
		id, _, ok := strings.Cut(key, "@")
		if ok && !desired[id] {
			a.startFail.forgetPrefix(id + "@")
		}
	}
}

// cronBlocked says whether this app's release means its scheduled work must
// not run right now.
//
// Two sources, and both are needed. `relRunning` is live and exact — a release
// executing on another goroutine this instant. `blocked` is reconcileOnce's
// answer, at most one pass (ten seconds) old, and it additionally covers a
// release that is backing off or has given up: in both of those the app's own
// processes are NOT running, and a scheduled job is not more entitled to the
// database than the app is.
//
// Being ten seconds stale can only ever hold a cron back, never let one
// through: a release that starts does so inside reconcileOnce, which sets both
// in the same pass.
func (a *Agent) cronBlocked(slug string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.relRunning[slug] || a.blocked[slug]
}

// mayStart says whether a start may be attempted for this process right now.
//
// This is the bound that was missing. `a.live` only gains an entry on SUCCESS,
// so a process whose start FAILS is never `running` on any later pass and never
// reached the restart counter — it was re-attempted every ten seconds, forever,
// with nothing counting it. That is the same unbounded-retry shape 1A closed on
// the release path and the restart path, through the one door left open, and it
// is the one an app that cannot start at all falls into.
func (a *Agent) mayStart(id, image string, now time.Time) bool {
	key := startKey(id, image)
	switch a.startFail.decide(key, now) {
	case actWait:
		return false
	case actGiveUp:
		if a.quiet.allow("start:"+key, now, giveUpEvery) {
			log.Printf("%s: has failed to start %d times, not trying again — deploy a new image to reset",
				id, maxAttempts)
		}
		return false
	}
	return true
}

// recordStartFailure counts one failed start and keeps its reason.
//
// The count is what mayStart reads on the next pass. The fault is what the
// control plane reads, and it deliberately OUTLIVES the give-up: a process
// nobody is retrying any more is still a process that is failing, and going
// quiet about it is how a node fault turns back into the app's fault.
//
// Not cleared on a successful start. The record is cleared where it always was
// — on a later pass that finds the process still running — because "it started"
// and "it is still up ten seconds later" are different facts, and clearing on
// the first would destroy the bound on a process that starts fine and then
// exits immediately.
func (a *Agent) recordStartFailure(id string, app App, proc Process, err error, now time.Time) {
	n := a.startFail.failWith(startKey(id, imageFor(app, proc)), now, err.Error())
	log.Printf("%s: start failed (%d/%d): %v", id, n, maxAttempts, err)

	fault := classifyStartError(err)
	a.mu.Lock()
	a.faults[id] = ProcessFault{
		Slug: app.Slug, Process: proc.Name,
		Fault: fault, Detail: faultDetail(fault, err),
	}
	a.mu.Unlock()
}

// reportFaults answers the sync with what is currently failing on this node.
//
// A copy under the lock, never the map itself: the caller marshals it on the
// sync goroutine while starts write to it, and handing out the live map is a
// data race with a JSON encoder on one end.
func (a *Agent) reportFaults() []ProcessFault {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]ProcessFault, 0, len(a.faults))
	for _, f := range a.faults {
		out = append(out, f)
	}
	// Stable order so two syncs that say the same thing look the same, in a log
	// and in a diff.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Slug != out[j].Slug {
			return out[i].Slug < out[j].Slug
		}
		return out[i].Process < out[j].Process
	})
	return out
}

// confirmWindow is how old an observation may be and still be reported as
// "running".
//
// Three reconcile passes. One missed pass is ordinary — a slow control plane, a
// node under load — and expiring on it would fail deploys for nothing. Three
// missed passes is a node that has stopped reconciling, and the report going
// quiet is exactly right then: a control plane reading silence rolls the deploy
// back, which is the safe direction. Deliberately shorter than the 90 seconds
// nodeFaultFor allows a fault row, because this steers a deploy to PASS and a
// fault only ever steers one to fail.
const confirmWindow = 30 * time.Second

// confirmRunning records that this process was just seen running.
//
// Takes the lock and re-reads the map rather than writing through a pointer the
// caller already holds: reconcileOnce reads `a.live[id]` outside the lock, and
// by the time the runsc check comes back the entry may have been replaced by a
// restart. Stamping the pointer it read would then vouch for a process that is
// no longer the one in the map, and would race the sync goroutine reading the
// same field.
func (a *Agent) confirmRunning(id string, now time.Time) {
	a.mu.Lock()
	if l, ok := a.live[id]; ok {
		l.confirmed = now
	}
	a.mu.Unlock()
}

// reportRunning answers the sync with what this node is confirmed to be running.
//
// The counterpart to reportFaults, and it answers the question a worker-only app
// makes unanswerable any other way: a bot publishes no route, so there is no
// HTTP probe that can tell "the node started it" from "the node has not got to
// it yet". Only a process the node has WATCHED reach running appears here.
//
// Values, never the *live pointers: the caller marshals this on the sync
// goroutine while reconcile writes to those same structs, and handing out
// pointers puts a JSON encoder on one end of a data race. Command is copied for
// the same reason — a shared backing array is shared state whether or not the
// header is.
func (a *Agent) reportRunning() []ProcessState {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]ProcessState, 0, len(a.live))
	for _, l := range a.live {
		// A process nobody has confirmed lately is not reported at all. Stale
		// beats wrong here: no row fails the deploy, and a wrong row passes one.
		if l.confirmed.IsZero() || now.Sub(l.confirmed) > confirmWindow {
			continue
		}
		s := ProcessState{
			Slug: l.app.Slug, Process: l.proc.Name, Image: imageFor(l.app, l.proc),
		}
		// Health, and only for a kind that has any. `probeAll` skips anything
		// that is not `web` — a worker has no port to ask — so reporting `false`
		// for one would say "broken" about a process nobody ever checked, and
		// the deploy that reads this would refuse every worker-only app.
		if l.proc.Kind == KindWeb {
			ok := l.ok
			s.Healthy = &ok
		}
		if len(l.proc.Command) > 0 {
			s.Command = append([]string(nil), l.proc.Command...)
		}
		out = append(out, s)
	}
	// Stable order so two syncs that say the same thing look the same, in a log
	// and in a diff. Same rule as reportFaults.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Slug != out[j].Slug {
			return out[i].Slug < out[j].Slug
		}
		return out[i].Process < out[j].Process
	})
	return out
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
	scheduled := make(map[string]bool, len(jobs))
	for _, j := range jobs {
		a.cronJobs = append(a.cronJobs, cronJob{app: j.app, proc: j.proc, sch: j.sch, loc: j.loc})
		scheduled[sandboxID(j.app.Slug, j.proc)] = true
	}
	a.mu.Unlock()

	// Here, because this is where the scheduled set is known. A cron process is
	// never in a.live, so the removal loop in reconcileOnce cannot reach these.
	a.forgetStaleCronRecords(scheduled)
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

		// The same gate the web and worker processes have, which this path did
		// not: a scheduled job must not run while its app's release is in
		// flight, or has not succeeded for the image the node is holding.
		//
		// This is the rollback defect 1A fixed, through a different door. A
		// nightly export firing into a database whose migration is halfway
		// applied is worse than a nightly export that does not run — and it is
		// the same customer data either way. `relRunning` is the live, precise
		// half; `blocked` also covers a release that is backing off or has
		// given up, in which case the app's own processes are not running and
		// its scheduled work has no business running either.
		//
		// Checked BEFORE shouldFire so the minute is not consumed: shouldFire
		// records "this (job, minute) has fired". A cron for 03:00 that was
		// blocked at 03:00 must not run at 03:07 instead — by then it is not
		// the job that was scheduled.
		if a.cronBlocked(j.app.Slug) {
			// Throttled, because a release that has given up would otherwise
			// write this line every minute forever. Silence is not an option
			// either: a nightly job that quietly stopped running is the kind of
			// failure nobody notices until the month-end report is empty.
			if a.quiet.allow("cron-blocked:"+id, now, giveUpEvery) {
				log.Printf("%s: cron %s NOT fired — this app's release is in flight or has not succeeded; "+
					"running it now could write into a half-applied migration", j.app.Slug, j.proc.Name)
			}
			continue
		}

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
				n := a.cronFail.failWith(id, time.Now(), err.Error())
				// The count is the whole point. One failed run is an incident;
				// the same one failing every night is a broken job, and on a
				// node whose logs do not leave it those look identical without
				// a number.
				log.Printf("%s: cron failed (%d in a row): %v", id, n, err)
			} else {
				a.cronFail.succeed(id)
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

	// Take back what the previous agent left running, and reap only the rest.
	//
	// This used to be an unconditional ReapAll, and the comment on it said a
	// survivor "is not adoptable". It is now: `Start` records the image, the
	// declared command and the SLOT in the bundle, so everything the in-memory
	// live set held can be recovered exactly. What is left is the reason the
	// systemd unit has always carried KillMode=process — a routine agent restart
	// is not supposed to be an outage — and ReapAll was undoing that on purpose.
	// All 21 apps on this node bounced at 09:51 on 5 Aug for a one-line change.
	//
	// Nothing is adopted blind. reconcileOnce still has to match each candidate
	// against desired state, and anything it does not claim is stopped on the
	// first pass, so a stale image or a deleted app is no more durable than
	// before.
	adoptable := rt.Adoptable()
	reaped := 0
	for _, id := range rt.List() {
		if _, ok := adoptable[id]; !ok {
			rt.Stop(id)
			reaped++
		}
	}
	if reaped > 0 {
		log.Printf("reaped %d sandbox(es) from a previous run", reaped)
	}
	if len(adoptable) > 0 {
		log.Printf("found %d running sandbox(es) to adopt", len(adoptable))
	}

	a := &Agent{rt: rt, src: src, live: map[string]*live{}, slots: map[int]string{},
		adopt:      adoptable,
		released:   map[string]string{},
		relFail:    newFailTracker(),
		relRunning: map[string]bool{},
		startFail:  newFailTracker(),
		cronFail:   newFailTracker(),
		quiet:      newLogThrottle(),
		blocked:    map[string]bool{},
		faults:     map[string]ProcessFault{}}

	// Reserve every adopted sandbox's slot before anything can ask for one.
	for id, ad := range adoptable {
		a.slots[ad.Manifest.Index] = id
	}

	// Wired only when there is a control plane to report to. Leaving it nil on
	// the lab path is deliberate: nil means "this node does not report", which
	// the control plane must not confuse with "this node reports nothing wrong".
	if src.Endpoint != "" {
		src.Report = a.reportFaults
		src.ReportRunning = a.reportRunning
	}

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

	// Which slugs still have at least one process unit, so a release's failure
	// record is forgotten only once its app is truly gone — not while some
	// other process of the same app is still desired.
	survivingSlugs := map[string]bool{}
	for _, u := range units {
		survivingSlugs[u.app.Slug] = true
	}

	// Remove what is no longer wanted, before starting anything new: on a node
	// near its memory ceiling, starting first would be the difference between a
	// clean swap and an OOM.
	for _, id := range have {
		if _, ok := units[id]; !ok {
			log.Printf("%s: removing (no longer desired)", id)
			a.rt.Stop(id)
			a.mu.Lock()
			l, wasLive := a.live[id]
			if wasLive {
				delete(a.slots, l.index)
			}
			delete(a.live, id)
			a.mu.Unlock()

			// Forget this id's own failure history: the start key carries the
			// image, so an exact delete can't find it — remove by prefix.
			a.startFail.forgetPrefix(id + "@")
			// The release and cron records belong to the app, not to this one
			// process — clear them only once no other process of this app
			// survives, so this doesn't hand a still-live app a fresh five
			// attempts. Cron sandbox ids never reach `have` (units excludes
			// KindCron, so a.live never holds one), so an exact-key delete on
			// `id` here could never match a cron record — remove by the app's
			// slug prefix instead, matching sandboxID's `slug + "--" + name + "."`
			// shape.
			if wasLive && !survivingSlugs[l.app.Slug] {
				a.relFail.forgetPrefix(l.app.Slug + "@")
			}
		}
	}

	// The same hole for start records, which the bound on the start path has just
	// made reachable — see forgetStaleStartRecords.
	desiredIDs := make(map[string]bool, len(units))
	for id := range units {
		desiredIDs[id] = true
	}
	a.forgetStaleStartRecords(desiredIDs)

	// Same shape of hole for the fault set, through a different door: a process
	// that FAILED to start never entered a.live either, and that is the only
	// kind of process this map ever holds. So the removal loop above can never
	// clear one, and an app deleted after it failed to start would go on being
	// reported as failing by a node that no longer holds it. Sweep against what
	// is still desired instead.
	a.mu.Lock()
	for id := range a.faults {
		if _, wanted := units[id]; !wanted {
			delete(a.faults, id)
		}
	}
	a.mu.Unlock()

	// An app whose release gave up never started a process, so it never entered
	// a.live and the removal loop above never sees it. That is precisely the app
	// an operator removes after reading "has given up", and without this its
	// record outlives it in /status with nothing left on the node to explain it.
	for key := range a.relFail.report() {
		slug, _, ok := strings.Cut(key, "@")
		if ok && !survivingSlugs[slug] {
			a.relFail.forgetPrefix(slug + "@")
		}
	}

	// Anything still unclaimed after this pass has considered every desired unit
	// is a sandbox nothing wants: an app removed while the agent was down, or a
	// process whose image changed under it. Stopped here rather than left, and
	// its slot released — holding one would leak an address per restart.
	//
	// Deferred so it runs after the claiming loop below, and only once: `adopt`
	// is empty from the second pass on, so this costs nothing thereafter.
	defer func() {
		a.mu.Lock()
		leftovers := make([]Adopted, 0, len(a.adopt))
		for id, ad := range a.adopt {
			leftovers = append(leftovers, ad)
			delete(a.adopt, id)
			delete(a.slots, ad.Manifest.Index)
		}
		a.mu.Unlock()
		for _, ad := range leftovers {
			log.Printf("%s: not desired after the restart — stopping", ad.ID)
			a.rt.Stop(ad.ID)
		}
	}()

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

		// A sandbox that outlived the previous agent, claimed here rather than
		// killed and rebuilt. Only on an exact match of the two fields that mean
		// "this is a different program" — the same test a live process gets just
		// below, against the same manifest fields Start recorded. A changed image
		// falls through and is started normally, so a deploy that happened while
		// the agent was down still takes effect.
		if !running {
			a.mu.Lock()
			ad, canAdopt := a.adopt[id]
			if canAdopt && ad.Manifest.Image == imageFor(u.app, u.proc) && sameStrings(ad.Manifest.Command, u.proc.Command) {
				delete(a.adopt, id)
				now := time.Now()
				a.live[id] = &live{
					app: u.app, proc: u.proc, net: ad.Net, index: ad.Manifest.Index,
					// `ok` stays false: this agent has not health-checked it yet,
					// and inheriting a verdict it never reached would report a
					// process as healthy on the word of a process that is gone.
					// The liveness pass sets it within one interval.
					since: now, confirmed: now,
				}
				l, running = a.live[id], true
				a.mu.Unlock()
				log.Printf("%s: adopted at %s (survived the agent restart)", id, ad.Net.IP)
			} else {
				a.mu.Unlock()
			}
		}

		if running {
			// Restart on a changed image, command OR environment. The first two
			// are what mean "this is a different program"; the third is what
			// means "the same program, told something different", and leaving it
			// out made `supersonic env set` a no-op on this runtime — the spec
			// changed, the node compared two fields that had not, and the process
			// kept running with the value the user had just replaced.
			//
			// Secrets are compared as NAMES, which is all the spec carries. A
			// rotated value behind an unchanged name does not restart anything,
			// and should not: that is a Secret Manager version change, and an app
			// that wants it takes it on its next start like every other one.
			if imageFor(l.app, l.proc) == imageFor(u.app, u.proc) &&
				sameStrings(l.proc.Command, u.proc.Command) &&
				sameStringMap(l.app.Env, u.app.Env) &&
				sameStringMap(l.app.Secrets, u.app.Secrets) {
				if st, err := runscStatusFn(id); err == nil && st.Status == "running" {
					// Forget every image this id ever failed on, not just the
					// current one — otherwise a bad image's record (e.g.
					// `id@bad`, fails: 5) outlives the fix and /status keeps
					// reporting a healthy process as given-up forever.
					a.startFail.forgetPrefix(id + "@")
					// The observation this pass just made, kept rather than
					// thrown away. It costs nothing — the subprocess has already
					// run and already answered — and it is the only thing that
					// keeps a worker's report alive between deploys. Under the
					// `err == nil && running` branch on purpose: a process runsc
					// will not vouch for must age out, not be re-stamped.
					a.confirmRunning(id, time.Now())
					continue
				}
				// It died. Restarting is right; restarting it every ten seconds
				// forever is not — that is a broken image turning into a
				// permanent cycle of sandbox creation on a node holding
				// nineteen working apps.
				key := startKey(id, imageFor(u.app, u.proc))
				switch a.startFail.decide(key, time.Now()) {
				case actWait:
					continue
				case actGiveUp:
					if a.quiet.allow("died:"+key, time.Now(), giveUpEvery) {
						log.Printf("%s: has died %d times, not restarting — deploy a new image to reset",
							id, maxAttempts)
					}
					continue
				}
				n := a.startFail.fail(key, time.Now())
				log.Printf("%s: not running, restarting (%d/%d)", id, n, maxAttempts)
			} else {
				// Which of the three, because the answer changes what a person
				// looks at next: a new image is a deploy, a new command is a
				// deploy, and a new environment is somebody running `env set`.
				what := "image"
				if imageFor(l.app, l.proc) == imageFor(u.app, u.proc) {
					what = "environment"
					if !sameStrings(l.proc.Command, u.proc.Command) {
						what = "command"
					}
				}
				log.Printf("%s: %s changed, restarting", id, what)
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
			// A process that has NEVER come up needs the same bound as one that
			// came up and died, and did not have it.
			//
			// `a.live` only gains an entry on SUCCESS. So a process whose start
			// fails is not `running` on this pass or any later one, never reaches
			// the counter above, and was re-attempted every ten seconds forever
			// with nothing counting — the third unbounded retry loop, through the
			// one door 1A left open. It closed the release loop and the restart
			// loop; this is the start loop, and it is the one an app that cannot
			// start at all falls into.
			//
			// Same key shape as the restart counter, `id@image`, so a new deploy
			// is a new key and clears the state without this code having to
			// notice that a deploy happened. A process that both died AND then
			// would not restart is counted by both paths in the same pass and so
			// reaches the cap sooner; that is the safe direction to be wrong in,
			// and it is more broken, not less.
			if !a.mayStart(id, imageFor(u.app, u.proc), time.Now()) {
				continue
			}
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
		inFlight := a.relRunning[slug]
		alreadyRan := a.released[slug] == app.Image
		a.mu.Unlock()

		// In flight FIRST, and keyed by slug rather than slug@image. A release
		// running for a DIFFERENT image must still block this app: rolling back
		// to an image whose release already succeeded would otherwise pass the
		// alreadyRan check and start the web process while the previous image's
		// migration is still writing.
		if inFlight {
			blocked[slug] = true
			continue
		}
		if alreadyRan {
			continue
		}

		switch a.relFail.decide(key, now) {
		case actWait:
			blocked[slug] = true
			continue
		case actGiveUp:
			// Said repeatedly rather than once ever, because /status is the only
			// other view and a human tailing the log has to be able to meet this
			// state without going to query it. But not once per pass: that is
			// 8,640 lines a day into an append-only file on a disk that does not
			// survive a stop, measured at ~1 MB/day per given-up app. The key
			// carries the image, so a new deploy is announced immediately.
			if a.quiet.allow("release:"+key, now, giveUpEvery) {
				log.Printf("%s: release has failed %d times, not retrying — deploy a new image to reset",
					slug, maxAttempts)
			}
			blocked[slug] = true
			continue
		}

		var rel Process
		found, extra := false, 0
		for _, p := range processesOf(app) {
			if p.Kind != KindRelease {
				continue
			}
			if found {
				extra++
				continue
			}
			rel, found = p, true
		}
		if extra > 0 {
			// Running two concurrently would double-book the slot and the
			// sandbox id, so only the first runs — but an app that declares two
			// is misconfigured and must not discover that silently.
			log.Printf("%s: %d release processes declared, running only %q", slug, extra+1, rel.Name)
		}
		if !found {
			continue
		}

		blocked[slug] = true
		a.mu.Lock()
		a.relRunning[slug] = true
		idx := a.slotFor(sandboxID(slug, rel))
		a.mu.Unlock()

		go func(slug, key string, app App, p Process, idx int) {
			log.Printf("%s: running release", slug)
			err := a.rt.RunToCompletion(app, p, idx, 30*time.Minute)

			// Record the outcome BEFORE clearing in-flight, so the slug is
			// never observable as idle-and-unrecorded — a reconcile pass
			// landing in that window would relaunch with no backoff at all.
			if err != nil {
				n := a.relFail.failWith(key, time.Now(), err.Error())
				log.Printf("%s: release FAILED (%d/%d), not starting the app: %v",
					slug, n, maxAttempts, err)
			} else {
				// Forget every image this slug ever failed a release on, not
				// just the one that just succeeded — otherwise a bad image's
				// record (e.g. `slug@bad`, fails: 5) survives a later good
				// deploy and /status keeps reporting a recovered app as
				// given-up forever.
				a.relFail.forgetPrefix(slug + "@")
				log.Printf("%s: release finished", slug)
			}

			a.mu.Lock()
			delete(a.relRunning, slug)
			delete(a.slots, idx)
			if err == nil {
				a.released[slug] = app.Image
			}
			a.mu.Unlock()
		}(slug, key, app, rel, idx)
	}

	// Publish, so the cron tick can ask the same question. Taken here rather
	// than inside the loop above: `blocked` is only complete once every release
	// has been considered, and a half-built set would let a cron through for an
	// app whose release had not been reached yet.
	a.mu.Lock()
	a.blocked = blocked
	a.mu.Unlock()

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
			// Where this app's OTHER processes are, so a `${process:name}` in the
			// environment can be resolved to an address. Read under the same lock
			// as the slot and copied, because `a.live` is written by every other
			// start running concurrently with this one.
			//
			// A sidecar that has not started yet is simply absent, and the
			// placeholder survives into the app's environment unresolved — which
			// is what an app's own error message should say, rather than a
			// half-formed URL failing inside a client library. The next reconcile
			// pass restarts nothing on its own; a client that retries connects
			// when the sidecar arrives, and one that does not is restarted by its
			// own exit.
			peers := map[string]string{}
			for _, l := range a.live {
				if l.app.Slug == app.Slug && l.net != nil && l.proc.Name != proc.Name {
					peers[l.proc.Name] = l.net.IP.String()
				}
			}
			app.ProcessIPs = peers
			a.mu.Unlock()

			started := time.Now()
			net, err := a.rt.Start(app, proc, idx)
			if err != nil {
				// Counted, which it was not before. The reconcile loop reads this
				// on the next pass and stops re-attempting a start that cannot
				// succeed; without the count it re-attempted forever.
				//
				// NOT cleared on success here, deliberately. The record is
				// cleared where it always was — on a later pass that finds the
				// process still running — because "it started" and "it is still
				// up ten seconds later" are different facts, and clearing on the
				// first would destroy the bound on a process that starts fine
				// and then exits immediately.
				a.recordStartFailure(id, app, proc, err, time.Now())
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
			// `confirmed` is set here and not left zero, because Start does not
			// return until it has polled `runsc state` to "running" itself
			// (container.go) — so this IS an observation, made moments ago, not
			// a belief. Leaving it zero would mean a worker's first report waited
			// for the next reconcile pass, which is up to ten seconds of a deploy
			// timeout spent on a process that is already up.
			a.live[id] = &live{app: app, proc: proc, net: net, index: idx,
				since: time.Now(), confirmed: time.Now()}
			// Same critical section as the live entry on purpose. A process that
			// is running is not failing, and leaving the two facts to be written
			// separately is a window in which the node reports both.
			delete(a.faults, id)
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
			Prefix:  l.proc.Prefix,
		})
	}
	// Everything the fleet holds that this node does not. Local first: a slug
	// this node runs is never routed off it, whatever the control plane said —
	// the placement it is reading may be one sync older than the app it started.
	local := make(map[string]bool, len(routes))
	for _, r := range routes {
		local[r.Slug] = true
	}
	for _, p := range a.desired.Peers {
		if local[p.Slug] || p.Slug == "" || p.Addr == "" {
			continue
		}
		routes = append(routes, Route{
			Slug: p.Slug, Addr: p.Addr,
			// Healthy because the node that holds it decides that, and this node
			// has no way to ask. Forwarding and letting the far end answer 503 is
			// the truthful failure; refusing here would report an app down on the
			// word of a machine that is not running it.
			Healthy: true,
			Peer:    true,
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
		// Healthy is a POINTER so it can be null, and that is the whole change.
		//
		// `probeAll` only checks `web` — a worker has no port to ask — so `l.ok`
		// stays false for one forever, and this reported `"healthy": false` for a
		// process nobody had ever probed. Every worker on the node read as broken
		// for life. It cost two sessions a detour each, one of them mine, and the
		// node was right every time: nothing was wrong, the report could not say
		// "not applicable" and said "no" instead.
		type item struct {
			Slug    string `json:"slug"`
			Kind    string `json:"kind"`
			Image   string `json:"image"`
			Addr    string `json:"addr"`
			Healthy *bool  `json:"healthy"`
			Status  string `json:"status"`
		}
		out := []item{}
		for id, l := range a.live {
			st, _ := runscStatus(id)
			var healthy *bool
			if l.proc.Kind == KindWeb {
				ok := l.ok
				healthy = &ok
			}
			out = append(out, item{
				Slug: id, Image: imageFor(l.app, l.proc), Kind: string(l.proc.Kind),
				Addr:    fmt.Sprintf("%s:%d", l.net.IP, effectivePort(l.app, l.proc)),
				Healthy: healthy, Status: st.Status,
			})
		}
		a.mu.Unlock()
		sort.Slice(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
		// Processes AND what has stopped being retried. A node that has given up
		// on something is the one state that is invisible from the outside: the
		// process is simply absent, which looks the same as never having been
		// asked for.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Processes any                  `json:"processes"`
			Failures  map[string]FailState `json:"failures"`
		}{
			Processes: out,
			Failures:  mergeFailures(a.relFail, a.startFail, a.cronFail),
		})
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

// mergeFailures flattens the three trackers into one map for /status.
//
// The keys are already distinguishable — a release key is slug@image, a start
// key is id@image, a cron key is a bare sandbox id — but that non-collision
// guarantee lives entirely outside this package, in what callers choose to
// pass as keys. A collision is therefore reported loudly rather than silently
// resolved by last-write-wins.
func mergeFailures(ts ...*failTracker) map[string]FailState {
	out := map[string]FailState{}
	for _, t := range ts {
		if t == nil {
			continue
		}
		for k, v := range t.report() {
			if _, dup := out[k]; dup {
				log.Printf("status: failure key %q reported by two trackers — keeping the first", k)
				continue
			}
			out[k] = v
		}
	}
	return out
}

// giveUpEvery is how often a state that is not going to change on its own is
// repeated into the node's log. Ten minutes is 144 lines a day instead of
// 8,640, and still soon enough that a human tailing the log meets it.
const giveUpEvery = 10 * time.Minute

// startKey is the failure key for one process on one image.
//
// The image is IN the key on purpose: a new deploy is a new key, so a fix
// clears the give-up state without anything here having to notice that a deploy
// happened. Written once, here, because two paths now build it — the restart
// counter and the start counter — and they must agree or a process would carry
// two independent counts.
func startKey(id, image string) string { return id + "@" + image }

// sameStringMap compares two env-shaped maps, nil and empty being the same
// thing — a spec that omits `env` and one that sends `{}` say the same.
func sameStringMap(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

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
