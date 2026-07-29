/**
 * Tunnel edge — the URL-first / instant-live front door.
 *
 * A deploy reserves a slug up front, so `<slug>.supersonic.cv` exists immediately.
 * Until the real build is published, this edge serves that hostname from a tunnel
 * the CLI holds open to the user's running dev server. The moment the build lands
 * (its release becomes reachable) the edge flips to the built output — the same
 * pointer-flip the static server already relies on, so the URL never changes.
 *
 * In production this collapses into `services/proxy` (which already resolves
 * slug→app behind *.supersonic.cv). It lives standalone here so the tunnel can be
 * built, run and tested on its own first.
 *
 * Registration and flip are gated by a bearer token the control plane hands the
 * CLI; the edge asks the control plane whether that token owns the slug.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 7099);
// Where to verify "does this token own this slug?" — the control plane. In local
// runs point it at http://127.0.0.1:3000. Empty disables auth (dev only).
const CONTROL_PLANE = process.env.CONTROL_PLANE_URL || "";
// When a release is live we hand the hostname to the real static path instead of
// the tunnel: the upstream (shared static server) to proxy to.
const STATIC_UPSTREAM = process.env.STATIC_UPSTREAM || ""; // e.g. https://supersonic-static-...run.app

const tunnels = new Map();   // slug -> ws
const flipped = new Map();   // slug -> true (release is live, stop tunneling)
const pending = new Map();   // reqId -> http res

const slugOf = (req) => req.headers["x-slug"] || (req.headers.host || "").split(":")[0].split(".")[0];

/** Ask the control plane whether `token` owns `slug`. No control plane set = allow (dev). */
async function ownsSlug(slug, token) {
  if (!CONTROL_PLANE) return true;
  try {
    const r = await fetch(`${CONTROL_PLANE}/api/apps`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const { apps = [] } = await r.json();
    return apps.some((a) => a.slug === slug);
  } catch { return false; }
}

/** Hand off to the shared static server exactly as the proxy does: slug in a header. */
async function proxyStatic(slug, req, res) {
  try {
    const up = await fetch(`${STATIC_UPSTREAM}${req.url}`, { headers: { "x-supersonic-slug": slug } });
    const body = Buffer.from(await up.arrayBuffer());
    const h = Object.fromEntries(up.headers.entries());
    delete h["transfer-encoding"]; delete h["content-encoding"];
    res.writeHead(up.status, { ...h, "x-served-by": "static-flip" });
    res.end(body);
  } catch (e) { res.writeHead(502); res.end("static upstream error: " + e.message); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/_health") { res.writeHead(200); res.end("ok"); return; }

  // Control: mark a slug flipped once its release is live (called after publish).
  if (url.pathname === "/_flip") {
    const slug = url.searchParams.get("slug");
    const token = (req.headers.authorization || "").replace(/^bearer\s+/i, "");
    if (!(await ownsSlug(slug, token))) { res.writeHead(403); res.end("forbidden"); return; }
    flipped.set(slug, true);
    tunnels.get(slug)?.close();
    res.writeHead(200); res.end("flipped"); return;
  }

  const slug = slugOf(req);
  if (flipped.get(slug) && STATIC_UPSTREAM) return proxyStatic(slug, req, res);

  const ws = tunnels.get(slug);
  if (!ws || ws.readyState !== ws.OPEN) {
    // Reserved but nothing live yet and no tunnel open: a "building…" holding page.
    res.writeHead(200, { "content-type": "text/html", "x-served-by": "holding" });
    res.end(`<!doctype html><title>Deploying…</title><body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div>🚀 <b>${slug}</b> is deploying — this page goes live automatically.</div></body>`);
    return;
  }

  const id = randomUUID();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    pending.set(id, res);
    ws.send(JSON.stringify({ type: "req", id, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("base64") }));
    setTimeout(() => { if (pending.delete(id)) { try { res.writeHead(504); res.end("tunnel timeout"); } catch {} } }, 20000);
  });
});

const wss = new WebSocketServer({ server, path: "/_tunnel" });
wss.on("connection", async (ws, req) => {
  const u = new URL(req.url, "http://x");
  const slug = u.searchParams.get("slug");
  const token = u.searchParams.get("token") || "";
  if (!slug || !(await ownsSlug(slug, token))) { ws.close(1008, "unauthorized"); return; }
  tunnels.set(slug, ws);
  console.log("tunnel UP:", slug);
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== "res") return;
    const res = pending.get(msg.id); if (!res) return; pending.delete(msg.id);
    res.writeHead(msg.status, { ...msg.headers, "x-served-by": "tunnel" });
    res.end(Buffer.from(msg.body || "", "base64"));
  });
  ws.on("close", () => { if (tunnels.get(slug) === ws) tunnels.delete(slug); console.log("tunnel DOWN:", slug); });
});

server.listen(PORT, () => console.log(`tunnel edge on :${PORT} (auth ${CONTROL_PLANE ? "on" : "off"})`));
