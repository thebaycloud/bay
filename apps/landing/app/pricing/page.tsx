import type { Metadata } from "next";
import { Check } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { PLANS } from "@/lib/plans";
import { SiteChrome } from "@/components/SiteChrome";
import { BackLink } from "@/components/BackLink";
import "../changelog/changelog.css";

export const metadata: Metadata = {
  title: `Pricing — ${BRAND}`,
  description: "Free forever, and no infrastructure bill.",
};

const WRAP = "mx-auto w-full max-w-[1200px] px-[22px] min-[900px]:px-10";

const BTN =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[8px] " +
  "border px-[18px] font-sans text-[15px] font-[450] tracking-[-0.01em] transition-colors";

export default function Pricing() {
  return (
    <SiteChrome>
      <header className={`${WRAP} pb-2 pt-[clamp(40px,5vw,72px)]`}>
        <BackLink href="/" label={BRAND} />
        <h1 className="m-0 mt-8 max-w-[26ch] font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          Free forever. No infrastructure bill.
        </h1>
        <p className="mt-4 max-w-[54ch] text-[17px] leading-[1.6] text-ink-2">
          Your cloud is included and you never see an AWS invoice. Apps on the free plan never
          sleep or expire.
        </p>
      </header>

      <section className={`${WRAP} pb-[clamp(72px,9vw,128px)]`}>
        <div className="mt-[clamp(36px,4.5vw,60px)] grid gap-5 min-[900px]:grid-cols-3">
          {PLANS.map((p) => (
            <div
              key={p.name}
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
                    / {p.unit}
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
          Self-hosting an open source project is free for its first year on top of any of these.
          Nothing to claim: it is detected when you deploy.
        </p>
      </section>
    </SiteChrome>
  );
}
