/**
 * The locales the site is published in.
 *
 * One list, imported by the picker, the routing and the message catalogues, so a
 * language cannot be half-added: a code that is in here but has no catalogue is
 * a compile error rather than a page of missing strings.
 *
 * `label` is in the language itself. A reader scanning for their own language
 * looks for the word they call it, not for "Chinese".
 *
 * Simplified and Traditional are separate entries rather than one "Chinese",
 * because they differ in vocabulary and not only in characters: software is 软件
 * in the mainland and 軟體 in Taiwan, and one catalogue cannot serve both.
 *
 * FONT: Geist covers Latin and Cyrillic, so en, es and ru render in the site's
 * own typeface. It has no CJK, measured rather than assumed, so zh-Hans, zh-Hant
 * and ja need a Noto face loaded alongside it or they fall back to whatever the
 * reader's system supplies and the page reads as a different site.
 */
export const LOCALES = ["en", "zh-Hans", "zh-Hant", "es", "ja", "ru"] as const;

export type Locale = (typeof LOCALES)[number];

/** English keeps the unprefixed URLs, which are the ones already indexed. */
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  es: "Español",
  ja: "日本語",
  ru: "Русский",
};

/** True for the three scripts Geist cannot set. */
export const NEEDS_CJK_FONT: Record<Locale, boolean> = {
  en: false,
  "zh-Hans": true,
  "zh-Hant": true,
  es: false,
  ja: true,
  ru: false,
};

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

/** The locales that live under a path prefix, which is everything but English. */
export const PREFIXED_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE);
