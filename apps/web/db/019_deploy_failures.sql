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
