-- What a node says it is actually RUNNING.
--
-- 014 stored the other half: a process whose start failed. That was enough to
-- keep a repair agent out of a customer's repository and it is not enough to
-- verify a deploy, because absence on that channel is not evidence. The agent
-- writes a fault only when a start returns an error, so "nothing failing" is
-- equally what it says about a process it has not fetched yet, one blocked
-- behind a release still running, and one whose release failed. A worker-only
-- app publishes no route, so absence-plus-time was the only verdict available
-- to `placeOnFleet` and it passes an app that never came up.
--
-- So: rows here are POSITIVE claims, and that inverts the trust model of 014. A
-- forged fault row costs one rolled-back deploy; a forged row HERE steers a
-- deploy to PASS and flips run_url onto a node running nothing. FLEET_TOKEN is
-- a shared secret and any holder can post as any node, which is why
-- recordNodeRunning accepts a row only for a (slug, node) pair that already
-- exists in fleet_placements — the same join recordNodeFaults makes, load-bearing
-- for a stronger reason.
CREATE TABLE IF NOT EXISTS fleet_process_running (
  slug        text NOT NULL,
  node        text NOT NULL REFERENCES fleet_nodes(name) ON DELETE CASCADE,
  process     text NOT NULL,
  -- The image and command the node is running, not the ones it was given.
  --
  -- Both, because both together are the agent's own predicate for "this is a
  -- different program": reconcileOnce leaves a live process alone only while the
  -- image AND the command still match what was placed. Storing the image alone
  -- would let a redeploy that changed a worker's command verify against the
  -- process still running the old one — and, because reported_at is refreshed on
  -- every sync, verify against it INSTANTLY.
  image       text NOT NULL,
  -- jsonb rather than text[]: this arrives as a JSON array from the node and is
  -- compared to a JSON array built by the control plane, so keeping it in that
  -- shape means no serialisation rule has to agree in two places.
  command     jsonb,
  -- Refreshed on every sync even when nothing changed, exactly as
  -- fleet_process_faults.reported_at is. A row nobody is still claiming must go
  -- stale rather than vouch for a process forever — and here that matters more,
  -- because the reader is deciding whether a deploy succeeded.
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, node, process)
);

CREATE INDEX IF NOT EXISTS fleet_process_running_slug_idx ON fleet_process_running (slug);
