"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv, readEnvFiles, selectEnv, encodeEnvHeader, MAX_HEADER_BYTES } = require("../lib/envfile.js");

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-envfile-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

// --- what a .env line means

test("plain assignments, comments and blank lines", () => {
  const v = parseEnv("# a comment\n\nOPENAI_API_KEY=sk-abc123\n\n# another\nRESEND_API_KEY=re_xyz\n");
  assert.deepEqual(v, { OPENAI_API_KEY: "sk-abc123", RESEND_API_KEY: "re_xyz" });
});

test("export prefixes and quotes are stripped", () => {
  const v = parseEnv(`export STRIPE_SECRET_KEY="sk_live_1"\nSINGLE='hello world'\n`);
  assert.equal(v.STRIPE_SECRET_KEY, "sk_live_1");
  assert.equal(v.SINGLE, "hello world");
});

test("an inline comment ends an unquoted value but not a quoted one", () => {
  const v = parseEnv(`A=plain # trailing note\nB="keeps # inside"\n`);
  assert.equal(v.A, "plain");
  assert.equal(v.B, "keeps # inside");
});

test("a value with an = in it keeps everything after the first one", () => {
  assert.equal(parseEnv("TOKEN=abc=def==").TOKEN, "abc=def==");
});

test("escapes expand in double quotes and stay literal in single", () => {
  assert.equal(parseEnv(`K="line1\\nline2"`).K, "line1\nline2");
  assert.equal(parseEnv(`K='line1\\nline2'`).K, "line1\\nline2");
});

test("a quoted value may span lines — PEM keys arrive that way", () => {
  const v = parseEnv('PRIVATE_KEY="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nAFTER=yes\n');
  assert.equal(v.PRIVATE_KEY, "-----BEGIN KEY-----\nabc\n-----END KEY-----");
  assert.equal(v.AFTER, "yes", "parsing continues after the multi-line value");
});

test("malformed lines are skipped, not guessed at", () => {
  const v = parseEnv('no-equals-here\n9INVALID=x\nhas space=x\nUNTERMINATED="oops\n');
  assert.deepEqual(v, {});
});

// --- layering

test(".env.local overrides .env", () => {
  const dir = tree({ ".env": "K=from-env\nONLY_BASE=1\n", ".env.local": "K=from-local\n" });
  const v = readEnvFiles(dir);
  assert.equal(v.K, "from-local");
  assert.equal(v.ONLY_BASE, "1");
});

test("no env files is not an error", () => {
  assert.deepEqual(readEnvFiles(tree({})), {});
});

// --- what has any business going to production

test("ordinary secrets are carried", () => {
  const { send } = selectEnv({ OPENAI_API_KEY: "sk-1", STRIPE_SECRET_KEY: "sk_live_1" });
  assert.deepEqual(send, { OPENAI_API_KEY: "sk-1", STRIPE_SECRET_KEY: "sk_live_1" });
});

test("vars the platform sets itself are never taken from .env", () => {
  // A local DATABASE_URL would replace the Cloud SQL one the deploy injects, and the
  // app would come up pointed at a database that does not exist in production.
  const { send, skipped } = selectEnv({ DATABASE_URL: "postgres://localhost/dev", PORT: "3000" });
  assert.deepEqual(send, {});
  assert.deepEqual(skipped.map((s) => s.key).sort(), ["DATABASE_URL", "PORT"]);
});

test("anything aimed at the developer's own machine is left behind", () => {
  const { send } = selectEnv({
    REDIS_URL: "redis://127.0.0.1:6379",
    API_BASE: "http://localhost:3000",
    DOCKER_HOST: "tcp://host.docker.internal:2375",
    PUBLIC_API: "https://api.example.com",
  });
  assert.deepEqual(send, { PUBLIC_API: "https://api.example.com" });
});

test("a value already set on the app wins over the local one", () => {
  // The live app has the real Stripe key; .env has the test one. Sending it would
  // swap a working payment integration for a sandbox on an unrelated redeploy.
  const { send, skipped } = selectEnv(
    { STRIPE_SECRET_KEY: "sk_test_local", NEW_KEY: "v" },
    { existingKeys: ["STRIPE_SECRET_KEY"] },
  );
  assert.deepEqual(send, { NEW_KEY: "v" });
  assert.equal(skipped.find((s) => s.key === "STRIPE_SECRET_KEY").reason, "already set on the app");
});

test("empty values are not sent", () => {
  assert.deepEqual(selectEnv({ BLANK: "" }).send, {});
});

// --- the wire

test("the header round-trips", () => {
  const send = { OPENAI_API_KEY: "sk-1", MULTI: "a\nb" };
  assert.deepEqual(JSON.parse(Buffer.from(encodeEnvHeader(send), "base64").toString("utf8")), send);
});

test("nothing to send produces no header", () => {
  assert.equal(encodeEnvHeader({}), null);
});

test("an env too large for a header is refused rather than truncated", () => {
  // Half an environment is worse than none: the app breaks with no visible cause.
  assert.equal(encodeEnvHeader({ BIG: "x".repeat(MAX_HEADER_BYTES) }), null);
});
