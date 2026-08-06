# A deleted app's fleet placement outlives it, and slugs are re-issued

**Found:** 2026-08-06, during the grilling that opened the Cloud Run → fleet move.
**Status:** confirmed against the code, chain complete. Not yet fixed.

## The chain

Each link verified, with the citation that closes it.

1. **`fleet_placements` is keyed on `(slug, node)`**, not on slug
   (`apps/web/db/013_fleet.sql`). One slug therefore holds rows on several nodes at
   once, and `placeApp` (`lib/fleet.ts:79`) upserts `ON CONFLICT(slug, node)` — it
   overwrites its own pair and leaves rows on other nodes untouched.

2. **Deleting an app never clears its placement.** `unplaceApp` (`lib/fleet.ts:88`)
   deletes by slug across all nodes, but its only callers are the failed-deploy
   rollback (`lib/fleet-place.ts:642`) and the runtime flip back to Cloud Run
   (`lib/fleet.ts:186`). The delete route contains no reference to the fleet at
   all. So `(X, node-A)` survives the app it belonged to.

3. **Slugs are re-issued as soon as they are freed.** `lib/gcloud.ts:666` states it
   outright: `randomSlug` is one letter and four alphanumerics, and `resolveSlug`
   builds its taken-set **from live services**, so a freed slug is immediately
   re-issuable. The same file already applied this reasoning to databases — "the
   slug space is five characters, so a name WILL eventually be reused, and the new
   app would have inherited a stranger's tables" — and to images and their
   `mode=max` caches. Nobody applied it to placements, because the fleet arrived
   after that comment was written.

4. **The join then succeeds.** `desiredFor` (`lib/fleet.ts:58`) is
   `fleet_placements JOIN apps ON a.slug = p.slug WHERE p.node = $1 AND a.runtime
   = 'fleet'`. Once a new app takes the freed slug and is placed on the fleet, the
   orphaned row on node A finds a partner again — and node A is handed **the
   previous tenant's spec**, including its image.

## What holds it back today

`desiredFor` requires `a.runtime = 'fleet'`, so while the slug is unclaimed the
orphan produces no desired state and the node runs nothing. The exposure needs all
three: an app deleted while placed, its slug re-issued, and the new app also on the
fleet. Slug reuse has not been observed yet — the space is 36^4 × 26 and the
platform has fewer than a hundred apps — but the code's own comment is that it
**will** happen, and the fix is cheaper than the argument about when.

## The fix

Call `unplaceApp(slug)` from the delete path. It already deletes across every node,
which is exactly the semantics needed. One line, plus a test that a deleted app
leaves no placement behind.

Worth doing in the same small change as the redeploy corroboration tail
(`.superpowers/research/fleet-deploy-time.md` §4b): both are in the fleet path,
both are small, and neither depends on the larger Cloud-Run-to-fleet work.

## What this is not

Not a live incident. No slug is known to have been reused. This is a latent path
that the platform's own documented reasoning says will eventually open, recorded
before it does rather than after.
