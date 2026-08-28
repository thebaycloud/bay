import { BRAND, DOCS_URL, SITE } from "@/lib/brand";

/**
 * The 404 a terminal gets, in markdown.
 *
 * `app/[locale]/not-found.tsx` is the same answer written for a browser, and it
 * says in its own comment why it cannot serve this: a not-found component
 * renders through the HTML pipeline and cannot set its own content type. So the
 * markdown lives here, at its own address, and middleware sends the request
 * that wanted it — a path matching no page, asked for by something that reads
 * text rather than paints it — here instead.
 *
 * A dead end costs an agent a turn. Both bodies are the same recovery map, in
 * the same order: the manual first, because a machine that guessed a URL wrong
 * is usually looking for the manual, then the sitemap, then the pages a person
 * would have wanted. Keep them in step.
 *
 * The status is the point. A 200 with a "not found" body teaches a crawler that
 * every path on this domain exists.
 */
export const dynamic = "force-static";

const BODY = `# 404 — there is nothing at this address

The page was moved, or the link was wrong. Everything ${BRAND} publishes is
reachable from here.

- [The manual](${SITE}/llms.txt) — every command, in markdown. Also answers at
  \`/agents.md\`, \`/AGENTS.md\` and \`/cli.md\`, and at the bare domain under \`curl\`.
- [Documentation](${DOCS_URL}) — guides, the CLI reference, the config reference.
- [The API, described](${SITE}/openapi.json) — OpenAPI 3.1, every operation the
  CLI speaks.
- [Sitemap](${SITE}/sitemap.xml) — every page we publish, in six languages.
- [Pricing](${SITE}/pricing) — what it costs.
- [Changelog](${SITE}/changelog) — what shipped, with an [RSS feed](${SITE}/changelog.xml).
- [Contact](${SITE}/contact) — a person reads every one of these.
`;

export function GET() {
  return new Response(BODY, {
    status: 404,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // The response for an unknown path depends on both, exactly as the apex
      // does: a browser gets the HTML 404 and a terminal gets this one.
      Vary: "Accept, User-Agent",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
