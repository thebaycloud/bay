package main

// The four process kinds.
//
// This is the section of docs/VM-FLEET.md that pays for the move. On Cloud Run
// these are three unrelated primitives with three disjoint flag sets: a service,
// a worker pool that accepts no --port and no probes, and a job that needs a
// Cloud Scheduler entry with an OAuth service account pointed at the Admin API's
// :run endpoint — plus a fourth path for `release`, and a documented inability
// to set terminationGracePeriodSeconds at all.
//
// Here there is one primitive — run this argv in a sandbox — and the kinds are
// scheduling policy on top of it:
//
//   web      long-lived, has a port, appears in the routing table
//   worker   long-lived, no port, never routed
//   cron     runs on a schedule, to completion
//   release  runs once to completion BEFORE web and worker start
//
// Three fields that parse today and reach nothing start working as a
// consequence, and none of them needed a feature: `shutdownGrace` is SIGTERM,
// wait, SIGKILL; `visibility: internal` is "do not publish a route"; and a
// Procfile `release:` line is the same mechanism as every other kind.

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

type ProcessKind string

const (
	KindWeb     ProcessKind = "web"
	KindWorker  ProcessKind = "worker"
	KindCron    ProcessKind = "cron"
	KindRelease ProcessKind = "release"
)

type Process struct {
	Name    string      `json:"name"`
	Kind    ProcessKind `json:"kind"`
	Command []string    `json:"command,omitempty"`

	// Image, when this process is not the app's own program.
	//
	// Every process of an app shared one image, which is right for `web` and
	// `worker` and `release` — they are the same code entered differently — and
	// wrong for everything an app needs BESIDE itself. A sibling service builds
	// its own image, and so does a dependency: "give it a Redis" is one more
	// process with `redis:7` on it, not a new subsystem.
	//
	// Empty means the app's image, so a spec written before this field behaves
	// exactly as it did.
	Image string `json:"image,omitempty"`

	// web only
	Port       int    `json:"port,omitempty"`
	HealthPath string `json:"healthPath,omitempty"`
	Visibility string `json:"visibility,omitempty"` // "public" (default) | "internal"

	// cron only
	Schedule string `json:"schedule,omitempty"` // 5-field cron
	Timezone string `json:"timezone,omitempty"`

	MemoryBytes int64  `json:"memoryBytes,omitempty"`
	CPUShares   uint64 `json:"cpuShares,omitempty"`

	// web and worker. Seconds between SIGTERM and SIGKILL.
	ShutdownGrace int `json:"shutdownGrace,omitempty"`
}

// sandboxID names one process's sandbox. Every kind is suffixed, including web,
// and the id ends in a dot. Both of those are load-bearing.
//
// **runsc resolves container ids by PREFIX.** Naming the web process `a8ebb`
// while its worker is `a8ebb--ticker` makes `runsc state a8ebb` fail with
//
//	id "a8ebb" is ambiguous and could refer to multiple containers
//
// and — much worse — `runsc delete --force a8ebb` fails the same way while
// exiting 0. The agent then believes the start failed, leaves a live sandbox
// behind, and every subsequent attempt collides with it forever. The app is up
// and unreachable, and the log says "container already exists" on a container
// nobody can address.
//
// So: no id may be a strict prefix of another. Suffixing web fixes the
// slug-vs-slug--name case; the trailing dot fixes the name-vs-longer-name case,
// because process names match [A-Za-z0-9_-]+ and so can never contain a dot —
// `a8ebb--web.` cannot be a prefix of `a8ebb--webhook.`. Across apps the `--`
// separator already does it: `a8--web.` is not a prefix of `a8ebb--web.`.
func sandboxID(slug string, p Process) string {
	return slug + "--" + p.Name + "."
}

// processesOf returns what an app declares, or the implicit single web process
// for an app that declares nothing.
//
// An app with no `processes` is NOT a worker-only app — its command is its web
// process under an older spelling, and it must take exactly the path it took
// yesterday. Only an app that SAID what it runs, and did not say `web`, is
// serviceless. That distinction is the difference between a feature and an
// outage, and the Cloud Run path learned it the hard way.
func processesOf(app App) []Process {
	if len(app.Processes) == 0 {
		return []Process{{
			Name:        "web",
			Kind:        KindWeb,
			Command:     app.Command,
			Port:        app.Port,
			HealthPath:  app.HealthPath,
			MemoryBytes: app.MemoryBytes,
			CPUShares:   app.CPUShares,
		}}
	}
	out := make([]Process, 0, len(app.Processes))
	for _, p := range app.Processes {
		if p.Kind == "" {
			// Derived, not authored — the same precedence the config schema
			// already uses: an explicit kind wins, then a schedule means cron,
			// then the reserved names, then everything else is a worker.
			switch {
			case p.Schedule != "":
				p.Kind = KindCron
			case p.Name == "web":
				p.Kind = KindWeb
			case p.Name == "release":
				p.Kind = KindRelease
			default:
				p.Kind = KindWorker
			}
		}
		if p.MemoryBytes == 0 {
			p.MemoryBytes = app.MemoryBytes
		}
		if p.CPUShares == 0 {
			p.CPUShares = app.CPUShares
		}
		if p.Kind == KindWeb {
			if p.Port == 0 {
				p.Port = app.Port
			}
			if p.HealthPath == "" {
				p.HealthPath = app.HealthPath
			}
		}
		out = append(out, p)
	}
	return out
}

// effectivePort is the port a process is told to listen on.
// imageFor is what this process actually runs.
//
// One function rather than `p.Image` at each site, because the sites are not
// only starts: adoption, the restart-on-change comparison, the release key and
// the failure counters all key on an image, and any of them reading a different
// answer would mean a process that is restarted forever or never.
func imageFor(app App, p Process) string {
	if p.Image != "" {
		return p.Image
	}
	return app.Image
}

func effectivePort(app App, p Process) int {
	if p.Port > 0 {
		return p.Port
	}
	if app.Port > 0 {
		return app.Port
	}
	return 8080
}

// processLogPath is where one process's stdout and stderr land.
func processLogPath(app App, p Process) string {
	base := app.LogPath
	if p.Kind == KindWeb || base == "" {
		return base
	}
	// <dir>/app.log -> <dir>/<name>.log
	if i := strings.LastIndex(base, "/"); i >= 0 {
		return base[:i+1] + p.Name + ".log"
	}
	return p.Name + ".log"
}

// hasWeb reports whether an app serves HTTP at all.
//
// A Telegram bot is a worker and nothing else: no port, no URL, no route, and
// nothing to health-check. Publishing a route for it would put it straight back
// to pretending to be a web server, which is the defect this model removes.
func hasWeb(procs []Process) bool {
	for _, p := range procs {
		if p.Kind == KindWeb {
			return true
		}
	}
	return false
}

// --- cron ------------------------------------------------------------------

// Schedule is the subset of cron the platform accepts: five fields, each a
// number, a comma list, a step, or `*`.
//
// Deliberately not a general cron parser. The scheduling this needs to express
// is "every N minutes" and "at 03:00", and a parser that silently accepts `@reboot`
// or a sixth seconds field would run a customer's job at a time nobody asked for.
type Schedule struct {
	min, hour, dom, mon, dow fieldMatch
}

type fieldMatch struct {
	any    bool
	values map[int]bool
	step   int
}

func parseField(s string, lo, hi int) (fieldMatch, error) {
	f := fieldMatch{values: map[int]bool{}}
	base := s
	if i := strings.Index(s, "/"); i >= 0 {
		step, err := atoi(s[i+1:])
		if err != nil || step <= 0 {
			return f, fmt.Errorf("bad step in %q", s)
		}
		f.step = step
		base = s[:i]
	}
	if base == "*" || base == "" {
		if f.step > 0 {
			for v := lo; v <= hi; v++ {
				if (v-lo)%f.step == 0 {
					f.values[v] = true
				}
			}
			return f, nil
		}
		f.any = true
		return f, nil
	}
	for _, part := range strings.Split(base, ",") {
		v, err := atoi(part)
		if err != nil || v < lo || v > hi {
			return f, fmt.Errorf("bad value %q (want %d-%d)", part, lo, hi)
		}
		f.values[v] = true
	}
	return f, nil
}

func (f fieldMatch) matches(v int) bool { return f.any || f.values[v] }

func atoi(s string) (int, error) {
	var n int
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("not a number")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

func ParseSchedule(s string) (*Schedule, error) {
	f := strings.Fields(s)
	if len(f) != 5 {
		return nil, fmt.Errorf("schedule %q: want 5 fields, got %d", s, len(f))
	}
	var sc Schedule
	var err error
	if sc.min, err = parseField(f[0], 0, 59); err != nil {
		return nil, fmt.Errorf("minute: %w", err)
	}
	if sc.hour, err = parseField(f[1], 0, 23); err != nil {
		return nil, fmt.Errorf("hour: %w", err)
	}
	if sc.dom, err = parseField(f[2], 1, 31); err != nil {
		return nil, fmt.Errorf("day of month: %w", err)
	}
	if sc.mon, err = parseField(f[3], 1, 12); err != nil {
		return nil, fmt.Errorf("month: %w", err)
	}
	if sc.dow, err = parseField(f[4], 0, 6); err != nil {
		return nil, fmt.Errorf("day of week: %w", err)
	}
	return &sc, nil
}

func (s *Schedule) Due(t time.Time) bool {
	return s.min.matches(t.Minute()) &&
		s.hour.matches(t.Hour()) &&
		s.dom.matches(t.Day()) &&
		s.mon.matches(int(t.Month())) &&
		s.dow.matches(int(t.Weekday()))
}

// cronRunner fires an app's scheduled processes.
//
// It ticks once a minute on the minute and never runs the same (process,
// minute) twice, so a tick that arrives late — or twice, which a timer under
// load will do — does not double-run a customer's job.
//
// A run that is still going when its next slot arrives is SKIPPED rather than
// overlapped. Overlapping a nightly export with itself is how one slow night
// becomes an outage.
type cronRunner struct {
	mu      sync.Mutex
	running map[string]bool
	lastRun map[string]string // id -> "2026-08-03T03:00" of the last fire
}

func newCronRunner() *cronRunner {
	return &cronRunner{running: map[string]bool{}, lastRun: map[string]string{}}
}

func (c *cronRunner) shouldFire(id string, t time.Time) bool {
	key := t.Format("2006-01-02T15:04")
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running[id] {
		log.Printf("cron %s: previous run still going, skipping %s", id, key)
		return false
	}
	if c.lastRun[id] == key {
		return false
	}
	c.lastRun[id] = key
	c.running[id] = true
	return true
}

func (c *cronRunner) done(id string) {
	c.mu.Lock()
	delete(c.running, id)
	c.mu.Unlock()
}

// location resolves a process's timezone.
//
// Without one, "0 3 * * *" is 03:00 UTC, which for a business in Almaty is 08:00
// — during the working day, against live traffic. Only honoured when the author
// said which zone they meant.
func location(tz string) *time.Location {
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		log.Printf("cron: unknown timezone %q, using UTC", tz)
		return time.UTC
	}
	return loc
}
