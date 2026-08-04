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
  const verdict = r.code >= 500 ? "down" : r.code >= 400 ? "warn" : "ok";
  return { verdict, label: `${r.code} · ${Math.round(r.ms)} ms`, preview };
}
