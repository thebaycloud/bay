import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUN_DB, FLEET_DB } from "../lib/db-address";
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
