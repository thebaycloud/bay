-- Monthly usage counters, and the one-time free repair.
--
-- The plan limits that existed before this were all about *state* — how many
-- apps you have, how many people you shared with — and state is cheap to check
-- because you can just count the rows. The two things that actually cost money
-- are *events*: a build holds a Cloud Run Job task at 4Gi/2cpu for its whole
-- duration, and a repair agent run is an LLM session. Neither leaves a row
-- anybody was counting, so nothing bounded them.
--
-- One row per user per calendar month. Old rows are left alone: they are a few
-- bytes each and they are the only record of what a month actually looked like,
-- which is what the first real limits should be chosen from.
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start date        NOT NULL,
  builds       integer     NOT NULL DEFAULT 0,
  agent_runs   integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start)
);

-- The one free repair-agent run, spent on the first deploy that actually fails.
--
-- A column on `users` rather than a counter, because it is once per lifetime
-- rather than once per period, and because the claim has to be atomic: an
-- UPDATE ... WHERE free_fix_used_at IS NULL either takes it or does not, so two
-- concurrent failed deploys cannot both be granted the same free fix.
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_fix_used_at timestamptz;
