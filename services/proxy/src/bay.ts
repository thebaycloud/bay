import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config";
import { mintIdToken } from "./idtoken";
import { isCloudRunTarget } from "./upstream";

/**
 * Analytics, served first-party, from the app's own address.
 *
 * THIS IS THE LOAD-BEARING DECISION OF THE WHOLE FEATURE.
 *
 * A third-party script tag — `<script src="https://umami.example/script.js">` —
 * is blocked by every content blocker by hostname, needs CORS to post anywhere,
 * and tells the visitor about a vendor they have never heard of and have no
 * relationship with. None of those are edge cases; the first one alone loses
 * something like a quarter of the traffic on a technical audience, silently,
 * and the app's owner would never find out.
 *
 * Proxied through the app's own origin it is same-origin, unblockable by
 * hostname, and never leaves the address the visitor already chose to trust.
 * It also means the umami service itself needs no public ingress at all: the
 * only route to it from the internet is through here.
 *
 *   GET  /_bay/a.js         → umami's script.js
 *   POST /_bay/api/send     → umami's /api/send   (what the tracker calls)
 *   POST /_bay/a            → the same, under the shorter name
 *
 * `/_bay` rather than `/_analytics` or `/umami`: a path that names the vendor is
 * a blocklist entry waiting to happen, and a path an app is plausibly already
 * using is a route we would be stealing. Nothing in this repo answers /_bay.
 */

/**
 * The invoker credential for the umami service, in the header that is NOT
 * `Authorization`. Umami runs `--no-allow-unauthenticated`, so Cloud Run wants
 * a Google ID token; `X-Serverless-Authorization` is where it belongs, and
 * forward.ts documents at length what happens when an invoker token is put in
 * `Authorization` instead. Empty for a local umami, which has no metadata
 * server to mint one from.
 */
async function invoker(): Promise<Record<string, string>> {
  const base = config.umamiUrl;
  if (!isCloudRunTarget(base)) return {};
  return { "X-Serverless-Authorization": `Bearer ${await mintIdToken(new URL(base).origin)}` };
}

/** The one thing an app row has to supply for any of this to happen. */
export interface BaySite {
  websiteId: string;
}

const SCRIPT = "/_bay/a.js";
const SEND = ["/_bay/a", "/_bay/api/send"];

/**
 * Whether this URL is ours to answer.
 *
 * Path only — the query string is not part of the match — and exact, not a
 * prefix: `/_bay/` is a namespace we are claiming from every hosted app at
 * once, and claiming more of it than we serve would break an app that happens
 * to answer there for reasons of its own.
 */
export function isBayPath(url: string | undefined): boolean {
  const p = (url ?? "").split(/[?#]/)[0];
  return p === SCRIPT || SEND.includes(p);
}

/** In-process copy of the tracker, so a page view is not an origin fetch. */
let script: { body: Buffer; at: number } | null = null;
const SCRIPT_TTL_MS = 60 * 60 * 1000;

async function serveScript(res: ServerResponse): Promise<void> {
  if (!script || Date.now() - script.at > SCRIPT_TTL_MS) {
    const r = await fetch(`${config.umamiUrl}/script.js`, {
      headers: await invoker(),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`umami script.js ${r.status}`);
    script = { body: Buffer.from(await r.arrayBuffer()), at: Date.now() };
  }
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    // A day, and public. It is the same two kilobytes for every app and every
    // visitor, and it changes when umami is upgraded — which is not something
    // that needs to reach a browser inside the hour.
    "Cache-Control": "public, max-age=86400",
    "Content-Length": String(script.body.length),
  });
  res.end(script.body);
}

/** The visitor's address, as the load balancer already worked it out. */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "";
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // A collection endpoint on the open internet with no bound on the body is a
    // way to make this process hold arbitrary memory for free. A tracker beacon
    // is a few hundred bytes.
    if (size > limit) throw new Error("beacon too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveSend(req: IncomingMessage, res: ServerResponse, site: BaySite): Promise<void> {
  const raw = await readBody(req);
  let body: { type?: string; payload?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return;
  }

  // THE WEBSITE ID IS OURS, NOT THE BODY'S.
  //
  // This request arrived on `<slug>.supersonic.cv`, and the slug is what decided
  // which site it counts toward. Trusting the id in the payload would mean
  // anybody could post events into any other app's analytics from their own
  // page — or from curl — and the owner would see visitors that were never
  // theirs, with no way to tell. The tracker sends the right one anyway; this
  // makes it not matter.
  const payload = { ...(body.payload ?? {}), website: site.websiteId };

  const upstream = await fetch(`${config.umamiUrl}/api/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await invoker()),
      // Umami resolves browser, OS and device from the User-Agent and country
      // from the address, so without these two every visitor is an unknown
      // device from nowhere. Nothing else of the visitor's is forwarded — no
      // cookies, no Referer, no Accept-Language — because nothing else is read.
      "User-Agent": String(req.headers["user-agent"] ?? ""),
      "X-Forwarded-For": clientIp(req),
      // Umami hands the tracker an opaque token and expects it back; it is what
      // lets the same visitor's second page view join the first one's session.
      ...(req.headers["x-umami-cache"] ? { "x-umami-cache": String(req.headers["x-umami-cache"]) } : {}),
    },
    body: JSON.stringify({ type: body.type ?? "event", payload }),
    signal: AbortSignal.timeout(5000),
  });

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "text/plain",
    // Never cached, never stored. It is a beacon.
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/**
 * Answer a `/_bay` request, or say we did not.
 *
 * Returns false when there is nothing to serve — analytics not configured, or
 * this app has no site — and the caller goes on to forward the request to the
 * app as it would any other path. That is deliberate: an app that answers
 * /_bay/a.js for reasons of its own keeps working on a platform where analytics
 * is switched off, and a 404 minted here would be a route we claimed and then
 * did not serve.
 *
 * Never throws. A failure to collect one beacon is not a failure of the page
 * that sent it, and a hosted app must not start returning 500s because umami
 * is having a bad afternoon.
 */
export async function serveBay(
  req: IncomingMessage,
  res: ServerResponse,
  site: BaySite | null
): Promise<boolean> {
  if (!config.umamiUrl || !site?.websiteId || !isBayPath(req.url)) return false;
  const path = (req.url ?? "").split(/[?#]/)[0];
  try {
    if (path === SCRIPT && (req.method === "GET" || req.method === "HEAD")) {
      await serveScript(res);
      return true;
    }
    if (SEND.includes(path) && req.method === "POST") {
      await serveSend(req, res, site);
      return true;
    }
    res.writeHead(405).end();
    return true;
  } catch (e) {
    console.error("bay:", e instanceof Error ? e.message : e);
    // 204, not 5xx. The browser is not going to retry a beacon and there is
    // nothing for it to do with the news; the tracker's own error handling is
    // to carry on, which is the right behaviour for a page that is about
    // somebody else's product entirely.
    if (!res.headersSent) res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return true;
  }
}
