-- The tables that predate this migration set. They were created by hand against
-- the production database and existed nowhere in the repository, so a fresh
-- database could not be bootstrapped at all: 001 aborts on ALTER TABLE users,
-- and because each file runs as one implicit transaction the whole migration
-- rolls back.
--
-- Transcribed from the live schema. Against production every statement here is a
-- no-op; against an empty database it is the foundation the later files need.
--
-- workspaces is deliberately NOT created here — 001 owns it, and users.workspace_id
-- only gains its foreign key there, after both tables exist.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text,
  password_hash text,
  provider      text NOT NULL DEFAULT 'credentials',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cli_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text UNIQUE NOT NULL,
  name         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
