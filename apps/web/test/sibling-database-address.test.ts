import { test } from "node:test";
import assert from "node:assert/strict";
import { restateDatabaseAt } from "../lib/env-merge";
import { databaseEnv, databaseEnvNames } from "../lib/lanes";
import { CLOUD_RUN_DB, FLEET_DB, databaseUrlFor } from "../lib/db-address";

/**
 * A sibling runs somewhere else than its primary, and inherits its environment.
 *
 * When the primary is placed on a node it is given FLEET_DB — 10.200.0.1, the
 * host-side proxy on the machine it runs on. A sibling deploys to Cloud Run and
 * has no route to that address at all, so inheriting it produces an app that
 * comes up, reports healthy, and fails every request that touches the database.
 *
 * This is the failure the runtime gate in the pipeline exists to prevent, and
 * its own comment says so: handing a Cloud Run revision FLEET_DB gives it "an
 * address it cannot reach — the same failure this whole task exists to stop,
 * arriving through the back door". It closed the front door and left this one.
 */

const pg = { user: "app_x", password: "s3cret", dbName: "x" };
const onFleet = databaseEnv({ databaseUrl: databaseUrlFor(pg, pg.dbName, FLEET_DB), ...pg }, FLEET_DB);
const onCloudRun = databaseEnv({ databaseUrl: databaseUrlFor(pg, pg.dbName, CLOUD_RUN_DB), ...pg }, CLOUD_RUN_DB);

function restate(inherited: string[]) {
  return restateDatabaseAt(inherited, onCloudRun, databaseEnvNames());
}

test("the node's address does not survive into a Cloud Run sibling", () => {
  const r = restate([...onFleet, "NODE_ENV=production"]);
  const all = [...r.inherited, ...r.plainEnv].join("\n");

  assert.ok(!all.includes(FLEET_DB.host), `the node's address survived:\n${all}`);
  assert.ok(all.includes(`PGHOST=${CLOUD_RUN_DB.host}`));
  assert.ok(all.includes(`POSTGRES_SERVER=${CLOUD_RUN_DB.host}`));
  assert.ok(all.includes(`DB_HOST=${CLOUD_RUN_DB.host}`));
});

test("every name the platform owns is replaced, not shadowed", () => {
  // Appending and letting the later value win is a coin toss inside one
  // --update-env-vars, and the losing side of that coin is an app that cannot
  // reach its database. So no owned name may appear twice.
  const r = restate([...onFleet, "NODE_ENV=production"]);
  const keys = [...r.inherited, ...r.plainEnv].map((e) => e.slice(0, e.indexOf("=")));
  const seen = new Set<string>();
  for (const k of keys) {
    assert.ok(!seen.has(k), `${k} appears twice`);
    seen.add(k);
  }
});

test("everything that is not the platform's database is kept", () => {
  // The sibling's own configuration must survive untouched — this function is
  // allowed to know about the database and nothing else.
  const r = restate([...onFleet, "NODE_ENV=production", "LOG_LEVEL=debug", "MY_PGHOSTNAME=keepme"]);
  assert.ok(r.inherited.includes("NODE_ENV=production"));
  assert.ok(r.inherited.includes("LOG_LEVEL=debug"));
  // Not a prefix match: MY_PGHOSTNAME is not PGHOST.
  assert.ok(r.inherited.includes("MY_PGHOSTNAME=keepme"));
});

test("the credential goes to Secret Manager, never to a plain variable", () => {
  const r = restate(onFleet);
  const plain = r.plainEnv.join("\n");

  assert.ok(!plain.includes("DATABASE_URL="), "DATABASE_URL was published as a plain variable");
  assert.ok(!plain.includes(pg.password), "the password was published as a plain variable");
  assert.equal(r.secretEnv.DATABASE_URL, `postgresql://app_x:s3cret@${CLOUD_RUN_DB.host}:5432/x`);
  assert.equal(r.secretEnv.PGPASSWORD, pg.password);
});

test("the sibling's DATABASE_URL names its own address, not the primary's", () => {
  // The loose host variables are the obvious half. The URL carries a host too,
  // and a fix that rewrote only the former would leave every app that reads
  // DATABASE_URL — which is most of them — pointed at the node.
  const r = restate(onFleet);
  assert.ok(r.secretEnv.DATABASE_URL.includes(`@${CLOUD_RUN_DB.host}:`));
  assert.ok(!r.secretEnv.DATABASE_URL.includes(FLEET_DB.host));
});

test("an inherited environment with no database is left alone", () => {
  const r = restateDatabaseAt(["NODE_ENV=production"], [], databaseEnvNames());
  assert.deepEqual(r.inherited, ["NODE_ENV=production"]);
  assert.deepEqual(r.plainEnv, []);
  assert.deepEqual(r.secretEnv, {});
});

test("a malformed inherited entry is not silently dropped", () => {
  // A value with no `=` is not ours to interpret, and discarding it would be a
  // variable disappearing from a deploy for a reason nobody could see.
  const r = restate(["JUST_A_NAME", ...onFleet]);
  assert.ok(r.inherited.includes("JUST_A_NAME"));
});
