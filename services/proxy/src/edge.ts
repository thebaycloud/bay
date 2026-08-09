/**
 * What a URL should serve, given what is actually known about the app behind it.
 *
 * The edge used to answer this in four lines, and each of them was a way of
 * saying something untrue:
 *
 *   - `status === "deploying"` served a 200 "Deploying…" page with no bound on
 *     how long that could go on for. A deploy whose process died leaves exactly
 *     that state, so a dead URL answered 200 forever — the worst possible
 *     result, because monitoring reads it as healthy and an agent reads it as
 *     shipped.
 *   - a failed deploy fell through to "deployed but not answering right now",
 *     which describes a working app having a bad moment, not one that never
 *     built. The real reason was sitting in the deploys row unread.
 *   - an open tunnel beat the published build unconditionally. The tunnel is the
 *     live preview of a deploy in flight; once the deploy has landed, the thing
 *     people should see is the build, not whatever the developer's laptop is
 *     still serving.
 *
 * Kept as a pure function, like decideAccess, because these are exactly the
 * cases nobody can produce on demand: a job killed mid-build, a redeploy that
 * failed over a live app, a tunnel still open after the build landed.
 */

export type EdgeAction =
  /** Forward to the published build. */
  | { serve: "build" }
  /** Answer with the app's reading — a page or the object, split on Accept. */
  | { serve: "xray" }
  /** 200, self-refreshing: a deploy is genuinely in progress. */
  | { page: "building" }
  /** 503: the deploy failed, and we know why. */
  | { page: "failed"; reason: string | null }
  /** 503: a deploy was running and then stopped saying anything. */
  | { page: "stalled" }
  /** 404: the app deployed fine and has no web process. Nothing is wrong. */
  | { page: "noweb" };

export interface EdgeInput {
  /**
   * This request is the owner asking for `/_xray`.
   *
   * The caller does the deciding about WHO — this is only told the answer, so
   * nothing about who may see a reading lives here. It is an input to this
   * function rather than a branch beside it because "what does this URL serve"
   * has to have exactly one answer: asked after the edge, the x-ray was
   * unreachable for every app the edge answers with a page of its own, which is
   * every app that has never come up. See the note at the top of decideEdge.
   */
  xrayForOwner?: boolean;
  /** The app has a published build to forward to. */
  buildLive: boolean;
  /** apps.status */
  status: "deploying" | "live" | "failed";
  /** The latest deploy record, or null for an app that predates the table. */
  deploy: { status: string; error: string | null; updatedAt: number | null } | null;
  /**
   * apps.has_web — false only for an app that declared its processes and did
   * not declare a `web` one. Optional, and absent means "not known": a row that
   * predates the column must keep every answer it had before.
   */
  hasWeb?: boolean;
  now: number;
  /** How long a deploy may go without progress before it is presumed dead. */
  staleAfterMs?: number;
}

/**
 * 15 minutes. Long enough for the slowest legitimate build observed (a cold
 * monorepo with a full dependency install runs into the several-minute range,
 * and the planner alone has taken three), short enough that a URL nobody is
 * building for stops claiming to be busy within one coffee.
 *
 * The clock is the deploy row's last update, not its start: a deploy that is
 * still emitting progress is alive however long it has been running.
 */
export const STALE_AFTER_MS = 15 * 60_000;

export function decideEdge(input: EdgeInput): EdgeAction {
  const { buildLive, status, deploy, hasWeb, now } = input;
  const staleAfterMs = input.staleAfterMs ?? STALE_AFTER_MS;

  // The owner's own reading outranks every page below, and has to: those pages
  // are exactly what the reading is FOR. An app mid-first-deploy, a failed one,
  // a stalled one — each is one of the states the reading exists to express, and
  // while this was decided after the edge, an agent polling `/_xray` through a
  // first deploy was handed the room page, as HTML, with a 200, and threw on
  // r.json(). Nothing about access is decided here; see EdgeInput.
  if (input.xrayForOwner) return { serve: "xray" };

  // A build that has landed is served, whatever the app's status says. During a
  // redeploy that means visitors keep getting the previous release for the whole
  // build — which is the behaviour a live app should have and, until the preview
  // tunnel was removed, the one case where it did not: an open tunnel outranked
  // the published build and pointed visitors at a developer's laptop instead.
  if (buildLive) return { serve: "build" };

  // Nothing to serve. The only honest answers left are "still coming",
  // "it failed", and "it stopped" — and which one it is has to be argued for.
  const failed = status === "failed" || deploy?.status === "failed";
  if (failed) return { page: "failed", reason: deploy?.error ?? null };

  // An app with no web process to point at. Nothing is wrong with it, and every
  // answer below this line would say there is: a Telegram bot spent two days
  // telling its customer's visitors "This deploy stopped" while the bot ran.
  //
  // Deliberately BELOW the failed check, not above it. `has_web` is written by
  // markAppLive, so it carries the shape of the last deploy that SUCCEEDED and
  // outlives a later failure. A worker-only app whose redeploy died must be
  // reported as failed; "it runs as a worker, nothing is wrong" would erase the
  // only signal its owner had.
  //
  // `=== false`, never `!hasWeb`. On a control plane running ahead of the
  // migration this arrives undefined, and treating that as "no web" would tell
  // every stalled and every building app in the platform that it is fine.
  if (hasWeb === false) return { page: "noweb" };

  // No deploy record at all: an app from before the table existed. Nothing to
  // measure staleness against, so this keeps the old behaviour rather than
  // declaring an app dead on the strength of a missing row.
  if (!deploy || deploy.updatedAt === null) return { page: "building" };

  if (deploy.status === "live") {
    // Marked live with nothing to forward to — the run_url never landed. Not a
    // build in progress, so saying "hang tight" would be a lie with no end.
    return { page: "stalled" };
  }

  return now - deploy.updatedAt > staleAfterMs ? { page: "stalled" } : { page: "building" };
}
