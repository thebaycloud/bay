export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { readLogs, ALL_SINCE, SOURCES, LEVELS, MAX_PAGE, type Query, type Source, type Level } from "@/lib/logs";

/**
 * A page of logs, newest first.
 *
 * Every parameter is validated against a closed set before it reaches the filter
 * builder — `source`, `level` and `face` are enumerations, `status` is an integer,
 * and `search` is escaped by `quote` because it is the one free-text field and
 * therefore the one that could try to escape the app restriction.
 *
 * `cursor` is opaque and comes back from a previous page. It carries a Cloud
 * Logging page token and the window it was minted against, because a token is
 * only valid for a byte-identical request.
 */

/** Windows the UI may ask for. A closed set, so `since` is never a caller's string. */
const WINDOWS: Record<string, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export function parseQuery(sp: URLSearchParams): { q: Query; window: string } {
  const window = sp.get("window") && sp.get("window")! in WINDOWS ? sp.get("window")! : "24h";
  const ms = WINDOWS[window];

  const sources = (sp.get("source") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Source => (SOURCES as string[]).includes(s));

  const faceRaw = sp.get("face");
  const levelRaw = sp.get("level");
  const status = Number(sp.get("status"));

  return {
    window,
    q: {
      sources,
      face: faceRaw === "frontend" || faceRaw === "backend" ? faceRaw : null,
      minLevel: (LEVELS as string[]).includes(levelRaw ?? "") ? (levelRaw as Level) : null,
      search: sp.get("q"),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      method: sp.get("method"),
      path: sp.get("path"),
      since: ms === null ? ALL_SINCE : new Date(Date.now() - ms).toISOString(),
    },
  };
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const { q, window } = parseQuery(sp);
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), MAX_PAGE);

  try {
    const page = await readLogs(slug, q, { limit, cursor: sp.get("cursor") });
    return Response.json({ ...page, window });
  } catch (e) {
    // Cloud Logging's own words. "invalid filter" tells somebody their search was
    // rejected; a wrapped "could not read logs" tells them nothing.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
