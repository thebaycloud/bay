import Link from "next/link";
import { BRAND } from "@/lib/brand";

/**
 * The 404, written for both readers.
 *
 * The status was already a real 404 rather than a 200 with an app shell, which
 * is the part that actually matters: a 200 on every path teaches a crawler that
 * every path exists. What was missing was a way back. A dead end costs an agent
 * a turn and a person a click to the back button.
 *
 * The links are the recovery map: the manual first, because a machine that
 * guessed a URL wrong is usually looking for the manual, then the sitemap, then
 * the pages a person is most likely to have wanted.
 *
 * Serving this as `text/markdown` to a client that asked for markdown is not
 * possible from here: a not-found component renders through the normal HTML
 * pipeline and cannot set its own content type. Doing it properly would mean
 * middleware holding a list of every valid route so it could recognise a 404
 * before routing happens, and that list would go stale the first time somebody
 * adds a page. The links below are in the markup either way.
 */
const WRAP = "mx-auto w-full max-w-[1040px] px-[22px] min-[900px]:px-10";

const WAYS_BACK: { href: string; label: string; note: string }[] = [
  { href: "/llms.txt", label: "The manual", note: "every command, in markdown" },
  { href: "/sitemap.xml", label: "Sitemap", note: "every page we publish" },
  { href: "/pricing", label: "Pricing", note: "what it costs" },
  { href: "/changelog", label: "Changelog", note: "what we shipped" },
];

export default function NotFound() {
  return (
    <div className="bay flex min-h-screen flex-col bg-ground font-sans text-[16px] leading-[1.55] tracking-[-0.008em] text-ink antialiased">
      <section className={`${WRAP} pt-[clamp(80px,12vw,160px)]`}>
        <p className="m-0 text-[14px] uppercase tracking-[0.16em] text-ink-3">404</p>
        <h1 className="m-0 mt-5 font-sans text-balance text-[clamp(28px,3vw,38px)] font-normal leading-[1.14] tracking-[-0.024em]">
          There is nothing at this address
        </h1>
        <p className="mt-4 max-w-[54ch] text-[17px] leading-[1.6] text-ink-2">
          The page was moved, or the link was wrong. Here is everything {BRAND} publishes.
        </p>

        <ul className="m-0 mt-10 flex list-none flex-col gap-0 p-0 border-t border-line">
          {WAYS_BACK.map((w) => (
            <li key={w.href} className="border-b border-line">
              <Link
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4 transition-colors hover:text-brand-ink"
                href={w.href}
              >
                <span className="text-[17px]">{w.label}</span>
                <span className="text-[14.5px] text-ink-3">{w.note}</span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-10 text-[14.5px] text-ink-3">
          <Link className="text-brand-ink hover:text-brand" href="/">
            Back to {BRAND}
          </Link>
        </p>
      </section>
    </div>
  );
}
