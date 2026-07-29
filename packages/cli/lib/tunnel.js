"use strict";
/*
 * Instant-live tunnel for `supersonic deploy --tunnel`.
 *
 * Reserve a slug → print the URL → start the local dev server → hold a WebSocket
 * open to the proxy so <slug>.supersonic.cv serves that dev server immediately,
 * while the real build runs on the server. When the build lands the proxy serves
 * it on the same URL and we tear the tunnel down. Uses the global WebSocket in
 * Node 20+ — no dependency.
 */
const http = require("http");
const { spawn } = require("child_process");

/** Start `npm run dev` and resolve once it prints the local URL (or times out). */
function startDevServer(cwd) {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["run", "dev"], { cwd, env: process.env });
    let done = false;
    const scan = (buf) => {
      if (done) return;
      const m = buf.toString().match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/i);
      if (m) { done = true; resolve({ proc, port: Number(m[1]) }); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    setTimeout(() => { if (!done) { done = true; resolve({ proc, port: null }); } }, 20000);
  });
}

/** Open the tunnel: forward every request the proxy sends to the local dev server. */
function openTunnel({ wsUrl, slug, token, devHost, devPort, onOpen, onClose }) {
  const ws = new WebSocket(`${wsUrl}?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`);
  ws.addEventListener("open", () => onOpen && onOpen());
  ws.addEventListener("close", (e) => onClose && onClose(e.code));
  ws.addEventListener("error", () => {});
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== "req") return;
    const headers = Object.assign({}, msg.headers, { host: `${devHost}:${devPort}` });
    const preq = http.request({ host: devHost, port: devPort, method: msg.method, path: msg.url, headers }, (pres) => {
      const chunks = [];
      pres.on("data", (c) => chunks.push(c));
      pres.on("end", () => {
        const h = Object.assign({}, pres.headers);
        delete h["transfer-encoding"]; delete h["content-encoding"]; delete h["content-length"];
        ws.send(JSON.stringify({ type: "res", id: msg.id, status: pres.statusCode, headers: h, body: Buffer.concat(chunks).toString("base64") }));
      });
    });
    preq.on("error", (e) => ws.send(JSON.stringify({ type: "res", id: msg.id, status: 502, headers: {}, body: Buffer.from("dev server: " + e.message).toString("base64") })));
    if (msg.body) preq.write(Buffer.from(msg.body, "base64"));
    preq.end();
  });
  return ws;
}

module.exports = { startDevServer, openTunnel };
