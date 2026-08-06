# Keep the reason a deploy failed — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record why every deploy failed, once per attempt, so the cause survives the
repair agent and the next deploy.

**Architecture:** A new table `deploy_failures` and a `FailureRecorder` in its own module,
shaped like `lib/stages.ts` — an injectable sink so it is testable without Postgres, and
every write wrapped so telemetry can never fail a deploy. One write site in the pipeline,
where `classify` returns its verdict and before that verdict branches the flow; the repair
outcome updates the row the recorder already inserted.

**Tech Stack:** TypeScript, Postgres, `node --test` with `tsx`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-failure-causes-design.md`.
- **Recording a failure may never fail a deploy.** Every write goes through the recorder,
  which swallows and reports its own errors. No caller adds a try/catch; none should need to.
- **A blank cause is never stored.** When the pipeline produced no reason, the stored cause
  is the exact sentence `no reason captured — this is a reporting gap, not a cause`, and no
  synonym. The Done-means counts that string; two spellings would count as one gap and one
  real cause.
- **`blame` comes from `classify` (`lib/deploy-errors.ts`), never from a reimplementation
  of its rules.** It has a `PLATFORM_MARKERS` list and an `app` fallback; a copy would drift.
- `input.runId` is **optional** — the non-job path has none. The table therefore keys on a
  surrogate uuid with `run_id` nullable beside it, exactly as `deploy_stages` does.
- Work is on branch `failure-causes`, off `main` at `c5bd899`. **Never push** — a push to
  `main` deploys production. Commit only.
- All work runs from `apps/web`. Full suite: `npm test`. It is 1155 tests / 1150 pass /
  0 fail / 5 skipped at the start.

---

### Task 1: The table and the recorder

**Files:**
- Create: `apps/web/db/019_deploy_failures.sql`
- Create: `apps/web/lib/deploy-failures.ts`
- Create: `apps/web/test/deploy-failures.test.ts`

**Interfaces:**
- Consumes: `getPool` from `lib/db.ts` (database `supersonic_platform`).
- Produces:
  - `const NO_REASON: string` — the exact not-captured sentence.
  - `function causeOf(error: string | null | undefined): string` — the error, or `NO_REASON` when blank.
  - `type Repair = "skipped" | "fixed" | "gave-up"`.
  - `interface FailureRow { runId: string | null; slug: string; ownerId: string | null; stage: string | null; cause: string; blame: "platform" | "app" }`
  - `interface FailureSink { insert(row: FailureRow): Promise<string>; setRepair(id: string, repair: Repair, summary: string | null): Promise<void> }`
  - `class FailureRecorder` with `constructor(sink?: FailureSink, onError?: (e: unknown) => void)`, `record(row: FailureRow): Promise<void>`, `repaired(repair: Repair, summary: string | null): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/deploy-failures.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  causeOf, NO_REASON, FailureRecorder,
  type FailureRow, type FailureSink, type Repair,
} from "../lib/deploy-failures";

function recordingSink() {
  const rows: FailureRow[] = [];
  const repairs: { id: string; repair: Repair; summary: string | null }[] = [];
  const sink: FailureSink = {
    async insert(r) { rows.push(r); return `id-${rows.length}`; },
    async setRepair(id, repair, summary) { repairs.push({ id, repair, summary }); },
  };
  return { sink, rows, repairs };
}

const row = (over: Partial<FailureRow> = {}): FailureRow => ({
  runId: "run-1", slug: "abc12", ownerId: "owner-1",
  stage: "build", cause: "Build failed:\nmissing module", blame: "app", ...over,
});

test("causeOf keeps a real reason exactly as it was", () => {
  assert.equal(causeOf("Build failed:\nmissing module"), "Build failed:\nmissing module");
});

test("causeOf turns a blank reason into the not-captured sentence", () => {
  // `??` guards null and lets "" through, which is how six of twenty-three
  // recorded failures ended up saying nothing at all. Whitespace counts as blank:
  // a row containing a newline is no more of a cause than an empty one.
  for (const blank of [null, undefined, "", "   ", "\n\t"]) {
    assert.equal(causeOf(blank), NO_REASON);
  }
});

test("the not-captured sentence is one exact string", () => {
  // The success criterion counts rows carrying it. Two spellings would count as
  // one reporting gap and one real cause.
  assert.equal(NO_REASON, "no reason captured — this is a reporting gap, not a cause");
});

test("recording a failure writes one row, as given", async () => {
  const { sink, rows } = recordingSink();
  await new FailureRecorder(sink).record(row());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row());
});

test("the repair outcome updates the row that was inserted", async () => {
  // Not a second row: a failed-then-repaired attempt is one attempt.
  const { sink, rows, repairs } = recordingSink();
  const r = new FailureRecorder(sink);
  await r.record(row());
  await r.repaired("gave-up", "opencode couldn't get it live after 2 redeploys");
  assert.equal(rows.length, 1);
  assert.deepEqual(repairs, [{ id: "id-1", repair: "gave-up", summary: "opencode couldn't get it live after 2 redeploys" }]);
});

test("a repair outcome with nothing recorded is dropped, not invented", async () => {
  // If the insert failed, there is no row to update. Inventing one would put a
  // repair verdict in the table with no cause beside it — the exact shape this
  // table exists to stop.
  const { sink, repairs } = recordingSink();
  await new FailureRecorder(sink).repaired("fixed", "fixed it");
  assert.deepEqual(repairs, []);
});

test("a sink that throws costs the record, never the deploy", async () => {
  const errors: unknown[] = [];
  const exploding: FailureSink = {
    async insert() { throw new Error("database is down"); },
    async setRepair() { throw new Error("database is down"); },
  };
  const r = new FailureRecorder(exploding, (e) => errors.push(e));
  await assert.doesNotReject(() => r.record(row()));
  await assert.doesNotReject(() => r.repaired("fixed", "fixed it"));
  assert.equal(errors.length, 1, "the insert threw and was reported; the repair had no row to update");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-failures.test.ts`

Expected: FAIL — cannot find module `../lib/deploy-failures`.

- [ ] **Step 3: Write the migration**

Create `apps/web/db/019_deploy_failures.sql`:

```sql
-- Why a deploy failed, kept per ATTEMPT.
--
-- `deploys` holds one row per app, so its `error` column is overwritten by the
-- next deploy whatever else happens — and before that, by the repair agent's own
-- verdict (deploy-pipeline.ts wrote `fixed.summary` over the cause that sent the
-- deploy to the agent in the first place). Measured on 6 Aug 2026: nine of the
-- twelve app-blamed failures on file read "codex couldn't get it live after N
-- redeploys", which is the agent's conclusion, not the failure. Six more carried
-- no error text at all. So a quarter of failures never said why and most of the
-- rest had their reason replaced by the thing called in to fix them.
--
-- Keyed on a surrogate id rather than run_id, and run_id nullable beside it,
-- because `runId` is optional on the in-request deploy path — the same reason
-- deploy_stages is shaped this way.
CREATE TABLE IF NOT EXISTS deploy_failures (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         text,
  slug           text NOT NULL,
  -- In the row rather than behind a join to `apps`: "ours or a user's" is the
  -- first question anyone asks of this table, and answering it took a bespoke
  -- script the day the table was designed.
  owner_id       text,
  stage          text,
  cause          text NOT NULL,
  blame          text NOT NULL,
  repair         text,
  repair_summary text,
  failed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deploy_failures_blame CHECK (blame IN ('platform', 'app')),
  CONSTRAINT deploy_failures_repair CHECK (repair IS NULL OR repair IN ('skipped', 'fixed', 'gave-up')),
  -- The database's own backstop for the rule the code already enforces. A blank
  -- cause is the defect this table was built to end, and a CHECK is the one place
  -- it cannot be reintroduced by a caller that forgets to go through `causeOf`.
  CONSTRAINT deploy_failures_cause CHECK (btrim(cause) <> '')
);

CREATE INDEX IF NOT EXISTS deploy_failures_slug ON deploy_failures (slug, failed_at DESC);
CREATE INDEX IF NOT EXISTS deploy_failures_blame ON deploy_failures (blame, failed_at DESC);
```

- [ ] **Step 4: Write the recorder**

Create `apps/web/lib/deploy-failures.ts`:

```ts
import { getPool } from "./db";

const DB = "supersonic_platform";

/**
 * What is stored when a failure arrived with no reason attached.
 *
 * One exact string, because the success criterion for this work counts rows
 * carrying it — it is the size of the remaining reporting gap. Two spellings
 * would count as one gap and one real cause, which is the measurement failing
 * quietly rather than loudly.
 */
export const NO_REASON = "no reason captured — this is a reporting gap, not a cause";

/**
 * The error, or the fact that there wasn't one.
 *
 * `result.error ?? "deploy failed"` in the pipeline guards null and lets `""`
 * straight through, because `??` does not test for blank — which is how six of
 * twenty-three recorded failures came to say nothing. Whitespace is blank too: a
 * cause of "\n" is no more of an answer than an empty one.
 */
export function causeOf(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  return e === "" ? NO_REASON : error!;
}

export type Repair = "skipped" | "fixed" | "gave-up";

export interface FailureRow {
  runId: string | null;
  slug: string;
  ownerId: string | null;
  stage: string | null;
  cause: string;
  blame: "platform" | "app";
}

/** Where a failure is written. Swapped out in tests. */
export interface FailureSink {
  insert(row: FailureRow): Promise<string>;
  setRepair(id: string, repair: Repair, summary: string | null): Promise<void>;
}

export const postgresSink: FailureSink = {
  async insert(row) {
    const { rows } = await getPool(DB).query<{ id: string }>(
      `INSERT INTO deploy_failures (run_id, slug, owner_id, stage, cause, blame)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [row.runId, row.slug, row.ownerId, row.stage, row.cause, row.blame],
    );
    return rows[0].id;
  },
  async setRepair(id, repair, summary) {
    await getPool(DB).query(
      `UPDATE deploy_failures SET repair = $2, repair_summary = $3 WHERE id = $1`,
      [id, repair, summary],
    );
  },
};

/**
 * Records why one deploy failed, and how the repair of it ended.
 *
 * One recorder per deploy: it holds the id of the row it inserted so the repair
 * outcome lands on that row rather than on a second one. A failed-then-repaired
 * attempt is one attempt.
 *
 * Every write is wrapped, for the same reason `StageRecorder`'s are: a broken
 * sink must cost us the observation and nothing else. That is the most important
 * property of this class.
 */
export class FailureRecorder {
  private id: string | null = null;

  constructor(
    private readonly sink: FailureSink = postgresSink,
    private readonly onError: (e: unknown) => void = (e) => console.error("failure record failed", e),
  ) {}

  /** The cause, at the moment blame is decided and before it branches the flow. */
  async record(row: FailureRow): Promise<void> {
    try {
      this.id = await this.sink.insert(row);
    } catch (e) {
      this.onError(e);
    }
  }

  /**
   * How the repair ended.
   *
   * Silently does nothing when no row was inserted: without a cause beside it, a
   * repair verdict alone is the shape this table exists to stop.
   */
  async repaired(repair: Repair, summary: string | null): Promise<void> {
    if (!this.id) return;
    try {
      await this.sink.setRepair(this.id, repair, summary);
    } catch (e) {
      this.onError(e);
    }
  }
}
```

- [ ] **Step 5: Run the new tests, then the full suite**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-failures.test.ts`
Expected: PASS, 7/7.

Then: `cd apps/web && npm test`
Expected: PASS, 1162 tests with 1157 passing (1155/1150 before, plus 7).

- [ ] **Step 6: Commit**

```bash
git add apps/web/db/019_deploy_failures.sql apps/web/lib/deploy-failures.ts apps/web/test/deploy-failures.test.ts
git commit -m "web: a place to keep why a deploy failed

deploys holds one row per app, so its error column is overwritten by the next
deploy whatever else happens — and before that, by the repair agent writing
its own verdict over the cause that sent the deploy to it. Measured on 6 Aug:
nine of the twelve app-blamed failures on file say \"codex couldn't get it
live after N redeploys\", which is the agent's conclusion rather than the
failure, and six more carry no error text at all.

Keyed on a surrogate id with run_id nullable beside it, because runId is
optional on the in-request path — the same shape deploy_stages has for the
same reason.

A blank cause is stored as one exact sentence saying so, and the column has a
CHECK behind it. The success criterion counts rows carrying that sentence, so
it is the size of the remaining reporting gap rather than noise; two spellings
would have counted as one gap and one real cause.

Writes are wrapped like StageRecorder's: a broken sink costs the observation
and never the deploy."
```

---

### Task 2: Record the failure where blame is decided

**Files:**
- Modify: `apps/web/lib/deploy-pipeline.ts` — around `:3856` (the `classify` call), `:3869`
  (the not-Pro branch), `:3923` (`if (fixed.ok)`) and `:3959` (the gave-up branch)
- Test: `apps/web/test/deploy-failures.test.ts` (created in Task 1; add the wiring cases)

**Interfaces:**
- Consumes: `causeOf`, `FailureRecorder`, `type Repair` from `lib/deploy-failures.ts`;
  `classify` from `lib/deploy-errors.ts`; `stages.failedStage()`; `input.runId`, `slug`,
  `ownerId`, `limits.autoFix`, `result.error`, `fixed.ok`, `fixed.summary`, all already in
  scope at those lines.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Read the site before changing it**

Open `apps/web/lib/deploy-pipeline.ts` and find `const blame = classify(result.error);`. Line
numbers in this plan were taken before you started — locate by content and say in your
report if anything has moved. Read from the `const failedIn = stages.failedStage();` above it
down to the end of the repair branch, so you can see all four places the flow can end.

The shape is: `classify` decides; a **platform** verdict rolls back and returns; a
non-Pro **app** verdict returns with a fix prompt; otherwise the repair agent runs and
either succeeds (`fixed.ok`) or gives up.

- [ ] **Step 2: Write the failing tests**

Add to `apps/web/test/deploy-failures.test.ts`:

```ts
import { classify } from "../lib/deploy-errors";

test("the blame stored is whatever classify returned, not a copy of its rules", () => {
  // classify carries a PLATFORM_MARKERS list and an `app` fallback. A second
  // implementation of "is this the platform's fault" would drift from it, and the
  // drift would be invisible: both answers are plausible strings.
  const platform = "Release failed — the previous revision is still serving.";
  const app = "SyntaxError: unexpected token";
  assert.equal(classify(platform).blame, "platform");
  assert.equal(classify(app).blame, "app");
});

test("a failure with no error text is recorded as a platform failure with the not-captured cause", async () => {
  // The two halves of the same six rows: classify already calls a reasonless
  // failure the platform's fault, and causeOf gives it a cause that says so.
  const { sink, rows } = recordingSink();
  await new FailureRecorder(sink).record(row({ cause: causeOf(""), blame: classify("").blame }));
  assert.equal(rows[0].cause, NO_REASON);
  assert.equal(rows[0].blame, "platform");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-failures.test.ts`
Expected: FAIL — `classify` is not imported yet in that file.

(If they pass immediately because you added the import in Step 2, that is fine — the
behavioural assertions still hold and Step 4 is what this task is for. Say so in your report
rather than contriving a red.)

- [ ] **Step 4: Wire the recorder into the pipeline**

Add to the imports at the top of `apps/web/lib/deploy-pipeline.ts`:

```ts
import { causeOf, FailureRecorder } from "./deploy-failures";
```

Immediately after `const blame = classify(result.error);`, insert:

```ts
      // The cause, recorded before the verdict branches the flow — this is the
      // last point at which it is still intact. Below, a platform verdict
      // returns, a non-Pro app verdict returns, and the repair agent overwrites
      // `deploys.error` with its own summary; `deploys` also holds one row per
      // app, so the next deploy discards whatever survived that.
      const failure = new FailureRecorder();
      await failure.record({
        runId: input.runId ?? null,
        slug,
        ownerId: ownerId ?? null,
        stage: failedIn,
        cause: causeOf(result.error),
        blame: blame.blame,
      });
```

Then record how it ended, at each of the three points the flow can leave:

- in the **platform** branch, before its `return`: `await failure.repaired("skipped", null);`
  — the repair agent is never called for a platform failure, and "skipped" says that
  deliberately rather than leaving `null`, which means "we do not know".
- in the **not-Pro** branch, before its `return`: `await failure.repaired("skipped", null);`
- at `if (fixed.ok)`, on the success side: `await failure.repaired("fixed", fixed.summary);`
- in the **gave-up** branch beside `setDeploy(slug, { status: "failed", error: fixed.summary })`:
  `await failure.repaired("gave-up", fixed.summary);`

Leave `setDeploy(..., error: fixed.summary)` exactly as it is. For the user, the app's
current state genuinely is the agent's verdict; the cause is no longer lost by it.

- [ ] **Step 5: Run the full suite**

Run: `cd apps/web && npm test`

Expected: PASS. The pipeline's own tests construct `runDeploy` inputs and must not have
acquired a Postgres dependency — `FailureRecorder`'s default sink only touches the pool when
a write actually happens, and its errors are swallowed, so a test that fails a deploy will
log a failed record rather than break. **If any pipeline test now fails or prints a database
error, stop and report it** rather than adding a mock: it means the default sink is being
reached in a test environment, and where the seam belongs is a design question, not a
mechanical one.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/deploy-pipeline.ts apps/web/test/deploy-failures.test.ts
git commit -m "web: record the cause where blame is decided, not after

classify's verdict is the last point at which the original failure is still
intact: below it a platform verdict returns, a non-Pro verdict returns, and the
repair agent writes its own summary over deploys.error. The cause is written
there, and how the repair ended updates that same row afterwards.

Every exit records an outcome, including the two that never call the agent —
they store \"skipped\" rather than leaving null, because null has to keep
meaning \"we do not know\" if it is to be worth anything.

setDeploy keeps writing the agent's summary. For the user the app's current
state genuinely is that verdict; it just is not the only copy any more."
```

---

### Task 3: A header with no body is not an error message

**Files:**
- Modify: `apps/web/lib/deploy-pipeline.ts` — three sites: `Build failed:` around `:2842`
  and `:3385`, `Prepare failed:` around `:3444`
- Test: `apps/web/test/deploy-failures.test.ts`

**Interfaces:**
- Consumes: `NO_REASON` from `lib/deploy-failures.ts`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/test/deploy-failures.test.ts`:

Add `failureSentence` to the existing `../lib/deploy-failures` import at the top of the file
rather than writing a second import statement from the same module, then add:

```ts
test("a build failure with a reason reads as the reason", () => {
  assert.equal(failureSentence("Build failed", "missing module 'x'"), "Build failed:\nmissing module 'x'");
});

test("a build failure with no reason says the reason is missing, not nothing", () => {
  // Three rows on file read exactly "Build failed:" or "Prepare failed:" with
  // nothing after the colon — a header whose body was empty. That is
  // indistinguishable from a message someone truncated, and it sends a reader
  // looking for a cause that was never captured.
  for (const blank of [null, undefined, "", "  \n"]) {
    assert.equal(failureSentence("Build failed", blank), `Build failed — ${NO_REASON}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && node --experimental-test-module-mocks --import tsx --test test/deploy-failures.test.ts`
Expected: FAIL — `failureSentence` is not exported.

- [ ] **Step 3: Implement**

Add to `apps/web/lib/deploy-failures.ts`:

```ts
/**
 * A failure headline joined to its reason, or an honest sentence when there is none.
 *
 * `Build failed:\n${reason}` renders as exactly `Build failed:` when the reason is
 * empty, and three rows on file are that. A header with nothing after the colon
 * reads like a message somebody truncated, so it sends its reader hunting for a
 * cause that was never captured — while a sentence saying the reason is missing
 * points at the reporting gap, which is where the bug actually is.
 */
export function failureSentence(headline: string, reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  return r === "" ? `${headline} — ${NO_REASON}` : `${headline}:\n${reason}`;
}
```

- [ ] **Step 4: Use it at all three sites**

In `apps/web/lib/deploy-pipeline.ts`, import it alongside the existing import from that module:

```ts
import { causeOf, failureSentence, FailureRecorder } from "./deploy-failures";
```

Then replace each construction. Locate them by content; the line numbers are from before you
started.

- `return { ok: false, error: \`Build failed:\n${reason}\` };`
  → `return { ok: false, error: failureSentence("Build failed", reason) };`
- `return { ok: false, error: reason ? \`Build failed:\n${reason}\` : "the build failed — check the logs" };`
  → `return { ok: false, error: failureSentence("Build failed", reason) };`
  (the ternary's fallback is replaced deliberately: "check the logs" is advice, not a cause,
  and it is the same missing reason wearing a friendlier sentence)
- `return { ok: false, error: \`Prepare failed:\n${buildLog || (e instanceof Error ? e.message : String(e))}\` };`
  → `return { ok: false, error: failureSentence("Prepare failed", buildLog || (e instanceof Error ? e.message : String(e))) };`

- [ ] **Step 5: Run the full suite**

Run: `cd apps/web && npm test`
Expected: PASS. If a pipeline test asserts on the old `"the build failed — check the logs"`
string, update that assertion — the message changed on purpose — and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/deploy-failures.ts apps/web/lib/deploy-pipeline.ts apps/web/test/deploy-failures.test.ts
git commit -m "web: say the reason is missing instead of printing a bare colon

Build failed:\\n\${reason} renders as exactly \"Build failed:\" when reason is
empty, and three rows on file are that. A header with nothing after the colon
reads like a truncated message, so it sends its reader hunting for a cause
that was never captured, when the bug is that nothing captured one.

The \"check the logs\" fallback goes the same way: advice is not a cause, and
it was the same missing reason wearing a friendlier sentence."
```

---

## After the plan

`scripts/failure-blame.ts` already re-derives blame over historical rows and is committed.
Once this is deployed and twenty failures have accumulated, it and a query over
`deploy_failures` answer the two questions that could not be asked before: what breaks most
often, and how many failures still arrive with no reason attached. The second number is the
size of the remaining reporting gap, and a large one is the next piece of work rather than a
success.
