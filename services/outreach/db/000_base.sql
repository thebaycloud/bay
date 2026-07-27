-- Outreach schema. Every statement is idempotent so the whole set can be
-- re-applied on every deploy without a migration-tracking table (same
-- convention as apps/web/db).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- One row per teammate's LinkedIn account. Caps live here rather than in code
-- because the safe ceiling differs per account age and per tier, and we want to
-- lower one person's limit without a deploy.
CREATE TABLE IF NOT EXISTS accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label             text NOT NULL,
  email             text UNIQUE NOT NULL,
  -- The extension authenticates with a bearer token; only its hash is stored.
  token_hash        text UNIQUE NOT NULL,
  timezone          text NOT NULL DEFAULT 'UTC',
  -- LinkedIn's free tier allows roughly 100 invites/week. 15/day leaves room
  -- under that ceiling even on a five-day week.
  daily_invite_cap  integer NOT NULL DEFAULT 15,
  daily_message_cap integer NOT NULL DEFAULT 40,
  -- Local-clock hours during which the executor is allowed to act.
  active_hour_start integer NOT NULL DEFAULT 9,
  active_hour_end   integer NOT NULL DEFAULT 18,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Prospects are globally unique by canonical profile URL, and owned by exactly
-- one account. That single owner column is what stops two teammates from
-- working the same lead.
CREATE TABLE IF NOT EXISTS prospects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_url    text UNIQUE NOT NULL,
  full_name      text,
  first_name     text,
  headline       text,
  company        text,
  title          text,
  location       text,
  -- 'post_likers' | 'post_commenters' | 'search' | 'connections' | 'csv'
  source         text NOT NULL,
  -- Post URN, search URL, or file name — whatever identifies the specific pull.
  source_ref     text,
  owner_id       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- Populated by the profile-visit enrichment pass; this is what the copy
  -- generator is allowed to reference.
  enrichment     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enriched_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prospects_owner_idx  ON prospects(owner_id);
CREATE INDEX IF NOT EXISTS prospects_source_idx ON prospects(source, source_ref);
-- The enrichment pass claims the oldest un-enriched prospects first.
CREATE INDEX IF NOT EXISTS prospects_unenriched_idx
  ON prospects(created_at) WHERE enriched_at IS NULL;

-- A scrape run is one pull from one source. Kept so the panel can show what a
-- given scrape actually produced, and so a selector regression is visible as a
-- run that suddenly returns zero.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source       text NOT NULL,
  source_ref   text,
  found_count  integer NOT NULL DEFAULT 0,
  new_count    integer NOT NULL DEFAULT 0,
  -- Set when the content script aborted, e.g. a selector no longer matched.
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scrape_runs_account_idx ON scrape_runs(account_id, created_at DESC);

-- brief drives copy generation (ICP, offer, tone, hard rules).
-- steps is the sequence: [{kind:'invite_note'|'message', delay_days:n}, ...]
CREATE TABLE IF NOT EXISTS campaigns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'draft',
  brief      jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'running', 'paused', 'done'))
);

-- One prospect's journey through one campaign.
CREATE TABLE IF NOT EXISTS enrollments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  prospect_id    uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  state          text NOT NULL DEFAULT 'pending',
  current_step   integer NOT NULL DEFAULT 0,
  next_action_at timestamptz,
  replied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, prospect_id),
  CONSTRAINT enrollments_state_check
    CHECK (state IN ('pending', 'running', 'replied', 'stopped', 'done'))
);

-- The executor polls for due work; this index is that query.
CREATE INDEX IF NOT EXISTS enrollments_due_idx
  ON enrollments(next_action_at) WHERE state IN ('pending', 'running');

-- Generated copy, one row per sequence step per enrollment. Nothing is sent
-- until status reaches 'approved', so a prompt regression stops at the queue.
CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_index    integer NOT NULL,
  kind          text NOT NULL,
  generated_text text,
  final_text     text,
  status         text NOT NULL DEFAULT 'draft',
  -- Which hard validators the generation tripped, if any.
  validator_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  model          text,
  generated_at   timestamptz,
  approved_at    timestamptz,
  sent_at        timestamptz,
  error          text,
  UNIQUE (enrollment_id, step_index),
  CONSTRAINT messages_kind_check
    CHECK (kind IN ('invite_note', 'message')),
  CONSTRAINT messages_status_check
    CHECK (status IN ('draft', 'approved', 'rejected', 'sent', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status);

-- Per-account, per-day send counters. The executor increments these in the same
-- transaction as the send so a crash cannot lose a count and overshoot the cap.
CREATE TABLE IF NOT EXISTS daily_counters (
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day           date NOT NULL,
  invites_sent  integer NOT NULL DEFAULT 0,
  messages_sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

-- Append-only audit trail. Every action the extension takes lands here.
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  prospect_id uuid REFERENCES prospects(id) ON DELETE SET NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_account_idx ON events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_type_idx    ON events(type, created_at DESC);
