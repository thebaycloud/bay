/**
 * Whose fault a failed deploy is, decided in code rather than by a model.
 *
 * Only IAM_FAILURE and AMBIGUOUS_STACK short-circuited. Everything else — a
 * gcloud crash, a missing `dist`, a runtime the platform does not have, a
 * POSTGRES_DB collision — was handed to a repair agent with edit access to the
 * customer's repository, and asked to fix it. There is nothing in the customer's
 * code to fix in any of those cases, so the agent invents work: it once invented
 * an app, wrote a fake .env, deleted a migrate script, and spent 428k tokens
 * arriving at `gcloud exited 1`.
 *
 * AGENT_MD already tells the agent not to fix platform limits. It was simply
 * never given the information to tell the difference. Classifying here means it
 * is not asked to.
 *
 * The rule for adding a pattern: it belongs here when NO edit to the user's
 * repository could fix it. Not "unlikely to be their fault" — impossible.
 */

export type Blame = "platform" | "app";

export interface Classified {
  blame: Blame;
  /** Why, in the user's terms. Empty for app errors, which speak for themselves. */
  reason?: string;
}

/**
 * Failures that belong to the platform, with the line each one should print.
 *
 * Ordered: the first match wins, so more specific patterns come first.
 */
const PLATFORM: Array<{ re: RegExp; reason: string }> = [
  {
    // Word-anchored throughout. An unanchored alternation reads a substring of
    // an ordinary word as a match, and every one of those is an app error
    // wrongly withheld from the agent that could have fixed it.
    re: /\b(permission denied|permissions?|forbidden|iam|unauthorized|not authorized|does not have)\b|\b403\b/i,
    reason: "The deploy could not get the permissions it needs. That is ours to fix, not yours — nothing in your code causes it.",
  },
  {
    re: /\b(quota|rate limit|resource exhausted)\b|\b429\b/i,
    reason: "The project hit a Google Cloud quota. Your code is fine; this needs a quota raise or a retry later.",
  },
  {
    re: /runtime not available|requires a different python|requires-python/i,
    reason: "This app needs a language version the platform does not run yet. No edit to your repository can change that.",
  },
  {
    re: /already exists.*database|POSTGRES_DB|duplicate database/i,
    reason: "The database name this app would get is already taken on the shared instance. That is a platform naming collision.",
  },
  {
    // \b around the errno codes is load-bearing: "ModuleNotFoundError"
    // lowercases to "modulenotfounderror", which CONTAINS "enotfound". Without
    // the boundary, a missing import — the most ordinary app error there is, and
    // one the repair agent fixes well — was classified as infrastructure and
    // never shown to it.
    re: /could not connect|connection refused|socket hang up|\b(econnrefused|enotfound|etimedout|econnreset)\b/i,
    reason: "A service the deploy depends on did not answer. That is infrastructure, not your app.",
  },
  {
    re: /gcloud (exited|crashed)|internal error|backend error|please try again|\b500 internal\b/i,
    reason: "Google Cloud returned an internal error. Nothing in your repository caused it and nothing there can fix it.",
  },
];

/**
 * Marker constants the pipeline throws with. Matched exactly rather than by
 * pattern, because these are ours and a substring match on them is a promise.
 */
export const PLATFORM_MARKERS = ["IAM_FAILURE", "AMBIGUOUS_STACK", "Runtime not available"];

export function classify(error: string | undefined | null): Classified {
  const e = error ?? "";
  if (!e.trim()) return { blame: "platform", reason: "The deploy failed without saying why. That is a gap in our reporting, not in your code." };
  for (const marker of PLATFORM_MARKERS) {
    if (e.includes(marker)) return { blame: "platform", reason: e };
  }
  for (const { re, reason } of PLATFORM) {
    if (re.test(e)) return { blame: "platform", reason };
  }
  return { blame: "app" };
}

/** True when this failure must never reach the repair agent. */
export function isPlatformFailure(error: string | undefined | null): boolean {
  return classify(error).blame === "platform";
}

/**
 * Strip the parts of an error that change between two runs of the same failure.
 *
 * Build ids, timestamps, container ids and revision suffixes all differ on every
 * attempt, so two reports of one unchanged problem never compare equal as
 * strings — which is why a loop guard that counted attempts could not notice
 * that nothing was moving.
 */
export function errorFingerprint(error: string | undefined | null): string {
  return (error ?? "")
    .toLowerCase()
    // ISO timestamps and clock times
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, "")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "")
    // Cloud Run revision names, matched whole — `demo-00021-abc`. Before the
    // digits are stripped, because afterwards there is no revision left to
    // recognise and the random three-letter tail survives as a difference.
    // Deliberately not a generic "-<letters>" rule: that would also eat the
    // words in `cloud-sql-proxy`, and erasing real words makes two DIFFERENT
    // failures compare equal, which stops the agent while it is still working.
    .replace(/\b[a-z][a-z0-9-]*-\d{4,5}-[a-z]{3}\b/g, "")
    // uuids, build ids, hex blobs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "")
    .replace(/\b[0-9a-f]{16,}\b/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/**
 * Whether the agent is making progress or restating the same failure.
 *
 * MAX_REDEPLOYS counted attempts and nothing compared errors, so three identical
 * failures cost three full deploys — the guard could tell you the agent had run
 * out of tries, never that it had run out of ideas.
 */
export function isSameFailure(previous: string | undefined | null, next: string | undefined | null): boolean {
  const a = errorFingerprint(previous);
  const b = errorFingerprint(next);
  return a !== "" && a === b;
}
