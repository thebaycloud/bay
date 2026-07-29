/**
 * Instant-live tunnels.
 *
 * A deploy reserves its slug up front, so `<slug>.supersonic.cv` exists before
 * anything is built. While it is still building, the CLI holds a WebSocket open to
 * this proxy and we forward requests for that slug straight to the user's running
 * dev server. The moment the build goes live (the app gains a run_url / status
 * "live") normal routing takes over — same URL, no client involvement. No extra
 * DNS: the proxy already fronts every `*.supersonic.cv`.
 *
 * Registration is authorised: the CLI presents its bearer token and we require it
 * to own the slug.
 *
 * State is per-instance (in memory). The proxy runs at min-instances=1; if it is
 * ever scaled out, a request can land on an instance that doesn't hold the tunnel,
 * so tunnel routing needs sticky sessions or shared state at that point.
 */
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { lookupApp, userIdFromToken } from "./registry";

const tunnels = new Map<string, WebSocket>();          // slug -> live CLI socket
const pending = new Map<string, ServerResponse>();     // reqId -> awaiting response

export function hasTunnel(slug: string): boolean {
  const ws = tunnels.get(slug);
  return !!ws && ws.readyState === ws.OPEN;
}

/** Forward one HTTP request to the slug's tunnel and relay the reply. */
export function forwardToTunnel(req: IncomingMessage, res: ServerResponse, slug: string): void {
  const ws = tunnels.get(slug);
  if (!ws || ws.readyState !== ws.OPEN) { res.writeHead(502).end("tunnel gone"); return; }
  const id = randomUUID();
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    pending.set(id, res);
    ws.send(JSON.stringify({ type: "req", id, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("base64") }));
    setTimeout(() => { if (pending.delete(id)) { try { res.writeHead(504).end("tunnel timeout"); } catch { /* already sent */ } } }, 20000);
  });
}

/** Attach the tunnel WebSocket endpoint (/_tunnel) to the proxy's HTTP server. */
export function attachTunnel(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/_tunnel" });
  wss.on("connection", async (ws, req) => {
    const u = new URL(req.url ?? "", "http://x");
    const slug = u.searchParams.get("slug") ?? "";
    const token = u.searchParams.get("token") ?? "";
    const uid = await userIdFromToken(token);
    const app = slug ? await lookupApp(slug) : null;
    if (!uid || !app || app.owner_id !== uid) { ws.close(1008, "unauthorized"); return; }
    tunnels.set(slug, ws);
    console.log("tunnel UP:", slug);
    ws.on("message", (data) => {
      let msg: { type?: string; id?: string; status?: number; headers?: Record<string, string>; body?: string };
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type !== "res" || !msg.id) return;
      const res = pending.get(msg.id); if (!res) return; pending.delete(msg.id);
      res.writeHead(msg.status ?? 502, { ...msg.headers, "x-served-by": "tunnel" });
      res.end(Buffer.from(msg.body ?? "", "base64"));
    });
    ws.on("close", () => { if (tunnels.get(slug) === ws) tunnels.delete(slug); console.log("tunnel DOWN:", slug); });
  });
}
