/**
 * The client's address, taken from the one position in `x-forwarded-for` that
 * the client cannot choose.
 *
 * The header is a list, and anybody may send one. Cloud Run appends the address
 * it actually accepted the connection from, so the honest value sits at a fixed
 * offset from the END; everything to the left of it is whatever the caller felt
 * like typing. Reading the FIRST element — which is what nearly every example
 * on the internet does — hands the key to the attacker: a fresh fake address
 * per request is a fresh bucket per request, and a ceiling that is never
 * reached. The limiter would report green while stopping nobody, which is the
 * failure mode worth designing against here.
 *
 * lib/public-origin.ts records the same lesson for a sibling header —
 * `x-forwarded-host` "is set by our proxy and by anybody else who feels like
 * it". Same header family, same trap, and that one had a redirect on the other
 * side of it.
 *
 * Nothing else in the control plane reads a client address. This is the first.
 */

/**
 * How far from the END of the list the trustworthy address sits.
 *
 * NOT YET MEASURED. Zero — the last element — is the shape Cloud Run's
 * behaviour is expected to produce for a service reached through a domain
 * mapping, and it is a default rather than a fact.
 *
 * The measurement is task 3 of docs/superpowers/plans/2026-08-25-rate-limiting.md:
 * a throwaway Cloud Run service that echoes the header, curled once honestly
 * and once with a forged value, checked against `httpRequest.remoteIp` in the
 * request log — the field Google computes rather than one the request carries.
 *
 * Until that is done, RATE_LIMIT_MODE must stay `off`. A wrong offset costs
 * nothing while nothing is counted; the moment counting starts it silently
 * poisons the very numbers the real ceilings get chosen from, and the moment
 * enforcement starts it is the difference between a limiter and a decoration.
 *
 * It must also be re-measured if the control plane ever moves behind a load
 * balancer, because that adds a hop and shifts the offset.
 */
export const TRUSTED_FROM_END = 0;

export function clientIp(req: Request): string | null {
  const raw = req.headers.get("x-forwarded-for");
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Trimmed and emptied first, so "1.1.1.1, , 2.2.2.2" and a stray trailing
  // comma cannot shift the offset — a header that changed the counted position
  // would be a header that chose its own bucket.
  const ip = parts[parts.length - 1 - TRUSTED_FROM_END];
  return ip || null;
}
