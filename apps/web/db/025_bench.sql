-- What a measured deploy actually cost, and what the agent burned doing it.
--
-- Two tables, for the two things nothing could answer before.
--
-- The first is the harness's own record. `deploy_stages` knows what happened
-- once a run existed; it cannot know when the person hit enter, how long the
-- reserve took, or whether the URL ever answered afterwards — the first two
-- happen before any run_id is minted and the third happens after the pipeline
-- has already declared victory. Those are exactly the segments a user
-- experiences and the ones no server-side table can see.
--
-- The second is the money. Token counts have been computed on every agent run
-- since opencode landed and then written to a log line (`lib/opencode-deploy.ts`
-- and `lib/agents/harness.ts` both return them), which means the single largest
-- variable cost of a deploy has only ever been readable by grepping Cloud
-- Logging for a sentence. A run that cost four dollars and one that cost four
-- cents are indistinguishable in every table we have.

-- One row per harness deploy.
--
-- Deliberately does NOT copy the server-side stage timings. Those live in
-- `deploy_stages` and join to this by run_id; duplicating them here would give
-- the same measurement two homes, and the moment a stage boundary moves the two
-- would disagree with no way to tell which was right.
--
-- No foreign keys, on purpose. A bench app is deleted as soon as it is measured
-- — that is the point of the cold mode — and the measurement must outlive the
-- app, the slug and the owner. A cascade here would quietly erase the history
-- every time the harness cleaned up after itself.
CREATE TABLE IF NOT EXISTS bench_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The batch this belongs to, so two runs of the harness a week apart are not
  -- silently averaged together.
  batch      text NOT NULL,
  -- Which control plane took the deploy. The whole reason both exist: prod runs
  -- the deploy through a Cloud Run job (DEPLOY_JOB=1) and local runs it inside
  -- the request, so the difference between the two IS the handoff and cold-start
  -- cost that `app/api/deploy/route.ts` describes as unmeasured.
  target     text NOT NULL,
  project    text NOT NULL,
  -- What was deployed, exactly. The SHA is not decoration: a corpus that tracks
  -- a branch stops being a corpus the first time upstream merges anything, and
  -- every number taken before that becomes uncomparable with every number after.
  repo_url   text NOT NULL,
  repo_sha   text NOT NULL,
  -- cold = a slug nobody has deployed before, warm = the same app again.
  -- `plan-cache.ts`, `clone-cache.ts` and the build cache make these two
  -- genuinely different events, and a benchmark that does not say which one it
  -- measured is reporting the order its rows happened to run in.
  mode       text NOT NULL,
  rep        integer NOT NULL,
  -- How many deploys the harness had in flight when this one ran.
  --
  -- The column that decides whether a duration on this row may be compared with
  -- a duration on another. Above 1, the harness's own deploys queue behind one
  -- shared Cloud Build pool and each other's cold starts, so the timings measure
  -- the batch rather than the deploy — which is the price of a batch that
  -- finishes in ten minutes instead of six hours, and worth paying for the runs
  -- that are asking about correctness rather than time.
  --
  -- Defaulted to 1 rather than left nullable because every row written before
  -- this column existed was, in fact, sequential.
  concurrency integer NOT NULL DEFAULT 1,

  -- Null when the deploy died before the server minted one — a plan limit, a
  -- refused request, a 503. That is a real outcome and must still be recorded.
  run_id     text,
  slug       text,
  url        text,

  -- The client's clock, in milliseconds from the moment the command was issued.
  -- Each is null until it happens, and null means "never did", not "zero".
  started_at      timestamptz NOT NULL DEFAULT now(),
  reserved_ms     integer,
  -- There is deliberately no `enqueued_ms` here. The enqueue is the one segment
  -- the server can see exactly — `run-record` and `job-dispatch` in
  -- `deploy_stages`, joined by run_id — and a client-side approximation of it
  -- beside the real thing would be a second answer to a question that already
  -- has one.
  -- When the pipeline said live.
  activated_ms    integer,
  -- When the harness itself got a good response from the URL. The honest finish
  -- line: the gap between this and `activated_ms` is how long a user keeps
  -- staring at a page after we have already ticked the box.
  first_ok_ms     integer,
  finished_at     timestamptz,

  outcome    text NOT NULL,
  -- The measured outcome against what the corpus said to expect. `platform` is
  -- its own answer rather than a failure: a 429 or an IAM error says nothing
  -- about whether we can deploy the repo, and folding those into the failure
  -- rate makes the platform's worst days look like the product's.
  --
  -- `inconclusive` is the same idea aimed at ourselves: the harness stopped
  -- watching before the deploy resolved. On 10 Aug two rows recorded `failed` at
  -- 150s and 198s while the server was still building both, because `budgetS` is
  -- a number somebody guessed at before any deploy had been measured. A guess
  -- that expires must not become a fact about the product.
  verdict    text,
  reason     text,
  error      text,

  -- What the CONTROL PLANE said, as opposed to what the CLI could see.
  --
  -- The CLI reports a stream that ended and an exit code; the server knows which
  -- stage it was in and why it stopped. Every finding on 10 Aug came from asking
  -- `/api/apps/<slug>/deploy-status` by hand after the fact, because the row said
  -- `failed` and nothing more — an hour of investigation per red row. `stage` is
  -- the last stage the pipeline entered, which is the answer to "where did it
  -- break"; the full timeline is in `deploy_stages`, joined by run_id.
  server_status text,
  server_stage  text,
  server_error  text,
  -- The deploy's own ERROR lines, oldest first. `server_stage` says where it
  -- broke and is the LAST thing said, which for a failed deploy is the repair
  -- agent's closing summary; this is the cause. epic-stack on 10 Aug recorded
  -- "agent · Deployment cannot be repaired in the repository." — true, and three
  -- layers above "Environment variable not found: DATABASE_URL", which is the
  -- only sentence in the whole run that says what to fix.
  server_log    text,

  CONSTRAINT bench_runs_target  CHECK (target IN ('local', 'prod')),
  CONSTRAINT bench_runs_mode    CHECK (mode IN ('cold', 'warm')),
  CONSTRAINT bench_runs_outcome CHECK (outcome IN ('live', 'failed', 'timeout', 'refused')),
  CONSTRAINT bench_runs_verdict CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'platform', 'inconclusive'))
);

-- `CREATE TABLE IF NOT EXISTS` above is a no-op against a table that already
-- exists, so a column added to it after the first run has to be added again
-- here. Every migration in this directory is applied on every deploy; this is
-- what keeps that promise true for a table someone already has.
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS concurrency   integer NOT NULL DEFAULT 1;
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS server_status text;
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS server_stage  text;
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS server_error  text;
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS server_log    text;
-- Same reasoning as the columns: a constraint written before `inconclusive`
-- existed rejects every row that uses it, and the table may already be out there.
ALTER TABLE bench_runs DROP CONSTRAINT IF EXISTS bench_runs_verdict;
ALTER TABLE bench_runs ADD  CONSTRAINT bench_runs_verdict
  CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'platform', 'inconclusive'));

-- The two questions asked of this table: "how did this batch do" and "how has
-- this project trended".
CREATE INDEX IF NOT EXISTS bench_runs_batch   ON bench_runs (batch, project);
CREATE INDEX IF NOT EXISTS bench_runs_project ON bench_runs (project, started_at DESC);
CREATE INDEX IF NOT EXISTS bench_runs_run     ON bench_runs (run_id);

-- One row per LLM session inside a deploy.
--
-- Per session rather than per deploy, because a deploy can hold two of them with
-- very different economics: the planner reads the repo on every plan-cache miss
-- and is charged to the happy path, while the repair agent runs only on failure.
-- Summed together they answer "what did this deploy cost"; kept apart they
-- answer "which half is expensive", and only the second one tells you what to
-- fix.
CREATE TABLE IF NOT EXISTS deploy_agent_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      text,
  slug        text NOT NULL,
  -- 'planner' or 'repair'. See above.
  role        text NOT NULL,
  -- Which CLI ran and which model it drove. Both are a `process.env` away from
  -- changing (`DEPLOY_AGENT`, `OPENCODE_MODEL`), so a token count that does not
  -- record them is a number with no units.
  engine      text NOT NULL,
  model       text NOT NULL,

  -- bigint because a single wandering repair run has already been observed at
  -- 2.2M tokens (see the note in lib/fleet-place.ts).
  tokens_in         bigint NOT NULL DEFAULT 0,
  tokens_out        bigint NOT NULL DEFAULT 0,
  tokens_reasoning  bigint NOT NULL DEFAULT 0,
  tokens_cache_read bigint NOT NULL DEFAULT 0,
  tokens_cache_write bigint NOT NULL DEFAULT 0,

  steps       integer NOT NULL DEFAULT 0,
  redeploys   integer NOT NULL DEFAULT 0,
  duration_ms integer,
  -- What the session came to. 'gave-up' is not 'error': one is the agent
  -- concluding it could not fix the app, the other is the agent failing to run.
  outcome     text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deploy_agent_runs_role    CHECK (role IN ('planner', 'repair')),
  CONSTRAINT deploy_agent_runs_outcome CHECK (outcome IN ('ok', 'fixed', 'gave-up', 'timeout', 'error'))
);

CREATE INDEX IF NOT EXISTS deploy_agent_runs_run  ON deploy_agent_runs (run_id);
CREATE INDEX IF NOT EXISTS deploy_agent_runs_slug ON deploy_agent_runs (slug, at DESC);
-- "What have the agents cost lately", which is the question that pays for this
-- table.
CREATE INDEX IF NOT EXISTS deploy_agent_runs_at   ON deploy_agent_runs (at DESC);
