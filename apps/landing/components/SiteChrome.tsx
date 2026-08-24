import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { localePath, type Locale, type Messages } from "@/lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
import { SiteNav } from "./SiteNav";

/**
 * Nav plus a short footer, for every page that is not the landing page.
 *
 * The navbar is literally the landing page's, from components/SiteNav. The
 * footer is deliberately not: a reading page or a price list does not need the
 * whole sitemap under it, and the landing page's four-column footer on a
 * three-card pricing page reads as more chrome than content.
 */
export function SiteChrome({
  t,
  locale,
  children,
}: {
  t: Messages;
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <div className="bay min-h-screen bg-ground font-sans text-[16px] leading-[1.55] tracking-[-0.008em] text-ink antialiased">
      <SiteNav t={t} locale={locale} />
      {children}
      <footer className="border-t border-line py-10">
        <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center gap-x-6 gap-y-2 px-[22px] text-[13px] text-ink-3 min-[900px]:px-10">
          <Link href={localePath(locale, "/")} className="hover:text-ink">
            {BRAND}
          </Link>
          <Link href={localePath(locale, "/templates")} className="hover:text-ink">
            {t.nav.templates}
          </Link>
          <Link href={localePath(locale, "/pricing")} className="hover:text-ink">
            {t.nav.pricing}
          </Link>
          {/* English only, and outside the locale tree, so no prefix. */}
          <Link href="/changelog" className="hover:text-ink">
            {t.nav.changelog}
          </Link>
          <a href="/changelog.xml" className="hover:text-ink">
            {t.footer.rss}
          </a>
          <div className="flex-1" />
          <LanguagePicker label={t.footer.languageAria} />
        </div>
      </footer>
    </div>
  );
}
