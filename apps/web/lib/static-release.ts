import { randomBytes } from "node:crypto";

/**
 * Publishing a static release.
 *
 * A release lands at `<slug>/r/<id>/` and only then does `<slug>/current` start
 * naming it. That order is the whole safety property: if the upload dies partway,
 * the pointer still names the previous release and the live site never notices.
 * Writing the pointer first would put a half-uploaded site in front of users.
 */

export const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "supersonic-static-assets";

/**
 * Sortable and unique: a UTC timestamp so `ls` reads chronologically, plus random
 * bytes so two deploys in the same second cannot collide.
 */
export function releaseId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function releasePrefix(slug: string, release: string): string {
  return `${slug}/r/${release}/`;
}

export function pointerPath(slug: string): string {
  return `${slug}/current`;
}

/*
 * WAS: `publishRelease(store, slug, dir)` and the `ReleaseStore` seam under it.
 *
 * Designed, tested, and never called by anything. Deleting rather than adopting
 * it, because it is not merely unused — it is LESS CORRECT than the path that
 * shipped instead. It uploads and then names the release:
 *
 *     await store.uploadDir(localDir, prefix);
 *     await store.writePointer(pointerPath(slug), release);
 *
 * with nothing in between. The pipeline reads the release back before naming it,
 * and the comment there says why: "A green Cloud Build is not evidence that
 * anything was uploaded — the step that copies the assets can exit 0 having
 * copied nothing, which is exactly how a pointer came to name a release that
 * does not exist." Adopting this would have reintroduced a bug somebody had
 * already found and fixed.
 *
 * The seam is worth a second note. `ReleaseStore` had exactly one hypothetical
 * adapter — the tests' fake — and none in production. A seam with one adapter is
 * a guess about what will vary; this one guessed that the STORE would, when what
 * actually varied was whether the upload could be trusted.
 *
 * What survives is what was always used: the naming above, which is pure, is
 * tested, and is what both the pipeline and the proxy agree a release is called.
 */
