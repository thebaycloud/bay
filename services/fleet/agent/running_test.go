package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The placement spec as the CONTROL PLANE writes it, byte for byte.
//
// Hand-writing the Go value would prove only that this file and the code under
// test share an imagination. Everything the verdict compares — the process name
// the row is keyed on, the image, the argv — is derived from this blob by the
// same `processesOf` the reconcile loop uses, so a rename on either side of the
// wire shows up as a failing test rather than as a worker-only deploy that
// rolls back for no visible reason.
//
// Shaped exactly as buildAppSpec emits it (apps/web/lib/fleet-spec.ts): a
// worker-only app declares `processes` and no `web` among them, and a command
// arrives already wrapped in /bin/sh -c by shellArgv.
const workerOnlySpecJSON = `{"apps":[{
  "slug": "a8ebb",
  "image": "us-central1-docker.pkg.dev/p/r/a8ebb@sha256:abc",
  "port": 8080,
  "memoryBytes": 2147483648,
  "cpuShares": 1024,
  "healthPath": "/",
  "processes": [
    {"name": "bot", "kind": "worker", "command": ["/bin/sh", "-c", "python bot.py"]}
  ]
}]}`

// workerOnlyDesired decodes that spec and expands it the way the agent does.
func workerOnlyDesired(t *testing.T) (Desired, App, Process) {
	t.Helper()
	var d Desired
	if err := json.Unmarshal([]byte(workerOnlySpecJSON), &d); err != nil {
		t.Fatalf("the placement spec did not decode: %v", err)
	}
	if len(d.Apps) != 1 {
		t.Fatalf("want one app, got %d", len(d.Apps))
	}
	procs := processesOf(d.Apps[0])
	if len(procs) != 1 {
		t.Fatalf("want one process, got %d", len(procs))
	}
	if hasWeb(procs) {
		t.Fatal("the fixture is meant to be worker-only and declares a web process")
	}
	return d, d.Apps[0], procs[0]
}

func agentForRunningTests() *Agent {
	return &Agent{
		live:          map[string]*live{},
		slots:         map[int]string{},
		released:      map[string]string{},
		relFail:       newFailTracker(),
		relRunning:    map[string]bool{},
		startFail:     newFailTracker(),
		cronFail:      newFailTracker(),
		quiet:         newLogThrottle(),
		blocked:       map[string]bool{},
		faults:        map[string]ProcessFault{},
		pendingTiming: map[string]StartTiming{},
	}
}

func TestAConfirmationThatHasGoneStaleIsNotReported(t *testing.T) {
	// The safety property, and the reason this is a stamp rather than a read of
	// a.live. `a.live` is a memory belief that survives a node which has stopped
	// reconciling entirely — loadDesired returning early takes the whole pass
	// with it, including the liveness check — so reporting from it would vouch
	// for a worker that died minutes ago and pass the deploy that placed it.
	_, app, proc := workerOnlyDesired(t)
	a := agentForRunningTests()
	a.live[sandboxID(app.Slug, proc)] = &live{
		app: app, proc: proc,
		confirmed: time.Now().Add(-60 * time.Second),
	}

	if got := a.reportRunning(); len(got) != 0 {
		t.Fatalf("a confirmation 60s old was still reported as running: %+v", got)
	}
}

func TestAProcessNeverConfirmedIsNotReported(t *testing.T) {
	// The zero value must not read as "confirmed at the epoch, therefore old" by
	// accident — it must be refused on its own terms, because an entry with no
	// observation behind it is precisely what a report must never carry.
	_, app, proc := workerOnlyDesired(t)
	a := agentForRunningTests()
	a.live[sandboxID(app.Slug, proc)] = &live{app: app, proc: proc}

	if got := a.reportRunning(); len(got) != 0 {
		t.Fatalf("an unconfirmed process was reported as running: %+v", got)
	}
}

func TestAFreshlyConfirmedProcessIsReportedWithItsImageAndCommand(t *testing.T) {
	// Image AND command, because that pair is the agent's own predicate for
	// "this is a different program" (reconcileOnce restarts on either changing).
	// A report carrying only the slug would let a redeploy that changed the
	// worker's command pass on the process still running the old one.
	_, app, proc := workerOnlyDesired(t)
	a := agentForRunningTests()
	id := sandboxID(app.Slug, proc)
	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now().Add(-1 * time.Second)}

	got := a.reportRunning()
	if len(got) != 1 {
		t.Fatalf("want one row, got %+v", got)
	}
	// Keyed off the producer, never off "bot" typed a second time: this is what
	// makes the agent's `process` field and the control plane's requiredProcesses
	// provably the same string.
	if got[0].Slug != app.Slug || got[0].Process != proc.Name {
		t.Fatalf("got %s/%s, want %s/%s", got[0].Slug, got[0].Process, app.Slug, proc.Name)
	}
	if got[0].Image != app.Image {
		t.Fatalf("image %q, want %q", got[0].Image, app.Image)
	}
	if !sameStrings(got[0].Command, proc.Command) {
		t.Fatalf("command %v, want %v", got[0].Command, proc.Command)
	}
	// And the row must be addressable by the id the control plane will compute.
	if id != app.Slug+"--"+proc.Name+"." {
		t.Fatalf("sandbox id shape changed: %q", id)
	}
}

func TestReportRunningIsACopyAndOrdered(t *testing.T) {
	// Same rule as reportFaults: the sync goroutine marshals this while reconcile
	// writes to the same structs, so nothing shared may leave the lock — the
	// Command slice included, where a shared backing array races just as well as
	// a shared pointer does.
	now := time.Now()
	a := agentForRunningTests()
	a.live["zulu--web."] = &live{
		app: App{Slug: "zulu", Image: "img"}, proc: Process{Name: "web"}, confirmed: now}
	a.live["alpha--worker."] = &live{
		app: App{Slug: "alpha", Image: "img"}, proc: Process{Name: "worker", Command: []string{"/bin/sh", "-c", "x"}}, confirmed: now}
	a.live["alpha--bot."] = &live{
		app: App{Slug: "alpha", Image: "img"}, proc: Process{Name: "bot"}, confirmed: now}

	got := a.reportRunning()
	want := []string{"alpha/bot", "alpha/worker", "zulu/web"}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, w := range want {
		if got[i].Slug+"/"+got[i].Process != w {
			t.Fatalf("position %d: got %s/%s, want %s", i, got[i].Slug, got[i].Process, w)
		}
	}

	got[0].Slug = "mutated"
	got[1].Command[0] = "mutated"
	if a.live["alpha--bot."].app.Slug != "alpha" {
		t.Fatal("reportRunning handed out state the caller can mutate")
	}
	if a.live["alpha--worker."].proc.Command[0] != "/bin/sh" {
		t.Fatal("reportRunning handed out the live Command slice, not a copy")
	}
}

// reconcileWith drives one real reconcile pass against a desired-state file and
// a scripted runsc, and returns the confirmation stamp afterwards.
//
// A real pass rather than a call to confirmRunning, because the thing worth
// proving is the WIRING: a stamp nothing refreshes ages out in thirty seconds
// and fails every worker-only deploy on the fleet, and a stamp refreshed outside
// the `running` branch vouches for a dead process forever. Only driving the pass
// can tell those apart.
func reconcileWith(t *testing.T, a *Agent, d Desired, status func(string) (runscState, error)) {
	t.Helper()
	dir := t.TempDir()

	statefile := filepath.Join(dir, "desired.json")
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal desired: %v", err)
	}
	if err := os.WriteFile(statefile, b, 0o600); err != nil {
		t.Fatalf("write desired: %v", err)
	}
	a.src = &Source{Local: statefile}

	oldRoutes, oldStatus := routesPath, runscStatusFn
	routesPath = filepath.Join(dir, "routes.json")
	runscStatusFn = status
	t.Cleanup(func() { routesPath, runscStatusFn = oldRoutes, oldStatus })

	if err := a.reconcileOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func TestReconcileRefreshesTheConfirmationItAlreadyPaidFor(t *testing.T) {
	// The liveness check runs `runsc state` every pass and already requires
	// "running" before leaving a process alone. Keeping that answer is what makes
	// a worker's report survive between deploys, and it costs no extra
	// subprocess — which is the whole reason the stamp is here and not a second
	// exec on the sync path.
	d, app, proc := workerOnlyDesired(t)
	a := agentForRunningTests()
	id := sandboxID(app.Slug, proc)
	stale := time.Now().Add(-5 * time.Minute)
	a.live[id] = &live{app: app, proc: proc, confirmed: stale}

	asked := []string{}
	reconcileWith(t, a, d, func(want string) (runscState, error) {
		asked = append(asked, want)
		return runscState{Status: "running"}, nil
	})

	if len(asked) != 1 || asked[0] != id {
		t.Fatalf("reconcile asked runsc about %v, want [%s]", asked, id)
	}
	a.mu.Lock()
	got := a.live[id].confirmed
	a.mu.Unlock()
	if !got.After(stale) {
		t.Fatal("a pass that watched runsc say 'running' did not record the observation — " +
			"every worker's report ages out in 30s and every worker-only deploy rolls back")
	}
	if len(a.reportRunning()) != 1 {
		t.Fatal("the process reconcile just confirmed is not being reported")
	}
}

func TestReconcileDoesNotConfirmAProcessRunscWillNotVouchFor(t *testing.T) {
	// The direction that matters. If the stamp were refreshed for every live
	// entry rather than only under `err == nil && running`, a worker that died
	// the instant it started would go on being reported as running and its
	// deploy would pass — which is the exact flip-on-faith this sequence exists
	// to prevent.
	//
	// The start record is pre-loaded past maxAttempts so the pass gives up
	// rather than restarting: this test is about the stamp, and a restart would
	// need a real containerd.
	d, app, proc := workerOnlyDesired(t)
	a := agentForRunningTests()
	id := sandboxID(app.Slug, proc)
	for i := 0; i < maxAttempts; i++ {
		a.startFail.fail(startKey(id, app.Image), time.Now())
	}
	stale := time.Now().Add(-5 * time.Minute)
	a.live[id] = &live{app: app, proc: proc, confirmed: stale}

	reconcileWith(t, a, d, func(string) (runscState, error) {
		return runscState{Status: "stopped"}, nil
	})

	a.mu.Lock()
	got := a.live[id].confirmed
	a.mu.Unlock()
	if !got.Equal(stale) {
		t.Fatal("a process runsc reported as stopped was confirmed as running anyway")
	}
	if r := a.reportRunning(); len(r) != 0 {
		t.Fatalf("a stopped process was reported as running: %+v", r)
	}
}

func TestConfirmRunningIgnoresAProcessThatIsNotLive(t *testing.T) {
	// reconcileOnce reads a.live outside the lock and stamps after the runsc call
	// returns, so the entry can be gone — or replaced by a restart — in between.
	// Re-reading the map under the lock is what keeps this from resurrecting a
	// process that has just been removed.
	a := agentForRunningTests()
	a.confirmRunning("gone--bot.", time.Now())
	if len(a.live) != 0 {
		t.Fatalf("confirmRunning invented a live entry: %+v", a.live)
	}
}

// --- the wire ---------------------------------------------------------------

func TestAnAgentThatDoesNotReportRunningOmitsTheFieldEntirely(t *testing.T) {
	// Absence is "this agent does not report", and it is the state every agent
	// built before this field existed is permanently in. The control plane keys
	// "leave the stored rows alone" off it, so absence has to survive the
	// encoder — a rolling agent upgrade must not read as the whole fleet having
	// stopped running things.
	body := captureSync(t, &Source{Identity: NodeIdentity{Name: "fleet-lab-1"}})
	if _, present := body["running"]; present {
		t.Fatalf("a nil ReportRunning must send no running field at all, got %s", body["running"])
	}
}

func TestAnAgentRunningNothingSendsAnEmptyArrayNotNull(t *testing.T) {
	// `null` is not an array, so a reader testing for one would take it as "does
	// not report" and never clear the rows of a node that has genuinely stopped
	// running anything — leaving a deleted app looking placed and healthy.
	body := captureSync(t, &Source{
		Identity:      NodeIdentity{Name: "fleet-lab-1"},
		ReportRunning: func() []ProcessState { return nil },
	})
	got, present := body["running"]
	if !present {
		t.Fatal("an agent running nothing must still send running: []")
	}
	if string(got) != "[]" {
		t.Fatalf("want [], got %s — null is not an array and reads as 'does not report'", got)
	}
}

func TestAReportedRunningProcessReachesTheWire(t *testing.T) {
	_, app, proc := workerOnlyDesired(t)
	body := captureSync(t, &Source{
		Identity: NodeIdentity{Name: "fleet-lab-1"},
		ReportRunning: func() []ProcessState {
			return []ProcessState{{Slug: app.Slug, Process: proc.Name, Image: app.Image, Command: proc.Command}}
		},
	})
	var got []ProcessState
	if err := json.Unmarshal(body["running"], &got); err != nil {
		t.Fatalf("running did not decode: %v", err)
	}
	if len(got) != 1 || got[0].Slug != app.Slug || got[0].Process != proc.Name {
		t.Fatalf("got %+v", got)
	}
	if got[0].Image != app.Image || !sameStrings(got[0].Command, proc.Command) {
		t.Fatalf("the image and command did not survive the wire: %+v", got[0])
	}
}

func TestTheTwoReportsTravelIndependently(t *testing.T) {
	// One is a claim that something is broken and the other that something
	// works. An agent may legitimately have one and not the other, and the
	// control plane treats their absence differently — so neither may switch the
	// other on or off.
	body := captureSync(t, &Source{
		Identity: NodeIdentity{Name: "fleet-lab-1"},
		Report:   func() []ProcessFault { return nil },
	})
	if _, present := body["running"]; present {
		t.Fatal("reporting faults switched on the running report")
	}
	body = captureSync(t, &Source{
		Identity:      NodeIdentity{Name: "fleet-lab-1"},
		ReportRunning: func() []ProcessState { return nil },
	})
	if _, present := body["processes"]; present {
		t.Fatal("reporting running switched on the fault report")
	}
	// And the identity still travels with both, because placement reads
	// memoryBytes and cpus off this same POST.
	body = captureSync(t, &Source{
		Identity:      NodeIdentity{Name: "fleet-lab-1", Zone: "us-central1-a", InternalIP: "10.0.0.2", MemoryBytes: 8 << 30, CPUs: 4},
		Report:        func() []ProcessFault { return nil },
		ReportRunning: func() []ProcessState { return nil },
	})
	for _, k := range []string{"name", "zone", "internalIp", "memoryBytes", "cpus", "processes", "running"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("the sync body lost %q", k)
		}
	}
}
