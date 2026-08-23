import { BRAND, SITE } from "@/lib/brand";
import { allEntries } from "@/lib/changelog";

/**
 * The feed. Three people will use it and they are the three who care.
 *
 * Summaries rather than full bodies: the entries link back, and a feed that
 * carries rendered HTML has to keep that HTML valid forever.
 */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function GET() {
  const entries = allEntries();
  const items = entries
    .map(
      (e) => `    <item>
      <title>${esc(e.title)}</title>
      <link>${SITE}/changelog/${e.slug}</link>
      <guid isPermaLink="true">${SITE}/changelog/${e.slug}</guid>
      <pubDate>${new Date(`${e.date}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${esc(e.summary)}</description>
    </item>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${BRAND} changelog</title>
    <link>${SITE}/changelog</link>
    <description>Everything we shipped, newest first.</description>
    <language>en</language>
    <atom:link href="${SITE}/changelog.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=600, s-maxage=3600",
    },
  });
}
