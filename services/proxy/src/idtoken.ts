const cache = new Map<string, { token: string; exp: number }>();

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
