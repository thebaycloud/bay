package main

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestTheFirstOccurrenceIsAlwaysSaid(t *testing.T) {
	// A state that has just begun is the one a human most wants to see, so the
	// throttle must never delay the announcement of a new one.
	l := newLogThrottle()
	if !l.allow("a8ebb@img", time.Now(), 10*time.Minute) {
		t.Fatal("the first occurrence of a key must be logged")
	}
}

func TestARepeatWithinTheIntervalIsSwallowed(t *testing.T) {
	l := newLogThrottle()
	now := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)
	l.allow("a8ebb@img", now, 10*time.Minute)

	// The reconcile loop runs every ten seconds; this is the next 59 passes.
	for i := 1; i <= 59; i++ {
		if l.allow("a8ebb@img", now.Add(time.Duration(i)*10*time.Second), 10*time.Minute) {
			t.Fatalf("pass %d (t+%ds) logged inside the interval", i, i*10)
		}
	}
	// …and the pass after ten minutes says it again, so the state does not
	// disappear for a human who started tailing a minute ago.
	if !l.allow("a8ebb@img", now.Add(10*time.Minute), 10*time.Minute) {
		t.Fatal("the interval elapsed and the state was not repeated")
	}
}

func TestANewImageIsAnnouncedImmediately(t *testing.T) {
	// This is why the key carries the image and why there is no forget(). A
	// deploy that fixes an app and then breaks it again five minutes later must
	// not be silent because an interval was already running: the second failure
	// is a different key.
	l := newLogThrottle()
	now := time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC)
	l.allow("a8ebb@old", now, 10*time.Minute)

	if !l.allow("a8ebb@new", now.Add(5*time.Second), 10*time.Minute) {
		t.Fatal("a new image must be announced at once, not swallowed by the previous image's interval")
	}
}

func TestKeysDoNotShadowEachOther(t *testing.T) {
	l := newLogThrottle()
	now := time.Now()
	l.allow("a8ebb@img", now, time.Hour)
	if !l.allow("anatf@img", now, time.Hour) {
		t.Fatal("one app's interval silenced another app")
	}
}

func TestTheMapDoesNotGrowForever(t *testing.T) {
	// Keys carry image digests, so a node that has been up for months across
	// many deploys would otherwise hold one entry per image ever seen.
	l := newLogThrottle()
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < pruneAbove+50; i++ {
		l.allow(fmt.Sprintf("slug@image-%d", i), old, time.Minute)
	}
	before := len(l.seen)

	l.allow("something-new", old.Add(48*time.Hour), time.Minute)

	if len(l.seen) >= before {
		t.Fatalf("nothing was pruned: %d entries before, %d after", before, len(l.seen))
	}
	if len(l.seen) != 1 {
		t.Fatalf("want only the fresh entry left, got %d", len(l.seen))
	}
}

func TestConcurrentThrottleUseIsSafe(t *testing.T) {
	// The cron tick, the reconcile loop and the start goroutines all reach this.
	l := newLogThrottle()
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			l.allow(fmt.Sprintf("key-%d", i%5), now, time.Minute)
		}(i)
	}
	wg.Wait()
}
