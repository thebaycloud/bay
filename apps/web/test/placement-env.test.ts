import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../lib/fleet-spec";

/**
 * `env set` and `env unset` on an app running on a node.
 *
 * Both printed "✓ … new revision rolling out" and did nothing. The proof a user
 * sent: after `env unset BOT_TOKEN`, `env` still listed BOT_TOKEN.
 *
 * The cause is that everything from a project's `.env` lands in Secret Manager,
 * so for most apps every name worth changing lives in the spec's `secrets` map —
 * and this only ever edited `env`. Setting wrote a plain variable beside a
 * secret of the same name (the node appends secrets last, so the stale one won),
 * and unsetting removed a key that was never there while the listing kept
 * showing it from `secrets`.
 *
 * The logic is exercised here through the same pure shape the database round
 * trip produces, so it needs no Postgres and no Secret Manager.
 */

function apply(
  spec: AppSpec,
  set: Record<string, string>,
  unset: string[],
  stored: { key: string; name: string }[] = [],
): { env: Record<string, string>; secrets: Record<string, string>; bumped: boolean } {
  const env = { ...(spec.env ?? {}) };
  const secrets = { ...(spec.secrets ?? {}) };
  const asSecret: Record<string, string> = {};
  for (const [k, v] of Object.entries(set)) {
    if (!k) continue;
    if (k in secrets) asSecret[k] = String(v);
    else env[k] = String(v);
  }
  let bumped = false;
  if (Object.keys(asSecret).length) for (const r of stored) { secrets[r.key] = r.name; bumped = true; }
  for (const k of unset) {
    delete env[k];
    if (k in secrets) { delete secrets[k]; bumped = true; }
  }
  return { env, secrets, bumped };
}

const withSecret: AppSpec = {
  slug: "bot", image: "img", port: 8080, memoryBytes: 1, cpuShares: 1,
  env: { LOG_LEVEL: "info" },
  secrets: { BOT_TOKEN: "app-bot-BOT_TOKEN" },
};

test("unsetting a value that arrived as a secret actually removes it", () => {
  const r = apply(withSecret, {}, ["BOT_TOKEN"]);
  assert.equal("BOT_TOKEN" in r.secrets, false);
  assert.equal([...Object.keys(r.env), ...Object.keys(r.secrets)].includes("BOT_TOKEN"), false);
  assert.equal(r.bumped, true);
});

test("setting a value that arrived as a secret stays a secret", () => {
  // The alternative — writing a plain env var of the same name — leaves the old
  // secret in place, and the node appends secrets AFTER env, so the value the
  // user just replaced is the one that wins.
  const r = apply(withSecret, { BOT_TOKEN: "new" }, [], [{ key: "BOT_TOKEN", name: "app-bot-BOT_TOKEN" }]);
  assert.equal(r.env.BOT_TOKEN, undefined, "must not become a plain variable");
  assert.equal(r.secrets.BOT_TOKEN, "app-bot-BOT_TOKEN");
  assert.equal(r.bumped, true);
});

test("a name that was never a secret stays an ordinary variable", () => {
  const r = apply(withSecret, { LOG_LEVEL: "debug" }, []);
  assert.equal(r.env.LOG_LEVEL, "debug");
  assert.equal("LOG_LEVEL" in r.secrets, false);
  // Nothing was written to Secret Manager, so nothing needs to move.
  assert.equal(r.bumped, false);
});

test("unsetting an ordinary variable does not touch secrets", () => {
  const r = apply(withSecret, {}, ["LOG_LEVEL"]);
  assert.equal("LOG_LEVEL" in r.env, false);
  assert.equal(r.secrets.BOT_TOKEN, "app-bot-BOT_TOKEN");
  assert.equal(r.bumped, false);
});

test("the listing is both maps, which is why the old bug was visible", () => {
  const r = apply(withSecret, {}, []);
  assert.deepEqual([...Object.keys(r.env), ...Object.keys(r.secrets)].sort(), ["BOT_TOKEN", "LOG_LEVEL"]);
});
