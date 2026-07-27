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

/** Attributes that point at something the release must contain. */
const REF = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

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
 * check — a CDN being down is not a broken release.
 */
export function localReferences(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(REF)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (isExternal(raw)) continue;
    const key = referenceKey(raw);
    if (key) found.add(key);
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
