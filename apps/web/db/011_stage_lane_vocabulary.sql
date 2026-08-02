-- One vocabulary for `lane`, plus the two columns that make the build question
-- answerable from data instead of from argument.
--
-- THE DEFECT
--
-- There were two exported TypeScript types called `Lane`:
--
--   lib/lanes.ts   "static" | "runner" | "container" | "buildpack"   <- what deploys
--   lib/stages.ts  "static" | "fast"   | "generic"   | "runner"      <- what was recorded
--
-- Same name, two modules, overlapping on two values and disagreeing on the other
-- two. TypeScript cannot catch it — they are separate declarations — and this
-- column is `text NOT NULL`, so Postgres could not either. The result is that
-- `deploy_stages` has existed and collected data the whole time, while the
-- question it was created to answer ("what does the runner lane's cache actually
-- buy us?", 004_deploy_stages.sql) could not be computed from it, because the
-- recorded names are not the executed ones.
--
-- `generic` was worse than a rename. The pipeline opens with
-- `new StageRecorder(slug, "generic")` BEFORE any lane is known, and also uses
-- `generic` for the Dockerfile lane once it does know — so the same string means
-- "not decided yet" on one row and "this app ships a Dockerfile" on another.
-- lib/analytics/attempts.ts already had to work around exactly this with
-- LANE_BLIND_STAGES, which is the workaround becoming permanent instead of the
-- cause being fixed.
--
-- THE REWRITE
--
-- `fast` is unambiguous: it is the buildpack lane under another name.
--
-- `generic` is disambiguated by the stage, using the same rule the analytics
-- layer already trusts: on a stage that runs before the lane is chosen it meant
-- "not known", and on any later stage it meant the container lane. The stage list
-- is LANE_BLIND_STAGES in lib/analytics/attempts.ts, copied here because a
-- migration cannot import it and because this statement runs exactly once — a
-- drifting second copy needs two live readers, and after this runs there is one.
UPDATE deploy_stages SET lane = 'buildpack' WHERE lane = 'fast';

UPDATE deploy_stages SET lane = 'unknown'
 WHERE lane = 'generic'
   AND stage IN ('run-record', 'job-dispatch', 'job-cold-start', 'run-fetch', 'clone', 'detect', 'infer-services');

UPDATE deploy_stages SET lane = 'container' WHERE lane = 'generic';

-- NO CHECK CONSTRAINT HERE. It was here, and adding it in the same migration as
-- the rewrite was a mistake that reached production — see
-- db/012_stage_lane_check_is_phase_two.sql, which drops it and explains why a
-- constraint describing what the CODE writes cannot ship before that code does.
--
-- `unknown` is still a first-class value rather than NULL: a stage genuinely
-- recorded before the lane was chosen is a fact, and NULL would make it
-- indistinguishable from a row that failed to record one.

-- What the app actually ran on — "python3.12", "node22", "go1.23".
--
-- Missing until now, and it is half of what step 6 of DEPLOY-PLAN-V2 needs: the
-- lane says the runner was used, and only this says whether the deploys taking
-- that lane are the two languages it supports or the long tail it does not.
-- Null on rows written before the lane is known, and on any deploy that never got
-- far enough to find out.
ALTER TABLE deploy_stages ADD COLUMN IF NOT EXISTS runtime text;

-- Whether this was the app's FIRST successful deploy.
--
-- The other half. "Measure what the cache buys before deleting the runner lane"
-- has been repeated in three plans, and a cache hit rate is meaningless without
-- knowing which deploys could possibly have hit it. A first deploy is a
-- guaranteed cold miss — and it is also the moment the product gets judged, so it
-- is the number that decides whether a 2-4 minute cold build is affordable.
--
-- `apps.release_hash` (005_release_hash.sql) cannot stand in: it is null for
-- everything built in the cloud, which is every deploy this measures.
ALTER TABLE deploy_stages ADD COLUMN IF NOT EXISTS cold boolean;

-- No index for these two columns, deliberately.
--
-- The query they exist for — per lane and runtime, cold versus warm — is run by a
-- person deciding a build strategy, not by a request. `deploy_stages_started_at_idx`
-- (010_analytics_indexes.sql) already bounds it to the window being asked about,
-- and an index on a pre-existing table has to be built CONCURRENTLY, which cannot
-- run inside the transaction the rest of this file needs. Paying that for a query
-- that runs by hand every few weeks is the wrong trade; add it when a dashboard
-- runs it on every page load.
