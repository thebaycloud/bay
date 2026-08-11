package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The cache path is a package constant, so these tests point the process at a
// temp directory rather than writing to /srv on whatever machine runs them.
func withTempCache(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	old := cachePath
	cachePath = filepath.Join(dir, "desired.cache.json")
	t.Cleanup(func() { cachePath = old })
}

// A control plane that answers whatever the test sets, and records what it was
// told — the generation the node claimed is the whole point.
func fakePlane(t *testing.T, reply func(claimed int64) any) (*Source, *[]int64) {
	t.Helper()
	claims := []int64{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in syncBody
		_ = json.NewDecoder(r.Body).Decode(&in)
		claims = append(claims, in.Generation)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply(in.Generation))
	}))
	t.Cleanup(srv.Close)
	return &Source{Endpoint: srv.URL, Token: "t", Identity: NodeIdentity{Name: "n1"}}, &claims
}

// THE test. reconcileOnce stops every process it is not told to run, so an
// "unchanged" answer that arrived as an empty desired set would take the whole
// node down on the first quiet poll — every app, on a healthy machine, because
// nothing had changed.
func TestUnchangedKeepsTheAppsRatherThanStoppingThem(t *testing.T) {
	withTempCache(t)
	full := Desired{Apps: []App{{Slug: "lilna", Image: "img"}, {Slug: "izuvx", Image: "img"}}, Generation: 7}

	s, claims := fakePlane(t, func(claimed int64) any {
		if claimed == 7 {
			return Desired{Generation: 7, Unchanged: true}
		}
		return full
	})

	first, err := s.Fetch()
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if len(first.Apps) != 2 {
		t.Fatalf("first fetch should carry the full set, got %d apps", len(first.Apps))
	}

	second, err := s.Fetch()
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if len(second.Apps) != 2 {
		t.Fatalf("an unchanged answer must keep the apps, got %d — this is every app on the node", len(second.Apps))
	}
	if (*claims)[0] != 0 || (*claims)[1] != 7 {
		t.Fatalf("the node must claim nothing first and 7 second, got %v", *claims)
	}
}

// The safety property the whole design rests on: a generation is only ever
// claimed with a cache behind it. Here the cache directory is made unwritable,
// so the write fails and the node must go on claiming nothing — otherwise it
// would answer "I am at 7" with no state to show for it, and the next unchanged
// reply would be unanswerable.
func TestAGenerationIsNotClaimedWithoutACacheBehindIt(t *testing.T) {
	withTempCache(t)
	cachePath = filepath.Join(cachePath, "impossible", "desired.cache.json") // parent does not exist

	s, claims := fakePlane(t, func(int64) any {
		return Desired{Apps: []App{{Slug: "lilna", Image: "img"}}, Generation: 7}
	})

	if _, err := s.Fetch(); err != nil {
		t.Fatalf("a failed cache write must not fail the fetch: %v", err)
	}
	if _, err := s.Fetch(); err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	for i, c := range *claims {
		if c != 0 {
			t.Fatalf("claim %d was %d; a node that could not cache must claim nothing", i, c)
		}
	}
}

// And if it somehow does end up claiming a generation it cannot answer for, it
// says so, forgets the claim, and fails the pass rather than reconciling
// against a set it cannot vouch for.
func TestAnUnanswerableUnchangedForgetsTheClaim(t *testing.T) {
	withTempCache(t)
	s, _ := fakePlane(t, func(int64) any { return Desired{Generation: 9, Unchanged: true} })
	s.lastGeneration = 9

	if _, err := s.Fetch(); err == nil {
		t.Fatal("an unchanged answer with no cache must fail the pass, not return an empty set")
	}
	if s.lastGeneration != 0 {
		t.Fatalf("the claim must be forgotten so the next poll asks for everything, got %d", s.lastGeneration)
	}
}

// A control plane too old to send a generation sends zero, and the node must go
// on receiving the full set rather than treating zero as "you are up to date".
func TestAControlPlaneWithNoGenerationStillWorks(t *testing.T) {
	withTempCache(t)
	s, claims := fakePlane(t, func(int64) any {
		return Desired{Apps: []App{{Slug: "lilna", Image: "img"}}} // no Generation field
	})
	for i := 0; i < 3; i++ {
		d, err := s.Fetch()
		if err != nil {
			t.Fatalf("fetch %d: %v", i, err)
		}
		if len(d.Apps) != 1 {
			t.Fatalf("fetch %d should carry the full set, got %d", i, len(d.Apps))
		}
	}
	for i, c := range *claims {
		if c != 0 {
			t.Fatalf("claim %d was %d; nothing to claim against a control plane that sends none", i, c)
		}
	}
	_ = os.Remove(cachePath)
}
