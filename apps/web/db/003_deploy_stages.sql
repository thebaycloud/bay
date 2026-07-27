-- One row per pipeline stage per deploy.
--
-- Before this there was no server-side record of a deploy at all: the stages
-- existed only in the SSE stream to one browser, and `deploys.stage` kept a
-- single latest string, throttled to one write per 2.5s. When someone asked why
-- their deploy took eight minutes there was nothing to read.
--
-- This is also how the fast-deploy work gets checked — the lane targets in the
-- design are projections until this table has data behind them.

CREATE TABLE IF NOT EXISTS deploy_stages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL,
  lane       text NOT NULL,
  stage      text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz,
  outcome    text,
  CONSTRAINT deploy_stages_outcome CHECK (outcome IS NULL OR outcome IN ('ok', 'failed', 'skipped'))
);

-- The query this table exists to answer is "show me the stages of this deploy,
-- in order", and after that "how has this stage trended".
CREATE INDEX IF NOT EXISTS deploy_stages_slug_started ON deploy_stages (slug, started_at DESC);
CREATE INDEX IF NOT EXISTS deploy_stages_stage_started ON deploy_stages (stage, started_at DESC);
