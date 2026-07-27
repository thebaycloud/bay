"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planFor, hashDir, hasOutput, nodeVersionWarning } = require("../lib/prebuilt.js");

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-prebuilt-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

// --- the decision

test("a static project with a build command is built here", () => {
  const p = planFor({
    serve: { mode: "static", outputDir: "dist" },
    buildCommand: "npm run build",
    installCommand: "npm ci",
  });
  assert.equal(p.mode, "build");
  assert.equal(p.outputDir, "dist");
  assert.equal(p.buildCommand, "npm run build");
});

test("a static project with nothing to build is uploaded as-is", () => {
  const p = planFor({ serve: { mode: "static", outputDir: "." }, buildCommand: null });
  assert.equal(p.mode, "upload");
  assert.equal(p.outputDir, ".");
});

test("an app that runs a server goes to the cloud", () => {
  // Its artifact is an image, not a directory, and we do not build images on
  // someone else's machine.
  const p = planFor({ serve: { mode: "container" }, buildCommand: "npm run build" });
  assert.equal(p.mode, "cloud");
});

test("a detector answer with no serve field goes to the cloud", () => {
  // An older server, or a stack the detector could not place: fall back, never guess.
  assert.equal(planFor({}).mode, "cloud");
  assert.equal(planFor({ serve: null }).mode, "cloud");
  assert.equal(planFor(null).mode, "cloud");
});

// --- the hash

test("the hash matches the server's implementation byte for byte", () => {
  // Both sides hash path + NUL + bytes + NUL, sorted by path. If they ever diverge the
  // skip silently stops working, so this is pinned to a known value.
  const dir = tree({ "index.html": "hello" });
  try {
    const crypto = require("node:crypto");
    const expected = crypto.createHash("sha256")
      .update("index.html").update("\0").update(Buffer.from("hello")).update("\0")
      .digest("hex");
    assert.equal(hashDir(dir), expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("identical output in two places hashes the same", () => {
  const files = { "index.html": "<h1>hi</h1>", "assets/a-1.js": "console.log(1)" };
  const a = tree(files); const b = tree(files);
  try {
    assert.equal(hashDir(a), hashDir(b), "this equality is what makes an unchanged redeploy instant");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("a changed byte changes the hash", () => {
  const a = tree({ "index.html": "one" });
  const b = tree({ "index.html": "two" });
  try {
    assert.notEqual(hashDir(a), hashDir(b));
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

// --- output presence

test("an empty or missing output directory is not usable", () => {
  const empty = tree({});
  try {
    assert.equal(hasOutput(empty), false);
    assert.equal(hasOutput(path.join(empty, "nope")), false);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("a populated output directory is usable", () => {
  const dir = tree({ "index.html": "x" });
  try {
    assert.equal(hasOutput(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- node version

test("a different Node major is warned about, not blocked", () => {
  const w = nodeVersionWarning({ runtime: "node:22" }, "v18.19.0");
  assert.match(w ?? "", /Node 22/);
  assert.match(w ?? "", /Node 18/);
});

test("a matching Node major says nothing", () => {
  assert.equal(nodeVersionWarning({ runtime: "node:22" }, "v22.14.0"), null);
});

test("a non-node runtime says nothing", () => {
  assert.equal(nodeVersionWarning({ runtime: "python:3.12" }, "v22.14.0"), null);
  assert.equal(nodeVersionWarning({}, "v22.14.0"), null);
});
