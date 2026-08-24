import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { allEntries, formatDate } from "@/lib/changelog";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { getMessages } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { BackLink } from "@/components/BackLink";
import "./changelog.css";

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return {
    title: "Changelog",
    alternates: {
      ...alternatesFor("/changelog", params.locale),
      types: { "application/rss+xml": "/changelog.xml" },
    },
  };
}

const WRAP = "mx-auto w-full max-w-[1040px] px-[22px] min-[900px]:px-10";

/** Date in a gutter, content in a column. One grid, used by both routes. */
const ROW = "grid gap-2 min-[860px]:grid-cols-[160px_minmax(0,1fr)] min-[860px]:gap-8";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

/**
 * The entries stay English: they are dated, they grow without end, and every
 * future post would owe five translations before it could ship. Only the chrome
 * around them is translated.
 */
export default function ChangelogIndex({ params }: { params: { locale: string } }) {
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);
  const entries = allEntries();

  return (
    <SiteChrome t={t} locale={locale}>
      <header className={`${WRAP} pb-12 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href="/" label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Changelog
        </h1>
      </header>

      <div className={WRAP}>
        {entries.map((e) => (
          <article key={e.slug} className={`${ROW} border-t border-line py-[clamp(28px,3.4vw,48px)]`}>
            <div className="text-[14px] text-ink-3 min-[860px]:pt-1">{formatDate(e.date)}</div>

            <div className="min-w-0 max-w-[66ch]">
              <h2 className="m-0 font-sans text-[26px] font-normal leading-[1.2] tracking-[-0.022em]">
                <Link href={`/changelog/${e.slug}`} className="hover:text-ink-2">
                  {e.title}
                </Link>
              </h2>

              {/* A one-paragraph note reads fine here. Anything longer shows its
                  summary and keeps its body on its own page, so the index stays
                  something you can scan rather than one endless scroll. */}
              {e.long ? (
                <>
                  <p className="mt-3 text-[17px] leading-[1.65] text-ink-2">{e.summary}</p>
                  <Link
                    href={`/changelog/${e.slug}`}
                    className="group mt-4 inline-flex items-center gap-2 text-[15px] text-brand-ink transition-colors hover:text-brand"
                  >
                    Read more
                    <ArrowRight
                      size={15}
                      strokeWidth={2}
                      className="transition-transform group-hover:translate-x-[3px]"
                    />
                  </Link>
                </>
              ) : (
                <div className="prose mt-3" dangerouslySetInnerHTML={{ __html: e.html }} />
              )}
            </div>
          </article>
        ))}

        {entries.length === 0 ? (
          <p className="border-t border-line py-12 text-[15px] text-ink-3">Nothing shipped yet.</p>
        ) : null}
      </div>
    </SiteChrome>
  );
}
