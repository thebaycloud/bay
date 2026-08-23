import { DOMAIN } from "./brand";

/**
 * The domains this site used to answer on, and where they go now.
 *
 * `supersonic.cv` was the platform's name until 24 Aug 2026. It is not being
 * switched off — three apps, nineteen people and every link anybody ever
 * pasted still point at it — so it answers, permanently, by saying where the
 * thing moved to.
 *
 * DELIBERATELY NOT the app addresses. `<slug>.supersonic.cv` keeps serving the
 * app itself and must never redirect: the whole promise of the overlap is that
 * a link somebody shared goes on working exactly as it did. Only the marketing
 * site moves, and only because there is nothing at the old address a person
 * would rather have than the new one.
 *
 * A permanent redirect rather than a temporary one, on purpose. This is not a
 * maintenance window: browsers and search engines should learn the new address
 * and stop asking. The cost of being wrong is that a cached 301 outlives a
 * change of mind, which is exactly why the decision to move was made first.
 */
const LEGACY_HOSTS = ["supersonic.cv", "www.supersonic.cv"];

/**
 * Where this request should be sent, or null to serve it here.
 *
 * Takes the host and the path rather than a request, so it can be reasoned
 * about — and tested — without one.
 */
export function legacyRedirect(host: string | null, pathAndQuery: string): string | null {
  const hostname = (host ?? "").split(":")[0].trim().toLowerCase();
  if (!hostname) return null;
  // A trailing dot is the fully-qualified spelling of the same name, and both
  // browsers and proxies emit it. Against a list of literals it would simply
  // miss, and the old domain would go on serving a page that says Bay.
  const clean = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!LEGACY_HOSTS.includes(clean)) return null;
  // Guard against sending a domain to itself. If the canonical root is ever set
  // back to the legacy one — a rollback — this must stop redirecting rather
  // than loop forever.
  if (clean === DOMAIN || clean === `www.${DOMAIN}`) return null;
  return `https://${DOMAIN}${pathAndQuery}`;
}
