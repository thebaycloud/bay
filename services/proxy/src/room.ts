import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookupApp } from "./registry";
import { decideEdge } from "./edge";
import { latestRunId, stepsAfter, tailSteps, forGuest, type RoomStep } from "./room-feed";

/**
 * The live side of the room: who is watching, what just happened, and when the
 * app starts answering for itself.
 *
 * One poller per slug, not per watcher. Two people watching the same build is the
 * ordinary case — that is what the shared link is for — and a poll loop each
 * would multiply the same two queries by however many friends were sent the URL.
 *
 * Everything here is per-instance and in memory, exactly like the tunnel. The
 * proxy runs at min-instances=1; if it is ever scaled out, watchers on different
 * instances will not see each other's presence and each instance will poll
 * separately. Written down rather than guarded against, because the fix is
 * shared state and this is not the moment to build it.
 */

interface Watcher {
  res: ServerResponse;
  /** Owners get the real build lines. Guests get the movement and nothing else. */
  owner: boolean;
}

interface Session {
  watchers: Set<Watcher>;
  timer: NodeJS.Timeout;
  runId: string | null;
  cursor: number;
  /** When something last actually happened, so quiet can be reported as quiet. */
  lastStepAt: number;
  quietSent: boolean;
  opened: boolean;
}

const sessions = new Map<string, Session>();

/** How often the room asks whether anything happened. */
const TICK_MS = 700;
/**
 * Silence long enough to be worth admitting to.
 *
 * The first 104 seconds of a deploy are the job's own cold start — a 892 MB image
 * pull and a Node boot — and the build has not emitted a line yet because the
 * build has not started. The room must not fill that with invented motion, so it
 * says it is waiting. This is also the number that makes the wait visible to
 * everyone the link was sent to, which is the honest pressure to shorten it.
 */
const QUIET_AFTER_MS = 6_000;

function send(w: Watcher, payload: unknown): boolean {
  try {
    w.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(s: Session, payload: unknown): void {
  for (const w of [...s.watchers]) if (!send(w, payload)) drop(s, w);
}

/** Steps carry text for owners only, so the fan-out is per watcher. */
function broadcastSteps(s: Session, steps: RoomStep[]): void {
  if (!steps.length) return;
  const guestView = forGuest(steps);
  for (const w of [...s.watchers]) {
    if (!send(w, { t: "steps", steps: w.owner ? steps : guestView })) drop(s, w);
  }
}

function drop(s: Session, w: Watcher): void {
  s.watchers.delete(w);
  try { w.res.end(); } catch { /* already gone */ }
}

/**
 * Does the app answer for itself yet?
 *
 * The room opens on this and not on the pipeline saying `done`, because they are
 * not the same moment: a node reports a placed process at the top of its next
 * reconcile pass, so there is a window where the deploy has finished and the URL
 * still has nothing behind it. Opening on `done` would hand the watcher a blank
 * page and call it the app.
 */
function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    try {
      const target = new URL(url);
      const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
        { method: "GET", hostname: target.hostname, port: target.port || undefined, path: target.pathname || "/", timeout: 4_000 },
        (res) => { res.resume(); finish((res.statusCode ?? 500) < 500); },
      );
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
      req.end();
    } catch {
      finish(false);
    }
  });
}

async function tick(slug: string): Promise<void> {
  const s = sessions.get(slug);
  if (!s) return;
  if (!s.watchers.size) { stop(slug); return; }

  // What happened.
  if (!s.runId) s.runId = await latestRunId(slug);
  if (s.runId) {
    if (s.cursor === 0) {
      const page = await tailSteps(s.runId);
      s.cursor = page.cursor;
      if (page.steps.length) { s.lastStepAt = Date.now(); s.quietSent = false; broadcastSteps(s, page.steps); }
    } else {
      const page = await stepsAfter(s.runId, s.cursor);
      s.cursor = page.cursor;
      if (page.steps.length) { s.lastStepAt = Date.now(); s.quietSent = false; broadcastSteps(s, page.steps); }
    }
  }

  // Nothing is happening, and saying so is the honest alternative to animating.
  if (!s.quietSent && Date.now() - s.lastStepAt > QUIET_AFTER_MS) {
    s.quietSent = true;
    broadcast(s, { t: "quiet" });
  }

  // Is it time to open.
  const app = await lookupApp(slug);
  if (!app) return;
  const action = decideEdge({
    buildLive: !!app.run_url,
    status: app.status,
    deploy: app.deploy,
    hasWeb: app.has_web,
    now: Date.now(),
  });
  if ("serve" in action && app.run_url && !s.opened) {
    if (await answers(app.run_url)) {
      s.opened = true;
      broadcast(s, { t: "open" });
      // The page reloads itself behind the opening; the stream has nothing left
      // to say and holding it open would keep a poller alive per abandoned tab.
      setTimeout(() => stop(slug), 5_000);
    }
    return;
  }
  if ("page" in action && (action.page === "failed" || action.page === "stalled")) {
    broadcast(s, { t: "broke", how: action.page, reason: action.page === "failed" ? action.reason : null });
  }
}

function stop(slug: string): void {
  const s = sessions.get(slug);
  if (!s) return;
  clearInterval(s.timer);
  for (const w of [...s.watchers]) drop(s, w);
  sessions.delete(slug);
}

function sessionFor(slug: string): Session {
  const existing = sessions.get(slug);
  if (existing) return existing;
  const s: Session = {
    watchers: new Set(),
    runId: null,
    cursor: 0,
    lastStepAt: Date.now(),
    quietSent: false,
    opened: false,
    timer: setInterval(() => { void tick(slug).catch(() => { /* a bad tick must not kill the room */ }); }, TICK_MS),
  };
  // Nothing else holds this interval; without unref a proxy with one abandoned
  // room would never be able to exit.
  s.timer.unref?.();
  sessions.set(slug, s);
  return s;
}

/** How many people are in this room right now. Includes the caller. */
export function watching(slug: string): number {
  return sessions.get(slug)?.watchers.size ?? 0;
}

/**
 * Attach one watcher to a room.
 *
 * Server-sent events rather than a WebSocket: the traffic is one-way, it is a
 * handful of small messages a second, and it survives an ordinary HTTP proxy
 * without an upgrade negotiation. The room has nothing to say upstream.
 */
export function serveRoomEvents(req: IncomingMessage, res: ServerResponse, opts: { slug: string; owner: boolean }): void {
  const { slug, owner } = opts;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const s = sessionFor(slug);
  const w: Watcher = { res, owner };
  s.watchers.add(w);

  send(w, { t: "hello", owner, watching: s.watchers.size });
  broadcast(s, { t: "watching", n: s.watchers.size });

  const bye = () => {
    if (!s.watchers.has(w)) return;
    s.watchers.delete(w);
    broadcast(s, { t: "watching", n: s.watchers.size });
    if (!s.watchers.size) stop(slug);
  };
  req.on("close", bye);
  req.on("error", bye);

  // First tick immediately, so a room does not open on an empty floor.
  void tick(slug).catch(() => { /* ignore */ });
}

/** Test seam: drop every session. */
export function resetRooms(): void {
  for (const slug of [...sessions.keys()]) stop(slug);
}
