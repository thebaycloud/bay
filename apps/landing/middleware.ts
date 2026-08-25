import { NextResponse, type NextRequest } from "next/server";
import { wantsMarkdown } from "./lib/wants-markdown";
import { legacyRedirect } from "./lib/legacy-domain";
import { DEFAULT_LOCALE, isLocale } from "./lib/i18n/locales";
import { isPublishedPath } from "./lib/pages";

/**
 * Three jobs, and the order is the point: get off the old domain, then answer a
 * terminal with the manual, then put every page under a locale.
 *
 * ── the old domain ──
 *
 * First, and for every path. Somebody following a link to supersonic.cv/pricing
 * has to arrive at the new pricing page, not at the new home page, and certainly
 * not at a page that says Bay at the old address. 301 because the move is
 * permanent and we want it cached and indexed as such.
 *
 * ── the manual ──
 *
 * `https://thebay.cloud/` in a browser is the landing page. The same URL in a
 * terminal, `curl thebay.cloud`, is a coding agent, or the person driving one,
 * asking what this is and how to use it from the command line. They get
 * `/llms.txt`: the manual, in markdown, on stdout, at the address they already
 * guessed. No second URL to learn and no HTML to strip.
 *
 * A rewrite and not a redirect: `curl` does not follow redirects unless told to,
 * so a 307 here would print a Location header and nothing else, which is
 * precisely the failure this exists to remove. The body arrives on the first
 * request, at status 200.
 *
 * `Vary` is not decoration. The response for `/` depends on two request headers,
 * and any cache between here and the reader that does not know that will
 * eventually hand a browser the manual, or a terminal the markup.
 *
 * ── the locale ──
 *
 * Every page lives under `app/[locale]`, which is what lets the root layout set
 * `<html lang>` from the segment. English keeps the unprefixed URLs, which are
 * the ones already indexed, so `/pricing` is rewritten to `/en/pricing` and the
 * reader never sees the prefix. A rewrite rather than a redirect for the same
 * reason as above, plus: the URL is the one we publish and it should stay in the
 * address bar.
 *
 * `/en/pricing` asked for directly is the same page at a second address, which
 * is a duplicate a crawler will find. That one redirects, permanently, to the
 * unprefixed form.
 *
 * ── the dead end ──
 *
 * Last, and it is the manual rule again in a different place. A path that
 * matches no page is a 404 either way; the question is what the body says. A
 * browser gets `app/[locale]/not-found.tsx`, which is written for a person. The
 * same terminal that gets markdown at the apex gets markdown here too, from
 * `/404.md`, because an agent that guessed a URL wrong and receives thirty
 * kilobytes of markup has been handed a dead end rather than a way back.
 *
 * Knowing a path is not a page, here, before routing has happened, needs the
 * list of pages — which is why lib/pages.ts exists and why the sitemap reads
 * the same one. A second copy would go stale the first time somebody adds a
 * page, and a stale copy here serves a 404 for a page that renders.
 */
/** The image routes Next generates from page metadata. */
const META_IMAGE = /\/(opengraph-image|twitter-image|icon|apple-icon)(-[A-Za-z0-9]+)?$/;

export function middleware(req: NextRequest) {
  const moved = legacyRedirect(req.headers.get("host"), req.nextUrl.pathname + req.nextUrl.search);
  if (moved) return NextResponse.redirect(moved, 301);

  const { pathname } = req.nextUrl;

  if (pathname === "/" && wantsMarkdown(req.headers.get("accept"), req.headers.get("user-agent"))) {
    const res = NextResponse.rewrite(new URL("/llms.txt", req.url));
    res.headers.set("Vary", "Accept, User-Agent");
    res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return res;
  }

  // The API is not a page and must never be prefixed. It stays inside the
  // matcher rather than outside it so the legacy redirect above still catches a
  // request that arrived at the old host.
  if (pathname === "/api" || pathname.startsWith("/api/")) return NextResponse.next();

  // A dot in the last segment means a file, not a page: /llms.txt, /favicon.ico,
  // /changelog.xml, /selfhost.md, and the per-template /templates/x/agent.md.
  // Those are machine routes, they are English, and they must not be prefixed.
  const segments = pathname.split("/");
  if ((segments[segments.length - 1] ?? "").includes(".")) return NextResponse.next();

  const first = segments[1] ?? "";

  // The path as it is published, with any locale prefix taken off, which is the
  // spelling lib/pages.ts holds. Done before the redirect below so that a
  // terminal asking for `/ru/nope` is answered rather than sent round a hop.
  const bare = isLocale(first) ? pathname.slice(first.length + 1) || "/" : pathname;

  // META_IMAGE is excluded for the same reason it is excluded from the redirect
  // below: /opengraph-image is a real response, generated from page metadata,
  // and it has no entry in lib/pages.ts because it is not a page. Answering a
  // curl for it with a 404 would be a lie about a URL our own og: tags publish.
  if (
    !isPublishedPath(bare) &&
    !META_IMAGE.test(pathname) &&
    wantsMarkdown(req.headers.get("accept"), req.headers.get("user-agent"))
  ) {
    const res = NextResponse.rewrite(new URL("/404.md", req.url));
    res.headers.set("Vary", "Accept, User-Agent");
    return res;
  }

  if (first === DEFAULT_LOCALE) {
    // Metadata images are the exception. Next builds og:image from the route it
    // lives on, so the tag says /en/opengraph-image, and redirecting that costs a
    // hop on every scrape and loses the preview entirely for a scraper that does
    // not follow one. An image answering at two URLs costs nothing.
    if (META_IMAGE.test(pathname)) return NextResponse.next();
    const bare = pathname.slice(`/${DEFAULT_LOCALE}`.length) || "/";
    return NextResponse.redirect(new URL(bare, req.url), 308);
  }

  if (isLocale(first)) return NextResponse.next();

  // `pathname` is "/" at the root, and appending it would ask for "/en/" with a
  // trailing slash. Next normalises trailing slashes on a REDIRECT and not on a
  // rewrite, so that spelling simply 404s.
  const target = pathname === "/" ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${pathname}`;
  return NextResponse.rewrite(new URL(target, req.url));
}

/**
 * Everything except Next's own assets.
 *
 * It was `"/"` while the only job here was the markdown rewrite. Both of the
 * other two need every path: the legacy redirect so that a link to
 * supersonic.cv/pricing lands on the right page, and the locale rewrite because
 * that is how any page is reached at all.
 *
 * `_next` and `favicon.ico` are excluded because rewriting a chunk request costs
 * a round trip and buys nothing: nobody bookmarks a hashed asset, and a locale
 * prefix on one would 404.
 */
export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
