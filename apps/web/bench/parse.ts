/**
 * Reading a result out of what the CLI said.
 *
 * A separate file from `run.ts` for one reason: `run.ts` calls `main()` when it
 * is loaded, so nothing can import it to check it. These two functions are the
 * entire seam between "a deploy happened" and "a row was recorded", and the
 * first batch of 10 Aug was lost because the first of them was wrong in a way
 * that no test could have been written to catch while it lived there.
 */

/**
 * The last complete JSON object in a stream of narration.
 *
 * This was originally written to read the output line by line and try to parse
 * each one, on the stated assumption that "the CLI prints its JSON as the last
 * line". It does not: `json()` in packages/cli/index.js is
 * `JSON.stringify(o, null, 2)`, so the result arrives pretty-printed across a
 * dozen lines and not one of them parses on its own. The harness therefore
 * recorded EVERY deploy as `outcome: failed` with a null slug, null runId and
 * null error — a green deploy included — and the first batch looked like a total
 * outage of the product rather than a broken tape measure.
 *
 * So: scan backwards for a `{` at the start of a line and parse from there to
 * the end. Anchoring on the line start is what keeps a brace inside a log
 * sentence from being read as the start of the result; taking the last one is
 * what keeps a JSON-shaped build log from outranking the real answer.
 */
export function lastJsonObject(out: string): Record<string, unknown> | null {
  const lines = out.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines.slice(i).join("\n").trim());
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* not the start of the result after all */ }
  }
  return null;
}

/**
 * The slug and address out of the CLI's reserve line.
 *
 * "⧗ deploying — your app will be live at https://<slug>.…" is printed the
 * moment the server hands the slug over, which makes it both the timestamp of
 * the URL-first promise and the earliest — often only — sight of what this
 * deploy is called. Taking the slug from the final JSON alone meant every run
 * that died before printing one leaked its app: the harness cannot delete what
 * it cannot name.
 *
 * The URL is taken whole rather than rebuilt from the slug and a hard-coded
 * domain. Which host an app answers on is the proxy's business and has changed
 * before, and a probe pointed at a guessed address would report a working
 * deploy as one that never answered.
 */
export function reserveLine(line: string): { slug: string; url: string } | null {
  if (!/will be live at/.test(line)) return null;
  const m = /(https?:\/\/([a-z0-9-]+)\.[^\s]+)/i.exec(line);
  if (!m) return null;
  // Trailing punctuation belongs to the sentence, not to the address.
  return { slug: m[2], url: m[1].replace(/[.,)\]]+$/, "") };
}
