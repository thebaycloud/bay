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
