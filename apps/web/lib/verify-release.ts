/**
 * Checking a release before it goes live.
 *
 * A locally built artifact arrives with no guarantee that it is coherent: an empty
 * output directory, a truncated upload, or a build that wrote an index referencing files
 * it never emitted all look identical from here until someone opens the site.
 *
 * This reads the uploaded objects only. Verifying through the static server would mean
 * giving that server a way to address a release other than the live one, which is
 * exactly the hole that lets someone read a private or withdrawn release. Checking
 * storage catches everything that actually breaks and adds no new surface.
 */

/**
 * One element, as `<name attributes…>`. Tag-aware on purpose: the attribute
 * alone does not say whether a URL is a *file the release must contain* or a
 * *place the visitor can go*, and treating the second as the first is how this
 * check refused ordinary sites. See NAVIGATION_TAGS below.
 *
 * `[^>]*` for the attribute run rather than a quote-aware alternation: it is
 * linear (no backtracking blowup on a large minified index.html), and the case
 * it gets wrong — a `>` inside an attribute value — cannot invent a reference,
 * only truncate one, which fails open.
 */
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

/** Attributes that point at something the release must contain. */
const REF = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/** `rel` on a `<link>`, so a navigational one can be told from a real asset. */
const REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/**
 * Tags whose `href` is somewhere to go, not something to load.
 *
 * This is the whole reason the check is tag-aware. `<a href="/about">` is a
 * route: a multi-page site (Astro, Hugo, Eleventy, Jekyll, Next `output:
 * export`) serves it from `about/index.html` or `about.html`, and a single-page
 * app serves it from index.html via the router — in neither case is there an
 * object literally named `about`. Requiring one refused every such build with
 * "index.html references files the build did not produce", on sites that were
 * publishing correctly the day before.
 */
const NAVIGATION_TAGS = new Set(["a", "area", "base", "form"]);

/**
 * `<link rel=…>` values that name a page or an origin rather than a file in the
 * release. `rel="canonical"` in particular is emitted by every static site
 * generator with SEO defaults on, and points at a route.
 *
 * A `<link>` with no `rel`, or with any other `rel` (stylesheet, icon,
 * manifest, preload, …), is still treated as a required file — that is the case
 * this verifier exists for.
 */
const NAVIGATION_LINK_RELS = new Set([
  "canonical", "alternate", "prev", "previous", "next", "author", "license",
  "help", "search", "me", "dns-prefetch", "preconnect", "pingback",
  "webmention", "profile", "index", "up", "bookmark", "tag",
]);

function attrValue(m: RegExpMatchArray | null): string {
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/** Whether this element's src/href names a file the release has to contain. */
function loadsAFile(tag: string, attrs: string): boolean {
  const name = tag.toLowerCase();
  if (NAVIGATION_TAGS.has(name)) return false;
  if (name !== "link") return true;
  const rels = attrValue(attrs.match(REL)).toLowerCase().split(/\s+/).filter(Boolean);
  return !rels.some((r) => NAVIGATION_LINK_RELS.has(r));
}

function isExternal(url: string): boolean {
  return (
    url === "" ||
    url.startsWith("//") ||          // protocol-relative — someone else's host
    /^[a-z][a-z0-9+.-]*:/i.test(url) // http:, https:, data:, mailto:, blob:
  );
}

/** Normalise a reference to the key it would have inside the release. */
export function referenceKey(url: string): string {
  const withoutQuery = url.split("?")[0].split("#")[0];
  return withoutQuery.replace(/^\.?\//, "");
}

/**
 * Local files an HTML document depends on.
 *
 * Absolute and protocol-relative URLs, data URIs and mailto links are not ours to
 * check — a CDN being down is not a broken release. Neither are navigation
 * targets: see NAVIGATION_TAGS.
 */
export function localReferences(html: string): string[] {
  const found = new Set<string>();
  for (const tag of html.matchAll(TAG)) {
    const attrs = tag[2] ?? "";
    if (!loadsAFile(tag[1], attrs)) continue;
    for (const m of attrs.matchAll(REF)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (isExternal(raw)) continue;
      const key = referenceKey(raw);
      if (key) found.add(key);
    }
  }
  return [...found].sort();
}

/**
 * Which of an index's local references are absent from the uploaded release.
 *
 * `present` is the list of keys relative to the release prefix.
 */
export function missingFiles(html: string, present: string[]): string[] {
  const have = new Set(present.map(referenceKey));
  return localReferences(html).filter((ref) => !have.has(ref));
}

export interface ReleaseVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * The whole decision, given what was uploaded.
 *
 * Kept separate from any I/O so the rule is testable and obvious: no index, no release;
 * an index that points at files we do not have, no release.
 */
export function verifyRelease(present: string[], indexHtml: string | null): ReleaseVerdict {
  if (present.length === 0) return { ok: false, reason: "the build produced no files" };
  if (indexHtml === null) return { ok: false, reason: "no index.html in the build output" };

  const missing = missingFiles(indexHtml, present);
  if (missing.length) {
    const shown = missing.slice(0, 5).join(", ");
    const rest = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    return { ok: false, reason: `index.html references files the build did not produce: ${shown}${rest}` };
  }
  return { ok: true };
}
