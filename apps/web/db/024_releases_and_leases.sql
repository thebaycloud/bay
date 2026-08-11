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

-- An instance is a thing, not a side effect of which machine it landed on — and
-- it is added as a SECOND unique key rather than by moving the primary one.
--
-- Moving it would have been correct and would have broken production for the
-- length of a deploy. Migrations run BEFORE the build in deploy.yml, so for the
-- few minutes between the schema moving and the new code landing, the old
-- `placeApp` is still issuing `ON CONFLICT (slug, node)` — which, with that
-- constraint gone, is not a slower path or a warning. It is an error, and every
-- fleet deploy landing in that window fails on a migration that was supposed to
-- be additive.
--
-- Keeping both is not a compromise here, because both express something true:
-- one instance is on one node, and one app has at most one instance per node.
-- The planner already spreads for exactly that reason — two instances of one app
-- on one machine is one machine away from none — so the constraint records a
-- rule we already keep rather than inventing one to make a migration convenient.
-- Number the rows that already exist before the index is built, because some
-- apps have more than one and every one of them defaulted to instance 0.
--
-- Found by this migration failing on production: `Key (slug, instance)=(be47q,
-- 0) is duplicated`. An app has two placement rows on two nodes, because
-- `placeApp` upserts on (slug, node) — so a deploy that chose a different node
-- from the last one wrote a second row rather than moving the first — and
-- `placementFor` reads with LIMIT 1, so nothing in the code has ever seen the
-- second. `fleet-place.ts` names this exact shape in its own comment: "two
-- copies of the app running at once, which is exactly what this sequence exists
-- to prevent." It was already happening.
--
-- Newest first, so the placement the LAST deploy intended keeps instance 0 and
-- the older ones become surplus. The reconciler removes surplus, so this
-- converges to one instance without anything being deleted here — a migration
-- that decided which of two live copies to kill would be making that call with
-- less information than the reconciler has, and irreversibly.
UPDATE fleet_placements p
   SET instance = n.rn
  FROM (SELECT slug, node,
               row_number() OVER (PARTITION BY slug ORDER BY placed_at DESC, node) - 1 AS rn
          FROM fleet_placements) n
 WHERE n.slug = p.slug AND n.node = p.node AND p.instance <> n.rn;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fleet_placements_instance
  ON fleet_placements (slug, instance);

-- The reconciler's own query: which placements are past their lease, so the
-- control plane may take them back. Without this it is a scan of the whole
-- table on every pass, and the pass runs on a clock.
-- CONCURRENTLY, because fleet_placements already exists and every deploy and
-- every reconcile pass writes to it: a plain build would block those writes for
-- its whole duration, and a placement write that blocks is a deploy that stalls.
CREATE INDEX CONCURRENTLY IF NOT EXISTS fleet_placements_lease ON fleet_placements (lease_until);
