import { TEMPLATES, agentMarkdown, templateBySlug } from "@/lib/templates";

/**
 * The instructions an agent actually follows.
 *
 * The copy button puts a three-line prompt on the clipboard that points here, so
 * the instructions are not frozen inside whatever a user pasted last month: a
 * broken template is fixed by editing lib/templates.ts, and the next agent to
 * fetch this gets the fix. Served as text/markdown so a model reads it as prose
 * and a browser shows it rather than downloading it.
 *
 * Same source as the human page. That is the point.
 */

export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ slug: t.slug }));
}

export function GET(_req: Request, { params }: { params: { slug: string } }) {
  const t = templateBySlug(params.slug);
  if (!t) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(agentMarkdown(t), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Long enough to be cheap, short enough that a fix to a broken template
      // reaches the next agent the same day.
      "cache-control": "public, max-age=300, s-maxage=3600",
    },
  });
}
