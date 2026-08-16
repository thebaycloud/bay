import { ArrowRight, Copy } from "lucide-react";
import { Button } from "@/components/ds/Button";
import { Metal, type Finish } from "@/components/ds/Metal";
import { DashboardBlocks, TintRow } from "@/components/ds/Blocks";

export const metadata = { title: "Supersonic — Design blocks" };

/**
 * Blocks we reuse everywhere. Not a redesign, and not a full dashboard — just
 * the pieces, at real size, built from the real components so what lands here
 * is what ships.
 *
 * `globals.css` sets `body { overflow: hidden }` for the cockpit shell, so this
 * page owns a fixed layer with its own scroll. That also puts it above the
 * graph-paper substrate, which would otherwise show through.
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

const FINISHES: { f: Finish; note: string }[] = [
  { f: "brushed", note: "Vertical grain. Tiles at any width." },
  { f: "panoramic", note: "Horizontal grain + irregular bands. Never tiles." },
  { f: "satin", note: "Matte, near-flat. The only one quiet enough to sit under content." },
];

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
          title="Metal is the surface. Hover swaps it."
          note="Every button is a pair: what it is at rest, and what it becomes under the cursor. Either end can be white, steel, or red metal, so both directions are the same component with the ends reversed. The label colour and the hairline edge travel with the surface — ink on white and steel, white on red, and no ring on metal because metal defines its own edge."
        >
          <p className="-mt-2 font-mono text-micro text-ink-3">Point at everything below.</p>

          <Row label="White at rest → metal on hover">
            <Button rest="white" hover="steel" size="md">Open console</Button>
            <Button rest="white" hover="steel" size="md" finish="satin">Settings</Button>
            <Button rest="white" hover="red" size="md">Deploy now</Button>
            <Button rest="white" hover="red" size="lg">
              Deploy now
              <ArrowRight size={18} strokeWidth={2} />
            </Button>
          </Row>

          <Row label="Metal at rest → white on hover">
            <Button rest="steel" hover="white" size="md">Open console</Button>
            <Button rest="steel" hover="white" size="md" finish="satin">Settings</Button>
            <Button rest="red" hover="white" size="md">Deploy now</Button>
            <Button rest="red" hover="white" size="lg" finish="panoramic">
              Deploy now
              <ArrowRight size={18} strokeWidth={2} />
            </Button>
          </Row>

          <Row label="Metal both ends — steel ⇄ red">
            <Button rest="steel" hover="red" size="md">Ship again</Button>
            <Button rest="red" hover="steel" size="md">Ship again</Button>
          </Row>

          <Row label="No change — flat red, and plain white">
            <Button rest="solid" size="sm">Ship</Button>
            <Button rest="solid" size="md">Ship</Button>
            <Button rest="white" size="md">
              <Copy size={16} strokeWidth={2} />
              Copy
            </Button>
            <Button rest="solid" size="md" disabled>Disabled</Button>
          </Row>

          <Row label="Finish changes the character">
            <Button rest="red" hover="white" size="md" finish="brushed">Brushed</Button>
            <Button rest="red" hover="white" size="md" finish="panoramic">Panoramic</Button>
            <Button rest="red" hover="white" size="md" finish="satin">Satin</Button>
          </Row>

          <Row label="Plate zoom — pick one">
            {[1, 3, 5, 8, 12].map((z) => (
              <div key={z} className="flex flex-col items-start gap-2">
                <Button rest="red" size="md" zoom={z}>Deploy now</Button>
                <Button rest="steel" size="md" zoom={z}>Open console</Button>
                <span className="font-mono text-[11px] text-ink-3">
                  zoom {z}
                  {z === 1 ? " · fits whole plate" : ""}
                </span>
              </div>
            ))}
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
              ["Machine", "14 / 22 · mono", <span key="m" className="font-mono text-val text-red-ink">standup-notes.supersonic.cv</span>],
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
              <div className="rounded-xl bg-tint p-4 font-mono text-val text-red">standup-notes.supersonic.cv</div>
              <div className="font-mono text-[11px] text-ink-3">#E63F2C on tint — 3.58:1, fails</div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="rounded-xl bg-tint p-4 font-mono text-val text-red-ink">standup-notes.supersonic.cv</div>
              <div className="font-mono text-[11px] font-semibold text-red-ink">#C9301B on tint — 5.10:1, passes</div>
            </div>
          </Row>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          n="03 — Dashboard blocks"
          title="Squared cells, rounded parts."
          note="Cells share one hairline instead of each drawing a border, so the screen is a single ruled surface. The mark at the crossing is four radial gradients — no image, no SVG."
        >
          <DashboardBlocks />

          <Row label="The value row on its own">
            <div className="w-full max-w-[460px]">
              <TintRow value="https://mcp.supersonic.cv/v2/mcp-oauth" />
            </div>
          </Row>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          n="04 — Metal"
          title="Three finishes."
          note="Grain is feTurbulence with deliberately unequal baseFrequency — that asymmetry is what turns noise into brushed metal. Every instance is a live filter pass, so these are for hero surfaces and buttons, not for behind every row of a list."
        >
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {FINISHES.map(({ f, note }) => (
              <div key={f} className="flex flex-col gap-3">
                <div className="relative h-32 overflow-hidden shadow-plate">
                  <Metal finish={f} tone="steel" />
                </div>
                <div className="relative h-32 overflow-hidden shadow-plate">
                  <Metal finish={f} tone="red" />
                </div>
                <div className="font-mono text-label uppercase text-ink">{f}</div>
                <div className="text-sub text-ink-2">{note}</div>
              </div>
            ))}
          </div>
        </Section>

      </div>
    </div>
  );
}
