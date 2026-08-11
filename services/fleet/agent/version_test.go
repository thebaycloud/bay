package main

import "testing"

// The default matters: an unstamped build must be obviously unstamped rather
// than claiming a version it does not have.
func TestVersionDefaultsToDev(t *testing.T) {
	if Version != "dev" {
		t.Fatalf("unstamped build should report dev, got %q", Version)
	}
}

// The updater greps this line to decide whether a downloaded file is a working
// agent, so its shape is an interface and not a log message.
func TestVersionLineCarriesTheVersion(t *testing.T) {
	old := Version
	defer func() { Version = old }()

	Version = "abc1234"
	if got, want := versionLine(), "supersonicd abc1234"; got != want {
		t.Fatalf("versionLine() = %q, want %q", got, want)
	}
}
