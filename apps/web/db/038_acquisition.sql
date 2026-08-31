-- How an account got here: the user came looking, or their agent chose us.
--
-- The CLI is agent-native — a coding agent runs `bay ship` on behalf of somebody
-- who may never have typed the word "bay". Those are two completely different
-- acquisition channels sharing one signup funnel, and until now they were
-- indistinguishable in the numbers. "We are winning in the model's answers" and
-- "people are hearing about us and asking for us by name" need different work,
-- and you cannot tell which one is happening from a signup count.
--
-- So the first sign-in on a machine passes `--via "<what the user asked for, in
-- their words>"`, and the classification happens HERE rather than in the CLI:
-- the agent copies a string it already has, and never gets to decide what that
-- string means. A label the agent chose would be a label the agent could get
-- wrong; a quote it copied is evidence.
--
-- Additive and idempotent, like every file here.

-- The verbatim request, capped by the CLI at 200 characters and one line. The
-- literal 'unknown' when the agent had nothing to quote — which is a different
-- fact from NULL, and worth keeping apart: 'unknown' means somebody was asked
-- and could not answer, NULL means nobody was ever asked (an account that
-- predates this, or one made in the browser).
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_via text;

-- 'named'   the request names us — the user came looking for Bay
-- 'chosen'  the request names a need, not a product — the agent picked us
-- 'unknown' asked, no answer
-- Derived from acquisition_via by lib/acquisition.ts, stored rather than
-- computed at read time so that changing the classifier later cannot silently
-- rewrite history.
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_kind text;

ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_at timestamptz;

-- FIRST TOUCH, and the index says so. Every write is
-- `WHERE id=$1 AND acquisition_via IS NULL`, so a second machine signing in to
-- an existing account cannot overwrite what the first one recorded. This index
-- exists for the funnel query — "of accounts created since X, how many chosen"
-- — which is a scan of a small column over a table nothing else groups by.
CREATE INDEX IF NOT EXISTS users_acquisition_kind_idx
  ON users (acquisition_kind, created_at)
  WHERE acquisition_kind IS NOT NULL;
