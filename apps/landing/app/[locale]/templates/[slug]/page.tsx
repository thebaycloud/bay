import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowUpRight, Check } from "lucide-react";
import { BRAND, CLI } from "@/lib/brand";
import { TEMPLATES, agentUrl, promptFor, templateBySlug } from "@/lib/templates";
import { fill, getMessages, localePath, type Messages } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, isLocale } from "@/lib/i18n/locales";
import { CopyPrompt } from "@/components/CopyPrompt";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";

const WRAP = "mx-auto w-full max-w-[900px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => TEMPLATES.map((t) => ({ locale, slug: t.slug })));
}

export function generateMetadata({
  params,
}: {
  params: { locale: string; slug: string };
}): Metadata {
  const tpl = templateBySlug(params.slug);
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  if (!tpl) return {};
  const t = getMessages(locale);
  return {
    title: fill(t.templatePage.metaTitle, { name: tpl.name }),
    description: fill(t.templates[tpl.slug].blurb, { brand: BRAND, cli: CLI }),
  };
}

/** A labelled block of facts. Used four times, so it is a component. */
function Facts({ head, items }: { head: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="text-[12px] uppercase tracking-[0.16em] text-ink-3">{head}</div>
      <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
        {items.map((i) => (
          <li key={i} className="flex items-baseline gap-2.5 text-[15px] text-ink-2">
            <Check size={14} strokeWidth={2.2} className="shrink-0 translate-y-0.5 text-ink-3" />
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function TemplatePage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const tpl = templateBySlug(params.slug);
  if (!tpl || !isLocale(params.locale)) notFound();
  const locale = isLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const t: Messages = getMessages(locale);
  const prose = t.templates[tpl.slug];
  const v = { brand: BRAND, cli: CLI };

  // The env var name comes from the record and is never translated; the sentence
  // explaining it comes from the catalogue, in the same order.
  const asks = tpl.asks.length
    ? tpl.asks.map(
        (a, i) =>
          `${a.key} (${a.required ? t.templatePage.required : t.templatePage.optional}). ` +
          fill(prose.asks[i] ?? "", v)
      )
    : [t.templatePage.noAsks];

  return (
    <SiteChrome t={t} locale={locale}>
      <header className={`${WRAP} pb-8 pt-[clamp(36px,4.5vw,64px)]`}>
        <BackLink href={localePath(locale, "/templates")} label={t.nav.templates} />

        <div className="mt-8 flex h-12 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/logos/brand/${tpl.logo}.png`}
            alt={tpl.name}
            style={{ height: tpl.logoHeight + 6 }}
            className="w-auto object-contain"
          />
        </div>

        <h1 className="m-0 mt-6 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          {fill(t.templatePage.h1, { name: tpl.name })}
        </h1>
        <p className="mt-4 max-w-[58ch] text-pretty text-[17px] leading-[1.6] text-ink-2">
          {fill(prose.what, v)}
        </p>

        {/* The one call to action. It copies, it does not navigate. */}
        <div className="mt-8">
          <CopyPrompt
            prompt={promptFor(tpl)}
            label={t.templatePage.copyLabel}
            copiedLabel={t.copyPrompt.copied}
            logos={["claude", "openai", "cursor"]}
          />
        </div>
        <p className="mt-4 max-w-[54ch] text-[14px] leading-[1.6] text-ink-3">
          {t.templatePage.copyNote}
        </p>
      </header>

      <section className={`${WRAP} pb-[clamp(64px,8vw,112px)]`}>
        <div className="grid gap-8 border-t border-line pt-10 min-[760px]:grid-cols-2">
          <Facts
            head={fill(t.templatePage.provisionsHead, v)}
            items={
              prose.provisions.length
                ? prose.provisions.map((p) => fill(p, v))
                : [t.templatePage.noProvisions]
            }
          />
          <Facts
            head={t.templatePage.generatesHead}
            items={
              tpl.generates.length
                ? tpl.generates.map((g) => fill(t.templatePage.generatedSuffix, { key: g }))
                : [t.templatePage.noGenerates]
            }
          />
          <Facts head={t.templatePage.asksHead} items={asks} />
          <Facts
            head={t.templatePage.handledHead}
            items={[
              ...(tpl.selfUrl.length
                ? [fill(t.templatePage.selfUrlLine, { vars: tpl.selfUrl.join(" / ") })]
                : []),
              ...(tpl.needsRelease ? [t.templatePage.migrationsLine] : []),
              t.templatePage.privateLine,
            ]}
          />
        </div>

        {prose.caveats.length ? (
          <div className="mt-10 rounded-[8px] border border-line bg-tile p-6">
            <div className="text-[12px] uppercase tracking-[0.16em] text-ink-3">
              {t.templatePage.caveatsHead}
            </div>
            <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
              {prose.caveats.map((c) => (
                <li key={c} className="text-[15px] leading-[1.6] text-ink-2">
                  {fill(c, v)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-8 text-[14.5px]">
          <a
            className="group inline-flex items-center gap-2 text-brand-ink transition-colors hover:text-brand"
            href={agentUrl(tpl)}
          >
            {t.templatePage.readInstructions}
            <ArrowUpRight
              size={15}
              strokeWidth={2}
              className="transition-transform group-hover:translate-x-[2px]"
            />
          </a>
          <a
            className="group inline-flex items-center gap-2 text-ink-2 transition-colors hover:text-ink"
            href={tpl.repo}
            target="_blank"
            rel="noreferrer"
          >
            {fill(t.templatePage.onGithub, { name: tpl.name })}
            <ArrowUpRight size={15} strokeWidth={2} />
          </a>
          <a
            className="group inline-flex items-center gap-2 text-ink-2 transition-colors hover:text-ink"
            href="/llms.txt"
          >
            {fill(t.templatePage.everyCommand, { cli: CLI })}
            <ArrowUpRight size={15} strokeWidth={2} />
          </a>
        </div>
      </section>
    </SiteChrome>
  );
}
