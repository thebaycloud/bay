/**
 * Supersonic screenshot service.
 *
 * Takes one picture of an app after it deploys, so the dashboard can show a
 * thumbnail without loading the app itself. The dashboard used to render a live
 * iframe per card — measured at 3.4s for one app — which meant opening the
 * dashboard opened every app on it.
 *
 * Sealed by IAM: only the control plane may invoke this. It is a service that
 * navigates a real browser to a URL it is handed, which is an SSRF primitive if
 * anyone can call it; ./target.ts refuses anything that is not one of our hosts,
 * and Cloud Run's invoker policy is the outer fence.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { Storage } from "@google-cloud/storage";
import { buildTarget, objectPath } from "./target.ts";

const PORT = Number(process.env.PORT ?? 8080);
const BUCKET = process.env.ASSETS_BUCKET ?? "supersonic-static-assets";
const WIDTH = 1200;
const HEIGHT = 800;
const NAV_TIMEOUT_MS = 20_000;
/** A thumbnail is never worth holding a deploy, or a browser, for long. */
const TOTAL_TIMEOUT_MS = 30_000;

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

/**
 * One browser for the life of the process, a fresh context per shot.
 *
 * Launching Chromium costs seconds; contexts cost milliseconds and isolate
 * cookies, storage and cache between the apps we photograph — which matters,
 * because these are different customers' sites.
 */
let browserPromise: Promise<Browser> | null = null;
function browser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

async function capture(url: string, headers: Record<string, string>): Promise<Buffer> {
  const b = await browser();
  const ctx = await b.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    extraHTTPHeaders: headers,
    // Customer sites, not ours: never let one bleed into the next.
    ignoreHTTPSErrors: false,
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    // `load` rather than `networkidle`: a page with a websocket or a poll never
    // goes idle, and we would wait out the timeout on exactly the liveliest apps.
    const resp = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    // An error page is a picture of nothing anyone wants on a card, and storing it
    // makes a broken app look photographed rather than broken. The first backfill
    // caught two apps whose rows say live while the static server answers "not
    // found"; both got a white JPEG of that text. No picture is the better answer.
    const status = resp?.status() ?? 0;
    if (status >= 400 || status === 0) throw new Error(`app answered HTTP ${status || "nothing"}`);
    // A beat for fonts and above-the-fold images, which arrive after load.
    await page.waitForTimeout(1200);
    return await page.screenshot({ type: "jpeg", quality: 78, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  } finally {
    await ctx.close().catch(() => {});
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end("ok\n");
  }
  if (req.method !== "POST" || !req.url?.startsWith("/shot")) return json(res, 404, { error: "not found" });

  const raw = await new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 8192) req.destroy(); });
    req.on("end", () => resolve(s));
  });

  let body: { slug?: string; runUrl?: string; idToken?: string };
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "bad json" }); }

  const target = buildTarget(String(body.slug ?? ""), String(body.runUrl ?? ""), body.idToken ?? null);
  if (!target) return json(res, 400, { error: "refusing that target" });

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timed out")), TOTAL_TIMEOUT_MS));

  try {
    const png = await Promise.race([capture(target.url, target.headers), deadline]);
    const path = objectPath(target.slug);
    await bucket.file(path).save(png, {
      contentType: "image/jpeg",
      metadata: { cacheControl: "private, max-age=60" },
    });
    json(res, 200, { ok: true, path, bytes: png.length });
  } catch (e) {
    // A missing thumbnail is a cosmetic loss. It must never read as a failure that
    // anything upstream should act on.
    console.warn("shot failed", target.slug, e instanceof Error ? e.message : e);
    json(res, 200, { ok: false, reason: e instanceof Error ? e.message : String(e) });
  }
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("unhandled", e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
    else res.destroy();
  });
}).listen(PORT, () => console.log(`shot service on :${PORT} bucket=${BUCKET}`));
