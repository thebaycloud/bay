/**
 * Which release is live for a slug.
 *
 * The pointer is a tiny object at `<slug>/current` holding a release id. Reading
 * it on every request would put a GCS round trip in front of every file, so it is
 * cached briefly — long enough to matter, short enough that a deploy or a rollback
 * takes effect while the person who triggered it is still looking at the page.
 */

export const POINTER_TTL_MS = 10_000;

export interface PointerStore {
  read(slug: string): Promise<string | null>;
}

interface Entry { release: string | null; at: number }

export class PointerCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly store: PointerStore,
    private readonly ttlMs: number = POINTER_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(slug: string): Promise<string | null> {
    const hit = this.entries.get(slug);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.release;
    // A miss is cached too. Without that, traffic to a slug that does not exist
    // — a typo, a scanner walking subdomains — hits GCS on every single request.
    const release = await this.store.read(slug);
    this.entries.set(slug, { release, at: this.now() });
    return release;
  }

  /** Drop an entry so the next request re-reads. Used by tests and by rollback. */
  forget(slug: string): void {
    this.entries.delete(slug);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A release id must be safe to splice into an object path. */
export function isReleaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
