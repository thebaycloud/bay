export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { watch } from "@/lib/log-hub";
import { parseQuery } from "@/lib/logs-query";

/**
 * The live tail, as server-sent events.
 *
 * SSE rather than a WebSocket: this is one-directional, it reconnects by itself,
 * and it needs no protocol upgrade through the load balancer. The filter is a
 * query parameter, so changing a filter means reopening the stream — which is
 * cheap, because the upstream Cloud Logging tail is shared and does not reopen.
 *
 * A comment line every twenty seconds. An idle SSE connection through a proxy is
 * indistinguishable from a dead one, and both Cloud Run and the browser will close
 * it — so the heartbeat is what keeps a quiet app's tail alive, and a quiet app is
 * the normal case.
 */
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return new Response("forbidden", { status: 403 });
  }
  const { q } = parseQuery(new URL(req.url).searchParams);

  const encoder = new TextEncoder();
  let stop: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between a row arriving and this write. Not an
          // error: the unsubscribe below is what matters.
        }
      };

      send("open", { at: new Date().toISOString() });

      stop = watch(
        slug,
        q,
        (row) => send("row", row),
        (why) => send("broken", { why }),
      );

      beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": beat\n\n"));
        } catch {
          /* closed */
        }
      }, 20_000);

      // Abort fires when the tab closes, the filter changes, or the page
      // navigates. Without this the hub keeps a sink for a connection nobody is
      // reading and the upstream tail never closes.
      req.signal.addEventListener("abort", () => {
        stop?.();
        if (beat) clearInterval(beat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      stop?.();
      if (beat) clearInterval(beat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some proxies buffer a response until it is large enough, which
      // holds every line until the buffer fills. This is the header that tells
      // them not to, and without it the "live" tail arrives in batches.
      "X-Accel-Buffering": "no",
    },
  });
}
