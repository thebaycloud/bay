#!/usr/bin/env node
"use strict";

/*
 * bay — the ship/debug surface for a coding agent.
 * Designed for agents, not humans: no interactive prompts, --json everywhere,
 * token auth (a human logs in once, the agent inherits the token), stdout=data,
 * stderr=logs, meaningful exit codes.
 *
 * THE OLD NAME STILL WORKS, EVERYWHERE, AND IS NOT DEPRECATED.
 *
 * The command is `bay`; package.json also installs it as `supersonic`. The
 * config is ~/.bay; ~/.supersonic is still read. The variables are BAY_TOKEN and
 * BAY_URL; SUPERSONIC_TOKEN and SUPERSONIC_URL are still honoured. Every one of
 * those pairs exists because the old spelling is written into scripts, CI
 * configs and agent prompts that nobody is going to edit, and a rename that
 * silently stops reading them does not read as a rename — it reads as the
 * platform signing you out and losing your account.
 *
 * The wire is a different question and the answer is no. `x-supersonic-*`
 * headers, `SUPERSONIC_RUN`, `SUPERSONIC_CODE_BUCKET` and `supersonic.json` are
 * what the CONTROL PLANE reads, not what a person types. Renaming them here
 * would break every deploy against a server that has not been renamed on the
 * same afternoon, so they stay until the server moves first.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { readEnvFiles, selectEnv, encodeEnvHeader } = require("./lib/envfile");
const { joinExecArgs } = require("./lib/exec-args");
const { whoHeader } = require("./lib/who");
const brand = require("./lib/brand");
const { deletionRefusal } = require("./lib/confirm");
const { configDirIn, envVarFrom } = require("./lib/home");

/**
 * Where the session lives: ~/.bay, unless ~/.supersonic is the one that exists.
 *
 * Not "read both and merge" — that would have two files disagreeing about which
 * account you are, with the winner decided by the order of two lines. The rule
 * is: the new directory if it is there, otherwise the old one if IT is there,
 * otherwise the new one. So an existing user stays signed in and keeps writing
 * to the file they already have, and a new one never creates the old name.
 */
const CFG_DIR = configDirIn(os.homedir(), fs.existsSync, path.join);
const CFG = path.join(CFG_DIR, "config.json");
const DEFAULT_URL = "https://app.supersonic.cv";

/**
 * A variable under its new name, falling back to the old one.
 *
 * `BAY_TOKEN` is the name now; `SUPERSONIC_TOKEN` is what is exported in every
 * CI job that already ships to this platform. The new name wins when both are
 * set, which is the only sane precedence: somebody who set both was migrating.
 */
function envVar(name) {
  return envVarFrom(process.env, name);
}

// ---------- output ----------
// A reader that stops reading — `bay check | head -5`, an agent piping into
// grep — closes the pipe under us, and Node turns that into an unhandled EPIPE:
// twenty lines of stack trace printed over the output that was actually asked for,
// and a non-zero exit that reads as the command having failed. It did not; the
// reader got what it wanted and left.
for (const s of [process.stdout, process.stderr]) s.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), red = c("31"), cyan = c("36"), yellow = c("33");
// Set once a deploy knows its slug: every progress line is also appended to
// <config dir>/deploys/<slug>.log, so a build survives the terminal it was
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
      $comment: "Written by bay after a successful ship. Safe to commit, safe to delete.",
      slug: slug || undefined,
      decided,
    }, null, 2) + "\n";
    const path = require("node:path").join(process.cwd(), LOCKFILE);
    if (require("node:fs").existsSync(path) && require("node:fs").readFileSync(path, "utf8") === body) return;
    require("node:fs").writeFileSync(path, body);
    info(dim(`  wrote ${LOCKFILE} — what this ship decided, so you can see it and change it`));
  } catch { /* never fail a green deploy over a note about it */ }
}
function json(o) { print(JSON.stringify(o, null, 2)); }

// ---------- config ----------
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } }
function saveCfg(cfg) { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); }
function baseUrl() { return (envVar("URL") || loadCfg().url || DEFAULT_URL).replace(/\/$/, ""); }
function token() { return envVar("TOKEN") || loadCfg().token || ""; }

// ---------- api ----------
/**
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] Don't narrate a 200-with-an-error-field. Some
 *   routes — the database one — answer 200 and put the failure in the body,
 *   because for them "this database does not exist" is an answer rather than a
 *   transport failure. Their callers print it themselves, and without this the
 *   reader sees the same sentence twice, once dim and once red.
 */
async function api(pathname, { method = "GET", body, stream = false, quiet = false } = {}) {
  const tok = token();
  if (!tok) die("not authenticated — run: bay login");
  const res = await fetch(baseUrl() + pathname, {
    method,
    headers: {
      Authorization: "Bearer " + tok,
      ...brand.protoHeaders("who", whoHeader(process.env)),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) die("token invalid or expired — run: bay login");
  if (res.status === 403) die("forbidden — you don't own that app (or it doesn't exist)");
  if (stream) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error) die(data.error);
  if (data.error && !quiet) info(dim("! " + data.error));
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
  const url = (args.url || envVar("URL") || DEFAULT_URL).replace(/\/$/, "");
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
  const url = (args.url || envVar("URL") || DEFAULT_URL).replace(/\/$/, "");
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
      res.end("<body style='font-family:monospace;text-align:center;padding-top:20vh'><h2>&#10003; Bay CLI connected</h2><p>You can close this tab and return to your terminal.</p></body>");
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
  if (!tok) return die(`${verb} timed out — try again, or use: bay login --token <token>`);
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
  if (!tok) die("sign-in timed out — run `bay login`, then `bay ship` again");
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
  if (args.json) return json({ loggedIn: res.ok, url: baseUrl(), email: acct.email || null, plan: acct.plan || null, source: envVar("TOKEN") ? "env" : "config" });
  if (!res.ok) return die("token invalid — run: bay login");
  const src = envVar("TOKEN") ? "env token" : "saved token";
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
  if (!list.length) { info("no apps yet — ship one with: bay ship"); return; }
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
  // The server's own answer, for the same reason `open` asks for it: the root is
  // not this file's to know.
  print(dim("  url      ") + (d.url || `https://${app}.supersonic.cv`));
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
    if (!Object.keys(set).length) die("usage: bay env <app> set KEY=VALUE [KEY2=VALUE2]");
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
    if (!rest.length) die("usage: bay env <app> unset KEY [KEY2]");
    const d = await api(`/api/apps/${app}/env`, { method: "POST", body: { unset: rest } });
    print(green("✓ ") + `unset ${rest.join(", ")}${d?.note ? ` — ${d.note}` : ""}`);
    if (args.json) json(d);
    return;
  }
  die(`unknown env subcommand: ${sub}`);
}

// ---------- the rest of the platform ----------
//
// Everything below exists because the answer to "can I do that from the CLI?"
// has to be yes. A command that sends someone to the dashboard for one setting
// sends an AGENT nowhere at all: it cannot open a browser, cannot click, and
// cannot tell its user what it could not do. Domains, access, the database, the
// connected repository, the plan and the tokens were all dashboard-only, and
// each of them is a place an agent-driven deploy stopped.
//
// None of them needed a new endpoint. The control plane resolves a Bearer token
// exactly where it resolves a session cookie (apps/web/lib/session.ts), so every
// route the dashboard calls already answers a CLI that asks.

/**
 * The custom domains attached to one app: read them, attach one, detach one.
 *
 * The DNS record is printed by `printRecord` from what the SERVER decided, never
 * from a rule this file carries. An apex cannot be a CNAME and a subdomain
 * should be one, and that decision lives in apps/web/lib/dns-record.ts — a copy
 * here would agree today and, the first time its public-suffix list grows, tell
 * somebody to create a record their registrar refuses.
 */
async function domains(args) {
  const app = needApp(args);
  const [, sub, host] = args._;

  if (!sub) {
    const d = await api(`/api/apps/${app}/domains`);
    if (args.json) return json(d);
    const list = d.domains || [];
    if (!list.length) {
      info(`no domain connected — ${bold(`bay domains ${app} add <hostname>`)}`);
      if (d.allowed === false) info(dim("custom domains are not on this account's plan"));
      return;
    }
    for (const dom of list) printDomain(dom, d.dns);
    // Said once, under the list, and only when it is true. A private app cannot
    // answer at a domain it does not own the cookie for — the edge sends those
    // visitors back to the platform address — so a domain that is `live` and an
    // app that is private is a working certificate onto a redirect.
    if (d.visibility && d.visibility !== "public") {
      print("");
      info(dim(`${app} is ${d.visibility}: visitors at a custom domain are sent back to its platform address to sign in.`));
      info(dim(`make it public with: bay share ${app} public`));
    }
    return;
  }

  if (sub === "add") {
    if (!host) die(`usage: bay domains ${app} add <hostname>`);
    const d = await api(`/api/apps/${app}/domains`, { method: "POST", body: { hostname: host } });
    if (args.json) return json(d);
    print(green("✓ ") + `${d.domain.hostname} is attached to ${app}`);
    printDomain(d.domain, d.dns);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    if (!host) die(`usage: bay domains ${app} remove <hostname>`);
    const d = await api(`/api/apps/${app}/domains?hostname=${encodeURIComponent(host)}`, { method: "DELETE" });
    if (args.json) return json(d);
    print(green("✓ ") + `${host} detached — its certificate is gone, so stop pointing DNS at us`);
    return;
  }

  die(`unknown: domains ${sub}\nusage: bay domains <app> [add <hostname> | remove <hostname>]`);
}

/** One domain, its state, and — while it is not live — the record to create. */
function printDomain(d, dns) {
  const state = {
    live: () => `${green("● live")}`,
    securing: () => `${yellow("◐ securing")} ${dim("— the certificate is being issued, usually a few minutes")}`,
    pending_dns: () => `${yellow("○ waiting")} ${dim("— for the DNS record below")}`,
    failed: () => `${red("✗ failed")}`,
  }[d.status];
  print(`${bold(d.hostname)}  ${state ? state() : dim(d.status)}`);
  if (d.detail) print(dim("  " + d.detail));
  if (d.status !== "live") printRecord(d, dns);
}

/**
 * The record, as the fields a DNS panel actually asks for.
 *
 * `guessed` is printed rather than hidden. It means the server could not place
 * the name against its suffix list and fell back to `A`, which works everywhere
 * — but somebody moving a subdomain would rather know they can use a CNAME.
 */
function printRecord(d, dns) {
  const r = d.record;
  if (!r) {
    // An older control plane, which sends `dns` without deciding the record. Both
    // options, plainly, rather than a rule this file would have to keep.
    if (!dns) return;
    print(dim("  create ONE of these where your DNS is managed:"));
    print(dim("    A     @    ") + dns.ip + dim("   (at the root of the domain)"));
    print(dim("    CNAME <sub> ") + dns.cname + dim("   (for a subdomain)"));
    return;
  }
  print(dim("  create this record where your DNS is managed:"));
  print(dim("    type  ") + r.type);
  print(dim("    name  ") + r.name + (r.name === "@" ? dim("   (the root of the domain)") : ""));
  print(dim("    value ") + r.value);
  if (r.guessed) print(dim("    (A works at any name; a subdomain could also use a CNAME to " + (dns ? dns.cname : "its platform address") + ")"));
}

/**
 * Who can open the app: the visibility, the people, and the rules.
 *
 * `bay share <app>` alone shows it. Everything else is one word — a
 * visibility, or add/remove with an address or a @domain — and the parsing is in
 * lib/share-args.js, because reading `acme.com` as a person instead of as a
 * company is a mistake that would not look like one afterwards.
 */
async function share(args) {
  const app = needApp(args);
  const { parseShare, shareBody } = require("./lib/share-args");
  const action = parseShare(args._.slice(1));
  if (action.kind === "error") die(action.why);

  const path = `/api/apps/${app}/share`;
  const d =
    action.kind === "show" ? await api(path)
      : action.kind === "visibility" ? await api(path, { method: "POST", body: { visibility: action.visibility } })
        : await api(path, { method: "POST", body: shareBody(action) });

  if (args.json) return json(d);

  if (action.kind === "add") {
    print(green("✓ ") + (action.audience === "email"
      ? `${action.value} can open ${app} — they have been emailed the link`
      : `anyone with an @${action.value} address can open ${app}`));
  }
  if (action.kind === "remove") print(green("✓ ") + `removed ${action.value}`);
  printAccess(app, d);
}

function printAccess(app, d) {
  const said = {
    private: `${red("● private")} ${dim("— only you")}`,
    shared: `${yellow("● shared")} ${dim("— you, and the people and rules below")}`,
    public: `${green("● public")} ${dim("— anyone with the link, no sign-in")}`,
  }[d.visibility];
  print(`${bold(app)}  ${said || dim(String(d.visibility))}`);

  for (const email of d.grants || []) print(dim("  person ") + email);
  for (const domain of d.domains || []) print(dim("  rule   ") + `everyone @${domain}`);
  // Said once, under the rules, because it is the difference between a rule that
  // works and a person who cannot get in: a rule admits an address the identity
  // provider PROVED — Google, or a verified GitHub address. Somebody who signed
  // up with a password at the same domain is refused, and the page they see says
  // to sign in with Google instead.
  if ((d.domains || []).length) info(dim("  a rule admits verified addresses only — password signups at that domain are not let in"));

  // A pending request is somebody who is currently looking at a locked door. It
  // is the only line here that is waiting on the reader, so it says the command
  // that answers it.
  for (const email of d.requests || []) {
    print(`${yellow("  asking")} ${email} ${dim(`— bay share ${app} add ${email}`)}`);
  }

  if (d.workspaceDomain && !(d.domains || []).includes(d.workspaceDomain)) {
    info(dim(`  everyone at your company: bay share ${app} add @${d.workspaceDomain}`));
  }
}

/**
 * The app's database, read-only, from here.
 *
 * `db <app>` lists the tables, `db <app> <table>` reads rows, and `--sql`
 * asks one SELECT. Read-only is the server's rule, not a convention this file
 * follows: the route refuses anything that does not begin with SELECT, and
 * refuses a second statement. Which is the right rule — a CLI that could DROP a
 * production table on a typo'd argument is not a tool an agent should be handed.
 */
async function db(args) {
  const app = needApp(args);
  const [, table] = args._;
  const { renderTable } = require("./lib/rows");

  if (args.sql) {
    const d = await api(`/api/apps/${app}/db`, { method: "POST", body: { sql: String(args.sql) }, quiet: true });
    if (args.json) return json(d);
    if (d.error) die(d.error);
    if (!(d.rows || []).length) { info("no rows"); return; }
    for (const l of renderTable(d.columns, d.rows)) print(l);
    return;
  }

  if (!table) {
    const d = await api(`/api/apps/${app}/db`, { quiet: true });
    if (args.json) return json(d);
    if (d.error) die(d.error);
    const list = d.tables || [];
    if (!list.length) { info("this database has no tables yet"); return; }
    info(dim(d.database));
    for (const t of list) {
      const n = t.rowsExact ? String(t.rows) : `~${t.rows}`;
      print(`${bold(t.name.padEnd(28))} ${dim(n.padStart(8) + " rows  " + t.columns + " cols")}`);
    }
    info(dim(`\nread one: bay db ${app} <table>`));
    return;
  }

  const qs = new URLSearchParams({ table });
  if (args.limit) qs.set("limit", String(args.limit));
  if (args.offset) qs.set("offset", String(args.offset));
  const d = await api(`/api/apps/${app}/db?${qs.toString()}`, { quiet: true });
  if (args.json) return json(d);
  if (d.error) die(d.error);
  const names = (d.columns || []).map((c) => (typeof c === "string" ? c : c.name));
  for (const l of renderTable(names, d.rows || [])) print(l);
  // The count is the reason `--limit`/`--offset` exist, so it is said even when
  // one page is the whole table.
  const shown = (d.rows || []).length;
  info(dim(`${shown} of ${d.totalExact ? d.total : "~" + d.total} rows${d.orderedBy ? ", " + d.orderedBy : ""}`));
}

/**
 * The repository this app follows, and whether a push to it ships.
 *
 * Connecting one is still a browser flow — it installs a GitHub App, which is
 * GitHub's consent screen and cannot be automated away. Everything after that
 * is here: which branch, whether pushes deploy, and disconnecting.
 */
async function git(args) {
  const app = needApp(args);
  const [, sub] = args._;
  const path = `/api/apps/${app}/git`;

  if (sub === "disconnect") {
    const d = await api(path, { method: "DELETE" });
    if (args.json) return json(d);
    print(green("✓ ") + `${app} no longer follows a repository — it keeps running, and reship still works`);
    return;
  }

  const wantsBranch = typeof args.branch === "string";
  const wantsAuto = args.auto !== undefined;
  if (wantsBranch || wantsAuto) {
    const body = {};
    if (wantsBranch) body.branch = args.branch;
    if (wantsAuto) {
      const on = args.auto === true || /^(on|yes|true)$/i.test(String(args.auto));
      const off = /^(off|no|false)$/i.test(String(args.auto));
      if (!on && !off) die(`--auto takes on or off, not "${args.auto}"`);
      body.autoDeploy = on;
    }
    const d = await api(path, { method: "PUT", body });
    if (args.json) return json(d);
    print(green("✓ ") + `${d.repo} · ${d.branch} · ${d.autoDeploy ? "ships on push" : "manual"}`);
    return;
  }

  const d = await api(path);
  if (args.json) return json(d);
  if (!d.connected) {
    info(`${app} follows no repository`);
    info(dim(`connect one at ${baseUrl()}/apps/${app} — it installs a GitHub App, which needs a browser`));
    return;
  }
  print(`${bold(d.repo)}  ${dim(d.url)}`);
  print(dim("  branch ") + d.branch);
  print(dim("  push   ") + (d.autoDeploy ? green("ships automatically") : "does nothing until you reship"));
}

/**
 * The plan, and every meter that can stop a deploy.
 *
 * `whoami` says which account. This says what that account may still do — which
 * is the question behind every 402 the API returns, and the one an agent should
 * be able to answer before it starts an eleven-minute build.
 */
async function plan(args) {
  const d = await api("/api/account");
  if (args.json) return json(d);

  print(`${bold(d.plan || "free")}${d.locked ? red("  · locked") : ""}${d.email ? dim("  " + d.email) : ""}`);
  const u = d.usage || {};
  // null is the wire form of unlimited — see the `cap()` in the account route.
  const meter = (label, used, max) =>
    print(dim("  " + label.padEnd(12)) + `${used ?? 0}${max === null || max === undefined ? dim(" of unlimited") : dim(" of " + max)}`);
  meter("apps", u.apps, u.maxApps);
  meter("public", u.publicApps, u.maxPublicApps);
  meter("builds", u.builds, u.monthlyBuilds);
  meter("agent runs", u.agentRuns, u.monthlyAgentRuns);

  const f = d.features || {};
  const has = (on, name) => (on ? green("✓ ") + name : dim("· " + name));
  print("  " + [has(f.autoFix, "auto-fix"), has(f.customDomains, "custom domains"), has(f.canRemoveBadge, "badge off")].join("   "));
  info(dim(`\nchange plan: ${baseUrl()}/settings`));
}

/**
 * Every CLI holding a key to this account, and the way to take one back.
 *
 * A token is minted in a browser — that is the whole point of the loopback flow
 * — but revoking one must not need the same browser. A laptop that is gone, a CI
 * runner that was decommissioned, a token pasted into the wrong terminal: those
 * are moments when a person wants one command, not a dashboard.
 */
async function tokens(args) {
  const [sub, id] = args._;

  if (sub === "revoke") {
    if (!id) die("usage: bay tokens revoke <id>   (ids come from: bay tokens)");
    const d = await api("/api/account/tokens", { method: "POST", body: { revoke: id } });
    if (args.json) return json(d);
    // `ok` is read rather than assumed. This route answers 404 for an id that is
    // not yours, which `api` turns into a refusal — but its sibling
    // /api/cli/token answers 200 with `ok: false` for the same case, and a
    // command that printed ✓ on that would be telling somebody a key had been
    // taken back when it had not.
    if (d.ok === false) die(`no token ${id} on this account — check: bay tokens`);
    print(green("✓ ") + `revoked ${id} — that CLI is signed out`);
    return;
  }

  const d = await api("/api/account/tokens");
  const list = d.tokens || [];
  if (args.json) return json(list);
  if (!list.length) { info("no CLI tokens on this account"); return; }
  for (const t of list) {
    const last = t.last_used_at ? new Date(t.last_used_at).toISOString().slice(0, 10) : "never";
    print(`${dim(t.id)}  ${bold((t.name || "cli").padEnd(20))} ${dim("added " + String(t.created_at).slice(0, 10) + " · last used " + last)}`);
  }
  info(dim("\nrevoke one: bay tokens revoke <id>"));
}

/**
 * The repair agent's fix, as a patch, on stdout and nothing else.
 *
 * The agent's edits happen in the copy of the repo the server unpacked, which is
 * deleted when the deploy ends — so a rescued app left this folder still broken
 * and the next deploy shipped the same code again. Straight to stdout so it can
 * be piped: `bay patch <app> | git apply`. Every other word this command
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
  // `revision` was Cloud Run's word for it and there are no revisions any more:
  // a rollback is one write moving `desired_release` to the version before, and
  // the reconciler places it. Printing `d.revision` here said "now serving
  // undefined" the moment the route stopped being Cloud-Run-shaped.
  print(green("✓ ") + `rolled back to version ${d.version} — the fleet is placing it now`);
  // Said every time, because it is the half a rollback cannot do. The API
  // returns the same sentence; printing the server's own wording keeps the two
  // from drifting into different promises.
  if (d.note) print(dim("  " + d.note));
}

/**
 * Delete an app. There is no undo and there is no prompt.
 *
 * The confirmation is a flag rather than a question because this CLI has none —
 * "designed for agents, not humans" is the first thing index.js says about
 * itself. `lib/confirm.js` holds the decision and the wording; this function is
 * the call.
 */
async function del(args) {
  const app = needApp(args);
  const refusal = deletionRefusal(app, args);
  if (refusal) die(refusal);
  const d = await api(`/api/apps/${app}/delete`, { method: "POST" });
  if (args.json) return json(d);
  print(green("✓ ") + `${app} deleted — its database, bucket and images went with it`);
}

async function exec(args) {
  const app = needApp(args);
  const command = joinExecArgs(args._raw || []);
  if (!command) die('usage: bay exec <app> -- <command>   e.g. bay exec myapp -- node -v');
  info(dim(`exec in ${app} (isolated instance, app env + db attached)`));
  info(dim("cold-starting a one-off container — can take ~30–60s…"));
  const d = await api(`/api/apps/${app}/exec`, { method: "POST", body: { command } });
  if (args.json) return json(d);
  if (d.output) print(d.output);
  else info(dim("(no output)"));
  if (d.exitCode) { info(red(`exited ${d.exitCode}`)); process.exitCode = d.exitCode; }
}

/**
 * Open the app in a browser, at the address the SERVER says it has.
 *
 * This used to build `https://<app>.supersonic.cv` here. That is one root
 * hardcoded into a published npm package: it survives a rebrand, it ignores
 * every custom domain the app has, and it cannot be corrected without a release.
 * The app row knows its own URL — ask it, and fall back to the old spelling only
 * if the answer is missing.
 */
async function open(args) {
  const app = needApp(args);
  const d = await api(`/api/apps/${app}`);
  const url = d.url || `https://${app}.supersonic.cv`;
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
    return die(`${r.CONFIG_FILENAME} already exists — read it, or \`bay init --force\` to overwrite it with a fresh draft`);
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
    print(yellow("! ") + "and `bay check` would already fail on it:");
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
const SHIP_FLAGS = ["name", "run", "wait", "no-env", "github", "repo", "prebuilt", "json", "help"];

/**
 * What the app is called.
 *
 * The folder's name by default, which is right nearly always — you ship from the
 * project's root and that is what the project is called. `--name` exists because
 * the dashboard asks for a name before it hands you this command, and a name the
 * user typed there has to survive into the deploy; without the flag the CLI would
 * refuse the whole command (SHIP_FLAGS above is a hard list) and the name would be
 * silently the folder's anyway.
 *
 * The server decides the SLUG from this — see resolveSlug — and reuses the one it
 * already gave a deploy of the same name, which is what makes a redeploy land on
 * the same address instead of creating a second app beside the first.
 */
function appNameFrom(args) {
  const raw = typeof args.name === "string" && args.name.trim() ? args.name : path.basename(process.cwd());
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "app";
}

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
      `bay ship understands.\n` +
      `  It takes: ${SHIP_FLAGS.map((f) => "--" + f).join(", ")}\n` +
      "  Nothing was shipped. Fix the flag and run it again."
    );
  }
  // One command: sign in automatically the first time, then deploy. No separate
  // `bay login` step required.
  await ensureAuth();
  // URL-first by default: a live link appears in ~0.1s — the address answers with
  // the room, which draws the build as it happens — while the real build runs on
  // the server. `--prebuilt` opts back into the old build-here-and-upload path.
  if (!args.prebuilt) return urlFirstDeploy(args);
  // GitHub / a git URL is a pickable option — the default is straight from this folder.
  if (args.github || args.repo) {
    let repo = args.repo;
    if (!repo) { repo = await gitOrigin(); if (!repo) die("no git remote 'origin' found here — pass --repo <url>"); }
    info(cyan("▸ ") + "shipping from " + bold(repo));
    const res = await api("/api/deploy", { method: "POST", body: { repo }, stream: true });
    return consumeDeploy(res, args);
  }
  // Default: deploy this folder straight from your computer — no git, no setup.
  const appName = appNameFrom(args);

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
  if (!tok) die("not authenticated — run: bay login");
  const res = await fetch(baseUrl() + "/api/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tok,
      "Content-Type": "application/gzip",
      ...brand.protoHeaders("upload", "1"),
      ...brand.protoHeaders("app", appName),
      ...brand.protoHeaders("who", whoHeader(process.env)),
    },
    body,
  });
  if (res.status === 401) die("token invalid or expired — run: bay login");
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
  const folderName = appNameFrom(args);

  // 1) reserve the slug → a URL right away (live immediately, any stack)
  // The repo names the app when it is a repo deploy, exactly as before — a
  // folder name sent alongside would change the slug every existing GitHub
  // deploy resolves to. `--name` overrides either, because it was typed.
  const reserveBody = repo ? { repo } : { name: folderName };
  if (args.name) reserveBody.name = folderName;
  const r = await api("/api/deploy/reserve", { method: "POST", body: reserveBody });
  const { slug, url } = r;
  // Not "✓ live". Nothing has been built yet — this is the moment the slug was
  // reserved, and the build can still fail. Eight agents in a row read that
  // checkmark as "done", stopped watching, and reported a working deploy for an
  // app that never came up. The URL is real and does work from here (it serves a
  // build page), so it stays; what leaves is the claim that the app is on it.
  print(dim("⧗ ") + "shipping — your app will be live at " + bold(url));

  // Default: DON'T hold the caller hostage for the whole build. A coding agent
  // that runs `bay deploy` should get the live URL and its prompt back in
  // ~1s, not sit blocked for two minutes. So the build is handed to a detached
  // background worker that keeps the deploy connection open (the server keeps
  // building, CPU allocated, until it lands) and logs to
  // <config dir>/deploys/<slug>.log. Pass --wait to stay attached and stream the
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
    print(dim("  build finishing in the background · watch: ") + bold(`bay logs ${slug} --follow`));
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
  // `bay logs` then reads from the server and shows the RUNNING app's logs,
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
      ...brand.protoHeaders("upload", "1"),
      ...brand.protoHeaders("app", folderName),
      ...brand.protoHeaders("slug", slug),
      ...brand.protoHeaders("who", whoHeader(process.env)),
    };
    // How to run the app in production, worked out by the agent. Encoded because it
    // has spaces/flags. The runner uses it as SUPERSONIC_RUN.
    if (runCmd) Object.assign(headers, brand.protoHeaders("run", encodeURIComponent(runCmd)));
    // The upload's body is the tarball, so the vars go in a header. Past what Cloud Run
    // will carry there we say so and set nothing: silently dropping half an environment
    // would surface later as an app that is broken for no visible reason.
    const envHeader = encodeEnvHeader(envVars);
    if (envHeader) Object.assign(headers, brand.protoHeaders("env", envHeader));
    else if (envKeys.length) info(red("! ") + ".env is too large to send with the build — set them after it lands: " + bold(`bay env ${slug} set KEY=VALUE`));

    // The bytes go to the bucket, not through the API. Attempted for every size
    // rather than only over the cap, so the path a large project depends on is
    // the same one every deploy exercises — a fallback that only runs for the
    // biggest uploads is a fallback nobody finds out is broken.
    const placed = await uploadSourceToBucket(body);
    if (placed) {
      Object.assign(headers, brand.protoHeaders("source-object", placed.object));
      Object.assign(headers, brand.protoHeaders("source-key", placed.key));
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
    if (res.status === 401) { cleanup(); die("token invalid or expired — run: bay login"); }
  }
  await consumeDeploy(res, args, slug);   // when the build goes live the proxy serves it on `url`
  print(green("✓ ") + "build is live at " + bold(url));
  cleanup();
}

/** The detached background worker spawned by the default deploy. Finishes the
 * build after the foreground command has already returned the live URL. */
async function deployWorker() {
  const slug = process.env.SS_BG_SLUG, url = process.env.SS_BG_URL;
  if (!slug || !url) die("ship worker: missing context");
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
  if (!tok) die("not authenticated — run: bay login");
  const res = await fetch(baseUrl() + "/api/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tok,
      "Content-Type": "application/gzip",
      ...brand.protoHeaders("upload", "1"),
      ...brand.protoHeaders("prebuilt", "1"),
      ...brand.protoHeaders("hash", hash),
      ...brand.protoHeaders("app", appName),
      ...brand.protoHeaders("who", whoHeader(process.env)),
    },
    body,
  });
  if (res.status === 401) die("token invalid or expired — run: bay login");
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
  if (!d.repo) die(`${app} was shipped from a computer — run \`bay ship\` in its folder to send an update`);
  info(cyan("▸ ") + "reshipping " + bold(app));
  // The slug travels, because the server would otherwise resolve one from the
  // repo URL — and an app created under a name of its own (the dashboard asks
  // for one) does not answer to that name, so the redeploy would build a
  // SECOND app beside the one being redeployed.
  const res = await api("/api/deploy", { method: "POST", body: { repo: d.repo, slug: app }, stream: true });
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
  // The salt is NOT renamed, and must not be. It is half of a key the control
  // plane derives with the same literal (apps/web/lib/deploy-runs.ts, KEY_SALT):
  // change it here and every upload decrypts to garbage on a server that still
  // says the old word.
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
    if (r.status === 401) die("token invalid or expired — run: bay login");
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
  if (!put.ok) die(`upload failed (${put.status}) — the code never left your machine, so nothing was shipped`);
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
  // The server's id for this deploy, announced as the stream's first event. It
  // is what joins this run to its rows in deploy_stages / deploy_events /
  // deploy_failures; without it a caller measuring a deploy has only the slug
  // and a guess at the time window.
  let runId = null;
  // A TRANSPORT FAILURE IS NOT A VERDICT ON THE DEPLOY, and it used to be
  // reported as one. `reader.read()` throws when the response body is cut —
  // undici's message for that is the single word "terminated" — and with nothing
  // catching it, that word travelled all the way to the user as `✗ terminated`
  // for a deploy that had SUCCEEDED. Observed on 13 Aug: the job completed in
  // 1m3s, the app was live on the new digest, and the CLI called it a failure
  // because the stream had been cut at five minutes.
  //
  // The comment below already says what to do about a stream that ends without a
  // result — "that is a fact about this connection, not about the deploy" — and
  // an exception is the same fact arriving by a different door. So it lands in
  // the same place: stop reading, and go ask the server what actually happened.
  let streamError = null;
  try {
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
      if (ev.runId) runId = ev.runId;
      if (ev.type === "run") continue;   // bookkeeping, not narration
      if (ev.type === "log") info("  " + dim(ev.line));
      else if (ev.type === "detected") info("  " + cyan(`detected ${ev.stack?.framework || "app"}`));
      else if (ev.type === "done") { writeLockfile(ev.decided, ev.slug); if (args.json) json({ ok: true, slug: ev.slug, url: ev.url, runId }); else print(green("✓ live: ") + ev.url); process.exit(0); }
      else if (ev.type === "error") { if (args.json) json({ ok: false, error: ev.message, slug, runId }); die(ev.message); }
    }
  }
  } catch (e) {
    streamError = e && e.message ? e.message : String(e);
  }
  // The server can answer with a plain JSON error instead of a stream — a plan limit,
  // a rejected request. That is not a build that timed out, and saying so sent someone
  // to `bay logs` looking for a failure that never happened. If what arrived
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
      if (args.json) json({ ok: true, slug, url, runId });
      else print(green("✓ live: ") + url);
      process.exit(0);
    }
    if (deploy?.status === "failed") {
      const why = deploy.error || deploy.stage || "the deploy failed";
      if (args.json) json({ ok: false, slug, error: why, runId });
      die(why);
    }
    // Still building when we ran out of patience. Say that, rather than calling a
    // deploy failed that may be minutes from landing.
    if (args.json) json({ ok: false, slug, error: "still building — connection lost", pending: true, runId });
    die(`lost contact with the build and it was still running after 3 minutes. It may still land — check: bay logs ${slug}`);
  }

  // No slug to ask about — the stream died before it named one, so there is
  // nothing to follow. The transport error is worth printing HERE, and only
  // here: it is all the information there is.
  const lost = streamError ? ` (the connection failed: ${streamError})` : "";
  if (args.json) json({ ok: false, error: "deploy stream ended without a result", streamError });
  die(`the ship ended without confirming it went live${lost} — the build may have failed or timed out. Check: bay apps  ·  bay logs <app>`);
}

// ---------- helpers ----------
function needApp(args) { const a = args._[0]; if (!a) die("missing app name — usage: bay " + args._cmd + " <app>"); return a; }
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
    print(`${bold("bay")} — publish your app in one command

${bold("just run this in your project folder:")}
  ${green("bay ship")}              publish this folder and print the live URL
                        (opens a browser to sign in the first time;
                         ${dim("`bay deploy` is the same command")})

${bold("before you ship")} ${dim("(local, ~2s, no cloud)")}
  bay init              write a draft supersonic.json from this repo
  bay check             what each phase would run, and what would fail

${bold("when something's wrong")}
  bay logs <app>        recent logs
  bay diagnose <app>    AI fix-prompt for your coding agent
  bay apps              list your apps
  bay open <app>        open the app in a browser
  bay login             sign in manually

${bold("the rest of the platform")} ${dim("(nothing here needs the dashboard)")}
  bay share <app> public          who can open it
  bay domains <app> add <host>    connect a domain you own
  bay db <app>                    read its database

${dim("more commands: bay help --all  ·  --json on any command for machine output")}`);
    return;
  }
  print(`${bold("bay")} — ship & debug from your coding agent

${bold("setup")}
  bay signup                            create an account (opens browser, one time)
  bay login [--url <u>] [--token <t>]   authenticate (browser, one time)
  bay logout
  bay whoami

${bold("author")} ${dim("(local: no cloud, no build, no model — about two seconds)")}
  bay init [dir] [--force]               write a DRAFT supersonic.json for an agent to correct
  bay check [dir]                        resolve + validate it, and print what each phase would run

${bold("ship")} ${dim("(URL-first: a live link in ~0.1s, the build drawn on it while it runs)")}
  bay ship                               ship this folder — live URL now, build behind it
  bay ship --name <name>                 what to call it (default: this folder's name)
  ${dim("(`bay deploy` does the same thing and always will — every flag here works with either)")}
  bay ship --run "<prod start cmd>"      how to run it in PROD — you know the stack
                                         e.g. --run "uvicorn main:app --host 0.0.0.0 --port $PORT"
  bay ship --wait                        stay attached and stream the build (default: returns once live)
  bay ship --no-env                      don't carry .env up (default: sets vars your app doesn't have yet)
  bay ship --github [--repo <url>]       ship from GitHub / a git URL instead
  bay ship --prebuilt                    old path: build here, upload the result
  bay reship <app>                       rebuild from the app's source
  bay patch <app>                        the repair agent's fix, to pipe into git apply
  bay rollback <app>                     roll back to the previous version
  bay delete <app> --yes                 delete an app (its database and bucket are kept)

${bold("inspect")}
  bay apps                               list your apps
  bay status <app>                       revision, url, env, database
  bay logs <app> [--severity error] [--limit 50] [--since 1h] [--follow]
  bay errors <app>                       production errors (7d)
  bay diagnose <app> [--error "..."]     AI fix-prompt for your agent
  bay exec <app> -- <command>            run a command in the app's env (isolated)

${bold("config")}
  bay env <app>                          list env var keys
  bay env <app> set KEY=VALUE            set env var(s)
  bay env <app> unset KEY                remove env var(s)
  bay open <app>                         open the app in a browser

${bold("who can open it")}
  bay share <app>                        the visibility, the people, the rules, who is asking
  bay share <app> private|shared|public  change it
  bay share <app> add ada@acme.com       invite one person (they get an email)
  bay share <app> add @acme.com          everyone with an address there
  bay share <app> remove <email|@domain>

${bold("its own address")}
  bay domains <app>                      what is attached, and the DNS record to create
  bay domains <app> add acme.com         attach a domain you own
  bay domains <app> remove acme.com

${bold("its data")}
  bay db <app>                           the tables, with row counts
  bay db <app> <table> [--limit 50] [--offset 0]
  bay db <app> --sql "select ..."        one read-only statement

${bold("shipping from GitHub")}
  bay git <app>                          the repo it follows, and whether a push ships
  bay git <app> --branch main --auto on
  bay git <app> disconnect

${bold("the account")}
  bay plan                               plan, every limit, and what is left of it
  bay tokens                             every CLI signed in to this account
  bay tokens revoke <id>                 take one back

${dim("global: --json for machine-readable output · $BAY_TOKEN overrides login")}`);
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
const COMMANDS = { signup, login, logout, whoami, apps, status, logs, errors, diagnose, env, domains, domain: domains, share, access: share, db, git, plan, account: plan, tokens, patch, rollback, exec, open, init, check, ship: deploy, deploy, reship: redeploy, redeploy, delete: del, rm: del, "__deploy-worker": deployWorker };

(async () => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return usage(rest.includes("--all") || rest.includes("-a"));
  const fn = COMMANDS[cmd];
  if (!fn) { info(red(`unknown command: ${cmd}`)); usage(); process.exit(1); }
  const args = parse(rest);
  args._cmd = cmd;
  await fn(args);
})().catch((e) => die(e && e.message ? e.message : String(e)));
