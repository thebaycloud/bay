/**
 * What the app itself says, as opposed to what Cloud Run says about it.
 *
 * The dashboard's "Live" has always been `ready` — Cloud Run's opinion of the
 * REVISION. A revision is ready when its container answered a startup probe on
 * $PORT once. `epvmx` clears that and then serves Django's DisallowedHost to
 * every request; it drew the same green LIVE as a working app, because nothing
 * had ever asked the app a question.
 *
 * This is the asking. Pure, so what counts as working is one readable rule
 * rather than a condition spread across a component.
 */

export interface ProbeResult {
  /**
   * Set when the EDGE answered rather than the app: `building`, `stalled`,
   * `deploy-failed`, `sign-in`, `no-access`, `no-such-app`. Absent when the app's
   * own process answered — which is the only case in which a 200 means what it
   * looks like.
   *
   * A building app is served the platform's holding page with status 200, because
   * that page is a page and it rendered. Two stalled builds answered 200 for
   * twenty minutes while producing no revision and no image, and a deploy report
   * had to note that "anyone treating a 200 as success would have reported this
   * deploy as live". The number cannot carry the fact; this can.
   */
  platformPage?: string;
  /** HTTP status, or 0 when nothing answered. */
  code: number;
  ms: number;
  contentType?: string;
  body?: string;
}

export interface ProbeSummary {
  verdict: "ok" | "warn" | "down";
  label: string;
  preview: string;
}

/** How long a preview may be before it starts pushing the facts off the card. */
const PREVIEW_MAX = 120;

/**
 * How long one app's answer is reused before asking again.
 *
 * This exists because of what the grid already learned once. Each card used to
 * be an `<iframe src="https://<slug>.supersonic.cv">` — opening the dashboard
 * opened every app on it. One request is far cheaper than that, but it is not
 * free in the way that matters: a probe WAKES a scale-to-zero app, so an
 * uncached one turns every dashboard load — and every three-second poll while
 * something is building — into a cold start per app, and a bill for it.
 *
 * Short enough that the page is not lying about an app that just fell over,
 * long enough that opening the dashboard twice costs one wake-up.
 */
export const PROBE_TTL_MS = 45_000;

/** Whether a stored answer is still worth showing instead of asking again. */
export function probeCacheUsable(entry: { at: number } | undefined, now: number, ttlMs: number = PROBE_TTL_MS): boolean {
  return Boolean(entry) && now - entry!.at < ttlMs;
}

/**
 * The body, when showing it beats showing a picture of it.
 *
 * This is the observation the whole redesign turns on: a screenshot works for a
 * site and not for an API. A thumbnail of `{"ok":true}` is a picture of the word
 * ok on a white field, and a thumbnail of a bare JSON error is the monogram
 * fallback with extra steps. For those, the response IS the interesting thing.
 *
 * HTML gets nothing back, deliberately — it has a screenshot, which says more
 * than its markup ever will.
 */
export function bodyPreview(body: string | undefined, contentType: string | undefined): string {
  if (!body) return "";
  if (/html/i.test(contentType ?? "")) return "";
  // One line: this lands in a fixed-height row, and a newline breaks it.
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/**
 * One answer, judged.
 *
 * The same rule the fleet's own verdict uses, and for the same reason: only a
 * 5xx and silence are failures. A 404 at the root is an API that has no root and
 * a 302 is an app redirecting to its login — calling either "down" is the
 * original mistake pointed the other way, and it would teach people to ignore
 * the light.
 */
export function probeSummary(r: ProbeResult): ProbeSummary {
  const preview = bodyPreview(r.body, r.contentType);
  if (!r.code) return { verdict: "down", label: "no answer", preview };

  // OUR page is never a verdict about their app.
  //
  // A building app is served the platform's holding page with status 200, so this
  // function used to answer `ok` — about an app whose build had not started. Two
  // stalled builds answered 200 for twenty minutes with no revision and no image,
  // and the only reason anybody noticed was that a person went and read the
  // status separately.
  //
  // `warn` and not `down`: the app is not broken, it is not there yet, and those
  // are different things. The label says which page it was, because "200" and
  // "still building" are the same number and opposite news.
  if (r.platformPage) {
    const said: Record<string, string> = {
      building: "still building — this is our holding page, not your app",
      waiting: "waiting to start — this is our holding page, not your app",
      stalled: "the deploy stalled — this is our page",
      "deploy-failed": "the last deploy failed — this is our page",
      "sign-in": "asking the visitor to sign in — this is our page",
      "prove-address": "asking the visitor to prove their address — this is our page",
      "no-access": "refusing the visitor — this is our page",
      "no-such-app": "no app at that address",
      "unknown-host": "no app at that address",
      "no-web-process": "this app serves no web process",
    };
    return {
      verdict: "warn",
      label: said[r.platformPage] ?? `our page (${r.platformPage})`,
      preview,
    };
  }

  const verdict = r.code >= 500 ? "down" : r.code >= 400 ? "warn" : "ok";
  return { verdict, label: `${r.code} · ${Math.round(r.ms)} ms`, preview };
}
