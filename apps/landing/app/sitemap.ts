import type { MetadataRoute } from "next";
import { SITE } from "@/lib/brand";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n";
import { allEntries } from "@/lib/changelog";
import { PAGES } from "@/lib/pages";

/**
 * Every indexable URL, in all six languages.
 *
 * The page list moved to lib/pages.ts, because middleware needs the same one to
 * tell a path that matches no page from one that does. What stays here is the
 * `index` filter: /templates renders but carries `robots: { index: false }` in
 * its own layout, and listing a noindex URL asks a crawler to fetch a page we
 * have told it to ignore.
 *
 * `alternates.languages` is the hreflang set. It matters more here than the
 * usual amount of hreflang hand-wringing, because English lives at the unprefixed
 * path and the other five sit under a prefix: without it a crawler sees six
 * near-identical pages and picks one of them for us.
 */
function everyLanguage(path: string) {
  return Object.fromEntries(
    LOCALES.map((l) => [l, `${SITE}${localePath(l, path)}`])
  );
}

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const pages = PAGES.filter((p) => p.index);

  const entries: MetadataRoute.Sitemap = pages.flatMap((p) =>
    LOCALES.map((l) => ({
      url: `${SITE}${localePath(l, p.path)}`,
      lastModified: now,
      changeFrequency: p.changeFrequency,
      priority: l === DEFAULT_LOCALE ? p.priority : p.priority * 0.9,
      alternates: { languages: everyLanguage(p.path) },
    }))
  );

  // The entries themselves are English only, so they get one URL each rather
  // than six. See lib/changelog.ts for why they are not translated.
  for (const e of allEntries()) {
    entries.push({
      url: `${SITE}/changelog/${e.slug}`,
      lastModified: new Date(`${e.date}T12:00:00Z`),
      changeFrequency: "yearly",
      priority: 0.5,
    });
  }

  return entries;
}
