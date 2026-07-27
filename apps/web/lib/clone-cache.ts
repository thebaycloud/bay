import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Hands a clone made by /api/detect over to /api/deploy so the repo is fetched
 * once instead of twice.
 *
 * This is only ever an optimisation. The control plane can serve the two requests
 * from different instances, an entry can expire, the disk can be swept — every one
 * of those is a miss, and a miss must cost a second clone, never a failed deploy.
 * `take()` returning null is the normal path, not an error path.
 */

const ROOT = join(tmpdir(), "ss-clone-cache");
export const CLONE_TTL_MS = 15 * 60 * 1000;

const TOKEN = /^[a-f0-9]{32}$/;

interface Entry { dir: string; at: number }
const entries = new Map<string, Entry>();

export function cacheRoot(): string {
  return ROOT;
}

/** Register a clone and return the token that reclaims it. */
export function put(dir: string, now: number = Date.now()): string {
  const token = randomBytes(16).toString("hex");
  entries.set(token, { dir, at: now });
  return token;
}

/**
 * Reclaim a clone. Returns null when the token is unknown, malformed, expired, or
 * names a directory that is no longer there.
 *
 * The token is validated as a hex string before it is used for anything. It
 * arrives in a request body, and a token is never a path — treating it as one is
 * how a lookup key turns into a directory traversal.
 */
export function take(token: unknown, now: number = Date.now()): string | null {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const hit = entries.get(token);
  if (!hit) return null;
  entries.delete(token);
  if (now - hit.at > CLONE_TTL_MS) {
    discard(hit.dir);
    return null;
  }
  if (!existsSync(hit.dir)) return null;
  return hit.dir;
}

/** Remove a cached clone from disk, ignoring anything that goes wrong. */
export function discard(dir: string): void {
  // Only ever delete inside our own root. A bug that let this take an arbitrary
  // path would be a recursive delete running as the control plane.
  const full = resolve(dir);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return;
  try { rmSync(full, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Create a fresh directory under the cache root for a clone to land in. */
export function reserve(): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = join(ROOT, randomBytes(12).toString("hex"));
  mkdirSync(dir);
  return dir;
}

/**
 * Delete clones older than the ttl, including ones whose token was never
 * redeemed — abandoned deploys are the common case, and without this they
 * accumulate on the instance until it runs out of disk.
 */
export function sweep(now: number = Date.now()): number {
  let removed = 0;
  for (const [token, entry] of entries) {
    if (now - entry.at > CLONE_TTL_MS) { entries.delete(token); discard(entry.dir); removed++; }
  }
  if (!existsSync(ROOT)) return removed;
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    try {
      if (now - statSync(full).mtimeMs > CLONE_TTL_MS) { discard(full); removed++; }
    } catch { /* vanished under us — fine */ }
  }
  return removed;
}

/** Test seam: forget every entry without touching the disk. */
export function _reset(): void {
  entries.clear();
}
