import { test } from "node:test";
import assert from "node:assert/strict";
import { envOwner, nameRefusal, ENV_NAME } from "../lib/env-owner";
import { databaseEnvNames } from "../lib/lanes";
import { platformOwned } from "../lib/app-config";

const managed = { managedDatabase: true };
const external = { managedDatabase: false };

test("BAY_ is ours, which it was not until this module existed", () => {
  // The rename shipped, `universalFacts` began writing BAY_URL and its three
  // siblings, and the protected list still only knew SUPERSONIC_. So an app could
  // declare BAY_URL, parse clean, and have it silently overwritten on deploy —
  // exactly the drift the list's own comment was written to prevent.
  for (const n of ["BAY_URL", "BAY_HOSTNAME", "BAY_SCHEME", "BAY_PATH_PREFIX"]) {
    assert.equal(envOwner(n, external), "platform", n);
    assert.equal(platformOwned(n), true, `${n} must also be refused at parse time`);
  }
  // And the old prefix stays, because somebody's settings.py reads it.
  assert.equal(envOwner("SUPERSONIC_HOSTNAME", external), "platform");
});

test("PORT is ours whatever the app declares", () => {
  assert.equal(envOwner("PORT", external), "platform");
  // But not every name that merely starts with it.
  assert.equal(envOwner("PORTAL_URL", external), "app");
});

test("every name databaseEnv writes is recognised, so the two cannot drift", () => {
  // The lists were maintained separately once — six protected names against
  // seventeen written — and every name in the gap was a user value the platform
  // silently overwrote.
  for (const n of databaseEnvNames()) {
    assert.equal(envOwner(n, managed), "database", n);
  }
  assert.ok(databaseEnvNames().length >= 17, "the list should not have shrunk");
});

test("an app with its own database owns its own connection variables", () => {
  // The mistake `platformOwned` was corrected for, and it must not come back
  // through the panel: an app on Supabase HAS the database, and calling those
  // seventeen names ours is a refusal aimed at the wrong app.
  assert.equal(envOwner("DATABASE_URL", external), "app");
  assert.equal(envOwner("PGHOST", external), "app");
  assert.equal(envOwner("DATABASE_URL", managed), "database");
});

test("the prefixes are broad on purpose", () => {
  // PGSSLMODE is not written by databaseEnv today, but it configures the same
  // connection, and setting it while the platform supplies the endpoint is
  // describing a connection you do not control.
  assert.equal(envOwner("PGSSLMODE", managed), "database");
  assert.equal(envOwner("POSTGRES_SCHEMA", managed), "database");
  assert.equal(envOwner("DB_SCHEMA", managed), "database");
});

test("an ordinary key is the app's own", () => {
  for (const n of ["STRIPE_SECRET_KEY", "OPENAI_API_KEY", "SESSION_SECRET", "_UNDERSCORE"]) {
    assert.equal(envOwner(n, managed), "app", n);
  }
});

test("the panel and the parser answer the same question", () => {
  // One rule, two callers. A UI that offers what the deploy then refuses reads as
  // a broken product rather than as a deliberate limit.
  const names = [
    "BAY_URL", "SUPERSONIC_URL", "PORT", "DATABASE_URL", "PGHOST", "DB_NAME",
    "POSTGRES_USER", "MY_KEY", "PORTAL_URL",
  ];
  for (const n of names) {
    assert.equal(
      envOwner(n, managed) !== "app",
      platformOwned(n, { provider: "managed" } as never),
      n,
    );
    assert.equal(
      envOwner(n, external) !== "app",
      platformOwned(n, { provider: "external" } as never),
      n,
    );
  }
});

test("a name the environment cannot hold is refused before the request", () => {
  assert.match(nameRefusal("", managed)!, /required/);
  assert.match(nameRefusal("2FA_CODE", managed)!, /not starting with a digit/);
  assert.match(nameRefusal("MY-KEY", managed)!, /underscores/);
  assert.match(nameRefusal("MY KEY", managed)!, /underscores/);
  assert.equal(nameRefusal("MY_KEY", managed), null);
  assert.ok(ENV_NAME.test("_x1"));
});

test("a refusal says WHICH kind of ours it is", () => {
  // Two different answers to "why is my value ignored", and they need different
  // advice: one is never yours, the other is yours on a different database.
  assert.match(nameRefusal("BAY_URL", managed)!, /overwritten on the next ship/);
  assert.match(nameRefusal("PGHOST", managed)!, /provisioned for this app/);
  // And on an external database it is simply allowed.
  assert.equal(nameRefusal("PGHOST", external), null);
});
