# Phase 0: Close the fleet's open door — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hop from the edge proxy to a fleet node authenticated, stop
sending a Google-signed identity assertion over a plaintext public hop, disarm a
canary aimed at an unverified node, and fix two comments that assert the opposite
of their code.

**Architecture:** The node's router gains a shared-secret gate, off by default so
the binary can ship before the proxy that feeds it. The proxy learns one
predicate — "is this upstream a Cloud Run service or a fleet node" — and uses it
in both directions: ID token to Cloud Run only, edge secret to the fleet only.
Enforcement is switched on last, by a line in a file on the node.

**Tech Stack:** Go 1.26 (`services/fleet/agent`, stdlib only), TypeScript on
Node 22 with `node:test` (`services/proxy`), gcloud CLI.

## Global Constraints

- **Never squash commits.** One commit per change, pushed immediately.
- **Never print secrets.** Not in logs, not in test output, not in a commit.
- **Every push to `main` deploys the control plane to production.** There is no staging.
- **Never put a pipe inside an `&&` chain that gates a push** — the chain takes the pipe's exit status. Redirect to a file and read the file.
- **Run TypeScript commands from the package directory**, never the repo root. At the root `npx tsc` resolves to an unrelated package and prints "This is not the tsc command you are looking for" while exiting 1.
- **Go builds for the node are `GOOS=linux GOARCH=amd64`.**
- **`pkill -f` inside a `gcloud compute ssh --command` kills the ssh command itself**, because the pattern matches the remote shell's own command line. Match on the exact comm with `-x`.
- The header name is **`x-supersonic-edge`** everywhere. The env var is **`FLEET_EDGE_SECRET`** everywhere.

---

### Task 1: Disarm the canary

No code. Do this first because it costs one command and removes a live risk that
everything else is unrelated to.

`supersonic-deploy-job` carries `FLEET_APPS=t1cyj`. Deploys execute in that job,
not in the control-plane service (`apps/web/app/api/deploy/route.ts:220`), so the
canary is live and aimed at a node whose Cloud SQL proxy has never been started
and whose nftables ruleset has never been parsed. A failed placement will not
take `t1cyj` down — its Cloud Run service keeps serving until `run_url` flips —
but it will mark the deploy failed and dispatch the repair agent, with write
access to a customer's checkout, over our own unverified node.

**Files:** none.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Later tasks do not depend on this one; it is first because it is cheap.

- [ ] **Step 1: Read the current value, so the rollback is written down**

```bash
gcloud run jobs describe supersonic-deploy-job --project supersonic-deploy-prod \
  --region us-central1 --format=json > /tmp/deploy-job-before.json
grep -o '"name": "FLEET_APPS"[^}]*}' /tmp/deploy-job-before.json
```

Expected: a line naming `FLEET_APPS` with the value `t1cyj`. Write that value
down — restoring it is how this is undone.

- [ ] **Step 2: Remove it**

```bash
gcloud run jobs update supersonic-deploy-job --project supersonic-deploy-prod \
  --region us-central1 --remove-env-vars FLEET_APPS
```

- [ ] **Step 3: Verify it is gone**

```bash
gcloud run jobs describe supersonic-deploy-job --project supersonic-deploy-prod \
  --region us-central1 --format=json > /tmp/deploy-job-after.json
grep -c FLEET_APPS /tmp/deploy-job-after.json
```

Expected: `0`.

Note the redirect-then-grep rather than a pipe: a pipe here would report grep's
status, not gcloud's.

- [ ] **Step 4: No commit**

Nothing changed in the repository. Record the removal in the task tracker or the
next handoff instead.

---

### Task 2: The node's router refuses an unsigned request

**Files:**
- Modify: `services/fleet/agent/router.go` (struct at :113-117, `NewRouter` at :119, `ServeHTTP` at :177, header comment at :15-20)
- Modify: `services/fleet/agent/main.go:264` — the one `NewRouter` call site
- Create: `services/fleet/agent/router_test.go`

**Interfaces:**
- Consumes: `Route` (`main.go:71-76`) — fields `Slug string`, `Addr string`, `Healthy bool`, `Since int64`; `fleetHealthPath` (`router.go:175`); `page(code int, title, detail string) string` (`router.go:282`).
- Produces: `NewRouter(rootDomain, edgeSecret string) *Router`. Task 4 sets `edgeSecret` from `os.Getenv("FLEET_EDGE_SECRET")`. The response marker for a refusal is the string `unsigned` in the `X-Supersonic-Router` header.

Three properties this must have, and each has a test because each has a way of
being wrong that looks fine:

1. **The health path stays open.** The Google load balancer's health check cannot
   carry a secret. Gate it and `fleet-backend` drains the only node in the group,
   which takes every app on the fleet down. This is the single most dangerous
   line in the task.
2. **An empty secret means no enforcement.** That is what lets this binary ship
   to the node before the proxy that sets the header exists, so the two deploys
   need not be simultaneous.
3. **The secret is never forwarded to the tenant's app.** The app is the one
   party on this path that must not learn it, because learning it lets it reach
   every other app on the node.

- [ ] **Step 1: Write the failing tests**

Create `services/fleet/agent/router_test.go`:

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

const testSecret = "edge-secret-for-tests"

// withRoute puts one healthy route in the table without going through a file.
func withRoute(rt *Router, slug, addr string) {
	rt.table.mu.Lock()
	rt.table.byslug = map[string]Route{slug: {Slug: slug, Addr: addr, Healthy: true}}
	rt.table.mu.Unlock()
}

func TestHealthPathStaysOpenWhenASecretIsSet(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	rt.ServeHTTP(w, httptest.NewRequest("GET", fleetHealthPath, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("health check got %d, want 200 — the load balancer cannot send a secret, "+
			"and gating this drains the backend", w.Code)
	}
}

func TestUnsignedRequestIsRefused(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	rt.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
	if got := w.Header().Get("X-Supersonic-Router"); got != "unsigned" {
		t.Fatalf("marker %q, want %q", got, "unsigned")
	}
}

func TestWrongSecretIsRefused(t *testing.T) {
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", "not-the-secret")
	rt.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403", w.Code)
	}
}

func TestSignedRequestReachesTheRoutingTable(t *testing.T) {
	// The table is empty, so "miss" is proof the request got PAST the gate.
	rt := NewRouter("supersonic.cv", testSecret)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", testSecret)
	rt.ServeHTTP(w, r)
	if got := w.Header().Get("X-Supersonic-Router"); got != "miss" {
		t.Fatalf("marker %q, want %q — a signed request must reach the table", got, "miss")
	}
}

func TestNoSecretConfiguredMeansNoEnforcement(t *testing.T) {
	// This is what lets the binary ship before the proxy that signs.
	rt := NewRouter("supersonic.cv", "")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	rt.ServeHTTP(w, r)
	if got := w.Header().Get("X-Supersonic-Router"); got != "miss" {
		t.Fatalf("marker %q, want %q — an unset secret must not enforce", got, "miss")
	}
}

func TestTheSecretIsNeverForwardedToTheApp(t *testing.T) {
	var seen string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("x-supersonic-edge")
		w.WriteHeader(http.StatusOK)
	}))
	defer app.Close()

	u, err := url.Parse(app.URL)
	if err != nil {
		t.Fatal(err)
	}

	rt := NewRouter("supersonic.cv", testSecret)
	withRoute(rt, "a8ebb", u.Host)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("x-supersonic-slug", "a8ebb")
	r.Header.Set("x-supersonic-edge", testSecret)
	rt.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("proxied request got %d, want 200", w.Code)
	}
	if seen != "" {
		t.Fatalf("the app received the edge secret; it must be stripped before proxying")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd services/fleet/agent && go test ./... > /tmp/router-test-1.txt 2>&1; echo "exit=$?"
cat /tmp/router-test-1.txt
```

Expected: a compile failure — `too many arguments in call to NewRouter`. That is
the correct first failure; the signature does not exist yet.

- [ ] **Step 3: Add the field and the parameter**

In `services/fleet/agent/router.go`, add `"crypto/subtle"` to the import block,
then change the struct at :113-117 and the constructor at :119:

```go
type Router struct {
	table      *routerTable
	rootDomain string
	// edgeSecret is what the edge proxy signs its requests with.
	//
	// Empty means unenforced, deliberately: it lets this binary reach a node
	// before the proxy that sets the header, so the two deploys do not have to be
	// simultaneous. Turning it on is one line in /etc/supersonic/fleet.env and a
	// restart, and turning it off again is deleting that line.
	edgeSecret string
	proxy      *httputil.ReverseProxy
}

func NewRouter(rootDomain, edgeSecret string) *Router {
	rt := &Router{
		table:      &routerTable{byslug: map[string]Route{}},
		rootDomain: rootDomain,
		edgeSecret: edgeSecret,
	}
```

Leave the rest of `NewRouter` unchanged.

- [ ] **Step 4: Add the gate to `ServeHTTP`**

In `services/fleet/agent/router.go`, immediately AFTER the `fleetHealthPath`
block that ends at :185 and BEFORE the `x-supersonic-slug` read at :200, insert:

```go
	// Everything below this line must come from the edge proxy.
	//
	// The health path is handled above and stays open, because the load balancer's
	// health check cannot carry a secret and failing it drains the node out of the
	// backend — which takes every app on the fleet down.
	//
	// This gate is what the comment at the top of this file used to claim and did
	// not do. `x-supersonic-slug` is client-supplied and names any app on the
	// node; the load balancer in front of this port answers the open internet, so
	// without this anyone could reach a placed app around the proxy's session
	// check, decideAccess, app_grants and workspace scoping.
	if rt.edgeSecret != "" {
		got := r.Header.Get("x-supersonic-edge")
		if subtle.ConstantTimeCompare([]byte(got), []byte(rt.edgeSecret)) != 1 {
			w.Header().Set("X-Supersonic-Router", "unsigned")
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, page(403, "Not through the front door.",
				"This node serves the edge proxy only."))
			return
		}
	}
	// The tenant's app is the one party on this path that must not learn the
	// secret: with it, an app could reach every other app on the node.
	r.Header.Del("x-supersonic-edge")
```

- [ ] **Step 5: Update the one call site**

In `services/fleet/agent/main.go`, line 264:

```go
	go NewRouter(*rootDomain, os.Getenv("FLEET_EDGE_SECRET")).Serve(*routerAddr, routesPath)
```

`os` is already imported in `main.go` (it reads `FLEET_ENDPOINT` and
`FLEET_TOKEN` at :236-237).

- [ ] **Step 6: Rewrite the header comment that was false**

In `services/fleet/agent/router.go`, replace lines 15-20 — the paragraph
beginning "What is deliberately NOT here yet" — with:

```go
// What is deliberately NOT here: visibility and access control. Private and
// workspace-scoped apps, `app_grants`, the session cookie and the overlay
// injection all live in `services/proxy`.
//
// This router does NOT enforce any of that, and an earlier version of this
// comment claimed it did — "refuses to serve anything the control plane has not
// marked public". It never did: `desiredFor` selects on runtime alone and never
// reads `apps.visibility`, so private apps are placed here like any other. What
// keeps them private is that every request must come from the edge proxy, which
// does enforce it. That is what `edgeSecret` below is for, and it is the only
// thing standing between a placed app and the open internet.
```

- [ ] **Step 7: Run the tests and vet**

```bash
cd services/fleet/agent && go test ./... > /tmp/router-test-2.txt 2>&1; echo "exit=$?"
cat /tmp/router-test-2.txt
go vet ./... > /tmp/router-vet.txt 2>&1; echo "exit=$?"
cat /tmp/router-vet.txt
GOOS=linux GOARCH=amd64 go build ./... > /tmp/router-build.txt 2>&1; echo "exit=$?"
cat /tmp/router-build.txt
```

Expected: `ok`, all six tests passing, vet silent, build exit 0. Paste the real
contents of those files — do not describe them.

- [ ] **Step 8: Commit**

```bash
git add services/fleet/agent/router.go services/fleet/agent/router_test.go services/fleet/agent/main.go
git commit -m "The node's router serves the edge proxy only

x-supersonic-slug is client-supplied and names any app on the node. That was
safe only while nothing could reach the port except the load balancer — and the
load balancer answers the open internet. desiredFor never reads apps.visibility,
so private apps are placed here like any other, which meant a request naming a
slug reached a placed app around the proxy's session check, decideAccess,
app_grants and workspace scoping.

An empty secret does not enforce, so this binary can reach a node before the
proxy that signs. The health path stays open above the gate: the load balancer's
check cannot carry a secret and failing it drains the only node in the backend.
The secret is stripped before proxying, because an app that learned it could
reach every other app on the node.

The comment at the top of this file claimed this refusal already existed. It did
not. Rewritten to describe the code."
```

---

### Task 3: The proxy signs the fleet and stops signing at it

**Files:**
- Create: `services/proxy/src/upstream.ts`
- Create: `services/proxy/src/upstream.test.ts`
- Modify: `services/proxy/src/forward.ts:35-37`

**Interfaces:**
- Consumes: `NewRouter`'s header name from Task 2 — `x-supersonic-edge`.
- Produces: `isCloudRunTarget(targetBase: string): boolean`, exported from `services/proxy/src/upstream.ts`.

One predicate, used in opposite directions. Cloud Run apps are sealed by IAM and
need the ID token; fleet nodes need the edge secret. Crossing them is the bug in
both directions: an ID token to a fleet node puts a Google-signed assertion of
our service account's identity on a plaintext public hop, and the edge secret to
a Cloud Run app hands it to a tenant.

- [ ] **Step 1: Write the failing test**

Create `services/proxy/src/upstream.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCloudRunTarget } from "./upstream";

test("a Cloud Run service URL is a Cloud Run target", () => {
  assert.equal(isCloudRunTarget("https://a8ebb-uyuwsbguuq-uc.a.run.app"), true);
});

test("the fleet load balancer is not", () => {
  assert.equal(isCloudRunTarget("http://8.232.255.172"), false);
});

test("a hostname that merely contains run.app is not", () => {
  // The check is on the hostname's suffix, not on the string anywhere in the URL.
  assert.equal(isCloudRunTarget("https://evil.run.app.attacker.com"), false);
});

test("a path containing run.app is not", () => {
  assert.equal(isCloudRunTarget("http://8.232.255.172/x.run.app"), false);
});

test("a malformed base is not a Cloud Run target", () => {
  // Refusing to parse must not mean "send the tenant our secret".
  assert.equal(isCloudRunTarget("not a url"), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd services/proxy && npm test > /tmp/upstream-test-1.txt 2>&1; echo "exit=$?"
cat /tmp/upstream-test-1.txt
```

Expected: FAIL — cannot find module `./upstream`.

- [ ] **Step 3: Write the implementation**

Create `services/proxy/src/upstream.ts`:

```ts
/**
 * Is this upstream one of our Cloud Run services, or a node in the fleet?
 *
 * Two credentials hang off the answer, in opposite directions, and crossing them
 * is a bug either way:
 *
 * - A sealed Cloud Run app needs an ID token in `x-serverless-authorization`.
 *   Sending one to a fleet node puts a Google-signed assertion of this service
 *   account's identity on a plaintext hop over the public internet, where it
 *   proves nothing and discloses something.
 * - A fleet node needs `x-supersonic-edge`, because its router trusts a
 *   client-supplied slug header and its load balancer answers the open internet.
 *   Sending that secret to a Cloud Run app hands it to a tenant, who could then
 *   reach every app on every node.
 *
 * The suffix is checked on the parsed hostname, never on the raw string: a URL
 * can carry `run.app` in its path or in a subdomain of somebody else's domain.
 * An unparseable base returns false, so the failure mode is "no secret sent"
 * rather than "secret sent to something we could not identify".
 */
export function isCloudRunTarget(targetBase: string): boolean {
  try {
    return new URL(targetBase).hostname.endsWith(".run.app");
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/proxy && npm test > /tmp/upstream-test-2.txt 2>&1; echo "exit=$?"
cat /tmp/upstream-test-2.txt
```

Expected: all five new tests pass, and every pre-existing test in
`services/proxy/src/*.test.ts` still passes. Paste the real output.

- [ ] **Step 5: Wire it into `forward.ts`**

In `services/proxy/src/forward.ts`, add to the imports at the top:

```ts
import { isCloudRunTarget } from "./upstream";
```

Then replace lines 35-37 — the `if (!process.env.SKIP_ID_TOKEN)` block — with:

```ts
  const cloudRun = isCloudRunTarget(targetBase);

  if (cloudRun && !process.env.SKIP_ID_TOKEN) {
    headers["x-serverless-authorization"] = `Bearer ${await idTokenFor(new URL(targetBase).origin)}`;
  }

  // The fleet's node router trusts `x-supersonic-slug` to name the app. That
  // trust used to rest on the port being unreachable, and it is not: the fleet
  // load balancer answers the open internet, so without this header anyone could
  // name any slug and reach a placed app around everything above — the session
  // check, decideAccess, app_grants, workspace scoping.
  //
  // Never to a Cloud Run target: that upstream is a tenant's app.
  if (!cloudRun && process.env.FLEET_EDGE_SECRET) {
    headers["x-supersonic-edge"] = process.env.FLEET_EDGE_SECRET;
  }
```

Leave the 13-line comment above it (`forward.ts:22-34`) in place — it explains
why the token goes in `x-serverless-authorization` rather than `Authorization`,
and that reasoning is unchanged.

- [ ] **Step 6: Run the full proxy suite and typecheck**

```bash
cd services/proxy && npm test > /tmp/proxy-test.txt 2>&1; echo "exit=$?"
cat /tmp/proxy-test.txt
npx tsc --noEmit > /tmp/proxy-tsc.txt 2>&1; echo "exit=$?"
cat /tmp/proxy-tsc.txt
```

Expected: all tests pass, tsc exit 0 with no output. Run these from
`services/proxy`, never the repo root.

- [ ] **Step 7: Commit**

```bash
git add services/proxy/src/upstream.ts services/proxy/src/upstream.test.ts services/proxy/src/forward.ts
git commit -m "One predicate decides which credential the upstream gets

The proxy was minting an ID token for every target, including the fleet load
balancer. Against a *.run.app host that token is the invoker credential a sealed
service requires; against 8.232.255.172 it is a Google-signed assertion of our
service account's identity, useless to the receiver and travelling in cleartext
over the public internet.

The same predicate carries the other credential the other way. The node's router
trusts x-supersonic-slug, and its load balancer is world-reachable, so the fleet
hop needs a secret the tenant must never see. isCloudRunTarget parses and checks
the hostname suffix rather than searching the string, because run.app can appear
in a path or in a subdomain of somebody else's domain; an unparseable base
returns false, so the failure mode is sending no secret rather than sending one
to an upstream we could not identify."
```

---

### Task 4: Turn it on, in the only order that is safe

No repository changes except the systemd unit. This is a rollout, and its order
is the whole point: at no moment may the proxy be sending a header the router
rejects, or the router requiring one the proxy does not send.

**Blocked on:** SSH to `fleet-lab-1`. The key at `~/.ssh/google_compute_engine`
has a forgotten passphrase and `enable-oslogin` is explicitly `FALSE` on the
instance, so the path is a regenerated key pushed to project metadata. Do that
first or none of this runs.

**Files:**
- Modify: `services/fleet/image/provision.sh` — the `supersonicd.service` unit at :341-365

**Interfaces:**
- Consumes: `NewRouter(rootDomain, edgeSecret)` from Task 2; `FLEET_EDGE_SECRET` from Task 3.
- Produces: nothing further depends on this.

- [ ] **Step 1: Fix SSH**

```bash
cd ~/.ssh && cp google_compute_engine google_compute_engine.bak-20260804 \
  && cp google_compute_engine.pub google_compute_engine.pub.bak-20260804 \
  && rm -f google_compute_engine google_compute_engine.pub \
  && ssh-keygen -t rsa -b 3072 -f ~/.ssh/google_compute_engine -N "" -C ilmak -q \
  && ssh-keygen -l -f ~/.ssh/google_compute_engine.pub
```

Then confirm it lets you in — gcloud pushes the new public key to project
metadata on first use:

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command "hostname; systemctl is-active supersonicd"
```

Expected: `fleet-lab-1` and `active`.

- [ ] **Step 2: Give the agent unit an environment file**

The `cloud-sql-proxy` unit already reads `/etc/supersonic/fleet.env`
(`provision.sh:314`); the agent unit does not. In
`services/fleet/image/provision.sh`, inside the `supersonicd.service` heredoc,
add one line immediately after `User=root`:

```
EnvironmentFile=-/etc/supersonic/fleet.env
```

The leading `-` means a missing file is not an error, which keeps `provision.sh`
runnable on a node that has never had one.

- [ ] **Step 3: Ship the agent with the gate OFF**

`FLEET_EDGE_SECRET` is not in `fleet.env` yet, so `NewRouter` gets `""` and
enforces nothing. Nothing changes for any request.

```bash
gcloud compute scp services/fleet/image/provision.sh fleet-lab-1:/tmp/ \
  --zone us-central1-a --project supersonic-deploy-prod
gcloud compute scp services/fleet/agent/*.go fleet-lab-1:/opt/agent/ \
  --zone us-central1-a --project supersonic-deploy-prod
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'sudo bash /tmp/provision.sh && sudo bash /tmp/restart-agent.sh'
```

- [ ] **Step 4: Prove nothing broke before going further**

```bash
curl -s -m 10 -o /dev/null -w "health %{http_code}\n" http://8.232.255.172/__fleet/healthz
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'systemctl is-active supersonicd; tail -n 20 /var/log/supersonicd.log'
```

Expected: `health 200`, `active`, and a router line reporting the same route
count as before. **If the health check is not 200, stop and roll back** — the
backend drains from here.

- [ ] **Step 5: Create the secret and give it to the proxy**

```bash
openssl rand -hex 32 | gcloud secrets create fleet-edge-secret \
  --project supersonic-deploy-prod --data-file=-
```

The value is never printed. `AUTH_SECRET` and `PG_PASSWORD` already reach the
proxy this way, so match them:

```bash
gcloud run services update supersonic-proxy --project supersonic-deploy-prod \
  --region us-central1 \
  --update-secrets FLEET_EDGE_SECRET=fleet-edge-secret:latest
```

The proxy now sends `x-supersonic-edge`; the router still ignores it. Both
halves are deployed and nothing is enforced. Confirm apps still serve:

```bash
curl -s -m 15 -o /dev/null -w "%{http_code}\n" https://<a-known-live-slug>.supersonic.cv/
```

- [ ] **Step 6: Turn enforcement on**

Read the secret onto the node without printing it, append it to `fleet.env`, and
restart:

```bash
gcloud secrets versions access latest --secret fleet-edge-secret \
  --project supersonic-deploy-prod > /tmp/edge.txt
gcloud compute scp /tmp/edge.txt fleet-lab-1:/tmp/edge.txt \
  --zone us-central1-a --project supersonic-deploy-prod
rm -f /tmp/edge.txt
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'sudo sh -c "printf \"FLEET_EDGE_SECRET=%s\n\" \"$(cat /tmp/edge.txt)\" >> /etc/supersonic/fleet.env; chmod 600 /etc/supersonic/fleet.env; rm -f /tmp/edge.txt; systemctl restart supersonicd"'
```

- [ ] **Step 7: Verify the door, both ways**

```bash
curl -s -m 10 -o /dev/null -w "health %{http_code}\n" http://8.232.255.172/__fleet/healthz
curl -s -m 10 -o /dev/null -D - -H "x-supersonic-slug: <a-placed-slug>" http://8.232.255.172/ | grep -i "HTTP/\|X-Supersonic-Router"
curl -s -m 15 -o /dev/null -w "through the proxy %{http_code}\n" https://<a-placed-slug>.supersonic.cv/
```

Expected, in order: `health 200`; `403` with `X-Supersonic-Router: unsigned`; and
a normal status through the real hostname. The middle line is the gap closing —
it is the exact request that reached a placed app before this task.

**Rollback if anything is wrong:** delete the `FLEET_EDGE_SECRET` line from
`/etc/supersonic/fleet.env` and `systemctl restart supersonicd`. Enforcement is
off again in seconds and the proxy's extra header is ignored.

- [ ] **Step 8: Commit the unit change**

```bash
git add services/fleet/image/provision.sh
git commit -m "The agent unit reads the same environment file the proxy unit does

FLEET_EDGE_SECRET has to reach supersonicd, and the only environment file on the
node was wired to cloud-sql-proxy alone. EnvironmentFile=- so a node that has
never had the file still provisions."
```

---

### Task 5: A comment that denies support the code has

**Files:**
- Modify: `apps/web/lib/build-config.ts:100-108`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Independent of every other task; it is here because it cost a reader a wrong conclusion during the research for this phase.

The doc block on `BuildInputs` says `runnerPrepareConfig` "is the only build
config in this repo that ever mounted a secret". It is not.
`buildkitBuildConfig` stages secrets to `/tmp` and passes
`--secret id=<key>,src=...` to `docker buildx build`
(`build-config.ts:284-295`), lists them in the step's `secretEnv` (:315) and
mounts them through `availableSecrets` (:319). Production runs
`BUILDER=buildkit` (`cloudbuild.yaml:145`), so that is the path a container-lane
build takes today. The comment predates its own file's support for the feature.

- [ ] **Step 1: Replace the stale paragraph**

In `apps/web/lib/build-config.ts`, replace lines 100-108 — from "`runnerPrepareConfig` is the only build config" through "regresses the largest language on the platform." — with:

```
 * Two build configs mount secrets: `buildkitBuildConfig`, which is the path
 * production takes (`BUILDER=buildkit`), and `runnerPrepareConfig`, which is
 * being deleted. `kanikoBuildConfig` refuses them by throwing, and
 * `cachedBuildConfig` upgrades a secret-needing build to buildkit rather than
 * failing. `static-build.ts` has no secret support at all.
 *
 * Why a build may need one is written down at runnerPrepareConfig's call site:
 * Prisma 7 evaluates `env('DATABASE_URL')` while loading prisma.config.js on
 * EVERY cli command, so `prisma generate` died on an app whose database the
 * platform had just provisioned. That is the requirement the runner's deletion
 * must not drop — and it does not, because buildkit already carries it.
```

- [ ] **Step 2: Typecheck and run the affected suite**

```bash
cd apps/web && npx tsc --noEmit > /tmp/web-tsc.txt 2>&1; echo "exit=$?"
cat /tmp/web-tsc.txt
node --import tsx --test test/build-config.test.ts > /tmp/build-config-test.txt 2>&1; echo "exit=$?"
cat /tmp/build-config-test.txt
```

Expected: tsc exit 0 with no output, tests pass. Run from `apps/web` — at the
repo root `npx tsc` resolves to an unrelated package and exits 1 with "This is
not the tsc command you are looking for", which reads exactly like a broken
typecheck.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/build-config.ts
git commit -m "Build secrets are not the runner's alone, and have not been for a while

The doc block said runnerPrepareConfig was the only config that ever mounted a
secret. buildkitBuildConfig mounts them too, and BUILDER=buildkit is what
production runs, so it is the path a container-lane build takes today. The
comment described the state before its own file grew the support.

It cost something: a reader researching the runner's deletion concluded from
this paragraph that deleting the lane would regress every app needing a
build-time secret, which is false and would have bought a builder nobody needs."
```

---

## Self-Review

**Spec coverage.** Phase 0 of `2026-08-04-off-cloud-run-design.md` has four
items. "The fleet load balancer has no authentication" → Tasks 2 and 4.
"`FLEET_APPS` is armed against a node nobody has checked" → Task 1. "The proxy
sends a signed identity assertion over the public internet" → Task 3. "Two
comments that are false" → Task 2 Step 6 (`router.go`) and Task 5
(`build-config.ts`). No gaps.

**Placeholder scan.** Two placeholders remain and both are deliberate:
`<a-known-live-slug>` and `<a-placed-slug>` in Task 4. They cannot be resolved
from the repository — the set of apps on the node lives in `fleet_placements` in
Postgres or in `/srv/state/routes.json` on the node, and neither is readable
until Task 4 Step 1 restores SSH. Read one from
`/srv/state/routes.json` at that point and use it for both.

**Type consistency.** `NewRouter(rootDomain, edgeSecret string)` is defined in
Task 2 Step 3 and called in Task 2 Step 5 and Task 4 Step 2's env plumbing.
`isCloudRunTarget(targetBase: string): boolean` is defined in Task 3 Step 3 and
used in Step 5. The header is `x-supersonic-edge` in Task 2 Steps 1, 4 and Task 3
Step 5. The env var is `FLEET_EDGE_SECRET` in Task 2 Step 5, Task 3 Step 5, and
Task 4 Steps 5-6. The refusal marker is `unsigned` in Task 2 Steps 1 and 4 and
Task 4 Step 7.

**One risk this plan does not remove.** Task 4 Step 6 writes the secret to a file
on the node. Anything that can read `/etc/supersonic/fleet.env` as root can
replay it, and so can anything that can read the proxy's environment. That is the
same exposure `FLEET_TOKEN` already has, and the real fix for both is a GCE
instance identity token — named in the spec, not in this phase.
