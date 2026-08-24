/**
 * An answer worth keeping for a moment.
 *
 * `describeService` already had a private version of this — a Map, a timestamp
 * and a 20-second TTL — for exactly the right reason: "the cockpit re-asks on
 * every navigation, and clicking into an app and back paid the full round trip
 * each time." The Dev screen re-asks nine questions per visit, and four of them
 * leave the process: Cloud Scheduler, Cloud Storage, umami, and Cloud Run.
 *
 * SHORT ON PURPOSE, and per-read rather than one global TTL. The number is not a
 * performance dial; it is a claim about how stale each answer may be before it
 * becomes a lie. A deploy changes a revision, so 20 seconds is already generous
 * there. A bucket listing that is a minute old is fine — nobody uploads a file
 * and then checks this screen to find out whether it worked. Visitor counts are
 * whole minutes behind at the source, so caching them for one adds nothing to
 * the error.
 *
 * IN-PROCESS, which means per Cloud Run instance. That is a feature here: the
 * cache cannot be stale for somebody it was never warmed for, and there is
 * nothing to invalidate across a fleet. It also means the numbers are already
 * bounded — one entry per app per read, and an app is a row in our own database.
 *
 * NOT for writes, and not for anything a person just changed. Every caller here
 * is a read whose worst case is a number a few seconds old.
 */

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

const cells = new Map<string, Entry<unknown>>();

/**
 * Run `get`, or hand back what it returned recently.
 *
 * The PROMISE is cached, not the value, which is what makes this collapse
 * concurrent callers: nine reads firing at once for one app share one round trip
 * instead of nine. That is the case this exists for — the Dev screen opens every
 * one of them in the same tick.
 *
 * A rejection is evicted rather than remembered. Caching a failure means one
 * unlucky moment becomes a screen that stays broken for the whole TTL, and the
 * retry button would be answering from the cache.
 */
export function memo<T>(key: string, ttlMs: number, get: () => Promise<T>): Promise<T> {
  const hit = cells.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const value = get();
  cells.set(key, { at: Date.now(), value });
  value.catch(() => {
    // Only if it is still ours: a later call may already have replaced it, and
    // dropping that one would throw away a good answer.
    if (cells.get(key)?.value === value) cells.delete(key);
  });
  return value;
}

/** Forget one key, for a write that has just made it wrong. */
export function forget(key: string): void {
  cells.delete(key);
}

/** Forget every key with this prefix — one app's reads, after a deploy. */
export function forgetPrefix(prefix: string): void {
  for (const k of cells.keys()) if (k.startsWith(prefix)) cells.delete(k);
}

/** Test seam. */
export const _memoForTesting = {
  clear(): void {
    cells.clear();
  },
  size(): number {
    return cells.size;
  },
};
