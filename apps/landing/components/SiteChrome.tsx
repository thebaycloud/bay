import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { SiteNav } from "./SiteNav";

/**
 * Nav plus a short footer, for every page that is not the landing page.
 *
 * The navbar is literally the landing page's, from components/SiteNav. The
 * footer is deliberately not: a reading page or a price list does not need the
 * whole sitemap under it, and the landing page's four-column footer on a
 * three-card pricing page reads as more chrome than content.
 */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="bay min-h-screen bg-ground font-sans text-[16px] leading-[1.55] tracking-[-0.008em] text-ink antialiased">
      <SiteNav />
      {children}
      <footer className="border-t border-line py-10">
        <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center gap-x-6 gap-y-2 px-[22px] font-mono text-[12px] text-ink-3 min-[900px]:px-10">
          <Link href="/" className="hover:text-ink">
            {BRAND}
          </Link>
          <Link href="/templates" className="hover:text-ink">
            Templates
          </Link>
          <Link href="/pricing" className="hover:text-ink">
            Pricing
          </Link>
          <Link href="/changelog" className="hover:text-ink">
            Changelog
          </Link>
          <a href="/changelog.xml" className="hover:text-ink">
            RSS
          </a>
        </div>
      </footer>
    </div>
  );
}
