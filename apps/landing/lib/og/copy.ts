import { getMessages, type Messages } from "../i18n";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n/locales";

/**
 * The catalogue and the locale a card is drawn from.
 *
 * Every locale is set in its own language now. It was English on the three CJK
 * ones for as long as Geist was the only face loaded, because satori draws a
 * glyph it cannot find as a blank rectangle and a card of empty boxes is worse
 * than a card in the wrong language. lib/og/fonts holds Noto subsets for those
 * three, so the compromise is gone.
 */
export function cardCopy(locale: string): { t: Messages; locale: Locale } {
  const l: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return { t: getMessages(l), locale: l };
}
