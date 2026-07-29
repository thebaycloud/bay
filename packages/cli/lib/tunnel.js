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
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/**
 * Get a running dev server to tunnel. The command is the caller's intelligence,
 * not ours — a coding agent knows its own stack (FastAPI → uvicorn, Flask → flask
 * run, Rails → bin/rails s, Go → go run, Node → npm run dev). Resolution order:
 *   1. `devPort`  — the agent already started it; just use the port.
 *   2. `devCmd`   — the agent gave the command; run it and use `devPort` (or the
 *                   first port it prints).
 *   3. Node `dev` script — the one case we can start ourselves without being told.
 * Returns {proc,port}. A null port means we couldn't get one — the caller decides,
 * but the intended flow is that the agent always supplies a dev server.
 */
function startDevServer(cwd, opts = {}) {
  const devPort = opts.devPort ? Number(opts.devPort) : null;
  let cmd = opts.devCmd || null;

  if (devPort && !cmd) return Promise.resolve({ proc: null, port: devPort });

  let needInstall = false;
  if (!cmd) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      if (pkg.scripts && pkg.scripts.dev) {
        // A fresh checkout has no node_modules, so `npm run dev` can't find vite/
        // next/etc. Install first so the live preview actually comes up. The URL is
        // already live (deploying page) meanwhile, so this only delays the preview.
        needInstall = !fs.existsSync(path.join(cwd, "node_modules"));
        cmd = needInstall ? "npm install --no-audit --no-fund && npm run dev" : "npm run dev";
      }
    } catch { /* not a node project */ }
  }
  if (!cmd) return Promise.resolve({ proc: null, port: null });

  return new Promise((resolve) => {
    // A fresh install can take a while before the dev server binds — don't give up early.
    const graceMs = needInstall ? 120000 : 20000;
    const proc = spawn(cmd, { cwd, env: process.env, shell: true });
    let done = false;
    const finish = (port) => { if (!done) { done = true; resolve({ proc, port }); } };
    const scan = (buf) => {
      if (done || devPort) return;
      const m = buf.toString().match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i);
      if (m) finish(Number(m[1]));
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    // With an explicit port, give the server a moment to bind, then go.
    if (devPort) setTimeout(() => finish(devPort), 1500);
    setTimeout(() => finish(devPort || null), graceMs);
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
