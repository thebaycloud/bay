-- Accounts are identified by (email, provider), not email alone. Signing up with
-- a password and signing in with GitHub under the same email are now SEPARATE
-- accounts, each with its own apps. Replace the email-only unique with a
-- composite one. Idempotent. No data migration: email was unique before, so every
-- (email, provider) pair is already unique.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_provider_key ON users(email, provider);
