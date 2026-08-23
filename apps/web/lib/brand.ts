import { rootDomain } from "./roots";

/**
 * What the platform is CALLED. The domain it answers on lives in lib/roots.ts.
 *
 * Two modules because they are two facts that move apart. A product can be
 * renamed before its domain is bought, and a domain can be added — as
 * `thebay.cloud` was, beside `supersonic.cv` — without the name on the page
 * changing at all. Merging them would make every reader of one a reader of the
 * other, and `roots.ts` is deliberately the narrower thing: a list where the
 * order is meaning.
 *
 * This file was written first, on 23 Aug, and held the domain too. `roots.ts`
 * landed on main the next day doing that half better — a list rather than a
 * single value, with the canonical root first — so the domain half was deleted
 * from here rather than kept beside it. Two answers to "what domain are we" is
 * the exact defect `roots.ts` exists to prevent, and this module having its own
 * copy would have reintroduced it on the day it merged.
 *
 * No server-only imports: read from client components.
 */

const DEFAULT_PRODUCT_NAME = "Supersonic";

let cachedName: string | null = null;

/**
 * What a person calls us.
 *
 * `NEXT_PUBLIC_` first, for the reason `roots.ts` gives at length: Next inlines
 * only those into a browser bundle, so a server-only variable read here is the
 * empty string on the client and falls silently through to the default — which
 * would put the old name on a page while the server used the new one.
 */
export function productName(): string {
  if (cachedName) return cachedName;
  const raw = (process.env.NEXT_PUBLIC_PRODUCT_NAME ?? process.env.PRODUCT_NAME ?? "").trim();
  cachedName = raw || DEFAULT_PRODUCT_NAME;
  return cachedName;
}

/** Where one app answers, under the canonical root. */
export function appHost(slug: string): string {
  return `${slug}.${rootDomain()}`;
}

/** Where the dashboard and the API answer, under the canonical root. */
export function controlPlaneHost(): string {
  return `app.${rootDomain()}`;
}

/**
 * Test seam. `productName` is cached because it is read on hot paths and cannot
 * change within a process — except in a test that sets the environment and
 * expects to be believed.
 */
export const _brandForTesting = {
  reset(): void {
    cachedName = null;
  },
};
