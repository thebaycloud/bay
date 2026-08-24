import type { IncomingMessage, ServerResponse } from "node:http";
import { allow } from "./publish";

/**
 * What the app's own pages report, from the browser.
 *
 * The only stream we cannot see from the outside. Everything else — stdout, the
 * request, the deploy — happens on our side of the wire; a `TypeError` in
 * somebody's checkout page happens on a stranger's laptop and is invisible unless
 * the page tells us.
 *
 * THE SLUG COMES FROM THE HOST, NEVER FROM THE PAYLOAD.
 *
 * This is the whole security design and it is worth stating plainly. The endpoint
 * is served BY THE PROXY, on the app's own origin, so by the time this runs the
 * proxy has already resolved which app the request is for — the same resolution
 * that decides which container to forward to. A page cannot claim to be another
 * app any more than it can serve another app's traffic. There is no slug in the
 * body to validate, and therefore no way to get it wrong.
 *
 * It also means no CORS: the collector posts to its own origin, so there is no
 * preflight, no `Access-Control-Allow-Origin` to widen by accident, and no
 * credentials involved at any point. This endpoint does not know or care who the
 * visitor is.
 *
 * WHAT IT REFUSES, BEFORE READING ANYTHING
 *
 * It is a public, unauthenticated endpoint on every hosted app. Anyone can POST
 * to it, `Origin` is forged trivially outside a browser, and the cost of a log
 * line is real. So the bound is not "who is calling" — that question has no
 * answer here — but "how much can this possibly cost", and it is enforced before
 * a body is read rather than after it is parsed.
 */

/** The most a page may send in one go. Refused by length, before reading. */
const MAX_BODY = 16 * 1024;

/** Field caps. A stack is useful; a novel is somebody probing the endpoint. */
const MAX_MSG = 1000;
const MAX_STACK = 2000;
const MAX_URL = 300;
const MAX_EVENTS = 20;

const ON = process.env.PUBLISH_BROWSER_LOGS !== "0";

/** Whether pages should carry the collector at all. */
export function collectingBrowserLogs(): boolean {
  return ON;
}

interface Event {
  msg?: unknown;
  stack?: unknown;
  url?: unknown;
  line?: unknown;
  col?: unknown;
  level?: unknown;
}

const cut = (v: unknown, n: number): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

const int = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.trunc(n) : undefined;
};

/** The page, without its query string — which carries tokens and addresses. */
export function pageOf(url: unknown): string | undefined {
  const s = cut(url, MAX_URL + 200);
  if (!s) return undefined;
  const q = s.indexOf("?");
  return cut(q === -1 ? s : s.slice(0, q), MAX_URL);
}

/** One event, reduced to what we are willing to keep. */
export function clean(e: Event): Record<string, unknown> | null {
  const msg = cut(e.msg, MAX_MSG);
  if (!msg) return null;
  const level = e.level === "warn" ? "warn" : "error";
  return {
    severity: level === "warn" ? "WARNING" : "ERROR",
    source: "browser",
    // The one stream that IS a side, and says so. A request cannot be placed on a
    // side and does not claim one; this can and does.
    face: "frontend",
    level,
    msg,
    ...(pageOf(e.url) ? { url: pageOf(e.url) } : {}),
    ...(int(e.line) !== undefined ? { line: int(e.line) } : {}),
    ...(int(e.col) !== undefined ? { col: int(e.col) } : {}),
    ...(cut(e.stack, MAX_STACK) ? { stack: cut(e.stack, MAX_STACK) } : {}),
  };
}

/** Read at most MAX_BODY, and hang up on anything longer. */
function readCapped(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Stop reading and stop the sender. Buffering the rest to reject it
        // politely is doing the work an attacker asked for.
        req.destroy();
        resolve(null);
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * Handle `POST /_log` for one app. Returns true when it answered.
 *
 * Only POST is intercepted. A tenant app with its own `/_log` page keeps it for
 * every other method, which makes the collision surface as small as reserving a
 * path can be.
 */
export async function handleBrowserLog(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<boolean> {
  if (req.method !== "POST") return false;
  if ((req.url ?? "").split("?")[0] !== "/_log") return false;

  // 204 whatever happens next. The page is not entitled to know whether we kept
  // its report, and an error body would be one more thing to probe.
  const done = () => {
    res.writeHead(204, { "Cache-Control": "no-store", "Content-Length": "0" });
    res.end();
    return true;
  };

  if (!ON || !slug) return done();

  const body = await readCapped(req);
  if (!body) return done();

  let events: Event[];
  try {
    const parsed = JSON.parse(body) as { events?: unknown };
    if (!Array.isArray(parsed?.events)) return done();
    events = parsed.events.slice(0, MAX_EVENTS) as Event[];
  } catch {
    return done();
  }

  for (const e of events) {
    // The same per-app ceiling the edge lines use, so a page in an error loop
    // cannot spend an app's ingest allowance — and cannot spend anybody else's,
    // because the budget is per app.
    const { ok, dropped } = allow(`browser:${slug}`);
    if (!ok) break;
    const line = clean(e);
    if (!line) continue;
    try {
      if (dropped > 0) {
        process.stdout.write(
          `${JSON.stringify({
            severity: "WARNING",
            slug,
            source: "browser",
            face: "frontend",
            msg: `${dropped} browser ${dropped === 1 ? "event was" : "events were"} dropped — this page is reporting faster than we keep`,
          })}\n`,
        );
      }
      process.stdout.write(`${JSON.stringify({ slug, ...line })}\n`);
    } catch {
      // stdout is gone. Nothing to recover, and a log line must never be the
      // reason a response is not sent.
    }
  }
  return done();
}

/**
 * The collector, injected into every HTML page beside the badge.
 *
 * Three sources, and the third is the one to be careful with. `onerror` and
 * `unhandledrejection` are events. `console.error` is somebody else's function
 * that we are wrapping, on their page, so: the original is called first and
 * always, a re-entrancy guard stops our own failure from recursing through it,
 * and nothing here throws into their call.
 *
 * Batched and sent with `sendBeacon`, which survives the page being closed —
 * which is exactly when the interesting error happened.
 *
 * A PER-PAGE CAP, not only a per-app one. An exception inside a render loop fires
 * thousands of times a second; the server-side ceiling would hold, but the page
 * would spend its own main thread packing events nobody will keep.
 */
export function collectorScript(): string {
  if (!ON) return "";
  return String.raw`
var Q=[],SENT=0,MAX=20,BUSY=0;
function push(level,msg,url,line,col,stack){
  if(SENT>=MAX||!msg)return;
  SENT++;
  Q.push({level:level,msg:String(msg).slice(0,1000),url:url||location.href,
          line:line,col:col,stack:stack?String(stack).slice(0,2000):undefined});
  if(Q.length>=5)flush();
}
function flush(){
  if(!Q.length)return;
  var body=JSON.stringify({events:Q}); Q=[];
  try{
    if(navigator.sendBeacon){navigator.sendBeacon('/_log',new Blob([body],{type:'application/json'}));}
    else{fetch('/_log',{method:'POST',body:body,keepalive:true,headers:{'Content-Type':'application/json'}}).catch(function(){});}
  }catch(e){}
}
window.addEventListener('error',function(e){
  push('error', e && e.message, e && e.filename, e && e.lineno, e && e.colno, e && e.error && e.error.stack);
});
window.addEventListener('unhandledrejection',function(e){
  var r=e&&e.reason;
  push('error', (r&&r.message)||String(r), location.href, undefined, undefined, r&&r.stack);
});
// Their function, called first and always. The guard is what stops a failure in
// here from recursing through the thing it is wrapping.
try{
  var CE=console.error;
  console.error=function(){
    try{CE.apply(console,arguments);}catch(e){}
    if(BUSY)return; BUSY=1;
    try{
      var parts=[];
      for(var i=0;i<arguments.length&&i<4;i++){
        var a=arguments[i];
        parts.push(a&&a.message?a.message:(typeof a==='string'?a:(function(){try{return JSON.stringify(a);}catch(e){return String(a);}})()));
      }
      var first=arguments[0];
      push('error', parts.join(' '), location.href, undefined, undefined, first&&first.stack);
    }catch(e){}
    BUSY=0;
  };
}catch(e){}
setInterval(flush,5000);
addEventListener('pagehide',flush);
`;
}
