import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUN_DB, FLEET_DB, databaseUrlFor } from "../lib/db-address";
import { databaseEnv } from "../lib/lanes";

const db = { databaseUrl: "postgresql://u:p@H:P/d", user: "u", password: "p", dbName: "d" };

test("the fleet address reaches every variable that carries a host, not just DATABASE_URL", () => {
  // databaseEnv writes eleven variables that name the host. A Django app reads
  // POSTGRES_HOST, a psql-shaped one reads PGHOST, and an app that assembles its
  // own URL reads DB_HOST — so changing only DATABASE_URL leaves most apps
  // pointing at a loopback address with nothing on it.
  const env = databaseEnv(db, FLEET_DB);
  const hostVars = env.filter((p) => /^(POSTGRES_SERVER|POSTGRES_HOST|PGHOST|DB_HOST)=/.test(p));

  assert.equal(hostVars.length, 4, `expected four host variables, got ${hostVars.join(" ")}`);
  for (const pair of hostVars) assert.ok(pair.endsWith("=10.200.0.1"), `${pair} kept the old host`);
});

test("the default is unchanged, so the Cloud Run path is untouched by this", () => {
  assert.deepEqual(databaseEnv(db), databaseEnv(db, CLOUD_RUN_DB));
  assert.ok(databaseEnv(db).includes("PGHOST=127.0.0.1"));
});

test("the two addresses are the only two, and they differ only in host", () => {
  // The port is the same on both sides on purpose: a proxy that answers on a
  // different port on each runtime is a second thing to get wrong for no gain.
  assert.equal(CLOUD_RUN_DB.port, FLEET_DB.port);
  assert.notEqual(CLOUD_RUN_DB.host, FLEET_DB.host);
});

test("the connection URL names the runtime's address", () => {
  const role = { user: "app_x", password: "s3cr3t" };
  assert.equal(databaseUrlFor(role, "x", FLEET_DB), "postgresql://app_x:s3cr3t@10.200.0.1:5432/x");
  assert.equal(databaseUrlFor(role, "x", CLOUD_RUN_DB), "postgresql://app_x:s3cr3t@127.0.0.1:5432/x");
});

test("a password that needs escaping does not silently produce a broken URL", () => {
  // Generated passwords have gone out with characters that are syntax in a URL.
  // A `@` in a password unescaped moves the host, and the app fails to resolve a
  // hostname that is really the tail of a password — which is both a confusing
  // error and a password in a log line.
  const url = databaseUrlFor({ user: "app_x", password: "p@ss/w:rd" }, "x", FLEET_DB);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "10.200.0.1");
  assert.equal(decodeURIComponent(parsed.password), "p@ss/w:rd");
});
