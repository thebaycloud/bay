/**
 * Which app a request is for, decided from its Host header alone.
 *
 * There are two kinds of address now and they are resolved in opposite
 * directions. An address we issued CARRIES the slug: `lilna.supersonic.cv` is
 * the app `lilna`, derivable with a string operation and true even when the
 * database is unreachable. A domain its owner attached carries nothing at all —
 * `acme.com` is a name we did not choose, and the only thing that connects it to
 * an app is a row.
 *
 * Keeping that distinction in one pure function, rather than as two branches
 * inside the request handler, is what makes it testable and what keeps the next
 * reader from assuming a hostname is a slug with a suffix.
 */

export type Door =
  /** An address we issued: the slug is in the name. */
  | { kind: "issued"; slug: string }
  /** A name we did not issue. Whether it belongs to an app is a question for the registry. */
  | { kind: "attached"; hostname: string }
  /** Nothing usable in the Host header at all. */
  | { kind: "nowhere" };

/**
 * The name in the Host header, with everything that is not the name removed.
 *
 * One trailing dot is stripped: `acme.com.` is the fully-qualified spelling of
 * the same host, and both browsers and proxies emit it. Against a table keyed by
 * hostname that spelling would simply miss, and the app would 404 at an address
 * that works everywhere else — a failure that looks like DNS and is not.
 */
export function hostnameOf(host: string | undefined): string {
  const name = (host ?? "").split(":")[0].trim().toLowerCase();
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * Which app, or whose domain, this request is for.
 *
 * Takes one root or several. Several is what a rename needs: while the platform
 * moves from one domain to another, both have to issue the same apps, or the
 * cutover is a day on which every bookmark stops working at once.
 *
 * A single string is still accepted because every caller passes one, and a
 * signature that quietly required an array would break them at runtime instead
 * of at the type checker.
 */
export function doorFor(host: string | undefined, roots: string | string[]): Door {
  const hostname = hostnameOf(host);
  if (!hostname) return { kind: "nowhere" };
  // Longest first. With roots that nest — `cloud` and `thebay.cloud` — matching
  // the short one turns `lilna.thebay.cloud` into the slug `lilna.thebay`,
  // which is not a slug, which is a 404 at an address that works.
  const list = (typeof roots === "string" ? [roots] : roots)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const root of list) {
    if (!hostname.endsWith("." + root)) continue;
    const slug = hostname.slice(0, -(root.length + 1));
    // A label that is not a slug is not an app, and must not fall through to the
    // attached-domain lookup: `evil.lilna.supersonic.cv` would otherwise become a
    // hostname somebody could attach, inside the namespace we issue. This runs
    // per root rather than once, because a guard applied to only the first root
    // is exactly the kind that gets left behind when a second one is added.
    return /^[a-z0-9-]+$/.test(slug) ? { kind: "issued", slug } : { kind: "nowhere" };
  }
  return { kind: "attached", hostname };
}

/**
 * Whether this request has to be sent back to the app's own supersonic.cv
 * address before anything else happens.
 *
 * Only ever true on an attached domain, and only for an app that is not public.
 *
 * Everything that decides who a visitor is reads the session cookie, and that
 * cookie is scoped to `.supersonic.cv`. A browser will not send it to acme.com —
 * correctly; that is what cookie scoping is for. So on an attached domain every
 * visitor is anonymous, the owner included: a private app would answer with the
 * sign-in gate, signing in would set a cookie on the wrong domain, and the
 * visitor would come back exactly as anonymous as they left. A loop with no exit.
 *
 * Sending them to the address where the cookie does exist ends that honestly:
 * the app opens if they are allowed in, and the gate they are shown is one that
 * can actually let them through.
 */
export function mustReturnToPlatform(door: Door, visibility: string): boolean {
  return door.kind === "attached" && visibility !== "public";
}

/** The app's own address, carrying the path and query the visitor asked for. */
export function platformUrl(slug: string, rootDomain: string, path: string | undefined): string {
  const rest = path && path.startsWith("/") ? path : "/";
  return `https://${slug}.${rootDomain}${rest}`;
}
