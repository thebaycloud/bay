# A deploy path for the fleet agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merged change to `services/fleet/agent` reaches every node automatically, without taking the apps on that node down.

**Architecture:** CI builds a static linux/amd64 binary, stamps it with the commit sha, uploads it to GCS under its own content hash, and writes a pointer naming the current one — the same release-pointer shape `lib/static-release.ts` already uses for static sites. Each node runs a small bash updater on a systemd timer: read the pointer, download if it names something we do not have, verify the checksum, smoke-test the new binary, keep the old one, swap, restart, and roll back if the agent does not come back healthy. The agent reports its version on the sync it already sends, so what is actually deployed is visible rather than assumed.

**Tech Stack:** Go 1.25 (single package `github.com/supersonic/fleet/agent`), GitHub Actions with the Workload Identity Federation provider the other two workflows already use, GCS, systemd timer, bash.

## Global Constraints

- **A restart must not be an outage.** The systemd unit already carries `KillMode=process`, and `Runtime.Adoptable()` takes back sandboxes that outlived the previous agent — but only on an exact match of image and declared command. Nothing in this plan may kill sandboxes.
- **`services/fleet/bench/restart-agent.sh` is destructive by design** and must never become the deploy mechanism: it kills every runsc container, unmounts `/srv/state/bundles`, and deletes `routes.json` and every `ss-*` namespace. It stays as a recovery tool.
- **Every process match in a shell script is `-x` (exact comm), never `-f`.** `pkill -f supersonicd` issued over ssh matches the ssh command's own command line and kills the shell running it. This cost three dropped sessions.
- Go module is `github.com/supersonic/fleet/agent`, one package, `go 1.25`. Run tests with `go test ./...` from `services/fleet/agent`.
- The GCS bucket is `supersonic-static-assets` (`ASSETS_BUCKET`, `apps/web/lib/static-release.ts:12`).
- CI authenticates as `supersonic-deployer@supersonic-deploy-prod.iam.gserviceaccount.com` through `projects/540236122367/locations/global/workloadIdentityPools/github/providers/github-oidc`. No service-account key exists in this repository.
- Never `--set-env-vars` on any Cloud Run deploy; only `--update-env-vars`.
- `main` is shared and every push to it deploys production. Work on a branch; do not push without being asked.
- Migrations in `apps/web/db/` are additive and idempotent, applied in filename order. **019 is duplicated and 021 is taken** — the next free number is 022.

---

### Task 1: The agent knows its own version

Nothing in the agent reports which build it is. That is why `fleet-pull` and `fleet-boot` have zero rows and nobody noticed: the node was running an older binary than `main`, and there was no way to see it. The updater in Task 4 also needs a smoke test that proves a downloaded file is a working agent before it replaces the running one.

**Files:**
- Create: `services/fleet/agent/version.go`
- Create: `services/fleet/agent/version_test.go`
- Modify: `services/fleet/agent/main.go:617-624` (the flag block in `main`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Version string` (package-level var, stamped at build time), `versionLine() string`. Task 2 reads `Version`. Task 4 runs `supersonicd -version` and matches its output.

- [ ] **Step 1: Write the failing test**

Create `services/fleet/agent/version_test.go`:

```go
package main

import "testing"

// The default matters: an unstamped build must be obviously unstamped rather
// than claiming a version it does not have.
func TestVersionDefaultsToDev(t *testing.T) {
	if Version != "dev" {
		t.Fatalf("unstamped build should report dev, got %q", Version)
	}
}

// The updater greps this line to decide whether a downloaded file is a working
// agent, so its shape is an interface and not a log message.
func TestVersionLineCarriesTheVersion(t *testing.T) {
	old := Version
	defer func() { Version = old }()

	Version = "abc1234"
	if got, want := versionLine(), "supersonicd abc1234"; got != want {
		t.Fatalf("versionLine() = %q, want %q", got, want)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/fleet/agent && go test ./... -run TestVersion -v
```

Expected: FAIL — `undefined: Version`, `undefined: versionLine`.

- [ ] **Step 3: Write the implementation**

Create `services/fleet/agent/version.go`:

```go
package main

// Version is stamped at build time with
//
//	-ldflags "-X main.Version=<commit sha>"
//
// It defaults to "dev" so that a binary built by hand says so. An unstamped
// build claiming a real version would be worse than useless: the whole point of
// this field is to tell a node running last week's agent from one running main,
// and a confident wrong answer there is what this is being added to end.
var Version = "dev"

// versionLine is what `supersonicd -version` prints.
//
// The shape is an interface, not a log line: the updater (image/update-agent.sh)
// runs the freshly downloaded binary with -version and refuses to install
// anything that does not answer in this form. That check is the only thing
// standing between a truncated download and a node with no agent.
func versionLine() string { return "supersonicd " + Version }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd services/fleet/agent && go test ./... -run TestVersion -v
```

Expected: PASS, both tests.

- [ ] **Step 5: Add the `-version` flag to main**

In `services/fleet/agent/main.go`, inside `main()`, the flag block currently reads:

```go
	var (
		addr       = flag.String("addr", "127.0.0.1:9900", "status and control API address")
		routerAddr = flag.String("router", ":8080", "app traffic address (behind the load balancer)")
		rootDomain = flag.String("domain", "supersonic.cv", "wildcard domain apps are served under")
		interval   = flag.Duration("interval", 10*time.Second, "reconcile interval")
	)
	flag.Parse()
```

Replace it with:

```go
	var (
		addr       = flag.String("addr", "127.0.0.1:9900", "status and control API address")
		routerAddr = flag.String("router", ":8080", "app traffic address (behind the load balancer)")
		rootDomain = flag.String("domain", "supersonic.cv", "wildcard domain apps are served under")
		interval   = flag.Duration("interval", 10*time.Second, "reconcile interval")
		showVer    = flag.Bool("version", false, "print the build version and exit")
	)
	flag.Parse()

	// Before anything else touches the machine. The updater runs this on a
	// freshly downloaded binary to prove it executes at all, and that check has
	// to be free of side effects: no state directory, no bridge, no containerd.
	if *showVer {
		fmt.Println(versionLine())
		return
	}
```

`fmt` is already imported in `main.go`; no import change is needed.

- [ ] **Step 6: Verify the flag works and the build is stampable**

```bash
cd services/fleet/agent
go build -o /tmp/supersonicd-test . && /tmp/supersonicd-test -version
```

Expected: `supersonicd dev`

```bash
go build -ldflags "-X main.Version=abc1234" -o /tmp/supersonicd-test . && /tmp/supersonicd-test -version
```

Expected: `supersonicd abc1234`

```bash
rm -f /tmp/supersonicd-test
```

- [ ] **Step 7: Run the whole suite**

```bash
cd services/fleet/agent && go test ./...
```

Expected: `ok  github.com/supersonic/fleet/agent`

- [ ] **Step 8: Commit**

```bash
git add services/fleet/agent/version.go services/fleet/agent/version_test.go services/fleet/agent/main.go
git commit -m "fleet agent: it can say which build it is"
```

---

### Task 2: The version reaches the control plane

A version the node knows and nobody can see answers nothing. It travels on the sync that already runs every ten seconds, is stored on `fleet_nodes`, and is shown on the admin fleet page — so "is this node running main?" becomes a question with an answer.

**Files:**
- Modify: `services/fleet/agent/desired.go:152` (`syncBody`)
- Modify: `services/fleet/agent/desired_test.go`
- Create: `apps/web/db/022_node_agent_version.sql`
- Modify: `apps/web/lib/fleet.ts` (`NodeReport`, `heartbeatNode`, `FleetNodeRow`)
- Create: `apps/web/test/fleet-heartbeat.test.ts`
- Modify: `apps/web/app/admin/fleet/page.tsx:132` area
- Modify: `apps/web/app/api/fleet/sync/route.ts` (pass the field through)

**Interfaces:**
- Consumes: `Version` from Task 1.
- Produces: `heartbeatSql(n: NodeReport)` in `apps/web/lib/fleet.ts`, returning `{ text: string; values: unknown[] }`. Nothing later in this plan consumes it; it exists so the write is testable without a database, matching `buildStartSql` in `apps/web/lib/builds.ts`.

- [ ] **Step 1: Write the failing Go test**

Append to `services/fleet/agent/desired_test.go`:

```go
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
```

If `encoding/json` or `strings` are not already imported in that file, add them.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd services/fleet/agent && go test ./... -run TestSyncBodyCarries -v
```

Expected: FAIL — `unknown field Version in struct literal of type syncBody`.

- [ ] **Step 3: Add the field to syncBody**

In `services/fleet/agent/desired.go`, inside `type syncBody struct`, add:

```go
	// Version is which build of this agent is speaking.
	//
	// Absent from an older agent, which is why it is omitempty rather than a
	// required field: a rolling update must not make every not-yet-updated node
	// look broken. The control plane stores null for those and the admin page
	// shows them as unknown, which is the honest rendering of "this node has not
	// told us".
	Version string `json:"version,omitempty"`
```

Then find where `syncBody` is constructed in `Fetch` and set `Version: Version` on it.

- [ ] **Step 4: Run it to verify it passes**

```bash
cd services/fleet/agent && go test ./...
```

Expected: `ok`

- [ ] **Step 5: Write the migration**

Create `apps/web/db/022_node_agent_version.sql`:

```sql
-- Which build of the agent a node is running.
--
-- Nothing recorded this, and the cost was concrete: `fleet-pull` and
-- `fleet-boot` were built on both sides, merged, and wrote zero rows, because
-- fleet-lab-1 was running an older agent and nothing could say so. The
-- instrumentation looked broken; the deploy path was.
--
-- Nullable with no backfill, deliberately. Null means "this node has not told
-- us" — an agent built before the field existed sends nothing — and that is a
-- different fact from any version string we could invent for it.
ALTER TABLE fleet_nodes ADD COLUMN IF NOT EXISTS agent_version text;
```

- [ ] **Step 6: Write the failing TypeScript test**

Create `apps/web/test/fleet-heartbeat.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatSql } from "@/lib/fleet";

test("the heartbeat carries the agent version", () => {
  const q = heartbeatSql({
    name: "n1", zone: "us-central1-a", internalIp: "10.0.0.1",
    memoryBytes: 1, cpus: 2, agentVersion: "abc1234",
  });
  assert.ok(q.text.includes("agent_version"));
  assert.equal(q.values[5], "abc1234");
});

// An older agent sends nothing, and nothing must not be read as a version.
// Overwriting a stored version with null on every heartbeat from a not-yet-
// updated node would make a rolling update look like a fleet-wide regression.
test("an agent that does not report leaves the stored version alone", () => {
  const q = heartbeatSql({
    name: "n1", zone: "us-central1-a", internalIp: "10.0.0.1",
    memoryBytes: 1, cpus: 2,
  });
  assert.equal(q.values[5], null);
  assert.ok(
    /agent_version = COALESCE\(EXCLUDED\.agent_version, fleet_nodes\.agent_version\)/.test(q.text),
    "an absent version must not clear the stored one",
  );
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd apps/web && node --import tsx --test test/fleet-heartbeat.test.ts
```

Expected: FAIL — `heartbeatSql` is not exported from `@/lib/fleet`.

- [ ] **Step 8: Split the SQL out and add the column**

In `apps/web/lib/fleet.ts`, add `agentVersion` to the `NodeReport` interface:

```ts
  /** Which build of the agent is speaking. Absent from an agent too old to say. */
  agentVersion?: string;
```

Then replace the body of `heartbeatNode` with a call to a new exported function, following the pattern `buildStartSql` established in `lib/builds.ts` — "split out from the write so the normalisation is testable without a database":

```ts
/**
 * The heartbeat write, as a query rather than as an effect.
 *
 * Separated so the one rule that is easy to get wrong can be tested without a
 * database: an agent that does not report a version must not clear the stored
 * one. `EXCLUDED.agent_version` is null for such an agent, and a plain
 * assignment would blank the column on every one of its heartbeats — so a
 * rolling agent update would read as the whole fleet losing its version.
 */
export function heartbeatSql(n: NodeReport) {
  return {
    text: `INSERT INTO fleet_nodes(name, zone, internal_ip, memory_bytes, cpus, agent_version, last_seen)
             VALUES($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (name) DO UPDATE SET
             zone = EXCLUDED.zone,
             internal_ip = EXCLUDED.internal_ip,
             memory_bytes = EXCLUDED.memory_bytes,
             cpus = EXCLUDED.cpus,
             agent_version = COALESCE(EXCLUDED.agent_version, fleet_nodes.agent_version),
             last_seen = now()`,
    values: [n.name, n.zone, n.internalIp, n.memoryBytes, n.cpus, n.agentVersion ?? null],
  };
}

export async function heartbeatNode(n: NodeReport): Promise<void> {
  const q = heartbeatSql(n);
  await getPool(DB).query(q.text, q.values);
}
```

Add `agent_version: string | null;` to the `FleetNodeRow` interface, and include `agent_version` in the `SELECT` inside `listNodes`.

- [ ] **Step 9: Run it to verify it passes**

```bash
cd apps/web && node --import tsx --test test/fleet-heartbeat.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 10: Pass the field through the route**

In `apps/web/app/api/fleet/sync/route.ts`, the `heartbeatNode` call currently passes five fields. Add the sixth:

```ts
    await heartbeatNode({
      name,
      zone,
      internalIp,
      memoryBytes: Number(body.memoryBytes ?? 0),
      cpus: Number(body.cpus ?? 0),
      // Only when the node said. `undefined` means "this agent does not report",
      // which heartbeatSql turns into a COALESCE that leaves the stored value be.
      agentVersion: typeof body.version === "string" && body.version ? body.version : undefined,
    });
```

`body` is typed as `Partial<NodeReport> & { processes?: unknown; running?: unknown }`; widen it to also allow `version?: unknown`.

- [ ] **Step 11: Show it on the admin page**

In `apps/web/app/admin/fleet/page.tsx`, the node row renders `n.drain ? \`${n.freshness} · draining\` : n.freshness`. Add the version beside it, rendering an absent one as `unknown` rather than blank — blank reads as a rendering bug, `unknown` reads as the fact it is:

```tsx
{n.agent_version ?? "unknown"}
```

- [ ] **Step 12: Typecheck and run the suites**

```bash
cd apps/web && npx tsc --noEmit && npm test
cd ../../services/fleet/agent && go test ./...
```

Expected: no type errors; both suites green.

- [ ] **Step 13: Commit**

```bash
git add services/fleet/agent/desired.go services/fleet/agent/desired_test.go \
        apps/web/db/022_node_agent_version.sql apps/web/lib/fleet.ts \
        apps/web/test/fleet-heartbeat.test.ts apps/web/app/api/fleet/sync/route.ts \
        apps/web/app/admin/fleet/page.tsx
git commit -m "fleet: a node says which agent it runs, and we keep the answer"
```

---

### Task 3: CI builds and publishes the binary

**Files:**
- Create: `.github/workflows/publish-agent.yml`

**Interfaces:**
- Consumes: the `-ldflags "-X main.Version=…"` stamp from Task 1.
- Produces: two objects in GCS that Task 4 reads:
  - `gs://supersonic-static-assets/agent/<sha256>/supersonicd` — the binary
  - `gs://supersonic-static-assets/agent/current` — a two-line pointer: line 1 is the sha256 of the binary, line 2 is the git commit sha.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/publish-agent.yml`:

```yaml
# Push to main → the fleet agent is built and published for the nodes to collect.
#
# The agent is the last component with no deploy path. It has been updated by
# copying .go files to each node and building there, which means "merged" and
# "running" have been different questions for as long as it has existed —
# ADR 0002 routed the room around that gap a year ago, and the fleet-pull and
# fleet-boot stages shipped, wrote zero rows, and looked like broken
# instrumentation because of it.
#
# This publishes. Collection is the node's job (image/update-agent.sh), on the
# same pull-not-push principle as desired state: nothing reaches into a node.
name: Publish fleet agent

on:
  push:
    branches: [main]
    paths:
      - "services/fleet/agent/**"
      - ".github/workflows/publish-agent.yml"
  workflow_dispatch:

# Never two publishes at once. The pointer is a single object and the last
# writer wins; two concurrent runs could leave it naming the older build.
concurrency:
  group: publish-agent
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write # required to mint the OIDC token; without it auth fails

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.25"
          cache-dependency-path: services/fleet/agent/go.sum

      # The agent's own tests gate the release. They are fast and they cover the
      # reconcile loop, adoption and the backoff trackers — the three things a
      # bad agent breaks quietly rather than loudly.
      - name: Test
        working-directory: services/fleet/agent
        run: go test ./...

      # CGO off and a static binary, because the node it lands on is not this
      # runner and must not need a matching libc.
      - name: Build
        working-directory: services/fleet/agent
        env:
          CGO_ENABLED: "0"
          GOOS: linux
          GOARCH: amd64
        run: |
          set -euo pipefail
          go build -trimpath -ldflags "-s -w -X main.Version=${GITHUB_SHA::7}" -o supersonicd .
          ./supersonicd -version || { echo "the binary does not run"; exit 1; }

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: projects/540236122367/locations/global/workloadIdentityPools/github/providers/github-oidc
          service_account: supersonic-deployer@supersonic-deploy-prod.iam.gserviceaccount.com

      - uses: google-github-actions/setup-gcloud@v2

      # Content-addressed, then the pointer. In that order and never the reverse:
      # a pointer naming an object that is not there yet is a node that downloads
      # a 404 and, if the updater were less careful, installs it.
      - name: Publish
        working-directory: services/fleet/agent
        run: |
          set -euo pipefail
          DIGEST="$(sha256sum supersonicd | cut -d' ' -f1)"
          echo "sha256 $DIGEST"

          gcloud storage cp supersonicd \
            "gs://supersonic-static-assets/agent/$DIGEST/supersonicd" \
            --project supersonic-deploy-prod

          printf '%s\n%s\n' "$DIGEST" "$GITHUB_SHA" > current
          gcloud storage cp current \
            "gs://supersonic-static-assets/agent/current" \
            --cache-control="no-cache" \
            --project supersonic-deploy-prod

      # Read back what was published rather than trusting that the upload
      # returned zero. The same reasoning as assertReleaseUploaded on the static
      # lane: an exit code says the step ran, not that it published.
      - name: Check the published binary matches what was built
        working-directory: services/fleet/agent
        run: |
          set -euo pipefail
          DIGEST="$(sha256sum supersonicd | cut -d' ' -f1)"
          gcloud storage cat "gs://supersonic-static-assets/agent/current" > published
          head -1 published | grep -qx "$DIGEST" || {
            echo "the pointer does not name the binary just built"; cat published; exit 1; }

          gcloud storage cp "gs://supersonic-static-assets/agent/$DIGEST/supersonicd" \
            downloaded --project supersonic-deploy-prod
          echo "$DIGEST  downloaded" | sha256sum -c -
```

- [ ] **Step 2: Verify the workflow parses**

```bash
cd ~/projects/supersonic && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish-agent.yml')); print('valid yaml')"
```

Expected: `valid yaml`

- [ ] **Step 3: Verify the build command works locally**

This is the exact command the workflow runs, so a failure here is a failure there:

```bash
cd services/fleet/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.Version=deadbee" -o /tmp/supersonicd-ci .
file /tmp/supersonicd-ci
```

Expected: `ELF 64-bit LSB executable, x86-64 … statically linked`

```bash
rm -f /tmp/supersonicd-ci
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish-agent.yml
git commit -m "CI: build and publish the fleet agent on a push to main"
```

---

### Task 4: The updater on the node

**Files:**
- Create: `services/fleet/image/update-agent.sh`
- Create: `services/fleet/image/update-agent.test.sh`

**Interfaces:**
- Consumes: the two GCS objects from Task 3, and `supersonicd -version` from Task 1.
- Produces: `/opt/agent/supersonicd` (the running binary), `/opt/agent/supersonicd.previous` (the one before it), `/opt/agent/installed.sha256` (what is installed, so a check costs no download).
- Seams for the test: `AGENT_BASE` (default `gs://supersonic-static-assets/agent`), `AGENT_FETCH` (default `gcloud storage cp`), `AGENT_DIR` (default `/opt/agent`), `AGENT_RESTART` (default `systemctl restart supersonicd`), `AGENT_HEALTH_URL` (default `http://127.0.0.1:9900/status`).

- [ ] **Step 1: Write the failing test**

Create `services/fleet/image/update-agent.test.sh`:

```bash
#!/usr/bin/env bash
# Runs update-agent.sh against a local directory standing in for the bucket.
#
# `AGENT_FETCH` defaults to `gcloud storage cp` and the test sets it to `cp`,
# which takes the same two arguments in the same order — so the code under test
# is the code that runs in production, with one word swapped.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  want: $3"; echo "  got:  $2"; fi; }

setup() {
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/bucket" "$ROOT/opt"
  # A stand-in agent: it answers -version and nothing else.
  printf '#!/bin/sh\n[ "$1" = "-version" ] && echo "supersonicd %s"\n' "$1" > "$ROOT/new"
  chmod +x "$ROOT/new"
  D="$(sha256sum "$ROOT/new" | cut -d" " -f1)"
  mkdir -p "$ROOT/bucket/$D"
  cp "$ROOT/new" "$ROOT/bucket/$D/supersonicd"
  printf '%s\ncommitsha\n' "$D" > "$ROOT/bucket/current"
  export AGENT_BASE="$ROOT/bucket" AGENT_FETCH="cp" AGENT_DIR="$ROOT/opt" \
         AGENT_RESTART="true" AGENT_HEALTH_URL=""
}

# 1. A node with no agent installs one.
setup v1
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "installs when absent" "$(cat "$ROOT/opt/supersonicd" | head -1)" "#!/bin/sh"
check "records what it installed" "$(cat "$ROOT/opt/installed.sha256")" "$D"

# 2. Running it again changes nothing and says so.
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "second run is a no-op" "$(echo "$out" | grep -c 'already current')" "1"

# 3. A new publish is picked up, and the old binary is kept.
OLD_D="$D"
setup v2
printf '#!/bin/sh\n[ "$1" = "-version" ] && echo "supersonicd v1"\n' > "$ROOT/opt/supersonicd"
chmod +x "$ROOT/opt/supersonicd"
echo "$OLD_D" > "$ROOT/opt/installed.sha256"
out="$(bash "$HERE/update-agent.sh" 2>&1)"
check "upgrades to the new digest" "$(cat "$ROOT/opt/installed.sha256")" "$D"
check "keeps the previous binary" "$([ -x "$ROOT/opt/supersonicd.previous" ] && echo yes)" "yes"

# 4. A corrupt download is refused and the running agent is untouched.
setup v3
printf '#!/bin/sh\necho old\n' > "$ROOT/opt/supersonicd"; chmod +x "$ROOT/opt/supersonicd"
echo "notthedigest" > "$ROOT/opt/installed.sha256"
echo "corrupted" > "$ROOT/bucket/$D/supersonicd"
out="$(bash "$HERE/update-agent.sh" 2>&1)"; rc=$?
check "refuses a checksum mismatch" "$rc" "1"
check "leaves the running binary alone" "$(sh "$ROOT/opt/supersonicd")" "old"

# 5. A binary that does not run is refused before it replaces anything.
setup v4
printf '#!/bin/sh\necho old\n' > "$ROOT/opt/supersonicd"; chmod +x "$ROOT/opt/supersonicd"
echo "notthedigest" > "$ROOT/opt/installed.sha256"
printf 'not an executable' > "$ROOT/bucket/current.tmp"
D2="$(sha256sum "$ROOT/bucket/current.tmp" | cut -d" " -f1)"
mkdir -p "$ROOT/bucket/$D2"; cp "$ROOT/bucket/current.tmp" "$ROOT/bucket/$D2/supersonicd"
printf '%s\ncommitsha\n' "$D2" > "$ROOT/bucket/current"
out="$(bash "$HERE/update-agent.sh" 2>&1)"; rc=$?
check "refuses a binary that will not run" "$rc" "1"
check "still leaves the running binary alone" "$(sh "$ROOT/opt/supersonicd")" "old"

echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
```

```bash
chmod +x services/fleet/image/update-agent.test.sh
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/projects/supersonic && bash services/fleet/image/update-agent.test.sh
```

Expected: FAIL — `update-agent.sh: No such file or directory`.

- [ ] **Step 3: Write the updater**

Create `services/fleet/image/update-agent.sh`:

```bash
#!/usr/bin/env bash
# Collect the current fleet agent, if it is not the one already installed.
#
# PULL, NOT PUSH, and for the same reason the agent pulls its desired state:
# nothing reaches into a node. A node that was unreachable during a release
# collects it on its next tick instead of missing it, and CI needs no route to
# any machine.
#
# WHY THIS DOES NOT KILL ANYTHING
#
# The systemd unit carries KillMode=process, so restarting the agent leaves its
# sandboxes running, and Runtime.Adoptable() takes them back on the next start —
# on an exact match of image and declared command, so a sandbox that should have
# changed is still replaced. That property is why an agent update can be routine.
#
# services/fleet/bench/restart-agent.sh does the opposite ON PURPOSE: it kills
# every runsc container, unmounts the bundles and deletes routes.json. It is the
# recovery tool for a node in a bad state. It must never be the deploy path, and
# this script exists so it no longer has to be.
set -uo pipefail

BASE="${AGENT_BASE:-gs://supersonic-static-assets/agent}"
FETCH="${AGENT_FETCH:-gcloud storage cp}"
DIR="${AGENT_DIR:-/opt/agent}"
RESTART="${AGENT_RESTART:-systemctl restart supersonicd}"
HEALTH="${AGENT_HEALTH_URL-http://127.0.0.1:9900/status}"

log() { echo "update-agent: $*"; }

mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. What should be running.
if ! $FETCH "$BASE/current" "$TMP/current" >/dev/null 2>&1; then
  log "could not read the pointer at $BASE/current — leaving this node alone"
  exit 1
fi
WANT="$(head -1 "$TMP/current" | tr -d '[:space:]')"
COMMIT="$(sed -n 2p "$TMP/current" | tr -d '[:space:]')"
if ! printf '%s' "$WANT" | grep -Eqx '[0-9a-f]{64}'; then
  log "the pointer does not name a sha256 ($WANT) — refusing"
  exit 1
fi

# 2. What is running. A missing record counts as nothing installed, which is
#    correct on a fresh node and harmless on one that lost the file: the digest
#    check below makes a redundant download idempotent rather than wrong.
HAVE="$(cat "$DIR/installed.sha256" 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$WANT" = "$HAVE" ] && [ -x "$DIR/supersonicd" ]; then
  log "already current ($WANT, commit ${COMMIT:-unknown})"
  exit 0
fi

log "want $WANT (commit ${COMMIT:-unknown}), have ${HAVE:-none}"

# 3. Fetch it.
if ! $FETCH "$BASE/$WANT/supersonicd" "$TMP/supersonicd" >/dev/null 2>&1; then
  log "could not fetch the binary — leaving this node alone"
  exit 1
fi

# 4. Prove it is what the pointer named. A truncated download is the ordinary
#    failure here, not an exotic one, and it produces a file that exists.
GOT="$(sha256sum "$TMP/supersonicd" | cut -d' ' -f1)"
if [ "$GOT" != "$WANT" ]; then
  log "checksum mismatch: got $GOT, wanted $WANT — refusing"
  exit 1
fi

# 5. Prove it runs at all, before it replaces something that does. This is the
#    only check between a bad build and a node with no agent, and it is cheap:
#    -version touches no state, no bridge and no containerd.
chmod +x "$TMP/supersonicd"
if ! "$TMP/supersonicd" -version 2>/dev/null | grep -q '^supersonicd '; then
  log "the downloaded binary does not answer -version — refusing"
  exit 1
fi

# 6. Swap, keeping the one that was working. Same filesystem, so the move is
#    atomic and there is no window where /opt/agent/supersonicd is absent.
[ -f "$DIR/supersonicd" ] && cp -f "$DIR/supersonicd" "$DIR/supersonicd.previous"
mv -f "$TMP/supersonicd" "$DIR/supersonicd.new"
mv -f "$DIR/supersonicd.new" "$DIR/supersonicd"
echo "$WANT" > "$DIR/installed.sha256"
log "installed $("$DIR/supersonicd" -version)"

# 7. Restart, then check it came back. systemd's Restart=always will keep
#    relaunching a broken agent forever, which looks like a running service and
#    is not one — so health is asked of the agent, not of systemd.
$RESTART || { log "restart failed"; exit 1; }

if [ -n "$HEALTH" ]; then
  ok=0
  for _ in $(seq 1 20); do
    sleep 1
    if curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
  done
  if [ "$ok" != "1" ]; then
    log "the new agent did not answer $HEALTH within 20s — rolling back"
    if [ -f "$DIR/supersonicd.previous" ]; then
      mv -f "$DIR/supersonicd.previous" "$DIR/supersonicd"
      echo "${HAVE:-}" > "$DIR/installed.sha256"
      $RESTART || true
      log "rolled back to the previous binary"
    else
      log "no previous binary to roll back to — this node needs a human"
    fi
    exit 1
  fi
fi

log "up on $WANT (commit ${COMMIT:-unknown})"
```

```bash
chmod +x services/fleet/image/update-agent.sh
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ~/projects/supersonic && bash services/fleet/image/update-agent.test.sh
```

Expected: `passed 9, failed 0`

- [ ] **Step 5: Commit**

```bash
git add services/fleet/image/update-agent.sh services/fleet/image/update-agent.test.sh
git commit -m "fleet: a node can collect the agent it is meant to run"
```

---

### Task 5: Put the updater on a timer, and retire the destructive path

**Files:**
- Modify: `services/fleet/image/provision.sh` (after the `7b. The agent` block, before `8. Kernel and cgroup posture`)
- Modify: `services/fleet/bench/restart-agent.sh` (header comment only)
- Modify: `services/fleet/README.md`

**Interfaces:**
- Consumes: `services/fleet/image/update-agent.sh` from Task 4.
- Produces: `supersonic-update-agent.service` and `supersonic-update-agent.timer` on every provisioned node.

- [ ] **Step 1: Add the timer to provision.sh**

In `services/fleet/image/provision.sh`, immediately after `systemctl enable supersonicd >/dev/null 2>&1 || true` and before the `# 8. Kernel and cgroup posture` banner, insert:

```bash
# ---------------------------------------------------------------------------
# 7c. Collecting the agent
#
# The agent was the last component with no deploy path: it was updated by
# copying .go files to a node and building there, so "merged" and "running" were
# different questions. It cost the fleet-pull and fleet-boot stages, which
# shipped, wrote zero rows, and looked like broken instrumentation.
#
# The updater PULLS, like everything else here. A node unreachable during a
# release collects it on the next tick rather than missing it, and CI needs no
# route to any machine.
#
# Two minutes, with a randomised delay: without the jitter every node in a site
# would fetch the same object at the same second, which is a self-inflicted
# thundering herd for no gain — nothing here is urgent to the second.
# ---------------------------------------------------------------------------

log "installing the agent updater"
install -m 0755 "$(dirname "$0")/update-agent.sh" /usr/local/bin/supersonic-update-agent 2>/dev/null \
  || log "update-agent.sh not beside provision.sh; copy it to /usr/local/bin/supersonic-update-agent by hand"

cat > /etc/systemd/system/supersonic-update-agent.service <<'EOF'
[Unit]
Description=Collect the current Supersonic fleet agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/supersonic-update-agent
StandardOutput=append:/var/log/supersonicd.log
StandardError=append:/var/log/supersonicd.log
EOF

cat > /etc/systemd/system/supersonic-update-agent.timer <<'EOF'
[Unit]
Description=Collect the current Supersonic fleet agent, periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now supersonic-update-agent.timer >/dev/null 2>&1 || true
```

- [ ] **Step 2: Verify provision.sh still parses**

```bash
cd ~/projects/supersonic && bash -n services/fleet/image/provision.sh && echo "syntax ok"
```

Expected: `syntax ok`

- [ ] **Step 3: Mark the destructive script for what it is**

At the top of `services/fleet/bench/restart-agent.sh`, replace the first comment line

```bash
# Rebuild and restart the agent, clearing any sandbox it left behind.
```

with:

```bash
# RECOVERY TOOL. This causes an outage of every app on the node. Not a deploy.
#
# It rebuilds the agent from source ON the node and then deliberately tears down
# everything: every runsc container killed, every bundle unmounted, routes.json
# and every ss-* namespace deleted. That is the right thing when a node is in a
# state nothing else clears, and it is the wrong thing for shipping a change.
#
# For shipping a change there is now image/update-agent.sh, which collects the
# binary CI published and restarts the unit — and because the unit carries
# KillMode=process and the agent adopts sandboxes that outlive it, that restart
# is not an outage. Using this script instead would automate the outage.
```

- [ ] **Step 4: Update the README**

In `services/fleet/README.md`, under `## Running one`, replace the two `build + restart the agent after an edit` lines:

```bash
# build + restart the agent after an edit
gcloud compute scp services/fleet/agent/*.go <node>:/opt/agent/ --zone us-central1-a
gcloud compute ssh <node> --zone us-central1-a --command 'sudo bash /tmp/restart-agent.sh'
```

with:

```bash
# ship an agent change: merge to main and the nodes collect it within ~2 minutes
#   CI:   .github/workflows/publish-agent.yml
#   node: /usr/local/bin/supersonic-update-agent, on a systemd timer
# check what a node is running:
gcloud compute ssh <node> --zone us-central1-a --tunnel-through-iap \
  --command '/opt/agent/supersonicd -version; cat /opt/agent/installed.sha256'

# force a collection now rather than waiting for the timer
gcloud compute ssh <node> --zone us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl start supersonic-update-agent'
```

And in the `## Not done` section, delete the bullet

```
- **The deploy pipeline does not know about any of this.** A deploy still goes to
  Cloud Run; `fleetctl` places an already-built image by hand.
```

which is stale — `runFleetDeploy` exists — and replace the whole `## Not done` bullet about fleet-wide routing:

```
- **Fleet-wide routing.** A node serves the apps placed on it and returns a
  plain "not on this node" for anything else. Forwarding to the node that holds
  an app is the next piece.
```

with a note that it is built:

```
- ~~Fleet-wide routing~~ — built on both sides: `peersFor` (apps/web/lib/fleet.ts)
  hands each node the other nodes' apps, and the router forwards with a
  single-hop rule so two nodes that disagree cannot pass a request back and
  forth. Untested with more than one node, because there is only one.
```

- [ ] **Step 5: Verify the whole thing still holds together**

```bash
cd ~/projects/supersonic
bash -n services/fleet/image/provision.sh
bash -n services/fleet/image/update-agent.sh
bash -n services/fleet/bench/restart-agent.sh
bash services/fleet/image/update-agent.test.sh
cd services/fleet/agent && go test ./...
cd ../../../apps/web && npx tsc --noEmit
```

Expected: no syntax errors; `passed 9, failed 0`; `ok github.com/supersonic/fleet/agent`; no type errors.

- [ ] **Step 6: Commit**

```bash
git add services/fleet/image/provision.sh services/fleet/bench/restart-agent.sh services/fleet/README.md
git commit -m "fleet: the updater runs on a timer, and the destructive path says so"
```

---

## Rollout, by hand, once

The provisioning script is idempotent and safe to re-run on a live node, which is how it is meant to be iterated. For `fleet-lab-1`:

- [ ] **Step 1: Confirm the workflow published something**

```bash
gcloud storage cat gs://supersonic-static-assets/agent/current --project supersonic-deploy-prod
```

Expected: two lines — a 64-character sha256, then a commit sha.

- [ ] **Step 2: Copy the two new scripts to the node and re-provision**

```bash
gcloud compute scp services/fleet/image/provision.sh services/fleet/image/update-agent.sh \
  fleet-lab-1:/tmp/ --zone us-central1-a --tunnel-through-iap
gcloud compute ssh fleet-lab-1 --zone us-central1-a --tunnel-through-iap \
  --command 'sudo install -m 0755 /tmp/update-agent.sh /usr/local/bin/supersonic-update-agent && sudo bash /tmp/provision.sh'
```

- [ ] **Step 3: Watch the first collection, and watch the apps not move**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --tunnel-through-iap --command '
  runsc --root=/run/supersonic/runsc list | wc -l
  sudo systemctl start supersonic-update-agent
  sleep 25
  /opt/agent/supersonicd -version
  runsc --root=/run/supersonic/runsc list | wc -l
  tail -20 /var/log/supersonicd.log'
```

Expected: the sandbox count before and after is the **same** — the restart adopted them rather than replacing them — and the log shows `update-agent: up on <sha>` followed by the agent adopting sandboxes.

- [ ] **Step 4: Confirm the version reached the control plane**

```bash
cloud-sql-proxy -g --port 5433 supersonic-deploy-prod:us-central1:supersonic-shared-pg &
cd apps/web && PGPASSWORD="$(node -p "require('./.pg.json').password")" \
  psql -h 127.0.0.1 -p 5433 -U postgres -d supersonic_platform \
  -c "SELECT name, agent_version, last_seen FROM fleet_nodes;"
pkill -x cloud-sql-proxy
```

Expected: `agent_version` matches what `-version` printed on the node.

Kill the tunnel when done — leaving it up once made an agent's test suite take 61 seconds against production.

- [ ] **Step 5: Confirm the stages that motivated this now have rows**

Once a deploy has run against the node with the new agent:

```bash
cloud-sql-proxy -g --port 5433 supersonic-deploy-prod:us-central1:supersonic-shared-pg &
cd apps/web && npm run timing --silent | head -30
pkill -x cloud-sql-proxy
```

Expected: `fleet-pull` and `fleet-boot` appear in the stage table. They have never had a row. Their appearance is the proof this task worked, and it is also the instrument the next plan needs.

---

## What this plan does not do

Does not touch the placement model, the reconciler, the sync protocol or the edge — those are separate items in the order of work and separate specs. Does not remove the Go toolchain from the nodes, which `restart-agent.sh` still needs. Does not deploy the agent to more than one node, because there is one. Does not add a rollout percentage or a canary for the agent itself: with a single node the concept is empty, and it belongs with node two.
