/**
 * Where a deployed app came from, when that is a place we could go back to.
 *
 * ## The gap this closes
 *
 * `apps` has never recorded the repository. lib/adopt.ts opens by explaining what
 * that cost: "the platform does not keep the repository a deployed app came from
 * … there is nothing to redeploy FROM", which is why twenty live apps had to be
 * moved onto the fleet by ADOPTING their running image rather than rebuilding
 * them. The deploy run that carried the URL is deleted when the run finishes, so
 * the value existed for minutes and was then gone.
 *
 * ## Why a decision and not just a column
 *
 * Two of the three ways an app arrives produce a `repoUrl` that cannot be cloned
 * again. On the upload path it is a reference to a tarball in GCS — an object the
 * deploy itself consumes — and a column filled with those is worse than an empty
 * one: it reads as "we know where this came from" and every redeploy built on it
 * fails at the clone.
 *
 * So the question is not "what was passed" but "what could we deploy from a
 * second time", and `null` is a real answer meaning LEAVE WHAT IS THERE. A
 * redeploy from an upload must not erase the repository an earlier git deploy
 * recorded.
 */

/**
 * Whether a string is something `git clone` could be pointed at.
 *
 * Shape-checked rather than trusted, because `isUpload` arrives as a request
 * header — a claim about the request, not a fact about the value. A bucket
 * reference is not a repository however the request was labelled.
 *
 * `git@host:path` is included and http(s) is included; `gs://`, a local path and
 * anything else are not. An ssh remote is kept deliberately even though the
 * platform holds no key for it: it is the honest record of where the app came
 * from, and a redeploy that cannot reach it should say so rather than behave as
 * though the origin were unknown.
 */
function clonable(url: string): boolean {
  if (/^https?:\/\/\S+$/i.test(url)) return true;
  return /^[\w.-]+@[\w.-]+:\S+$/.test(url);
}

export function redeployableRepo(a: { url: string; isUpload: boolean }): string | null {
  if (a.isUpload) return null;
  const url = a.url.trim();
  if (!url || !clonable(url)) return null;
  return url;
}
