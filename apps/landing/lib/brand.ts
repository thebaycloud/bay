/**
 * What this site calls the product, and where it sends people.
 *
 * The same seam as `apps/web/lib/brand.ts` and for the same reason: the rename
 * has to be a configuration change rather than an edit spread across a page, a
 * layout, a manual and a terminal prop. The two modules are deliberately not
 * shared: the landing is a separate build with no dependency on the control
 * plane, and giving it one so two constants could live together would be a
 * worse trade than repeating four lines.
 *
 * Defaults are the NEW name. The landing is the one place where that is right:
 * this site is the announcement, and a site that says Supersonic by default is
 * a site that has to be remembered on cutover day.
 */

const DEFAULT_BRAND = "Bay";
const DEFAULT_DOMAIN = "thebay.cloud";
const DEFAULT_CLI = "bay";

function env(name: string, fallback: string): string {
  const v = (process.env[name] ?? "").trim();
  return v || fallback;
}

/** What a person calls us. */
export const BRAND = env("NEXT_PUBLIC_PRODUCT_NAME", DEFAULT_BRAND);

/** The domain addresses are issued under. */
export const DOMAIN = env("NEXT_PUBLIC_ROOT_DOMAIN", DEFAULT_DOMAIN);

/** The command a person types, and the npm package that installs it. */
export const CLI = env("NEXT_PUBLIC_CLI_NAME", DEFAULT_CLI);

/**
 * Where "Open app" goes.
 *
 * Kept separate from DOMAIN and pointed at the OLD host until cutover, because
 * this is the one link on the page that must resolve to a live control plane.
 * It pointed at app.supersonic.cv from 23 Aug until the cutover, because
 * app.thebay.cloud existed with no certificate yet and a button that leads
 * nowhere is worse than one that leads to the old name.
 *
 * Flipped 24 Aug. The old host still answers, it 307s here, so the only cost
 * of having left this behind was a redirect the person could see in the address
 * bar, on the one button the page exists to get them to press.
 *
 * Derived from DOMAIN rather than written out, so it cannot be left behind a
 * second time.
 */
export const APP_URL = env("NEXT_PUBLIC_APP_URL", `https://app.${DOMAIN}`);

/** Where somebody writes to us. */
export const CONTACT_EMAIL = env("NEXT_PUBLIC_CONTACT_EMAIL", `founders@${DOMAIN}`);

/** This site's own origin, for absolute URLs in feeds and agent instructions. */
export const SITE = env("NEXT_PUBLIC_SITE_URL", `https://${DOMAIN}`);

/**
 * The name in titles and structured data, which is not the name on the page.
 *
 * BRAND is "Bay", and that is right in the lockup and in a sentence: the product
 * is Bay. But "Bay" alone is unsearchable. It competes with eBay, the Bay Area,
 * Hudson's Bay and every bay window, and no amount of markup wins that query. So
 * metadata says "Bay Cloud", which is a phrase somebody can actually find, while
 * the interface goes on saying Bay.
 *
 * Titles only. Do not spend this in body copy or in the navbar: two names on one
 * page reads as two products.
 */
export const SITE_NAME = env("NEXT_PUBLIC_SITE_NAME", `${DEFAULT_BRAND} Cloud`);

/**
 * The npm package that provides the CLI. Usually the same word as the command,
 * but not necessarily: a name can be taken on npm and free as a binary.
 */
/**
 * The npm package that installs the CLI.
 *
 * NOT the command. `bay` is what a person types; `@thebaycloud/cli` is what npm
 * installs, and they differ because npm refused `bay-cli` as too close to
 * `cpy-cli` and `bay` itself belongs to somebody else: a real package at 0.6.2.
 *
 * Defaulting this to CLI put `npm i -g bay` and `npx bay@latest deploy` on the
 * live site and inside the prompt people paste into a coding agent: an
 * instruction to install and execute a stranger's package. Never derive this
 * from the command name.
 */
export const PKG = env("NEXT_PUBLIC_CLI_PACKAGE", "@thebaycloud/cli");

/**
 * The repo the star count and the community link read from.
 *
 * Ours, and public since 25 Aug. It was a placeholder pointing at somebody
 * else's repository for as long as this one was private, which meant the star
 * pill and the community link both led somewhere that was not us.
 */
export const GITHUB_REPO = env("NEXT_PUBLIC_GITHUB_REPO", "thebaycloud/bay");

/** The repository page itself, for a link rather than an API call. */
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
