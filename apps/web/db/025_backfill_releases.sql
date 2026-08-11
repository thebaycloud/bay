-- Give every app that is already running a release to point at.
--
-- 024 added `releases` and `apps.desired_release`, both empty. The reconciler
-- reads a null `desired_release` as "this app should not run anywhere" — which
-- is the correct meaning of the column and a catastrophe applied to the
-- twenty-six apps that were placed before it existed. Its first pass would have
-- removed every one of them, correctly, from a picture nobody had filled in.
--
-- So the picture is filled in here rather than left to the first deploy of each
-- app, because "it will be fixed the next time somebody redeploys" is not a
-- thing to say about a table that decides whether running apps keep running.
--
-- The release is reconstructed from the placement's own spec, which is exactly
-- what the node is running right now — so what is recorded is what shipped,
-- not a guess at it. `version` is 1 for all of them: this is the first release
-- any of these apps has ever had recorded, and pretending to know their history
-- would be inventing one.
--
-- Idempotent by the WHERE clauses, like every file here. An app that already has
-- a desired_release is left alone, and a second run inserts nothing.

-- One release per placed app, from what that app is actually running.
INSERT INTO releases (slug, version, base_image, code_image, spec)
SELECT p.slug,
       1,
       COALESCE(p.spec->>'image', ''),
       COALESCE(p.spec->>'image', ''),
       p.spec
  FROM fleet_placements p
  JOIN apps a ON a.slug = p.slug
 WHERE a.runtime = 'fleet'
   AND a.desired_release IS NULL
   AND p.spec ? 'image'
   AND NOT EXISTS (SELECT 1 FROM releases r WHERE r.slug = p.slug)
 ON CONFLICT (slug, version) DO NOTHING;

-- Point the app at it, and point the placement at it too — the placement's
-- release_id is what the reconciler compares against desired to decide whether
-- a rollout is in progress. Left null, every app would look mid-rollout forever.
UPDATE apps a
   SET desired_release = r.id
  FROM releases r
 WHERE r.slug = a.slug
   AND r.version = 1
   AND a.runtime = 'fleet'
   AND a.desired_release IS NULL;

UPDATE fleet_placements p
   SET release_id = a.desired_release
  FROM apps a
 WHERE a.slug = p.slug
   AND p.release_id IS NULL
   AND a.desired_release IS NOT NULL;

-- A lease for what is already running, so the first reconcile pass does not read
-- twenty-six live apps as twenty-six expired placements.
--
-- Generous on purpose: the nodes renew on their next sync, seconds away, and the
-- only cost of a long first lease is that eviction cannot fire for an hour on a
-- fleet that could not evict anyway — there are two nodes, and a majority of two
-- is two. The cost of a short one is a reconciler that acts on a picture the
-- nodes have not had a chance to confirm.
UPDATE fleet_placements
   SET lease_until = now() + interval '1 hour'
 WHERE lease_until IS NULL;
