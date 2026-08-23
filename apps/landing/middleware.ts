import { NextResponse, type NextRequest } from "next/server";
import { wantsMarkdown } from "./lib/wants-markdown";
import { legacyRedirect } from "./lib/legacy-domain";

/**
 * One address, two audiences.
 *
 * `https://thebay.cloud/` in a browser is the landing page. The same URL in a
 * terminal — `curl thebay.cloud` — is a coding agent, or the person driving
 * one, asking what this is and how to use it from the command line. They get
 * `/llms.txt`: the manual, in markdown, on stdout, at the address they already
 * guessed. No second URL to learn and no HTML to strip.
 *
 * A rewrite and not a redirect: `curl` does not follow redirects unless told
 * to, so a 307 here would print a Location header and nothing else — which is
 * precisely the failure this exists to remove. The body arrives on the first
 * request, at status 200.
 *
 * `Vary` is not decoration. The response for `/` now depends on two request
 * headers, and any cache between here and the reader that does not know that
 * will eventually hand a browser the manual, or a terminal the markup.
 */
export function middleware(req: NextRequest) {
  // The old domain, first and for every path. A person who followed a link to
  // supersonic.cv/pricing should land on the new pricing page, not on the new
  // home page — and certainly not on a page that says Bay at the old address.
  const moved = legacyRedirect(req.headers.get("host"), req.nextUrl.pathname + req.nextUrl.search);
  if (moved) return NextResponse.redirect(moved, 301);

  // Below here: the root only, whatever the matcher lets through.
  if (req.nextUrl.pathname !== "/") return NextResponse.next();

  if (!wantsMarkdown(req.headers.get("accept"), req.headers.get("user-agent"))) {
    return NextResponse.next();
  }
  const res = NextResponse.rewrite(new URL("/llms.txt", req.url));
  res.headers.set("Vary", "Accept, User-Agent");
  res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return res;
}

/**
 * Everything except Next's own assets.
 *
 * It was `"/"` while the only job here was the markdown rewrite. The legacy
 * redirect needs every path — somebody following a link to
 * supersonic.cv/pricing has to arrive at the new pricing page — so the matcher
 * widened and the rewrite grew an explicit `pathname !== "/"` guard instead of
 * relying on the matcher to be its scope.
 *
 * `_next` and `favicon.ico` are excluded because redirecting a chunk request
 * costs a round trip and buys nothing: nobody bookmarks a hashed asset.
 */
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
