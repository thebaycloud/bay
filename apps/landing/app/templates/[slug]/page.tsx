import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, Check } from "lucide-react";
import { BRAND, CLI } from "@/lib/brand";
import { TEMPLATES, agentUrl, promptFor, templateBySlug } from "@/lib/templates";
import { CopyPrompt } from "../copy-prompt";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";

const WRAP = "mx-auto w-full max-w-[900px] px-[22px] min-[900px]:px-10";

export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ slug: t.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const t = templateBySlug(params.slug);
  if (!t) return {};
  return {
    title: `Self-host ${t.name} — ${BRAND}`,
    description: t.blurb,
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

export default function TemplatePage({ params }: { params: { slug: string } }) {
  const t = templateBySlug(params.slug);
  if (!t) notFound();

  const asks = t.asks.length
    ? t.asks.map((a) => `${a.key} — ${a.required ? "required" : "optional"}. ${a.what}`)
    : ["Nothing. There is no question to answer."];

  return (
    <SiteChrome>
      <header className={`${WRAP} pb-8 pt-[clamp(36px,4.5vw,64px)]`}>
        <BackLink href="/templates" label="Templates" />

        <div className="mt-8 flex h-12 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/logos/brand/${t.logo}.png`}
            alt={t.name}
            style={{ height: t.logoHeight + 6 }}
            className="w-auto object-contain"
          />
        </div>

        <h1 className="m-0 mt-6 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Self-host {t.name}
        </h1>
        <p className="mt-4 max-w-[58ch] text-pretty text-[17px] leading-[1.6] text-ink-2">
          {t.what}
        </p>

        {/* The one call to action. It copies, it does not navigate. */}
        <div className="mt-8">
          <CopyPrompt
            prompt={promptFor(t)}
            label={`Onboard your agent`}
            logos={["claude", "openai", "cursor"]}
          />
        </div>
        <p className="mt-4 max-w-[54ch] text-[14px] leading-[1.6] text-ink-3">
          Paste it into Claude Code, Codex, Cursor or anything else that runs commands. It clones
          the source, deploys it, and signs you in on the way past. There is no dashboard step.
        </p>
      </header>

      <section className={`${WRAP} pb-[clamp(64px,8vw,112px)]`}>
        <div className="grid gap-8 border-t border-line pt-10 min-[760px]:grid-cols-2">
          <Facts
            head={`What ${BRAND} provisions`}
            items={t.provisions.length ? t.provisions : ["Nothing. This app needs nothing."]}
          />
          <Facts
            head="Secrets it generates for you"
            items={
              t.generates.length
                ? t.generates.map((g) => `${g}, generated rather than asked for`)
                : ["None needed."]
            }
          />
          <Facts head="What you may be asked for" items={asks} />
          <Facts
            head="Also handled"
            items={[
              ...(t.selfUrl.length
                ? [`Its own address, injected as ${t.selfUrl.join(" and ")}`]
                : []),
              ...(t.needsRelease ? ["Migrations, run before the app starts"] : []),
              "Private until you say otherwise",
            ]}
          />
        </div>

        {t.caveats.length ? (
          <div className="mt-10 rounded-[8px] border border-line bg-tile p-6">
            <div className="text-[12px] uppercase tracking-[0.16em] text-ink-3">
              Before you start
            </div>
            <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
              {t.caveats.map((c) => (
                <li key={c} className="text-[15px] leading-[1.6] text-ink-2">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-8 text-[14.5px]">
          <a
            className="group inline-flex items-center gap-2 text-brand-ink transition-colors hover:text-brand"
            href={agentUrl(t)}
          >
            The instructions your agent will read
            <ArrowUpRight
              size={15}
              strokeWidth={2}
              className="transition-transform group-hover:translate-x-[2px]"
            />
          </a>
          <a
            className="group inline-flex items-center gap-2 text-ink-2 transition-colors hover:text-ink"
            href={t.repo}
            target="_blank"
            rel="noreferrer"
          >
            {t.name} on GitHub
            <ArrowUpRight size={15} strokeWidth={2} />
          </a>
          <a
            className="group inline-flex items-center gap-2 text-ink-2 transition-colors hover:text-ink"
            href="/llms.txt"
          >
            Every {CLI} command
            <ArrowUpRight size={15} strokeWidth={2} />
          </a>
        </div>
      </section>
    </SiteChrome>
  );
}
