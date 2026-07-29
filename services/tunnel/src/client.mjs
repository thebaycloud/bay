/**
 * Tunnel client — the piece the CLI runs on the user's machine.
 * Opens a WS to the edge, registers its slug (with the CLI token), and proxies
 * each forwarded request to the local dev server. The Host is rewritten so the
 * dev server doesn't reject the request.
 *
 * Usage: node client.mjs <slug> <host:port-of-dev-server> [edge-ws-url] [token]
 */
import http from "node:http";
import WebSocket from "ws";

const SLUG = process.argv[2];
const [THOST, TPORT] = (process.argv[3] || "127.0.0.1:5173").split(":");
const EDGE = process.argv[4] || process.env.TUNNEL_EDGE || "ws://127.0.0.1:7099/_tunnel";
const TOKEN = process.argv[5] || process.env.SUPERSONIC_TOKEN || "";

function connect() {
  const ws = new WebSocket(`${EDGE}?slug=${encodeURIComponent(SLUG)}&token=${encodeURIComponent(TOKEN)}`);
  ws.on("open", () => console.log("tunnel open:", SLUG, "→", `${THOST}:${TPORT}`));
  ws.on("error", (e) => console.log("tunnel ws error:", e.message));
  ws.on("close", (code) => { console.log("tunnel closed", code); if (code !== 1008) setTimeout(connect, 1000); });
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== "req") return;
    const headers = { ...msg.headers, host: `${THOST}:${TPORT}` };
    const preq = http.request({ host: THOST, port: Number(TPORT), method: msg.method, path: msg.url, headers }, (pres) => {
      const chunks = [];
      pres.on("data", (c) => chunks.push(c));
      pres.on("end", () => {
        const h = { ...pres.headers };
        delete h["transfer-encoding"]; delete h["content-encoding"]; delete h["content-length"];
        ws.send(JSON.stringify({ type: "res", id: msg.id, status: pres.statusCode, headers: h, body: Buffer.concat(chunks).toString("base64") }));
      });
    });
    preq.on("error", (e) => ws.send(JSON.stringify({ type: "res", id: msg.id, status: 502, headers: {}, body: Buffer.from("proxy err: " + e.message).toString("base64") })));
    if (msg.body) preq.write(Buffer.from(msg.body, "base64"));
    preq.end();
  });
}
connect();
