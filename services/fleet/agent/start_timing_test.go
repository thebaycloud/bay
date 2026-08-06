package main

import (
	"testing"
	"time"
)

// Pull and boot timing rides the SAME wire channel ReportRunning already
// uses — see desired.go's ProcessState.PullMs/BootMs — rather than a new sync
// field, because that channel is already async, already fires within the
// pass a process is placed in (main.go's ReportNow, added by a45497e), and
// adding a field to it costs nothing on the node's start path: recordStart is
// an in-memory append, never a network call.
//
// The two tests below are the contract that makes reusing ProcessState safe:
// unlike Slug/Process/Image, which restate the SAME fact on every sync for as
// long as a process stays confirmed, a duration is a fact about one EVENT —
// the start that just finished — and must appear on exactly one report, or a
// process alive for a day would write the same "started in 4.2s" row into
// deploy_stages every ten seconds for its whole life.

// TestReportRunningAttachesTimingOnce is the positive half: a report made
// right after recordStart carries the duration, and the very next report
// does not repeat it.
func TestReportRunningAttachesTimingOnce(t *testing.T) {
	a := agentForRunningTests()
	app := App{Slug: "demo", Image: "img"}
	proc := Process{Name: "web", Kind: KindWeb}
	id := sandboxID(app.Slug, proc)
	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now()}

	a.recordStart(id, StartTiming{Pull: 2500 * time.Millisecond, Boot: 900 * time.Millisecond})

	first := a.reportRunning()
	if len(first) != 1 {
		t.Fatalf("want one row, got %+v", first)
	}
	if first[0].PullMs == nil || *first[0].PullMs != 2500 {
		t.Fatalf("pullMs = %v, want 2500", first[0].PullMs)
	}
	if first[0].BootMs == nil || *first[0].BootMs != 900 {
		t.Fatalf("bootMs = %v, want 900", first[0].BootMs)
	}

	second := a.reportRunning()
	if len(second) != 1 {
		t.Fatalf("want one row, got %+v", second)
	}
	if second[0].PullMs != nil || second[0].BootMs != nil {
		t.Fatalf("a second report repeated timing already sent: %+v", second[0])
	}
}

// TestUntimedProcessesReportNoTiming is the ordinary case — a process
// re-confirmed on some later pass, which never had recordStart called for
// it (nothing new was started) — and it must report ABSENT timing, not a
// zero duration. A zero would read as an instant pull, which is a claim
// nothing here has evidence for.
func TestUntimedProcessesReportNoTiming(t *testing.T) {
	a := agentForRunningTests()
	app := App{Slug: "demo", Image: "img"}
	proc := Process{Name: "web", Kind: KindWeb}
	id := sandboxID(app.Slug, proc)
	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now()}

	got := a.reportRunning()
	if len(got) != 1 {
		t.Fatalf("want one row, got %+v", got)
	}
	if got[0].PullMs != nil || got[0].BootMs != nil {
		t.Fatalf("a process nobody just started reported timing: %+v", got[0])
	}
}

// TestRecordStartIsForgottenWhenAProcessIsRemoved guards the other failure
// mode: an app undeployed between its start and the next report must not
// leave a `pendingTiming` entry that leaks forever, or — worse — attaches
// stale timing to a different process that is later given the same sandbox
// id (an id is deterministic from slug+process, so a redeploy after a
// delete can reuse one).
func TestRecordStartIsForgottenWhenAProcessIsRemoved(t *testing.T) {
	a := agentForRunningTests()
	app := App{Slug: "demo", Image: "img"}
	proc := Process{Name: "web", Kind: KindWeb}
	id := sandboxID(app.Slug, proc)
	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now()}
	a.recordStart(id, StartTiming{Pull: time.Second, Boot: time.Second})

	a.forgetPendingTiming(id)

	a.live[id] = &live{app: app, proc: proc, confirmed: time.Now()}
	got := a.reportRunning()
	if len(got) != 1 {
		t.Fatalf("want one row, got %+v", got)
	}
	if got[0].PullMs != nil || got[0].BootMs != nil {
		t.Fatalf("timing survived forgetPendingTiming: %+v", got[0])
	}
}
