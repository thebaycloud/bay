"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { portFromOutput, isListening, listeningPorts, packageManager } = require("../lib/tunnel.js");

// --- reading the port out of a dev server's banner

test("the shapes the common stacks actually print", () => {
  assert.equal(portFromOutput("  ➜  Local:   http://localhost:5173/"), 5173);            // vite
  assert.equal(portFromOutput("- Local:        http://localhost:3000"), 3000);           // next
  assert.equal(portFromOutput("Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C)"), 8000);
  assert.equal(portFromOutput(" * Running on http://0.0.0.0:5000"), 5000);               // flask
  assert.equal(portFromOutput("Listening on [::1]:4321"), 4321);
});

test("a port announced in words is found too", () => {
  // The case that used to yield no preview at all: no host in the line.
  assert.equal(portFromOutput("Server listening on port 8080"), 8080);
  assert.equal(portFromOutput("port=3001 ready"), 3001);
});

test("a host that isn't loopback is not a dev server", () => {
  // Dev servers log upstream URLs; tunnelling to one of those is worse than no tunnel.
  assert.equal(portFromOutput("connected to redis://cache.internal:6379"), null);
  assert.equal(portFromOutput("proxying to https://api.example.com:8443"), null);
});

test("output with no port at all", () => {
  assert.equal(portFromOutput("compiled successfully"), null);
  assert.equal(portFromOutput(""), null);
});

// --- probing, which is what catches the servers that print nothing useful

async function listener() {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test("a port with something on it is seen, a free one is not", async () => {
  const s = await listener();
  try {
    assert.equal(await isListening(s.port), true);
  } finally { await s.close(); }
  // Same port, now closed — nothing is accepting.
  assert.equal(await isListening(s.port), false);
});

test("snapshotting tells busy ports from free ones", async () => {
  const s = await listener();
  try {
    const busy = await listeningPorts([s.port, s.port + 1]);
    assert.equal(busy.has(s.port), true);
    assert.equal(busy.size >= 1, true);
  } finally { await s.close(); }
});

test("the live preview uses the package manager the project committed", () => {
  // Deploying the FastAPI template on 1 Aug ran `npm install` in a repo whose
  // lockfile is bun.lock, dropping a package-lock.json into a clean checkout two
  // minutes after the command had already returned.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  try {
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    assert.equal(packageManager(dir).name, "bun");
    assert.equal(packageManager(dir).install, "bun install");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("each lockfile names its own manager, and npm is the fallback", () => {
  const cases = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"]];
  for (const [file, name] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
    try {
      fs.writeFileSync(path.join(dir, file), "");
      assert.equal(packageManager(dir).name, name);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  try {
    assert.equal(packageManager(bare).name, "npm");
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});
