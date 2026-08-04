package main

import (
	"errors"
	"testing"
	"time"
)

// agentForStartTests is the state mayStart and recordStartFailure touch, and
// nothing else — no containerd, no network, no node.
func agentForStartTests() *Agent {
	return &Agent{
		startFail: newFailTracker(),
		quiet:     newLogThrottle(),
		faults:    map[string]ProcessFault{},
	}
}

// a8ebb's real error, from the node on 4 Aug. Unclassified on purpose: this is
// the failure that was retried every ten seconds and it is not one the
// classifier recognises, so the bound must not depend on knowing what went
// wrong.
var startErr = errors.New("cannot read client sync file: waiting for sandbox to start: EOF")

// drive runs `passes` reconcile passes ten seconds apart and returns how many
// starts were actually attempted.
func drive(a *Agent, id, image string, from time.Time, passes int) int {
	attempts := 0
	for i := 0; i < passes; i++ {
		at := from.Add(time.Duration(i) * 10 * time.Second)
		if a.mayStart(id, image, at) {
			attempts++
			a.recordStartFailure(id, App{Slug: "a8ebb", Image: image}, Process{Name: "web"}, startErr, at)
		}
	}
	return attempts
}

func TestAProcessThatCannotStartIsNotRetriedForever(t *testing.T) {
	// The defect, stated as a number. `a.live` gains an entry only on success,
	// so a process whose start fails is never `running` and never reached the
	// restart counter: it was attempted on every pass, which over twenty minutes
	// is 120 sandbox creations for one broken app on a node holding nineteen
	// working ones. It would never have stopped.
	a := agentForStartTests()
	got := drive(a, "a8ebb--web.", "registry/a8ebb:broken", time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC), 120)

	if got != maxAttempts {
		t.Fatalf("got %d attempts in twenty minutes, want %d — before this gate it was 120", got, maxAttempts)
	}
}

func TestTheFirstStartIsNeverDelayed(t *testing.T) {
	// A brand-new process must not pay for a record it does not have. This is
	// the property that makes the gate safe to put in front of every start on
	// the node, including the twenty that come back after a reboot.
	a := agentForStartTests()
	if !a.mayStart("anatf--web.", "registry/anatf:good", time.Now()) {
		t.Fatal("a process with no failure history was made to wait")
	}
}

func TestTheAttemptsFollowTheMeasuredBackoff(t *testing.T) {
	// Not "it backs off" — the schedule itself, in seconds from the first
	// attempt. A test that only asserts growth is satisfied by any constant
	// delay, which is one of the four tests phase 1C-1 caught proving nothing;
	// these numbers are the only thing that rules that out.
	//
	// Phase 1A measured the same curve on the RELEASE path on the live node —
	// five attempts at gaps of 21 / 31 / 61 / 123 seconds. The gaps here are
	// 20 / 30 / 60 / 120 because the reconcile loop only wakes every ten
	// seconds, so each attempt lands on the first pass at or after its
	// deadline. Same curve, same file, now on the start path too.
	a := agentForStartTests()
	start := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)

	var at []int
	for i := 0; i < 60; i++ { // ten minutes of passes
		now := start.Add(time.Duration(i) * 10 * time.Second)
		if a.mayStart("a8ebb--web.", "img", now) {
			at = append(at, i*10)
			a.recordStartFailure("a8ebb--web.", App{Slug: "a8ebb", Image: "img"}, Process{Name: "web"}, startErr, now)
		}
	}

	want := []int{0, 20, 50, 110, 230}
	if len(at) != len(want) {
		t.Fatalf("attempted at %v seconds, want %v", at, want)
	}
	for i := range want {
		if at[i] != want[i] {
			t.Fatalf("attempted at %v seconds, want %v", at, want)
		}
	}
}

func TestANewImageClearsTheGiveUp(t *testing.T) {
	// The documented escape, and the only one: "deploy a new image to reset".
	// The image is in the key, so this needs no code anywhere to notice that a
	// deploy happened.
	a := agentForStartTests()
	start := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)
	drive(a, "a8ebb--web.", "registry/a8ebb:broken", start, 120)

	if a.mayStart("a8ebb--web.", "registry/a8ebb:broken", start.Add(time.Hour)) {
		t.Fatal("the broken image was retried an hour later; give-up is meant to be permanent for that image")
	}
	if !a.mayStart("a8ebb--web.", "registry/a8ebb:fixed", start.Add(time.Hour)) {
		t.Fatal("a new image did not reset the give-up — the only documented escape does not work")
	}
}

func TestAGivenUpProcessStillTellsTheControlPlaneItIsFailing(t *testing.T) {
	// The bound stops the RETRYING, not the REPORTING. A process nobody is
	// trying any more is still a process that is down, and going quiet about it
	// is exactly how a node fault turns back into the app's fault — which is
	// the thing phase 1C-1 exists to prevent.
	a := agentForStartTests()
	start := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)
	drive(a, "a8ebb--web.", "img", start, 120)

	if a.mayStart("a8ebb--web.", "img", start.Add(time.Hour)) {
		t.Fatal("expected the start to have been given up")
	}
	rep := a.reportFaults()
	if len(rep) != 1 || rep[0].Slug != "a8ebb" || rep[0].Process != "web" {
		t.Fatalf("a given-up process stopped being reported: %+v", rep)
	}
	if rep[0].Fault != FaultUnknown {
		t.Fatalf("got %q, want %q — this error is not one the classifier knows", rep[0].Fault, FaultUnknown)
	}
	if rep[0].Detail != "" {
		t.Fatalf("an unclassified detail must stay on the node, got %q", rep[0].Detail)
	}
}

func TestTheGiveUpIsAnnouncedButDoesNotFloodTheLog(t *testing.T) {
	// Measured on the node: the previous form wrote 9 lines in 82 seconds and
	// ~1 MB/day, forever, into an append-only file on local SSD that does not
	// survive a stop.
	a := agentForStartTests()
	start := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)
	drive(a, "a8ebb--web.", "img", start, 30)

	said := 0
	for i := 0; i < 360; i++ { // one hour of ten-second passes
		at := start.Add(5*time.Minute + time.Duration(i)*10*time.Second)
		if a.quiet.allow("start:"+startKey("a8ebb--web.", "img"), at, giveUpEvery) {
			said++
		}
	}
	if said < 1 {
		t.Fatal("the give-up went completely silent — a human tailing the log would never learn of it")
	}
	if said > 7 {
		t.Fatalf("said %d times in an hour; the throttle is not holding", said)
	}
}
