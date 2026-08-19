/**
 * What to tell someone whose deploy just failed about the version still serving.
 *
 * There is no rollback to perform. The fleet keeps ONE SPEC PER APP rather than a
 * history, so by the time this runs the previous version is either already back —
 * `placeOnFleet` restores it on a failed verify — or was never disturbed. This
 * reports which of those happened, in the user's terms.
 *
 * Phrased as a fact and never as "we rolled back", because nothing here does:
 * claiming an action the platform did not take is how a user comes to believe a
 * mechanism exists that they can rely on next time.
 */
import type { AppSpec } from "./fleet-spec";

export interface RollbackSubject {
  slug: string;
  /** A static app publishes to a bucket; a failed publish leaves the pointer alone. */
  staticServe: boolean;
  /** An app with no web process has no address whose version anybody can see. */
  serviceless: boolean;
  /**
   * Whether the target performs its own automatic rollback.
   *
   * Asked through the deploy target's capability rather than by naming a
   * runtime, so this and the domain-mapping guard three hundred lines away fork
   * on "which target" the same way. See lib/deploy-target.ts.
   */
  canAutoRollback: boolean;
}

export interface RollbackDeps {
  log: (line: string) => void;
  /** The app's current placement, or null. May reject; see `advise`. */
  placementFor: (slug: string) => Promise<{ node: string; spec: AppSpec } | null>;
}

/**
 * The sentence to attach to the failure, or null when there is nothing to say.
 *
 * NEVER REJECTS. This runs on the failure path of every deploy, with things
 * already degraded, and a Postgres hiccup here must not escape: caught, it is a
 * fact this function can report; uncaught, it replaces the deploy's REAL error
 * with a raw database message at the outer catch — and takes the error event,
 * the fix prompt, the upgrade path and the failure record with it, none of which
 * that catch can produce for a thrown, unclassified error.
 */
export async function advise(subject: RollbackSubject, deps: RollbackDeps): Promise<string | null> {
  if (subject.staticServe || subject.serviceless) return null;
  if (subject.canAutoRollback) return null;   // the target undoes its own; nothing to add

  let placed: { node: string; spec: AppSpec } | null;
  try {
    placed = await deps.placementFor(subject.slug);
  } catch (e) {
    deps.log(`! could not check the fleet placement (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }

  if (placed) {
    // The version now placed is either the one restored moments ago, on THIS
    // attempt's failed verify, or the one never touched because this attempt
    // got nowhere near placing anything. Either way the fact is the same and it
    // is the fact worth telling — not the mechanism.
    deps.log(`${subject.slug} is on the version that was working before this deploy — the fleet has no revision history to roll back further than that.`);
    return "The previous version is still (or already back) serving — the fleet keeps one spec per app, not a history, so this is as far back as an automatic rollback can go.";
  }

  // No placement at all: either this was the first deploy, so nothing ever
  // served, or the single placement attempt failed verify and — having no
  // previous spec of its own to restore — correctly unplaced rather than leaving
  // a broken address on the books. Both are one user-facing fact.
  deps.log(`No previous version of ${subject.slug} exists on the fleet to roll back to — this looks like its first deploy. Fix the error above and redeploy.`);
  return "Nothing to roll back to on the fleet: this app has no previous placement. Fix the error and redeploy.";
}
