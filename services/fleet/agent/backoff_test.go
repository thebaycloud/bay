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
