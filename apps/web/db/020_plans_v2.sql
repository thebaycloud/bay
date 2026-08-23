-- Free / Pro / Team, and the end of the trial.
--
-- The model this replaces was three paid tiers opening with a trial, and it had
-- two problems. A 1-app Basic tier argued with the product — small software
-- means *many* small tools, so the cap fought the thing we were selling — and a
-- trial converts a visitor into a lead somebody has to chase, when what we want
-- from a launch is a live app on a supersonic.cv URL with our badge on it.
--
-- So: free is the resting state, not a countdown. `locked` now means exactly
-- one thing — a PAID subscription lapsed — and a user who never paid can never
-- be locked out of anything.
--
-- Note on ordering: migrations are re-applied in filename order on every run,
-- so 007_trials.sql re-asserts the trialing default a few files before this one
-- runs. That is fine and deterministic — this file is the last word on it — and
-- it is why the statements below are unconditional corrections rather than
-- `IF NOT EXISTS` guards. Renumbering this file below 007 would silently undo it.
--
-- It was NOT fine for the plan CHECK, which 005_plans.sql used to re-assert with
-- the old two values. A default or an UPDATE can be overwritten by a later file;
-- ADD CONSTRAINT validates the rows that are already there, so it fails before
-- this file gets to run at all. It killed every production deploy from the day
-- this migration landed. 005 now only drops the constraint; the CHECK below is
-- the only definition of what a plan may be.

-- 1. The plan column. Migrate the data BEFORE the constraint, or the new CHECK
--    fails against every row still saying 'basic'.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

UPDATE users SET plan = 'free' WHERE plan = 'basic' OR plan IS NULL;

ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';

ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'team'));

-- 2. No more trials. New users are active on the free plan from the moment they
--    sign up; nothing expires and nothing counts down.
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE users ALTER COLUMN trial_ends_at DROP DEFAULT;

-- Anyone mid-trial when this lands becomes active rather than being dropped
-- into a paywall by a migration. `trial_ends_at` is kept (not dropped) because
-- it is the only record of who was on a trial and when — but it stops meaning
-- anything to `entitlement()`.
UPDATE users SET status = 'active' WHERE status = 'trialing' OR status IS NULL;

-- 3. Grandfather everyone who was here before pricing existed.
--
-- A fixed date, not now(): this file re-runs on every migration pass, and
-- `created_at < now()` would quietly hand a free plan to every user who signed
-- up since the last deploy. Anyone who predates the cutover keeps unlimited
-- access — they have apps that were deployed under no cap at all, and a
-- migration is not an acceptable way to tell someone their third app is over a
-- limit they never agreed to.
UPDATE users
   SET plan = 'pro', status = 'active'
 WHERE created_at < timestamptz '2026-08-06 00:00:00+00'
   AND plan = 'free';
