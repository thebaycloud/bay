/**
 * What this site calls the product, and where it sends people.
 *
 * The same seam as `apps/web/lib/brand.ts` and for the same reason: the rename
 * has to be a configuration change rather than an edit spread across a page, a
 * layout, a manual and a terminal prop. The two modules are deliberately not
 * shared — the landing is a separate build with no dependency on the control
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
 * `app.thebay.cloud` exists but its certificate is still being issued; a button
 * that leads nowhere is worse than one that leads to the old name.
 *
 * Flipping this is the last edit of the migration.
 */
export const APP_URL = env("NEXT_PUBLIC_APP_URL", "https://app.supersonic.cv");

/** Where somebody writes to us. */
export const CONTACT_EMAIL = env("NEXT_PUBLIC_CONTACT_EMAIL", `founders@${DOMAIN}`);

/** This site's own origin, for absolute URLs in feeds and agent instructions. */
export const SITE = env("NEXT_PUBLIC_SITE_URL", `https://${DOMAIN}`);

/**
 * The npm package that provides the CLI. Usually the same word as the command,
 * but not necessarily: a name can be taken on npm and free as a binary.
 */
export const PKG = env("NEXT_PUBLIC_CLI_PACKAGE", CLI);

/**
 * The repo the star count and the community link read from.
 *
 * PLACEHOLDER: ours is private, so this points at a public repo to have a real
 * number to render. It is not our repository, so both the pill and the community
 * link lead somewhere that is not us until this is swapped.
 */
export const GITHUB_REPO = env("NEXT_PUBLIC_GITHUB_REPO", "thepersonalaicompany/amurex");
