package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The spec declares a bind mount of the app's data directory, and a bind mount
// whose SOURCE does not exist kills the sandbox before it ever runs.
//
// This is the release-path blocker of 5 Aug, stated as a unit test. The
// directory was created in startBatch — the path long-running processes take —
// and `release` runs BEFORE any of them, so the first app on a node ever to
// declare a release bind-mounted a directory nothing had made yet. runsc does
// not say so: the gofer dies with `error setting up FS: opening
// /srv/apps/<slug>/data: no such file or directory` and the only thing that
// reaches the agent is `cannot create sandbox: cannot read client sync file:
// waiting for sandbox to start: EOF`, which names neither the mount nor the
// path. It looks like a sandbox that will not boot.
//
// Same defect shape, and the same fix, as the app-log directory in
// runscDetached: create it in the one function every kind goes through, not at
// the call sites that happen to have remembered.
func TestSpecCreatesTheDataDirItBindMounts(t *testing.T) {
	bundle := t.TempDir()
	// Two levels deep and absent, which is the real case: nothing has created
	// /srv/apps/<slug> either when a release is the first thing an app runs.
	dataDir := filepath.Join(t.TempDir(), "srv", "apps", "gzz9j", "data")

	app := App{
		Slug:        "gzz9j",
		Port:        8080,
		MemoryBytes: 1 << 31,
		CPUShares:   1024,
		DataDir:     dataDir,
	}
	proc := Process{Name: "release", Kind: KindRelease}
	net := &SandboxNet{Name: "ss-gzz9j--release.", Path: "/var/run/netns/ss-gzz9j--release."}

	if err := writeSpec(bundle, app, proc, net, nil,
		[]string{"/bin/sh", "-c", "node migrate.js"}, "/app", nil); err != nil {
		t.Fatalf("writeSpec: %v", err)
	}

	st, err := os.Stat(dataDir)
	if err != nil {
		t.Fatalf("the spec bind-mounts %s but nothing created it: %v", dataDir, err)
	}
	if !st.IsDir() {
		t.Fatalf("%s exists but is not a directory", dataDir)
	}

	// And it is actually the source of /data — a test that passed because the
	// mount had quietly been dropped would be worse than no test.
	var spec struct {
		Mounts []struct {
			Destination string `json:"destination"`
			Source      string `json:"source"`
		} `json:"mounts"`
	}
	b, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("parse config.json: %v", err)
	}
	found := false
	for _, m := range spec.Mounts {
		if m.Destination == "/data" {
			found = true
			if m.Source != dataDir {
				t.Fatalf("/data source is %q, want %q", m.Source, dataDir)
			}
		}
	}
	if !found {
		t.Fatal("spec declares no /data mount")
	}
}

// An app with no data directory must not gain one, and must not gain the mount
// either. Empty DataDir means "no persistent disk", and a MkdirAll on "" would
// turn that into a mount of the process's working directory.
func TestNoDataDirMeansNoMountAndNoDirectory(t *testing.T) {
	bundle := t.TempDir()
	app := App{Slug: "i6xce", Port: 8080, MemoryBytes: 1 << 31, CPUShares: 1024}
	proc := Process{Name: "web", Kind: KindWeb}
	net := &SandboxNet{Name: "ss-i6xce--web.", Path: "/var/run/netns/ss-i6xce--web."}

	if err := writeSpec(bundle, app, proc, net, nil, []string{"/app/server"}, "/app", nil); err != nil {
		t.Fatalf("writeSpec: %v", err)
	}

	var spec struct {
		Mounts []struct {
			Destination string `json:"destination"`
		} `json:"mounts"`
	}
	b, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("parse config.json: %v", err)
	}
	for _, m := range spec.Mounts {
		if m.Destination == "/data" {
			t.Fatal("an app with no DataDir was given a /data mount")
		}
	}
}
