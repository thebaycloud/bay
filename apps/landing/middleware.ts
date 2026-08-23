import { NextResponse, type NextRequest } from "next/server";
import { wantsMarkdown } from "./lib/wants-markdown";

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
  if (!wantsMarkdown(req.headers.get("accept"), req.headers.get("user-agent"))) {
    return NextResponse.next();
  }
  const res = NextResponse.rewrite(new URL("/llms.txt", req.url));
  res.headers.set("Vary", "Accept, User-Agent");
  res.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return res;
}

/**
 * The root only. Every other path on this site is already unambiguous, and the
 * manual keeps its own permanent address at /llms.txt for anyone who asks for
 * it by name.
 */
export const config = { matcher: "/" };
