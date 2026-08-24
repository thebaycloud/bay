import { DEFAULT_LOCALE, type Locale } from "./locales";
import type { Messages } from "./types";
import en from "./messages/en";
import zhHans from "./messages/zh-Hans";
import zhHant from "./messages/zh-Hant";
import es from "./messages/es";
import ja from "./messages/ja";
import ru from "./messages/ru";

export type { Messages };
export type { Locale };
export { DEFAULT_LOCALE };

/**
 * A static map, not a dynamic import.
 *
 * Every page here is statically rendered, and awaiting a chunk to read a string
 * would turn each one into something that has to resolve a promise before it can
 * print a heading. Six catalogues of plain strings are small enough that having
 * them all in the bundle costs less than the machinery to avoid it.
 */
const CATALOGUES: Record<Locale, Messages> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  es,
  ja,
  ru,
};

export function getMessages(locale: Locale): Messages {
  return CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
}

/**
 * Fills {name} placeholders.
 *
 * The catalogues hold {brand}, {domain} and {cli} rather than the words, so the
 * rebrand stays one edit in lib/brand.ts instead of a search across six
 * languages. Values are substituted, never parsed: nothing here builds markup.
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole
  );
}

/**
 * An internal path under a locale.
 *
 * Every in-site link has to go through this or a reader who switched language
 * lands back in English on their first click. English is unprefixed, so this is
 * the identity there, which is why forgetting it is invisible until someone
 * actually reads the site in another language.
 *
 * Absolute URLs, mailto:, in-page anchors and the machine routes (anything with
 * a dot in the last segment, like /llms.txt) are returned untouched: none of
 * them has a locale.
 */
export function localePath(locale: Locale, path: string): string {
  if (locale === DEFAULT_LOCALE) return path;
  if (/^([a-z]+:|\/\/|#)/i.test(path)) return path;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".")) return path;
  const clean = path === "/" ? "" : path.replace(/\/$/, "");
  return `/${locale}${clean}`;
}
