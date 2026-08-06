package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// captureAllSyncs stands in for the control plane across a WHOLE reconcile
// pass, not just its first request — reconcileOnce may POST more than once,
// and the thing under test is which of those POSTs a freshly confirmed
// process shows up on. Every request gets the same desired state back, so
// the pass never sees its own work as a reason to redo anything.
func captureAllSyncs(t *testing.T, d Desired) (*httptest.Server, *[][]byte) {
	t.Helper()
	resp, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal desired: %v", err)
	}
	bodies := [][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, raw)
		w.Write(resp)
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

// runningSlugs pulls the slugs the `running` field of one captured sync body
// names, or nil if the field is absent.
func runningSlugs(t *testing.T, raw []byte) []string {
	t.Helper()
	var body struct {
		Running *[]ProcessState `json:"running"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("a captured sync body did not decode: %v (%s)", err, raw)
	}
	if body.Running == nil {
		return nil
	}
	out := make([]string, 0, len(*body.Running))
	for _, p := range *body.Running {
		out = append(out, p.Slug+"/"+p.Process)
	}
	return out
}

// TestAProcessConfirmedThisPassIsReportedThisPass drives one real
// reconcileOnce pass in which a process becomes CONFIRMED during the pass
// itself — via adoption, the one path that reaches confirmation without a
// real containerd — and checks the sync traffic that pass generates.
//
// loadDesired's own POST, at the very top of reconcileOnce, is built and sent
// before this pass has adopted or confirmed anything, so it can only ever
// describe the pass before this one — see desired.go's ReportNow. If nothing
// after that POST ever tells the control plane about this pass's own work,
// the corroboration a redeploy waits on has to wait for pass N+1's poll
// instead, which is the 10-15s this ticket exists to remove.
func TestAProcessConfirmedThisPassIsReportedThisPass(t *testing.T) {
	d, app, proc := workerOnlyDesired(t)
	id := sandboxID(app.Slug, proc)

	srv, bodies := captureAllSyncs(t, d)

	a := agentForRunningTests()
	a.src = &Source{
		Endpoint: srv.URL,
		Identity: NodeIdentity{Name: "fleet-lab-1"},
	}
	a.src.Report = a.reportFaults
	a.src.ReportRunning = a.reportRunning

	// A sandbox that survived an agent restart, matching desired state on the
	// two fields that mean "same program" — the adoption path claims it
	// in-process, with no containerd involved, and confirms it the moment it
	// is claimed (see reconcileOnce's adoption branch). That confirmation is
	// this pass's own work, made after loadDesired's POST has already gone
	// out — exactly the ordering the redeploy corroboration tail depends on.
	a.adopt = map[string]Adopted{
		id: {ID: id, Manifest: sandboxManifest{
			Slug: app.Slug, Process: proc.Name, Kind: string(proc.Kind),
			Image: imageFor(app, proc), Command: proc.Command, Index: 0,
		}, Net: &SandboxNet{IP: ipForIndex(0)}},
	}
	a.slots[0] = id

	dir := t.TempDir()
	oldRoutes := routesPath
	routesPath = filepath.Join(dir, "routes.json")
	t.Cleanup(func() { routesPath = oldRoutes })

	// Adoption alone only makes the process LIVE. reconcileOnce still runs the
	// same liveness check a process gets on every later pass — matching image
	// and command, then asking runsc — before it will confirm it, and this
	// fixture has no real containerd for that to ask. Faking "running" here is
	// what turns adoption into a confirmation within this pass, same as it
	// would on a node where runsc actually answers.
	oldStatus := runscStatusFn
	runscStatusFn = func(string) (runscState, error) { return runscState{Status: "running"}, nil }
	t.Cleanup(func() { runscStatusFn = oldStatus })

	if err := a.reconcileOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if len(*bodies) == 0 {
		t.Fatal("reconcileOnce sent no sync at all")
	}

	// The defect, stated directly: loadDesired's POST — the first one this
	// pass sent — was built before the adoption above ran, so it cannot have
	// carried it.
	if got := runningSlugs(t, (*bodies)[0]); contains(got, app.Slug+"/"+proc.Name) {
		t.Fatalf("the pass's OWN first sync already claimed to know about a process it had not "+
			"adopted yet — this assertion needs a slower fixture, not a passing test: got %v", got)
	}

	found := false
	for _, b := range *bodies {
		if contains(runningSlugs(t, b), app.Slug+"/"+proc.Name) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("none of this pass's %d sync(s) reported %s/%s as running — "+
			"the confirmation happened this pass but the control plane has to wait "+
			"for pass N+1's poll to hear about it", len(*bodies), app.Slug, proc.Name)
	}
}

// TestAnIdlePassSendsOnlyOneSync is the frugality half of the fix: a pass
// that places nothing new — everything already live is simply re-confirmed,
// which the control plane already learned about on an earlier pass — must
// not double this node's sync traffic. Nothing is waiting on a refresh of a
// fact the control plane already has; only a NEW placement earns the extra
// POST.
func TestAnIdlePassSendsOnlyOneSync(t *testing.T) {
	d, app, proc := workerOnlyDesired(t)
	id := sandboxID(app.Slug, proc)

	srv, bodies := captureAllSyncs(t, d)

	a := agentForRunningTests()
	a.src = &Source{Endpoint: srv.URL, Identity: NodeIdentity{Name: "fleet-lab-1"}}
	a.src.Report = a.reportFaults
	a.src.ReportRunning = a.reportRunning

	// Already live and confirmed from some earlier pass — not adopted or
	// started by the pass under test.
	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now().Add(-5 * time.Second)}

	dir := t.TempDir()
	oldRoutes := routesPath
	routesPath = filepath.Join(dir, "routes.json")
	t.Cleanup(func() { routesPath = oldRoutes })

	oldStatus := runscStatusFn
	runscStatusFn = func(string) (runscState, error) { return runscState{Status: "running"}, nil }
	t.Cleanup(func() { runscStatusFn = oldStatus })

	if err := a.reconcileOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("an idle pass sent %d syncs, want 1 — a pass with nothing new to place must not "+
			"double this node's sync traffic", len(*bodies))
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
