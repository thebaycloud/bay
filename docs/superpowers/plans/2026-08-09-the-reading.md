# The Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<slug>.supersonic.cv/_xray` return one complete **reading** of an app — including who did each build — assembled once and served as JSON to the owner's agent.

**Architecture:** A new `builds` table gives every shipping attempt one durable row with a `who` column, written by the control plane at the two points a run already begins and ends. The edge proxy, which alone holds the live half in memory and already reads Postgres, composes the durable half and the live half into a single `Reading` object. `/_xray` serves that object, splitting on `Accept` and resolving either a session cookie or a CLI bearer token to the same owner.

**Tech Stack:** TypeScript, Node 22 `node:test`, `pg`, Next.js (control plane), plain Node HTTP (proxy).

**This is plan 1 of 3.** It ends with a working JSON reading and no page changes. Plan 2 draws the page from it; plan 3 collapses `/apps/[slug]` into it.

## Global Constraints

- **Never squash commits.** Each task commits separately. (`docs/…/handoff` §7)
- **Never print secrets.** `GET /env` returns keys only; nothing in this plan changes that.
- **Every push to `main` deploys production.** `.github/workflows/deploy.yml` has no path filter; `deploy-proxy.yml` is path-filtered to `services/proxy/**`.
- **Migration numbering: the next free number is `021`.** Two files already share `019` — do not add a third collision.
- **Product words only in anything a person sees.** `CONTEXT.md` bans *dashboard*, *console*, *panel*, *settings*, *deployment*, *revision*, *history*, *rollback*. Internal type and column names may use platform language; user-facing strings may not.
- **Never guess `who`.** An undeclared actor is `someone`. Inferring from a TTY is forbidden — CI has no TTY either.
- **Proxy tests:** `cd services/proxy && npm test` (`node --import tsx --test 'src/**/*.test.ts'`).
- **Web tests:** `cd apps/web && npm test` (`node --experimental-test-module-mocks --import tsx --test 'test/**/*.test.ts'`).

---

### Task 1: `who` — the value, and the rule that it is never guessed

**Files:**
- Create: `apps/web/lib/builds.ts`
- Test: `apps/web/test/builds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Who = "you" | "agent" | "platform" | "someone"`, `normaliseWho(declared: string | null | undefined): Who`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/builds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseWho } from "../lib/builds";

test("an undeclared actor is someone, never a guess", () => {
  // The whole point of the field. A wrong name here is worse than no name:
  // the dashboard's one claim over Render's is that it says who acted.
  assert.equal(normaliseWho(undefined), "someone");
  assert.equal(normaliseWho(null), "someone");
  assert.equal(normaliseWho(""), "someone");
});

test("only the three declared actors are accepted", () => {
  assert.equal(normaliseWho("you"), "you");
  assert.equal(normaliseWho("agent"), "agent");
  assert.equal(normaliseWho("platform"), "platform");
  assert.equal(normaliseWho("  Agent "), "agent");
});

test("anything else falls to someone rather than being interpreted", () => {
  // "ci" is the exact case that tempts inference. It is not one of the three,
  // so it is someone — we do not decide that CI means an agent.
  assert.equal(normaliseWho("ci"), "someone");
  assert.equal(normaliseWho("human"), "someone");
  assert.equal(normaliseWho("robot"), "someone");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npm test -- --test-name-pattern="actor"`
Expected: FAIL — cannot find module `../lib/builds`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/lib/builds.ts
/**
 * Who caused a build: you, an agent, the platform — or `someone`, when nobody
 * said.
 *
 * The tempting implementation reads a TTY and calls the answer `agent` when
 * there isn't one. CI has no TTY either, so that reports an agent where there
 * was none, in the one field the whole surface exists to show. An honest blank
 * costs less than a confident lie.
 */
export type Who = "you" | "agent" | "platform" | "someone";

const DECLARED: readonly string[] = ["you", "agent", "platform"];

export function normaliseWho(declared: string | null | undefined): Who {
  const v = (declared ?? "").trim().toLowerCase();
  return (DECLARED.includes(v) ? v : "someone") as Who;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npm test -- --test-name-pattern="actor|declared|someone"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/builds.ts apps/web/test/builds.test.ts
git commit -m "builds: who did it, and the rule that it is never guessed"
```

---

### Task 2: the `builds` table and its two writes

**Files:**
- Create: `apps/web/db/021_builds.sql`
- Modify: `apps/web/lib/builds.ts`
- Test: `apps/web/test/builds.test.ts` (append)

**Interfaces:**
- Consumes: `normaliseWho` from Task 1.
- Produces: `startBuild(runId: string, slug: string, who: Who): Promise<void>`, `finishBuild(runId: string, outcome: "ok" | "failed"): Promise<void>`, `type BuildRow = { run_id: string; slug: string; who: Who; started_at: string; ended_at: string | null; outcome: "ok" | "failed" | null }`.

- [ ] **Step 1: Write the migration**

```sql
-- apps/web/db/021_builds.sql
-- One durable row per shipping attempt.
--
-- There was no such row anywhere. `deploy_runs` is deleted by finishRun the
-- moment a build ends, because it holds the app's encrypted source and a
-- secret's window is one build long. `deploy_stages` is one row per STAGE — it
-- gained run_id on 6 Aug (018) but still cannot answer "list this app's builds"
-- without a GROUP BY, and has nowhere to record who caused one.
--
-- `deploy_events` cannot hold it either: pruneEvents drops everything older
-- than seven days, and an actor that is forgotten in a week is not an answer to
-- "what did the agent do to my app".
CREATE TABLE IF NOT EXISTS builds (
  run_id     text PRIMARY KEY,
  slug       text NOT NULL,
  who        text NOT NULL DEFAULT 'someone',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  outcome    text,
  CONSTRAINT builds_who CHECK (who IN ('you', 'agent', 'platform', 'someone')),
  CONSTRAINT builds_outcome CHECK (outcome IS NULL OR outcome IN ('ok', 'failed'))
);

-- The query this table exists to answer: "this app's builds, newest first".
CREATE INDEX IF NOT EXISTS builds_slug_started ON builds (slug, started_at DESC);
```

- [ ] **Step 2: Run the migration and verify the table exists**

Run:
```bash
cloud-sql-proxy -g --port 5433 supersonic-deploy-prod:us-central1:supersonic-shared-pg &
cd apps/web && npm run db:migrate
```
Expected: migration `021_builds.sql` applied, no error. `-g` matters; "Reauth required" means the user must run `! gcloud auth login` themselves.

- [ ] **Step 3: Write the failing test for the writers**

```ts
// append to apps/web/test/builds.test.ts
import { buildStartSql, buildFinishSql } from "../lib/builds";

test("a build is recorded under its run id, with who normalised", () => {
  // The SQL is thin; what is worth testing is that an undeclared actor reaches
  // the database as `someone` rather than as an empty string or a NULL that the
  // CHECK constraint would reject at 3am during a deploy.
  const { text, values } = buildStartSql("run-1", "lilna", "ci");
  assert.match(text, /INSERT INTO builds/);
  assert.deepEqual(values, ["run-1", "lilna", "someone"]);
});

test("finishing a build records its outcome and nothing else", () => {
  const { text, values } = buildFinishSql("run-1", "failed");
  assert.match(text, /UPDATE builds/);
  assert.deepEqual(values, ["run-1", "failed"]);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/web && npm test -- --test-name-pattern="recorded under its run id|finishing a build"`
Expected: FAIL — `buildStartSql` is not exported.

- [ ] **Step 5: Implement**

```ts
// append to apps/web/lib/builds.ts
import { getPool } from "./db";

const DB = "supersonic_platform";

export interface BuildRow {
  run_id: string; slug: string; who: Who;
  started_at: string; ended_at: string | null;
  outcome: "ok" | "failed" | null;
}

/** Split out from the write so the normalisation is testable without a database. */
export function buildStartSql(runId: string, slug: string, who: string | null | undefined) {
  return {
    text: `INSERT INTO builds(run_id, slug, who) VALUES($1,$2,$3)
             ON CONFLICT (run_id) DO NOTHING`,
    values: [runId, slug, normaliseWho(who)],
  };
}

export function buildFinishSql(runId: string, outcome: "ok" | "failed") {
  return {
    text: `UPDATE builds SET ended_at = now(), outcome = $2 WHERE run_id = $1`,
    values: [runId, outcome],
  };
}

/** Best-effort, both of them: losing the record of a build must not fail the build. */
export async function startBuild(runId: string, slug: string, who: string | null | undefined): Promise<void> {
  const q = buildStartSql(runId, slug, who);
  try { await getPool(DB).query(q.text, q.values); } catch { /* ignore */ }
}

export async function finishBuild(runId: string, outcome: "ok" | "failed"): Promise<void> {
  const q = buildFinishSql(runId, outcome);
  try { await getPool(DB).query(q.text, q.values); } catch { /* ignore */ }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web && npm test -- --test-name-pattern="recorded under its run id|finishing a build"`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/db/021_builds.sql apps/web/lib/builds.ts apps/web/test/builds.test.ts
git commit -m "builds: one durable row per shipping attempt, with who caused it"
```

---

### Task 3: write a build at the two points a run already begins and ends

**Files:**
- Modify: `apps/web/app/api/deploy/route.ts:252-288`

**Interfaces:**
- Consumes: `startBuild`, `finishBuild` from Task 2.
- Produces: a `builds` row for every deploy started through this route.

- [ ] **Step 1: Read the surrounding code**

Read `apps/web/app/api/deploy/route.ts:250-290`. The run id is minted at line 266 (`runId = randomUUID()`), `createRun` follows at 270, and `finishRun(runId)` is called at 281 inside the failure path. Do not move any of these; add beside them.

- [ ] **Step 2: Add the two calls**

Add to the imports at the top of the file:

```ts
import { startBuild, finishBuild } from "@/lib/builds";
```

Immediately after `runId = randomUUID();`:

```ts
    // The durable record of this attempt, written before anything can fail, so a
    // build that dies in its first second still appears on the app's timeline.
    // `who` is whatever the caller declared and nothing more — see lib/builds.
    void startBuild(runId, slug, req.headers.get("x-supersonic-who"));
```

In the same `catch` block that calls `finishRun(runId)`:

```ts
      if (runId) await finishBuild(runId, "failed").catch(() => {});
```

- [ ] **Step 3: Verify no existing test broke**

Run: `cd apps/web && npm test`
Expected: the suite passes at its current count (1230 pass, 5 skip as of 2026-08-09). A drop means something else was touched.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/deploy/route.ts
git commit -m "deploy: record the build itself, not only its stages"
```

---

### Task 4: the CLI declares who is shipping

**Files:**
- Create: `packages/cli/lib/who.js`
- Create: `packages/cli/test/who.test.js`
- Modify: `packages/cli/index.js` — the deploy requests at lines 553, 574, 727, 755 and 763
- Modify: `packages/cli/package.json` (version), `packages/cli/CHANGELOG.md`

> **This package is JavaScript, not TypeScript.** `lib/*.js`, CommonJS-style module layout, tests in `test/*.test.js` run by `node --test 'test/**/*.test.js'`. Do not introduce TypeScript here.

**Interfaces:**
- Consumes: the `x-supersonic-who` header read in Task 3.
- Produces: `whoHeader(env)` in `packages/cli/lib/who.js`, and that header on every deploy request.

- [ ] **Step 1: Write the failing test**

```js
// packages/cli/test/who.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { whoHeader } = require("../lib/who");

test("the CLI declares an agent only when told to", () => {
  // SUPERSONIC_WHO is the only input. There is deliberately no TTY check: CI has
  // no TTY, and reporting "agent" there would be a confident lie in the one
  // field this whole surface exists to show.
  assert.equal(whoHeader({ SUPERSONIC_WHO: "agent" }), "agent");
  assert.equal(whoHeader({ SUPERSONIC_WHO: "you" }), "you");
  assert.equal(whoHeader({ SUPERSONIC_WHO: " Platform " }), "platform");
});

test("an undeclared shipper is someone, and CI is not an agent", () => {
  assert.equal(whoHeader({}), "someone");
  assert.equal(whoHeader({ CI: "true" }), "someone");
  assert.equal(whoHeader({ SUPERSONIC_WHO: "robot" }), "someone");
});
```

> Match the module style of the file you are next to — if `packages/cli/lib/envfile.js` uses `module.exports`, use `module.exports`; if it uses ESM `export`, use that and adjust the test's import accordingly. Check before writing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npm test`
Expected: FAIL — cannot find module `../lib/who`.

- [ ] **Step 3: Implement**

```js
// packages/cli/lib/who.js
/**
 * Who is shipping, as declared — never as inferred.
 *
 * An agent sets SUPERSONIC_WHO=agent. Nothing else is consulted: a TTY check
 * would call CI an agent, and the platform would then draw a figure that was
 * never there. The absence of a name is a fact; a wrong name is a lie.
 */
function whoHeader(env) {
  const v = String(env.SUPERSONIC_WHO || "").trim().toLowerCase();
  return v === "you" || v === "agent" || v === "platform" ? v : "someone";
}

module.exports = { whoHeader };
```

- [ ] **Step 4: Send the header on every deploy request**

`packages/cli/index.js` reaches `/api/deploy` five times: through the `api()` helper at **553** and **727**, and by raw `fetch` at **574**, **755** and **763**. Add the header in `api()` once so both of its callers are covered, and to each of the three raw calls:

```js
"x-supersonic-who": whoHeader(process.env),
```

Read each call site before editing — two of them build a `headers` object above the call rather than inline.

- [ ] **Step 5: Run tests**

Run: `cd packages/cli && npm test`
Expected: PASS — 101 tests (99 existing + 2 new).

- [ ] **Step 6: Bump the version and write the changelog entry**

`package.json` `0.12.0` → `0.12.1`, and a `CHANGELOG.md` entry in the existing house style: a ship now says who is shipping when it has been told, and says `someone` when it has not.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/lib/who.js packages/cli/test/who.test.js packages/cli/index.js packages/cli/package.json packages/cli/CHANGELOG.md
git commit -m "cli 0.12.1: a ship says who is shipping, when it knows"
```

> **Do not attempt to publish.** `supersonic-cli` cannot be published at all right now — npm serves 0.10.0 and `NPM_TOKEN` lacks publish rights (handoff §6.1). This change reaches users only after that token is replaced. The version guard makes a later re-run safe.

---

### Task 5: the proxy reads builds, and says when the narration is gone

**Files:**
- Create: `services/proxy/src/builds.ts`
- Create: `services/proxy/src/builds.test.ts`

**Interfaces:**
- Consumes: the `builds` table from Task 2; `db()` from `services/proxy/src/db.ts`.
- Produces: `type Tick = { runId: string; who: Who; startedAt: number; endedAt: number | null; outcome: "ok" | "failed" | null; linesGone: boolean }`, `linesGone(startedAtMs: number, nowMs: number, retentionDays?: number): boolean`, `listBuilds(slug: string, limit?: number): Promise<Tick[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// services/proxy/src/builds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { linesGone } from "./builds";

const DAY = 86_400_000;

test("a build older than the retention window has no narration left", () => {
  // pruneEvents(days = 7) runs at the start of every deploy, so the lines of an
  // old build are genuinely deleted. The tick and the outcome survive. Rendering
  // that as an empty list would read as "nothing happened", which is the exact
  // lie `since` exists to prevent elsewhere in this service.
  const now = Date.UTC(2026, 7, 9);
  assert.equal(linesGone(now - 8 * DAY, now), true);
  assert.equal(linesGone(now - 6 * DAY, now), false);
});

test("the boundary belongs to the side that still has lines", () => {
  const now = Date.UTC(2026, 7, 9);
  assert.equal(linesGone(now - 7 * DAY + 1000, now), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — cannot find module `./builds`.

- [ ] **Step 3: Implement**

```ts
// services/proxy/src/builds.ts
import { db } from "./db";

export type Who = "you" | "agent" | "platform" | "someone";

export interface Tick {
  runId: string;
  who: Who;
  startedAt: number;
  endedAt: number | null;
  outcome: "ok" | "failed" | null;
  /** True when this build's lines have been pruned, so the reader can say so. */
  linesGone: boolean;
}

/**
 * Whether `deploy_events` still holds this build's lines.
 *
 * Mirrors `pruneEvents(days = 7)` in apps/web/lib/deploy-events.ts, which is
 * called at the start of every deploy. If that default changes, change this one
 * with it — they are the same number seen from two services.
 */
export function linesGone(startedAtMs: number, nowMs: number, retentionDays = 7): boolean {
  return nowMs - startedAtMs > retentionDays * 86_400_000;
}

/** This app's builds, newest first. */
export async function listBuilds(slug: string, limit = 50): Promise<Tick[]> {
  const now = Date.now();
  try {
    const r = await db().query(
      `SELECT run_id, who, started_at, ended_at, outcome
         FROM builds WHERE slug = $1 ORDER BY started_at DESC LIMIT $2`,
      [slug, limit],
    );
    return r.rows.map((row) => {
      const startedAt = new Date(row.started_at).getTime();
      return {
        runId: row.run_id, who: row.who as Who, startedAt,
        endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
        outcome: row.outcome ?? null,
        linesGone: linesGone(startedAt, now),
      };
    });
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/proxy && npm test`
Expected: PASS — 111 tests (109 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/builds.ts services/proxy/src/builds.test.ts
git commit -m "proxy: an app's builds, and whether their lines still exist"
```

---

### Task 6: the reading — one object, with two windows

**Files:**
- Create: `services/proxy/src/reading.ts`
- Create: `services/proxy/src/reading.test.ts`

**Interfaces:**
- Consumes: `xray(slug)` from `./xray` (returns `{ since, here, paths, dropped }`), `listBuilds` and `Tick` from Task 5.
- Produces: `type Reading = { slug: string; door: string; open: boolean; live: { since: number; here: {count: number; names: string[]}; paths: XrayPath[]; dropped: number }; builds: Tick[]; since: { live: number; builds: "durable" } }`, `assembleReading(slug: string, deps: ReadingDeps): Promise<Reading>`.

- [ ] **Step 1: Write the failing test**

```ts
// services/proxy/src/reading.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleReading } from "./reading";

const deps = {
  xray: () => ({ since: 1000, here: { count: 2, names: ["ada", "grace"] }, paths: [], dropped: 0 }),
  listBuilds: async () => [
    { runId: "r1", who: "agent" as const, startedAt: 500, endedAt: 900, outcome: "ok" as const, linesGone: true },
  ],
  door: async () => ({ door: "lilna.supersonic.cv", open: true }),
};

test("the reading carries two windows, because its halves have two lifetimes", async () => {
  // here/paths die with a proxy release; builds are durable. One `since` over
  // both would lie about one of them — and an empty live half after a release is
  // not an app with no traffic.
  const r = await assembleReading("lilna", deps);
  assert.equal(r.since.live, 1000);
  assert.equal(r.since.builds, "durable");
});

test("who did it survives into the reading", async () => {
  const r = await assembleReading("lilna", deps);
  assert.equal(r.builds[0].who, "agent");
  assert.equal(r.builds[0].linesGone, true);
});

test("a reading is produced even when every source is empty", async () => {
  // An app that has never come up must still have a reading; the page and the
  // agent both need something with the right shape to render "nothing yet".
  const empty = {
    xray: () => ({ since: 42, here: { count: 0, names: [] }, paths: [], dropped: 0 }),
    listBuilds: async () => [],
    door: async () => ({ door: "new.supersonic.cv", open: false }),
  };
  const r = await assembleReading("new", empty);
  assert.equal(r.open, false);
  assert.deepEqual(r.builds, []);
  assert.equal(r.live.here.count, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — cannot find module `./reading`.

- [ ] **Step 3: Implement**

```ts
// services/proxy/src/reading.ts
import { xray as liveXray, type Xray } from "./xray";
import { listBuilds as listBuildsDb, type Tick } from "./builds";

/**
 * Everything the X-ray shows about one app at one moment, as a single thing.
 *
 * A person and an agent are given this same object and only the rendering
 * differs. Two objects built separately would drift within a week, and the one
 * that drifted would be the one nobody was looking at — which is what happened
 * to the "deployed" line in apps/web/app/api/apps/route.ts.
 *
 * NOT A CONTRACT. This is the page's own data, the way github.com's JSON is its
 * page's data and api.github.com's is an API. No CLI reads it today. The moment
 * one does it becomes a contract silently, and renaming a field while editing
 * markup becomes a breaking change — so make that a decision, not a discovery.
 */
export interface Reading {
  slug: string;
  door: string;
  open: boolean;
  live: Xray;
  builds: Tick[];
  /**
   * Two windows, not one. The live half lives in this process's memory and dies
   * with a release; builds are durable. Collapsing them into one `since` would
   * lie about whichever half it did not describe.
   */
  since: { live: number; builds: "durable" };
}

export interface ReadingDeps {
  xray: (slug: string) => Xray;
  listBuilds: (slug: string) => Promise<Tick[]>;
  door: (slug: string) => Promise<{ door: string; open: boolean }>;
}

export async function assembleReading(slug: string, deps: ReadingDeps): Promise<Reading> {
  const live = deps.xray(slug);
  const [builds, d] = await Promise.all([deps.listBuilds(slug), deps.door(slug)]);
  return {
    slug, door: d.door, open: d.open, live, builds,
    since: { live: live.since, builds: "durable" },
  };
}

/** The real dependencies, for callers that are not tests. */
export const liveDeps = (doorOf: ReadingDeps["door"]): ReadingDeps => ({
  xray: liveXray,
  listBuilds: listBuildsDb,
  door: doorOf,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/proxy && npm test`
Expected: PASS — 114 tests.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/reading.ts services/proxy/src/reading.test.ts
git commit -m "proxy: the reading — one object, and two windows because two lifetimes"
```

---

### Task 7: an agent's bearer token opens the same door as a person's cookie

**Files:**
- Modify: `services/proxy/src/session.ts:31`
- Create: `services/proxy/src/bearer.test.ts`

**Interfaces:**
- Consumes: `cli_tokens.token_hash`, which is `sha256(token)` hex — `apps/web/lib/cli-tokens.ts:28-30`.
- Produces: `bearerFrom(header: string | undefined): string | null`; `readVisitor` unchanged in signature, now resolving a bearer as well as a cookie.

- [ ] **Step 1: Write the failing test**

```ts
// services/proxy/src/bearer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerFrom } from "./session";

test("a bearer token is read, and nothing else is", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("bearer abc123"), "abc123");
  assert.equal(bearerFrom("Basic abc123"), null);
  assert.equal(bearerFrom(undefined), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom("Bearer   "), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — `bearerFrom` is not exported from `./session`.

- [ ] **Step 3: Implement**

Add to `services/proxy/src/session.ts`:

```ts
import { createHash } from "node:crypto";
import { db } from "./db";

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * The owner, however they arrived.
 *
 * A person carries the .supersonic.cv session cookie; their agent carries a CLI
 * token. Both resolve to one user id and one Visitor, so nothing downstream —
 * least of all the Accept branch — ever learns which was used. Mastodon's
 * controller has this same fork and needs a different auth path per
 * representation; keeping it inside one function is what stops that spreading.
 */
async function visitorFromBearer(token: string): Promise<Visitor | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const r = await db().query(
      `UPDATE cli_tokens SET last_used_at = now() WHERE token_hash = $1
         RETURNING user_id`, [hash],
    );
    if (!r.rows.length) return null;
    const u = await db().query(`SELECT id, email, name FROM users WHERE id = $1`, [r.rows[0].user_id]);
    if (!u.rows.length) return null;
    return { userId: u.rows[0].id, email: u.rows[0].email, name: u.rows[0].name ?? "" };
  } catch {
    return null;
  }
}
```

Then, at the top of the existing `readVisitor`, before the cookie path:

```ts
  const token = bearerFrom(req.headers.authorization as string | undefined);
  if (token) return visitorFromBearer(token);
```

- [ ] **Step 4: Run tests**

Run: `cd services/proxy && npm test`
Expected: PASS — 120 tests. The existing `access.test.ts` must still pass unchanged; a cookie visitor's path is untouched.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/session.ts services/proxy/src/bearer.test.ts
git commit -m "proxy: an agent's token opens the same door as a person's cookie"
```

---

### Task 8: `/_xray` serves the reading, with the headers it has been missing

**Files:**
- Modify: `services/proxy/src/index.ts:24-27` (the `html` helper), `services/proxy/src/index.ts:86-98` (the `/_xray` branch)
- Create: `services/proxy/src/negotiate.test.ts`

**Interfaces:**
- Consumes: `assembleReading` and `liveDeps` from Task 6; `readVisitor` from Task 7.
- Produces: `wantsHtml(accept: string | undefined): boolean`; `/_xray` returning a `Reading` as JSON.

- [ ] **Step 1: Write the failing test**

```ts
// services/proxy/src/negotiate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsHtml } from "./negotiate";

test("an unknown client is treated as a machine, not as a browser", () => {
  // A bare fetch() sends */* per the Fetch Standard — including our own poll at
  // xray-panel.ts:116. Written the other way round ("if they ask for JSON, send
  // JSON") that poll would receive the HTML page. The safe default is machine.
  assert.equal(wantsHtml("*/*"), false);
  assert.equal(wantsHtml(undefined), false);
  assert.equal(wantsHtml(""), false);
});

test("a browser is recognised by asking for html", () => {
  assert.equal(wantsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), true);
  assert.equal(wantsHtml("TEXT/HTML"), true);
});

test("asking explicitly for json gets json", () => {
  assert.equal(wantsHtml("application/json"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && npm test`
Expected: FAIL — cannot find module `./negotiate`.

- [ ] **Step 3: Implement the negotiator**

```ts
// services/proxy/src/negotiate.ts
/**
 * Whether this client wants the page rather than the object.
 *
 * The test is on text/html and never on JSON, deliberately. RFC 9110 §12.1
 * describes the negotiation; the Fetch Standard decides the default, because a
 * bare fetch() sends `Accept: */*` and a client that says nothing must be
 * treated as a machine.
 */
export function wantsHtml(accept: string | undefined): boolean {
  return /text\/html/i.test(accept ?? "");
}
```

- [ ] **Step 4: Give the HTML helper the headers it never had**

Modify `services/proxy/src/index.ts:24-27`. The helper writes only `Content-Type` today, which for an owner-only page is RFC 9111 §4.1's "resources that mistakenly omit the Vary header field":

```ts
function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Vary": "Accept, Cookie",
  });
  res.end(body);
}
```

- [ ] **Step 5: Serve the reading from the `/_xray` branch**

In `services/proxy/src/index.ts:86-98`, replace `xray(slug)` in the JSON branch with the assembled reading, and add `Vary` there too:

```ts
  if ((req.url ?? "/") === "/_xray") {
    const viewer = await readVisitor(req);
    if (viewer && viewer.userId === app.owner_id) {
      if (wantsHtml(String(req.headers.accept ?? ""))) {
        return html(res, 200, xrayPage(slug));
      }
      const reading = await assembleReading(slug, liveDeps(async () => ({
        door: `${slug}.supersonic.cv`,
        open: Boolean(app.run_url),
      })));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Vary": "Accept, Cookie",
      });
      res.end(JSON.stringify(reading));
      return;
    }
```

- [ ] **Step 6: Run the whole proxy suite**

Run: `cd services/proxy && npm test`
Expected: PASS — 124 tests. `inject.test.ts` and `access.test.ts` must be unchanged: a visitor still gets nothing from `/_xray`.

- [ ] **Step 7: Commit**

```bash
git add services/proxy/src/negotiate.ts services/proxy/src/negotiate.test.ts services/proxy/src/index.ts
git commit -m "proxy: /_xray serves the whole reading, and says it is negotiated"
```

---

### Task 9: verify it against production, not against the tests

**Files:** none — this task changes nothing and must not.

- [ ] **Step 1: Push and let the edge deploy itself**

```bash
git push origin main
```
`deploy-proxy.yml` is path-filtered to `services/proxy/**` and will run. `deploy.yml` runs on any push and redeploys the control plane; both are expected here because this plan touched both trees.

- [ ] **Step 2: Confirm the edge is healthy before reading anything into a result**

```bash
curl -s -m 12 -o /dev/null -w "lb %{http_code}\n" http://8.232.255.172/__fleet/healthz
curl -s -m 12 -o /dev/null -w "gate %{http_code}\n" -H "x-supersonic-slug: anatf" http://8.232.255.172/
curl -s -m 15 -o /dev/null -w "anatf %{http_code}\n" https://anatf.supersonic.cv/
curl -s -m 15 -o /dev/null -w "login %{http_code}\n" https://app.supersonic.cv/login
```
Expected: `200 403 200 200`.

- [ ] **Step 3: Read a reading as an agent would**

```bash
curl -s -H "Authorization: Bearer $SUPERSONIC_TOKEN" https://oh6sn.supersonic.cv/_xray | head -c 600
```
Expected: JSON with `slug`, `door`, `open`, `live`, `builds`, and `since.live` / `since.builds`. A `builds: []` here is correct and expected — the table is new, so it fills only as apps are shipped from now on. **Do not backfill it from `deploy_stages`:** those rows have no actor, and inventing one would put a name in the field this whole design exists to keep honest.

- [ ] **Step 4: Ship something and watch `who` arrive**

```bash
SUPERSONIC_WHO=agent supersonic ship   # from a throwaway app directory
```
Then re-read `/_xray` and confirm the newest build carries `"who": "agent"`. Ship again without the variable and confirm the next one says `"someone"`, not `"you"` — the absence of a guess is the thing being verified.

- [ ] **Step 5: Confirm a browser still gets the page**

Open `https://oh6sn.supersonic.cv/_xray` in a signed-in tab. Expected: the existing x-ray page, unchanged by this plan. If it returns JSON, `wantsHtml` is wired backwards.

- [ ] **Step 6: Record what was measured**

Append to `docs/research/agent-first-dashboard.md` a short dated block: the reading's byte size for a real app, and whether `builds` filled. Both are numbers the next plan will design against, and the standing habit in this repo is to write the measurement next to the constant rather than re-derive it later.

```bash
git add docs/research/agent-first-dashboard.md
git commit -m "research: what the first real readings measured"
git push origin main
```

---

## Self-review

**Spec coverage.** Of the spec's eight "what has to be built" items, this plan covers 1 (`builds`, Task 2), 2 (`who` from the CLI, Tasks 1/3/4), 3 (assembler, Task 6), 4 (Accept split and cache headers, Task 8) and 5 (bearer, Task 7). Items 6 (HTML render takes everything from the reading), 7 (`/apps/[slug]` redirect and `Cockpit.tsx` deletion) and 8 (action forwarding) are **plan 3**, and the canvas is **plan 2** — both stated at the top rather than silently dropped.

**Deliberately not covered, and stated in the spec as such:** MCP, x-ray history or rollups, per-build stills, `undo` on fleet apps, third-party agent access.

**Type consistency.** `Who` is defined in `apps/web/lib/builds.ts` (Task 1) and re-declared in `services/proxy/src/builds.ts` (Task 5) because the two services do not share a package; the string values are identical and the database `CHECK` constraint in Task 2 is the thing that keeps them honest. `Tick` is produced by Task 5 and consumed unchanged by Task 6. `wantsHtml` is used only in Task 8, where it is defined.

**Known sharp edge.** `linesGone`'s seven days duplicates `pruneEvents(days = 7)` in the other service. The comment in Task 5 says so explicitly and names the file, because this is exactly the shape of the `lane` disagreement the glossary retired a term over.
