import { getPool } from "./db";
import { HttpError } from "./http";

export interface ScrapedProspect {
  profileUrl: string;
  fullName?: string;
  headline?: string;
  company?: string;
  title?: string;
  location?: string;
}

export const SOURCES = [
  "post_likers",
  "post_commenters",
  "search",
  "connections",
  "csv",
] as const;

export type Source = (typeof SOURCES)[number];

/**
 * Reduce any LinkedIn profile URL to `https://www.linkedin.com/in/<slug>`.
 *
 * The same person surfaces with tracking query strings, a locale subdomain
 * (`de.linkedin.com`), a trailing slash, or as a bare `/in/slug` href pulled
 * straight from the DOM. Without one canonical form the unique index does not
 * dedupe and the same prospect gets messaged twice.
 */
export function canonicalProfileUrl(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // DOM hrefs are frequently relative.
  const absolute = trimmed.startsWith("/") ? `https://www.linkedin.com${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;

  const m = /^\/in\/([^/]+)\/?/.exec(parsed.pathname);
  if (!m) return null;

  // The slug is already percent-encoded in the href; decoding and re-encoding
  // normalises the two spellings of non-ASCII names to one.
  let slug: string;
  try {
    slug = encodeURIComponent(decodeURIComponent(m[1]));
  } catch {
    slug = m[1];
  }
  if (!slug) return null;

  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

/**
 * Best-effort first name, used for template variables and as the only name the
 * copy generator is allowed to open with.
 *
 * Deliberately conservative: it strips credential suffixes and honorifics but
 * makes no attempt to parse multi-part given names. A wrong first name is worse
 * than none, so anything unexpected falls back to the whole string.
 */
export function firstNameOf(fullName: string | undefined): string | null {
  if (!fullName) return null;
  // Everything after a comma is a credential list ("Jane Doe, PhD, MBA").
  const beforeComma = fullName.split(",")[0];
  const words = beforeComma
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ") // badges and emoji
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return null;

  const honorifics = new Set(["mr", "mrs", "ms", "mx", "dr", "prof", "sir"]);
  const first = words[0];
  const stripped = first.replace(/\.$/, "").toLowerCase();
  if (honorifics.has(stripped) && words.length > 1) return words[1];
  return first;
}

export interface IngestResult {
  runId: string;
  found: number;
  created: number;
  existing: number;
  skipped: number;
}

/**
 * Upsert a batch of scraped prospects and record the scrape run.
 *
 * Ownership is claimed on first insert and never transferred: if a teammate
 * already owns the prospect, a later scrape by someone else enriches the row
 * but leaves the owner alone.
 */
export async function ingestProspects(opts: {
  accountId: string;
  source: Source;
  sourceRef?: string;
  prospects: ScrapedProspect[];
}): Promise<IngestResult> {
  if (!SOURCES.includes(opts.source)) {
    throw new HttpError(400, `unknown source: ${opts.source}`);
  }

  const seen = new Set<string>();
  const rows: Array<Required<Pick<ScrapedProspect, "profileUrl">> & ScrapedProspect> = [];
  let skipped = 0;

  for (const p of opts.prospects) {
    const url = canonicalProfileUrl(p.profileUrl);
    // A batch routinely contains the same person twice — a virtualised list can
    // re-render a row mid-scroll. Dedupe here so the statement below does not
    // hit "cannot affect row a second time".
    if (!url || seen.has(url)) {
      skipped++;
      continue;
    }
    seen.add(url);
    rows.push({ ...p, profileUrl: url });
  }

  const pool = getPool();

  if (!rows.length) {
    const { rows: runRows } = await pool.query<{ id: string }>(
      `INSERT INTO scrape_runs (account_id, source, source_ref, found_count, new_count)
       VALUES ($1, $2, $3, $4, 0) RETURNING id`,
      [opts.accountId, opts.source, opts.sourceRef ?? null, opts.prospects.length],
    );
    return {
      runId: runRows[0].id,
      found: opts.prospects.length,
      created: 0,
      existing: 0,
      skipped,
    };
  }

  // unnest() keeps this to one round trip regardless of batch size.
  const { rows: upserted } = await pool.query<{ id: string; inserted: boolean }>(
    `INSERT INTO prospects
       (profile_url, full_name, first_name, headline, company, title, location,
        source, source_ref, owner_id)
     SELECT t.profile_url, t.full_name, t.first_name, t.headline, t.company,
            t.title, t.location, $8::text, $9::text, $10::uuid
     FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
     ) AS t(profile_url, full_name, first_name, headline, company, title, location)
     ON CONFLICT (profile_url) DO UPDATE SET
       full_name = COALESCE(prospects.full_name, EXCLUDED.full_name),
       first_name = COALESCE(prospects.first_name, EXCLUDED.first_name),
       headline  = COALESCE(prospects.headline,  EXCLUDED.headline),
       company   = COALESCE(prospects.company,   EXCLUDED.company),
       title     = COALESCE(prospects.title,     EXCLUDED.title),
       location  = COALESCE(prospects.location,  EXCLUDED.location),
       -- Never reassign an owned prospect to whoever scraped it most recently.
       owner_id  = COALESCE(prospects.owner_id,  EXCLUDED.owner_id)
     RETURNING id, (xmax = 0) AS inserted`,
    [
      rows.map((r) => r.profileUrl),
      rows.map((r) => r.fullName ?? null),
      rows.map((r) => firstNameOf(r.fullName)),
      rows.map((r) => r.headline ?? null),
      rows.map((r) => r.company ?? null),
      rows.map((r) => r.title ?? null),
      rows.map((r) => r.location ?? null),
      opts.source,
      opts.sourceRef ?? null,
      opts.accountId,
    ],
  );

  const created = upserted.filter((r) => r.inserted).length;

  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO scrape_runs (account_id, source, source_ref, found_count, new_count)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.accountId, opts.source, opts.sourceRef ?? null, opts.prospects.length, created],
  );

  return {
    runId: runRows[0].id,
    found: opts.prospects.length,
    created,
    existing: upserted.length - created,
    skipped,
  };
}
