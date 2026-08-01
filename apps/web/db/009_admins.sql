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

-- The index this feature needs lives in 010, on its own, because building it
-- must NOT hold a lock against a table live deploys are writing to. See that
-- file. Nothing in this one touches an existing table at all.
