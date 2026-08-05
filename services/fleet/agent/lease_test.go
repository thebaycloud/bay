package main

import (
	"strings"
	"testing"

	"github.com/containerd/containerd/v2/pkg/identifiers"
)

// The ids this agent actually produces, from process.go's `slug + "--" + name + "."`.
//
// `subio-2` is in the list because it is a real slug on fleet-lab-1 and it is the
// one that makes sanitising alone unsafe: it already contains the separator the
// sanitiser introduces.
func realSandboxIDs() []string {
	return []string{
		"gzz9j--release.",
		"p6mx8--release.",
		"anatf--web.",
		"a8ebb--ticker.",
		"subio--web.",
		"subio-2--web.",
		"ss-mt-df8y2z--web.",
		"cursor-meetup--web.",
		"i6xce--web.",
	}
}

// leaseID must produce something containerd will take, checked with containerd's
// OWN validator.
//
// Mirroring the regex here would prove only that the mirror matches itself — the
// same trap fault_test.go documents for the Secret Manager error string. A lease
// id containerd rejects means Create fails, prepareRootfs returns an error, and
// the sandbox never starts: the failure this file exists to prevent is total, not
// cosmetic.
func TestLeaseIDIsAValidContainerdIdentifier(t *testing.T) {
	for _, id := range realSandboxIDs() {
		lid := leaseID(id)
		if err := identifiers.Validate(lid); err != nil {
			t.Errorf("leaseID(%q) = %q, which containerd rejects: %v", id, lid, err)
		}
		if len(lid) > 76 {
			t.Errorf("leaseID(%q) = %q is %d chars, over containerd's 76", id, lid, len(lid))
		}
	}
}

// The raw sandbox id is NOT a valid lease id, which is the reason this function
// exists at all. If containerd ever relaxes its rule this test fails and the
// function can go.
func TestRawSandboxIDWouldBeRejected(t *testing.T) {
	if err := identifiers.Validate("gzz9j--release."); err == nil {
		t.Fatal("containerd now accepts `gzz9j--release.` as an identifier — leaseID is no longer needed")
	}
}

// Distinct sandboxes must get distinct leases, or Stop on one deletes the lease
// holding another's snapshot — which is the original bug, aimed at a live app.
func TestLeaseIDDoesNotCollide(t *testing.T) {
	seen := map[string]string{}
	// The pair that collides under sanitising alone.
	ids := append(realSandboxIDs(), "subio--2-web.", "subio-2--web.")
	for _, id := range ids {
		lid := leaseID(id)
		if prev, dup := seen[lid]; dup && prev != id {
			t.Errorf("leaseID collision: %q and %q both give %q", prev, id, lid)
		}
		seen[lid] = id
	}
}

// Stop derives the lease id from the sandbox id with nothing stored, so the same
// input must always give the same answer — including across a restart, which is
// exactly when Stop is used to clear wreckage.
func TestLeaseIDIsStable(t *testing.T) {
	for _, id := range realSandboxIDs() {
		if a, b := leaseID(id), leaseID(id); a != b {
			t.Errorf("leaseID(%q) is not stable: %q then %q", id, a, b)
		}
	}
}

// The readable half survives, so `ctr leases ls` is legible to a human looking
// for one app's lease. Not cosmetic: a leaked lease pins a snapshot forever, and
// the only way anyone finds it is by reading that list.
func TestLeaseIDKeepsTheSlugReadable(t *testing.T) {
	lid := leaseID("gzz9j--release.")
	if !strings.HasPrefix(lid, "gzz9j-release-") {
		t.Errorf("leaseID lost the slug: %q", lid)
	}
}
