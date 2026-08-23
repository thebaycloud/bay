import { selfhostMarkdown } from "@/lib/templates";

/**
 * Instructions for self-hosting anything, as opposed to one of the three listed
 * templates. Same pattern as /templates/<slug>/agent.md: the copy button puts a
 * short prompt on the clipboard that points here, so the instructions can be
 * fixed without reaching everyone who already pasted one.
 */
export function GET() {
  return new Response(selfhostMarkdown(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
}
