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
  ('luwo.ai',       'seed: Google Workspace domain'),
  ('supersonic.cv', 'seed: Google Workspace domain')
ON CONFLICT (domain) DO NOTHING;

-- Every user who exists at migration time keeps access, whatever their domain.
INSERT INTO allowed_signins(email, note)
SELECT lower(email), 'seed: existing user at migration time' FROM users
ON CONFLICT (email) DO NOTHING;
