package main

import (
	"strings"
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

	// maxDelay is a CLAMP, not the ceiling on retry spacing it reads like.
	//
	// It cannot bind as a backoff cap at these constants and it is worth saying
	// so, because a reader who takes it at face value expects a broken app to
	// be retried ten minutes apart. It is not: decide answers actGiveUp at
	// maxAttempts, so the last delay ever consulted is the one set by the
	// failure before the cap — 15s << 3 = 120s — and the whole allowance is
	// spent in under four minutes. The measured curve on the live node agrees:
	// five attempts at 21 / 31 / 61 / 123 seconds.
	//
	// What it does do is bound the shift for a tracker whose count is NOT
	// bounded by give-up. cronFail is one: nothing calls decide on it — a
	// nightly job should keep trying — so its count grows for as long as the
	// job keeps failing, and 15s << 60 is not a delay anybody meant. Go defines
	// an over-wide shift as zero rather than undefined, so that arrives here as
	// d <= 0; both doors lead to the same clamp.
	maxDelay = 10 * time.Minute
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
	// LastError is the most recent NON-EMPTY failure message, for a human
	// reading /status: failWith keeps the previous message when passed an
	// empty one, so this can show a stale message for a later failure.
	// Empty until a caller supplies one via failWith.
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
//
// decide and a later fail/succeed are separate critical sections, not one
// transaction. Callers are expected to be the only goroutine acting on a
// given key — releases are serialised by relRunning, the worker path does
// both on the reconcile goroutine, and crons use distinct keys. A caller
// that violates that can double-count one logical failure.
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

// forgetPrefix drops every record whose key starts with p.
//
// Callers key on slug@image or id@image, so a process or app that leaves
// desired state cannot be forgotten by exact key — the image is part of the key
// and the caller removing it does not know which images it ever failed on.
// Without this, /status accumulates ghost entries for things that no longer
// exist, which is precisely what it was added to help a human rule out.
func (t *failTracker) forgetPrefix(p string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	// Deleting from a map during range is safe per the Go spec — do not
	// "fix" this into a two-pass collect-then-delete.
	for k := range t.m {
		if strings.HasPrefix(k, p) {
			delete(t.m, k)
		}
	}
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
