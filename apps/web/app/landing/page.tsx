import { Hero } from "@/components/landing/Hero";
import { Navbar } from "@/components/landing/Navbar";
import { Backdrop } from "@/components/landing/Backdrop";
import { FrameGuides, COL } from "@/components/landing/Bridge";
import { TowerDivider } from "@/components/landing/Tower";

export const metadata = { title: "Supersonic — Landing" };

/**
 * `globals.css` sets `body { overflow: hidden }` for the cockpit shell, so this
 * owns a fixed layer with its own scroll, same as /design. The guides live in a
 * `relative` wrapper around all the content so they span the full scroll height
 * rather than restarting at each section.
 */
function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto w-full px-16 py-28" style={{ maxWidth: COL }}>
      <div className="flex max-w-[52ch] flex-col gap-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">{eyebrow}</p>
        <h2 className="text-[clamp(24px,3vw,34px)] font-semibold leading-[1.1] tracking-[-0.035em]">
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div
      data-scroll-root
      className="fixed inset-0 z-50 overflow-y-auto bg-white font-sans text-ink antialiased"
    >
      <Backdrop />

      <div className="relative z-10">
        {/* The column's paper. Opaque, full page height, exactly the content
            width — this is what confines the fog to the margins. */}
        {/* -z-10 is load-bearing. This is absolutely positioned, and a
            positioned element paints above static-flow siblings — without it the
            paper covers the tower dividers and every section below the hero.
            The parent's z-10 keeps the whole group above the fog regardless. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-full -translate-x-1/2 bg-white"
          style={{ maxWidth: COL }}
        />

        <FrameGuides />

        <Navbar />

        <Hero />

        <TowerDivider />

        <Section eyebrow="Why now" title="Configuration used to be free.">
          <p className="text-body text-ink-2">
            Three weeks writing an app and two hours deploying it was a rounding error.
            An agent writes the same app in twenty minutes, and those two hours are now
            most of the project. Infrastructure became the bottleneck precisely because
            code stopped being one.
          </p>
        </Section>

        <TowerDivider />

        <Section eyebrow="Every agent ships here" title="We don’t care which one you use.">
          <p className="font-mono text-sub text-ink-2">
            Claude Code · Cursor · Codex · Windsurf · Lovable · Bolt · Replit
          </p>
        </Section>

        <TowerDivider />

        <div className="h-40" />
      </div>
    </div>
  );
}
