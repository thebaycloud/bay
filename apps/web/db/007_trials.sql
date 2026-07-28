-- 3-day trial + subscription status. New users start a 3-day trial (full Pro
-- access, no card); when it ends they're locked behind a paywall until they
-- subscribe. `status` mirrors Stripe once they pay.
--
-- Idempotent + grandfather-safe: columns are added nullable, existing rows are
-- backfilled to 'active' (never trialed), THEN defaults are set so only NEW rows
-- get a trial. Re-running never re-trials anyone (the backfill only touches NULLs).
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

-- Grandfather everyone who existed before trials: active, no trial deadline.
UPDATE users SET status = 'active' WHERE status IS NULL;

-- New rows: 3-day trial from creation.
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'trialing';
ALTER TABLE users ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '3 days');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('trialing', 'active', 'past_due', 'canceled'));
