export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getPool } from "@/lib/db";
import { probeMany } from "@/lib/probe-run";
import { currentUserId } from "@/lib/session";

const DB = "supersonic_platform";
/** No page shows more apps than this, and a list that long is a mistake, not a request. */
const MAX_SLUGS = 100;

/**
 * Every app on the page, asked in one request.
 *
 * The dashboard used to fire one request per card — twenty-six of them the
 * moment the page painted, against a browser that will run about six at a time
 * on one origin, so the rest queued behind the slowest cold start. Measured at
 * 3.9–5.1s each in the worst cases.
 *
 * The fan-out moved to the server, where it is a concurrency-capped loop over a
 * shared cache instead of twenty-six sockets opened in the same tick.
 */
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const asked: string[] = Array.isArray(body?.slugs)
    ? body.slugs.filter((s: unknown): s is string => typeof s === "string").slice(0, MAX_SLUGS)
    : [];
  if (asked.length === 0) return Response.json({ probes: {} });

  // One query decides what this account may ask about, rather than one
  // ownership check per slug — and an unowned slug is dropped silently, since
  // telling the caller which of their guesses exist is itself an answer.
  const owned = await getPool(DB).query(
    "SELECT slug FROM apps WHERE owner_id = $1 AND slug = ANY($2)",
    [uid, asked],
  );
  const mine = owned.rows.map((r) => r.slug as string);
  if (mine.length === 0) return Response.json({ probes: {} });

  // NDJSON: one line per app, written the moment that app answers. Buffering
  // them into a single object held the whole page behind the slowest cold start
  // on it — the exact failure the one-request-per-card version did not have, and
  // the reason to batch was never to make the page wait longer.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (slug: string, probe: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify({ slug, probe }) + "\n"));
        } catch {
          // The reader went away — a closed tab, a navigation. The probes still
          // finish and still fill the cache, which is not wasted work.
        }
      };
      try {
        await probeMany(mine, uid, write);
      } finally {
        try { controller.close(); } catch { /* already closed by the client */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Nothing in front of this may hold the lines back to fill a buffer;
      // arriving early is the entire point.
      "x-accel-buffering": "no",
    },
  });
}
