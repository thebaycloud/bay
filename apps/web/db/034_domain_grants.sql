-- Access by ORGANISATION: "anyone with an @acme.com address", as a rule on the
-- app rather than a row per person.
--
-- A rule is not a person, so it is not a row in app_grants: that table's key is
-- an address, every reader of it treats a value as somebody who was invited by
-- name, and `email = 'acme.com'` would have been a lie in both directions.
CREATE TABLE IF NOT EXISTS app_domain_grants (
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  domain     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, domain)
);

-- Whether the identity provider proved this address belongs to this person.
--
-- Signup with a password asks for an address and never checks it, so a domain
-- rule read off an unverified row would mean "anyone who TYPED @acme.com" —
-- which is not a boundary at all, it is `public` with extra steps. Only a
-- verified row may satisfy a domain rule; invitations by name are unaffected,
-- because there the owner named the address themselves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Google is backfilled: the address comes from the Workspace/Gmail account the
-- person just signed into, and we only ever accepted it with email_verified set.
--
-- GitHub is NOT backfilled, on purpose. Until this change the profile fallback
-- would take an UNVERIFIED address off /user/emails when nothing verified was
-- there, so an existing github row is not evidence of anything. Those rows flip
-- to true on the owner's next sign-in, through the verified path in auth.ts.
UPDATE users SET email_verified = true WHERE provider = 'google' AND email_verified = false;
