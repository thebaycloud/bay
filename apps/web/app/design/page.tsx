import { ArrowRight, Copy } from "lucide-react";
import { Button } from "@/components/ds/Button";
import { DashboardBlocks, TintRow } from "@/components/ds/Blocks";

export const metadata = { title: "Supersonic — Design blocks" };

/**
 * Blocks we reuse everywhere. Not a redesign, and not a full dashboard — just
 * the pieces, at real size, built from the real components so what lands here
 * is what ships.
 *
 * `globals.css` sets `body { overflow: hidden }` for the cockpit shell, so this
 * page owns a fixed layer with its own scroll.
 */

function Section({ n, title, note, children }: { n: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-7 border-t border-line pt-10">
      <div className="flex flex-col gap-2">
        <div className="font-mono text-label uppercase text-ink-3">{n}</div>
        <h2 className="text-title text-ink">{title}</h2>
        {note && <p className="max-w-[62ch] text-body text-ink-2">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="font-mono text-label uppercase text-ink-3">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function DesignPage() {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white font-sans text-ink antialiased">
      <div className="mx-auto flex max-w-[1040px] flex-col gap-14 px-10 pb-32 pt-16">

        <header className="flex flex-col gap-5">
          <div className="flex items-center gap-2.5">
            <span className="size-3 rounded-[3px] bg-red" />
            <span className="text-[16px] font-semibold tracking-[-0.03em]">Supersonic</span>
            <span className="font-mono text-micro text-ink-3">design blocks</span>
          </div>
          <h1 className="text-display max-w-[18ch] text-ink">Blocks we reuse everywhere.</h1>
        </header>

        {/* ---------------------------------------------------------------- */}
        <Section
          n="01 — Buttons"
          title="Two surfaces. Hover swaps them."
          note="Every button is a pair: what it is at rest, and what it becomes under the cursor. Either end can be white or flat red, so both directions are the same component with the ends reversed. The label colour and the hairline edge travel with the surface — ink on white, white on red. Metal used to be a third and fourth surface, two .webp plates cross-fading under the cursor; it is gone, because it cost every page with a button two image fetches to draw one."
        >
          <p className="-mt-2 font-mono text-micro text-ink-3">Point at everything below.</p>

          <Row label="White at rest → red on hover">
            <Button rest="white" hover="solid" size="sm">Open console</Button>
            <Button rest="white" hover="solid" size="md">Deploy now</Button>
            <Button rest="white" hover="solid" size="lg">
              Deploy now
              <ArrowRight size={18} strokeWidth={2} />
            </Button>
          </Row>

          <Row label="Red at rest → white on hover">
            <Button rest="solid" hover="white" size="sm">Ship again</Button>
            <Button rest="solid" hover="white" size="md">Ship again</Button>
            <Button rest="solid" hover="white" size="lg">
              Ship again
              <ArrowRight size={18} strokeWidth={2} />
            </Button>
          </Row>

          <Row label="No change — the label still rolls">
            <Button rest="solid" size="sm">Ship</Button>
            <Button rest="solid" size="md">Ship</Button>
            <Button rest="white" size="md">
              <Copy size={16} strokeWidth={2} />
              Copy
            </Button>
            <Button rest="solid" size="md" disabled>Disabled</Button>
          </Row>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          n="02 — Text"
          title="One near-black, four opacities."
          note="Hierarchy comes from size and opacity, never from boxes. Mono is machine text only — addresses, counts, timestamps, commands — so that seeing mono tells you a machine wrote it."
        >
          <div className="flex flex-col">
            {[
              ["Display", "44 / 46 · -0.042em", <span key="d" className="text-display">Ship it to Maya</span>],
              ["Title", "28 / 32 · -0.035em", <span key="t" className="text-title">standup-notes</span>],
              ["Section", "20 / 28 · -0.1px", <span key="s" className="text-section">Database</span>],
              ["Body", "16 / 24", <span key="b" className="text-body text-ink-2">Four people opened this tool today. Nobody had to install anything.</span>],
              ["Sub", "13 / 20 · ink-2", <span key="u" className="text-sub text-ink-2">Your app&rsquo;s data and files</span>],
              ["Machine", "14 / 22 · mono", <span key="m" className="font-mono text-val text-red-ink">standup-notes.thebay.cloud</span>],
              ["Label", "11 · 0.14em caps", <span key="l" className="font-mono text-label uppercase text-ink-3">Shared with</span>],
            ].map(([name, spec, demo]) => (
              <div key={name as string} className="grid grid-cols-1 items-baseline gap-2 border-b border-line py-4 sm:grid-cols-[128px_1fr] sm:gap-6">
                <div className="font-mono text-[11px] leading-5 text-ink-3">
                  {name}
                  <br />
                  {spec}
                </div>
                <div className="min-w-0">{demo}</div>
              </div>
            ))}
          </div>

          <Row label="The two reds — why there are two">
            <div className="flex flex-col gap-2">
              <div className="rounded-xl bg-tint p-4 font-mono text-val text-red">standup-notes.thebay.cloud</div>
              <div className="font-mono text-[11px] text-ink-3">#E63F2C on tint — 3.58:1, fails</div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="rounded-xl bg-tint p-4 font-mono text-val text-red-ink">standup-notes.thebay.cloud</div>
              <div className="font-mono text-[11px] font-semibold text-red-ink">#C9301B on tint — 5.10:1, passes</div>
            </div>
          </Row>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          n="03 — Dashboard blocks"
          title="Cells share one hairline."
          note="Cells share one hairline instead of each drawing a border, so the screen is a single ruled surface. The mark at the crossing is four radial gradients — no image, no SVG."
        >
          <DashboardBlocks />

          <Row label="The value row on its own">
            <div className="w-full max-w-[460px]">
              <TintRow value="https://mcp.thebay.cloud/v2/mcp-oauth" />
            </div>
          </Row>
        </Section>

      </div>
    </div>
  );
}
