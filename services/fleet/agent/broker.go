package main

// The secret broker, from the node's side.
//
// The node used to read Secret Manager itself, with its own service account —
// which holds `secretmanager.secretAccessor` project-wide and unconditioned, so
// one escape from one sandbox read every tenant's database password. Now it asks
// the control plane, which answers only for apps currently placed on this node
// under a live lease. See apps/web/lib/secret-broker.ts for the decision.
//
// THERE IS NO FALLBACK TO THE DIRECT PATH, deliberately. The point of the
// exercise is to remove secret access from the node's service account, and once
// that grant is gone a fallback is dead code that cannot work. Keeping one
// during the transition would mean a broker that silently never worked, with
// every start quietly taking the old path and the security change never landing.
// §8 states the consequence and accepts it: a cold boot needs the broker.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// brokerURL derives the broker's address from the sync endpoint.
//
// One endpoint is configured on a node, not two that can disagree.
//
// THE LAST PATH SEGMENT IS REPLACED, rather than a `/sync` suffix being
// required. The strict version was written first and was wrong for a reason
// worth keeping: `agent.env` was "added to the live unit by hand" and is in no
// file in this repository, so its exact value cannot be read from here. An
// assumption about the shape of a string nobody can check, guarded by
// `log.Fatalf`, meets `Restart=always` and becomes a crash loop — which leaves
// every sandbox on the node running with nothing supervising them.
//
// Replacement is also no less safe than the suffix check. The host and the path
// prefix come from the endpoint either way, so the worst case is the right
// control plane at a path that does not exist — a 404 the caller reports —
// rather than an app's secret names sent somewhere unintended.
func brokerURL(syncEndpoint string) string {
	if syncEndpoint == "" {
		return ""
	}
	// The last "/" has to be inside the PATH, with a segment after it to replace.
	// Without the first check `https://cp.example` matches on the second slash of
	// `://` and yields `https://secrets` — a hostname invented out of a scheme.
	// Without the second, `https://cp.example/` yields `https://cp.example/secrets`,
	// which is a guess at a route rather than a derivation from one.
	scheme := strings.Index(syncEndpoint, "://")
	if scheme < 0 {
		return ""
	}
	i := strings.LastIndex(syncEndpoint, "/")
	if i < scheme+3 || i+1 >= len(syncEndpoint) {
		return ""
	}
	return syncEndpoint[:i+1] + "secrets"
}

// Configured once in main, after identity is known. Package vars for the same
// reason `secretManagerBase` is one: so a test can point them somewhere real.
var (
	brokerEndpoint string
	brokerToken    string
	brokerNode     string
)

// resolveViaBroker turns an app's secret references into values.
//
// `refs` is env-name → secret-id, and the result is keyed by ENV NAME: the
// caller is building a process environment, and the id is a detail of where the
// value came from.
func resolveViaBroker(endpoint, token, node, slug string, refs map[string]string) (map[string]string, error) {
	if len(refs) == 0 {
		return nil, nil
	}

	names := make([]string, 0, len(refs))
	for _, id := range refs {
		names = append(names, id)
	}
	body, err := json.Marshal(struct {
		Node  string   `json:"node"`
		Slug  string   `json:"slug"`
		Names []string `json:"names"`
	}{Node: node, Slug: slug, Names: names})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	// WHICH node is asking, signed by Google rather than asserted by us.
	//
	// The shared token above proves membership and nothing else, so the broker's
	// per-node placement check is currently written against a name this process
	// supplies about itself. This header is the same claim with a signature on
	// it, and the control plane compares the two.
	//
	// Best-effort on purpose: the shared token still authenticates this call, so
	// a metadata server that will not answer costs the extra proof and not the
	// deploy. The control plane decides what an absent header means — today it
	// audits, and when every node is sending one it can refuse.
	if id, err := nodeIdentityToken(); err == nil {
		req.Header.Set("X-Supersonic-Node-Identity", id)
	} else {
		log.Printf("! could not mint an instance identity token (%v) — "+
			"the request still carries the fleet token", err)
	}

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("secret broker: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode != 200 {
		// The broker's own reason, not a summary of it. "not placed" and "lease
		// expired" mean a stale spec and a lost lease, and classifyStartError
		// reads these strings — collapsing them costs the distinction exactly as
		// it does in resolveSecret.
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(raw[:min(len(raw), 300)]))
		}
		return nil, fmt.Errorf("secret broker refused %s on %s: %d %s", slug, node, resp.StatusCode, e.Error)
	}

	var out struct {
		Values map[string]string `json:"values"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("secret broker: parse: %w", err)
	}

	// Every name, or none. A partial environment is the failure the agent's
	// "an unresolvable secret fails the start" rule exists to prevent: the
	// process comes up, passes a health check on "/", and fails every request
	// that touches data.
	res := make(map[string]string, len(refs))
	for key, id := range refs {
		v, ok := out.Values[id]
		if !ok {
			return nil, fmt.Errorf("secret broker: %s returned nothing for %s", endpoint, id)
		}
		res[key] = v
	}
	return res, nil
}
