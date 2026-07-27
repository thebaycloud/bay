/**
 * Path handling for the static server.
 *
 * Everything here runs on attacker-controlled input: the `Host` header and the
 * request path both come from the wire. A mistake in this file is one tenant
 * reading another tenant's release, so the rule is deny-by-default and every
 * function returns null rather than something almost-right.
 */

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Slug from a Host header. `foo.supersonic.cv` -> `foo`.
 *
 * The port is stripped because `Host` carries one on non-standard ports. Anything
 * that is not a single label under the root — the apex, a deeper name, an
 * unrelated domain — has no slug.
 */
export function slugFromHost(host: string | undefined, root: string): string | null {
  if (!host) return null;
  const name = host.trim().toLowerCase().split(":")[0];
  if (!name || !name.endsWith("." + root)) return null;
  const label = name.slice(0, -(root.length + 1));
  if (!label || label.includes(".")) return null;
  return SLUG.test(label) ? label : null;
}

/**
 * Normalise a request path to a release-relative object key.
 *
 * Returns null for anything that tries to climb out. Note the decode happens
 * first: `%2e%2e%2f` is `../` and has to be rejected as such, not passed through
 * because it did not literally contain a dot.
 */
export function objectKey(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;
  if (!decoded.startsWith("/")) return null;

  const out: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null; // never resolve upward, even if it would stay in bounds
    if (segment.includes("\\")) return null;
    out.push(segment);
  }
  return out.join("/");
}

/** True when the last path segment looks like a file rather than a route. */
export function looksLikeFile(key: string): boolean {
  const last = key.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 && dot < last.length - 1;
}
