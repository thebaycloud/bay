-- Plans: every user is on 'basic' or 'pro'. Billing (Stripe) drives the column;
-- enforcement is gated behind GATING_ENABLED so this can ship before billing is
-- live without locking anyone out. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- The constraint is DROPPED here and re-added by 020_plans_v2.sql, which owns it.
--
-- It used to be re-added here too, with the two values plans had in this file's
-- day. Migrations replay in filename order on every deploy and there is no
-- tracking table, so this ran again against a database 020 had already migrated
-- to 'free' — and ADD CONSTRAINT validates existing rows, which is the one kind
-- of statement that cannot be re-asserted out of order. Every production deploy
-- since 020 landed died right here:
--
--   check constraint "users_plan_check" of relation "users" is violated by some row
--
-- Widening the list instead would work until the next plan is added and put the
-- set of legal plans in two files that have to agree. One file defines it: the
-- latest one.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

-- The founder account already runs many apps; keep it on pro so flipping gating
-- on never locks it out. Safe no-op if the row doesn't exist yet.
UPDATE users SET plan = 'pro' WHERE email = 'arsenfounder@gmail.com';
