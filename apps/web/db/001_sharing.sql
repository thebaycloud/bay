CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain     text UNIQUE,
  kind       text NOT NULL DEFAULT 'company',
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_kind_check CHECK (kind IN ('company', 'personal')),
  CONSTRAINT workspaces_company_has_domain CHECK (kind = 'personal' OR domain IS NOT NULL)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

CREATE TABLE IF NOT EXISTS apps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  owner_id     uuid NOT NULL REFERENCES users(id),
  run_url      text,
  visibility   text NOT NULL DEFAULT 'private',
  status       text NOT NULL DEFAULT 'deploying',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apps_visibility_check CHECK (visibility IN ('private', 'shared', 'workspace')),
  CONSTRAINT apps_status_check CHECK (status IN ('deploying', 'live', 'failed'))
);

CREATE TABLE IF NOT EXISTS app_grants (
  app_id     uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, email)
);

CREATE INDEX IF NOT EXISTS apps_workspace_idx ON apps(workspace_id);
CREATE INDEX IF NOT EXISTS apps_owner_idx     ON apps(owner_id);
