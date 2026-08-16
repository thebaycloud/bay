import { COL } from "./Bridge";

/**
 * The navbar sits inside the frame guides and closes the top of the page: the
 * two verticals plus this rule make the header a box rather than two lines
 * running off the top edge. Same grey as the guides — it is one frame.
 *
 * Deliberately thin on links. The page's whole argument is that you copy a
 * prompt and go, so a nav full of product pages would be arguing with it.
 */
const LINKS = [
  { label: "Docs", href: "#0" },
  { label: "Pricing", href: "#0" },
  { label: "Blog", href: "#0" },
];

export function Navbar() {
  return (
    <header className="relative z-20 w-full">
      <div
        className="mx-auto flex h-16 flex-row items-center justify-between px-8"
        style={{ maxWidth: COL }}
      >
        <a href="#0" className="flex items-center gap-2.5">
          <span className="size-3 rounded-[3px] bg-red" />
          <span className="text-[15px] font-semibold tracking-[-0.03em]">Supersonic</span>
        </a>

        {/* `flex-row` and `p-0` are not redundant: globals.css still carries the
            cockpit's blueprint rules, including a bare `nav { display:flex;
            flex-direction:column; padding:10px 8px }`. Tailwind's `flex` sets
            display but not direction, so without this the links stack. */}
        <nav className="hidden flex-row items-center gap-8 p-0 sm:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sub text-ink-2 transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-5">
          <a href="#0" className="text-sub text-ink-2 transition-colors hover:text-ink">
            Sign in
          </a>
        </div>
      </div>

      {/* the rule closing the header, guide to guide */}
      <div className="mx-auto h-px bg-[#C8CDD2]" style={{ maxWidth: COL }} />
    </header>
  );
}
