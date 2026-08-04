const cache = new Map<string, { token: string; exp: number }>();

/**
 * How the forwarder obtains an ID token.
 *
 * A variable so a test can replace it, and it exists to DELETE `SKIP_ID_TOKEN`.
 *
 * That was a production branch that existed for a test's benefit: one env var,
 * read on the request path, that skipped minting the invoker credential
 * altogether. Set in a real environment — copied into a deploy from a local
 * shell, inherited by a container, typed once at the wrong service — it would
 * have silently stripped `x-serverless-authorization` from every Cloud Run
 * upstream, and every tenant's app would have started 403ing at once with
 * nothing in this codebase saying why. A test that needs to avoid the metadata
 * server should replace the thing that reaches it, not add a branch to the
 * thing being tested.
 *
 * Nothing in production assigns to this.
 */
export let mintIdToken: (audience: string) => Promise<string> = idTokenFor;

/**
 * Replace the minter for a test. Returns the function that puts it back.
 *
 * Returning the restore rather than exporting a reset means a test cannot
 * forget which state it was in, and two tests cannot disagree about it.
 */
export function setIdTokenMinter(fn: (audience: string) => Promise<string>): () => void {
  const previous = mintIdToken;
  mintIdToken = fn;
  return () => {
    mintIdToken = previous;
  };
}

/**
 * Cloud Run ID token for a given audience, from the metadata server.
 * Tokens last an hour; we refresh five minutes early.
 */
export async function idTokenFor(audience: string): Promise<string> {
  const hit = cache.get(audience);
  if (hit && Date.now() < hit.exp) return hit.token;

  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata identity failed: ${r.status}`);
  const token = (await r.text()).trim();
  cache.set(audience, { token, exp: Date.now() + 55 * 60_000 });
  return token;
}
