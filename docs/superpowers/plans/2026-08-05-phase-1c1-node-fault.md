# Phase 1C-1: The node says when the fault is its own — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a node cannot start an app because something on the node is broken, the deploy fails as a platform fault and the repair agent is never dispatched against the customer's repository.

**Architecture:** The agent already knows — `container.go` refuses to start a database-backed app when the node's Cloud SQL proxy is unreachable and the error names the node. It logs that and drops it. This adds the missing channel: the existing 10-second sync body carries a per-process `fault` enum decided at the source, the control plane stores it, and `placeOnFleet` turns a corroborated node fault into a `FLEET_NODE_FAULT` marker that `classify` already knows how to route to `blame: "platform"`.

**Tech Stack:** Go 1.25 (`services/fleet/agent`); TypeScript on Node 22 with `node:test` (`apps/web`); Postgres.

## Why this slice, and what it deliberately leaves out

The full status-channel design covers three things: this, a verdict for worker-only apps that publish no route, and an operator surface for what is running. This plan is only the first, because it is the one that costs money on every occurrence: a failure the node caused is classified as the app's, and `opencodeRepair` is handed a customer's checkout with `write_file` and `run_command`, up to 18 steps and 3 full rebuild-and-deploy cycles.

**Explicitly not here:** the serviceless verdict, `reportHash` write-amplification control, `/status`-style process listing in the control plane, and any UI. Each is named in the programme spec and each needs this to exist first.

## What is already true

- The sync request body is `NodeIdentity` — `name`, `zone`, `internalIp`, `memoryBytes`, `cpus` — and nothing else (`desired.go:31-37`). The response is `{ apps }`. One POST per node every 10 seconds.
- `fleet_nodes` has no per-app state. `fleet_placements` has `(slug, node)` as its primary key.
- The agent throws the reason away: `main.go` logs `"%s: start failed: %v"` and the `live` map only gains an entry on success.
- `classify` (`deploy-errors.ts`) matches `PLATFORM_MARKERS` with `includes`, and a match routes to `blame: "platform"`, which takes the branch that rolls back and tells the user without reaching the repair agent.
- `chooseNode` already treats a node as usable only if `last_seen > now() - 90 seconds`.

## Global Constraints

- **Never squash commits.** One commit per change.
- **Never print secrets.** Not in logs, not in test output, not in a commit.
- **Postgres is shared production. Additive, idempotent SQL only.** Migrations are applied in filename order on every run; the latest is `013_fleet.sql`, so the next is `014_`.
- **Every push to `main` deploys the control plane to production.** There is no staging.
- **The agent is deployed by `scp`-ing `*.go` to `/opt/agent/` and building on the node**, then `sudo systemctl restart supersonicd`. It is NOT deployed by pushing to `main`. Do not use `/tmp/restart-agent.sh` — it deletes every sandbox.
- **Never put a pipe inside an `&&` chain that gates a decision** — the chain takes the pipe's exit status. Redirect to a file, echo `$?`, then read the file.
- **Go commands from `services/fleet/agent`; TypeScript from `apps/web`, never the repo root.** The test command needs `--experimental-test-module-mocks`.

## File structure

| File | Responsibility |
|---|---|
| `services/fleet/agent/fault.go` | **new.** The fault enum and the classification of an error into it. Pure, no I/O. |
| `services/fleet/agent/fault_test.go` | **new.** Its tests. |
| `services/fleet/agent/main.go` | retains the failure instead of dropping it. |
| `services/fleet/agent/desired.go` | the sync body carries the per-process report. |
| `apps/web/db/014_fleet_status.sql` | **new.** Where the report is stored. |
| `apps/web/lib/fleet.ts` | writes the report, and answers "is this node at fault for this app". |
| `apps/web/app/api/fleet/sync/route.ts` | accepts the new field, and refuses rows for placements that do not exist. |
| `apps/web/lib/fleet-place.ts` | turns a corroborated node fault into the marker. |
| `apps/web/lib/deploy-errors.ts` | one entry in `PLATFORM_MARKERS`. |

---

### Task 1: A fault is a value, not a sentence

**Files:**
- Create: `services/fleet/agent/fault.go`
- Create: `services/fleet/agent/fault_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 2 and 3:
  - `type Fault string` with `FaultNone = ""`, `FaultNode = "node"`, `FaultApp = "app"`, `FaultUnknown = "unknown"`
  - `func classifyStartError(err error) Fault`

The control plane must not re-derive a fault by matching substrings of an error message. `deploy-errors.ts:72-79` documents what that costs: an `enotfound`/`ModuleNotFoundError` boundary bug that mis-blamed a whole class of failures. The node is the only place that knows whether the Cloud SQL proxy answered, so the node decides and sends a value.

- [x] **Step 1: Write the failing tests**

Create `services/fleet/agent/fault_test.go`:

```go
package main

import (
	"errors"
	"fmt"
	"testing"
)

func TestAnUnreachableDatabaseProxyIsTheNodesFault(t *testing.T) {
	// secrets.go produces this shape when dbPathReachable fails. It names the
	// node precisely so a human reading the log knows where to look; the enum is
	// so the control plane does not have to read the log at all.
	err := fmt.Errorf("fleet-lab-1: the database path 10.200.0.1:5432 is not answering")
	if got := classifyStartError(err); got != FaultNode {
		t.Fatalf("got %q, want %q — a dead node proxy must not be blamed on the app", got, FaultNode)
	}
}

// CORRECTED. The strings below were invented by this document and exist
// nowhere in the code — see "Corrections applied" at the end of this file.
// The real fixture calls resolveSecret against an httptest server, so the
// producer writes the string and rewording it fails this test.

func TestAMissingSecretIsTheNodesFaultWhenItIsAPermissionProblem(t *testing.T) {
	// A 403 resolving a secret is the node's service account, not the app's spec.
	err := secretManagerError(t, "app-foo-DATABASE_URL", 403, `{"error":{"code":403,…}}`)
	if got := classifyStartError(err); got != FaultNode {
		t.Fatalf("got %q, want %q", got, FaultNode)
	}
}

func TestAMissingSecretIsTheAppsFaultWhenItDoesNotExist(t *testing.T) {
	// A 404 is the spec naming a secret nobody created — that IS the app.
	err := secretManagerError(t, "app-foo-DATABASE_URL", 404, `{"error":{"code":404,…}}`)
	if got := classifyStartError(err); got != FaultApp {
		t.Fatalf("got %q, want %q", got, FaultApp)
	}
}

func TestAnUnrecognisedErrorIsUnknownNotApp(t *testing.T) {
	// The default must not be "app". Defaulting to the app is what dispatches a
	// repair agent against a customer's repository over our own outage, and an
	// error nobody has classified is exactly the case where that is most likely
	// to be wrong.
	err := errors.New("something nobody has seen before")
	if got := classifyStartError(err); got != FaultUnknown {
		t.Fatalf("got %q, want %q — an unclassified error must not read as the app's fault", got, FaultUnknown)
	}
}

func TestNoErrorIsNoFault(t *testing.T) {
	if got := classifyStartError(nil); got != FaultNone {
		t.Fatalf("got %q, want %q", got, FaultNone)
	}
}
```

- [x] **Step 2: Run them to verify they fail**

```bash
cd services/fleet/agent && go test -run TestAnUnreachable -run TestA -run TestNo ./... > /tmp/f1.txt 2>&1; echo "exit=$?"
cat /tmp/f1.txt
```

Expected: a compile failure — `undefined: classifyStartError`.

- [x] **Step 3: Write it**

Create `services/fleet/agent/fault.go`:

```go
package main

import "strings"

// Whose fault a failed start is, decided HERE, on the node.
//
// The control plane cannot work this out. It sees "nothing answered at the load
// balancer" and has historically concluded the app is broken — which dispatches
// an LLM repair agent against the customer's repository, with write access, over
// an outage we caused. The node is the only party that knows whether its own
// Cloud SQL proxy answered.
//
// A value rather than a sentence, deliberately. deploy-errors.ts re-derives
// blame by matching substrings and the file documents what that cost: an
// enotfound/ModuleNotFoundError boundary bug that mis-blamed a whole class of
// failures. Classification belongs where the fact is.
type Fault string

const (
	FaultNone    Fault = ""
	FaultNode    Fault = "node"
	FaultApp     Fault = "app"
	FaultUnknown Fault = "unknown"
)

// classifyStartError maps a start failure onto who is responsible.
//
// The default is FaultUnknown and never FaultApp. An error nobody has
// classified is precisely the case where blaming the app is most likely to be
// wrong, and the cost of that mistake is measured in someone's repository.
func classifyStartError(err error) Fault {
	if err == nil {
		return FaultNone
	}
	s := strings.ToLower(err.Error())

	switch {
	// The node's own database path. secrets.go names the node in this error.
	case strings.Contains(s, "database path") && strings.Contains(s, "not answering"):
		return FaultNode
	// CORRECTED. "resolve secret" is a Go function name and is never emitted;
	// gating on it returns FaultUnknown for every real secret failure. Match on
	// the status code our own format string writes, not on Google's prose.
	case strings.Contains(s, "secret ") && strings.Contains(s, ": 403"):
		return FaultNode
	case strings.Contains(s, "secret ") && strings.Contains(s, ": 404"):
		return FaultApp
	default:
		return FaultUnknown
	}
}
```

- [x] **Step 4: Run the tests**

```bash
cd services/fleet/agent && go test -count=1 ./... > /tmp/f2.txt 2>&1; echo "exit=$?"
tail -3 /tmp/f2.txt
go vet ./... > /tmp/f3.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/f3.txt)"
GOOS=linux GOARCH=amd64 go build ./... > /tmp/f4.txt 2>&1; echo "linux exit=$?"
```

Expected: all exit 0, the five new tests passing alongside the existing suite.

- [x] **Step 5: Commit**

```bash
git add services/fleet/agent/fault.go services/fleet/agent/fault_test.go
git commit -m "Whose fault a failed start is, decided on the node

The control plane sees nothing answering at the load balancer and concludes the
app is broken, which hands an LLM repair agent a customer's repository with
write access over an outage we caused. The node is the only party that knows
whether its own Cloud SQL proxy answered.

A value rather than a sentence: deploy-errors.ts re-derives blame by matching
substrings and documents what that cost, an enotfound/ModuleNotFoundError
boundary bug that mis-blamed a class of failures.

The default is unknown and never app. An error nobody has classified is exactly
where blaming the app is most likely to be wrong."
```

---

### Task 2: The agent keeps the failure and sends it

**Files:**
- Modify: `services/fleet/agent/main.go` — the `Agent` struct, and the start-failure site that currently only logs
- Modify: `services/fleet/agent/desired.go` — `NodeIdentity` and the POST body

**Interfaces:**
- Consumes: `Fault`, `FaultNone`, `classifyStartError` from Task 1.
- Produces, consumed by Task 3: the sync request body gains one optional field:

```json
{ "name": "...", "zone": "...", "internalIp": "...", "memoryBytes": 0, "cpus": 0,
  "processes": [ { "slug": "a8ebb", "process": "web", "fault": "node", "detail": "..." } ] }
```

`processes` **absent** must mean "this agent does not report", not "this node holds nothing" — Task 3 relies on that distinction, and conflating them would make a rolling agent upgrade look like a fleet-wide outage.

- [x] **Step 1: Add the report type and the retained map**

In `services/fleet/agent/desired.go`, beside `NodeIdentity`:

```go
// ProcessFault is one process's most recent start failure, as the node sees it.
//
// Sent on every sync. Omitted entirely — not sent as an empty array — by an
// agent that has nothing to report, because absent and empty must stay
// distinguishable: absent means "this agent does not report", empty means "I
// hold nothing failing". Conflating them makes a rolling agent upgrade read as
// a fleet-wide outage.
type ProcessFault struct {
	Slug    string `json:"slug"`
	Process string `json:"process"`
	Fault   Fault  `json:"fault"`
	Detail  string `json:"detail,omitempty"`
}
```

and extend the body that `fromControlPlane` marshals. It currently marshals `s.Identity`; give `Source` a `Report func() []ProcessFault` callback and marshal a struct embedding `NodeIdentity` plus the processes.

**CORRECTED.** This plan said `Processes []ProcessFault \`json:"processes,omitempty"\`` and that `omitempty` is what makes absent-vs-empty work. It does the opposite: `omitempty` drops a nil slice and an empty one alike, so "this agent is too old to report" and "I hold nothing failing" become the same bytes. The field must be a **pointer** to a slice — nil omits, `&[]` sends `[]` — and the pointed-to slice must never itself be nil, because `json.Marshal` writes `null` for one and `null` is not an array.

In `services/fleet/agent/main.go`, add to the `Agent` struct beside the trackers:

```go
	// faults is the most recent start failure per sandbox id, retained rather
	// than logged and dropped. Cleared when that id next starts successfully.
	faults map[string]ProcessFault
```

Initialise it in the one struct literal alongside the others, and populate it where the start failure is currently only logged:

```go
			log.Printf("%s: start failed: %v", id, err)
			a.mu.Lock()
			a.faults[id] = ProcessFault{
				Slug: app.Slug, Process: proc.Name,
				Fault: classifyStartError(err), Detail: err.Error(),
			}
			a.mu.Unlock()
```

and clear it on a successful start, in the same critical section that records the live entry.

Wire `src.Report` in `main()` to a method that copies the map under the lock.

- [x] **Step 2: Build, vet, race**

```bash
cd services/fleet/agent && go build ./... > /tmp/a1.txt 2>&1; echo "build exit=$?"; cat /tmp/a1.txt
go vet ./... > /tmp/a2.txt 2>&1; echo "vet exit=$? bytes=$(wc -c < /tmp/a2.txt)"
go test -race -count=1 ./... > /tmp/a3.txt 2>&1; echo "race exit=$?"; tail -3 /tmp/a3.txt
GOOS=linux GOARCH=amd64 go build ./... > /tmp/a4.txt 2>&1; echo "linux exit=$?"
```

The race detector matters: `faults` is written from the start path and read from the sync path.

- [x] **Step 3: Commit**

```bash
git add services/fleet/agent/main.go services/fleet/agent/desired.go
git commit -m "The agent keeps the reason a process would not start

It knew and threw it away: the failure was logged and the live map only gained
an entry on success, so the control plane saw silence and blamed the app.

Sent on the sync that already runs every ten seconds, so there is no new channel
to secure and no second auth surface. Absent and empty stay distinguishable —
omitempty on the wire — because an agent that does not report and a node that
holds nothing failing are different facts, and conflating them would make a
rolling agent upgrade read as a fleet-wide outage."
```

---

### Task 3: The control plane stores it, and refuses what it was not given

**Files:**
- Create: `apps/web/db/014_fleet_status.sql`
- Modify: `apps/web/lib/fleet.ts`
- Modify: `apps/web/app/api/fleet/sync/route.ts`

**Interfaces:**
- Consumes: the `processes` array from Task 2.
- Produces, consumed by Task 4: `nodeFaultFor(slug: string): Promise<{ node: string; detail: string } | null>` from `apps/web/lib/fleet.ts` — non-null only when a **fresh** node reports `fault = 'node'` for that app.

- [x] **Step 1: The migration**

Create `apps/web/db/014_fleet_status.sql`. Additive and idempotent, like every migration in this directory:

```sql
-- What a node says about the processes it was given.
--
-- Only failures are stored. A process that starts is absent, so the table stays
-- small and "is there a row" is itself the question the reader asks.
CREATE TABLE IF NOT EXISTS fleet_process_faults (
  slug        text NOT NULL,
  node        text NOT NULL REFERENCES fleet_nodes(name) ON DELETE CASCADE,
  process     text NOT NULL,
  fault       text NOT NULL,
  detail      text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, node, process)
);

CREATE INDEX IF NOT EXISTS fleet_process_faults_slug_idx ON fleet_process_faults (slug);
```

- [x] **Step 2: The write, and the guard**

In `apps/web/lib/fleet.ts`, add:

```ts
export interface ProcessFault { slug: string; process: string; fault: string; detail?: string; }

/**
 * Replace this node's fault set, in one transaction.
 *
 * A row is accepted only for a (slug, node) pair that already exists in
 * fleet_placements. FLEET_TOKEN is a shared secret and any holder can post as
 * any node, so without this the channel upgrades a leaked token from "read
 * desired state" to "mark another node's apps failed and steer deploy verdicts".
 * A node cannot report on apps it was never given.
 */
export async function recordNodeFaults(node: string, faults: ProcessFault[]): Promise<void> {
  // ... delete this node's rows, then insert the accepted ones, in one transaction
}
```

Implement it following the file's existing query style — read `heartbeatNode` and `desiredFor` first and match them rather than introducing a second idiom.

Then the reader:

```ts
/**
 * Is a FRESH node reporting that this app's failure is the node's own?
 *
 * Freshness is a property of the NODE, never of the row. `KillMode=process`
 * means restarting the agent does not stop the sandboxes, so a node that has not
 * reported recently is `unknown` — not `down` — and unknown must never fail a
 * deploy. The 90-second window is the one chooseNode already uses.
 */
export async function nodeFaultFor(slug: string): Promise<{ node: string; detail: string } | null> {
  // ... join fleet_process_faults to fleet_nodes on last_seen > now() - interval '90 seconds'
  //     and to fleet_placements on (slug, node), where fault = 'node'
}
```

- [x] **Step 3: Accept it in the route**

In `apps/web/app/api/fleet/sync/route.ts`, after `heartbeatNode` and before `desiredFor`, call `recordNodeFaults(name, body.processes)` **only when `body.processes` is an array** — an absent field must leave the stored set untouched, because absent means "this agent does not report" and an older agent must not silently clear a newer one's rows.

Wrap it so a failure here cannot fail the sync: the response the node needs is `{ apps }`, and a node that stops receiving desired state because a status write failed is a worse outcome than a stale fault row.

- [x] **Step 4: Verify the migration applies**

```bash
cd apps/web && npx tsc --noEmit > /tmp/m1.txt 2>&1; echo "tsc exit=$? bytes=$(wc -c < /tmp/m1.txt)"
cat /tmp/m1.txt
node --experimental-test-module-mocks --import tsx --test 'test/**/*.test.ts' > /tmp/m2.txt 2>&1; echo "suite exit=$?"
grep -E "^# (tests|pass|fail|skipped)" /tmp/m2.txt
```

Expected: tsc clean, 0 fail. Baseline is 907 tests / 902 pass / 0 fail / 5 skipped.

- [x] **Step 5: Commit**

```bash
git add apps/web/db/014_fleet_status.sql apps/web/lib/fleet.ts apps/web/app/api/fleet/sync/route.ts
git commit -m "The control plane stores what a node says, and only about apps it was given

A row is accepted only for a (slug, node) pair already in fleet_placements.
FLEET_TOKEN is a shared secret and any holder can post as any node; without that
guard this channel upgrades a leaked token from reading desired state to marking
another node's apps failed and steering deploy verdicts.

Absent processes leaves the stored set untouched. Absent means this agent does
not report; empty means it holds nothing failing. An older agent must not
silently clear a newer one's rows.

Only failures are stored, so the table stays small and the presence of a row is
itself the question a reader asks."
```

---

### Task 4: A node fault stops reaching the repair agent

**Files:**
- Modify: `apps/web/lib/deploy-errors.ts` — `PLATFORM_MARKERS`
- Modify: `apps/web/lib/fleet-place.ts` — the failed-verdict branch of `placeOnFleet`
- Modify: `apps/web/test/fleet-place.test.ts`

**Interfaces:**
- Consumes: `nodeFaultFor` from Task 3.
- Produces: nothing further.

This is the task the plan exists for. Everything above it is plumbing.

- [x] **Step 1: Add the marker**

In `apps/web/lib/deploy-errors.ts`, add `"FLEET_NODE_FAULT"` to `PLATFORM_MARKERS`. `classify` matches markers with `includes`, so a reason containing that string routes to `blame: "platform"`, which takes the branch that rolls back and tells the user — and never reaches `opencodeRepair`.

- [x] **Step 2: Emit it, but only when corroborated**

In `placeOnFleet`'s failed-verdict branch, before returning the reason, ask `nodeFaultFor(slug)`. When it returns non-null, prefix the reason:

```ts
      const nf = await nodeFaultFor(slug);
      const reason = nf
        // Corroboration matters both ways. A false "node" costs one rolled-back
        // deploy; a false "app" costs a repair run with write access to a
        // customer's repository. But a node that blames itself for everything
        // would hide real app bugs, so this fires only on the node's own typed
        // verdict, never on a guess from the probe's silence.
        ? `FLEET_NODE_FAULT: ${nf.node} reports this app cannot start on it — ${nf.detail}`
        : verdict.reason;
```

Add `nodeFaultFor` to the `PlacementPorts` interface so the existing tests can inject it, rather than importing it directly — the file's tests already work that way.

- [x] **Step 3: Test both directions**

Add to `apps/web/test/fleet-place.test.ts`, following the file's existing port-injection style:

```ts
test("a node that blames itself keeps the repair agent away", async () => {
  const r = await placeOnFleet(/* ports with a failing probe AND nodeFaultFor returning a fault */);
  assert.equal(r.placed, false);
  assert.match(r.reason ?? "", /FLEET_NODE_FAULT/);
});

test("a failure the node does NOT claim still reads as the app's", async () => {
  // The whole value is in this direction too: a node that took the blame for
  // everything would hide real app bugs behind a platform verdict.
  const r = await placeOnFleet(/* ports with a failing probe and nodeFaultFor returning null */);
  assert.equal(r.placed, false);
  assert.ok(!(r.reason ?? "").includes("FLEET_NODE_FAULT"));
});
```

Fill in the port objects from the file's existing helpers — do not invent a new fixture shape.

- [x] **Step 4: Run and commit**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts test/deploy-errors.test.ts > /tmp/n1.txt 2>&1; echo "exit=$?"
grep -E "^# (tests|pass|fail)" /tmp/n1.txt
npx tsc --noEmit > /tmp/n2.txt 2>&1; echo "tsc exit=$? bytes=$(wc -c < /tmp/n2.txt)"
```

```bash
git add apps/web/lib/deploy-errors.ts apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts
git commit -m "A node that blames itself no longer sends a repair agent after the app

The agent has always known when its own database path is dead; it logged that
and the control plane saw only silence at the load balancer, classified the
failure as the app's, and dispatched an LLM against the customer's repository
with write access — up to 18 steps and 3 full rebuild-and-deploy cycles, over an
outage we caused.

FLEET_NODE_FAULT joins PLATFORM_MARKERS, so classify routes it to
blame: platform, which rolls back and tells the user without ever reaching
opencodeRepair.

Tested in both directions on purpose. A node that took the blame for everything
would hide real app bugs behind a platform verdict, so this fires only on the
node's own typed verdict and never on a guess from the probe's silence."
```

---

## Self-Review

**Spec coverage.** The programme spec's phase 1 item "One status channel closes three holes at once" has three halves. This plan implements the first — node-versus-app blame. The serviceless verdict and the operator surface are named as excluded above and both need this table to exist first.

**Placeholder scan.** Task 3 Step 2 and Task 4 Step 3 describe query bodies and fixtures rather than giving them verbatim. That is deliberate and it is the one thing in this plan I would flag to a reviewer: `fleet.ts` has an established query idiom and `fleet-place.test.ts` an established port-injection fixture, and writing those out from memory would produce a second idiom in each file. The instruction is to read the neighbours and match them. If an implementer finds the neighbours do not support what is asked, that is a real finding and should come back rather than be worked around.

**Type consistency.** `Fault` and `classifyStartError` are defined in Task 1 and used in Task 2. `ProcessFault` is defined in Task 2 (Go) and mirrored in Task 3 (TypeScript) — the two must stay in step, and nothing enforces that, which is the same drift risk `test/fleet-spec.test.ts` exists to catch for `App`. A drift test for this pair belongs in the next slice.

**The risk this plan does not remove.** `FLEET_TOKEN` is still a shared secret, and the placement guard narrows the blast radius rather than closing it: a holder can still report faults for apps that node genuinely holds. The real fix is a GCE instance identity token, which the sync route's own comment already names as the upgrade, and this change raises its priority rather than delivering it.

---

## Corrections applied during implementation

All four tasks are implemented on `phase-1c1-node-fault`. Five defects were found
in THIS DOCUMENT and none in the transcription of it, which is the same ratio the
5 Aug handoff recorded. Each is corrected in place above; this is the ledger.

**1. The secret classifier matched a string that does not exist.** The brief
gated on `Contains("resolve secret")`. `resolveSecret` is a Go function name and
is never emitted; the real producer is `secrets.go:70`,
`fmt.Errorf("secret %s: %d %s", …)`. Implemented verbatim, the classifier
compiles, passes the brief's own tests, and returns `FaultUnknown` for every real
secret failure. Match on the status number — `: 403` is ours and changes only
when we change it; "Permission denied on resource" is Google's, inside a JSON
body, and can be reworded in an API release. A `: 500` is a Secret Manager
outage, neither our permissions nor the app's spec, and falls through to
`FaultUnknown` rather than being guessed into either bucket.

**2. The fixtures were built from the same imagination as the code.**
`errors.New` with strings this document invented would have passed against a
correct implementation and a broken one alike. The fixtures now CALL the
producers: `dbPathReachable("127.0.0.1:1", …)` for the database path, and
`resolveSecret` against an `httptest` server for the secret cases — which needed
a base-URL and token seam in `secrets.go`. Measured: rewording the `fmt.Errorf`
now fails both tests with `got "unknown"`.

**3. `omitempty` cannot express absent-versus-empty.** It drops nil and empty
alike. An agent with nothing failing would then be indistinguishable from an
agent too old to report — and since faults live in memory, EVERY agent restart
has nothing failing, so a repaired app would have stayed marked as a node fault
in Postgres forever, failing all its later deploys as a platform problem. The
field is a pointer to a slice. Measured against the plan's form: `want [], got
null`.

**4. Detail must not travel for an unclassified fault.** `container.go` folds
the last 800 bytes of the app's own log into a start error, so an unclassified
detail is the customer's stdout and can hold anything they printed. It already
goes to the node's log; this channel would take it off the node into shared
Postgres and into a sentence a user reads on a failed deploy. Only the
classified strings — ours, with no app output in them — carry detail, bounded at
400 runes.

**5. `.catch()` on the fault lookup let the unwired-port case through.** A
missing port throws a `TypeError` synchronously, before there is a promise to
attach a handler to, so the exception escapes `placeOnFleet` and skips the
restore — leaving the broken spec placed with the runtime flag on `fleet`. Found
by `deploy-pipeline.test.ts`, whose fleet mock had not been given the new port:
its repair-agent assertion went from 1 repair to 0. `try/catch`, and a test that
deletes the port outright.

**One addition beyond the plan.** `nodeFaultFor` carries a second freshness
condition on `reported_at`, not only on the node's `last_seen`. A node can go on
heartbeating while no longer reporting faults — roll the agent back to a binary
built before this field existed and that is exactly what happens — and the sync
correctly leaves the stored row alone, so a fault nobody is still claiming would
blame the platform for every future deploy of that app. `reported_at` is
refreshed on every sync, so this costs a genuine fault nothing.

**What was verified, and how.** The Go package: 39 tests, `-race` clean, `vet`
silent, `GOOS=linux` build clean. `apps/web`: 913 tests, 908 pass, 0 fail, 5
skipped (baseline was 907/902/0/5), `tsc` clean. The SQL — the part with no test
harness in this repository — was run against a real Postgres engine rather than
reasoned about: the migration applies and re-applies, the placement guard drops
rows for apps a node was not given, an empty report clears one node's rows and
never another's, `app` and `unknown` faults do not read as node faults, a fault
value this control plane has never heard of is stored rather than rejected, both
freshness conditions bite, and a duplicate `(slug, process)` pair does not abort
the sync. Fourteen checks.

**Not done.** Nothing is merged and nothing is deployed. The agent still has to
be built on the node and `014_fleet_status.sql` still has to reach production,
which happens on the next push to `main`.
