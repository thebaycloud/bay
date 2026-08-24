import type { Metadata } from "next";
import { SITE } from "../brand";
import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from "./locales";
import { localePath } from "./index";

/**
 * The canonical URL and the hreflang set for one page.
 *
 * Both are needed and they do different jobs. Canonical says "this exact URL is
 * the one to index", which stops the same page being counted twice when it is
 * reachable with a query string or a trailing slash. hreflang says "these six
 * URLs are the same page in different languages", which stops a crawler treating
 * five translations as thin duplicates of the English one and quietly dropping
 * them.
 *
 * `x-default` points at English. It is what a crawler uses for a reader whose
 * language is none of ours, and leaving it out means that reader gets whichever
 * translation the crawler guesses.
 */
export function alternatesFor(path: string, locale: string): Metadata["alternates"] {
  const l: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return {
    canonical: `${SITE}${localePath(l, path)}`,
    languages: {
      ...Object.fromEntries(LOCALES.map((x) => [x, `${SITE}${localePath(x, path)}`])),
      "x-default": `${SITE}${localePath(DEFAULT_LOCALE, path)}`,
    },
  };
}
