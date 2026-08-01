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
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Where the dev servers of the common stacks land. Only ever used as a fallback, and
// only for a port that was NOT already listening before the command started — the
// preview must not end up pointing at some unrelated server the user has running.
const DEV_PORTS = [3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

/**
 * The port a dev server announces in its own output.
 *
 * Loopback hosts, or an explicit "port N". Deliberately not any `host:port`: dev
 * servers log upstream URLs too, and tunnelling to whatever a startup banner mentioned
 * would be worse than not tunnelling at all.
 */
function portFromOutput(text) {
  const s = String(text);
  const m =
    s.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i) ||
    s.match(/\bport[:=\s]+(\d{2,5})\b/i);
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Is anything accepting connections on this port right now? */
function isListening(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Which of `ports` are busy — snapshotted before we start anything of our own. */
async function listeningPorts(ports) {
  const hits = await Promise.all(ports.map(async (p) => ((await isListening(p)) ? p : null)));
  return new Set(hits.filter((p) => p !== null));
}

/**
 * Which package manager this project uses, by the lockfile it committed.
 *
 * The live preview used to run `npm install` unconditionally. Deploying the
 * FastAPI template on 1 Aug, that dropped a `package-lock.json` into a
 * repository that uses `bun.lock` — a lockfile the project does not use, in a
 * checkout the user had not asked us to touch, two minutes after the command had
 * already returned. `git status` went from clean to dirty with no output saying
 * so.
 *
 * The lockfile is the project stating its answer. Reading it costs nothing.
 */
function packageManager(cwd) {
  const has = (f) => { try { return fs.existsSync(path.join(cwd, f)); } catch { return false; } };
  if (has("bun.lock") || has("bun.lockb")) return { name: "bun", install: "bun install", dev: "bun run dev" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", install: "pnpm install", dev: "pnpm run dev" };
  if (has("yarn.lock")) return { name: "yarn", install: "yarn install", dev: "yarn run dev" };
  return { name: "npm", install: "npm install --no-audit --no-fund", dev: "npm run dev" };
}

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
        const pm = packageManager(cwd);
        cmd = needInstall ? `${pm.install} && ${pm.dev}` : pm.dev;
      }
    } catch { /* not a node project */ }
  }
  if (!cmd) return Promise.resolve({ proc: null, port: null });

  return new Promise((resolve) => {
    // A fresh install can take a while before the dev server binds — don't give up early.
    const graceMs = needInstall ? 120000 : 20000;
    // Snapshot the usual ports before starting, so one that appears afterwards is ours.
    const takenBefore = devPort ? Promise.resolve(new Set()) : listeningPorts(DEV_PORTS);
    const proc = spawn(cmd, { cwd, env: process.env, shell: true });
    let done = false;
    let poll = null;
    const finish = (port) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      resolve({ proc, port });
    };
    const scan = (buf) => {
      if (done || devPort) return;
      const port = portFromOutput(buf);
      if (port) finish(port);
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    // With an explicit port, give the server a moment to bind, then go.
    if (devPort) {
      setTimeout(() => finish(devPort), 1500);
    } else {
      // Reading the output is the fast path, but plenty of servers never print a
      // usable line ("Listening on port 8000", or nothing at all) and the deploy then
      // came up with no preview at all while looking like the stack was unsupported.
      // So also watch for a port that starts listening after the command was spawned.
      let probing = false;
      poll = setInterval(async () => {
        if (done || probing) return;
        probing = true;
        try {
          const taken = await takenBefore;
          for (const p of DEV_PORTS) {
            if (taken.has(p)) continue;
            if (await isListening(p)) { finish(p); return; }
          }
        } finally { probing = false; }
      }, 500);
    }
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
    preq.on("error", (e) => {
      ws.send(JSON.stringify({ type: "res", id: msg.id, status: 502, headers: {}, body: Buffer.from("dev server: " + e.message).toString("base64") }));
      // The dev server is gone (stopped, crashed, restarting on a port change). Since
      // the proxy prefers an open tunnel over the published build, holding this one
      // open would keep serving errors for an app that has a perfectly good release
      // behind it. Dropping it hands the URL straight back to that release.
      if (e.code === "ECONNREFUSED") { try { ws.close(1000, "dev server gone"); } catch { /* already closing */ } }
    });
    if (msg.body) preq.write(Buffer.from(msg.body, "base64"));
    preq.end();
  });
  return ws;
}

module.exports = { startDevServer, openTunnel, portFromOutput, isListening, listeningPorts, packageManager, DEV_PORTS };
