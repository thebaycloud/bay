import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The manual, served as markdown.
 *
 * It used to be a static file in public/, which is why it went out as
 * `text/plain`: a file in public/ carries the type its extension implies and
 * nothing can change that. acceptmarkdown.com asks for `text/markdown`, and more
 * to the point an agent that fetches a document and is told it is plain text has
 * been told something false about it.
 *
 * A route handler owns its own headers, so this is where that gets fixed. The
 * URL is unchanged: `/llms.txt` still answers, next.config still rewrites
 * /agents.md, /AGENTS.md, /agents.txt and /cli.md here, and middleware still
 * rewrites the bare apex here for a terminal.
 *
 * The .txt extension stays on the URL even though the type is now markdown. It
 * is the name the convention established and the one agents guess.
 *
 * `Vary: Accept, User-Agent` because the apex serves this to a terminal and the
 * landing page to a browser. Any cache that does not know the response depends
 * on those two headers will eventually hand a browser the manual.
 */
export const dynamic = "force-static";

const MANUAL = join(process.cwd(), "content/manual.md");

export function GET() {
  return new Response(readFileSync(MANUAL, "utf8"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Vary": "Accept, User-Agent",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
