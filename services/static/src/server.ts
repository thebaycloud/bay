/**
 * Supersonic static server.
 *
 * One Cloud Run service in front of every static app we host. The slug comes from
 * the Host header, the live release from a pointer object, the bytes from GCS.
 *
 * Being one service for all tenants is the whole point — it is why a static deploy
 * skips building an image and rolling out a revision — and it is also why the path
 * handling in ./paths.ts is deny-by-default.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Storage } from "@google-cloud/storage";
import { slugFor, objectKey, looksLikeFile } from "./paths.ts";
import { contentType, cacheControl } from "./headers.ts";
import { PointerCache, isReleaseId } from "./pointer.ts";

const PORT = Number(process.env.PORT ?? 8080);
const BUCKET = process.env.ASSETS_BUCKET ?? "supersonic-static-assets";
const ROOT_DOMAIN = process.env.ROOT_DOMAIN ?? "supersonic.cv";

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

const pointers = new PointerCache({
  async read(slug: string) {
    try {
      const [buf] = await bucket.file(`${slug}/current`).download();
      const value = buf.toString("utf8").trim();
      return isReleaseId(value) ? value : null;
    } catch {
      return null; // absent, or unreadable — both mean "no live release"
    }
  },
});

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message + "\n");
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method not allowed");

  const slug = slugFor(req.headers["x-supersonic-slug"], req.headers.host, ROOT_DOMAIN);
  if (!slug) return fail(res, 404, "not found");

  const release = await pointers.get(slug);
  if (!release) return fail(res, 404, "not found");

  const key = objectKey(req.url ?? "/");
  if (key === null) return fail(res, 400, "bad request");

  const prefix = `${slug}/r/${release}/`;
  const wanted = key === "" ? "index.html" : key;

  let file = bucket.file(prefix + wanted);
  let servedKey = wanted;
  let [exists] = await file.exists();

  if (!exists) {
    // A route the client-side router owns has no extension and falls back to the
    // shell. A missing file *with* an extension is a real 404 — answering with
    // index.html there hides broken builds behind a page that looks fine.
    if (looksLikeFile(wanted)) return fail(res, 404, "not found");
    servedKey = "index.html";
    file = bucket.file(prefix + servedKey);
    [exists] = await file.exists();
    if (!exists) return fail(res, 404, "not found");
  }

  res.writeHead(200, {
    "content-type": contentType(servedKey),
    "cache-control": cacheControl(servedKey),
    "x-supersonic-release": release,
  });
  if (req.method === "HEAD") return void res.end();

  const stream = file.createReadStream();
  stream.on("error", () => {
    // Headers are already out, so the only honest signal left is an aborted body.
    res.destroy();
  });
  stream.pipe(res);
}

createServer((req, res) => {
  serve(req, res).catch((e) => {
    console.error("static serve failed", e);
    if (!res.headersSent) fail(res, 503, "temporarily unavailable");
    else res.destroy();
  });
}).listen(PORT, () => console.log(`static server on :${PORT} bucket=${BUCKET} root=${ROOT_DOMAIN}`));
