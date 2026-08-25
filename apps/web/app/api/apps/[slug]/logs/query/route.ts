export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { forbiddenBody } from "@/lib/api-error";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { readLogs, MAX_PAGE } from "@/lib/logs";
import { parseQuery } from "@/lib/logs-query";

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

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json(forbiddenBody(), { status: 403 });
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
