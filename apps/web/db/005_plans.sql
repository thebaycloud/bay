-- Plans: every user is on 'basic' or 'pro'. Billing (Stripe) drives the column;
-- enforcement is gated behind GATING_ENABLED so this can ship before billing is
-- live without locking anyone out. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('basic', 'pro'));

-- The founder account already runs many apps; keep it on pro so flipping gating
-- on never locks it out. Safe no-op if the row doesn't exist yet.
UPDATE users SET plan = 'pro' WHERE email = 'arsenfounder@gmail.com';
