/** Content types and caching for served objects. */

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json; charset=utf-8",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

export function contentType(key: string): string {
  const ext = (key.split(".").pop() ?? "").toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * Bundlers fingerprint assets — `main.4f3a91c2.js`, `index-BQq1nR7x.css`. Those
 * names change whenever the bytes change, so they are safe to cache forever.
 */
export function isFingerprinted(key: string): boolean {
  const last = key.split("/").pop() ?? "";
  return /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(last);
}

/**
 * `index.html` must never be cached: it is the file that names the current
 * asset bundle, so a stale copy pins a visitor to the previous deploy.
 */
export function cacheControl(key: string): string {
  if (key === "index.html" || key.endsWith("/index.html")) return "no-cache";
  if (isFingerprinted(key)) return "public, max-age=31536000, immutable";
  return "public, max-age=300";
}
