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
const { spawn } = require("child_process");

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

// Browser loopback used by both login and signup: open the web at `startPath`,
// spin up a local server, and let the web hand a CLI token back once signed in.
async function loopbackAuth(url, startPath, verb) {
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

  let tok;
  try {
    tok = await Promise.race([done, timeout]);
  } catch {
    shutdown();
    return die(`${verb} timed out — try again, or use: supersonic login --token <token>`);
  }
  shutdown();
  if (!tok) return die("no token received");

  saveCfg({ ...loadCfg(), url, token: tok });
  print(green("✓ ") + `${verb} to ${url}`);
  process.exit(0); // loopback server + timer are cleaned up; exit so the shell returns
}

// Prove a token is valid by hitting any authorized endpoint (200 == good).
async function validToken(url, tok) {
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/api/apps", { headers: { Authorization: "Bearer " + tok } });
    return r.ok;
  } catch { return false; }
}

async function whoami(args) {
  const cfg = loadCfg();
  const tok = token();
  if (!tok) { if (args.json) return json({ loggedIn: false }); print("not logged in"); return; }
  // Prove the token by listing apps (any 200 means valid).
  const res = await fetch(baseUrl() + "/api/apps", { headers: { Authorization: "Bearer " + tok } });
  const ok = res.ok;
  if (args.json) return json({ loggedIn: ok, url: baseUrl(), source: process.env.SUPERSONIC_TOKEN ? "env" : "config" });
  if (!ok) return die("token invalid — run: supersonic login");
  const src = process.env.SUPERSONIC_TOKEN ? "env token" : "saved token";
  const who = !process.env.SUPERSONIC_TOKEN && cfg.email ? " as " + cfg.email : "";
  print(`logged in to ${baseUrl()}${who} (${src})`);
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

function usage() {
  print(`${bold("supersonic")} — deploy & debug from your coding agent

${bold("setup")}
  supersonic signup                            create an account (opens browser, one time)
  supersonic login [--url <u>] [--token <t>]   authenticate (browser, one time)
  supersonic logout
  supersonic whoami

${bold("deploy")}
  supersonic deploy                             deploy this folder — no git needed
  supersonic deploy --github [--repo <url>]     deploy from GitHub / a git URL instead
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

const COMMANDS = { signup, login, logout, whoami, apps, status, logs, errors, diagnose, env, rollback, exec, open, deploy, redeploy };

(async () => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return usage();
  const fn = COMMANDS[cmd];
  if (!fn) { info(red(`unknown command: ${cmd}`)); usage(); process.exit(1); }
  const args = parse(rest);
  args._cmd = cmd;
  await fn(args);
})().catch((e) => die(e && e.message ? e.message : String(e)));
