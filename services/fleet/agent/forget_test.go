package main

import (
	"testing"
	"time"
)

// nowForTest is a fixed instant: these assertions are about which keys exist,
// never about when.
func nowForTest() time.Time { return time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC) }

func agentForSweeps() *Agent {
	return &Agent{
		cronFail:  newFailTracker(),
		startFail: newFailTracker(),
		// Pre-set so syncCron does not launch its once-a-minute goroutine.
		cron:  newCronRunner(),
		live:  map[string]*live{},
		slots: map[int]string{},
	}
}

func TestACronRecordOutlivesNothing(t *testing.T) {
	// The ghost-record defect. A cron process is never in a.live — `units`
	// excludes KindCron because the scheduler owns them — so the removal loop
	// in reconcileOnce cannot see these, and an app removed after its cron had
	// failed left its record in /status forever, in the one view an operator
	// consults to rule things out.
	a := agentForSweeps()
	gone := App{Slug: "gone", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}
	stays := App{Slug: "stays", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}
	goneKey := sandboxID(gone.Slug, gone.Processes[0])
	staysKey := sandboxID(stays.Slug, stays.Processes[0])
	a.cronFail.fail(goneKey, nowForTest())
	a.cronFail.fail(staysKey, nowForTest())

	// The next desired state holds only one of them.
	a.syncCron(Desired{Apps: []App{stays}})

	rep := a.cronFail.report()
	if _, still := rep[goneKey]; still {
		t.Fatalf("%s was removed from the node and its cron record survived", goneKey)
	}
	if _, ok := rep[staysKey]; !ok {
		t.Fatalf("%s is still scheduled and its record was dropped", staysKey)
	}
}

func TestASlugThatContainsADoubleHyphenTakesNothingWithIt(t *testing.T) {
	// The sweep matches whole ids. The prefix it replaced, slug + "--", also
	// matches every key of an app whose slug BEGINS with this one plus "--".
	// Nothing produces such a slug today, and the reason is the point: slugify
	// collapses runs of hyphens and randomSlug emits five alphanumerics, both
	// in a TypeScript file in another service that this key scheme silently
	// depended on.
	a := agentForSweeps()
	foo := App{Slug: "foo", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}
	fooBar := App{Slug: "foo--bar", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}
	a.cronFail.fail(sandboxID(foo.Slug, foo.Processes[0]), nowForTest())
	a.cronFail.fail(sandboxID(fooBar.Slug, fooBar.Processes[0]), nowForTest())

	// `foo` leaves; `foo--bar` stays.
	a.syncCron(Desired{Apps: []App{fooBar}})

	if _, ok := a.cronFail.report()[sandboxID(fooBar.Slug, fooBar.Processes[0])]; !ok {
		t.Fatal("removing `foo` took `foo--bar`'s record with it")
	}
}

func TestAStartRecordDoesNotOutliveTheProcessItDescribes(t *testing.T) {
	// Newly load-bearing. Until the start path was bounded, a startFail record
	// only ever existed for a process that had been live, and the removal loop
	// saw all of them. A process that has NEVER come up now has one too — that
	// is the point of the bound — and the removal loop walks a.live, so it
	// cannot see exactly the records the bound creates.
	a := agentForSweeps()
	a.startFail.fail(startKey("gone--web.", "img@sha256:abc"), nowForTest())
	a.startFail.fail(startKey("stays--web.", "img@sha256:def"), nowForTest())

	a.forgetStaleStartRecords(map[string]bool{"stays--web.": true})

	rep := a.startFail.report()
	if len(rep) != 1 {
		t.Fatalf("want one record left, got %v", rep)
	}
	if _, ok := rep[startKey("stays--web.", "img@sha256:def")]; !ok {
		t.Fatalf("the surviving process's record was dropped: %v", rep)
	}
}

func TestEveryImageAProcessEverFailedOnIsForgottenWithIt(t *testing.T) {
	// The key carries the image, so one process that was redeployed twice while
	// broken has three records. Forgetting only the current one would leave two
	// ghosts behind — and a digest is full of "@", which is why the id is cut
	// at the FIRST one.
	a := agentForSweeps()
	for _, img := range []string{"img@sha256:a", "img@sha256:b", "img@sha256:c"} {
		a.startFail.fail(startKey("gone--web.", img), nowForTest())
	}

	a.forgetStaleStartRecords(map[string]bool{})

	if rep := a.startFail.report(); len(rep) != 0 {
		t.Fatalf("ghost records survived: %v", rep)
	}
}
