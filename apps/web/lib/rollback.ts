import { getPool } from "./db";
import type { Pool } from "pg";

const DB = "supersonic_platform";

/**
 * Rollback, as the architecture decided it: ONE WRITE.
 *
 * `apps.desired_release = previous`, and the reconciler does the rest through
 * exactly the function a deploy uses. It places the older release beside what is
 * running, waits for the node to report it ready, then drains the newer one —
 * `planPlacements` already does all of that, and it does not care whether the
 * release it is converging on is newer or older than what is placed.
 *
 * This replaces a 501 whose message was accurate when it was written: "a
 * placement keeps only the current version". It does not any more. `releases`
 * holds every version with the spec that shipped, and `fleet_placements` copies
 * that spec byte-for-byte when it places — so the older version is not rebuilt,
 * it is re-placed from the row that recorded it.
 *
 * ## What this is NOT
 *
 * A rollback of code, not of schema. A release that ran a migration is not
 * undone by pointing at an older image, and the interface has to say so rather
 * than let it be discovered: the older code will start against the newer
 * database. The spec states this and it is repeated at the call site.
 */

export interface ReleaseRef {
  id: number;
  version: number;
}

/**
 * The release before the desired one, or null when there is not one.
 *
 * RELATIVE TO DESIRED, not to the newest. An app that has already rolled back is
 * asked for an older release while newer ones still exist in the table, and
 * rolling back again has to keep moving backwards — "the highest version that is
 * not current" would jump straight to the newest, which is a roll FORWARD
 * wearing the name of a rollback.
 *
 * Ordered by `version`, never by `id`: version is per app and assigned inside
 * the insert, while id comes from a sequence shared with every other app, so
 * interleaved deploys leave one app's ids out of order.
 */
export function previousReleaseId(releases: ReleaseRef[], desired: number | null): number | null {
  if (desired === null) return null;
  const current = releases.find((r) => r.id === desired);
  // A desired release that is not in the list cannot be located in the history,
  // and without a position there is no "previous". Refused rather than answered
  // with something plausible.
  if (!current) return null;
  let best: ReleaseRef | null = null;
  for (const r of releases) {
    if (r.version >= current.version) continue;
    if (!best || r.version > best.version) best = r;
  }
  return best?.id ?? null;
}

/** Every release recorded for an app, newest first. */
export async function releasesFor(slug: string, pool: Pool = getPool(DB)): Promise<ReleaseRef[]> {
  const r = await pool.query(
    `SELECT id, version FROM releases WHERE slug = $1 ORDER BY version DESC`,
    [slug],
  );
  return r.rows.map((row) => ({ id: Number(row.id), version: Number(row.version) }));
}
