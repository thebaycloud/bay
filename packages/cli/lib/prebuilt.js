"use strict";
/**
 * Deciding whether to build here or in the cloud, and hashing what we built.
 *
 * The decision is a pure function so it can be tested without running builds, and so
 * the reason for every choice is written down in one place rather than spread through
 * the deploy command.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * What to do with a project, given what the detector said about it.
 *
 * `container` never builds locally: its artifact is an image, not a directory, and we
 * are not building images on someone else's machine.
 */
function planFor(stack) {
  const serve = stack && stack.serve;
  if (!serve || serve.mode !== "static") {
    return { mode: "cloud", reason: "this app runs a server, so it is built in the cloud" };
  }
  const outputDir = String(serve.outputDir || ".");
  if (!stack.buildCommand) {
    // Nothing to build — the folder already is the site.
    return { mode: "upload", outputDir, reason: "no build step — uploading the folder as-is" };
  }
  return {
    mode: "build",
    outputDir,
    installCommand: stack.installCommand || null,
    buildCommand: stack.buildCommand,
  };
}

/** Files under a directory, relative and slash-separated, sorted. */
function listFiles(root, dir = root, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) listFiles(root, full, out);
    else if (item.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/**
 * Content hash of a built directory. Must match apps/web/lib/dirhash.ts exactly —
 * the two are compared across the wire, and a mismatch in either direction silently
 * disables the skip rather than failing loudly.
 */
function hashDir(root) {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** True when the build output exists and has something in it. */
function hasOutput(dir) {
  try {
    return fs.statSync(dir).isDirectory() && listFiles(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Warn when the local Node major differs from what the project asks for. This is the
 * single most likely cause of "it built on my machine and broke in production", and a
 * word at build time is worth more than a support conversation afterwards.
 */
function nodeVersionWarning(stack, localVersion = process.version) {
  const runtime = String((stack && stack.runtime) || "");
  if (!runtime.startsWith("node:")) return null;
  const want = runtime.slice(5).match(/\d+/);
  const have = String(localVersion).match(/\d+/);
  if (!want || !have || want[0] === have[0]) return null;
  return `this project targets Node ${want[0]} but you are on Node ${have[0]} — building anyway`;
}

module.exports = { planFor, hashDir, listFiles, hasOutput, nodeVersionWarning };
