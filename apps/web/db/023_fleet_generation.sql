-- A counter that moves whenever any node's desired state could have changed.
--
-- The sync returns the FULL desired set on every poll, every ten seconds, per
-- node. That is O(nodes × apps) of constant load against state that changes
-- every few minutes, and it costs a deploy up to ten seconds of waiting for a
-- node to get round to asking. Measured on 11 Aug: the `fleet` stage is 25.1s
-- p50, of which `fleet-pull` is 0.0 and `fleet-boot` is 0.4 — so almost all of
-- it is the placement round trip and the poll interval inside it, not the work.
--
-- GLOBAL, NOT PER NODE, and the design document had this wrong.
--
-- It reasoned that a per-node counter is better because "a global counter wakes
-- the whole fleet on any change anywhere". That is true of the `apps` half of
-- the response and false of the `peers` half: `peersFor` hands each node the
-- OTHER nodes' apps, so placing an app on node A changes what node B must be
-- told. A per-node counter would therefore have to be bumped for every node on
-- every placement — which is a global counter with extra steps and one more
-- place to forget.
--
-- One row, enforced. A second row would make "the" generation ambiguous, and
-- the failure would be a node that never sees an update because it happened to
-- read the other one.
CREATE TABLE IF NOT EXISTS fleet_generation (
  only_row  boolean PRIMARY KEY DEFAULT true,
  generation bigint NOT NULL DEFAULT 1,
  CONSTRAINT fleet_generation_one_row CHECK (only_row)
);

INSERT INTO fleet_generation(only_row, generation) VALUES (true, 1)
  ON CONFLICT (only_row) DO NOTHING;
