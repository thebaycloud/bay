/**
 * The domains the platform issues addresses under.
 *
 * There is more than one now. `thebay.cloud` is the name from here on and
 * `supersonic.cv` is what three live apps, 19 users and every installed copy of
 * the CLI already point at — so both have to answer at once for a while, and the
 * length of that while is a decision, not an accident.
 *
 * ORDER IS MEANING. The first root is CANONICAL: it is the one new addresses are
 * minted under, the one a person is told to CNAME at, the one the session cookie
 * belongs to, and the one the edge sends a visitor back to. Every other root is
 * accepted and nothing more. Getting this backwards would have people pointing
 * their own DNS at a name we are retiring.
 *
 * WHY A MODULE AND NOT A CONSTANT
 *
 * `lib/domains.ts` held the root as a literal while app-urls, cors, umami and
 * the proxy each read it from env with a different default. That is four places
 * to change and one that cannot be changed without a deploy — and the literal is
 * the one that decides whether somebody may attach `foo.thebay.cloud` as "a
 * domain you own". If it says supersonic.cv after the cutover, that attach is
 * accepted, a certificate is issued, and two rules then answer for one host: the
 * wildcard and the lookup, with whichever runs first winning.
 *
 * No `pg`, no server-only imports. These are read from client components, which
 * is why the NEXT_PUBLIC_ names are checked first — Next inlines only those into
 * a browser bundle, and a server-only variable read here would be the empty
 * string on the client and silently fall through to the default.
 */

/** What the platform answered to before the rebrand, and still must. */
const LEGACY_ROOT = "supersonic.cv";

/** The name from here on. First, because the first root is the canonical one. */
export const CANONICAL_ROOT = "thebay.cloud";

/**
 * What to answer to when nothing says otherwise.
 *
 * This was `LEGACY_ROOT` alone, and that default was doing real work: every
 * service that does not set `ROOT_DOMAINS` — local development, the static
 * server, a node's `-domain` flag — minted `supersonic.cv` addresses months after
 * the cutover. Production sets the variable explicitly, so flipping the default
 * changes nothing there and fixes everywhere else.
 *
 * Both, and in this order: new addresses under the new name, the old one still
 * answered. A default of `thebay.cloud` alone would stop the three live apps on
 * the old root from being recognised as ours.
 */
export const DEFAULT_ROOTS = `${CANONICAL_ROOT},${LEGACY_ROOT}`;

/**
 * Every root, canonical first.
 *
 * Set `NEXT_PUBLIC_ROOT_DOMAINS=thebay.cloud,supersonic.cv` and the cutover is
 * that line — which is also the default now, so a service that sets nothing gets
 * the new name rather than the old one. `ROOT_DOMAIN` singular is still honoured because it is what the
 * proxy, umami and CORS were configured with before this file existed, and a
 * rename that silently ignores the old variable is a rename that takes the
 * platform down at the moment it is deployed.
 */
export function rootDomains(): string[] {
  const raw =
    process.env.NEXT_PUBLIC_ROOT_DOMAINS ??
    process.env.ROOT_DOMAINS ??
    process.env.NEXT_PUBLIC_ROOT_DOMAIN ??
    process.env.ROOT_DOMAIN ??
    DEFAULT_ROOTS;
  const roots = raw
    .split(",")
    .map((r) => r.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  // Never empty. A misconfigured variable must not turn every hostname into an
  // attachable name — with no roots, `refuseHostname` refuses nothing and the
  // namespace we issue is open for anyone to claim.
  return roots.length ? Array.from(new Set(roots)) : [CANONICAL_ROOT, LEGACY_ROOT];
}

/** The root new addresses are minted under. */
export function rootDomain(): string {
  return rootDomains()[0];
}

/**
 * Whether this hostname is one WE issue — either a root itself or a name
 * directly under one.
 *
 * A label boundary, not a suffix: `notsupersonic.cv` ends with our name and is
 * somebody else's domain entirely.
 */
export function isPlatformHost(hostname: string, roots: string[] = rootDomains()): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  return roots.some((r) => h === r || h.endsWith("." + r));
}

/**
 * Whether a URL already points at one of our roots.
 *
 * For the callers that ask "is this address already ours" rather than "what
 * should this address be" — the screenshot service, the signup callback
 * allow-list. Those were written as `.includes(".supersonic.cv")`, which after
 * the cutover answers NO for an app on the canonical root, and each caller then
 * did something wrong with the answer.
 *
 * Parsed rather than matched on the string. `evil.com/?x=.thebay.cloud` contains
 * our root and is not ours, and a suffix test on the whole URL says it is.
 */
export function onAnyRoot(url: string, roots = rootDomains()): boolean {
  try {
    return isPlatformHost(new URL(url).hostname, roots);
  } catch {
    return false;
  }
}
