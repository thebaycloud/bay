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
const { readEnvFiles, selectEnv, encodeEnvHeader } = require("./lib/envfile");
const { joinExecArgs } = require("./lib/exec-args");
const { whoHeader } = require("./lib/who");

const CFG_DIR = path.join(os.homedir(), ".supersonic");
const CFG = path.join(CFG_DIR, "config.json");
const DEFAULT_URL = "https://app.supersonic.cv";

// ---------- output ----------
// A reader that stops reading — `supersonic check | head -5`, an agent piping into
// grep — closes the pipe under us, and Node turns that into an unhandled EPIPE:
// twenty lines of stack trace printed over the output that was actually asked for,
// and a non-zero exit that reads as the command having failed. It did not; the
// reader got what it wanted and left.
for (const s of [process.stdout, process.stderr]) s.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), cyan = c("36"), yellow = c("33");
// Set once a deploy knows its slug: every progress line is also appended to
// ~/.supersonic/deploys/<slug>.log, so a build survives the terminal it was
// started in. Best-effort — a log that cannot be written must never stop a deploy.
let deployLog = null;
function startDeployLog(slug) {
  try {
    const dir = path.join(CFG_DIR, "deploys");
    fs.mkdirSync(dir, { recursive: true });
    deployLog = fs.openSync(path.join(dir, `${slug}.log`), "a");
  } catch { deployLog = null; }
}
function info(s) {
  process.stderr.write(s + "\n");                            // logs -> stderr
  // eslint-disable-next-line no-control-regex
  if (deployLog !== null) { try { fs.writeSync(deployLog, s.replace(/\x1b\[[0-9;]*m/g, "") + "\n"); } catch { /* full disk, etc. */ } }
}
function print(s) { process.stdout.write(s + "\n"); }         // data -> stdout
function die(s, code = 1) { process.stderr.write(red("✗ ") + s + "\n"); process.exit(code); }

/** What the last green deploy decided, written beside the project. */
const LOCKFILE = "supersonic.lock.json";

/**
 * Record the decisions a successful deploy made.
 *
 * Written HERE and not by the server, because the server has a clone and the
 * clone is not your folder. That is also why a `--github` deploy gets nothing:
 * there is no working tree on this machine to write into, and inventing one
 * would put a file in whatever directory the command happened to run from.
 *
 * A lockfile, not a form. A first deploy on a bare folder still requires nothing;
 * this appears only after something has worked, and it says what was chosen —
 * which for `versionFrom: "platform default"` is the only line the author did not
 * choose and the only one that can move under them.
 *
 * A SIDECAR rather than fields in supersonic.json: `parseAppConfig` has a fixed
 * key list and silently drops what it does not know, so writing there would be
 * committing the accepted-and-ignored defect while claiming to document against
 * it.
 *
 * Best-effort throughout. A read-only directory, a permissions error, a
 * `--prebuilt` deploy with nothing to record: none of them is a reason to turn a
 * successful deploy into a failure at the very last step.
 */
function writeLockfile(decided, slug) {
  if (!decided || typeof decided !== "object") return;
  try {
    const body = JSON.stringify({
      $comment: "Written by supersonic after a successful deploy. Safe to commit, safe to delete.",
      slug: slug || undefined,
      decided,
    }, null, 2) + "\n";
    const path = require("node:path").join(process.cwd(), LOCKFILE);
    if (require("node:fs").existsSync(path) && require("node:fs").readFileSync(path, "utf8") === body) return;
    require("node:fs").writeFileSync(path, body);
    info(dim(`  wrote ${LOCKFILE} — what this deploy decided, so you can see it and change it`));
  } catch { /* never fail a green deploy over a note about it */ }
}
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
      "x-supersonic-who": whoHeader(process.env),
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
    // The list endpoint has always sent `status: "building"` for a deploy in
    // flight and the CLI has always thrown it away, so an app that was building
    // normally appeared here as a dead one — the same "ready or down" flattening
    // that `status` had.
    const building = a.status === "building";
    const dot = a.ready ? green("●") : building ? yellow("◐") : red("○");
    const note = building ? dim(`  ${a.stage || "deploying…"}`) : "";
    print(`${dot} ${bold(a.slug.padEnd(22))} ${dim(a.url || `${a.slug}.supersonic.cv`)}${note}`);
  }
}

async function status(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}`);
  if (args.json) return json(d);
  // Three states, because there are three. Reporting a deploy in progress as
  // "down" is how `status` came to say `○ down · revision — · env none` about an
  // app that was building normally and whose URL was answering 200 — a confident
  // answer to a question it could not yet answer.
  const dot = d.ready ? green("● live") : d.deploying ? yellow("◐ deploying") : red("○ down");
  print(`${bold(app)}  ${dot}${d.deploying && d.stage ? dim(` · ${d.stage}`) : ""}`);
  print(dim("  url      ") + `${app}.supersonic.cv`);
  print(dim("  revision ") + (d.revision || "—"));
  print(dim("  image    ") + (d.image ? d.image.split("/").pop() : "—"));
  print(dim("  region   ") + (d.region || "—"));
  print(dim("  database ") + (d.cloudsql ? d.cloudsql.split(":").pop() : "none"));
  print(dim("  env      ") + (d.envKeys && d.envKeys.length ? d.envKeys.join(", ") : "none"));
  print(dim("  repo     ") + (d.repo || "—"));
  // An app is not always one program. A worker, a cron and a release are
  // invisible everywhere else in this command, and "is my worker running" is
  // the question people actually ask.
  if (d.processes && d.processes.length) {
    const line = d.processes
      .map((p) => `${p.name}(${p.kind})${p.kind === "web" || p.kind === "worker" ? (p.running ? " ✓" : " ✗") : ""}`)
      .join("  ");
    print(dim("  runs     ") + line);
  }
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
    // "new revision" is Cloud Run's word, and an app on a node has none — its
    // process is restarted in place. Worse, it was printed unconditionally, so
    // it announced a rollout for a write that had changed nothing. The server
    // says what actually happened; this repeats it rather than guessing.
    print(green("✓ ") + `set ${Object.keys(set).join(", ")}${d?.note ? ` — ${d.note}` : ""}`);
    if (args.json) json(d);
    return;
  }
  if (sub === "unset") {
    if (!rest.length) die("usage: supersonic env <app> unset KEY [KEY2]");
    const d = await api(`/api/apps/${app}/env`, { method: "POST", body: { unset: rest } });
    print(green("✓ ") + `unset ${rest.join(", ")}${d?.note ? ` — ${d.note}` : ""}`);
    if (args.json) json(d);
    return;
  }
  die(`unknown env subcommand: ${sub}`);
}

/**
 * The repair agent's fix, as a patch, on stdout and nothing else.
 *
 * The agent's edits happen in the copy of the repo the server unpacked, which is
 * deleted when the deploy ends — so a rescued app left this folder still broken
 * and the next deploy shipped the same code again. Straight to stdout so it can
 * be piped: `supersonic patch <app> | git apply`. Every other word this command
 * says goes to stderr, so the pipe carries the patch alone.
 */
async function patch(args) {
  const app = needApp(args);
  const res = await api(`/api/apps/${app}/patch`, { stream: true });
  const body = await res.text();
  if (res.status === 404) { info(dim(body.trim())); process.exit(1); }
  if (!res.ok) die(body.trim() || `could not fetch the patch (${res.status})`);
  process.stdout.write(body);
}

async function rollback(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}/rollback`, { method: "POST" });
  if (args.json) return json(d);
  print(green("✓ ") + `rolled back — now serving ${d.revision}`);
}

async function exec(args) {
  const app = needApp(args);
  const command = joinExecArgs(args._raw || []);
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

/**
 * Write a DRAFT supersonic.json from this repository. No model, no network, ~2s.
 *
 * Deliberately not "generate a config": the file it writes is a first draft for an
 * agent to correct, and the two are different products. Never ask a state-1 agent
 * to produce JSON from nothing — ask it to correct a draft, because review is the
 * thing agents are good at and authoring from an empty file is the thing they are
 * not.
 */
async function init(args) {
  const { resolver, detector } = require("./lib/resolver");
  const { buildDraft, renderDraft, unknownsFor } = require("./lib/draft");
  const r = resolver();
  const dir = path.resolve(args._[0] || process.cwd());
  const target = path.join(dir, r.CONFIG_FILENAME);

  // Refusing to overwrite is the whole point of the file existing. A hand-written
  // config is the ONE input the platform is required to obey, and replacing it
  // with a detector's guess would be this command undoing its own reason to exist.
  if (fs.existsSync(target) && !args.force) {
    return die(`${r.CONFIG_FILENAME} already exists — read it, or \`supersonic init --force\` to overwrite it with a fresh draft`);
  }

  const { config, candidates } = await buildDraft(dir, { resolver: r, detect: detector() });
  const unknowns = unknownsFor(dir, config, candidates);
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");

  if (args.json) {
    return json({
      wrote: r.CONFIG_FILENAME,
      draft: true,
      config,
      undetermined: unknowns.map(([question, field]) => ({ question, field })),
    });
  }
  for (const line of renderDraft(r.CONFIG_FILENAME, config, unknowns)) print(line);

  // The draft is written whatever happens next — a config that needs a correction
  // is exactly what this command produces — but a draft the resolver would already
  // refuse is worth saying now rather than on the next command.
  const { checkApp } = require("./lib/check");
  const { problems } = await checkApp(dir, { resolver: r, detect: detector() });
  if (problems.length) {
    print("");
    print(yellow("! ") + "and `supersonic check` would already fail on it:");
    for (const p of problems) print("  " + p);
  }
}

/**
 * The local dry run. resolve() + validate(), nothing else, no cloud.
 *
 * Non-zero on any error, because the caller is an agent in a loop and an exit code
 * is the only part of this output it is guaranteed to read.
 */
async function check(args) {
  const { resolver, detector } = require("./lib/resolver");
  const { checkApp, renderCheck, secretWarnings } = require("./lib/check");
  const r = resolver();
  const dir = path.resolve(args._[0] || process.cwd());

  const { app, problems, warnings } = await checkApp(dir, { resolver: r, detect: detector() });
  if (app) {
    // The local .env is not the deployed environment, so this can only warn — but
    // it is the same file `deploy` carries up, which makes it the best available
    // answer to "will this secret have a value when it lands".
    const available = [...Object.keys(readEnvFiles(dir)), ...Object.keys(process.env)];
    warnings.push(...secretWarnings(r, app, available));
  }

  if (args.json) {
    json({ ok: problems.length === 0, source: app ? app.source : null, services: app ? app.services : [], resources: app ? app.resources : null, problems, warnings });
  } else {
    for (const line of renderCheck(r.CONFIG_FILENAME, app, problems, warnings)) {
      print(problems.length && line.startsWith("✕") ? red(line) : line.startsWith("! ") ? yellow(line) : line);
    }
  }
  if (problems.length) process.exit(1);
}

/**
 * Flags that used to run the app on this machine and tunnel the public URL to it.
 *
 * Named rather than ignored. `parse()` accepts any `--flag` it is handed, so a
 * removed one would be swallowed in silence — and the caller would go on believing
 * a preview was being served from their laptop while the address showed something
 * else entirely. Silence is the wrong answer to "I asked for a thing you no longer
 * do", especially for the agents that make up most of the callers here.
 */
const REMOVED_DEPLOY_FLAGS = ["dev-cmd", "dev-port", "no-preview"];

/**
 * Every flag `ship` understands.
 *
 * `parse()` accepts anything that starts with `--`, which is fine for a command
 * that only reads. It is not fine for this one: a typo'd flag was silently
 * dropped and the deploy went ahead anyway, so `--drt-run` reserved a slug,
 * uploaded a folder and created an app. Found by doing exactly that by accident
 * while testing the alias below.
 *
 * The cost lands on agents hardest. A person sees the app appear; an agent reads
 * "deploying — your app will be live at" and reports success for the thing it did
 * not ask for.
 */
const SHIP_FLAGS = ["run", "wait", "no-env", "github", "repo", "prebuilt", "json", "help"];

async function deploy(args) {
  if (args.help) return usage(true);
  const removed = REMOVED_DEPLOY_FLAGS.filter((f) => args[f] !== undefined);
  if (removed.length) {
    die(
      `${removed.map((f) => "--" + f).join(", ")} ${removed.length > 1 ? "were" : "was"} removed in 0.11.0.\n` +
      "  Nothing needs to run on your machine any more: the URL is live the moment you ship\n" +
      "  and shows the build itself, then becomes your app. Drop the flag and ship."
    );
  }
  const unknown = Object.keys(args).filter(
    (k) => k !== "_" && k !== "_raw" && k !== "_cmd" && !SHIP_FLAGS.includes(k),
  );
  if (unknown.length) {
    die(
      `${unknown.map((f) => "--" + f).join(", ")} ${unknown.length > 1 ? "are not flags" : "is not a flag"} ` +
      `supersonic ship understands.\n` +
      `  It takes: ${SHIP_FLAGS.map((f) => "--" + f).join(", ")}\n` +
      "  Nothing was shipped. Fix the flag and run it again."
    );
  }
  // One command: sign in automatically the first time, then deploy. No separate
  // `supersonic login` step required.
  await ensureAuth();
  // URL-first by default: a live link appears in ~0.1s — the address answers with
  // the room, which draws the build as it happens — while the real build runs on
  // the server. `--prebuilt` opts back into the old build-here-and-upload path.
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
    headers: {
      Authorization: "Bearer " + tok,
      "Content-Type": "application/gzip",
      "x-supersonic-upload": "1",
      "x-supersonic-app": appName,
      "x-supersonic-who": whoHeader(process.env),
    },
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
 * Reserve the slug → print the URL, which is already live and showing the room →
 * run the real build on the server → the same URL becomes the app when it lands.
 * Every stack gets the same thing; nothing has to run locally for the link to be
 * worth sending to somebody.
 */
async function urlFirstDeploy(args) {
  let repo = args.repo;
  if (args.github && !repo) { repo = await gitOrigin(); }
  const folderName = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "app";

  // 1) reserve the slug → a URL right away (live immediately, any stack)
  const r = await api("/api/deploy/reserve", { method: "POST", body: repo ? { repo } : { name: folderName } });
  const { slug, url } = r;
  // Not "✓ live". Nothing has been built yet — this is the moment the slug was
  // reserved, and the build can still fail. Eight agents in a row read that
  // checkmark as "done", stopped watching, and reported a working deploy for an
  // app that never came up. The URL is real and does work from here (it serves a
  // build page), so it stays; what leaves is the claim that the app is on it.
  print(dim("⧗ ") + "deploying — your app will be live at " + bold(url));

  // Default: DON'T hold the caller hostage for the whole build. A coding agent
  // that runs `supersonic deploy` should get the live URL and its prompt back in
  // ~1s, not sit blocked for two minutes. So the build is handed to a detached
  // background worker that keeps the deploy connection open (the server keeps
  // building, CPU allocated, until it lands) and logs to
  // ~/.supersonic/deploys/<slug>.log. Pass --wait to stay attached and stream the
  // build here instead.
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
        SS_BG_NOENV: args["no-env"] ? "1" : "",
        SS_BG_RUN: args["run"] || "",
      },
    });
    child.unref();
    // Say — in the foreground, where the agent actually sees it — what the link
    // shows while the build runs. It is not a placeholder any more: the address
    // answers with the room, which draws the build as it happens and turns into
    // the app the moment it first responds.
    print(dim("  the link is live now — it shows the build, and becomes your app when it comes up"));
    // Said here, not in the worker's log, because this is the only output the agent
    // that ran the deploy will read. Names only — the values must never reach a log.
    if (!args["no-env"]) {
      const candidates = Object.keys(selectEnv(readEnvFiles(process.cwd())).send);
      if (candidates.length) print(dim("  carrying from .env: ") + candidates.join(", ") + dim(" (vars already set on the app are left alone)"));
    }
    print(dim("  build finishing in the background · watch: ") + bold(`supersonic logs ${slug} --follow`));
    process.exit(0);
  }

  await runBuildAndWait({ slug, url, repo, folderName, args });
}

/**
 * The vars to carry up with this deploy, read from the project's local `.env`.
 *
 * Asking the app which keys it already has is what keeps a redeploy from overwriting a
 * deliberately-set production value with whatever is in the developer's `.env` — very
 * often a test key. A slug reserved seconds ago has no service yet and answers with no
 * keys, which is right: on a first deploy everything local is new.
 */
async function collectEnv(slug, args) {
  const none = { send: {}, skipped: [] };
  if (args["no-env"]) return none;
  const local = readEnvFiles(process.cwd());
  if (!Object.keys(local).length) return none;
  let existingKeys = [];
  try { existingKeys = (await api(`/api/apps/${slug}/env`)).keys || []; } catch { /* no service yet */ }
  return selectEnv(local, { existingKeys, platformOwned: ownedHere() });
}

/**
 * Which names THIS repo's deploy will write for itself.
 *
 * Asked of the control plane's own resolver rather than answered here, because it
 * is not a property of the name: DATABASE_URL belongs to the platform when the
 * platform provisions the database and to the app when the app already has one.
 * Answering it locally from a hard-coded list is what made the CLI strip the one
 * variable a bring-your-own-database deploy cannot run without.
 *
 * Undefined on any failure — no config, a malformed one, a build with no bundled
 * resolver — which leaves `selectEnv` on its own conservative set. A variable
 * wrongly skipped is printed to the user with a reason; a variable wrongly sent
 * points a live app at a laptop.
 */
function ownedHere() {
  try {
    const { resolver } = require("./lib/resolver");
    const r = resolver();
    const config = r.readAppConfig(process.cwd());
    if (!config) return undefined;
    // Already OR'd with every service's `uses`/`needsDB` by parseAppConfig, so
    // this is the same answer the server will reach.
    const database = config.resources && config.resources.database;
    return (name) => r.platformOwned(name, database);
  } catch {
    return undefined;
  }
}

/**
 * Steps 2–3 of a URL-first deploy: kick off the real build on the server and
 * stream it to completion. Runs either in the foreground (`--wait`) or inside
 * the detached background worker.
 *
 * The address is already live while this runs — it was reserved in step 1 and
 * the edge answers it with the room, which draws the build as it happens.
 */
async function runBuildAndWait({ slug, url, repo, folderName, args }) {
  // Keep a local copy of the build output whichever path this is.
  //
  // The log file used to be written only by the detached worker, because that is
  // where its stdout was redirected — so `--wait`, the mode where you are watching
  // and most likely to lose the terminal, was the one mode that kept no record.
  // `supersonic logs` then reads from the server and shows the RUNNING app's logs,
  // which for a failed deploy is nothing at all.
  startDeployLog(slug);

  // The app's own secrets, from the project's local .env. They ride the deploy request
  // rather than the tarball, so they land on the first revision — an app that needs an
  // API key comes up working instead of crash-looping until someone sets it by hand.
  const { send: envVars } = await collectEnv(slug, args);
  const envKeys = Object.keys(envVars);
  if (envKeys.length) info(cyan("▸ ") + `carrying ${envKeys.length} var${envKeys.length > 1 ? "s" : ""} from .env: ` + dim(envKeys.join(", ")));

  // The real build, on the reserved slug, on the server (your machine stays free).
  let res;
  const runCmd = args.run || process.env.SS_BG_RUN || "";
  if (repo) {
    res = await api("/api/deploy", { method: "POST", body: { repo, slug, secrets: envVars, run: runCmd }, stream: true });
  } else {
    // Not "to build in the cloud" — most apps take the prebuilt runner and the
    // server says "no image to build" twenty lines later, so the two read as a
    // contradiction. What is true of every deploy is that the code is going up.
    info(cyan("▸ ") + "uploading " + bold(folderName) + "…");
    const tgz = await packageFolder();
    const body = fs.readFileSync(tgz);
    try { fs.unlinkSync(tgz); } catch { /* ignore */ }
    const headers = {
      Authorization: "Bearer " + token(),
      "Content-Type": "application/gzip",
      "x-supersonic-upload": "1",
      "x-supersonic-app": folderName,
      "x-supersonic-slug": slug,
      "x-supersonic-who": whoHeader(process.env),
    };
    // How to run the app in production, worked out by the agent. Encoded because it
    // has spaces/flags. The runner uses it as SUPERSONIC_RUN.
    if (runCmd) headers["x-supersonic-run"] = encodeURIComponent(runCmd);
    // The upload's body is the tarball, so the vars go in a header. Past what Cloud Run
    // will carry there we say so and set nothing: silently dropping half an environment
    // would surface later as an app that is broken for no visible reason.
    const envHeader = encodeEnvHeader(envVars);
    if (envHeader) headers["x-supersonic-env"] = envHeader;
    else if (envKeys.length) info(red("! ") + ".env is too large to send with the build — set them after it lands: " + bold(`supersonic env ${slug} set KEY=VALUE`));

    // The bytes go to the bucket, not through the API. Attempted for every size
    // rather than only over the cap, so the path a large project depends on is
    // the same one every deploy exercises — a fallback that only runs for the
    // biggest uploads is a fallback nobody finds out is broken.
    const placed = await uploadSourceToBucket(body);
    if (placed) {
      headers["x-supersonic-source-object"] = placed.object;
      headers["x-supersonic-source-key"] = placed.key;
      res = await fetch(baseUrl() + "/api/deploy", { method: "POST", headers });
    } else if (body.length >= BODY_LIMIT) {
      // Said here because nowhere else can. The 413 comes from Google's front
      // end, so the server has no record to report and no log line to show.
      cleanup();
      die(`this project is ${(body.length / 1e6).toFixed(1)} MB packed, and the direct upload path caps at 32 MB — `
        + `the bucket upload could not be prepared, so there is no way to send it right now. Nothing was deployed.`);
    } else {
      res = await fetch(baseUrl() + "/api/deploy", { method: "POST", headers, body });
    }
    if (res.status === 401) { cleanup(); die("token invalid or expired — run: supersonic login"); }
  }
  await consumeDeploy(res, args, slug);   // when the build goes live the proxy serves it on `url`
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
    args: {
      "no-env": process.env.SS_BG_NOENV === "1" || undefined,
      _: [],
    },
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
      "x-supersonic-who": whoHeader(process.env),
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
    // COPYFILE_DISABLE=1 stops macOS `tar` from synthesizing AppleDouble `._*`
    // entries. Without it those land in the archive, extract on the Linux build
    // side, and break framework builds (Next tries to compile `._page.js`). No-op
    // off macOS. Belt-and-suspenders: also drop any `._*` already on disk.
    const p = spawn("tar", ["--exclude=._*", "-czf", out, "-C", dir, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
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
  return consumeDeploy(res, args, app);
}

/**
 * Zip the current folder into a temp .tgz. `lib/bundle.js` decides what goes in it
 * — and, unlike the denylist this replaced, says what it left out and why.
 */
function packageFolder() {
  const { packageFolder: pack } = require("./lib/bundle.js");
  return pack(process.cwd(), (line) => {
    if (line.level === "warn") info(yellow("! ") + line.text);
    else if (line.level === "detail") info(dim("  " + line.text));
    else info(dim("  " + line.text));
  });
}

/**
 * What a request body may weigh before Google's front end throws it away.
 *
 * Cloud Run's cap, and it is enforced ABOVE the service: a larger POST is
 * answered 413 by the front end, so the control plane never sees the request,
 * logs nothing, and leaves the app sitting at "reserved" forever. Excalidraw
 * bundles to 36.3 MB and hit exactly this — the deploy looked like it had simply
 * stopped. Anything at or above this goes to the bucket instead.
 */
const BODY_LIMIT = 32 * 1024 * 1024;

/**
 * The tarball's encryption, mirroring lib/deploy-runs.ts on the server.
 *
 * The bucket is readable by the shared app-runtime identity, so source left
 * there in the clear would be readable from inside every other customer's
 * container. Encrypting here rather than server-side is what lets the bytes skip
 * the control plane entirely; the key travels with the deploy request and is
 * stored in the same Postgres column a server-side upload would have written.
 *
 * aes-256-cbc, key derived by scrypt from a 32-byte hex passphrase under a fixed
 * salt, IV prefixed to the ciphertext. If either side changes, both must.
 */
function encryptSource(buf, pass) {
  const { createCipheriv, scryptSync } = require("node:crypto");
  const iv = require("node:crypto").randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", scryptSync(pass, "supersonic-deploy-run", 32), iv);
  return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
}

/**
 * Put the source in the bucket ourselves and hand back the reference.
 *
 * Returns null when the server cannot mint a URL, which the caller treats as
 * "use the body" — correct for a small project and a refusal for a large one,
 * because the body is precisely what does not work at size.
 */
async function uploadSourceToBucket(body) {
  let spot;
  try {
    const r = await fetch(baseUrl() + "/api/deploy/upload-url", {
      method: "POST",
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    });
    if (r.status === 401) die("token invalid or expired — run: supersonic login");
    if (!r.ok) return null;
    spot = await r.json();
  } catch { return null; }
  if (!spot || !spot.uploadUrl || !spot.object) return null;

  const key = require("node:crypto").randomBytes(32).toString("hex");
  const sealed = encryptSource(body, key);
  const put = await fetch(spot.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: sealed,
  });
  if (!put.ok) die(`upload failed (${put.status}) — the code never left your machine, so nothing was deployed`);
  return { object: spot.object, key };
}

/**
 * Follow a deploy on the server after the stream to it has died.
 *
 * The build runs on the control plane, not here — so a dropped socket says
 * nothing about whether the deploy worked. It has already gone both ways: a
 * Prisma app was reported failed six seconds before its own health probe passed,
 * and a killed instance ended streams on deploys that went on to land. The
 * server's own record is the only thing that knows, so ask it rather than
 * inferring from a closed connection.
 */
async function followDeployOnServer(slug, ms = 180000) {
  const deadline = Date.now() + ms;
  let announced = false;
  for (;;) {
    let deploy = null;
    // Deliberately not `api()`: it exits the process on a non-200, and a blip
    // while polling must not become the verdict.
    try {
      const r = await fetch(baseUrl() + `/api/apps/${slug}/deploy-status`, {
        headers: { Authorization: "Bearer " + token() },
      });
      if (r.ok) deploy = (await r.json().catch(() => ({}))).deploy || null;
    } catch { /* transient — keep waiting */ }
    if (deploy && (deploy.status === "live" || deploy.status === "failed")) return deploy;
    if (Date.now() >= deadline) return null;
    if (!announced) {
      announced = true;
      info(dim("  lost the connection to the build — following it on the server instead…"));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function consumeDeploy(res, args, knownSlug) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // The deploy stream announces the slug up front, so even the call paths that
  // let the server pick one can follow the deploy after the stream dies.
  let slug = knownSlug || null;
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
      if (ev.slug) slug = ev.slug;
      if (ev.type === "log") info("  " + dim(ev.line));
      else if (ev.type === "detected") info("  " + cyan(`detected ${ev.stack?.framework || "app"}`));
      else if (ev.type === "done") { writeLockfile(ev.decided, ev.slug); if (args.json) json({ ok: true, slug: ev.slug, url: ev.url }); else print(green("✓ live: ") + ev.url); process.exit(0); }
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

  // Stream closed with no terminal `done`/`error`. That is a fact about this
  // connection, not about the deploy: the build is still running on the server.
  // Ask the server what actually happened before saying anything.
  if (slug) {
    const deploy = await followDeployOnServer(slug);
    if (deploy?.status === "live") {
      const url = deploy.url || `https://${slug}.supersonic.cv`;
      if (args.json) json({ ok: true, slug, url });
      else print(green("✓ live: ") + url);
      process.exit(0);
    }
    if (deploy?.status === "failed") {
      const why = deploy.error || deploy.stage || "the deploy failed";
      if (args.json) json({ ok: false, slug, error: why });
      die(why);
    }
    // Still building when we ran out of patience. Say that, rather than calling a
    // deploy failed that may be minutes from landing.
    if (args.json) json({ ok: false, slug, error: "still building — connection lost", pending: true });
    die(`lost contact with the build and it was still running after 3 minutes. It may still land — check: supersonic logs ${slug}`);
  }

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
  ${green("supersonic ship")}            publish this folder and print the live URL
                             (opens a browser to sign in the first time;
                              ${dim("`deploy` is the same command")})

${bold("before you ship")} ${dim("(local, ~2s, no cloud)")}
  supersonic init            write a draft supersonic.json from this repo
  supersonic check           what each phase would run, and what would fail

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

${bold("author")} ${dim("(local: no cloud, no build, no model — about two seconds)")}
  supersonic init [dir] [--force]               write a DRAFT supersonic.json for an agent to correct
  supersonic check [dir]                        resolve + validate it, and print what each phase would run

${bold("ship")} ${dim("(URL-first: a live link in ~0.1s, the build drawn on it while it runs)")}
  supersonic ship                               ship this folder — live URL now, build behind it
  ${dim("(`deploy` does the same thing and always will — every flag below works with either)")}
  supersonic ship --run "<prod start cmd>"    how to run it in PROD — you know the stack
                                                  e.g. --run "uvicorn main:app --host 0.0.0.0 --port $PORT"
  supersonic ship --wait                      stay attached and stream the build (default: returns once live)
  supersonic ship --no-env                    don't carry .env up (default: sets vars your app doesn't have yet)
  supersonic ship --github [--repo <url>]     deploy from GitHub / a git URL instead
  supersonic ship --prebuilt                  old path: build here, upload the result
  supersonic reship <app>                       rebuild from the app's source
  supersonic patch <app>                        the repair agent's fix, to pipe into git apply
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

/**
 * `ship` is the word; `deploy` is the alias, and it is permanent.
 *
 * The product language calls the act of sending your work out `ship` — it is
 * what people say, and it leaves `deploy` free to mean the thing sysadmins do.
 * But `deploy` is typed by every existing user and written into every agent
 * prompt, README and script that already exists, so it does not get deprecated,
 * warned about, or removed. Two words, one command, forever.
 */
const COMMANDS = { signup, login, logout, whoami, apps, status, logs, errors, diagnose, env, patch, rollback, exec, open, init, check, ship: deploy, deploy, reship: redeploy, redeploy, "__deploy-worker": deployWorker };

(async () => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return usage(rest.includes("--all") || rest.includes("-a"));
  const fn = COMMANDS[cmd];
  if (!fn) { info(red(`unknown command: ${cmd}`)); usage(); process.exit(1); }
  const args = parse(rest);
  args._cmd = cmd;
  await fn(args);
})().catch((e) => die(e && e.message ? e.message : String(e)));
