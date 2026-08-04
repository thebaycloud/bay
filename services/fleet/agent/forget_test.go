package main

import (
	"testing"
	"time"
)

func TestCronRecordsAreForgottenByIdentityNotByPrefix(t *testing.T) {
	// The prefix `slug + "--"` also matches every key of an app whose slug
	// begins with this one plus "--". Nothing produces such a slug today —
	// slugify collapses runs of hyphens and randomSlug emits five
	// alphanumerics — but that rule lives in a TypeScript file in another
	// service, and this key scheme silently depended on it.
	a := &Agent{cronFail: newFailTracker()}

	victim := App{Slug: "foo", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}
	bystander := App{Slug: "foo--bar", Processes: []Process{{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}}}

	victimKey := sandboxID(victim.Slug, victim.Processes[0])
	bystanderKey := sandboxID(bystander.Slug, bystander.Processes[0])
	a.cronFail.fail(victimKey, nowForTest())
	a.cronFail.fail(bystanderKey, nowForTest())

	a.forgetCronRecords(victim)

	rep := a.cronFail.report()
	if _, still := rep[victimKey]; still {
		t.Fatalf("%s was not forgotten", victimKey)
	}
	if _, gone := rep[bystanderKey]; !gone {
		t.Fatalf("forgetting %q took %q with it — the prefix was ambiguous", victim.Slug, bystander.Slug)
	}
}

func TestForgettingAnAppWithNoCronIsHarmless(t *testing.T) {
	// processesOf gives an app that declares nothing one implicit WEB process,
	// so this must not reach for a cron id that was never created.
	a := &Agent{cronFail: newFailTracker()}
	a.cronFail.fail("someone-else--beat.", nowForTest())

	a.forgetCronRecords(App{Slug: "plain"})

	if len(a.cronFail.report()) != 1 {
		t.Fatal("forgetting an app with no cron disturbed another app's record")
	}
}

func TestEveryCronOfAnAppIsForgotten(t *testing.T) {
	// An app can declare several. Forgetting one of them and leaving the rest
	// is the ghost-record defect this exists to prevent, just smaller.
	a := &Agent{cronFail: newFailTracker()}
	app := App{Slug: "many", Processes: []Process{
		{Name: "beat", Kind: KindCron, Schedule: "* * * * *"},
		{Name: "digest", Kind: KindCron, Schedule: "0 3 * * *"},
		{Name: "web", Kind: KindWeb},
	}}
	for _, p := range app.Processes {
		a.cronFail.fail(sandboxID(app.Slug, p), nowForTest())
	}

	a.forgetCronRecords(app)

	rep := a.cronFail.report()
	if len(rep) != 1 {
		t.Fatalf("want only the web record left (this tracker is for crons), got %v", rep)
	}
	if _, ok := rep[sandboxID(app.Slug, app.Processes[2])]; !ok {
		t.Fatal("the web process's record was removed by the cron cleanup")
	}
}

// nowForTest is a fixed instant: these assertions are about which keys exist,
// never about when.
func nowForTest() time.Time { return time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC) }
