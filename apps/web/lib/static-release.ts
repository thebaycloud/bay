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

/** What the publisher needs from storage. Kept tiny so it is trivial to fake. */
export interface ReleaseStore {
  /** Copy every file under `localDir` to `gs://<bucket>/<prefix>`. */
  uploadDir(localDir: string, prefix: string): Promise<void>;
  /** Write the pointer object naming the live release. */
  writePointer(path: string, release: string): Promise<void>;
}

export interface PublishResult {
  release: string;
  prefix: string;
}

/**
 * Upload a built directory and make it live.
 *
 * Throws if the upload fails, having touched nothing the public can see.
 */
export async function publishRelease(
  store: ReleaseStore,
  slug: string,
  localDir: string,
  now: Date = new Date(),
): Promise<PublishResult> {
  const release = releaseId(now);
  const prefix = releasePrefix(slug, release);

  await store.uploadDir(localDir, prefix);
  // Only now is the release complete enough to be named.
  await store.writePointer(pointerPath(slug), release);

  return { release, prefix };
}
