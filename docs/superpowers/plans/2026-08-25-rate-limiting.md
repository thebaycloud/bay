# Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. This session's standing instruction is that subagents are not used
> unless the user asks, so subagent-driven-development is NOT the route here.

**Goal:** Bound the rate of requests against signup, login and the tenant edge —
three surfaces that today have no rate limit of any kind.

**Architecture:** Three layers, delivered separately because their risk profiles
differ. Cloud Armor on the two backend services that already sit behind the load
balancer (configuration, no migration). A ceiling on control-plane `maxScale`
(one setting). And a Postgres-backed limiter in the application, built on the
atomic check-and-increment `lib/usage.ts:countIfUnder` already uses, wired into
signup and login behind a flag that counts before it ever refuses.

**Tech Stack:** TypeScript, Next.js 14 App Router, Postgres (Cloud SQL,
`supersonic_platform`), `node:test` with `mock.module`, next-auth 5.0.0-beta.32,
gcloud for Cloud Armor and Cloud Run.

**Spec:** `docs/superpowers/specs/2026-08-25-rate-limiting-design.md`

## Global Constraints

- **Migrations are idempotent and re-applied every run.** `db/migrate.ts` sorts
  `^\d+_.*\.sql$` and runs all of them every time; there is no tracking table.
  Every statement must be `IF NOT EXISTS`-shaped.
- **Next migration number is `036`.** Highest existing is `035_user_image.sql`.
- **Tests never touch Postgres.** `getPool` points at `127.0.0.1:5433`, so a
  test that "just tried it" mutates production on any machine running
  cloud-sql-proxy. Mock `@/lib/db` with `mock.module`, as `test/plan-limits.test.ts` does.
- **Imports of mocked modules must be deferred**, `const x$ = import("@/lib/x")`,
  never a static import: tsx compiles to CJS where a static import hoists above
  `mock.module` and loads the real module. CJS also means no top-level await.
- **Env vars are read at module load**, so a test must set them before its
  deferred import resolves.
- **Every push to `main` deploys production** and no CI runs the 1593 tests.
  Work on a branch. Do not push to `main` without saying so.
- **House style:** comments explain *why*, at length, and name the incident that
  caused the code. Commit messages are prose that argues, not a diff summary.
- **`--update-secrets`, never `--set-secrets`** on gcloud (the latter replaced a
  whole list and wiped a service once). Commas in `--update-env-vars` need the
  `^~~^` delimiter escape.

---

### Task 1: Cloud Armor on the two backends that are already behind the load balancer

Production configuration. No code, no migration, nothing to roll back through
git. **Requires the user's explicit go-ahead before running** — it changes how
live tenant traffic is filtered.

**Files:**
- Create: `docs/adr/0006-rate-limiting-at-the-edge.md`
- No source changes

**Interfaces:**
- Consumes: nothing
- Produces: two security policies, `bay-edge-throttle` attached to
  `supersonic-proxy-backend` and `fleet-backend`. No code depends on them.

- [ ] **Step 1: Confirm both backends are still unprotected**

```bash
gcloud compute backend-services list --global \
  --format="table(name,securityPolicy)"
```

Expected: `supersonic-proxy-backend` and `fleet-backend`, both with an empty
`SECURITY_POLICY`. If either already has one, stop and re-read this task — some
other session got here first.

- [ ] **Step 2: Create the policy with a default-allow rule**

```bash
gcloud compute security-policies create bay-edge-throttle \
  --description="Per-IP volumetric throttle for tenant traffic. See docs/adr/0006."
```

- [ ] **Step 3: Add the per-IP rate limit rule**

600 requests per minute per IP, ban for 10 minutes on breach. A tenant app
serving a normal page load makes tens of requests, so 600/min is roughly ten
page loads a second from one address — far above a person, far below a flood.

```bash
gcloud compute security-policies rules create 1000 \
  --security-policy=bay-edge-throttle \
  --expression="true" \
  --action=rate-based-ban \
  --rate-limit-threshold-count=600 \
  --rate-limit-threshold-interval-sec=60 \
  --ban-duration-sec=600 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP
```

- [ ] **Step 4: Attach to the proxy backend in preview mode first**

Preview logs what it *would* have blocked without blocking it. This is the same
instinct as the limiter's count-only mode in Task 4: the threshold above is a
guess, and finding out it was wrong by refusing real tenant traffic is the
expensive way to learn.

```bash
gcloud compute security-policies update bay-edge-throttle --enable-layer7-ddos-defense
gcloud compute backend-services update supersonic-proxy-backend --global \
  --security-policy=bay-edge-throttle
gcloud compute security-policies rules update 1000 \
  --security-policy=bay-edge-throttle --preview
```

- [ ] **Step 5: Verify a normal request still succeeds**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://thebay.cloud/
```

Expected: `200`. If this is anything else, detach immediately:
`gcloud compute backend-services update supersonic-proxy-backend --global --no-security-policy`

- [ ] **Step 6: Read what preview mode would have blocked, after 24h**

```bash
gcloud logging read \
  'resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.outcome="ACCEPT"
   AND jsonPayload.previewSecurityPolicy.outcome="DENY"' \
  --limit=20 --freshness=1d \
  --format="value(jsonPayload.remoteIp,httpRequest.requestUrl)"
```

Empty output means the threshold refuses nobody who is currently using the
product, and the rule can leave preview. Non-empty output is the list of people
it would have broken — read it before deciding.

- [ ] **Step 7: Write the ADR**

`docs/adr/0006-rate-limiting-at-the-edge.md` records: why the edge layer covers
only tenant traffic (the control plane is a Cloud Run domain mapping, not a load
balancer backend), why 600/min was chosen, why preview came before enforcement,
and the fact that leaving preview is a separate decision made against Step 6's
output rather than on a schedule.

- [ ] **Step 8: Attach to `fleet-backend` the same way, once the proxy has been
      enforcing for a week without complaint**

```bash
gcloud compute backend-services update fleet-backend --global \
  --security-policy=bay-edge-throttle
```

- [ ] **Step 9: Commit the ADR**

```bash
git add docs/adr/0006-rate-limiting-at-the-edge.md
git commit -m "The edge learns to throttle, and only where the edge exists"
```

---

### Task 2: Cap what a flood of the control plane can cost

**Files:**
- Modify: `.github/workflows/deploy.yml` (the `--max-instances` on the control
  plane deploy, so the console and the repository cannot disagree)

**Interfaces:**
- Consumes: nothing
- Produces: nothing code depends on

- [ ] **Step 1: Read the current value from the workflow, not the console**

```bash
grep -n "max-instances\|maxScale" .github/workflows/deploy.yml cloudbuild.yaml
```

If the deploy does not set it explicitly, the live value of 100 is a Cloud Run
default and the fix belongs in the workflow so the next deploy does not undo it.

- [ ] **Step 2: Confirm what the service actually runs today**

```bash
gcloud run services describe supersonic-control-plane --region=us-central1 \
  --format="value(spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'])"
```

Expected: `100`.

- [ ] **Step 3: Set the ceiling to 30 in the deploy workflow**

Add `--max-instances=30` to the control-plane deploy step. 30 is roughly three
times the highest instance count the service has ever reached; it does not
constrain normal operation and it bounds a flood's bill to something survivable.

The comment above it must say what it trades, in the house's voice: this
protects the invoice, not availability. Past 30 instances a real traffic spike
queues instead of scaling, and that is the accepted cost until the control plane
sits behind a load balancer where Cloud Armor can refuse the flood outright.

- [ ] **Step 4: Verify the workflow file parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('ok')"
```

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "A flood of the control plane now has a ceiling on what it costs"
```

Note: this takes effect on the next deploy of `main`. Applying it to the running
service immediately is a separate, deliberate command — do it only if asked.

---

### Task 3: Find out which client IP can be trusted, by measuring it

This is the task the whole limiter rests on. Parsed wrong, an IP-keyed limit is
defeated by one forged header and still reports green. The parse rule is
therefore **measured on a throwaway service**, never read out of documentation.

A throwaway service rather than a temporary log line in production: it answers
the identical question — the same Cloud Run frontend sits in front of both — and
it does not require deploying instrumented code to the control plane, which
today would mean a production deploy with no CI behind it.

**Files:**
- Create: `apps/web/lib/client-ip.ts`
- Create: `apps/web/test/client-ip.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `clientIp(req: Request): string | null` — used by Tasks 5 and 6.

- [ ] **Step 1: Deploy a throwaway echo service**

```bash
gcloud run deploy xff-probe \
  --image=docker.io/mendhak/http-https-echo:31 \
  --region=us-central1 --allow-unauthenticated --port=8080 \
  --max-instances=1
```

- [ ] **Step 2: Ask it what an honest request looks like**

```bash
URL=$(gcloud run services describe xff-probe --region=us-central1 --format='value(status.url)')
curl -sS "$URL" | python3 -c "import json,sys; h=json.load(sys.stdin)['headers']; print(h.get('x-forwarded-for'))"
```

Record the output. This is the header with no client-supplied value in it.

- [ ] **Step 3: Ask it what a forged request looks like**

```bash
curl -sS -H "X-Forwarded-For: 203.0.113.9" "$URL" | \
  python3 -c "import json,sys; h=json.load(sys.stdin)['headers']; print(h.get('x-forwarded-for'))"
```

Record the output. Compare against Step 2. The question being answered is:
**where in the list did Google put the real peer, counting from the end?** The
forged `203.0.113.9` is at a known position, and the real address is the one
that is not it.

- [ ] **Step 4: Confirm against the value Google computes itself**

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="xff-probe"' \
  --limit=5 --freshness=10m --format="value(httpRequest.remoteIp)"
```

`httpRequest.remoteIp` is written by the platform and cannot be influenced by
the request. Whichever element of the header matches this is the trustworthy
one; that offset from the end of the list is the constant in Step 6.

- [ ] **Step 5: Delete the throwaway service**

```bash
gcloud run services delete xff-probe --region=us-central1 --quiet
```

- [ ] **Step 6: Write the failing test, using the two strings recorded above**

Replace `<STEP2>` and `<STEP3>` with the exact header values measured, and
`<REAL_IP>` with the address from Step 4. Do not invent them — the point of this
test is that it encodes evidence.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "@/lib/client-ip";

function req(xff?: string): Request {
  return new Request("https://app.thebay.cloud/api/signup", {
    headers: xff ? { "x-forwarded-for": xff } : {},
  });
}

test("an honest request yields the address Cloud Run reported", () => {
  assert.equal(clientIp(req("<STEP2>")), "<REAL_IP>");
});

test("a forged leading entry does not become the key", () => {
  // The whole reason this module exists. Taking the FIRST element here would
  // return 203.0.113.9 — a value the attacker chose — and every request could
  // choose a different one, so no bucket would ever fill.
  const got = clientIp(req("<STEP3>"));
  assert.notEqual(got, "203.0.113.9");
  assert.equal(got, "<REAL_IP>");
});

test("no header at all is null, not a shared bucket", () => {
  // Returning a constant like "unknown" would put every header-less request in
  // one bucket, so a handful of them would lock out all the others. Null means
  // the caller decides, and the callers in this codebase fall back to a key
  // that is not the IP.
  assert.equal(clientIp(req()), null);
});
```

- [ ] **Step 7: Run the test to verify it fails**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/client-ip.test.ts
```

Expected: FAIL, `Cannot find module '@/lib/client-ip'`

- [ ] **Step 8: Implement**

Set `TRUSTED_FROM_END` to the offset measured in Step 4 — `0` if the real peer
was the last element, `1` if it was second from last.

```ts
/**
 * The client's address, taken from the one position in `x-forwarded-for` that
 * the client cannot choose.
 *
 * The header is a list, and anybody may send one. Cloud Run appends the address
 * it actually accepted the connection from, so the honest value sits at a fixed
 * offset from the END; everything to the left of it is whatever the caller felt
 * like typing. Reading the FIRST element — which is what almost every example
 * on the internet does — hands the key to the attacker: a fresh fake address per
 * request is a fresh bucket per request, and a limit that is never reached.
 *
 * `lib/public-origin.ts` records the same lesson for `x-forwarded-host`, which
 * "is set by our proxy and by anybody else who feels like it". Same header
 * family, same trap.
 *
 * The offset below was MEASURED against a throwaway Cloud Run service and
 * checked against `httpRequest.remoteIp` in the request log — the value Google
 * computes rather than one the request carries. It is not read off any
 * documentation, and it must be re-measured if the control plane ever moves
 * behind a load balancer, because that adds a hop and shifts the offset.
 */
const TRUSTED_FROM_END = 0;

export function clientIp(req: Request): string | null {
  const raw = req.headers.get("x-forwarded-for");
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const ip = parts[parts.length - 1 - TRUSTED_FROM_END];
  return ip || null;
}
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/client-ip.test.ts
```

Expected: PASS, 3 tests

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/client-ip.ts apps/web/test/client-ip.test.ts
git commit -m "Which forwarded address can be trusted was measured, not assumed"
```

---

### Task 4: The limiter itself

**Files:**
- Create: `apps/web/db/036_rate_limits.sql`
- Create: `apps/web/lib/rate-limit.ts`
- Create: `apps/web/test/rate-limit.test.ts`

**Interfaces:**
- Consumes: `getPool` from `@/lib/db`
- Produces:
  - `type Scope = "signup:ip" | "signup:email-domain" | "login:email-ip"`
  - `type Verdict = { ok: true } | { ok: false; retryAfterSec: number }`
  - `takeToken(scope: Scope, key: string): Promise<Verdict>`
  - `CEILINGS: Record<Scope, { limit: number; windowSec: number; failClosed: boolean }>`
  - `windowStart(windowSec: number, now?: Date): Date`

- [ ] **Step 1: Write the migration**

```sql
-- How often a thing may happen, as opposed to how much of it may exist.
--
-- Every other limit in this platform bounds a resource or a month's spend:
-- maxApps, monthlyBuilds, maxConcurrentDeploys. None of them bounds a rate, so
-- signup was unlimited and the login path was protected by nothing at all.
--
-- A FIXED window, not a sliding one. Sliding costs either a row per request --
-- with the write volume and the cleanup that implies -- or an approximation
-- over two adjacent windows, and the fixed window is one atomic statement and
-- nothing else. Its known weakness is a double burst across a boundary: a
-- ten-per-minute ceiling tolerates twenty in the seconds either side of the
-- tick. For refusing a password guesser, twenty is as refused as ten.
--
-- The key is (bucket, window_start) rather than an id, because the upsert in
-- lib/rate-limit.ts needs the conflict target to BE the identity of the count.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start)
);

-- Unlike usage_counters, this table is written on every request to a protected
-- route, so the sweep in lib/rate-limit.ts:sweepOldWindows runs on a schedule
-- and needs to find expired rows without reading the whole table. A limiter
-- that quietly fills the platform database is a worse outage than the one it
-- was added to prevent.
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx
  ON rate_limits (window_start);
```

- [ ] **Step 2: Write the failing tests**

```ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The limiter, against a driver that is not a database.
 *
 * `getPool` points at 127.0.0.1:5433, so a test that reached a real pool would
 * quietly write production on any machine with cloud-sql-proxy running. Same
 * reasoning as test/plan-limits.test.ts, and the same mock.
 */
process.env.RATE_LIMIT_MODE = "enforce";

type Result = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => Result;

let handler: Handler = () => ({ rows: [{ hits: 1 }], rowCount: 1 });
let queryThrows: Error | null = null;
const sent: { sql: string; params: unknown[] }[] = [];

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (queryThrows) throw queryThrows;
        sent.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return handler(sql, params);
      },
    }),
  },
});

function withDb(h: Handler, throws: Error | null = null): void {
  handler = h;
  queryThrows = throws;
  sent.length = 0;
}

// Deferred, not static: tsx compiles to CJS, where a static import hoists above
// mock.module and would load the real lib/db.
const rl$ = import("@/lib/rate-limit");

test("a take under the ceiling is allowed", async () => {
  const { takeToken } = await rl$;
  withDb(() => ({ rows: [{ hits: 3 }], rowCount: 1 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
});

test("the ceiling is enforced by the statement, not by a read-then-write", async () => {
  const { takeToken } = await rl$;
  // An empty RETURNING is how the database says "the WHERE on DO UPDATE did not
  // match". Two statements here would let concurrent callers all read 9 of 10
  // and all pass -- the exact race lib/usage.ts:countIfUnder was written to
  // avoid, and this asserts we inherited the fix rather than the shape.
  withDb(() => ({ rows: [], rowCount: 0 }));
  const v = await takeToken("signup:ip", "203.0.113.1");
  assert.equal(v.ok, false);
  const sql = sent[0].sql;
  assert.match(sql, /ON CONFLICT/);
  assert.match(sql, /WHERE rate_limits\.hits < \$3/);
  assert.match(sql, /RETURNING/);
});

test("a refusal says when to come back", async () => {
  const { takeToken, CEILINGS } = await rl$;
  withDb(() => ({ rows: [], rowCount: 0 }));
  const v = await takeToken("login:email-ip", "a@b.com|203.0.113.1");
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.retryAfterSec > 0);
  assert.ok(v.retryAfterSec <= CEILINGS["login:email-ip"].windowSec);
});

test("the bucket key is the scope and the key together", async () => {
  const { takeToken } = await rl$;
  withDb(() => ({ rows: [{ hits: 1 }], rowCount: 1 }));
  await takeToken("signup:ip", "203.0.113.1");
  assert.equal(sent[0].params[0], "signup:ip:203.0.113.1");
});

test("a window boundary starts the count again", async () => {
  const { windowStart } = await rl$;
  const a = windowStart(60, new Date("2026-08-25T10:00:59.000Z"));
  const b = windowStart(60, new Date("2026-08-25T10:01:00.000Z"));
  assert.notEqual(a.getTime(), b.getTime());
  assert.equal(b.getTime() - a.getTime(), 60_000);
});

test("signup fails OPEN when the database is down", async () => {
  const { takeToken } = await rl$;
  // Mirrors countIfUnder. A hiccup must not be experienced as "I was refused
  // for no reason"; a few junk signups during an outage is the cheaper error.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
});

test("login fails CLOSED when the database is down", async () => {
  const { takeToken } = await rl$;
  // The asymmetry is deliberate and matches takeFreeFix. Being wrong open on
  // signup costs a few junk accounts; being wrong open here costs an account.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  const v = await takeToken("login:email-ip", "a@b.com|203.0.113.1");
  assert.equal(v.ok, false);
});

test("mode off does not reach the database at all", async () => {
  const { takeToken, setModeForTest } = await rl$;
  setModeForTest("off");
  withDb(() => ({ rows: [], rowCount: 0 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
  assert.equal(sent.length, 0);
  setModeForTest("enforce");
});

test("mode count never refuses, and keeps counting PAST the ceiling", async () => {
  const { takeToken, setModeForTest } = await rl$;
  setModeForTest("count");
  withDb(() => ({ rows: [{ hits: 99 }], rowCount: 1 }));
  assert.deepEqual(await takeToken("signup:ip", "203.0.113.1"), { ok: true });
  // The observation week exists to choose real ceilings from real numbers. An
  // upsert that stopped incrementing at the guessed limit would only ever teach
  // us "somebody reached 5" and never how far past it they went -- which is the
  // one number the ceiling is supposed to be picked from. Same reason
  // countIfUnder counts unlimited plans.
  assert.doesNotMatch(sent[0].sql, /WHERE rate_limits\.hits </);
  setModeForTest("enforce");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/rate-limit.test.ts
```

Expected: FAIL, `Cannot find module '@/lib/rate-limit'`

- [ ] **Step 4: Implement the module**

```ts
import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * How often a thing may happen.
 *
 * Everything else that limits anything here bounds a resource or a month of
 * spend. This bounds a rate, which is the axis that was missing entirely:
 * signup unlimited, login unprotected, and nothing anywhere counting requests.
 *
 * The storage is lib/usage.ts:countIfUnder with a time window in place of a
 * calendar month, deliberately and not by coincidence. That check-and-increment
 * race was solved here once already, and solving it a second way would give two
 * mechanisms to keep correct.
 */

/**
 * A closed union, not an open string.
 *
 * The scope reaches a query as part of the bucket key, and it indexes CEILINGS.
 * `Meter` in lib/usage.ts is closed for the same reason and says so: a
 * caller-supplied name would be an injection.
 */
export type Scope = "signup:ip" | "signup:email-domain" | "login:email-ip";

export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

export interface Ceiling {
  limit: number;
  windowSec: number;
  /**
   * What a database failure means for THIS scope.
   *
   * Almost everything fails open, mirroring countIfUnder: an outage must not be
   * experienced as "I was refused for no reason". Login is the exception and
   * fails closed, because an outage must not open a brute-force window. The
   * question is always what being wrong costs, and it is not symmetric.
   */
  failClosed: boolean;
}

/**
 * The ceilings, in one place, the way LIMITS is in lib/entitlements.ts, so the
 * number a route enforces and the number a reader looks up cannot disagree.
 *
 * EVERY NUMBER BELOW IS A GUESS. Nobody has ever counted signups per hour or
 * failed logins per account on this platform. That is precisely why
 * RATE_LIMIT_MODE has a `count` state, and why nothing should move to `enforce`
 * before a week of it has produced real numbers.
 */
export const CEILINGS: Record<Scope, Ceiling> = {
  // Five accounts an hour from one address. A household or an office behind one
  // NAT could plausibly make three; a farm makes hundreds.
  "signup:ip": { limit: 5, windowSec: 3600, failClosed: false },
  // Twenty an hour from one email domain. Higher than the per-IP ceiling on
  // purpose: a real company signing its team up in one afternoon shares a
  // domain and must not be mistaken for a farm. It catches the farm that
  // rotates addresses but keeps one throwaway domain.
  "signup:email-domain": { limit: 20, windowSec: 3600, failClosed: false },
  // Ten failed attempts per email+address per fifteen minutes. A person who has
  // forgotten which password they used gets several tries; a dictionary does
  // not get a second page.
  "login:email-ip": { limit: 10, windowSec: 900, failClosed: true },
};

/**
 * off | count | enforce.
 *
 * `count` is the state that matters and the reason this is not a boolean: it
 * records every take and refuses none of them, so the ceilings above can be
 * replaced by measurements before they are ever allowed to turn somebody away.
 * Shipping a guessed limit straight to `enforce` is how a limiter locks out a
 * real user on a bad day.
 *
 * Read at module load, like GATING_ENABLED, so tests must set it before their
 * deferred import resolves.
 */
export type Mode = "off" | "count" | "enforce";
let MODE: Mode = (process.env.RATE_LIMIT_MODE as Mode) || "off";

/** Test seam only. Production changes mode by redeploying with a new env var. */
export function setModeForTest(m: Mode): void {
  MODE = m;
}

/**
 * The start of the fixed window this instant falls in.
 *
 * Floor division on epoch milliseconds, so every instance of the control plane
 * computes the same boundary from the clock alone with nothing shared. Two
 * instances disagreeing about which window it is would give a caller two
 * buckets and twice the ceiling.
 */
export function windowStart(windowSec: number, now: Date = new Date()): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function takeToken(scope: Scope, key: string): Promise<Verdict> {
  if (MODE === "off") return { ok: true };

  const c = CEILINGS[scope];
  const start = windowStart(c.windowSec);
  const bucket = `${scope}:${key}`;
  const retryAfterSec = Math.max(
    1,
    Math.ceil((start.getTime() + c.windowSec * 1000 - Date.now()) / 1000)
  );

  // In `count` the upsert carries no WHERE, so the counter runs past the
  // ceiling and the week of observation learns the real shape of the traffic
  // rather than just the moment it crossed a guess. countIfUnder does the same
  // for unlimited plans, and its comment gives the reason: a plan that records
  // nothing is a plan we cannot price.
  const bounded = MODE === "enforce";
  const sql = bounded
    ? `INSERT INTO rate_limits (bucket, window_start, hits)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start)
       DO UPDATE SET hits = rate_limits.hits + 1, updated_at = now()
       WHERE rate_limits.hits < $3
       RETURNING hits`
    : `INSERT INTO rate_limits (bucket, window_start, hits)
       VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start)
       DO UPDATE SET hits = rate_limits.hits + 1, updated_at = now()
       RETURNING hits`;
  const params = bounded ? [bucket, start, c.limit] : [bucket, start];

  try {
    const r = await getPool(DB).query(sql, params);
    if (!bounded) {
      const hits = Number((r.rows[0] as { hits?: number } | undefined)?.hits ?? 0);
      if (hits > c.limit) {
        // The whole product of the observation week: what enforcement WOULD
        // have refused, without refusing it.
        console.warn(`[rate-limit] would refuse ${bucket}: ${hits} > ${c.limit}`);
      }
      return { ok: true };
    }
    return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, retryAfterSec };
  } catch {
    return c.failClosed ? { ok: false, retryAfterSec } : { ok: true };
  }
}

/**
 * Delete windows that can no longer be current.
 *
 * Unlike usage_counters this table takes a write on every request to a
 * protected route, so nothing here is self-limiting. One day back is far past
 * the longest window in CEILINGS and leaves a margin for reading recent
 * history while choosing real ceilings.
 */
export async function sweepOldWindows(): Promise<number> {
  try {
    const r = await getPool(DB).query(
      `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`
    );
    return r.rowCount ?? 0;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/rate-limit.test.ts
```

Expected: PASS, 9 tests

- [ ] **Step 6: Run the whole suite, to be sure nothing else moved**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: `# fail 0`. Read the count, not the exit code of a pipeline — a
backgrounded `npm test > log; echo $?` reports the exit status of `echo`, which
is how a run with three failures was once read as green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/db/036_rate_limits.sql apps/web/lib/rate-limit.ts apps/web/test/rate-limit.test.ts
git commit -m "A limit on how OFTEN, which is the axis nothing here had"
```

---

### Task 5: Wire signup, the surface that mints free accounts

**Files:**
- Modify: `apps/web/app/api/signup/route.ts`
- Create: `apps/web/test/signup-rate-limit.test.ts`

**Interfaces:**
- Consumes: `takeToken`, `Verdict` from `@/lib/rate-limit`; `clientIp` from `@/lib/client-ip`
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const takes: { scope: string; key: string }[] = [];
let verdict: { ok: boolean; retryAfterSec?: number } = { ok: true };
let bcryptCalls = 0;

mock.module("@/lib/rate-limit", {
  namedExports: {
    takeToken: async (scope: string, key: string) => {
      takes.push({ scope, key });
      return verdict;
    },
  },
});
mock.module("@/lib/client-ip", {
  namedExports: { clientIp: () => "203.0.113.7" },
});
mock.module("bcryptjs", {
  defaultExport: {
    hash: async () => {
      bcryptCalls++;
      return "hashed";
    },
  },
});
mock.module("@/lib/users", {
  namedExports: {
    findUserByEmailAndProvider: async () => null,
    createUser: async () => ({ id: "u1" }),
  },
});

const route$ = import("@/app/api/signup/route");

function post(email: string): Request {
  return new Request("https://app.thebay.cloud/api/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "hunter2", name: "A" }),
  });
}

test("a refused signup never reaches bcrypt", async () => {
  const { POST } = await route$;
  takes.length = 0;
  bcryptCalls = 0;
  verdict = { ok: false, retryAfterSec: 42 };
  const res = await POST(post("a@example.com"));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  // bcrypt is deliberately slow, which makes an unlimited signup route a CPU
  // exhaustion surface on its own -- separately from how many accounts it
  // creates. The gate must run BEFORE it, and this is the assertion that says
  // so rather than merely hoping the lines stayed in that order.
  assert.equal(bcryptCalls, 0);
});

test("signup is keyed on both the address and the email domain", async () => {
  const { POST } = await route$;
  takes.length = 0;
  verdict = { ok: true };
  await POST(post("a@example.com"));
  assert.deepEqual(takes, [
    { scope: "signup:ip", key: "203.0.113.7" },
    { scope: "signup:email-domain", key: "example.com" },
  ]);
});

test("an allowed signup still creates the account", async () => {
  const { POST } = await route$;
  verdict = { ok: true };
  const res = await POST(post("b@example.com"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: "u1" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/signup-rate-limit.test.ts
```

Expected: FAIL — status is 200 where 429 was expected.

- [ ] **Step 3: Add the gate to the route**

Insert after the password-length check and **before** the `try` block that calls
bcrypt, in `apps/web/app/api/signup/route.ts`:

```ts
  // Before bcrypt, and that order is the point rather than an accident. bcrypt
  // at cost 10 is deliberately expensive, so an unlimited signup route burns
  // CPU on every attempt whether or not the account is ever created -- it is a
  // denial-of-service surface independently of being an account farm.
  //
  // Two keys, because they catch different things. The address catches one
  // machine making accounts in a loop. The email domain catches the farm that
  // rotates addresses but keeps one throwaway domain, which the address key
  // would miss entirely.
  //
  // A missing IP is not a shared bucket: clientIp returns null when there is no
  // forwarded header, and one bucket for every such request would let a handful
  // of them lock out all the rest. Skipping the IP key leaves the domain key
  // doing the work.
  const ip = clientIp(req);
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  for (const [scope, key] of [
    ["signup:ip", ip],
    ["signup:email-domain", domain],
  ] as const) {
    if (!key) continue;
    const v = await takeToken(scope, key);
    if (!v.ok) {
      return Response.json(
        { error: "too many signups from here — try again shortly" },
        { status: 429, headers: { "retry-after": String(v.retryAfterSec) } }
      );
    }
  }
```

And at the top of the file:

```ts
import { takeToken } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/signup-rate-limit.test.ts
```

Expected: PASS, 3 tests

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/signup/route.ts apps/web/test/signup-rate-limit.test.ts
git commit -m "Signup stops being a free and unlimited way to mint accounts"
```

---

### Task 6: Wire login, the one that fails closed

**Files:**
- Create: `apps/web/lib/credentials-login.ts`
- Modify: `apps/web/auth.ts:13-27` (the Credentials provider delegates to it)
- Create: `apps/web/test/login-rate-limit.test.ts`

**Interfaces:**
- Consumes: `takeToken` from `@/lib/rate-limit`; `clientIp` from `@/lib/client-ip`
- Produces: `authorizeCredentials(creds: unknown, request?: Request): Promise<{ id: string; email: string; name?: string } | null>`

**Why a new module rather than an edit in place.** `auth.ts` exports only
`{ handlers, auth, signIn, signOut }` — the `providers` array is module-local, so
the `authorize` closure inside it is unreachable from a test. Widening that
export to let a test in would be changing the shape of the module for the
convenience of the test. Moving the function out gives it a name, a signature
and a test, and leaves `auth.ts` wiring providers together, which is what it is
for.

next-auth is `5.0.0-beta.32`, whose `authorize` signature is
`(credentials, request)` — `@auth/core/providers/credentials.d.ts` documents the
second argument as "you have access to the original request as well". That is
where the address comes from; it was checked against the installed types rather
than assumed.

- [ ] **Step 1: Write the failing test**

```ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const takes: { scope: string; key: string }[] = [];
let verdict: { ok: boolean; retryAfterSec?: number } = { ok: true };
let compares = 0;

mock.module("@/lib/rate-limit", {
  namedExports: {
    takeToken: async (scope: string, key: string) => {
      takes.push({ scope, key });
      return verdict;
    },
  },
});
mock.module("@/lib/client-ip", {
  namedExports: { clientIp: () => "203.0.113.7" },
});
mock.module("bcryptjs", {
  defaultExport: {
    compare: async () => {
      compares++;
      return true;
    },
    hash: async () => "hashed",
  },
});
mock.module("@/lib/users", {
  namedExports: {
    findUserByEmailAndProvider: async () => ({
      id: "u1",
      email: "a@example.com",
      name: "A",
      password_hash: "hashed",
    }),
    createUser: async () => ({ id: "u1" }),
  },
});

const login$ = import("@/lib/credentials-login");

function creds() {
  return { email: "a@example.com", password: "hunter2" };
}
function request() {
  return new Request("https://app.thebay.cloud/api/auth/callback/credentials");
}

async function authorize(): Promise<unknown> {
  const { authorizeCredentials } = await login$;
  return authorizeCredentials(creds(), request());
}

test("a refused attempt never reaches bcrypt.compare", async () => {
  takes.length = 0;
  compares = 0;
  verdict = { ok: false, retryAfterSec: 300 };
  assert.equal(await authorize(), null);
  assert.equal(compares, 0);
});

test("the key is the email and the address together, not either alone", async () => {
  takes.length = 0;
  verdict = { ok: true };
  await authorize();
  // Email alone would let anyone lock a victim out of their own account by
  // guessing at it from anywhere -- the limiter becomes the attack. Address
  // alone would let one office behind a NAT exhaust the ceiling for everybody
  // sharing it. The pair is the smallest key that is neither.
  assert.deepEqual(takes, [
    { scope: "login:email-ip", key: "a@example.com|203.0.113.7" },
  ]);
});

test("a normal sign-in still succeeds", async () => {
  verdict = { ok: true };
  const user = await authorize();
  assert.deepEqual(user, { id: "u1", email: "a@example.com", name: "A" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/login-rate-limit.test.ts
```

Expected: FAIL — `compares` is 1 where 0 was expected.

- [ ] **Step 3: Move the function out and add the gate**

Create `apps/web/lib/credentials-login.ts` with the logic currently inline in
`auth.ts`, plus the limiter:

```ts
import bcrypt from "bcryptjs";
import { findUserByEmailAndProvider } from "./users";
import { takeToken } from "./rate-limit";
import { clientIp } from "./client-ip";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

/**
 * Signing in with a password, and the only place a password is checked.
 *
 * Lifted out of the Credentials provider in auth.ts so it has a name and a
 * test. auth.ts exports only what NextAuth returns, which left this closure
 * unreachable, and a brute-force gate nobody can write a test against is a
 * gate nobody can prove still works after the next edit.
 */
export async function authorizeCredentials(
  creds: unknown,
  request?: Request
): Promise<SessionUser | null> {
  const c = creds as { email?: unknown; password?: unknown } | undefined;
  const email = String(c?.email ?? "").toLowerCase();
  const password = String(c?.password ?? "");
  if (!email || !password) return null;

  // FAILS CLOSED, unlike every other limiter call in this codebase. A database
  // outage must not be the thing that opens a brute-force window;
  // lib/rate-limit.ts carries the switch on the scope so the decision lives
  // beside the number rather than here. Same asymmetry takeFreeFix makes, and
  // for the same reason: being wrong open costs an account.
  //
  // Keyed on email AND address. Email alone would let anybody lock a victim out
  // of their own account from anywhere, which turns the protection into the
  // attack; address alone would let one shared NAT exhaust the ceiling for a
  // whole office.
  //
  // Refusal returns null, the same as a wrong password, because this function
  // has no other vocabulary -- and telling an attacker the difference between
  // "wrong" and "throttled" tells them the address exists. The Retry-After is
  // spent here, deliberately.
  const ip = request ? clientIp(request) : null;
  if (ip) {
    const v = await takeToken("login:email-ip", `${email}|${ip}`);
    if (!v.ok) return null;
  }

  // Only the password account for this email — never an OAuth account that
  // happens to share it (those have no password_hash anyway).
  const user = await findUserByEmailAndProvider(email, "credentials");
  if (!user?.password_hash) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email, name: user.name ?? undefined };
}
```

Then `auth.ts` keeps the wiring and loses the logic. Replace the Credentials
provider with:

```ts
import { authorizeCredentials } from "./lib/credentials-login";

const providers: any[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    authorize: (creds, request) => authorizeCredentials(creds, request as Request),
  }),
];
```

`bcrypt` and `findUserByEmailAndProvider` may now be unused imports in
`auth.ts` — check before deleting either, since the OAuth branches further down
the file also call `findUserByEmailAndProvider`. Verify with an import-shaped
grep rather than a word grep, and do not trust `knip` here: it has been wrong
three times in this repository (`9edc2c4`).

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/login-rate-limit.test.ts
```

Expected: PASS, 3 tests

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add apps/web/auth.ts apps/web/lib/credentials-login.ts \
        apps/web/test/login-rate-limit.test.ts
git commit -m "The login path stops being the one door with no lock on it"
```

---

### Task 7: Sweep the table, so the limiter does not become the outage

**Files:**
- Modify: `apps/web/app/api/domains/reconcile/route.ts`
- Create: `apps/web/test/rate-limit-sweep.test.ts`

**Interfaces:**
- Consumes: `sweepOldWindows` from `@/lib/rate-limit`
- Produces: nothing

`domains/reconcile` is chosen because it is an existing scheduled route that
already runs periodically and is already idempotent and safe to overlap. Adding
a second scheduler for one `DELETE` would be a new piece of infrastructure to
keep alive.

- [ ] **Step 1: Write the failing test**

```ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";

let swept = 0;
mock.module("@/lib/rate-limit", {
  namedExports: {
    sweepOldWindows: async () => {
      swept++;
      return 7;
    },
  },
});

const rl$ = import("@/lib/rate-limit");

test("the sweep deletes only windows that can no longer be current", async () => {
  const { sweepOldWindows } = await rl$;
  assert.equal(await sweepOldWindows(), 7);
  assert.equal(swept, 1);
});
```

Then, in `test/rate-limit.test.ts`, add a test against the real module asserting
the statement's shape:

```ts
test("the sweep is bounded by window_start and nothing else", async () => {
  const { sweepOldWindows } = await rl$;
  withDb(() => ({ rows: [], rowCount: 4 }));
  assert.equal(await sweepOldWindows(), 4);
  assert.match(sent[0].sql, /DELETE FROM rate_limits WHERE window_start < now\(\)/);
});

test("a failed sweep is zero, not a thrown reconcile", async () => {
  const { sweepOldWindows } = await rl$;
  // The reconcile job does several unrelated things. A limiter housekeeping
  // failure must not take the domain checks down with it.
  withDb(() => ({ rows: [], rowCount: 0 }), new Error("connection terminated"));
  assert.equal(await sweepOldWindows(), 0);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/rate-limit.test.ts test/rate-limit-sweep.test.ts
```

Expected: FAIL on the sweep assertions.

- [ ] **Step 3: Call the sweep from the reconcile route**

In `apps/web/app/api/domains/reconcile/route.ts`, alongside the existing work:

```ts
  // Housekeeping for lib/rate-limit.ts, which unlike usage_counters takes a
  // write on every request to a protected route and so has no natural ceiling
  // on its row count. Deliberately not its own scheduler: this route already
  // runs periodically, is already idempotent and is already safe to overlap.
  //
  // Awaited but never allowed to throw -- sweepOldWindows swallows its own
  // errors and returns 0, so a limiter housekeeping failure cannot take the
  // domain reconciliation down with it.
  const sweptWindows = await sweepOldWindows();
```

Include `sweptWindows` in whatever the route already reports, so an operator can
see the sweep is running rather than assuming it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/rate-limit.test.ts test/rate-limit-sweep.test.ts
```

Expected: PASS

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/rate-limit.ts apps/web/app/api/domains/reconcile/route.ts \
        apps/web/test/rate-limit.test.ts apps/web/test/rate-limit-sweep.test.ts
git commit -m "The limiter sweeps up after itself, or it becomes the outage"
```

---

### Task 8: Count for a week, then choose the real numbers

The ceilings in `CEILINGS` are guesses and the code says so. This task replaces
them with measurements. It is a task and not an afterthought because a limiter
left in `count` forever protects nothing, and one moved to `enforce` on a guess
refuses real people.

**Files:**
- Modify: `apps/web/lib/rate-limit.ts` (the `CEILINGS` values only)
- Modify: `docs/superpowers/specs/2026-08-25-rate-limiting-design.md` (record
  the measured numbers where the spec says they were guesses)

**Interfaces:**
- Consumes: `CEILINGS` from Task 4
- Produces: nothing

- [ ] **Step 1: Deploy with counting on**

```bash
gcloud run services update supersonic-control-plane --region=us-central1 \
  --update-env-vars=RATE_LIMIT_MODE=count
```

`--update-env-vars`, never `--set-env-vars`: the latter replaces the whole list,
and there are 53 variables on this service.

- [ ] **Step 2: After seven days, read what enforcement would have refused**

```bash
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="supersonic-control-plane"
   AND textPayload:"[rate-limit] would refuse"' \
  --freshness=7d --limit=200 --format="value(textPayload)" | sort | uniq -c | sort -rn
```

Every line here is a request the guessed ceiling would have turned away. A line
belonging to a real user means the ceiling is too low.

- [ ] **Step 3: Read the actual distribution from the table**

```sql
SELECT split_part(bucket, ':', 1) AS scope,
       max(hits) AS worst,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY hits) AS p99,
       percentile_disc(0.50) WITHIN GROUP (ORDER BY hits) AS p50,
       count(*) AS buckets
FROM rate_limits
GROUP BY 1 ORDER BY 1;
```

Run it through the Cloud SQL proxy. Note that the proxy dies with an expired
gcloud token and must be restarted — `gcloud auth login a@supersonic.cv`, with
the account named, or the picker offers one with no permissions.

- [ ] **Step 4: Set each ceiling from p99, not from the worst case**

Edit `CEILINGS` so each `limit` sits comfortably above the p99 of ordinary
traffic. Replace the comment above each number: it currently explains a guess,
and must now record what was measured and when. A limit derived from `worst`
is a limit that never fires, because the worst case in a week of honest traffic
usually IS somebody having a bad day.

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/web && npm test 2>&1 | tail -20
```

Expected: `# fail 0`. The tests assert mechanism, not specific ceilings, so
changing the numbers must not break any of them. If one breaks, that test was
asserting a guess and should be fixed to assert the mechanism instead.

- [ ] **Step 6: Update the spec to say what is now known**

The spec's "Shipping safely" section states that every ceiling is a guess. Amend
it with the measured numbers and the date, so a later reader does not repeat the
observation week to learn something already learned.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/rate-limit.ts docs/superpowers/specs/2026-08-25-rate-limiting-design.md
git commit -m "The ceilings stop being guesses and start being measurements"
```

- [ ] **Step 8: Turn enforcement on**

```bash
gcloud run services update supersonic-control-plane --region=us-central1 \
  --update-env-vars=RATE_LIMIT_MODE=enforce
```

- [ ] **Step 9: Verify a real signup and a real sign-in still work**

Not a curl of the endpoint — an actual account created through the UI and an
actual sign-in. The failure this catches is the one where the limiter refuses
the ordinary path, and no synthetic request will show it.

---

## What this plan does not do

- **The control plane's move behind a load balancer.** Until that happens,
  `app.thebay.cloud` has no edge protection and Task 2's `maxScale` ceiling is
  the only thing bounding a flood's cost. Its own plan, its own window; the
  reason for the split is in the spec.
- **CI.** Every task here commits to a branch. Merging any of them deploys
  production with no test run behind it, which is why every code path added is
  dark until `RATE_LIMIT_MODE` says otherwise.
- **Anything for the deploy or agent endpoints.** Bursts inside a paid monthly
  quota were excluded from the spec, and `maxConcurrentDeploys` already refuses
  there.
