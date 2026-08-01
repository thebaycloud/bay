-- Who may read the operators' analytics.
--
-- Deliberately the same shape as `allowed_signins` (002): one row is either an
-- email or a domain, never both, and the decision is made by a pure matcher over
-- the rows. Sign-in and operator access are different questions, so they are
-- different tables — but they are answered the same way, by the same matching
-- code, so there is one place to reason about who gets in.
--
-- Seeded EMPTY on purpose. Guessing who runs this product is exactly the kind of
-- inference that has cost this codebase before; an empty table means the page is
-- reachable by nobody until a human says otherwise. To grant access:
--
--   INSERT INTO platform_admins(email, note) VALUES ('you@example.com', 'operator')
--     ON CONFLICT (email) DO NOTHING;
--
-- or set ADMIN_EMAILS=a@x.com,b@y.com on the control plane, which is read as
-- additional entries and exists so the first operator can get in without a
-- database write.

CREATE TABLE IF NOT EXISTS platform_admins (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email    text UNIQUE,
  domain   text UNIQUE,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_admins_one_of CHECK (num_nonnulls(email, domain) = 1)
);

-- Indexes the analytics queries lean on. Every one is additive and idempotent;
-- none of them changes a row.
--
-- `users` is scanned by created_at for the signups chart and the activation
-- cohorts. `apps` is scanned by owner and by created_at for apps-per-user and
-- the acquisition funnel. `deploy_stages` already has (slug, started_at) and
-- (stage, started_at) from 004; what it lacks is a way to ask "every stage in
-- this window, in order" without reading the whole table, which is what every
-- reliability and speed panel does.
CREATE INDEX IF NOT EXISTS users_created_at_idx        ON users (created_at);
CREATE INDEX IF NOT EXISTS apps_created_at_idx         ON apps (created_at);
CREATE INDEX IF NOT EXISTS deploy_stages_started_at_idx ON deploy_stages (started_at);
