#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

const CFG_DIR = path.join(os.homedir(), ".supersonic");
const CFG = path.join(CFG_DIR, "config.json");

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return null; } }
function saveCfg(c) { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); }

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}

function makeJar() {
  const jar = {};
  return {
    set(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) { const kv = c.split(";")[0]; const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    },
    header() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); },
  };
}

async function login(args) {
  const url = (args.url || process.env.SUPERSONIC_URL || "http://localhost:3000").replace(/\/$/, "");
  const email = args.email || (await ask("email: "));
  const password = args.password || process.env.SUPERSONIC_PASSWORD || (await ask("password: "));
  const jar = makeJar();
  const csrfRes = await fetch(`${url}/api/auth/csrf`); jar.set(csrfRes);
  const { csrfToken } = await csrfRes.json();
  const cb = await fetch(`${url}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ csrfToken, email, password, json: "true" }).toString(),
    redirect: "manual",
  });
  jar.set(cb);
  const cookie = jar.header();
  if (!cookie.includes("session-token")) { console.error("✗ login failed — check your email/password"); process.exit(1); }
  saveCfg({ url, cookie, email });
  console.log(`✓ logged in to ${url} as ${email}`);
}

async function deploy(args) {
  const cfg = loadCfg();
  if (!cfg) { console.error("not logged in — run: supersonic login"); process.exit(1); }
  let repo = args.repo;
  if (!repo) {
    try { repo = execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
    catch { console.error("no git remote 'origin' found.\nPush your project to GitHub first, or pass --repo <url>."); process.exit(1); }
  }
  console.log(`▸ deploying ${repo}`);
  const res = await fetch(`${cfg.url}/api/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cfg.cookie },
    body: JSON.stringify({ repo }),
  });
  if (res.status === 401 || res.status === 307 || !res.body) { console.error("session expired — run: supersonic login"); process.exit(1); }
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
      const ev = JSON.parse(raw);
      if (ev.type === "log") console.log("  " + ev.line);
      else if (ev.type === "done") { console.log(`\n✓ live: ${ev.url}`); process.exit(0); }
      else if (ev.type === "error") { console.error(`\n✗ ${ev.message}`); process.exit(1); }
    }
  }
}

function whoami() { const c = loadCfg(); console.log(c ? `logged in to ${c.url} as ${c.email}` : "not logged in"); }
function logout() { try { fs.unlinkSync(CFG); } catch { /* ignore */ } console.log("logged out"); }

function usage() {
  console.log(`supersonic — deploy anything in one command

  supersonic login [--url <control-plane>] [--email <e>]
  supersonic deploy [--repo <git-url>]      # defaults to your git origin
  supersonic whoami
  supersonic logout`);
}

const [, , cmd, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) { args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true; }
}

(async () => {
  if (cmd === "login") await login(args);
  else if (cmd === "deploy") await deploy(args);
  else if (cmd === "whoami") whoami();
  else if (cmd === "logout") logout();
  else usage();
})().catch((e) => { console.error("error:", e.message); process.exit(1); });
