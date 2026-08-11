package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// captureSync stands in for the control plane and returns the raw body the node
// POSTed, so these tests assert on the JSON that actually goes over the wire
// rather than on the Go value that produced it. The three states of `processes`
// are a wire contract — absent, [], and a list — and a test on the struct could
// not tell the first two apart.
func captureSync(t *testing.T, s *Source) map[string]json.RawMessage {
	t.Helper()

	var raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ = io.ReadAll(r.Body)
		io.WriteString(w, `{"apps":[]}`)
	}))
	t.Cleanup(srv.Close)

	s.Endpoint = srv.URL
	if _, err := s.fromControlPlane(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("the node sent something that is not an object: %v (%s)", err, raw)
	}
	return body
}

func TestAnAgentThatDoesNotReportOmitsTheFieldEntirely(t *testing.T) {
	// A nil Report is an agent that does not participate — including every
	// agent built before this field existed. The control plane keys "leave the
	// stored faults alone" off the field's absence, so absence has to survive
	// the encoder.
	body := captureSync(t, &Source{Identity: NodeIdentity{Name: "fleet-lab-1"}})
	if _, present := body["processes"]; present {
		t.Fatalf("a nil Report must send no processes field at all, got %s", body["processes"])
	}
}

func TestAnAgentWithNothingFailingSendsAnEmptyArrayNotNothing(t *testing.T) {
	// This is the one that keeps a repaired app repaired. Faults live in memory,
	// so every agent restart legitimately has none; if "none" were sent as
	// absence, the control plane would never clear the row it stored before the
	// restart and every later deploy of that app would fail as a platform fault
	// forever. `null` is not good enough either — the reader tests for an array.
	body := captureSync(t, &Source{
		Identity: NodeIdentity{Name: "fleet-lab-1"},
		Report:   func() []ProcessFault { return nil },
	})
	got, present := body["processes"]
	if !present {
		t.Fatal("an agent that reports nothing must still send processes: []")
	}
	if string(got) != "[]" {
		t.Fatalf("want [], got %s — null is not an array and reads as 'does not report'", got)
	}
}

func TestAReportedFaultReachesTheWire(t *testing.T) {
	body := captureSync(t, &Source{
		Identity: NodeIdentity{Name: "fleet-lab-1"},
		Report: func() []ProcessFault {
			return []ProcessFault{{Slug: "a8ebb", Process: "web", Fault: FaultNode, Detail: "the database path is not answering"}}
		},
	})
	var got []ProcessFault
	if err := json.Unmarshal(body["processes"], &got); err != nil {
		t.Fatalf("processes did not decode: %v", err)
	}
	if len(got) != 1 || got[0].Slug != "a8ebb" || got[0].Fault != FaultNode {
		t.Fatalf("got %+v", got)
	}
}

func TestTheIdentityStillTravelsAlongsideTheReport(t *testing.T) {
	// The report is an addition to this body, not a replacement for it. Placement
	// reads memoryBytes and cpus off the same POST, and dropping them while
	// adding a field would take every deploy's node choice with it.
	body := captureSync(t, &Source{
		Identity: NodeIdentity{Name: "fleet-lab-1", Zone: "us-central1-a", InternalIP: "10.0.0.2", MemoryBytes: 8 << 30, CPUs: 4},
		Report:   func() []ProcessFault { return nil },
	})
	for _, k := range []string{"name", "zone", "internalIp", "memoryBytes", "cpus"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("the sync body lost %q", k)
		}
	}
}

func TestReportFaultsIsACopyAndOrdered(t *testing.T) {
	a := &Agent{faults: map[string]ProcessFault{
		"zulu--web.1":  {Slug: "zulu", Process: "web", Fault: FaultNode},
		"alpha--web.1": {Slug: "alpha", Process: "web", Fault: FaultApp},
		"alpha--wkr.1": {Slug: "alpha", Process: "worker", Fault: FaultUnknown},
	}}

	got := a.reportFaults()
	want := []string{"alpha/web", "alpha/worker", "zulu/web"}
	for i, w := range want {
		if got[i].Slug+"/"+got[i].Process != w {
			t.Fatalf("position %d: got %s/%s, want %s", i, got[i].Slug, got[i].Process, w)
		}
	}

	// A copy, not the map: the sync goroutine marshals this while starts write
	// to a.faults, and handing out shared state puts a JSON encoder on one end
	// of a data race.
	got[0].Slug = "mutated"
	if a.faults["alpha--web.1"].Slug != "alpha" {
		t.Fatal("reportFaults handed out state the caller can mutate")
	}
}

func TestAnUnknownFaultSendsNoDetail(t *testing.T) {
	// container.go folds the last 800 bytes of the app's own log into a start
	// error, so an unclassified detail is the customer's stdout — which can hold
	// whatever they printed, including a credential. It stays on the node.
	appLog := "Traceback…\nDATABASE_URL=postgresql://u:hunter2@10.200.0.1:5432/db\n"
	err := errors.New("runsc run --detach a8ebb--web.1: exit status 1: " + appLog)

	if d := faultDetail(classifyStartError(err), err); d != "" {
		t.Fatalf("an unclassified error must not send its text off the node, got %q", d)
	}
}

func TestAClassifiedFaultSendsItsDetailBounded(t *testing.T) {
	// The classified strings are ours and carry no app output, so they travel —
	// but they land in a Postgres column and in a sentence a user reads, so the
	// length is not the app's to choose.
	err := dbPathReachable("127.0.0.1:1", 200*time.Millisecond)
	d := faultDetail(classifyStartError(err), err)
	if !strings.Contains(d, "not answering") {
		t.Fatalf("a node fault must explain itself, got %q", d)
	}

	long := errors.New("this node's database path (10.200.0.1:5432) is not answering — " + strings.Repeat("x", 5000))
	d = faultDetail(classifyStartError(long), long)
	if len([]rune(d)) > detailLimit+1 {
		t.Fatalf("detail is unbounded: %d runes", len([]rune(d)))
	}
}

func TestSyncBodyCarriesTheAgentVersion(t *testing.T) {
	old := Version
	defer func() { Version = old }()
	Version = "abc1234"

	b, err := json.Marshal(syncBody{
		NodeIdentity: NodeIdentity{Name: "n1", Zone: "z", InternalIP: "10.0.0.1"},
		Version:      Version,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"version":"abc1234"`) {
		t.Fatalf("version missing from sync body: %s", b)
	}
}
