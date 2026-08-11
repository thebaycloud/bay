-- Rebuild `fleet_placements_instance`, which exists and does not work.
--
-- migrate: no-transaction
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a whole
-- migration file sent as one query IS an implicit one.
--
-- WHAT HAPPENED, because the failure mode is worth writing down: 024 built this
-- index CONCURRENTLY, the first attempt hit a duplicate key that nothing in the
-- code had ever been able to see, and a concurrent build that fails LEAVES THE
-- INDEX BEHIND — marked invalid. The duplicate was then fixed and the migration
-- re-ran, where `IF NOT EXISTS` found an index by that name, concluded there was
-- nothing to do, and skipped it. So the schema had an index that pg_index
-- reports as `indisvalid = false`: unusable for lookups, and — the part that
-- actually bit — unusable as an `ON CONFLICT` target.
--
-- The reconciler has been failing every minute since it was scheduled, on
-- `there is no unique or exclusion constraint matching the ON CONFLICT
-- specification`, and nothing noticed because the fleet was already converged.
-- A loop that errors on every pass and a loop with nothing to do look identical
-- from outside when the answer is "no steps" either way.
--
-- `IF NOT EXISTS` is the wrong guard for a concurrently-built index for exactly
-- this reason, and this file is not the last one that will build one. The drop
-- below is conditional on invalidity rather than unconditional, so re-running is
-- still a no-op once the index is healthy.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'fleet_placements_instance'
       AND NOT i.indisvalid
  ) THEN
    -- Plain DROP, not DROP CONCURRENTLY: an invalid index serves no reads, so
    -- the brief lock costs nothing, and DROP CONCURRENTLY could not run inside
    -- this block anyway.
    DROP INDEX fleet_placements_instance;
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fleet_placements_instance
  ON fleet_placements (slug, instance);
