import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { BRAND, CLI } from "@/lib/brand";
import { TEMPLATES } from "@/lib/templates";
import { fill, getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { alternatesFor } from "@/lib/i18n/alternates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";

const WRAP = "mx-auto w-full max-w-[1200px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);
  return {
    title: t.templatesPage.metaTitle,
    alternates: alternatesFor("/templates", params.locale),
    description: t.templatesPage.metaDescription,
  };
}

export default function TemplatesIndex({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);

  return (
    <SiteChrome t={t} locale={locale}>
      <section className={`${WRAP} pb-10 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          {t.templatesPage.h1}
        </h1>
        <p className="mt-4 max-w-[56ch] text-pretty text-[17px] leading-[1.6] text-ink-2">
          {t.templatesPage.p}
        </p>
      </section>

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <div className="grid gap-4 min-[760px]:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <Link
              key={tpl.slug}
              href={localePath(locale, `/templates/${tpl.slug}`)}
              className="group/card flex flex-col overflow-hidden rounded-[12px] bg-tile p-6 pb-0"
            >
              <span className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/logos/brand/${tpl.logo}.png`}
                  alt=""
                  className="h-[18px] w-auto shrink-0 object-contain"
                />
                <span className="text-[17px] font-medium tracking-[-0.02em]">{tpl.name}</span>
              </span>

              {/* Heading and blurb butt together as one block, two colours, the
                  same treatment as the feature panels above. */}
              <span className="mt-1.5 text-[17px] leading-[1.45] tracking-[-0.015em] text-ink-2">
                {fill(t.templates[tpl.slug].blurb, { brand: BRAND, cli: CLI })}
              </span>

              <span className="mt-4 inline-flex items-center gap-2 text-[15px] text-brand-ink">
                {t.templatesSection.cardCta}
                <ArrowRight
                  size={15}
                  strokeWidth={2}
                  className="transition-transform group-hover/card:translate-x-[3px]"
                />
              </span>

              {/* Bottom, and flush with the card's edge so it reads as running
                  on past it rather than as a picture in a box. object-top
                  because these are interfaces and the top is the real content. */}
              <span className="mt-6 block h-[210px] overflow-hidden rounded-t-[8px] bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={tpl.shot}
                  alt={fill(t.templatesSection.shotAlt, { name: tpl.name })}
                  width={720}
                  height={450}
                  className="size-full object-cover object-top transition-transform duration-500 group-hover/card:scale-[1.03]"
                />
              </span>
            </Link>
          ))}
        </div>

        <p className="mt-10 max-w-[62ch] text-[14.5px] leading-[1.6] text-ink-3">
          {fill(t.templatesPage.footnote, { brand: BRAND })}
        </p>
      </section>
    </SiteChrome>
  );
}
