import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { plans } from "@/lib/plans";
import { getMessages, localePath } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import "../changelog/changelog.css";

const WRAP = "mx-auto w-full max-w-[1200px] px-[22px] min-[900px]:px-10";

const BTN =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[8px] " +
  "border px-[18px] font-sans text-[15px] font-[450] tracking-[-0.01em] transition-colors";

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);
  return {
    // A middle dot, not a dash: em dashes are out everywhere on this project.
    title: `${t.pricing.metaTitle} · ${BRAND}`,
    description: t.pricing.metaDescription,
  };
}

export default function Pricing({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t = getMessages(locale);

  return (
    <SiteChrome t={t} locale={locale}>
      <header className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href={localePath(locale, "/")} label={BRAND} />
        <h1 className="m-0 mt-8 max-w-[26ch] font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          {t.pricing.h1}
        </h1>
        <p className="mt-4 max-w-[54ch] text-[17px] leading-[1.6] text-ink-2">{t.pricing.p}</p>
      </header>

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <div className="mt-[clamp(36px,4.5vw,60px)] grid gap-5 min-[900px]:grid-cols-3">
          {plans(t).map((p) => (
            <div
              key={p.id}
              className="flex flex-col rounded-[12px] border border-line bg-white px-[26px] py-7"
            >
              <div className="text-[15px] font-medium">{p.name}</div>
              {/* A worded price is not a numeral and must not be set like one:
                  "Let's talk" at 36px/300 outweighs $20 and reads as the
                  expensive plan. */}
              <div
                className={
                  p.unit
                    ? "mb-1.5 mt-[18px] text-[36px] font-light leading-none tracking-[-0.03em]"
                    : "mb-1.5 mt-[18px] text-[24px] font-normal leading-none tracking-[-0.02em]"
                }
              >
                {p.price}{" "}
                {p.unit ? (
                  <span className="text-[14px] font-normal tracking-[-0.01em] text-ink-3">
                    {t.pricing.per} {p.unit}
                  </span>
                ) : null}
              </div>
              <p className="mb-[22px] text-[14.5px] text-ink-2">{p.desc}</p>
              <ul className="m-0 mb-[26px] flex list-none flex-col gap-[9px] p-0">
                {p.rows.map((r) => (
                  <li key={r} className="flex items-baseline gap-[10px] text-[14.5px] text-ink-2">
                    <Check
                      size={14}
                      strokeWidth={2.2}
                      className="shrink-0 translate-y-0.5 text-ink-3"
                    />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
              <a
                className={`${BTN} mt-auto ${
                  p.fill
                    ? "border-brand-ink bg-brand text-[#ffffff] hover:bg-[#cf3522]"
                    : "border-line bg-white text-ink hover:bg-tile"
                }`}
                href={p.href}
              >
                {p.cta}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-10 max-w-[62ch] text-[14.5px] leading-[1.6] text-ink-3">
          {t.pricing.footnote}
        </p>
      </section>
    </SiteChrome>
  );
}
