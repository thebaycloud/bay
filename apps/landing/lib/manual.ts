import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

/**
 * The manual, as a document rather than as a stream of bytes.
 *
 * `content/manual.md` is one file with several readers: `/llms.txt` serves it
 * verbatim to an agent, the apex serves it to a terminal, and `/docs` renders
 * it as a page. One source, three representations — because documentation that
 * exists twice is documentation that disagrees with itself by the second edit.
 *
 * The ids are added here and not by marked, which stopped emitting them in v5.
 * They are what makes a heading linkable, which is what makes a section
 * quotable: an agent that wants to point somebody at the secrets rules should be
 * able to send `/docs#secrets` rather than "search the page for secrets".
 */
export type Section = { id: string; title: string };

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

let cached: { html: string; sections: Section[] } | null = null;

export function manual(): { html: string; sections: Section[] } {
  if (cached) return cached;

  const md = readFileSync(join(process.cwd(), "content/manual.md"), "utf8");
  const sections: Section[] = [];

  // The h1 is the document's own title, which the page already sets in its
  // header, so it is dropped rather than rendered twice.
  const html = (marked.parse(md.replace(/^#\s+.*\n/, ""), { async: false }) as string).replace(
    /<h2>([^<]*)<\/h2>/g,
    (_m, title: string) => {
      const id = slug(title);
      sections.push({ id, title });
      return `<h2 id="${id}">${title}</h2>`;
    }
  );

  cached = { html, sections };
  return cached;
}
