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
 * MEASURED, 25 Aug 2026, against a throwaway Cloud Run service in this project
 * that echoed the header back — not read out of any documentation. Three
 * requests, from one client at 88.225.225.125:
 *
 *   no header sent            → `88.225.225.125`
 *   `X-Forwarded-For: A`      → `A,88.225.225.125`
 *   `X-Forwarded-For: A, B`   → `A, B,88.225.225.125`
 *
 * Google appends the address it accepted the connection from, at the END, and
 * appends it however many entries the caller invented. Cross-checked against
 * `httpRequest.remoteIp` in the Cloud Run request log — the field the platform
 * computes rather than one the request carries — which read 88.225.225.125 for
 * all three. So the honest value is the last element: zero from the end.
 *
 * Read the second line of that table again before changing anything here. Under
 * a first-element rule, the attacker's `A` is the key, every request can pick a
 * different one, and no bucket ever fills.
 *
 * It must be re-measured if the control plane ever moves behind a load
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
