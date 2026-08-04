package main

// Secret resolution.
//
// On Cloud Run, secrets never touch the platform: `--update-secrets` hands Cloud
// Run a reference and Cloud Run mounts the value. There is no equivalent here —
// the agent is the thing that starts the process, so the agent is the thing that
// has to resolve the reference.
//
// Three rules follow from that, and they are the whole design:
//
//   - Values are resolved at start and passed in the process environment. They
//     are never written to node disk, never logged, and never put in the bundle's
//     config.json, which is world-readable inside the sandbox.
//   - The node's own service account does the reading, and it is the only
//     identity on the box that can — the nftables rule in provision.sh keeps the
//     metadata credentials API away from every tenant.
//   - A secret that cannot be resolved FAILS the start. Starting an app with a
//     missing DATABASE_URL produces a process that comes up, fails every request,
//     and passes a health check on "/" — which is worse than not starting.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const secretManagerBase = "https://secretmanager.googleapis.com/v1"

// dbProxyAddr is the one Cloud SQL Auth Proxy per node, reached over the
// sandbox bridge gateway (see bridgeCIDR in network.go) rather than
// localhost, because every sandbox's network namespace has its own loopback.
const dbProxyAddr = "10.200.0.1:5432"

// resolveSecret fetches one secret version's payload.
//
// `name` is the bare secret id (e.g. `app-<slug>-DATABASE_URL`), matching what
// `app-secrets.ts` creates. Accepting a bare id rather than a full resource path
// keeps the placement spec free of project ids, so the same spec is valid if the
// fleet ever moves project.
func resolveSecret(project, name string) (string, error) {
	tok, err := metadataToken()
	if err != nil {
		return "", fmt.Errorf("metadata token: %w", err)
	}

	u := fmt.Sprintf("%s/projects/%s/secrets/%s/versions/latest:access",
		secretManagerBase, url.PathEscape(project), url.PathEscape(name))
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("Authorization", "Bearer "+tok)

	c := &http.Client{Timeout: 15 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		// The message is deliberately the API's, not a summary: the difference
		// between "not found" and "permission denied" is the difference between
		// a bad spec and a missing IAM binding on the node's service account,
		// and collapsing them costs an hour every time.
		return "", fmt.Errorf("secret %s: %d %s", name, resp.StatusCode,
			strings.TrimSpace(string(raw[:min(len(raw), 300)])))
	}

	var out struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("secret %s: parse: %w", name, err)
	}
	b, err := base64.StdEncoding.DecodeString(out.Payload.Data)
	if err != nil {
		return "", fmt.Errorf("secret %s: decode: %w", name, err)
	}
	return string(b), nil
}

// resolveAll turns an app's secret references into values.
//
// Concurrent, because an app with a database has several and doing them in
// series adds a round trip each to every cold start.
func resolveAll(project string, refs map[string]string) (map[string]string, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	type res struct {
		key, val string
		err      error
	}
	ch := make(chan res, len(refs))
	for key, name := range refs {
		go func(key, name string) {
			v, err := resolveSecret(project, name)
			ch <- res{key: key, val: v, err: err}
		}(key, name)
	}

	out := make(map[string]string, len(refs))
	var firstErr error
	for range refs {
		r := <-ch
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		out[r.key] = r.val
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// hasDatabase is true when this app was given a database by the platform.
//
// The reference can arrive either as a Secret Manager id (before resolution)
// or, once resolved, as a plain value in the environment — checking both
// means this stays correct regardless of where in the start sequence it is
// called from.
func hasDatabase(app App) bool {
	if _, ok := app.Secrets["DATABASE_URL"]; ok {
		return true
	}
	_, ok := app.Env["DATABASE_URL"]
	return ok
}

// dbPathReachable checks that this node's database path is up.
//
// A secret that cannot be resolved already fails a start, and for the same
// reason: an app that comes up without a working DATABASE_URL passes a health
// check on "/" and fails every request that touches data.
//
// The error names the NODE deliberately. Without that this failure is
// indistinguishable from a broken app, and the repair agent is handed a
// customer's repository to fix over our own outage.
func dbPathReachable(addr string, timeout time.Duration) error {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return fmt.Errorf("this node's database path (%s) is not answering — a node problem, not this app's: %w", addr, err)
	}
	return conn.Close()
}
