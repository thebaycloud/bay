-- The placement model: an immutable release, a desired state, and a leased
-- placement per instance.
--
-- `fleet_placements` was `(slug, node) → spec`, overwritten on every deploy.
-- Four things followed from that and all four are answered here.
--
-- NO VERSION. The node compared fields by hand and two concurrent deploys raced
-- on one row with no arbiter.
--
-- NO HISTORY. `rollback` returned 501 on the fleet, honestly, and `rewind`,
-- `undo` and `shadow` went with it — and shadow is what Ask-that-changes needs.
--
-- NO WAY TO MOVE ONE INSTANCE. `unplaceApp` deletes every row for a slug, so
-- "remove from A, keep on B" was inexpressible: no migration, no replica, no
-- drain, though the primary key permitted all three.
--
-- NO LEASE. Nothing stopped the control plane re-placing a live but silent
-- node's apps and producing two copies writing to one database.
--
-- Additive and idempotent, like every file here: the primary key change is
-- guarded on the constraint it replaces, and existing rows are given the values
-- that describe what they already are — instance 0, ready, and the release they
-- are running once one is recorded for them.
--
-- migrate: no-transaction
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a whole
-- migration file sent as one query IS an implicit one. The directive makes the
-- runner send each statement separately, which is what 010 and 018 already do
-- for the same reason.

-- ---------------------------------------------------------------------------
-- Releases: the timeline.
-- ---------------------------------------------------------------------------
--
-- Immutable by rule rather than by permission: nothing updates this table. A
-- release is one successful build, and the record of what shipped must not be
-- editable by the thing that ships the next one.
--
-- `base_image` and `code_image` are the pair the architecture spec §3 settles
-- on. Both name the same digest today, because a deploy still produces one
-- image; the split exists so that when the base stops being rebuilt on every
-- deploy, it is a second value rather than a schema change.
CREATE TABLE IF NOT EXISTS releases (
  id          bigserial PRIMARY KEY,
  slug        text        NOT NULL,
  version     int         NOT NULL,
  base_image  text        NOT NULL,
  code_image  text        NOT NULL,
  spec        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT releases_version_per_app UNIQUE (slug, version)
);

-- The query this table exists to answer: "this app's releases, newest first".
CREATE INDEX IF NOT EXISTS releases_slug_version ON releases (slug, version DESC);

-- ---------------------------------------------------------------------------
-- Desired: two columns, not a table.
-- ---------------------------------------------------------------------------
--
-- One row per app is enough, and a table would add a join to every read for
-- nothing. Separating desired from ACTUAL is what makes a rollout expressible:
-- during one, some instances are on the new release and some on the old, and
-- that is a correct state rather than a divergence. No such state exists today,
-- which is why a fleet deploy is stop-then-start — that is, downtime.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS desired_release  bigint REFERENCES releases(id);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS desired_replicas int NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE apps ADD CONSTRAINT apps_desired_replicas_sane CHECK (desired_replicas BETWEEN 0 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Placements: actual, per instance, leased.
-- ---------------------------------------------------------------------------

ALTER TABLE fleet_placements ADD COLUMN IF NOT EXISTS instance   int NOT NULL DEFAULT 0;
ALTER TABLE fleet_placements ADD COLUMN IF NOT EXISTS release_id bigint REFERENCES releases(id);
ALTER TABLE fleet_placements ADD COLUMN IF NOT EXISTS lease_until timestamptz;

-- `ready`, not `starting`, for rows that already exist: they ARE serving, and
-- calling them starting would make the first reconcile pass treat every running
-- app as cover-less and refuse to drain anything for a rollout that had already
-- finished.
ALTER TABLE fleet_placements ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';

DO $$ BEGIN
  ALTER TABLE fleet_placements ADD CONSTRAINT fleet_placements_state
    CHECK (state IN ('starting', 'ready', 'draining'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The key moves from (slug, node) to (slug, instance), and that is the change
-- that makes an instance a thing rather than a side effect of which machine it
-- landed on. Keyed on the node, "move instance 1 from A to B" is a delete and an
-- insert with a window in between where the app has no placement at all; keyed
-- on the instance it is one UPDATE.
--
-- Guarded on the constraint's own name so re-running this file is a no-op, which
-- is the rule every migration here follows and the reason none of them has ever
-- had to be run by hand in the right order.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fleet_placements_pkey'
       AND conrelid = 'fleet_placements'::regclass
       AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (slug, node)%'
  ) THEN
    ALTER TABLE fleet_placements DROP CONSTRAINT fleet_placements_pkey;
    ALTER TABLE fleet_placements ADD CONSTRAINT fleet_placements_pkey PRIMARY KEY (slug, instance);
  END IF;
END $$;

-- The reconciler's own query: which placements are past their lease, so the
-- control plane may take them back. Without this it is a scan of the whole
-- table on every pass, and the pass runs on a clock.
-- CONCURRENTLY, because fleet_placements already exists and every deploy and
-- every reconcile pass writes to it: a plain build would block those writes for
-- its whole duration, and a placement write that blocks is a deploy that stalls.
CREATE INDEX CONCURRENTLY IF NOT EXISTS fleet_placements_lease ON fleet_placements (lease_until);
