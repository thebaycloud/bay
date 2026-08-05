package main

import (
	"errors"
	"testing"
	"time"
)

// gzz9j's real error, from the node on 5 Aug — the shape a release start fails
// with when the sandbox dies before signalling ready.
var releaseStartErr = errors.New(
	"cannot create sandbox: cannot read client sync file: waiting for sandbox to start: EOF")

// swapLifecycle points RunToCompletion at fakes and returns the ids Stop was
// called with.
func swapLifecycle(t *testing.T, start func(*Runtime, App, Process, int) (*SandboxNet, error)) *[]string {
	t.Helper()
	prevStart, prevStop := startFn, stopFn
	t.Cleanup(func() { startFn, stopFn = prevStart, prevStop })

	stopped := &[]string{}
	startFn = start
	stopFn = func(_ *Runtime, id string) { *stopped = append(*stopped, id) }
	return stopped
}

// A start that FAILS still has to be cleaned up.
//
// `Start` gets as far as creating the bundle, mounting the rootfs and taking the
// snapshot lease before anything can go wrong in the sandbox itself, and on its
// way out it tears down only the network namespace. So everything else is the
// caller's to release — and the caller deferred `Stop` after the error check,
// which is the one path where it never runs.
//
// It is not a slow leak. A release is retried five times, so one bad deploy
// leaves five mounted overlays and five leases pinning snapshots that nothing
// will use again. On 5 Aug the node was carrying two of them, from 06:25 and
// 10:06, hours after the agent had given up.
func TestAFailedStartIsStillCleanedUp(t *testing.T) {
	stopped := swapLifecycle(t, func(*Runtime, App, Process, int) (*SandboxNet, error) {
		return nil, releaseStartErr
	})

	var r *Runtime // the fakes never touch the receiver
	err := r.RunToCompletion(
		App{Slug: "gzz9j"}, Process{Name: "release", Kind: KindRelease}, 0, time.Minute)

	if !errors.Is(err, releaseStartErr) {
		t.Fatalf("want the start error back, got %v", err)
	}
	if len(*stopped) != 1 {
		t.Fatalf("a failed start left its bundle, mount and lease behind: Stop called %d times, want 1",
			len(*stopped))
	}
	if (*stopped)[0] != "gzz9j--release." {
		t.Fatalf("stopped %q, want %q", (*stopped)[0], "gzz9j--release.")
	}
}

// And the successful path must still clean up exactly once — a fix that moved
// the defer somewhere it stopped covering success would trade one leak for a
// worse one, since that sandbox really exists.
//
// The status poll finds no such container and returns an error, which
// RunToCompletion reads as "finished and reaped" — its documented success-by-
// absence path, and the one a fast migration takes for real.
func TestASuccessfulRunIsCleanedUpExactlyOnce(t *testing.T) {
	stopped := swapLifecycle(t, func(*Runtime, App, Process, int) (*SandboxNet, error) {
		return &SandboxNet{Name: "ss-gzz9j--release."}, nil
	})

	var r *Runtime
	if err := r.RunToCompletion(
		App{Slug: "gzz9j"}, Process{Name: "release", Kind: KindRelease}, 0, time.Minute); err != nil {
		t.Fatalf("RunToCompletion: %v", err)
	}
	if len(*stopped) != 1 {
		t.Fatalf("Stop called %d times, want exactly 1", len(*stopped))
	}
}
