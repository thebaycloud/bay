import { notFound, permanentRedirect } from "next/navigation";
import { DOCS_URL } from "@/lib/brand";
import { isLocale } from "@/lib/i18n/locales";

/**
 * /docs is where the documentation used to be rendered. It now points at where
 * the documentation is.
 *
 * This page was `content/manual.md` as a page — the same file `/llms.txt`
 * serves, given an address a person would guess. That was the right answer for
 * exactly as long as the manual was the only documentation there was.
 *
 * `apps/docs` is now published, and it is not the same document: twenty-two
 * pages against one file, with a CLI reference derived from `bay help --all`
 * and a configuration reference derived from the exported types the control
 * plane actually parses. Keeping both meant two descriptions of one product,
 * overlapping on install, ship, databases, secrets, domains and logs, drifting
 * from the first edit that touched one and not the other.
 *
 * So the split is by reader rather than by document. A person gets the site. An
 * agent gets `/llms.txt`, which is untouched and still reads `content/manual.md`
 * — one file, one request, no navigation to crawl. Neither is a lesser copy of
 * the other, which is what makes this survivable.
 *
 * Permanent, because the address is not coming back. `lib/pages.ts` still lists
 * it with `index: false`: middleware asks "is this a page" before routing, so
 * dropping the entry answered a terminal asking for /docs with a 404 for a URL
 * that does redirect — while `index: false` keeps it out of the sitemap, where a
 * redirecting URL asks a crawler to index a hop.
 *
 * Dynamic, and NOT prerendered, which is the part that has to be said. With
 * `generateStaticParams` this page built to a 308 carrying no Location header at
 * all: an external redirect cannot be baked into a static route, so every locale
 * answered with a dead end that looked like a redirect in the status line. The
 * redirect has to be computed per request for the header to exist.
 */
export const dynamic = "force-dynamic";

export default function Docs({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  permanentRedirect(DOCS_URL);
}
