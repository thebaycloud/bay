CREATE TABLE IF NOT EXISTS allowed_signins (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email    text UNIQUE,
  domain   text UNIQUE,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allowed_signins_one_of CHECK (num_nonnulls(email, domain) = 1)
);

-- Both domains are confirmed Google Workspace (MX -> Google), so everyone on
-- them can sign in with a verified address.
INSERT INTO allowed_signins(domain, note) VALUES
  ('acme.com',       'seed: Google Workspace domain'),
  ('supersonic.cv', 'seed: Google Workspace domain')
ON CONFLICT (domain) DO NOTHING;

-- Every user who exists at migration time keeps access, whatever their domain.
-- Guarded because this file also runs against a fresh database, where `users`
-- does not exist yet; the whole migration runs as one implicit transaction, so
-- an unguarded reference would roll back the CREATE TABLE above with it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'users') THEN
    INSERT INTO allowed_signins(email, note)
    SELECT lower(email), 'seed: existing user at migration time' FROM users
    ON CONFLICT (email) DO NOTHING;
  END IF;
END $$;
