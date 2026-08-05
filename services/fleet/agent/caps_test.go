package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	specs "github.com/opencontainers/runtime-spec/specs-go"
)

// The capability set is the difference between "runs images written for this
// platform" and "runs images". It was CAP_NET_BIND_SERVICE alone, and the first
// stock image ever placed here — nginx — died on its own entrypoint's chown
// before it bound anything. So both halves are pinned: what a startup script
// legitimately needs is present, and what would widen the sandbox is not.

func capsOf(t *testing.T) *specs.LinuxCapabilities {
	t.Helper()
	bundle := t.TempDir()
	app := App{Slug: "capt", Image: "img"}
	proc := Process{Name: "web", Kind: KindWeb}
	if err := writeSpec(bundle, app, proc, &SandboxNet{}, nil, []string{"/bin/true"}, "/", nil); err != nil {
		t.Fatalf("writeSpec: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	var s specs.Spec
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("parse config.json: %v", err)
	}
	if s.Process == nil || s.Process.Capabilities == nil {
		t.Fatal("spec carries no capabilities at all")
	}
	return s.Process.Capabilities
}

func TestSandboxCapsAllowAnOrdinaryEntrypoint(t *testing.T) {
	caps := capsOf(t)
	// CHOWN is the one nginx died without, and it is named on its own because a
	// regression here does not look like a capability bug from the outside — it
	// looks like the app crash looping for no stated reason.
	for _, want := range []string{
		"CAP_CHOWN",
		"CAP_DAC_OVERRIDE",
		"CAP_FOWNER",
		"CAP_FSETID",
		"CAP_KILL",
		"CAP_NET_BIND_SERVICE",
		"CAP_SETGID",
		"CAP_SETUID",
		"CAP_SETPCAP",
	} {
		if !has(caps.Effective, want) {
			t.Errorf("%s missing — an image that %s on startup cannot run here", want, verbFor(want))
		}
	}
}

func TestSandboxCapsWithholdReach(t *testing.T) {
	caps := capsOf(t)
	// Each of these is reach rather than housekeeping: nothing needs them to
	// start a server, and granting one to fix a single app would be the cheapest
	// possible way to widen every sandbox on the node.
	for _, never := range []string{
		"CAP_SYS_ADMIN",
		"CAP_SYS_PTRACE",
		"CAP_SYS_MODULE",
		"CAP_NET_ADMIN",
		"CAP_NET_RAW",
		"CAP_MKNOD",
		"CAP_SYS_CHROOT",
		"CAP_SETFCAP",
		"CAP_AUDIT_WRITE",
		"CAP_DAC_READ_SEARCH",
	} {
		if has(caps.Bounding, never) {
			t.Errorf("%s is granted — it is not needed to start a process and it widens every sandbox", never)
		}
	}
}

func TestSandboxCapsAreTheSameInEveryVector(t *testing.T) {
	caps := capsOf(t)
	// A capability in Permitted but not Effective is one the process must raise
	// for itself, and an entrypoint written for a normal runtime never thinks to.
	// Bounding below either of the others would silently cap what can be raised.
	if len(caps.Effective) != len(caps.Permitted) || len(caps.Effective) != len(caps.Bounding) {
		t.Fatalf("vectors disagree: bounding %d, permitted %d, effective %d",
			len(caps.Bounding), len(caps.Permitted), len(caps.Effective))
	}
	for _, c := range caps.Effective {
		if !has(caps.Permitted, c) || !has(caps.Bounding, c) {
			t.Errorf("%s is effective but not permitted+bounding", c)
		}
	}
}

func TestSandboxKeepsNoNewPrivileges(t *testing.T) {
	// The counterweight to granting anything at all: the set above lets a process
	// do these things AS ITSELF, and this is what stops it gaining more by
	// exec'ing a setuid binary. Loosening capabilities without this would be a
	// different change from the one that was reasoned about.
	bundle := t.TempDir()
	if err := writeSpec(bundle, App{Slug: "capt", Image: "img"}, Process{Name: "web", Kind: KindWeb},
		&SandboxNet{}, nil, []string{"/bin/true"}, "/", nil); err != nil {
		t.Fatalf("writeSpec: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(bundle, "config.json"))
	var s specs.Spec
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !s.Process.NoNewPrivileges {
		t.Error("NoNewPrivileges is off — the capability set above was reasoned about with it on")
	}
}

func has(list []string, want string) bool {
	for _, s := range list {
		if strings.EqualFold(s, want) {
			return true
		}
	}
	return false
}

// verbFor makes the failure read like the outage it predicts rather than a
// missing string constant.
func verbFor(cap string) string {
	switch cap {
	case "CAP_CHOWN", "CAP_FOWNER", "CAP_FSETID", "CAP_DAC_OVERRIDE":
		return "chowns or chmods its own files"
	case "CAP_SETUID", "CAP_SETGID", "CAP_SETPCAP":
		return "drops to an unprivileged user"
	case "CAP_KILL":
		return "signals its own children"
	default:
		return "binds a privileged port"
	}
}
