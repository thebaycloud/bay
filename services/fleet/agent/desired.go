package main

// Where desired state comes from.
//
// The agent ASKS. Nothing pushes to a node. That direction is the availability
// story: a control plane that is down cannot take running apps with it, and a
// node that reboots while the control plane is unreachable comes back serving
// from the answer it cached last time.
//
// Order of preference, and each fallback is deliberate:
//   1. the control plane, if one is configured
//   2. the last answer it gave, from disk
//   3. a local file, for a node with no control plane at all (the lab)

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const cachePath = "/srv/state/desired.cache.json"

// NodeIdentity is what this node tells the control plane about itself.
type NodeIdentity struct {
	Name        string `json:"name"`
	Zone        string `json:"zone"`
	InternalIP  string `json:"internalIp"`
	MemoryBytes int64  `json:"memoryBytes"`
	CPUs        int    `json:"cpus"`
}

// ProcessFault is one process's most recent start failure, as the node sees it.
//
// Sent on the sync that already runs every ten seconds, so there is no new
// channel to secure and no second auth surface.
//
// Detail carries the error text ONLY for a classified fault. An unclassified
// failure's error can be the last 800 bytes of the app's own log (container.go
// wraps the runsc tail into it), which is the customer's stdout and can hold
// anything they printed — including a credential. That text already goes to the
// node's log; this field would take it off the node, into shared Postgres, and
// in phase 1C-1 Task 4 into a deploy reason a user reads. The classified cases
// are strings this package writes itself — dbPathReachable's and resolveSecret's
// — and carry no app output at all.
type ProcessFault struct {
	Slug    string `json:"slug"`
	Process string `json:"process"`
	Fault   Fault  `json:"fault"`
	Detail  string `json:"detail,omitempty"`
}

// ProcessState is one process this node is CONFIRMED to be running right now.
//
// The positive half of the channel ProcessFault opened, and it exists because
// absence is not evidence. `faults` is written only when a start FAILS, so
// "nothing failing" is also what a node says about a process it has not fetched
// yet, one blocked behind a release, and one whose release failed. A worker-only
// app has no route to probe, so absence-plus-time was the only other verdict
// available and it passes an app that never came up — which is the one thing the
// place-verify-flip sequence exists to stop.
//
// Image and Command, because those are the agent's OWN predicate for "this is a
// different program" (see reconcileOnce: a live process is left alone only while
// both still match what was placed). Reporting the slug alone would pass a
// redeploy that changed the worker's command on the process still running the
// old one. Nothing else travels: env and secrets are not in that predicate, so
// the node would not restart on a change to them and a report carrying them
// would claim more than the node checks.
type ProcessState struct {
	Slug    string   `json:"slug"`
	Process string   `json:"process"`
	Image   string   `json:"image"`
	Command []string `json:"command,omitempty"`
	// Whether this process is ANSWERING, not merely present.
	//
	// Added because "the node is running your image" turned out not to mean the
	// app works, and the deploy was believing it. A container that starts and
	// exits is in `a.live` the whole time it is being restarted — reconcile puts
	// it back five times — so it reported its new image on every sync while
	// serving nothing, and a redeploy verified against that row and was
	// announced live. Measured on 5 Aug 2026: i341m v3 exited before binding,
	// the node logged `not running, restarting (3/5)`, and the deploy said
	// `✓ live`.
	//
	// A pointer so the field can be ABSENT. The control plane must be able to
	// tell "this agent does not report health" from "reported, and it is false"
	// — the same distinction Processes itself makes above, and for the same
	// reason: an older agent must not have its silence read as a failure.
	Healthy *bool `json:"healthy,omitempty"`
	// PullMs and BootMs are how long THIS node's most recent start of this
	// process took to pull its image and to boot the sandbox, in milliseconds
	// — see container.go's StartTiming, which splits the two because they have
	// different fixes (a leaner image and a faster registry fix one; fewer
	// local setup steps fix the other) and docs/research/fleet-deploy-time.md,
	// which named the combined, unsplit number the largest blind spot in the
	// whole deploy path.
	//
	// Unlike every other field on ProcessState, these are not present tense.
	// Slug, Process, Image, Command and Healthy restate the same fact about a
	// process for as long as it stays confirmed, and that repetition is
	// harmless — a fact that has not changed costs nothing to say again. A
	// duration is a fact about one EVENT, the start that just finished, and
	// resending it on every ten-second sync for a process's whole life would
	// either flood deploy_stages with the same "started in 4.2s" row forever
	// or push a "have I already sent this" bookkeeping problem onto every
	// reader instead of solving it once, here, at the source. reportRunning
	// (main.go) attaches these on exactly the first report after a start and
	// clears them before the next.
	//
	// Pointers so "nothing to report" is ABSENT from the wire rather than a
	// zero duration — a zero would read as an instant pull, a claim nothing
	// here has evidence for, and would be indistinguishable from a genuine
	// (if implausible) sub-millisecond one.
	PullMs *int64 `json:"pullMs,omitempty"`
	BootMs *int64 `json:"bootMs,omitempty"`
}

// syncBody is what the node POSTs: its identity, plus what it has to say about
// the processes it was given.
//
// Processes is a POINTER to a slice, and that is load-bearing on the wire:
//
//	nil            -> the field is absent    -> "this agent does not report"
//	&[]            -> the field is []        -> "I hold nothing failing"
//	&[...]         -> the field is a list    -> "these are failing"
//
// Absent and empty must stay different facts. An agent too old to know about
// this field sends neither, and the control plane must leave whatever it has
// stored alone — otherwise a rolling agent upgrade reads as a fleet-wide
// recovery. But a NEW agent with nothing failing must send `[]` and mean it,
// because that is the only thing that ever clears a stored fault: the agent
// keeps faults in memory, so every restart legitimately starts with none, and
// an agent that stayed silent about that would leave a repaired app marked as a
// node fault in Postgres forever, failing every later deploy as a platform
// problem. `omitempty` on a plain slice cannot express this — it drops nil and
// empty alike — which is why the pointer is here.
//
// Running is a pointer for the same reason and with the same three states, but
// the cost of confusing them runs the other way. A stale fault wrongly FAILS a
// deploy; a missing running-report also fails one, and a spurious one PASSES a
// deploy for an app that is not up. So absent stays "does not report" — the
// control plane leaves stored rows alone, and a worker-only deploy against an
// agent too old to send this finds no rows and rolls back, which is the safe
// direction — while `[]` means "I am running nothing confirmed" and clears them.
type syncBody struct {
	NodeIdentity
	Processes *[]ProcessFault `json:"processes,omitempty"`
	Running   *[]ProcessState `json:"running,omitempty"`
	// Version is which build of this agent is speaking.
	//
	// Absent from an older agent, which is why it is omitempty rather than a
	// required field: a rolling update must not make every not-yet-updated node
	// look broken. The control plane stores null for those and the admin page
	// shows them as unknown, which is the honest rendering of "this node has not
	// told us".
	Version string `json:"version,omitempty"`
}

func metadata(path string) (string, error) {
	req, _ := http.NewRequest("GET", "http://169.254.169.254/computeMetadata/v1/"+path, nil)
	req.Header.Set("Metadata-Flavor", "Google")
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(b)), err
}

// Identify reads this node's own facts from the metadata server.
func Identify() (NodeIdentity, error) {
	var id NodeIdentity
	name, err := metadata("instance/name")
	if err != nil {
		return id, fmt.Errorf("instance name: %w", err)
	}
	// The zone arrives as projects/<num>/zones/<zone>; only the last element is
	// meaningful and storing the rest would make every comparison a suffix match.
	zone, err := metadata("instance/zone")
	if err != nil {
		return id, fmt.Errorf("zone: %w", err)
	}
	if i := strings.LastIndex(zone, "/"); i >= 0 {
		zone = zone[i+1:]
	}
	ip, err := metadata("instance/network-interfaces/0/ip")
	if err != nil {
		return id, fmt.Errorf("internal ip: %w", err)
	}

	id = NodeIdentity{Name: name, Zone: zone, InternalIP: ip, CPUs: runtime.NumCPU()}
	id.MemoryBytes = totalMemoryBytes()
	return id, nil
}

// totalMemoryBytes reads MemTotal. Reported to the control plane for placement;
// zero is survivable (placement treats it as unknown) so this never fails hard.
func totalMemoryBytes() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		var kb int64
		if _, err := fmt.Sscanf(line, "MemTotal: %d kB", &kb); err == nil {
			return kb * 1024
		}
	}
	return 0
}

// Source fetches desired state, from the control plane when there is one.
type Source struct {
	Endpoint string // e.g. https://control-plane/api/fleet/sync
	Token    string
	Identity NodeIdentity
	Local    string // fallback file for a node with no control plane
	// Report answers "what is failing on this node right now", read fresh on
	// every sync — and reconcileOnce triggers more than one of those per pass
	// now, via ReportNow below, so this can be called more than once between
	// polls. A nil Report means this node does not report at all, which is a
	// different statement from reporting nothing — see syncBody.
	Report func() []ProcessFault
	// ReportRunning answers "what am I confirmed to be running right now", on
	// the same sync. Nil carries the same meaning as a nil Report and is the
	// state every agent built before this field was added is permanently in.
	ReportRunning func() []ProcessState
}

func (s *Source) Fetch() (Desired, error) {
	if s.Endpoint == "" {
		return s.fromFile(s.Local)
	}

	d, err := s.fromControlPlane()
	if err == nil {
		// Cache only a good answer. Writing the cache on failure would let one
		// bad response become the node's permanent idea of the world.
		if b, mErr := json.MarshalIndent(d, "", "  "); mErr == nil {
			tmp := cachePath + ".tmp"
			if os.WriteFile(tmp, b, 0o600) == nil {
				_ = os.Rename(tmp, cachePath)
			}
		}
		return d, nil
	}

	// The control plane is unreachable or unhappy. Keep serving what it last
	// said rather than treating silence as "run nothing", which would take every
	// app on the node down for the duration of a control-plane outage.
	log.Printf("desired: control plane unavailable (%v); using cache", err)
	if cached, cErr := s.fromFile(cachePath); cErr == nil {
		return cached, nil
	}
	return Desired{}, err
}

// ReportNow pushes a fresh sync immediately, carrying whatever Report and
// ReportRunning answer right now, without waiting for the next reconcile
// pass's poll to send it.
//
// It exists because Fetch's POST — the one that asks "what should I be
// running" — goes out at the TOP of reconcileOnce, before that same pass has
// placed or started anything. So the report riding on it is necessarily about
// the pass before this one, and a process this pass just confirmed does not
// reach the control plane until the NEXT pass's Fetch, a full poll interval
// later. The redeploy corroboration a deploy waits on reads exactly this
// report, so that interval became a wait the app was already past. Calling
// this again once reconcileOnce has done its own work lets the report catch
// up within the same pass instead.
//
// The desired state that comes back is discarded: the caller already has this
// pass's copy, and acting on a second one here would run the placement logic
// twice for one pass. A no-op on the lab path (no Endpoint) and errors are
// logged, not returned — this is an extra chance to speak sooner, and a node
// that could not take it is no worse off than one that never tried; the
// regular Fetch on the next pass is still the fallback that must not fail.
func (s *Source) ReportNow() {
	if s.Endpoint == "" {
		return
	}
	if _, err := s.fromControlPlane(); err != nil {
		log.Printf("report: control plane unavailable (%v)", err)
	}
}

func (s *Source) fromControlPlane() (Desired, error) {
	var d Desired
	payload := syncBody{NodeIdentity: s.Identity, Version: Version}
	if s.Report != nil {
		// Never a nil slice behind the pointer: json.Marshal writes `null` for
		// one, and `null` is not an array, so the control plane would read it as
		// "does not report" and never clear a stale fault.
		p := s.Report()
		if p == nil {
			p = []ProcessFault{}
		}
		payload.Processes = &p
	}
	if s.ReportRunning != nil {
		// Same nil-to-empty normalisation, for the same reason: `null` is not an
		// array, so a reader testing for one would take it as "does not report"
		// and never clear the rows of a node that has stopped running anything.
		r := s.ReportRunning()
		if r == nil {
			r = []ProcessState{}
		}
		payload.Running = &r
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return d, err
	}
	req, err := http.NewRequest("POST", s.Endpoint, bytes.NewReader(body))
	if err != nil {
		return d, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.Token)

	c := &http.Client{Timeout: 20 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return d, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != 200 {
		return d, fmt.Errorf("control plane %d: %s", resp.StatusCode,
			strings.TrimSpace(string(raw[:min(len(raw), 200)])))
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return d, fmt.Errorf("parse response: %w", err)
	}
	return d, nil
}

func (s *Source) fromFile(path string) (Desired, error) {
	var d Desired
	if path == "" {
		return d, fmt.Errorf("no desired-state file configured")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Desired{}, nil
		}
		return d, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, fmt.Errorf("parse %s: %w", path, err)
	}
	return d, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
