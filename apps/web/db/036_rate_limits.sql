-- How often a thing may happen, as opposed to how much of it may exist.
--
-- Every other limit on this platform bounds a resource or a month's spend:
-- maxApps, monthlyBuilds, maxConcurrentDeploys, the per-run agent ceilings.
-- None of them bounds a RATE, which is why signup was unlimited and the login
-- path was protected by nothing at all. The monthly meters come closest and
-- still miss it: they bound "expensive over a month" and say nothing about a
-- thousand requests in a minute, and it is the second that takes the service
-- down and scales the control plane out.
--
-- A FIXED window, not a sliding one. Sliding costs either a row per request --
-- with the write volume and the cleanup that implies -- or an approximation
-- over two adjacent windows. The fixed window is one atomic statement and
-- nothing else. Its known weakness is a double burst across a boundary: a
-- ten-per-minute ceiling tolerates twenty in the seconds either side of the
-- tick. For refusing a password guesser, twenty is as refused as ten, and the
-- simpler mechanism is worth more than closing that gap. Written down because a
-- later reader would otherwise assume sliding was forgotten rather than
-- declined.
--
-- The key is (bucket, window_start) rather than a synthetic id, because the
-- upsert in lib/rate-limit.ts needs the conflict target to BE the identity of
-- the count. An id would make every take an insert.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start)
);

-- Unlike usage_counters, this table takes a write on every request to a
-- protected route, so nothing about it is self-limiting. lib/rate-limit.ts's
-- sweepOldWindows runs from the domains reconcile job and needs to find expired
-- rows without reading the whole table. A limiter that quietly fills the
-- platform database is a worse outage than the one it was added to prevent.
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx
  ON rate_limits (window_start);
