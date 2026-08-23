/**
 * What the platform is called, and the domain it issues addresses under.
 *
 * ## Why this is a module and not two string literals
 *
 * The name appeared 2259 times across 374 files (counted 23 Aug 2026), and a
 * rename that touches all of them at once, on a live platform, is not a rename —
 * it is an outage with a changelog. This module is the seam: after it, becoming
 * Bay is `ROOT_DOMAIN=thebay.cloud` and a deploy, and becoming Supersonic again
 * is unsetting it.
 *
 * ## One answer, whoever asks
 *
 * There were two variables for one fact. `lib/app-urls.ts` read
 * `NEXT_PUBLIC_ROOT_DOMAIN`, `lib/cors.ts` and `lib/umami.ts` read
 * `ROOT_DOMAIN`, and both defaulted to the same literal — so the disagreement
 * was invisible until somebody set one of them. Setting only the public one
 * would have built every link for the new domain while CORS went on refusing
 * requests from it; setting only the private one does the reverse.
 *
 * The public one wins here because it is the only one that CAN win in a browser:
 * Next inlines `NEXT_PUBLIC_*` at build time and strips the rest from the client
 * bundle. The private one remains for the processes Next never built — the
 * proxy, the deploy job, the fleet agent.
 *
 * ## No server-only imports
 *
 * Read from client components. Nothing here may import `pg`, `node:fs`, or
 * anything else that cannot be bundled.
 */

/** Today's values. Defaults, so nothing moves until something is set. */
const DEFAULT_ROOT_DOMAIN = "supersonic.cv";
const DEFAULT_PRODUCT_NAME = "Supersonic";

/**
 * A hostname out of whatever was typed into a dashboard field.
 *
 * These are set by hand, in a hurry, by somebody who has just been told the new
 * domain over a call. A leading `https://` silently builds `https://https://app.…`
 * and a trailing space builds a hostname no resolver will answer — both fail far
 * from here and neither looks like a configuration mistake when it does.
 */
function clean(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
  return v || null;
}

let cachedDomain: string | null = null;
let cachedName: string | null = null;

/** The domain the platform issues addresses under. */
export function rootDomain(): string {
  if (cachedDomain) return cachedDomain;
  cachedDomain =
    clean(process.env.NEXT_PUBLIC_ROOT_DOMAIN) ??
    clean(process.env.ROOT_DOMAIN) ??
    DEFAULT_ROOT_DOMAIN;
  return cachedDomain;
}

/**
 * What a person calls us.
 *
 * Separate from the domain because the two rename apart: a product can be
 * renamed before its domain is bought, and a domain can move without the name
 * changing at all.
 */
export function productName(): string {
  if (cachedName) return cachedName;
  const raw = (process.env.NEXT_PUBLIC_PRODUCT_NAME ?? process.env.PRODUCT_NAME ?? "").trim();
  cachedName = raw || DEFAULT_PRODUCT_NAME;
  return cachedName;
}

/** Where one app answers. The address every share link is built from. */
export function appHost(slug: string): string {
  return `${slug}.${rootDomain()}`;
}

/** Where the dashboard and the API answer. */
export function controlPlaneHost(): string {
  return `app.${rootDomain()}`;
}

/**
 * Test seam. The values are cached because they are read on hot paths and can
 * never change within a process — except in a test that sets the environment
 * and expects to be believed.
 */
export const _brandForTesting = {
  reset(): void {
    cachedDomain = null;
    cachedName = null;
  },
};
