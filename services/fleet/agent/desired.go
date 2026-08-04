package main

// Where desired state comes from.
//
// The agent ASKS. Nothing pushes to a node. That direction is the availability
// story: a control plane that is down cannot take running apps with it, and a
// node that reboots while the control plane is unreachable comes back serving
// from the answer it cached last time.
//
// Order of preference, and each fallback is deliberate:
//   1. the control plane, if one is configured
//   2. the last answer it gave, from disk
//   3. a local file, for a node with no control plane at all (the lab)

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const cachePath = "/srv/state/desired.cache.json"

// NodeIdentity is what this node tells the control plane about itself.
type NodeIdentity struct {
	Name        string `json:"name"`
	Zone        string `json:"zone"`
	InternalIP  string `json:"internalIp"`
	MemoryBytes int64  `json:"memoryBytes"`
	CPUs        int    `json:"cpus"`
}

// ProcessFault is one process's most recent start failure, as the node sees it.
//
// Sent on the sync that already runs every ten seconds, so there is no new
// channel to secure and no second auth surface.
//
// Detail carries the error text ONLY for a classified fault. An unclassified
// failure's error can be the last 800 bytes of the app's own log (container.go
// wraps the runsc tail into it), which is the customer's stdout and can hold
// anything they printed — including a credential. That text already goes to the
// node's log; this field would take it off the node, into shared Postgres, and
// in phase 1C-1 Task 4 into a deploy reason a user reads. The classified cases
// are strings this package writes itself — dbPathReachable's and resolveSecret's
// — and carry no app output at all.
type ProcessFault struct {
	Slug    string `json:"slug"`
	Process string `json:"process"`
	Fault   Fault  `json:"fault"`
	Detail  string `json:"detail,omitempty"`
}

// syncBody is what the node POSTs: its identity, plus what it has to say about
// the processes it was given.
//
// Processes is a POINTER to a slice, and that is load-bearing on the wire:
//
//	nil            -> the field is absent    -> "this agent does not report"
//	&[]            -> the field is []        -> "I hold nothing failing"
//	&[...]         -> the field is a list    -> "these are failing"
//
// Absent and empty must stay different facts. An agent too old to know about
// this field sends neither, and the control plane must leave whatever it has
// stored alone — otherwise a rolling agent upgrade reads as a fleet-wide
// recovery. But a NEW agent with nothing failing must send `[]` and mean it,
// because that is the only thing that ever clears a stored fault: the agent
// keeps faults in memory, so every restart legitimately starts with none, and
// an agent that stayed silent about that would leave a repaired app marked as a
// node fault in Postgres forever, failing every later deploy as a platform
// problem. `omitempty` on a plain slice cannot express this — it drops nil and
// empty alike — which is why the pointer is here.
type syncBody struct {
	NodeIdentity
	Processes *[]ProcessFault `json:"processes,omitempty"`
}

func metadata(path string) (string, error) {
	req, _ := http.NewRequest("GET", "http://169.254.169.254/computeMetadata/v1/"+path, nil)
	req.Header.Set("Metadata-Flavor", "Google")
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(b)), err
}

// Identify reads this node's own facts from the metadata server.
func Identify() (NodeIdentity, error) {
	var id NodeIdentity
	name, err := metadata("instance/name")
	if err != nil {
		return id, fmt.Errorf("instance name: %w", err)
	}
	// The zone arrives as projects/<num>/zones/<zone>; only the last element is
	// meaningful and storing the rest would make every comparison a suffix match.
	zone, err := metadata("instance/zone")
	if err != nil {
		return id, fmt.Errorf("zone: %w", err)
	}
	if i := strings.LastIndex(zone, "/"); i >= 0 {
		zone = zone[i+1:]
	}
	ip, err := metadata("instance/network-interfaces/0/ip")
	if err != nil {
		return id, fmt.Errorf("internal ip: %w", err)
	}

	id = NodeIdentity{Name: name, Zone: zone, InternalIP: ip, CPUs: runtime.NumCPU()}
	id.MemoryBytes = totalMemoryBytes()
	return id, nil
}

// totalMemoryBytes reads MemTotal. Reported to the control plane for placement;
// zero is survivable (placement treats it as unknown) so this never fails hard.
func totalMemoryBytes() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		var kb int64
		if _, err := fmt.Sscanf(line, "MemTotal: %d kB", &kb); err == nil {
			return kb * 1024
		}
	}
	return 0
}

// Source fetches desired state, from the control plane when there is one.
type Source struct {
	Endpoint string // e.g. https://control-plane/api/fleet/sync
	Token    string
	Identity NodeIdentity
	Local    string // fallback file for a node with no control plane
	// Report answers "what is failing on this node right now", called once per
	// sync. A nil Report means this node does not report at all, which is a
	// different statement from reporting nothing — see syncBody.
	Report func() []ProcessFault
}

func (s *Source) Fetch() (Desired, error) {
	if s.Endpoint == "" {
		return s.fromFile(s.Local)
	}

	d, err := s.fromControlPlane()
	if err == nil {
		// Cache only a good answer. Writing the cache on failure would let one
		// bad response become the node's permanent idea of the world.
		if b, mErr := json.MarshalIndent(d, "", "  "); mErr == nil {
			tmp := cachePath + ".tmp"
			if os.WriteFile(tmp, b, 0o600) == nil {
				_ = os.Rename(tmp, cachePath)
			}
		}
		return d, nil
	}

	// The control plane is unreachable or unhappy. Keep serving what it last
	// said rather than treating silence as "run nothing", which would take every
	// app on the node down for the duration of a control-plane outage.
	log.Printf("desired: control plane unavailable (%v); using cache", err)
	if cached, cErr := s.fromFile(cachePath); cErr == nil {
		return cached, nil
	}
	return Desired{}, err
}

func (s *Source) fromControlPlane() (Desired, error) {
	var d Desired
	payload := syncBody{NodeIdentity: s.Identity}
	if s.Report != nil {
		// Never a nil slice behind the pointer: json.Marshal writes `null` for
		// one, and `null` is not an array, so the control plane would read it as
		// "does not report" and never clear a stale fault.
		p := s.Report()
		if p == nil {
			p = []ProcessFault{}
		}
		payload.Processes = &p
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return d, err
	}
	req, err := http.NewRequest("POST", s.Endpoint, bytes.NewReader(body))
	if err != nil {
		return d, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.Token)

	c := &http.Client{Timeout: 20 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return d, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != 200 {
		return d, fmt.Errorf("control plane %d: %s", resp.StatusCode,
			strings.TrimSpace(string(raw[:min(len(raw), 200)])))
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return d, fmt.Errorf("parse response: %w", err)
	}
	return d, nil
}

func (s *Source) fromFile(path string) (Desired, error) {
	var d Desired
	if path == "" {
		return d, fmt.Errorf("no desired-state file configured")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Desired{}, nil
		}
		return d, err
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, fmt.Errorf("parse %s: %w", path, err)
	}
	return d, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
