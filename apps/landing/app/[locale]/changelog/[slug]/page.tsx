import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { allEntries, entryBySlug, formatDate } from "@/lib/changelog";
import { SiteChrome } from "@/components/SiteChrome";
import { getMessages } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { BackLink } from "@/components/BackLink";
import "../changelog.css";

const WRAP = "mx-auto w-full max-w-[1040px] px-[22px] min-[900px]:px-10";
const ROW = "grid gap-2 min-[860px]:grid-cols-[160px_minmax(0,1fr)] min-[860px]:gap-8";

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => allEntries().map((e) => ({ locale, slug: e.slug })));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const e = entryBySlug(params.slug);
  if (!e) return {};
  return { title: `${e.title} — ${BRAND}`, description: e.summary };
}

export default function ChangelogEntry({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);
  const e = entryBySlug(params.slug);
  if (!e) notFound();

  return (
    <SiteChrome t={t} locale={locale}>
      {/* Same gutter and same measure as the index, so a post reads as the same
          object opened rather than a different page. */}
      <article className={`${WRAP} pb-16 pt-[clamp(40px,5vw,72px)]`}>
        <div className={ROW}>
          <div className="text-[14px] text-ink-3 min-[860px]:pt-2">{formatDate(e.date)}</div>

          <div className="min-w-0 max-w-[66ch]">
            <BackLink href="/changelog" label="Changelog" />
            <h1 className="m-0 mt-3 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
              {e.title}
            </h1>
            <div className="prose mt-7" dangerouslySetInnerHTML={{ __html: e.html }} />

            <div className="mt-14 border-t border-line pt-6">
              <Link
                href="/changelog"
                className="group inline-flex items-center gap-2 text-[15px] text-ink-2 transition-colors hover:text-ink"
              >
                <ArrowLeft
                  size={15}
                  strokeWidth={2}
                  className="transition-transform group-hover:-translate-x-[3px]"
                />
                All changes
              </Link>
            </div>
          </div>
        </div>
      </article>
    </SiteChrome>
  );
}
