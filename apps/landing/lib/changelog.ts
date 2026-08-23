import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

/**
 * The changelog, read from markdown on disk.
 *
 * Markdown rather than MDX: entries are prose with the occasional link and
 * heading, and MDX would buy components inside content at the cost of a build
 * pipeline. Written by hand rather than generated from git, because CONTEXT.md
 * keeps platform language away from people and a generated log would put
 * `fleet_placements` in front of them.
 *
 * `draft: true` keeps an entry out of the index, the routes and the feed. It is
 * how something written ahead of shipping waits without being live: flip the one
 * word on the day it is true.
 */

const DIR = path.join(process.cwd(), "content", "changelog");

export interface Entry {
  slug: string;
  title: string;
  /** ISO date from the frontmatter. */
  date: string;
  /** One line for the index and the feed. */
  summary: string;
  /** Rendered HTML of the body. */
  html: string;
  /** Roughly how long the body is, which decides how the index shows it. */
  long: boolean;
}

/**
 * YAML turns an unquoted `date: 2026-08-19` into a Date, not a string, so this
 * has to accept both. Reading it as a string gave "Wed Aug 19" and every entry
 * rendered "Invalid Date" and sorted wrong.
 */
function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
}

/** Aug 24, 2026. Fixed locale so the server and the client agree. */
export function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function allEntries(): Entry[] {
  if (!fs.existsSync(DIR)) return [];

  const entries = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(DIR, file), "utf8");
      const { data, content } = matter(raw);
      if (data.draft) return null;

      const body = content.trim();
      return {
        slug: file.replace(/\.md$/, ""),
        title: String(data.title ?? "Untitled"),
        date: isoDate(data.date),
        summary: String(data.summary ?? ""),
        html: marked.parse(body, { async: false }) as string,
        // A one-paragraph note reads fine inline; anything longer earns its own
        // page, so the index stays scannable instead of becoming one long scroll.
        long: body.length > 420 || /\n## /.test(body),
      } satisfies Entry;
    })
    .filter((e): e is Entry => e !== null);

  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function entryBySlug(slug: string): Entry | undefined {
  return allEntries().find((e) => e.slug === slug);
}
