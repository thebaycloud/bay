import { NextResponse, type NextRequest } from "next/server";
import { wantsMarkdown } from "./lib/wants-markdown";
import { DEFAULT_LOCALE, isLocale } from "./lib/i18n/locales";

/**
 * Two jobs, in this order: serve the manual to terminals, then put every page
 * under a locale.
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
 * `Vary` is not decoration. The response for `/` now depends on two request
 * headers, and any cache between here and the reader that does not know that
 * will eventually hand a browser the manual, or a terminal the markup.
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
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/" && wantsMarkdown(req.headers.get("accept"), req.headers.get("user-agent"))) {
    const res = NextResponse.rewrite(new URL("/llms.txt", req.url));
    res.headers.set("Vary", "Accept, User-Agent");
    res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return res;
  }

  // A dot in the last segment means a file, not a page: /llms.txt, /favicon.ico,
  // /changelog.xml, /selfhost.md, and the per-template /templates/x/agent.md.
  // Those are machine routes, they are English, and they must not be prefixed.
  const segments = pathname.split("/");
  if ((segments[segments.length - 1] ?? "").includes(".")) return NextResponse.next();

  const first = segments[1] ?? "";

  if (first === DEFAULT_LOCALE) {
    const bare = pathname.slice(`/${DEFAULT_LOCALE}`.length) || "/";
    return NextResponse.redirect(new URL(bare, req.url), 308);
  }

  if (isLocale(first)) return NextResponse.next();

  return NextResponse.rewrite(new URL(`/${DEFAULT_LOCALE}${pathname}`, req.url));
}

/**
 * Everything except Next's own internals and the API. `_next` carries the build
 * output and prefixing it would break every asset on the page.
 */
export const config = { matcher: ["/((?!_next|api).*)"] };
