import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { TEMPLATES } from "@/lib/templates";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";

export const metadata: Metadata = {
  title: `Self-host templates — ${BRAND}`,
  description:
    "Open source you already use, running on an address of your own. Hand the prompt to your coding agent and it does the rest.",
};

const WRAP = "mx-auto w-full max-w-[1200px] px-[22px] min-[900px]:px-10";

export default function TemplatesIndex() {
  return (
    <SiteChrome>
      <header className={`${WRAP} pb-10 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href="/" label={BRAND} />
        <h1 className="m-0 mt-8 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Self-host something you already use
        </h1>
        <p className="mt-4 max-w-[56ch] text-pretty text-[17px] leading-[1.6] text-ink-2">
          Your own address, your own database, your own copy. You do not click through a setup
          wizard: you hand a prompt to the coding agent you already have open, and it deploys the
          thing while you read something else.
        </p>
      </header>

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <div className="grid gap-4 min-[760px]:grid-cols-3">
          {TEMPLATES.map((t) => (
            <Link
              key={t.slug}
              href={`/templates/${t.slug}`}
              className="group/card flex flex-col overflow-hidden rounded-[12px] bg-tile p-6 pb-0"
            >
              <span className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/logos/brand/${t.logo}.png`}
                  alt=""
                  className="h-[18px] w-auto shrink-0 object-contain"
                />
                <span className="text-[17px] font-medium tracking-[-0.02em]">{t.name}</span>
              </span>

              {/* Heading and blurb butt together as one block, two colours, the
                  same treatment as the feature panels above. */}
              <span className="mt-1.5 text-[17px] leading-[1.45] tracking-[-0.015em] text-ink-2">
                {t.blurb}
              </span>

              <span className="mt-4 inline-flex items-center gap-2 text-[15px] text-brand-ink">
                Self-host it
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
                  src={t.shot}
                  alt={`${t.name} running`}
                  width={720}
                  height={450}
                  className="size-full object-cover object-top transition-transform duration-500 group-hover/card:scale-[1.03]"
                />
              </span>
            </Link>
          ))}
        </div>

        <p className="mt-10 max-w-[62ch] text-[14.5px] leading-[1.6] text-ink-3">
          Every one of these builds from its own source on your account. {BRAND} provisions what it
          needs, generates the secrets that are only entropy, and asks you for nothing that it can
          work out itself.
        </p>
      </section>
    </SiteChrome>
  );
}
