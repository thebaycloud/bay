package main

import (
	"testing"
	"time"
)

// agentWithDueCron is an agent holding one cron that is due every minute, and
// nothing else. rt is deliberately nil: if the gate below ever lets a firing
// through, RunToCompletion would be reached and the test would crash rather
// than quietly pass.
func agentWithDueCron(t *testing.T) (*Agent, string) {
	t.Helper()
	sch, err := ParseSchedule("* * * * *")
	if err != nil {
		t.Fatalf("schedule: %v", err)
	}
	app := App{Slug: "a8ebb", Image: "registry/a8ebb:1"}
	proc := Process{Name: "beat", Kind: KindCron, Schedule: "* * * * *"}

	a := &Agent{
		live:       map[string]*live{},
		slots:      map[int]string{},
		relRunning: map[string]bool{},
		blocked:    map[string]bool{},
		quiet:      newLogThrottle(),
		faults:     map[string]ProcessFault{},
		cron:       newCronRunner(),
		cronJobs:   []cronJob{{app: app, proc: proc, sch: sch, loc: time.UTC}},
	}
	return a, sandboxID(app.Slug, proc)
}

func TestACronDoesNotFireWhileItsReleaseIsInFlight(t *testing.T) {
	// The rollback defect 1A fixed, through a different door. A nightly export
	// firing into a database whose migration is halfway applied is worse than a
	// nightly export that does not run, and it is the same customer's data
	// either way.
	a, id := agentWithDueCron(t)
	a.relRunning["a8ebb"] = true

	a.fireDueCrons(time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC))

	a.cron.mu.Lock()
	defer a.cron.mu.Unlock()
	if a.cron.lastRun[id] != "" {
		t.Fatalf("the cron fired during its own release (lastRun=%q)", a.cron.lastRun[id])
	}
	// And the minute was not consumed: shouldFire records "(job, minute) has
	// fired", so checking the gate after it would burn the slot for a job that
	// never ran.
	if a.cron.running[id] {
		t.Fatal("the run slot was taken for a firing that was refused")
	}
}

func TestACronDoesNotFireWhenItsReleaseHasNotSucceeded(t *testing.T) {
	// Not only in-flight. A release that is backing off, or has given up, means
	// the app's own processes are not running either — a scheduled job is not
	// more entitled to the database than the app is.
	a, id := agentWithDueCron(t)
	a.blocked["a8ebb"] = true

	a.fireDueCrons(time.Date(2026, 8, 5, 3, 0, 0, 0, time.UTC))

	a.cron.mu.Lock()
	defer a.cron.mu.Unlock()
	if a.cron.lastRun[id] != "" {
		t.Fatal("the cron fired for an app whose release had not succeeded")
	}
}

func TestACronOfADifferentAppIsNotHeldBack(t *testing.T) {
	// The gate is per app. One app's release must not stop the whole node's
	// scheduled work — twenty apps share this tick.
	a, _ := agentWithDueCron(t)
	a.relRunning["some-other-app"] = true
	a.blocked["and-another"] = true

	if a.cronBlocked("a8ebb") {
		t.Fatal("an unrelated app's release blocked this app's cron")
	}
}

func TestAnAppWithNothingInFlightIsNotBlocked(t *testing.T) {
	a, _ := agentWithDueCron(t)
	if a.cronBlocked("a8ebb") {
		t.Fatal("a cron was blocked with no release in flight and nothing blocked")
	}
}
