#!/usr/bin/env node
"use strict";

/*
 * supersonic — the deploy/debug surface for a coding agent.
 * Designed for agents, not humans: no interactive prompts, --json everywhere,
 * token auth (a human logs in once, the agent inherits the token), stdout=data,
 * stderr=logs, meaningful exit codes.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const CFG_DIR = path.join(os.homedir(), ".supersonic");
const CFG = path.join(CFG_DIR, "config.json");
const DEFAULT_URL = "https://app.supersonic.cv";

// ---------- output ----------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), cyan = c("36");
function info(s) { process.stderr.write(s + "\n"); }         // logs -> stderr
function print(s) { process.stdout.write(s + "\n"); }         // data -> stdout
function die(s, code = 1) { process.stderr.write(red("✗ ") + s + "\n"); process.exit(code); }
function json(o) { print(JSON.stringify(o, null, 2)); }

// ---------- config ----------
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } }
function saveCfg(cfg) { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); }
function baseUrl() { return (process.env.SUPERSONIC_URL || loadCfg().url || DEFAULT_URL).replace(/\/$/, ""); }
function token() { return process.env.SUPERSONIC_TOKEN || loadCfg().token || ""; }

// ---------- api ----------
async function api(pathname, { method = "GET", body, stream = false } = {}) {
  const tok = token();
  if (!tok) die("not authenticated — run: supersonic login");
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers: {
      Authorization: "Bearer " + tok,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) die("token invalid or expired — run: supersonic login");
  if (res.status === 403) die("forbidden — you don't own that app (or it doesn't exist)");
  if (stream) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error) die(data.error);
  if (data.error) info(dim("! " + data.error));
  return data;
}

// ---------- browser ----------
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

// ---------- commands ----------
async function login(args) {
  const url = (args.url || process.env.SUPERSONIC_URL || DEFAULT_URL).replace(/\/$/, "");
  // Explicit token (agents / CI / headless).
  if (args.token) {
    const ok = await validToken(url, String(args.token));
    if (!ok) return die("that token was rejected");
    saveCfg({ ...loadCfg(), url, token: String(args.token) });
    print(green("✓ ") + `logged in to ${url}`);
    process.exit(0);
  }
  await loopbackAuth(url, "/cli", "logged in");
}

// Create an account without leaving the terminal: opens the browser to sign up,
// then the web hands a token back and the agent can continue straight to deploy.
async function signup(args) {
  const url = (args.url || process.env.SUPERSONIC_URL || DEFAULT_URL).replace(/\/$/, "");
  await loopbackAuth(url, "/signup", "signed up");
}

// Browser loopback core: open the web at `startPath`, spin up a local server,
// and resolve with the CLI token the web hands back (or null on timeout). Does
// NOT save/print/exit — callers decide, so `deploy` can auto-auth and continue.
async function runLoopback(url, startPath) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const authUrl = `${url}${startPath}?port=${port}&name=${encodeURIComponent(os.hostname())}`;

  const done = new Promise((resolve) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const tok = u.searchParams.get("token") || "";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<body style='font-family:monospace;text-align:center;padding-top:20vh'><h2>&#10003; Supersonic CLI connected</h2><p>You can close this tab and return to your terminal.</p></body>");
      resolve(tok);
    });
  });

  info(`Opening browser…\n${dim(authUrl)}`);
  if (!openBrowser(authUrl)) info("Couldn't open a browser automatically — open the URL above manually.");

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), 300000); });
  const shutdown = () => { clearTimeout(timer); try { server.closeAllConnections?.(); } catch { /* noop */ } server.close(); };
  try {
    const tok = await Promise.race([done, timeout]);
    shutdown();
    return tok || null;
  } catch {
    shutdown();
    return null;
  }
}

// The `login`/`signup` wrapper: authenticate, then report and exit.
async function loopbackAuth(url, startPath, verb) {
  const tok = await runLoopback(url, startPath);
  if (!tok) return die(`${verb} timed out — try again, or use: supersonic login --token <token>`);
  saveCfg({ ...loadCfg(), url, token: tok });
  print(green("✓ ") + `${verb} to ${url}`);
  process.exit(0);
}

// Make `deploy` (and other primary commands) a single command: if there's no
// token, sign the human in via the browser once, then keep going.
async function ensureAuth() {
  if (token()) return;
  const url = baseUrl();
  info(dim("Not signed in — opening a browser to sign in (just this once)…"));
  const tok = await runLoopback(url, "/cli");
  if (!tok) die("sign-in timed out — run `supersonic login`, then `supersonic deploy` again");
  saveCfg({ ...loadCfg(), url, token: tok });
  info(green("✓ ") + "signed in — continuing…");
}

// Prove a token is valid by hitting any authorized endpoint (200 == good).
async function validToken(url, tok) {
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/api/apps", { headers: { Authorization: "Bearer " + tok } });
    return r.ok;
  } catch { return false; }
}

async function whoami(args) {
  const tok = token();
  if (!tok) { if (args.json) return json({ loggedIn: false }); print("not logged in"); return; }
  // Resolve the actual account (email + plan) so you can see WHO you are, not
  // just that a token exists.
  const res = await fetch(baseUrl() + "/api/account", { headers: { Authorization: "Bearer " + tok } });
  const acct = res.ok ? await res.json().catch(() => ({})) : {};
  if (args.json) return json({ loggedIn: res.ok, url: baseUrl(), email: acct.email || null, plan: acct.plan || null, source: process.env.SUPERSONIC_TOKEN ? "env" : "config" });
  if (!res.ok) return die("token invalid — run: supersonic login");
  const src = process.env.SUPERSONIC_TOKEN ? "env token" : "saved token";
  const who = acct.email ? " as " + acct.email : "";
  const plan = acct.plan ? ` · ${acct.plan}` : "";
  print(`logged in to ${baseUrl()}${who}${plan} (${src})`);
}

function logout() {
  try { const cfg = loadCfg(); delete cfg.token; delete cfg.email; saveCfg(cfg); } catch { /* ignore */ }
  print("logged out");
}

async function apps(args) {
  const d = await api("/api/apps");
  const list = d.apps || [];
  if (args.json) return json(list);
  if (!list.length) { info("no apps yet — deploy one with: supersonic deploy"); return; }
  for (const a of list) {
    const dot = a.ready ? green("●") : red("○");
    print(`${dot} ${bold(a.slug.padEnd(22))} ${dim(a.url || `${a.slug}.supersonic.cv`)}`);
  }
}

async function status(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}`);
  if (args.json) return json(d);
  const dot = d.ready ? green("● live") : red("○ down");
  print(`${bold(app)}  ${dot}`);
  print(dim("  url      ") + `${app}.supersonic.cv`);
  print(dim("  revision ") + (d.revision || "—"));
  print(dim("  image    ") + (d.image ? d.image.split("/").pop() : "—"));
  print(dim("  region   ") + (d.region || "—"));
  print(dim("  database ") + (d.cloudsql ? d.cloudsql.split(":").pop() : "none"));
  print(dim("  env      ") + (d.envKeys && d.envKeys.length ? d.envKeys.join(", ") : "none"));
  print(dim("  repo     ") + (d.repo || "—"));
}

async function logs(args) {
  const app = needApp(args);
  const qs = new URLSearchParams();
  if (args.severity) qs.set("severity", args.severity);
  if (args.limit) qs.set("limit", String(args.limit));
  if (args.since) qs.set("since", args.since);
  const q = qs.toString() ? "?" + qs.toString() : "";

  if (args.follow) {
    let seen = new Set();
    info(dim(`tailing ${app} — ctrl-c to stop`));
    for (;;) {
      const d = await api(`/api/apps/${app}/logs${q}`);
      for (const l of d.logs || []) {
        const key = l.time + l.message;
        if (seen.has(key)) continue;
        seen.add(key);
        print(logLine(l));
      }
      if (seen.size > 2000) seen = new Set();
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  const d = await api(`/api/apps/${app}/logs${q}`);
  if (args.json) return json(d.logs || []);
  if (!(d.logs || []).length) { info("no logs in that window"); return; }
  for (const l of d.logs) print(logLine(l));
}

function logLine(l) {
  const sev = (l.severity || "").toUpperCase();
  const tag = sev === "ERROR" || sev === "CRITICAL" ? red(sev) : sev === "WARNING" ? cyan(sev) : dim(sev || "INFO");
  return `${dim((l.time || "").slice(11, 19))} ${tag} ${l.message}`;
}

async function errors(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}/errors`);
  const list = d.errors || [];
  if (args.json) return json(list);
  if (!list.length) { print(green("✓ no production errors in the last 7 days")); return; }
  for (const e of list) print(`${red("✗")} ${dim((e.time || "").slice(0, 19))} ${e.message}`);
}

async function diagnose(args) {
  const app = needApp(args);
  info(dim("analyzing — reading logs + repo…"));
  const d = await api(`/api/apps/${app}/diagnose`, { method: "POST", body: { error: args.error } });
  if (args.json) return json(d);
  if (d.healthy) { print(green("✓ ") + d.message); return; }
  info(dim("diagnosing: ") + (d.subject || d.error || "").slice(0, 200));
  print("");
  print(bold("Fix prompt (paste into your coding agent):"));
  print(d.fixPrompt || "(no prompt returned)");
}

async function env(args) {
  const app = needApp(args);
  const [, sub, ...rest] = args._; // _[0] is the app; subverb + rest follow
  if (!sub) {
    const d = await api(`/api/apps/${app}/env`);
    if (args.json) return json(d.keys || []);
    if (!(d.keys || []).length) { info("no env vars set"); return; }
    for (const k of d.keys) print(k);
    return;
  }
  if (sub === "set") {
    const set = {};
    for (const kv of rest) { const i = kv.indexOf("="); if (i > 0) set[kv.slice(0, i)] = kv.slice(i + 1); }
    if (!Object.keys(set).length) die("usage: supersonic env <app> set KEY=VALUE [KEY2=VALUE2]");
    const d = await api(`/api/apps/${app}/env`, { method: "POST", body: { set } });
    print(green("✓ ") + `set ${Object.keys(set).join(", ")} — new revision rolling out`);
    if (args.json) json(d);
    return;
  }
  if (sub === "unset") {
    if (!rest.length) die("usage: supersonic env <app> unset KEY [KEY2]");
    const d = await api(`/api/apps/${app}/env`, { method: "POST", body: { unset: rest } });
    print(green("✓ ") + `unset ${rest.join(", ")} — new revision rolling out`);
    if (args.json) json(d);
    return;
  }
  die(`unknown env subcommand: ${sub}`);
}

async function rollback(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}/rollback`, { method: "POST" });
  if (args.json) return json(d);
  print(green("✓ ") + `rolled back — now serving ${d.revision}`);
}

async function exec(args) {
  const app = needApp(args);
  const command = (args._raw || []).join(" ").trim();
  if (!command) die('usage: supersonic exec <app> -- <command>   e.g. supersonic exec myapp -- node -v');
  info(dim(`exec in ${app} (isolated instance, app env + db attached)`));
  info(dim("cold-starting a one-off container — can take ~30–60s…"));
  const d = await api(`/api/apps/${app}/exec`, { method: "POST", body: { command } });
  if (args.json) return json(d);
  if (d.output) print(d.output);
  else info(dim("(no output)"));
  if (d.exitCode) { info(red(`exited ${d.exitCode}`)); process.exitCode = d.exitCode; }
}

async function open(args) {
  const app = needApp(args);
  const url = `https://${app}.supersonic.cv`;
  info(`opening ${url}`);
  openBrowser(url);
}

async function deploy(args) {
  // One command: sign in automatically the first time, then deploy. No separate
  // `supersonic login` step required.
  await ensureAuth();
  // URL-first by default: a live link appears in ~0.1s (a "deploying…" page, or a
  // live preview tunnelled to the dev server when one can be started) while the
  // real build runs on the server. `--prebuilt` opts back into the old build-here-
  // and-upload path for a project that has no server side to preview.
  if (!args.prebuilt) return urlFirstDeploy(args);
  // GitHub / a git URL is a pickable option — the default is straight from this folder.
  if (args.github || args.repo) {
    let repo = args.repo;
    if (!repo) { repo = await gitOrigin(); if (!repo) die("no git remote 'origin' found here — pass --repo <url>"); }
    info(cyan("▸ ") + "deploying from " + bold(repo));
    const res = await api("/api/deploy", { method: "POST", body: { repo }, stream: true });
    return consumeDeploy(res, args);
  }
  // Default: deploy this folder straight from your computer — no git, no setup.
  const appName = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "app";

  // The fast path: your machine already has this project and builds it in seconds, so
  // build here and send only the result. Uploading sources and rebuilding them in the
  // cloud is ~80s; this is ~15s, and nothing at all when the output has not changed.
  if (!args["cloud-build"]) {
    const done = await tryPrebuilt(appName, args);
    if (done !== null) return done;
  }

  info(cyan("▸ ") + "packaging " + bold(appName) + " from this folder…");
  const tgz = await packageFolder();
  const body = fs.readFileSync(tgz);
  try { fs.unlinkSync(tgz); } catch { /* ignore */ }
  info(dim(`uploading ${(body.length / 1048576).toFixed(1)} MB`));
  const tok = token();
  if (!tok) die("not authenticated — run: supersonic login");
  const res = await fetch(baseUrl() + "/api/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/gzip", "x-supersonic-upload": "1", "x-supersonic-app": appName },
    body,
  });
  if (res.status === 401) die("token invalid or expired — run: supersonic login");
  if (res.status === 403) die("forbidden");
  if (!res.body) die("no response stream");
  return consumeDeploy(res, args);
}

/**
 * URL-first deploy — a live URL in ~0.1s, the real build behind it. The default.
 *
 * Reserve the slug → print the URL (already live: a "deploying…" page for any
 * stack, or a live preview if a dev server can be started) → run the real build on
 * the server → the proxy serves the build on the same URL when it lands. The tunnel
 * preview is best-effort (reliable for Node's `npm run dev`); when it can't start
 * one, the URL is still live instantly with the deploying page. No stack is blocked.
 */
async function urlFirstDeploy(args) {
  let repo = args.repo;
  if (args.github && !repo) { repo = await gitOrigin(); }
  const folderName = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "app";

  // 1) reserve the slug → a URL right away (live immediately, any stack)
  const r = await api("/api/deploy/reserve", { method: "POST", body: repo ? { repo } : { name: folderName } });
  const { slug, url } = r;
  print(green("✓ ") + "your app is live at " + bold(url) + dim("  (deploying — build finishing in the background)"));

  // Default: DON'T hold the caller hostage for the whole build. A coding agent
  // that runs `supersonic deploy` should get the live URL and its prompt back in
  // ~1s, not sit blocked for two minutes. So the build is handed to a detached
  // background worker that keeps the deploy connection open (the server keeps
  // building, CPU allocated, until it lands) and logs to
  // ~/.supersonic/deploys/<slug>.log. Pass --wait to stay attached and stream the
  // build here instead (keeps the live-preview tunnel up the whole time).
  if (!args.wait) {
    const logDir = path.join(CFG_DIR, "deploys");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${slug}.log`);
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [process.argv[1], "__deploy-worker"], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        SS_BG_SLUG: slug, SS_BG_URL: url, SS_BG_REPO: repo || "",
        SS_BG_FOLDER: folderName,
        SS_BG_DEVCMD: args["dev-cmd"] || "", SS_BG_DEVPORT: args["dev-port"] || "",
      },
    });
    child.unref();
    // Say — in the foreground, where the agent actually sees it — what the link
    // shows while the build runs. A live preview needs a way to run the app
    // locally; without one the URL is a "building…" page until the real build lands.
    const hasDevCmd = !!(args["dev-cmd"] || args["dev-port"]);
    let hasDevScript = false;
    try { hasDevScript = !!((JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts) || {}).dev; } catch { /* not a node app */ }
    if (hasDevCmd || hasDevScript) {
      print(dim("  starting a live preview at that URL now; the real build swaps in when ready"));
    } else {
      print("  " + bold("no live preview") + dim(" — the link shows a “building…” page until the build finishes (~1–2 min)."));
      print(dim("  for an instant preview, redeploy with ") + bold('--dev-cmd "<how to run your app>"'));
    }
    print(dim("  build finishing in the background · watch: ") + bold(`supersonic logs ${slug} --follow`));
    process.exit(0);
  }

  await runBuildAndWait({ slug, url, repo, folderName, args });
}

/**
 * Steps 2–3 of a URL-first deploy: bring up the live-preview tunnel, kick off the
 * real build on the server, and stream it to completion. Runs either in the
 * foreground (`--wait`) or inside the detached background worker.
 */
async function runBuildAndWait({ slug, url, repo, folderName, args }) {
  const { startDevServer, openTunnel } = require("./lib/tunnel");

  // Live preview: tunnel the URL to a dev server. The agent supplies how to run it
  // (--dev-cmd / --dev-port) for any stack; a Node `dev` script we start ourselves.
  // Until it's up the URL shows the deploying page, never a dead link.
  info(dim("  bringing up a live preview at that URL…"));
  const { proc, port } = await startDevServer(process.cwd(), { devCmd: args["dev-cmd"], devPort: args["dev-port"] });
  const tunnelWs = process.env.SUPERSONIC_TUNNEL_WS || `wss://${slug}.supersonic.cv/_tunnel`;
  let ws = null;
  if (port) {
    ws = openTunnel({
      wsUrl: tunnelWs, slug, token: token(), devHost: "127.0.0.1", devPort: port,
      onOpen: () => info(green("● ") + "live preview at " + bold(url) + dim(" — go do your thing")),
      onClose: (code) => { if (code === 1008) info(red("preview tunnel rejected — token/ownership")); },
    });
  } else {
    info(dim("  (no dev server — pass --dev-cmd \"<how to run your app>\" for an instant live preview)"));
  }
  const cleanup = () => { try { ws && ws.close(); } catch { /* */ } try { proc && proc.kill(); } catch { /* */ } };
  // consumeDeploy exits the process on the terminal event, so guarantee the dev
  // server / tunnel are torn down however this process ends.
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  // The real build, on the reserved slug, on the server (your machine stays free).
  let res;
  if (repo) {
    res = await api("/api/deploy", { method: "POST", body: { repo, slug }, stream: true });
  } else {
    info(cyan("▸ ") + "uploading " + bold(folderName) + " to build in the cloud…");
    const tgz = await packageFolder();
    const body = fs.readFileSync(tgz);
    try { fs.unlinkSync(tgz); } catch { /* ignore */ }
    res = await fetch(baseUrl() + "/api/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/gzip", "x-supersonic-upload": "1", "x-supersonic-app": folderName, "x-supersonic-slug": slug },
      body,
    });
    if (res.status === 401) { cleanup(); die("token invalid or expired — run: supersonic login"); }
  }
  await consumeDeploy(res, args);   // when the build goes live the proxy serves it on `url`
  print(green("✓ ") + "build is live at " + bold(url));
  cleanup();
}

/** The detached background worker spawned by the default deploy. Finishes the
 * build after the foreground command has already returned the live URL. */
async function deployWorker() {
  const slug = process.env.SS_BG_SLUG, url = process.env.SS_BG_URL;
  if (!slug || !url) die("deploy worker: missing context");
  await runBuildAndWait({
    slug, url,
    repo: process.env.SS_BG_REPO || "",
    folderName: process.env.SS_BG_FOLDER || "app",
    args: { "dev-cmd": process.env.SS_BG_DEVCMD || undefined, "dev-port": process.env.SS_BG_DEVPORT || undefined, _: [] },
  });
}

/**
 * Build here and upload only the result.
 *
 * Returns null to mean "not this path, carry on with the cloud build" — which happens
 * for server apps, when the detector can't place the project, and whenever the local
 * build fails. Every one of those falls back rather than failing: someone whose machine
 * is misconfigured still gets a deploy.
 */
async function tryPrebuilt(appName, args) {
  let detect, prebuilt;
  try {
    detect = require("./vendor/detector.js");
    prebuilt = require("./lib/prebuilt.js");
  } catch {
    return null; // detector not bundled — old install, use the cloud
  }

  let stack;
  try { stack = detect.detectStack(process.cwd()); } catch { return null; }

  const plan = prebuilt.planFor(stack);
  if (plan.mode === "cloud") return null;

  const outDir = path.resolve(process.cwd(), plan.outputDir);

  if (plan.mode === "build") {
    const warn = prebuilt.nodeVersionWarning(stack);
    if (warn) info(dim("! " + warn));

    if (!fs.existsSync(path.join(process.cwd(), "node_modules")) && plan.installCommand) {
      info(cyan("▸ ") + "installing dependencies…");
      if (!runLocal(plan.installCommand)) {
        info(dim("! install failed here — building in the cloud instead"));
        return null;
      }
    }
    info(cyan("▸ ") + "building " + bold(appName) + "…");
    if (!runLocal(plan.buildCommand)) {
      info(dim("! build failed here — building in the cloud instead"));
      return null;
    }
  }

  if (!prebuilt.hasOutput(outDir)) {
    info(dim(`! nothing in ${plan.outputDir}/ — building in the cloud instead`));
    return null;
  }

  const hash = prebuilt.hashDir(outDir);

  // Already live? Then there is nothing to send.
  try {
    const pre = await api("/api/deploy/preflight", { method: "POST", body: { app: appName, hash } });
    if (pre && pre.skip) {
      info(green("✓ ") + "already live, nothing changed — " + bold(pre.url));
      return pre.url;
    }
  } catch { /* preflight is an optimisation; never let it stop a deploy */ }

  const tgz = await packageDir(outDir);
  const body = fs.readFileSync(tgz);
  try { fs.unlinkSync(tgz); } catch { /* ignore */ }
  info(dim(`uploading ${(body.length / 1048576).toFixed(1)} MB of built output`));

  const tok = token();
  if (!tok) die("not authenticated — run: supersonic login");
  const res = await fetch(baseUrl() + "/api/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tok,
      "Content-Type": "application/gzip",
      "x-supersonic-upload": "1",
      "x-supersonic-prebuilt": "1",
      "x-supersonic-hash": hash,
      "x-supersonic-app": appName,
    },
    body,
  });
  if (res.status === 401) die("token invalid or expired — run: supersonic login");
  if (res.status === 403) die("forbidden");
  if (!res.body) die("no response stream");
  return consumeDeploy(res, args);
}

/** Run a shell command in the project, streaming its output. True when it succeeded. */
function runLocal(command) {
  const r = spawnSync(command, { shell: true, stdio: "inherit", cwd: process.cwd() });
  return r.status === 0;
}

/** Pack a single directory's contents into a temp .tgz. */
function packageDir(dir) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), "ss-built-" + process.pid + ".tgz");
    const p = spawn("tar", ["-czf", out, "-C", dir, "."], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("could not run `tar` — is it installed?")));
    p.on("close", () => (fs.existsSync(out) ? resolve(out) : reject(new Error("packaging failed: " + err.trim()))));
  });
}

async function redeploy(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}`);
  if (!d.repo) die(`${app} was deployed from a computer — run \`supersonic deploy\` in its folder to ship an update`);
  info(cyan("▸ ") + "redeploying " + bold(app));
  const res = await api("/api/deploy", { method: "POST", body: { repo: d.repo }, stream: true });
  return consumeDeploy(res, args);
}

// Zip the current folder into a temp .tgz, skipping deps/build junk + .gitignore.
function packageFolder() {
  return new Promise((resolve, reject) => {
    const cwd = process.cwd();
    const out = path.join(os.tmpdir(), "ss-deploy-" + process.pid + ".tgz");
    const excludes = ["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit",
      "target", ".venv", "venv", "__pycache__", "vendor", ".DS_Store", ".env", ".env.local",
      ".env.*.local", "*.pyc", ".turbo", ".cache", "out"];
    const targs = ["-czf", out, "-C", cwd];
    for (const e of excludes) targs.push("--exclude=" + e);
    if (fs.existsSync(path.join(cwd, ".gitignore"))) targs.push("--exclude-from=" + path.join(cwd, ".gitignore"));
    targs.push(".");
    const p = spawn("tar", targs, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("could not run `tar` — is it installed?")));
    p.on("close", () => (fs.existsSync(out) ? resolve(out) : reject(new Error("packaging failed: " + err.trim()))));
  });
}

async function consumeDeploy(res, args) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const p of parts) {
      const raw = p.replace(/^data: /, "").trim();
      if (!raw) continue;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === "log") info("  " + dim(ev.line));
      else if (ev.type === "detected") info("  " + cyan(`detected ${ev.stack?.framework || "app"}`));
      else if (ev.type === "done") { if (args.json) json({ ok: true, slug: ev.slug, url: ev.url }); else print(green("✓ live: ") + ev.url); process.exit(0); }
      else if (ev.type === "error") { if (args.json) json({ ok: false, error: ev.message }); die(ev.message); }
    }
  }
  // The server can answer with a plain JSON error instead of a stream — a plan limit,
  // a rejected request. That is not a build that timed out, and saying so sent someone
  // to `supersonic logs` looking for a failure that never happened. If what arrived
  // parses as an error object, report what it actually said.
  const trailing = (buf || "").trim();
  if (trailing) {
    let body; try { body = JSON.parse(trailing.replace(/^data: /, "")); } catch { /* not JSON */ }
    if (body && body.error) {
      if (args.json) json({ ok: false, error: body.error, upgrade: !!body.upgrade, paywall: !!body.paywall });
      die(body.error);
    }
  }

  // Stream closed with no terminal `done`/`error` — the build likely timed out or
  // the connection dropped mid-repair. Never report this as success.
  if (args.json) json({ ok: false, error: "deploy stream ended without a result" });
  die("the deploy ended without confirming it went live — the build may have failed or timed out. Check: supersonic apps  ·  supersonic logs <app>");
}

// ---------- helpers ----------
function needApp(args) { const a = args._[0]; if (!a) die("missing app name — usage: supersonic " + args._cmd + " <app>"); return a; }
function gitOrigin() {
  return new Promise((resolve) => {
    const p = spawn("git", ["remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] });
    let o = ""; p.stdout.on("data", (d) => (o += d));
    p.on("error", () => resolve(""));
    p.on("close", (code) => resolve(code === 0 ? o.trim() : ""));
  });
}

function usage(all = false) {
  if (!all) {
    print(`${bold("supersonic")} — publish your app in one command

${bold("just run this in your project folder:")}
  ${green("supersonic deploy")}          publish this folder and print the live URL
                             (opens a browser to sign in the first time)

${bold("when something's wrong")}
  supersonic logs <app>      recent logs
  supersonic diagnose <app>  AI fix-prompt for your coding agent
  supersonic apps            list your apps
  supersonic open <app>      open the app in a browser
  supersonic login           sign in manually

${dim("more commands: supersonic help --all  ·  --json on any command for machine output")}`);
    return;
  }
  print(`${bold("supersonic")} — deploy & debug from your coding agent

${bold("setup")}
  supersonic signup                            create an account (opens browser, one time)
  supersonic login [--url <u>] [--token <t>]   authenticate (browser, one time)
  supersonic logout
  supersonic whoami

${bold("deploy")} ${dim("(URL-first: a live link in ~0.1s, real build in the background)")}
  supersonic deploy                             deploy this folder — live URL now, build behind it
  supersonic deploy --dev-cmd "<run in dev>"    tunnel the URL to your app live while it builds
                                                  e.g. --dev-cmd "uvicorn main:app --port 8000"
  supersonic deploy --dev-port <n>              tunnel to a dev server you already started
  supersonic deploy --wait                      stay attached and stream the build (default: returns once live)
  supersonic deploy --github [--repo <url>]     deploy from GitHub / a git URL instead
  supersonic deploy --prebuilt                  old path: build here, upload the result
  supersonic redeploy <app>                     rebuild from the app's source
  supersonic rollback <app>                     roll back to the previous revision

${bold("inspect")}
  supersonic apps                               list your apps
  supersonic status <app>                       revision, url, env, database
  supersonic logs <app> [--severity error] [--limit 50] [--since 1h] [--follow]
  supersonic errors <app>                       production errors (7d)
  supersonic diagnose <app> [--error "..."]     AI fix-prompt for your agent
  supersonic exec <app> -- <command>            run a command in the app's env (isolated)

${bold("config")}
  supersonic env <app>                          list env var keys
  supersonic env <app> set KEY=VALUE            set env var(s)
  supersonic env <app> unset KEY                remove env var(s)
  supersonic open <app>                         open the app in a browser

${dim("global: --json for machine-readable output · $SUPERSONIC_TOKEN overrides login")}`);
}

// ---------- arg parsing ----------
function parse(argv) {
  const args = { _: [], _raw: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { args._raw = argv.slice(i + 1); break; } // everything after `--` is a passthrough command
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > -1) args[t.slice(2, eq)] = t.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && argv[i + 1] !== "--") args[t.slice(2)] = argv[++i];
      else args[t.slice(2)] = true;
    } else args._.push(t);
  }
  return args;
}

const COMMANDS = { signup, login, logout, whoami, apps, status, logs, errors, diagnose, env, rollback, exec, open, deploy, redeploy, "__deploy-worker": deployWorker };

(async () => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return usage(rest.includes("--all") || rest.includes("-a"));
  const fn = COMMANDS[cmd];
  if (!fn) { info(red(`unknown command: ${cmd}`)); usage(); process.exit(1); }
  const args = parse(rest);
  args._cmd = cmd;
  await fn(args);
})().catch((e) => die(e && e.message ? e.message : String(e)));
