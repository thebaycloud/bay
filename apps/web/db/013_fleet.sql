-- Where an app runs, and which machine is running it.
--
-- docs/VM-FLEET.md moves the runtime off Cloud Run onto shared VMs. The decision
-- to move is one-way; the MECHANISM is deliberately per-app, because a big-bang
-- cutover with no per-app reverse is how a bad hour becomes a bad week. One
-- column decides where a given app runs, and putting a bad app back is one row
-- update.
--
-- Nothing here changes an existing app: `runtime` defaults to 'cloudrun', which
-- is exactly what every app is doing today.

-- Which runtime serves this app.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'cloudrun';

DO $$ BEGIN
  ALTER TABLE apps ADD CONSTRAINT apps_runtime CHECK (runtime IN ('cloudrun', 'fleet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The machines. A node registers itself and heartbeats; the control plane never
-- pushes to it.
--
-- `drain` is separate from simply deleting the row: draining is a state a node
-- sits in while its apps are being re-placed, and a node that vanished from the
-- table would instead look like it never existed, taking its placements with it.
CREATE TABLE IF NOT EXISTS fleet_nodes (
  name          text PRIMARY KEY,
  zone          text NOT NULL,
  internal_ip   text NOT NULL,
  -- Capacity, as reported by the node itself. Placement reads these; nothing
  -- else does.
  memory_bytes  bigint NOT NULL DEFAULT 0,
  cpus          int NOT NULL DEFAULT 0,
  drain         boolean NOT NULL DEFAULT false,
  last_seen     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Which node holds which app.
--
-- One row per placed app, not one per replica: a second replica is a second row
-- and the primary key is (slug, node), so the table can express both without a
-- schema change when web apps start getting two.
CREATE TABLE IF NOT EXISTS fleet_placements (
  slug        text NOT NULL,
  node        text NOT NULL REFERENCES fleet_nodes(name) ON DELETE CASCADE,
  -- What the node should actually run. Denormalised on purpose: the agent pulls
  -- this verbatim, and resolving it per request would put the deploy pipeline's
  -- vocabulary on the serving path.
  spec        jsonb NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, node)
);

CREATE INDEX IF NOT EXISTS fleet_placements_node_idx ON fleet_placements (node);

-- A node that has not been heard from is the thing placement most needs to find,
-- and it is a scan over a small table every time a placement decision is made.
CREATE INDEX IF NOT EXISTS fleet_nodes_last_seen_idx ON fleet_nodes (last_seen);
