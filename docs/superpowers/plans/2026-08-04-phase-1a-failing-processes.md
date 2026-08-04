# Phase 1A: A failing process stops costing the node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A process that cannot start stops retrying forever, stops holding the
reconcile goroutine, and leaves a record of why it gave up.

**Architecture:** One pure, tested failure tracker — exponential backoff, an
attempt cap, and a key that resets when the image changes — used by the three
places that currently retry without limit: the release, a crash-looping worker,
and a failing cron. The release additionally moves off the reconcile goroutine so
one app's 30-minute timeout can no longer stop every other app on the node from
being reconciled.

**Tech Stack:** Go 1.25 (`services/fleet/agent`), stdlib only, `go test`.

## Why this phase exists, in one measured example

`fleet-lab-1` was rebooted for the first time on 2026-08-04. Nineteen of its
twenty apps came back. `a8ebb` did not: its release failed, `a.released[slug]` is
only set on success, and `reconcileOnce` therefore re-ran it **every 10 seconds,
27 times before a human noticed**, and would have continued indefinitely. Nothing
recorded that it had given up, because it never gave up.

That is the behaviour this plan removes. It does **not** fix why `a8ebb`'s
sandbox will not start — that app was already `failed` in the database before the
reboot, and it is a separate investigation.

## Global Constraints

- **Never squash commits.** One commit per change.
- **Never print secrets.** Not in logs, not in test output, not in a commit.
- **Every push to `main` deploys the control plane to production.** There is no staging.
- **Never put a pipe inside an `&&` chain that gates a decision** — the chain takes the pipe's exit status. Redirect to a file, echo `$?`, then read the file.
- **Go commands run from `services/fleet/agent`.** Build for the node with `GOOS=linux GOARCH=amd64 go build ./...`.
- **The agent is deployed by `scp`-ing `*.go` to `/opt/agent/` and building on the node.** It is NOT deployed by pushing to `main`. Do not use `/tmp/restart-agent.sh` — it deletes every sandbox, wipes `routes.json` and `/srv/state/bundles`, and starts the agent outside systemd. `sudo systemctl restart supersonicd` is enough: `KillMode=process` leaves the sandboxes running.
- **`pkill -f` inside a `gcloud compute ssh --command` kills the ssh command itself.** Match the exact comm with `-x`, or kill by PID.

## File structure

| File | Responsibility |
|---|---|
| `services/fleet/agent/backoff.go` | **new.** The failure tracker: when to try again, when to stop, when to forget. Pure — no runsc, no clock of its own, no logging. |
| `services/fleet/agent/backoff_test.go` | **new.** Its tests. Everything decision-shaped in this plan is tested here. |
| `services/fleet/agent/main.go` | wiring: the release path (~:436-464), the worker restart path (~:406-430), the cron path (~:172-206), the `Agent` struct (~:100-116), and `/status` (~:640-657). |

The tracker is a separate file on purpose. `main.go` is 711 lines and the parts
this plan touches are three unrelated call sites; putting the decision in one
tested place is what lets all three share it without any of them growing a copy.

---

### Task 1: The failure tracker

**Files:**
- Create: `services/fleet/agent/backoff.go`
- Create: `services/fleet/agent/backoff_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces, all used by Tasks 2-4:
  - `type failTracker struct` with `func newFailTracker() *failTracker`
  - `func (t *failTracker) decide(key string, now time.Time) failAction`
  - `func (t *failTracker) fail(key string, now time.Time) int` — returns the new consecutive-failure count
  - `func (t *failTracker) succeed(key string)`
  - `func (t *failTracker) report() map[string]FailState`
  - `type failAction int` with constants `actRun`, `actWait`, `actGiveUp`
  - `type FailState struct { Fails int; Since time.Time; LastError string }`
  - `const maxAttempts = 5`

Three properties this must have:

1. **The first attempt is never delayed.** A key with no record runs immediately.
2. **The cap is a stop, not a slowdown.** After `maxAttempts` consecutive
   failures the answer is `actGiveUp` forever, until something calls `succeed` or
   uses a different key. This is what ends the 10-second loop.
3. **A changed image is a different key.** Callers key on `slug@image`, so a new
   deploy resets the count without the tracker knowing what an image is.

- [ ] **Step 1: Write the failing tests**

Create `services/fleet/agent/backoff_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func TestFirstAttemptRunsImmediately(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	if got := tr.decide("a8ebb@sha256:aaa", now); got != actRun {
		t.Fatalf("first attempt got %v, want actRun — a fresh key must not wait", got)
	}
}

func TestBackoffGrowsAndBlocksUntilItElapses(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	tr.fail("k", now)

	if got := tr.decide("k", now.Add(1*time.Second)); got != actWait {
		t.Fatalf("1s after one failure got %v, want actWait", got)
	}
	if got := tr.decide("k", now.Add(30*time.Second)); got != actRun {
		t.Fatalf("30s after one failure got %v, want actRun", got)
	}

	// Second failure must wait longer than the first did.
	tr.fail("k", now.Add(30*time.Second))
	if got := tr.decide("k", now.Add(45*time.Second)); got != actWait {
		t.Fatalf("15s after the second failure got %v, want actWait — backoff did not grow", got)
	}
}

func TestGivesUpAfterTheCapAndStaysGivenUp(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	for i := 0; i < maxAttempts; i++ {
		tr.fail("k", now)
	}
	if got := tr.decide("k", now); got != actGiveUp {
		t.Fatalf("at the cap got %v, want actGiveUp", got)
	}
	// An hour later it is still given up. This is the property that ends the
	// every-10-seconds loop; a longer wait must not resurrect it.
	if got := tr.decide("k", now.Add(time.Hour)); got != actGiveUp {
		t.Fatalf("an hour past the cap got %v, want actGiveUp", got)
	}
}

func TestSuccessForgetsEverything(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	for i := 0; i < maxAttempts; i++ {
		tr.fail("k", now)
	}
	tr.succeed("k")
	if got := tr.decide("k", now); got != actRun {
		t.Fatalf("after success got %v, want actRun", got)
	}
	if _, ok := tr.report()["k"]; ok {
		t.Fatalf("a succeeded key must not appear in the report")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	for i := 0; i < maxAttempts; i++ {
		tr.fail("a8ebb@sha256:old", now)
	}
	// The same app on a new image is a different key: a deploy must get a fresh
	// start without the tracker knowing what an image is.
	if got := tr.decide("a8ebb@sha256:new", now); got != actRun {
		t.Fatalf("a new image got %v, want actRun", got)
	}
}

func TestFailCountsAndReports(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	if n := tr.fail("k", now); n != 1 {
		t.Fatalf("first fail returned %d, want 1", n)
	}
	if n := tr.fail("k", now); n != 2 {
		t.Fatalf("second fail returned %d, want 2", n)
	}
	r := tr.report()
	if r["k"].Fails != 2 {
		t.Fatalf("report Fails = %d, want 2", r["k"].Fails)
	}
	if !r["k"].Since.Equal(now) {
		t.Fatalf("report Since = %v, want the FIRST failure time %v", r["k"].Since, now)
	}
}

func TestReportIsACopy(t *testing.T) {
	tr := newFailTracker()
	tr.fail("k", time.Unix(1000, 0))
	r := tr.report()
	delete(r, "k")
	if len(tr.report()) != 1 {
		t.Fatalf("report handed out its own map — a caller deleted a live record")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/fleet/agent && go test -run 'TestFirst|TestBackoff|TestGives|TestSuccess|TestKeys|TestFail|TestReport' ./... > /tmp/bo1.txt 2>&1; echo "exit=$?"
cat /tmp/bo1.txt
```

Expected: a compile failure — `undefined: newFailTracker`. That is the correct first failure.

- [ ] **Step 3: Write the implementation**

Create `services/fleet/agent/backoff.go`:

```go
package main

import (
	"sync"
	"time"
)

// The failure tracker: how long to wait before retrying something that failed,
// and when to stop retrying it altogether.
//
// It exists because the agent had three retry loops with no limit between them.
// The one that bit: after fleet-lab-1's first reboot, an app whose release
// process could not start had that release re-run every 10 seconds — 27 times
// before a human noticed — because `released[slug]` is only set on success and
// nothing counted the failures.
//
// Deliberately knows nothing about apps, images or sandboxes. Callers build the
// key, and a key that includes the image is how a new deploy gets a clean start
// without this file having an opinion about what a deploy is.

const (
	// maxAttempts is a stop, not a slowdown. Past it the answer is actGiveUp
	// until something succeeds or the key changes.
	maxAttempts = 5

	baseDelay = 15 * time.Second
	maxDelay  = 10 * time.Minute
)

type failAction int

const (
	// actRun: no record, or the wait has elapsed.
	actRun failAction = iota
	// actWait: failed recently, still inside its backoff.
	actWait
	// actGiveUp: failed maxAttempts times in a row. Not retried again.
	actGiveUp
)

func (f failAction) String() string {
	switch f {
	case actRun:
		return "run"
	case actWait:
		return "wait"
	case actGiveUp:
		return "give-up"
	}
	return "unknown"
}

// FailState is what a caller may show a human. Exported because /status encodes it.
type FailState struct {
	Fails int       `json:"fails"`
	Since time.Time `json:"since"`
	// LastError is the most recent failure's message, for a human reading
	// /status. Empty until a caller supplies one via failWith.
	LastError string `json:"lastError,omitempty"`
}

type failRecord struct {
	fails int
	since time.Time
	next  time.Time
	last  string
}

type failTracker struct {
	mu sync.Mutex
	m  map[string]*failRecord
}

func newFailTracker() *failTracker {
	return &failTracker{m: map[string]*failRecord{}}
}

// decide says what to do about this key now.
func (t *failTracker) decide(key string, now time.Time) failAction {
	t.mu.Lock()
	defer t.mu.Unlock()
	r, ok := t.m[key]
	if !ok {
		return actRun
	}
	if r.fails >= maxAttempts {
		return actGiveUp
	}
	if now.Before(r.next) {
		return actWait
	}
	return actRun
}

// fail records one failure and returns the new consecutive count.
func (t *failTracker) fail(key string, now time.Time) int {
	return t.failWith(key, now, "")
}

// failWith is fail, carrying the error text for /status.
func (t *failTracker) failWith(key string, now time.Time, msg string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	r, ok := t.m[key]
	if !ok {
		r = &failRecord{since: now}
		t.m[key] = r
	}
	r.fails++
	if msg != "" {
		r.last = msg
	}
	// Exponential, capped. The first retry waits baseDelay, not zero: the
	// reconcile loop runs every 10s and an immediate retry is the loop this
	// whole file exists to stop.
	d := baseDelay << (r.fails - 1)
	if d > maxDelay || d <= 0 {
		d = maxDelay
	}
	r.next = now.Add(d)
	return r.fails
}

// succeed forgets the key entirely.
func (t *failTracker) succeed(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, key)
}

// report is a copy, so a caller iterating it cannot race the reconcile loop.
func (t *failTracker) report() map[string]FailState {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]FailState, len(t.m))
	for k, r := range t.m {
		out[k] = FailState{Fails: r.fails, Since: r.since, LastError: r.last}
	}
	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/fleet/agent && go test -count=1 ./... > /tmp/bo2.txt 2>&1; echo "exit=$?"
cat /tmp/bo2.txt
go vet ./... > /tmp/bo3.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/bo3.txt)"
cat /tmp/bo3.txt
```

Expected: `ok`, all seven new tests passing alongside the existing suite, vet silent.

- [ ] **Step 5: Commit**

```bash
git add services/fleet/agent/backoff.go services/fleet/agent/backoff_test.go
git commit -m "A tracker for work that keeps failing

Three retry loops in the agent had no limit between them. This is the one place
that decides when to wait and when to stop, so none of the three grows its own
copy. It knows nothing about apps or images: callers build the key, and putting
the image in it is how a new deploy gets a clean start."
```

---

### Task 2: The release stops looping, and stops holding the reconcile goroutine

**Files:**
- Modify: `services/fleet/agent/main.go` — the `Agent` struct (~:100-116) and the release block (~:432-464)

**Interfaces:**
- Consumes: `newFailTracker()`, `decide`, `failWith`, `succeed`, `actRun`/`actWait`/`actGiveUp`, `maxAttempts` from Task 1.
- Produces: `Agent.relFail *failTracker` and `Agent.relRunning map[string]bool`, both read by Task 4's `/status`.

Two separate defects live in this block, and the fix for one does not fix the other:

1. **It never stops.** `a.released[slug]` is set only on success, so a failing
   release is re-attempted every reconcile pass, forever.
2. **It blocks everything.** `RunToCompletion` is called synchronously with a
   30-minute timeout inside `reconcileOnce`, and `reconcileOnce` is the only
   thing that reconciles any app. One app's slow release stops the other
   nineteen from being reconciled at all.

The release must still block its OWN app from starting — a web process that
starts after a failed migration is how an app comes up against a half-migrated
database — so "in flight" and "given up" both count as blocked.

- [ ] **Step 1: Add the fields to the `Agent` struct**

In `services/fleet/agent/main.go`, in the `Agent` struct immediately after the
`released map[string]string` field and its comment (~:115), add:

```go
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
```

- [ ] **Step 2: Initialise them where the Agent is constructed**

There is exactly one construction site, `main.go:260-261`:

```go
	a := &Agent{rt: rt, src: src, live: map[string]*live{}, slots: map[int]string{},
		released: map[string]string{}}
```

Replace it with:

```go
	a := &Agent{rt: rt, src: src, live: map[string]*live{}, slots: map[int]string{},
		released:   map[string]string{},
		relFail:    newFailTracker(),
		relRunning: map[string]bool{},
		startFail:  newFailTracker(),
		cronFail:   newFailTracker()}
```

`startFail` and `cronFail` belong to Tasks 3 and 4 and their struct fields do not
exist yet — so add all four fields to the struct now, in Step 1, and initialise
all four here. Splitting one struct literal across three tasks would leave the
build broken between them for no benefit; the *behaviour* still lands one task at
a time, which is what the task boundaries are for.

A nil `*failTracker` would panic on first use rather than degrading, so there is
no lazy option here worth taking.

- [ ] **Step 3: Replace the release block**

Replace the whole block at `main.go` from the comment beginning `// Release runs
to completion BEFORE anything else starts` through the closing brace of the
`for slug, app := range needRelease` loop — currently lines ~432-464 — with:

```go
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
```

Note what changed beyond the backoff: the inner `for ... range processesOf(app)`
loop became a search for the single release process. The original ran the body
once per release process and reused `blocked[slug]`; a slug has at most one, and
a loop that starts a goroutine per iteration would double-book the slot if it
ever had two.

- [ ] **Step 4: Build, vet and test**

```bash
cd services/fleet/agent && go build ./... > /tmp/r1.txt 2>&1; echo "build exit=$?"; cat /tmp/r1.txt
go vet ./... > /tmp/r2.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/r2.txt)"; cat /tmp/r2.txt
go test -count=1 ./... > /tmp/r3.txt 2>&1; echo "test exit=$?"; tail -3 /tmp/r3.txt
GOOS=linux GOARCH=amd64 go build ./... > /tmp/r4.txt 2>&1; echo "linux exit=$? bytes=$(wc -c < /tmp/r4.txt)"
go test -race -count=1 ./... > /tmp/r5.txt 2>&1; echo "race exit=$?"; tail -3 /tmp/r5.txt
```

Expected: all exit 0. The race detector matters here specifically — this task
moves work onto a new goroutine that touches `a.released`, `a.slots` and
`a.relRunning`, all of which the reconcile loop also touches.

- [ ] **Step 5: Commit**

```bash
git add services/fleet/agent/main.go
git commit -m "A failed release stops after five tries, and stops blocking the node

Two defects, one block. It never stopped: released[slug] is set only on success,
so a failing release re-ran every reconcile pass — measured at 27 times in a row
after fleet-lab-1's first reboot, and it would not have stopped. And it ran
synchronously with a 30-minute timeout inside reconcileOnce, which is the only
thing that reconciles any app on the node, so one app's slow release stopped the
other nineteen from being reconciled at all.

Now it backs off, gives up after five, and runs on its own goroutine. Its own app
stays blocked while it is in flight or given up — a web process that starts after
a failed migration is the thing this ordering exists to prevent — and nothing
else waits. Keyed by slug@image, so deploying a new image resets the count."
```

---

### Task 3: A crash-looping worker backs off

**Files:**
- Modify: `services/fleet/agent/main.go` — the `Agent` struct and the restart branch (~:406-430)

**Interfaces:**
- Consumes: `newFailTracker()`, `decide`, `fail`, `succeed`, `actRun`/`actWait`/`actGiveUp`, `maxAttempts` from Task 1.
- Produces: `Agent.startFail *failTracker`, read by Task 4's `/status`.

A process that exits immediately is restarted on the next pass, ten seconds
later, forever, with nothing recorded. The restart itself is right — that is what
supervision is — but an unbounded one turns a broken image into a permanent
10-second cycle of sandbox creation and teardown on a node shared with nineteen
working apps.

Note the asymmetry to preserve: **a changed image or command must restart
immediately**, no backoff. That is a deploy, and a deploy is exactly the event
that should get a clean try.

- [ ] **Step 1: Confirm the field is already there**

`startFail *failTracker` was declared on the `Agent` struct and initialised in the
struct literal at `main.go:260` by Task 2, so that all four trackers are written
once. Confirm before writing any logic:

```bash
cd services/fleet/agent && grep -n "startFail" main.go
```

Expected: two lines — the struct field and the initialiser. If either is missing,
Task 2 was not completed; add them as Task 2 Steps 1 and 2 describe rather than
inventing a second construction site.

- [ ] **Step 2: Gate the not-running restart**

In `main.go`, in the `if running {` branch, replace this:

```go
			if l.app.Image == u.app.Image && sameStrings(l.proc.Command, u.proc.Command) {
				if st, err := runscStatus(id); err == nil && st.Status == "running" {
					continue
				}
				log.Printf("%s: not running, restarting", id)
			} else {
```

with:

```go
			if l.app.Image == u.app.Image && sameStrings(l.proc.Command, u.proc.Command) {
				if st, err := runscStatus(id); err == nil && st.Status == "running" {
					a.startFail.succeed(id + "@" + u.app.Image)
					continue
				}
				// It died. Restarting is right; restarting it every ten seconds
				// forever is not — that is a broken image turning into a
				// permanent cycle of sandbox creation on a node holding
				// nineteen working apps.
				key := id + "@" + u.app.Image
				switch a.startFail.decide(key, time.Now()) {
				case actWait:
					continue
				case actGiveUp:
					log.Printf("%s: has died %d times, not restarting — deploy a new image to reset",
						id, maxAttempts)
					continue
				}
				n := a.startFail.fail(key, time.Now())
				log.Printf("%s: not running, restarting (%d/%d)", id, n, maxAttempts)
			} else {
```

The `succeed` call on the healthy path is what makes the count *consecutive*: a
process that dies once, restarts and stays up must not carry that failure toward
the cap for the rest of the node's uptime.

The `else` branch — image or command changed — is untouched, so a deploy still
restarts immediately.

- [ ] **Step 3: Build, vet, test, race**

```bash
cd services/fleet/agent && go build ./... > /tmp/w1.txt 2>&1; echo "build exit=$?"; cat /tmp/w1.txt
go vet ./... > /tmp/w2.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/w2.txt)"
go test -race -count=1 ./... > /tmp/w3.txt 2>&1; echo "race exit=$?"; tail -3 /tmp/w3.txt
GOOS=linux GOARCH=amd64 go build ./... > /tmp/w4.txt 2>&1; echo "linux exit=$? bytes=$(wc -c < /tmp/w4.txt)"
```

Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add services/fleet/agent/main.go
git commit -m "A process that keeps dying stops being recreated every ten seconds

Restarting a dead process is supervision. Restarting it forever, ten seconds
apart, is a broken image turning into a permanent cycle of sandbox creation and
teardown on a node holding nineteen working apps, with nothing recorded anywhere.

Counted per sandbox id and image, cleared the moment the process is seen running
so the count is consecutive rather than cumulative. A changed image or command
still restarts immediately and with a clean count — that is a deploy, and a
deploy is exactly the event that deserves a fresh try."
```

---

### Task 4: A failing cron says so, and the node can be asked what has given up

**Files:**
- Modify: `services/fleet/agent/main.go` — `fireDueCrons` (~:172-206), the `Agent` struct, and the `/status` handler (~:640-657)

**Interfaces:**
- Consumes: `newFailTracker()`, `fail`, `succeed`, `report`, `FailState`, `maxAttempts` from Task 1; `Agent.relFail` from Task 2; `Agent.startFail` from Task 3.
- Produces: a `failures` object on the `/status` response.

Crons do not spin — they fire on a schedule — so this half is not about
stopping a loop. It is that a failing cron is one `log.Printf` on a node whose
logs do not leave it, so a cron that has failed every night for a week looks
exactly like a cron that has never run.

The `/status` addition is the same problem seen from the other side: the node
knows what has given up and nothing can ask it. This does not replace the status
channel of phase 1C — it is the shape that channel will read, available now over
loopback, and it is how a human on the node can answer "what is broken here" with
one command instead of grepping a log.

- [ ] **Step 1: Confirm the field is already there**

`cronFail *failTracker` was declared and initialised by Task 2 along with the
other three trackers. Confirm:

```bash
cd services/fleet/agent && grep -n "cronFail\|relFail\|startFail" main.go
```

Expected: six lines — three struct fields and three initialisers. If any are
missing, complete Task 2 first rather than adding a second construction site.

- [ ] **Step 2: Count the failures in `fireDueCrons`**

In `main.go`, inside the goroutine in `fireDueCrons`, replace:

```go
			log.Printf("%s: cron firing", id)
			if err := a.rt.RunToCompletion(j.app, j.proc, idx, 30*time.Minute); err != nil {
				log.Printf("%s: cron failed: %v", id, err)
			} else {
				log.Printf("%s: cron finished", id)
			}
```

with:

```go
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
```

Note that a cron is **not** gated by `decide`. A schedule is an instruction from
the app's author, and skipping a scheduled run because earlier ones failed would
silently change what the app asked for. Counting is the fix here; stopping is
not.

- [ ] **Step 3: Expose the three trackers on `/status`**

In the `/status` handler in `main.go`, the existing code builds `out` and encodes
it directly. Replace the final two lines of that handler —

```go
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
```

— with:

```go
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
```

Then add this helper to the bottom of `main.go`, in the `--- helpers ---` section
beside `sameStrings`:

```go
// mergeFailures flattens the three trackers into one map for /status.
//
// The keys are already distinguishable — a release key is slug@image, a start
// key is id@image, a cron key is a bare sandbox id — so a prefix would only add
// a second thing to keep in step with the callers.
func mergeFailures(ts ...*failTracker) map[string]FailState {
	out := map[string]FailState{}
	for _, t := range ts {
		if t == nil {
			continue
		}
		for k, v := range t.report() {
			out[k] = v
		}
	}
	return out
}
```

- [ ] **Step 4: Build, vet, test, race**

```bash
cd services/fleet/agent && go build ./... > /tmp/c1.txt 2>&1; echo "build exit=$?"; cat /tmp/c1.txt
go vet ./... > /tmp/c2.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/c2.txt)"
go test -race -count=1 ./... > /tmp/c3.txt 2>&1; echo "race exit=$?"; tail -3 /tmp/c3.txt
GOOS=linux GOARCH=amd64 go build ./... > /tmp/c4.txt 2>&1; echo "linux exit=$? bytes=$(wc -c < /tmp/c4.txt)"
```

Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add services/fleet/agent/main.go
git commit -m "A failing cron carries a count, and /status says what has given up

A cron that failed once is an incident. The same one failing every night for a
week is a broken job. On a node whose logs do not leave it those two produce
identical output, so the count is the fix. The cron is deliberately NOT gated by
the backoff: a schedule is an instruction from the app's author, and skipping
scheduled runs because earlier ones failed would silently change it.

/status now carries the three trackers alongside the process list, because a node
that has given up on something is otherwise invisible from outside: the process
is simply absent, which looks the same as never having been asked for. Loopback
only, as it was; phase 1C is what carries this to the control plane."
```

---

### Task 5: Prove it on the node

No repository changes. This is the verification that the three loops are gone,
and it is the only place the behaviour can actually be observed.

**Blocked on:** nothing. SSH to `fleet-lab-1` works.

- [ ] **Step 1: Record the current loop, so the after has a before**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'sudo grep -ac "release FAILED" /var/log/supersonicd.log; sudo grep -a "release FAILED" /var/log/supersonicd.log | tail -2'
```

Expected: a count in the dozens and two lines roughly ten seconds apart. `a8ebb`
is the app doing this. Write the count down.

- [ ] **Step 2: Ship and restart**

```bash
gcloud compute scp services/fleet/agent/*.go fleet-lab-1:/tmp/agent-src/ \
  --zone us-central1-a --project supersonic-deploy-prod
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod --command '
  sudo cp /tmp/agent-src/*.go /opt/agent/ && rm -rf /tmp/agent-src
  cd /opt/agent && sudo env PATH=$PATH:/usr/local/go/bin go build -o supersonicd . && echo BUILD-OK
  sudo systemctl restart supersonicd'
```

Do **not** use `/tmp/restart-agent.sh`. `systemctl restart` is enough and leaves
the sandboxes running.

- [ ] **Step 3: Watch the loop stop**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'sudo grep -a "release" /var/log/supersonicd.log | tail -8'
```

Expected, in order: attempts numbered `(1/5)` through `(5/5)` with the gaps
between them growing — 15s, 30s, 60s, 120s — and then the line
`release has failed 5 times, not retrying — deploy a new image to reset`.
No further `running release` lines after that.

**If the attempts are still ten seconds apart, the build did not take.** Check
`sudo strings /opt/agent/supersonicd | grep -c 'not retrying'` — zero means the
binary is stale, and the log lines you are reading predate the restart. That
exact confusion cost a debugging cycle on 2026-08-04.

- [ ] **Step 4: Ask the node what it has given up on**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'curl -s -m 5 http://127.0.0.1:9900/status | python3 -m json.tool | head -30'
```

Expected: a `failures` object keyed by `a8ebb@sha256:…` with `fails: 5` and the
`lastError` text. This is the first time the node can be asked what is broken
rather than having its log read.

- [ ] **Step 5: Confirm nothing else regressed**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'systemctl is-active supersonicd; sudo grep -o "\"slug\"" /srv/state/routes.json | wc -l; sudo tail -2 /var/log/supersonicd.log'
curl -s -m 10 -o /dev/null -w "health %{http_code}\n" http://8.232.255.172/__fleet/healthz
curl -s -m 10 -o /dev/null -D - -H "x-supersonic-slug: anatf" http://8.232.255.172/ | head -1
curl -s -m 15 -o /dev/null -w "anatf %{http_code}\n" https://anatf.supersonic.cv/
```

Expected: `active`; 19 or 20 routes; `health 200`; a `403` from the bypass, since
phase 0's gate is still on; and `anatf` serving through the real path.

- [ ] **Step 6: No commit**

Nothing changed in the repository. Record the observed backoff sequence in the
handoff.

---

## Self-Review

**Spec coverage.** The programme spec's phase 1 lists six items. This plan covers
two of them: "A failed release stalls the whole node" (Tasks 2 and 5) and the
cron half of "Crons change meaning silently" — specifically that a failure is
invisible (Task 4). The worker crash-loop named in the same spec paragraph is
Task 3.

**Deliberately NOT in this plan**, and each is named so it is not mistaken for an
oversight:

- **The cron dialect.** Ranges, names, `@daily`, DOW 7, `N/M` step-from-base and
  the DOM/DOW OR semantics are a parser rewrite with its own correctness
  argument, and a migrating cron that silently stops firing is a different defect
  from one that fails loudly. Its own plan.
- **Log shipping** — phase 1B. Task 4's `/status` addition is loopback-only and
  does not substitute for it.
- **The status channel to the control plane** — phase 1C. Task 4 builds the shape
  it will read, nothing more.
- **The four dropped spec fields** (`instances`, `taskTimeout`, `retries`,
  `health.expect`) and the `type Process struct` drift test. Both belong with
  1C, where the protocol is already being changed.
- **`taskTimeout`** in particular: the 30-minute timeout stays hardcoded here.
  Honouring the declared value is a spec-field change, and mixing it into a
  backoff plan would put two reasons in one commit.

**Placeholder scan.** None. Every step carries the code or the command.

**Type consistency.** `failTracker`, `failAction`, `actRun`/`actWait`/
`actGiveUp`, `FailState`, `maxAttempts`, `newFailTracker`, `decide`, `fail`,
`failWith`, `succeed`, `report` are defined in Task 1 and used with those exact
names in Tasks 2, 3 and 4. `mergeFailures` is defined and used in Task 4. The
field names `relFail`, `relRunning`, `startFail`, `cronFail` are introduced in
Tasks 2-4 and read together in Task 4 Step 3.

**One risk this plan does not remove.** The cap is five consecutive failures and
the only things that reset it are a success or a new image. An app whose release
fails for a transient reason — a database briefly unreachable — will be given up
on and stay given up until someone deploys. That is the intended trade against a
loop that never ends, but it means "deploy a new image to reset" has to be true
and discoverable, which is why it is in the log line rather than only here.
