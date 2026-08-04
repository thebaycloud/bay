# The fleet as a deploy target, databases included — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy every container- and buildpack-lane web app to the fleet instead of Cloud Run, including apps with a database.

**Architecture:** One Cloud SQL Auth Proxy per node, listening on the sandbox bridge gateway `10.200.0.1:5432`, which every sandbox already has a default route to. The deploy pipeline chooses a runtime *before* deploying and takes one branch. There is no fallback to Cloud Run: a failed deploy leaves the previous placement serving.

**Tech Stack:** TypeScript (Next.js app under `apps/web`), Go (the node agent under `services/fleet/agent`), bash (`services/fleet/image/provision.sh`), Postgres, Cloud SQL Auth Proxy, systemd, gVisor/runsc.

**Spec:** `docs/superpowers/specs/2026-08-04-fleet-as-deploy-target-design.md`

## Global Constraints

- **Never squash commits.** One commit per change, pushed immediately.
- **Never print secrets** (`AUTH_SECRET`, `PG_PASSWORD`, `apps/web/.env.local`, `apps/web/.pg.json`, `~/.supersonic/config.json`, `openai-api-key`).
- **Postgres is shared production.** Additive/idempotent SQL only.
- **Every push to `main` deploys to production.** There is no staging.
- **Never put a pipe inside an `&&` chain that gates a push** — it takes the pipe's exit status.
- **Verify before claiming.** A measurement, not an argument.
- TypeScript tests are `node:test` + `node:assert/strict`. Run one file with
  `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/<name>.test.ts`,
  everything with `npm test`.
- Typecheck with `cd apps/web && npx tsc --noEmit` — and read the exit code
  without a pipe, or you read `head`'s.
- Go builds for the platform it runs on:
  `cd services/fleet/agent && GOOS=linux GOARCH=amd64 go build ./...`
- The bridge gateway address is **`10.200.0.1`**, defined as `bridgeCIDR` in
  `services/fleet/agent/network.go:25`. After this plan it is part of every
  database-backed app's configuration.

## File structure

| File | Responsibility | Change |
|---|---|---|
| `services/fleet/image/provision.sh` | Node build: packages, containerd, gVisor, nftables, proxy, agent | modify §7 |
| `apps/web/lib/lanes.ts` | Lane-shaped argv and the database environment | modify |
| `apps/web/lib/db-address.ts` | Where Postgres answers, per runtime, and the URL built from it | **create** |
| `apps/web/lib/fleet-place.ts` | Runtime choice, placement, verdict, probe | modify |
| `apps/web/lib/deploy-pipeline.ts` | The pipeline, and the runtime fork | modify |
| `services/fleet/agent/secrets.go` | Secret resolution; gains the database-path check | modify |
| `apps/web/test/db-address.test.ts` | Tests for the address and the URL | **create** |
| `apps/web/test/fleet-place.test.ts` | Existing placement tests | modify |

`db-address.ts` is its own file rather than more of `lanes.ts` because `lanes.ts`
is Cloud Run's vocabulary — sidecars, startup probes, `--set-env-vars` — and the
address of a database is now a fact about the runtime, not about a lane. It is
also the one value both runtimes must agree about, which is exactly the kind of
thing this codebase keeps in one declaration with a test over it.

---

### Task 1: The proxy on the node actually runs

The unit already exists — `provision.sh` §7 writes
`/etc/systemd/system/cloud-sql-proxy.service` — and is **never enabled**. Line
347 enables `supersonicd`; nothing enables the proxy. So the file is written and
after a reboot nothing starts it.

It also binds `--address 0.0.0.0`, which listens on every interface the node has,
including its VPC address. It cannot simply bind `10.200.0.1` instead: the bridge
`ssbr0` is created by the *agent* at runtime, so at boot that address does not
exist yet and the unit would fail to start. The fix is to keep the bind and close
the door with nftables, next to the metadata block that is already there.

**Files:**
- Modify: `services/fleet/image/provision.sh:268-307` (§7) and `:346-347`

**Interfaces:**
- Consumes: nothing.
- Produces: a listener on `10.200.0.1:5432` reachable from every sandbox; a
  health endpoint on `127.0.0.1:9801`.

- [ ] **Step 1: Enable the unit**

In `provision.sh`, next to the existing `systemctl enable supersonicd` line:

```bash
systemctl daemon-reload
systemctl enable cloud-sql-proxy >/dev/null 2>&1 || true
systemctl enable supersonicd >/dev/null 2>&1 || true
```

- [ ] **Step 2: Close the proxy to everything except sandboxes**

Add to the nftables ruleset written in §6, in the same `define`/`chain` block that
blocks the metadata server:

```
# The Cloud SQL proxy binds 0.0.0.0 because ssbr0 does not exist at boot — the
# agent creates it. So the bind is wide and the DOOR is narrow: only sandbox
# traffic arriving on the bridge may reach 5432. Without this the node's VPC
# address answers Postgres for anything that can route to it.
tcp dport 5432 iifname != "ssbr0" drop
```

- [ ] **Step 3: Apply to the live node and check it comes up**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --tunnel-through-iap --command "sudo systemctl enable --now cloud-sql-proxy && systemctl is-active cloud-sql-proxy && curl -sf http://127.0.0.1:9801/startup && echo ' proxy healthy'"
```

Expected: `active` then ` proxy healthy`.

If SSH fails with `Permission denied (publickey)`, the key has not propagated —
ask the operator to run it. Do not skip and claim it works.

- [ ] **Step 4: Prove a sandbox can reach it — the measurement the spec asks for**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --tunnel-through-iap --command "sudo ip netns exec ss-\$(sudo ls /var/run/netns | head -1 | sed 's/^ss-//') timeout 5 bash -c '</dev/tcp/10.200.0.1/5432' && echo REACHABLE"
```

Expected: `REACHABLE`. If it is not, stop — every later task depends on this and
none of them will tell you it is missing.

- [ ] **Step 5: Reboot and check it survives**

```bash
gcloud compute instances reset fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod
# wait for boot, then:
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --tunnel-through-iap --command "systemctl is-active cloud-sql-proxy"
```

Expected: `active`. This is the step the missing `enable` would have failed.

- [ ] **Step 6: Commit**

```bash
git add services/fleet/image/provision.sh
git commit -m "The database proxy on a node starts, and only sandboxes reach it

The unit was written and never enabled. provision.sh enables containerd,
nftables and supersonicd; the proxy was the one thing that got a unit file
and no enable, so a node came back from a reboot with no database path and
nothing saying so.

It binds 0.0.0.0 because ssbr0 does not exist at boot — the agent creates
it — so the bind stays wide and the door gets narrow instead: only traffic
arriving on the bridge may reach 5432."
git push origin main
```

---

### Task 2: The database address becomes a value, not a constant

`DB_HOST` and `DB_PORT` are baked into `lanes.ts` and read by `databaseEnv`,
`dbContainerArgs`, `proxyWait` and `provisionPostgres`. The host is about to
differ per runtime, so it becomes a parameter with two named values.

Note what `databaseEnv` actually writes: **eleven** variables carry the host, not
just `DATABASE_URL` — `POSTGRES_SERVER`, `POSTGRES_HOST`, `PGHOST`, `DB_HOST`
and their ports. Changing only `DATABASE_URL` would leave a Django app reading
`POSTGRES_HOST=127.0.0.1` and failing in a way that looks nothing like this
change.

**Files:**
- Create: `apps/web/lib/db-address.ts`
- Create: `apps/web/test/db-address.test.ts`
- Modify: `apps/web/lib/lanes.ts:45-46, 75-90`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DbAddress { host: string; port: string }`
  - `const CLOUD_RUN_DB: DbAddress` — `{ host: "127.0.0.1", port: "5432" }`
  - `const FLEET_DB: DbAddress` — `{ host: "10.200.0.1", port: "5432" }`
  - `databaseEnv(db, at?: DbAddress): string[]` — `at` defaults to `CLOUD_RUN_DB`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/db-address.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUN_DB, FLEET_DB } from "../lib/db-address";
import { databaseEnv } from "../lib/lanes";

const db = { databaseUrl: "postgresql://u:p@H:P/d", user: "u", password: "p", dbName: "d" };

test("the fleet address reaches every variable that carries a host, not just DATABASE_URL", () => {
  // databaseEnv writes eleven variables that name the host. A Django app reads
  // POSTGRES_HOST, a psql-shaped one reads PGHOST, and an app that assembles its
  // own URL reads DB_HOST — so changing only DATABASE_URL leaves most apps
  // pointing at a loopback address with nothing on it.
  const env = databaseEnv(db, FLEET_DB);
  const hostVars = env.filter((p) => /^(POSTGRES_SERVER|POSTGRES_HOST|PGHOST|DB_HOST)=/.test(p));

  assert.equal(hostVars.length, 4, `expected four host variables, got ${hostVars.join(" ")}`);
  for (const pair of hostVars) assert.ok(pair.endsWith("=10.200.0.1"), `${pair} kept the old host`);
});

test("the default is unchanged, so the Cloud Run path is untouched by this", () => {
  assert.deepEqual(databaseEnv(db), databaseEnv(db, CLOUD_RUN_DB));
  assert.ok(databaseEnv(db).includes("PGHOST=127.0.0.1"));
});

test("the two addresses are the only two, and they differ only in host", () => {
  // The port is the same on both sides on purpose: a proxy that answers on a
  // different port on each runtime is a second thing to get wrong for no gain.
  assert.equal(CLOUD_RUN_DB.port, FLEET_DB.port);
  assert.notEqual(CLOUD_RUN_DB.host, FLEET_DB.host);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/db-address.test.ts`
Expected: FAIL — `Cannot find module '../lib/db-address'`.

- [ ] **Step 3: Create the module**

Create `apps/web/lib/db-address.ts`:

```ts
/**
 * Where Postgres answers, which is now a property of the runtime.
 *
 * Its own file rather than more of lanes.ts: that module is Cloud Run's
 * vocabulary — sidecars, startup probes, --set-env-vars — and this is the one
 * value both runtimes have to agree about. One declaration, with a test over it.
 */
export interface DbAddress {
  host: string;
  port: string;
}

/**
 * Cloud Run: a Cloud SQL Auth Proxy sidecar in the same service, on loopback.
 * See `dbContainerArgs`, which carries the account of what that cost to learn.
 */
export const CLOUD_RUN_DB: DbAddress = { host: "127.0.0.1", port: "5432" };

/**
 * The fleet: one proxy per node, on the sandbox bridge gateway.
 *
 * Not a new convention — `bridgeCIDR` in services/fleet/agent/network.go is
 * 10.200.0.1/16 and `SetupSandboxNet` gives every sandbox a default route via
 * it. Every app can reach this by construction.
 *
 * gVisor runs its own network stack, so this could NOT have been 127.0.0.1 with
 * a redirect: loopback inside a sandbox never leaves it, and no rule in the
 * namespace sees that traffic.
 */
export const FLEET_DB: DbAddress = { host: "10.200.0.1", port: "5432" };
```

- [ ] **Step 4: Take the parameter in `databaseEnv`**

In `apps/web/lib/lanes.ts`, replace the `DB_HOST`/`DB_PORT` constants at 45-46:

```ts
import { CLOUD_RUN_DB, type DbAddress } from "./db-address";

/**
 * Kept as names because dbContainerArgs and proxyWait are Cloud Run's sidecar
 * and mean loopback specifically. Anything that can run on either runtime takes
 * a DbAddress instead.
 */
export const DB_HOST = CLOUD_RUN_DB.host;
export const DB_PORT = CLOUD_RUN_DB.port;
```

And give `databaseEnv` the parameter:

```ts
export function databaseEnv(
  db: { databaseUrl: string; user: string; password: string; dbName: string },
  at: DbAddress = CLOUD_RUN_DB,
): string[] {
  return [
    `DATABASE_URL=${db.databaseUrl}`,
    `POSTGRES_SERVER=${at.host}`, `POSTGRES_HOST=${at.host}`, `POSTGRES_PORT=${at.port}`,
    `POSTGRES_USER=${db.user}`, `POSTGRES_PASSWORD=${db.password}`, `POSTGRES_DB=${db.dbName}`,
    `PGHOST=${at.host}`, `PGPORT=${at.port}`,
    `PGUSER=${db.user}`, `PGPASSWORD=${db.password}`, `PGDATABASE=${db.dbName}`,
    `DB_HOST=${at.host}`, `DB_PORT=${at.port}`,
    `DB_USER=${db.user}`, `DB_PASSWORD=${db.password}`, `DB_NAME=${db.dbName}`,
  ];
}
```

- [ ] **Step 5: Run the tests and the typecheck**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/db-address.test.ts
npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: the new file passes, `tsc exit=0`, `fail 0`. `databaseEnvNames()`
derives from `databaseEnv` so it needs no change — confirm it did not.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/db-address.ts apps/web/lib/lanes.ts apps/web/test/db-address.test.ts
git commit -m "Where Postgres answers is a value now, because it differs per runtime

databaseEnv writes ELEVEN variables that name the host — POSTGRES_HOST,
PGHOST, DB_HOST and their ports — so a change that touched only
DATABASE_URL would leave a Django app reading 127.0.0.1 and failing in a
way that looks nothing like this change.

Default unchanged, so the Cloud Run path is untouched by this commit."
git push origin main
```

---

### Task 3: The connection URL is built from that address

`provisionPostgres` builds the URL inline at `deploy-pipeline.ts:623`, inside a
function that shells out to `gcloud` — so the one string every database-backed
app depends on has no test over it. Extract it.

**Files:**
- Modify: `apps/web/lib/db-address.ts`
- Modify: `apps/web/test/db-address.test.ts`
- Modify: `apps/web/lib/deploy-pipeline.ts:623`

**Interfaces:**
- Consumes: `DbAddress`, `CLOUD_RUN_DB`, `FLEET_DB` from Task 2.
- Produces: `databaseUrlFor(role: { user: string; password: string }, dbName: string, at: DbAddress): string`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/db-address.test.ts`:

```ts
import { databaseUrlFor } from "../lib/db-address";

test("the connection URL names the runtime's address", () => {
  const role = { user: "app_x", password: "s3cr3t" };
  assert.equal(databaseUrlFor(role, "x", FLEET_DB), "postgresql://app_x:s3cr3t@10.200.0.1:5432/x");
  assert.equal(databaseUrlFor(role, "x", CLOUD_RUN_DB), "postgresql://app_x:s3cr3t@127.0.0.1:5432/x");
});

test("a password that needs escaping does not silently produce a broken URL", () => {
  // Generated passwords have gone out with characters that are syntax in a URL.
  // A `@` in a password unescaped moves the host, and the app fails to resolve a
  // hostname that is really the tail of a password — which is both a confusing
  // error and a password in a log line.
  const url = databaseUrlFor({ user: "app_x", password: "p@ss/w:rd" }, "x", FLEET_DB);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "10.200.0.1");
  assert.equal(decodeURIComponent(parsed.password), "p@ss/w:rd");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/db-address.test.ts`
Expected: FAIL — `databaseUrlFor is not a function`.

- [ ] **Step 3: Implement it**

Append to `apps/web/lib/db-address.ts`:

```ts
/**
 * The connection URL, which is the one string every database-backed app depends
 * on and which had no test over it: it was built inline inside
 * `provisionPostgres`, a function that shells out to gcloud.
 *
 * The user and password are percent-encoded. A generated password containing
 * `@` moves the host, and the app then fails to resolve a hostname that is
 * really the tail of a password — a confusing error, and a password in a log.
 */
export function databaseUrlFor(
  role: { user: string; password: string },
  dbName: string,
  at: DbAddress,
): string {
  const user = encodeURIComponent(role.user);
  const password = encodeURIComponent(role.password);
  return `postgresql://${user}:${password}@${at.host}:${at.port}/${dbName}`;
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/db-address.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Use it in the pipeline**

In `apps/web/lib/deploy-pipeline.ts`, `provisionPostgres` takes the address and
uses the helper. Replace the inline construction at line 623:

```ts
      const databaseUrl = databaseUrlFor(role, dbName, at);
```

and give the function the parameter (`at: DbAddress`), passing `CLOUD_RUN_DB`
from its single call site for now — Task 7 is what starts passing `FLEET_DB`.
Add the import next to the existing `lanes` import at line 42:

```ts
import { CLOUD_RUN_DB, FLEET_DB, databaseUrlFor, type DbAddress } from "@/lib/db-address";
```

- [ ] **Step 6: Verify nothing moved**

```bash
cd apps/web && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `tsc exit=0`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/db-address.ts apps/web/lib/deploy-pipeline.ts apps/web/test/db-address.test.ts
git commit -m "The connection URL is built in one tested place

It was assembled inline inside provisionPostgres — a function that shells
out to gcloud — so the one string every database-backed app depends on had
no test over it at all.

Escaping comes with it. A generated password containing @ moved the host,
and the app then failed to resolve a hostname that was really the tail of
a password: a confusing error, and a password in a log line."
git push origin main
```

---

### Task 4: `chooseRuntime`, and the database refusal goes

`fleetEligibility` answers "may this app be placed". The pipeline now needs
"where does this app go", which is the same question with an answer that names
the other branch. And the refusal added for databases on 2026-08-04 is exactly
what this plan removes.

**Files:**
- Modify: `apps/web/lib/fleet-place.ts`
- Modify: `apps/web/test/fleet-place.test.ts`

**Interfaces:**
- Consumes: `Lane` from `lib/lanes`.
- Produces:
  - `chooseRuntime(a: { lane: Lane; image: string; staticServe: boolean; serviceless: boolean }): { runtime: Runtime; reason?: string }`
  - `fleetEligibility` keeps its signature **minus** `cloudsql`.

**Do not declare a new runtime type.** `Runtime = "cloudrun" | "fleet"` already
exists at `apps/web/lib/fleet.ts:14`. A second declaration of the same two
strings is the defect this codebase is named after; import it.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/fleet-place.test.ts`, replace the test named
`"an app with a database is not placed, because the fleet has nowhere to put the proxy"`
with:

```ts
test("an app with a database goes to the fleet now that a node has a proxy", () => {
  // The refusal added on 2026-08-04 was a guard for exactly one gap: the fleet
  // had no equivalent of Cloud Run's sidecar. A node runs one now, on the
  // bridge gateway, so the guard is what is wrong.
  assert.equal(chooseRuntime(eligible).runtime, "fleet");
});

test("what the fleet cannot serve is named, and goes to Cloud Run", () => {
  const cases: Array<[Partial<typeof eligible>, RegExp]> = [
    [{ staticServe: true }, /static/i],
    [{ lane: "runner" }, /runner/i],
    [{ image: "" }, /image/i],
    [{ serviceless: true }, /route|worker-only/i],
  ];
  for (const [over, why] of cases) {
    const r = chooseRuntime({ ...eligible, ...over });
    assert.equal(r.runtime, "cloudrun", `${JSON.stringify(over)} should stay on Cloud Run`);
    assert.match(r.reason!, why);
  }
});

test("a placeable app is given no reason, because there is nothing to explain", () => {
  assert.equal(chooseRuntime(eligible).reason, undefined);
});
```

Change the shared fixture at the top of the file from

```ts
const eligible = { lane: "container" as const, image: "img", staticServe: false, serviceless: false, cloudsql: null };
```

to

```ts
const eligible = { lane: "container" as const, image: "img", staticServe: false, serviceless: false };
```

and add `chooseRuntime` to the import from `../lib/fleet-place`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: FAIL — `chooseRuntime is not a function`.

- [ ] **Step 3: Implement**

In `apps/web/lib/fleet-place.ts`, delete the whole `if (a.cloudsql)` block from
`fleetEligibility` and drop `cloudsql` from its parameter type. Then add:

```ts
import type { Runtime } from "./fleet";

/**
 * Where this app is deployed. Decided BEFORE anything is deployed.
 *
 * The same judgement `fleetEligibility` makes, with an answer that names the
 * other branch — because the pipeline no longer deploys to Cloud Run and then
 * also places. A database-backed app under that shape failed its first step, on
 * the runtime it was leaving, for a reason belonging to the runtime it was
 * going to.
 */
export function chooseRuntime(a: {
  lane: Lane;
  image: string;
  staticServe: boolean;
  serviceless: boolean;
}): { runtime: Runtime; reason?: string } {
  const can = fleetEligibility(a);
  return can.ok ? { runtime: "fleet" } : { runtime: "cloudrun", reason: can.reason };
}
```

`lib/fleet.ts` imports nothing from `lib/fleet-place.ts`, so importing the type
the other way introduces no cycle. Check that it still holds before you write it.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: PASS.

Then fix the one caller that still passes `cloudsql` — `deploy-pipeline.ts`, the
`fleetEligibility({ ... })` call — and typecheck:

```bash
cd apps/web && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"; head -5 /tmp/tsc.out
```

Expected: `tsc exit=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts apps/web/lib/deploy-pipeline.ts
git commit -m "Where an app is deployed is decided before it is deployed

chooseRuntime answers the question the pipeline is about to start asking,
and the database refusal goes with it — it was a guard for exactly one
gap, and a node has a proxy now.

Four refusals remain and each names itself: static has no image of its
own, the runner lane's image is not the app's, a build that produced no
image has nothing to place, and a worker-only app publishes no route to
verify through. The last is a limit of the CHECK, not of the fleet."
git push origin main
```

---

### Task 5: A failed deploy leaves the previous version serving

`placeOnFleet` currently rolls back by calling `setRuntime(slug, 'cloudrun')`.
Under one-way there is nothing to roll back *to* — and the placement row has
already been overwritten with the new spec by the time the probe fails, so doing
nothing would leave a broken version placed.

**Files:**
- Modify: `apps/web/lib/fleet-place.ts`
- Modify: `apps/web/test/fleet-place.test.ts`
- Modify: `apps/web/lib/fleet.ts` (add `placementFor`)

**Interfaces:**
- Consumes: `AppSpec` from `lib/fleet-spec`.
- Produces:
  - `placementFor(slug: string): Promise<AppSpec | null>` in `lib/fleet.ts`
  - `PlacementPorts` gains `readPlacement: (slug: string) => Promise<AppSpec | null>`
    and **loses** nothing; `setRuntime` stays, it is still how an app is marked
    as living on the fleet.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/fleet-place.test.ts`, replace
`"an app that does not answer from the fleet is put back, before anything routes to it"`:

```ts
test("a version that does not answer is replaced by the one that did", async () => {
  const previous: AppSpec = { ...spec, image: "registry/myapp:good" };
  const { calls, p } = ports({
    probe: async () => ({ code: 502 }),
    readPlacement: async () => { calls.push("read"); return previous; },
  });
  const r = await placeOnFleet("myapp", { ...spec, image: "registry/myapp:bad" }, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.equal(r.runUrl, undefined);
  // The previous spec is put back, because placing the new one already
  // overwrote the row — doing nothing would leave the broken version placed.
  assert.ok(calls.includes("place:myapp@fleet-lab-1:registry/myapp:good"),
    `previous spec was not restored — calls were ${calls.join(", ")}`);
  // And nothing goes to Cloud Run. There is no way back any more.
  assert.ok(!calls.some((c) => c.includes("cloudrun")), "an app was sent back to Cloud Run");
});

test("a first deploy that fails is unplaced rather than restored to nothing", async () => {
  // No previous placement exists, so there is nothing to put back and the app
  // must not be left pointing at a version that does not serve.
  const { calls, p } = ports({ probe: async () => ({ code: 0 }), readPlacement: async () => null });
  const r = await placeOnFleet("myapp", spec, "8.232.255.172", p);

  assert.equal(r.placed, false);
  assert.ok(calls.includes("unplace:myapp"), `calls were ${calls.join(", ")}`);
});
```

Update the `ports()` helper to record the image and the new port:

```ts
  const base: PlacementPorts = {
    chooseNode: async () => { calls.push("chooseNode"); return "fleet-lab-1"; },
    placeApp: async (slug, node, s) => { calls.push(`place:${slug}@${node}:${s.image}`); },
    unplaceApp: async (slug) => { calls.push(`unplace:${slug}`); },
    readPlacement: async () => null,
    setRuntime: async (slug, rt) => { calls.push(`runtime:${slug}=${rt}`); },
    probe: async () => { calls.push("probe"); return { code: 200 }; },
    log: () => {},
  };
```

and the happy-path order test becomes:

```ts
  assert.deepEqual(calls, ["chooseNode", "read", "place:myapp@fleet-lab-1:" + spec.image, "runtime:myapp=fleet", "probe"]);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: FAIL — `readPlacement` is not a property of the ports object, and the
restore assertion does not hold.

- [ ] **Step 3: Add `placementFor` to `lib/fleet.ts`**

```ts
/** The spec a node is currently running for this app, or null if it has none. */
export async function placementFor(slug: string): Promise<AppSpec | null> {
  const r = await getPool(DB).query(`SELECT spec FROM fleet_placements WHERE slug = $1 LIMIT 1`, [slug]);
  return (r.rows[0]?.spec as AppSpec) ?? null;
}
```

- [ ] **Step 4: Rewrite the failure path in `placeOnFleet`**

```ts
export interface PlacementPorts {
  chooseNode: () => Promise<string | null>;
  placeApp: (slug: string, node: string, spec: AppSpec) => Promise<void>;
  unplaceApp: (slug: string) => Promise<void>;
  readPlacement: (slug: string) => Promise<AppSpec | null>;
  setRuntime: (slug: string, runtime: Runtime) => Promise<void>;
  probe: (slug: string) => Promise<{ code: number; router?: string }>;
  log: (line: string) => void;
}
```

and in the body, read before placing and restore after a failed verdict:

```ts
  // Read BEFORE placing: placing overwrites the row, so after that the version
  // that was working is only knowable from here.
  const previous = await p.readPlacement(slug);

  await p.placeApp(slug, node, spec);
  await p.setRuntime(slug, "fleet");

  const verdict = fleetVerdict(await p.probe(slug));
  if (!verdict.ok) {
    // There is no Cloud Run to fall back to any more, so the fallback is the
    // last version that answered. With none — a first deploy — the placement is
    // dropped rather than left pointing at something that does not serve.
    if (previous) {
      await p.placeApp(slug, node, previous);
      p.log(`· kept the previous version — ${verdict.reason}`);
    } else {
      await p.unplaceApp(slug);
      p.log(`· nothing placed — ${verdict.reason}`);
    }
    return { placed: false, reason: verdict.reason };
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/fleet.ts apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts
git commit -m "A failed deploy keeps the version that worked, not Cloud Run

setRuntime(slug,'cloudrun') was the rollback, and there is no Cloud Run to
roll back to any more. Doing nothing instead would be worse than either:
placing the new spec has already overwritten the row by the time the probe
fails, so the broken version would be the one left placed.

So the previous spec is read BEFORE the new one is placed — after that it
is only knowable from there — and put back on failure. A first deploy has
no previous version, so it is unplaced rather than left pointing at
something that does not serve."
git push origin main
```

---

### Task 6: The fleet probe asks the app's own health path

`fleetProbe` requests `/`. The spec requires the check to touch the database,
and an app already declares where that is — `health.path` in its config, which
`primaryHealth` carries and `probeApp` already uses on the Cloud Run side.

**Files:**
- Modify: `apps/web/lib/fleet-place.ts`
- Modify: `apps/web/test/fleet-place.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fleetProbe(loadBalancer, slug, opts?: { path?: string; fetchImpl?: typeof fetch; attempts?: number; delayMs?: number })`

- [ ] **Step 1: Write the failing test**

```ts
test("the probe asks the path the app said to ask", async () => {
  // A 200 at the root proves a process started. epvmx proved a started process
  // can refuse every real request, and an app whose database is unreachable
  // serves its homepage perfectly happily — which is the exact failure this
  // whole piece of work is about not shipping.
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;

  await fleetProbe("8.232.255.172", "myapp", { fetchImpl: impl, attempts: 1, delayMs: 0, path: "/healthz" });
  assert.deepEqual(seen, ["http://8.232.255.172/healthz"]);
});

test("no declared path means the root, which is what every app has", async () => {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;

  await fleetProbe("8.232.255.172", "myapp", { fetchImpl: impl, attempts: 1, delayMs: 0 });
  assert.deepEqual(seen, ["http://8.232.255.172/"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: FAIL — the first test sees `http://8.232.255.172/`.

- [ ] **Step 3: Implement**

In `fleetProbe`, accept and use the path:

```ts
export async function fleetProbe(
  loadBalancer: string,
  slug: string,
  opts: { fetchImpl?: typeof fetch; attempts?: number; delayMs?: number; path?: string } = {},
): Promise<{ code: number; router?: string }> {
  const f = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 24;
  const delayMs = opts.delayMs ?? 5000;
  // The app's own health path, so a database-backed app is checked on a request
  // that needs the database. Its root would answer 200 with no database at all.
  const path = opts.path?.startsWith("/") ? opts.path : `/${opts.path ?? ""}`;
```

and use `` `http://${loadBalancer}${path}` `` in the fetch.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts
git commit -m "Ask the app where it said to ask

The fleet probe requested the root. A 200 at the root proves a process
started, and epvmx proved a started process can refuse every real request
— an app whose database is unreachable serves its homepage happily, which
is precisely the failure this work must not ship.

The app already declares a health path and the Cloud Run probe already
uses it. Now both do."
git push origin main
```

---

### Task 7: The pipeline forks on runtime

The structural change. `runDeploy()` at `deploy-pipeline.ts:2990` is the Cloud
Run path; it gains a sibling, and the fork decides which runs.

**Files:**
- Modify: `apps/web/lib/deploy-pipeline.ts` — around `:2990`, and the placement
  block added on 2026-08-04 near `:3284`

**Interfaces:**
- Consumes: `chooseRuntime`, `placeOnFleet`, `fleetProbe` (Task 4, 5, 6),
  `buildAppSpec` from `lib/fleet-spec`, `FLEET_DB`/`databaseUrlFor` (Tasks 2–3),
  `placementFor`, `placeApp`, `unplaceApp`, `setRuntime`, `chooseNode` from `lib/fleet`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Decide the runtime before the deploy**

Immediately before `let result = await runDeploy();`, replace the log line and
add the decision. **The canary gate stays** — `chooseRuntime` says what the fleet
*can* serve, and `fleetPlacementWanted` says what it is *allowed* to serve yet.
Task 10 removes the second half after one app has proved the path; without it,
the first app to prove this is whichever one somebody happens to deploy.

```ts
    const target = chooseRuntime({ lane, image: processImage ?? "", staticServe: !!staticServe, serviceless });
    const toFleet = target.runtime === "fleet" && fleetPlacementWanted(process.env, slug);
    if (target.reason) log(`Deploying ${slug} to Cloud Run — ${target.reason}`);
    else if (!toFleet) log(`Deploying ${slug} to Cloud Run — the fleet could take it, but it is not a canary yet`);
    else log(`Deploying ${slug} to the fleet…`);
```

- [ ] **Step 2: Give the database the right address**

`provisionPostgres` is called earlier than this decision, so hoist both lines
above it and pass the address.

**Derive the address from `toFleet`, not from `target.runtime`.** They differ for
exactly the apps this gate exists for: an app the fleet could serve but which is
not a canary deploys to Cloud Run, and giving it `FLEET_DB` would hand a Cloud
Run revision an address it cannot reach — the same failure this whole task
exists to stop, arriving through the back door.

```ts
    const dbAt = toFleet ? FLEET_DB : CLOUD_RUN_DB;
    // …and at the provisionPostgres call site:
    const db = await provisionPostgres(slug, log, dbAt);
    // …and wherever databaseEnv is called for this app:
    extraEnv.push(...databaseEnv(db, dbAt));
```

- [ ] **Step 3: Write the fleet branch**

```ts
    /**
     * The fleet branch. No Cloud Run service is created at all.
     *
     * The image is already built by the time this runs — building is shared, it
     * is only the delivery that forks. Verification is the load balancer with
     * the app's own health path, because that is the path real traffic takes and
     * the one a database-backed app fails on when its database is unreachable.
     */
    const runFleetDeploy = async (): Promise<{ ok: boolean; url?: string; error?: string }> => {
      if (!FLEET_LB) return { ok: false, error: "no fleet load balancer is configured" };
      const built = processImage ?? await liveContainerImage(slug);
      if (!built) return { ok: false, error: "this deploy produced no image to place" };

      const placement = await placeOnFleet(
        slug,
        buildAppSpec({
          slug, image: built, env: extraEnv,
          secrets: await allAppSecrets(slug, secretRefs),
          processes, healthPath: primaryHealth.health.path,
        }),
        FLEET_LB,
        {
          chooseNode, placeApp, unplaceApp, readPlacement: placementFor, setRuntime,
          probe: (s) => fleetProbe(FLEET_LB, s, { path: primaryHealth.health.path }),
          log,
        },
      );
      return placement.placed
        ? { ok: true, url: placement.runUrl }
        : { ok: false, error: placement.reason ?? "the app did not answer from the fleet" };
    };
```

- [ ] **Step 4: Take one branch**

```ts
    const firstAttempt = stages.start(ACTIVATION_STAGE);
    let result = toFleet ? await runFleetDeploy() : await runDeploy();
    await stages.end(firstAttempt, result.ok ? "ok" : "failed");
```

- [ ] **Step 5: Delete the additive placement block**

Remove the `if (fleetPlacementWanted(process.env, slug) && result.ok) { … }`
block added on 2026-08-04 and the `fleetUrl` variable, and take the url from
`result` instead:

```ts
      await markAppLive(slug, result.url ?? "", null, routes);
```

The `fleet` stage name stays in `LANE_KNOWN_STAGES` — `placeOnFleet` is still
what writes it, now from inside the branch.

- [ ] **Step 6: Verify**

```bash
cd apps/web && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"; head -10 /tmp/tsc.out
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
node --experimental-test-module-mocks --import tsx --test test/stages.test.ts 2>&1 | grep -E "^# (pass|fail)"
```

Expected: `tsc exit=0`, `fail 0`. The stage-vocabulary test must still pass — it
is what catches a stage name that is written and not declared.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/deploy-pipeline.ts
git commit -m "One runtime per deploy, chosen before anything is deployed

The additive shape — deploy to Cloud Run, verify there, then also place —
cannot survive a database. DATABASE_URL on the fleet names an address a
Cloud Run revision cannot reach, so a database-backed app failed its FIRST
step, on the runtime it was leaving, for a reason belonging to the runtime
it was going to.

Building is still shared; only delivery forks. Verification on the fleet
is the load balancer with the app's own health path.

No Cloud Run service is created for a fleet app at all, which is the point
— two live runtimes per app is where this week's defects came from."
git push origin main
```

---

### Task 8: Release runs on the node, not as a Cloud Run job

A database-backed app has migrations, and "reads and writes" is not provable
without them. Release is a process kind the agent already runs to completion
before web and worker start (`processesOf`, `KindRelease`, and the `released` map
keyed by image so it runs once). What is missing is that the pipeline still runs
release through `lib/release-job.ts` as a Cloud Run Job.

> **Scope note for the reviewer:** the spec puts scheduled and background
> processes in piece 2 and does not mention release. It is here because success
> criterion 5 — an app that reads and writes — cannot be met without it. Flag
> this if you disagree; do not silently widen it further.

**Files:**
- Modify: `apps/web/lib/deploy-pipeline.ts` — the release-job call site
- Modify: `apps/web/test/fleet-spec.test.ts`

**Interfaces:**
- Consumes: `buildAppSpec` (unchanged), `releaseCommand` from `lib/app-config`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/fleet-spec.test.ts`:

```ts
test("a release command reaches the node as a release process", () => {
  // The agent runs KindRelease to completion BEFORE web and worker start, and
  // keys it by image so a slow start does not run a customer's migration twice
  // concurrently. All of that is wasted if the command never arrives.
  const spec = buildAppSpec({
    ...base,
    processes: [
      resolveProcess("release", { command: "python manage.py migrate" }),
      resolveProcess("web", { command: "gunicorn app:wsgi" }),
    ] as ResolvedProcess[],
  });

  const release = spec.processes?.find((p) => p.name === "release");
  assert.equal(release?.kind, "release");
  assert.deepEqual(release?.command, ["/bin/sh", "-c", "python manage.py migrate"]);
});
```

- [ ] **Step 2: Run it and watch it pass — then write the one that fails**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-spec.test.ts`
Expected: PASS. A release process declared in a **Procfile** already arrives:
`buildAppSpec` maps every `ResolvedProcess`, release included.

The gap is a release declared in **config**. `deploy-pipeline.ts:483` treats
`processes.some(p => p.kind === "release")` and `releaseCommand(config)` as two
separate things, so a config-declared release has only ever existed as a Cloud
Run Job and never reaches the placement spec. Add the failing test for that:

```ts
test("a release declared in config, not a Procfile, still reaches the node", () => {
  // deploy-pipeline.ts:483 treats a release PROCESS and a release COMMAND as
  // separate things, because on Cloud Run they were: one is a Procfile line and
  // the other is a job. On a node there is one primitive, so the command has to
  // arrive as a process or the app's migrations simply never run.
  const spec = buildAppSpec({
    ...base,
    processes: [resolveProcess("web", { command: "gunicorn app:wsgi" })] as ResolvedProcess[],
    releaseCommand: "python manage.py migrate",
  });

  const release = spec.processes?.find((p) => p.name === "release");
  assert.equal(release?.kind, "release");
  assert.deepEqual(release?.command, ["/bin/sh", "-c", "python manage.py migrate"]);
});
```

Run it. Expected: FAIL — `SpecInput` has no `releaseCommand`.

- [ ] **Step 3: Make a config-declared release become a process**

Add the optional field to `SpecInput` in `apps/web/lib/fleet-spec.ts` and
synthesise the process when it is present and no `release` process was declared:

```ts
  /**
   * A release declared in config rather than in a Procfile.
   *
   * On Cloud Run these were two different mechanisms — a Procfile line became a
   * process, and this became a job — so nothing ever needed them to agree. A
   * node has one primitive, and an app whose migrations never run is an app that
   * serves its homepage and fails everything else.
   */
  releaseCommand?: string | null;
```

```ts
  const declared = i.processes.map(agentProcess);
  if (i.releaseCommand && !declared.some((p) => p.name === "release")) {
    declared.push({ name: "release", kind: "release", command: shellArgv(i.releaseCommand) });
  }
  if (declared.length) spec.processes = declared;
```

Then pass it at the `buildAppSpec` call site in Task 7's `runFleetDeploy`:

```ts
          releaseCommand: appConfig ? releaseCommand(appConfig) : null,
```

Where `processes` is read (`deploy-pipeline.ts:1928`, `readProcesses(...)`), if
`releaseCommand(appConfig)` returns a command and no process named `release`
exists, append one:

```ts
    // A release declared in config rather than a Procfile has always been run by
    // lib/release-job.ts as a Cloud Run Job. On the fleet a release is an
    // ordinary process, so it has to arrive as one.
    const declaredRelease = appConfig ? releaseCommand(appConfig) : null;
    if (declaredRelease && !processes.some((p) => p.name === "release")) {
      processes.push(resolveProcess("release", { command: declaredRelease }));
    }
```

- [ ] **Step 3b: Skip the Cloud Run release job on the fleet branch**

Guard the existing release-job call with `!toFleet` — the same value the deploy
branch used, so the release and the app can never disagree about where they are —
and log the fleet case so it is not silent:

```ts
    if (toFleet) log("release runs on the node, before the app starts");
```

- [ ] **Step 5: Verify**

```bash
cd apps/web && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `tsc exit=0`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/deploy-pipeline.ts apps/web/test/fleet-spec.test.ts
git commit -m "A release is a process on the node, not a job somewhere else

An app with a database has migrations, and 'it reads and writes' is not
provable without them. The agent already runs a release process to
completion before web and worker start, keyed by image so a slow start
does not run a customer's migration twice at once.

What was missing is that a release declared in config — rather than in a
Procfile — only ever existed as a Cloud Run Job, so it never arrived in
the placement spec at all."
git push origin main
```

---

### Task 9: The agent says "the database path is down", not "your app is broken"

From the spec's risks. If the proxy is dead, every database-backed app on the
node fails to start, and without this the repair agent is handed a customer's
repository to fix over our own outage — at roughly $12–15 a run.

**Files:**
- Modify: `services/fleet/agent/secrets.go`
- Create: `services/fleet/agent/secrets_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `dbPathReachable(addr string, timeout time.Duration) error`

- [ ] **Step 1: Write the failing test**

Create `services/fleet/agent/secrets_test.go`:

```go
package main

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestDBPathReachableReportsTheNodeNotTheApp(t *testing.T) {
	// A listener that exists is enough: this asks "is the database path up on
	// this node", not "is Postgres healthy".
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	if err := dbPathReachable(ln.Addr().String(), time.Second); err != nil {
		t.Fatalf("a live listener should be reachable: %v", err)
	}
}

func TestDBPathUnreachableNamesTheNode(t *testing.T) {
	// The message is the whole point. An app that cannot reach the database is
	// indistinguishable from an app that is broken, and the repair agent will
	// go and edit a customer's repository over our outage.
	err := dbPathReachable("127.0.0.1:1", 200*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a port nothing listens on")
	}
	if !strings.Contains(err.Error(), "node") {
		t.Fatalf("the error must blame the node, got: %v", err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd services/fleet/agent && go test ./...`
Expected: FAIL — `undefined: dbPathReachable`.

- [ ] **Step 3: Implement**

Append to `services/fleet/agent/secrets.go`:

```go
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
```

Add `"net"` and `"time"` to that file's imports.

- [ ] **Step 4: Call it before starting an app that has a database**

Where secrets are resolved before a sandbox is created, if any resolved
environment variable names the database path, check it first:

```go
	if hasDatabase(app) {
		if err := dbPathReachable("10.200.0.1:5432", 3*time.Second); err != nil {
			return nil, err
		}
	}
```

with:

```go
// hasDatabase is true when this app was given a database by the platform.
func hasDatabase(app App) bool {
	if _, ok := app.Secrets["DATABASE_URL"]; ok {
		return true
	}
	_, ok := app.Env["DATABASE_URL"]
	return ok
}
```

- [ ] **Step 5: Run the tests and build for the node's platform**

```bash
cd services/fleet/agent && go test ./... && GOOS=linux GOARCH=amd64 go build -o /dev/null ./... && GOOS=linux GOARCH=amd64 go vet ./...
echo "exit=$?"
```

Expected: `ok`, then `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add services/fleet/agent/secrets.go services/fleet/agent/secrets_test.go
git commit -m "A dead database path blames the node, not the app

If the host proxy is down, every database-backed app on the node fails to
start — and that is indistinguishable from a broken app, so the repair
agent goes and edits a customer's repository over our own outage, at
roughly \$12-15 a run.

Checked before the sandbox exists, the same rule secrets.go already
follows: a missing DATABASE_URL produces a process that comes up, passes a
health check on '/' and fails every request that touches data, which is
worse than not starting."
git push origin main
```

---

### Task 10: Prove it on one app, then make the fleet the default

**Files:**
- Modify: `apps/web/lib/fleet-place.ts` (delete `fleetPlacementWanted`)
- Modify: `apps/web/test/fleet-place.test.ts`
- Modify: `apps/web/lib/deploy-pipeline.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Point the canary at one app and deploy it**

The operator runs this — the assistant's prod mutations are blocked:

```
gcloud run jobs update supersonic-deploy-job --project supersonic-deploy-prod \
  --region us-central1 --update-env-vars FLEET_APPS=<slug>
```

Then deploy an app that **has a database and a migration**. A Django or Prisma
template is the right shape; `t1cyj` is not — it has no repository recorded and
cannot be redeployed.

- [ ] **Step 2: Check what the deploy log says, and do not accept a green light without it**

Expected in order: `Deploying <slug> to the fleet…`, the release running, then
`Running on fleet-lab-1`. If instead it says `Deploying <slug> to Cloud Run — <reason>`,
the reason is the bug; fix that rather than forcing the branch.

- [ ] **Step 3: Prove the database, not the homepage**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "x-supersonic-slug: <slug>" http://8.232.255.172/<health-path>
```

Then write a row through the app's own UI or API, restart the app
(`fleetctl.sh` restart, or place the same spec again), and read the row back.
A 200 at the root proves nothing here — that is the whole reason this task
exists.

- [ ] **Step 4: Make the fleet the default and delete the flags**

Delete `fleetPlacementWanted` from `lib/fleet-place.ts`, its test, and its use in
the pipeline. `chooseRuntime` is the only decision left.

A flag nobody can turn off is a branch pretending to be a choice, so it goes
rather than being left defaulting to true.

- [ ] **Step 5: Verify the whole tree**

```bash
cd apps/web && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "tsc exit=$?"
npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
npm run build > /tmp/build.out 2>&1; echo "build exit=$?"
cd ../../services/fleet/agent && GOOS=linux GOARCH=amd64 go vet ./...; echo "vet exit=$?"
```

Expected: `tsc exit=0`, `fail 0`, `build exit=0`, `vet exit=0`.

- [ ] **Step 6: Ask the operator to remove the canary variables**

```
gcloud run jobs update supersonic-deploy-job --project supersonic-deploy-prod \
  --region us-central1 --remove-env-vars FLEET_APPS,FLEET_PLACEMENT
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts apps/web/lib/deploy-pipeline.ts
git commit -m "The fleet is where apps go

Proven on one database-backed app first — deployed from nothing, migrated,
written to, restarted, read back — which is what FLEET_APPS existed for.

The flags go rather than being left switched on. A flag nobody can turn
off is a branch pretending to be a choice, and this codebase has paid for
that shape before."
git push origin main
```

---

## What this plan does not do

Named so nobody has to guess whether they were forgotten: scheduled and
background processes on the fleet (piece 2), static apps (3), deleting the runner
lane (4), HTTPS and the DNS cutover (5), a second node (6), and deleting the
Cloud Run code (7).

The Cloud Run branch is still reachable after this plan, for static, runner-lane
and worker-only apps. It is not dead code until those three have somewhere else
to go.

Two of the spec's risks are carried, not closed, and neither should be reported
as handled:

- **One proxy process serving every app on a node** is still unmeasured. Twenty
  apps today, so it is not urgent; the number to take is connections and latency
  at the point app counts reach three figures.
- **The shared instance's connection limit.** The proxy does not pool, so this
  is exactly as it was on Cloud Run — no worse, and no better.

`10.200.0.1` becoming load-bearing IS handled, as far as it can be: Task 2 puts
it in one exported constant with a test, so changing it is a one-line change
rather than a search.
