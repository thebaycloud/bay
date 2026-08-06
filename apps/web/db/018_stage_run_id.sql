-- Which DEPLOY a stage belongs to.
--
-- deploy_stages was keyed by (slug, started_at) and nothing else, so the only
-- way to bound one deploy was a time window — and lib/deploys.ts used thirty
-- minutes. Every attempt inside that window collapsed into one duration.
--
-- Measured on 6 Aug 2026, on the dashboard's own cards: an app whose real
-- deploy took 1m 34s from build start to publish was shown as "DEPLOYED IN
-- 23m 57s", because four attempts and a repair-agent run had happened in the
-- preceding half hour. The number is wrong in one direction — always high —
-- and wrong in proportion to how often somebody redeploys, which is to say it
-- lies hardest while a person is debugging and looking at it most.
--
-- Nullable, because every row written before this exists and the reader still
-- has to answer for those: with no run id it falls back to the window it used
-- to use, which is exactly today's behaviour rather than a gap.
ALTER TABLE deploy_stages ADD COLUMN IF NOT EXISTS run_id text;

-- CONCURRENTLY, because deploy_stages already exists and is written on every
-- stage of every deploy: a plain build would block those writes for its whole
-- duration, and a stage write that blocks is a deploy that stalls.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deploy_stages_run ON deploy_stages (run_id, started_at);
