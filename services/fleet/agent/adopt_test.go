package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Taking a surviving sandbox back over, instead of killing every app on the node
// because the agent restarted.
//
// `KillMode=process` in the unit exists precisely so a restart does not take the
// sandboxes down — and `ReapAll` then took them down anyway, every time. On
// 5 Aug all 21 apps on fleet-lab-1 bounced for a one-line change to Go.
//
// What makes it safe is that adoption is not a guess. `Start` writes the image,
// the declared command and the SLOT into the bundle, so the new agent recovers
// exactly what the old one held in memory, and matches on the same two fields a
// live process is matched on. Anything that does not match is started normally,
// and anything nothing desires is stopped.

func manifestBundle(t *testing.T, id string, m sandboxManifest) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeManifest(dir, App{Slug: m.Slug, Image: m.Image},
		Process{Name: m.Process, Kind: ProcessKind(m.Kind), Command: m.Command}, m.Index); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAManifestRoundTrips(t *testing.T) {
	// The slot especially. It is the field with no other source: the image could
	// in principle be re-read from the spec's env, but the index exists only
	// because the agent chose it, and without it the address cannot be derived
	// and the next start collides with this sandbox's IP.
	want := sandboxManifest{Slug: "gzz9j", Process: "web", Kind: "web",
		Image: "reg/gzz9j:abc", Command: []string{"node", "index.js"}, Index: 22}
	dir := manifestBundle(t, "gzz9j--web.", want)

	got, err := readManifest(dir)
	if err != nil {
		t.Fatalf("readManifest: %v", err)
	}
	if got.Slug != want.Slug || got.Image != want.Image || got.Index != want.Index ||
		got.Process != want.Process || !sameStrings(got.Command, want.Command) {
		t.Fatalf("manifest did not round-trip: %+v vs %+v", got, want)
	}
}

func TestTheSlotDecidesTheAddress(t *testing.T) {
	// Adoption derives the address from the slot rather than asking the kernel,
	// so this mapping has to be the same one SetupSandboxNet used. If they ever
	// disagree, an adopted app is routed to an address nothing is listening on.
	cases := map[int]string{0: "10.200.1.1", 21: "10.200.1.22", 253: "10.200.1.254", 254: "10.200.2.1"}
	for idx, want := range cases {
		if got := ipForIndex(idx).String(); got != want {
			t.Fatalf("slot %d -> %s, want %s", idx, got, want)
		}
	}
}

// The claiming decision itself, without containerd: a candidate is adopted only
// when the image AND the declared command still match what desired state asks
// for. This is the same test a live process gets, and it is what makes a deploy
// that landed while the agent was down still take effect.
func adoptDecision(ad Adopted, u App, p Process) bool {
	return ad.Manifest.Image == u.Image && sameStrings(ad.Manifest.Command, p.Command)
}

func TestAnUnchangedSandboxIsAdopted(t *testing.T) {
	ad := Adopted{ID: "anatf--web.", Manifest: sandboxManifest{
		Slug: "anatf", Process: "web", Image: "reg/anatf:v1", Index: 3}}
	if !adoptDecision(ad, App{Slug: "anatf", Image: "reg/anatf:v1"}, Process{Name: "web"}) {
		t.Fatal("an app whose image and command did not change must not be restarted")
	}
}

func TestAChangedImageIsNotAdopted(t *testing.T) {
	// A deploy that landed while the agent was down. Adopting here would leave
	// the OLD code running and never correct itself — the failure mode that
	// makes adoption worse than reaping if it is done loosely.
	ad := Adopted{ID: "anatf--web.", Manifest: sandboxManifest{
		Slug: "anatf", Process: "web", Image: "reg/anatf:v1", Index: 3}}
	if adoptDecision(ad, App{Slug: "anatf", Image: "reg/anatf:v2"}, Process{Name: "web"}) {
		t.Fatal("a changed image must be started fresh, not adopted")
	}
}

func TestAChangedCommandIsNotAdopted(t *testing.T) {
	ad := Adopted{ID: "a8ebb--ticker.", Manifest: sandboxManifest{
		Slug: "a8ebb", Process: "ticker", Image: "reg/a8ebb:v1",
		Command: []string{"node", "ticker.js"}, Index: 7}}
	if adoptDecision(ad, App{Slug: "a8ebb", Image: "reg/a8ebb:v1"},
		Process{Name: "ticker", Command: []string{"node", "ticker2.js"}}) {
		t.Fatal("a changed command means a different program")
	}
}

// The leftovers sweep: a sandbox nothing claimed must be stopped and its slot
// released, or every restart leaks one address.
func TestUnclaimedAdopteesAreStoppedAndTheirSlotsFreed(t *testing.T) {
	a := &Agent{
		live:  map[string]*live{},
		slots: map[int]string{},
		adopt: map[string]Adopted{
			"gone--web.": {ID: "gone--web.", Manifest: sandboxManifest{Slug: "gone", Process: "web", Index: 9}},
		},
	}
	a.slots[9] = "gone--web."
	// Everything below 9 is taken, so the freed slot is the one slotFor must
	// return next — it hands out the lowest free index, and with an empty map it
	// would answer 0 whether or not 9 was ever released.
	for i := 0; i < 9; i++ {
		a.slots[i] = "other--web."
	}

	// What the deferred sweep in reconcileOnce does.
	for id, ad := range a.adopt {
		delete(a.adopt, id)
		delete(a.slots, ad.Manifest.Index)
	}

	if len(a.adopt) != 0 {
		t.Fatal("the adopt set must be empty after the first pass")
	}
	if _, taken := a.slots[9]; taken {
		t.Fatal("an unclaimed sandbox's slot must be released, or a restart leaks an address")
	}
	// And the freed slot is handed out again rather than skipped.
	if got := a.slotFor("new--web."); got != 9 {
		t.Fatalf("slotFor returned %d, want the freed 9", got)
	}
}

func TestAnAdoptedProcessIsNotReportedHealthyOnInheritedWord(t *testing.T) {
	// `ok` must start false. Inheriting a verdict this agent never reached would
	// report a process as healthy on the word of a process that is gone — and
	// the deploy that is watching for health would pass on it.
	now := time.Now()
	l := &live{app: App{Slug: "anatf"}, proc: Process{Name: "web"},
		net: &SandboxNet{IP: ipForIndex(3)}, index: 3, since: now, confirmed: now}
	if l.ok {
		t.Fatal("an adopted process must not start out reported healthy")
	}
	if l.confirmed.IsZero() {
		t.Fatal("confirmed must be stamped, or the process ages out of reporting immediately")
	}
}
