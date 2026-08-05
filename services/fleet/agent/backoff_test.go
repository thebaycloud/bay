package main

import (
	"fmt"
	"sync"
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
	t0 := time.Unix(1000, 0)

	// One failure: the delay is 15s, so 16s later it may run again.
	tr.fail("k", t0)
	if got := tr.decide("k", t0.Add(16*time.Second)); got != actRun {
		t.Fatalf("16s after ONE failure got %v, want actRun — the first delay should be under 16s", got)
	}

	// Two failures: the delay is 30s, so the SAME 16s offset must still be waiting.
	// This is the pair that rules out a constant: no fixed delay can be both
	// under and over 16 seconds.
	t1 := t0.Add(16 * time.Second)
	tr.fail("k", t1)
	if got := tr.decide("k", t1.Add(16*time.Second)); got != actWait {
		t.Fatalf("16s after TWO failures got %v, want actWait — the delay did not grow", got)
	}
}

func TestConcurrentUseIsSafe(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("app-%d@sha256:x", i%5)
			tr.fail(key, now)
			tr.decide(key, now)
			tr.report()
			if i%7 == 0 {
				tr.succeed(key)
			}
		}(i)
	}
	wg.Wait()
	// Coherence, not an exact count: every surviving record must have a
	// positive count and a non-zero start time.
	for k, v := range tr.report() {
		if v.Fails <= 0 || v.Since.IsZero() {
			t.Fatalf("incoherent record for %q after concurrent use: %+v", k, v)
		}
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

func TestForgetPrefixRemovesMatchingKeysOnly(t *testing.T) {
	tr := newFailTracker()
	now := time.Unix(1000, 0)
	tr.fail("a8ebb@sha256:old", now)
	tr.fail("a8ebb@sha256:new", now)
	tr.fail("other@sha256:old", now)

	tr.forgetPrefix("a8ebb@")

	r := tr.report()
	if _, ok := r["a8ebb@sha256:old"]; ok {
		t.Fatalf("forgetPrefix left a8ebb@sha256:old — matching key was not removed")
	}
	if _, ok := r["a8ebb@sha256:new"]; ok {
		t.Fatalf("forgetPrefix left a8ebb@sha256:new — matching key was not removed")
	}
	if _, ok := r["other@sha256:old"]; !ok {
		t.Fatalf("forgetPrefix removed other@sha256:old — a non-matching key must survive")
	}
}

func TestMergeFailuresUnionsDistinctKeys(t *testing.T) {
	rel := newFailTracker()
	start := newFailTracker()
	cron := newFailTracker()
	now := time.Unix(1000, 0)

	rel.fail("app1@sha256:aaa", now)
	start.fail("id1@sha256:bbb", now)
	cron.fail("id2", now)

	out := mergeFailures(rel, start, cron)
	if len(out) != 3 {
		t.Fatalf("mergeFailures returned %d entries, want 3 (one per tracker): %+v", len(out), out)
	}
	for _, k := range []string{"app1@sha256:aaa", "id1@sha256:bbb", "id2"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("mergeFailures missing key %q from the union", k)
		}
	}
}

func TestTheCapIsReachedLongBeforeTheDelayCeilingIs(t *testing.T) {
	// maxDelay reads like the ceiling on retry spacing. It is not one, and this
	// pins the arithmetic that makes it unreachable so that raising
	// maxAttempts — which WOULD make it reachable — fails here first and gets
	// read rather than discovered on a node.
	tr := newFailTracker()
	t0 := time.Unix(1000, 0)

	var last time.Duration
	for n := 1; n < maxAttempts; n++ {
		tr.fail("k", t0)
		got := tr.m["k"].next.Sub(t0)
		want := baseDelay << (n - 1)
		if got != want {
			t.Fatalf("after %d failures the delay is %s, want %s", n, got, want)
		}
		last = got
	}
	if last >= maxDelay {
		t.Fatalf("the last reachable delay is %s, which reaches maxDelay (%s) — the comment above maxDelay is now wrong", last, maxDelay)
	}
	if last != 2*time.Minute {
		t.Fatalf("the last reachable delay is %s, want 2m — the measured curve on the node was 21/31/61/123s", last)
	}

	// And the attempt that would have had a longer delay never gets one,
	// because it is refused outright.
	tr.fail("k", t0)
	if got := tr.decide("k", t0.Add(24*time.Hour)); got != actGiveUp {
		t.Fatalf("a day later got %v, want %v", got, actGiveUp)
	}
}

func TestAnUnboundedCounterIsClampedRatherThanOverflowing(t *testing.T) {
	// cronFail is never asked to decide — a nightly job should keep trying — so
	// its count rises for as long as the job keeps failing. 15s << 60 is not a
	// delay anybody meant, and Go defines an over-wide shift as zero, so both
	// the huge and the zero case have to land somewhere sane.
	tr := newFailTracker()
	t0 := time.Unix(1000, 0)
	for i := 0; i < 400; i++ {
		tr.fail("nightly", t0)
	}
	if d := tr.m["nightly"].next.Sub(t0); d != maxDelay {
		t.Fatalf("after 400 failures the delay is %s, want it clamped to %s", d, maxDelay)
	}
}
