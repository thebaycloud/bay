"use strict";
/**
 * Carrying the project's local `.env` up to the deployed app.
 *
 * `.env` is deliberately kept out of the upload (see packageFolder) — a secret in the
 * tarball ends up in the build bucket and in the image layers, where it cannot be
 * rotated and, until every app has its own runtime identity, can be read by other
 * apps. So the values travel as env vars on the deploy request instead and are set on
 * the service, which is the one place they can be changed or removed later.
 *
 * The rules live here as pure functions: what a `.env` line means, and which of those
 * values have any business being in production.
 */
const fs = require("node:fs");
const path = require("node:path");

// Read in this order; later files win, matching how dotenv-style tooling layers them.
//
// `.env.production` belongs here and its absence was the worst of both worlds: the
// tarball's exclude list did not cover it either, so a project keeping its real
// values there had them SHIPPED into the build bundle and never applied to the
// app. Deploying is production, so the production files are the ones whose values
// should win — and every one of them is excluded from the bundle (see
// packageFolder), because a value baked into an image cannot be rotated.
const ENV_FILES = [".env", ".env.production", ".env.local", ".env.production.local"];

// Set by the platform on every deploy — a local value would overwrite the real one and
// point the app at a database that does not exist in production.
const PLATFORM_OWNED = new Set([
  "DATABASE_URL",
  "STORAGE_BUCKET",
  "GOOGLE_CLOUD_PROJECT",
  "SUPERSONIC_CODE_BUCKET",
  "SUPERSONIC_CODE_OBJECT",
  "PORT",
]);

// A value aimed at the developer's own machine is worse than no value: the app starts,
// then hangs or fails on the first request to something that isn't there.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"];

/**
 * Parse one `.env` file's text into a plain object.
 *
 * Handles what people actually write: `export` prefixes, comments, quoted values, and
 * values that span lines (service-account keys and PEM blocks arrive that way).
 * Anything it can't make sense of is skipped rather than guessed at.
 */
function parseEnv(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let rest = line.slice(eq + 1).trim();
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
    if (!quote) {
      // Unquoted: an inline comment ends the value, as in `KEY=value # note`.
      const hash = rest.indexOf(" #");
      out[key] = (hash > -1 ? rest.slice(0, hash) : rest).trim();
      continue;
    }
    // Quoted, possibly across several lines — consume until the closing quote.
    rest = rest.slice(1);
    let value = "";
    let closed = false;
    for (;;) {
      const end = rest.indexOf(quote);
      if (end > -1) { value += rest.slice(0, end); closed = true; break; }
      value += rest + "\n";
      if (++i >= lines.length) break;
      rest = lines[i];
    }
    if (!closed) continue; // unterminated quote — the file is malformed, don't guess
    out[key] = quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : value;
  }
  return out;
}

/** Read the project's env files, layered. Missing or unreadable files are simply absent. */
function readEnvFiles(cwd, files = ENV_FILES) {
  const merged = {};
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(cwd, name), "utf8"); } catch { continue; }
    Object.assign(merged, parseEnv(text));
  }
  return merged;
}

/**
 * Decide which of the local values to send.
 *
 * `existingKeys` are the vars the app already has. They are left alone on purpose: the
 * value in production is the one the user set deliberately, and the one in `.env` is
 * very often a test key. Overwriting a live Stripe key with `sk_test_…` on an unrelated
 * redeploy breaks payments silently, which is the worst way for this to fail.
 */
function selectEnv(vars, { existingKeys = [] } = {}) {
  const have = new Set(existingKeys);
  const send = {};
  const skipped = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!value) { skipped.push({ key, reason: "empty" }); continue; }
    if (PLATFORM_OWNED.has(key)) { skipped.push({ key, reason: "set by Supersonic" }); continue; }
    if (LOCAL_HOSTS.some((h) => value.includes(h))) { skipped.push({ key, reason: "points at your machine" }); continue; }
    if (have.has(key)) { skipped.push({ key, reason: "already set on the app" }); continue; }
    send[key] = value;
  }
  return { send, skipped };
}

/**
 * Serialize for the deploy request's header.
 *
 * Cloud Run caps request headers, and a `.env` big enough to hit that cap is rare
 * enough that failing the whole deploy over it would be absurd — over the limit we
 * hand back null and the caller falls back to setting the vars after the build.
 */
const MAX_HEADER_BYTES = 8 * 1024;

function encodeEnvHeader(send) {
  if (!send || !Object.keys(send).length) return null;
  const encoded = Buffer.from(JSON.stringify(send), "utf8").toString("base64");
  return Buffer.byteLength(encoded) > MAX_HEADER_BYTES ? null : encoded;
}

module.exports = { parseEnv, readEnvFiles, selectEnv, encodeEnvHeader, ENV_FILES, PLATFORM_OWNED, MAX_HEADER_BYTES };
