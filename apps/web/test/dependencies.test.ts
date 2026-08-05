import { test } from "node:test";
import assert from "node:assert/strict";
import { sidecarFor, sidecarEnv, dependencyRefusal, addressPlaceholder } from "../lib/dependencies";

/**
 * Which dependencies run beside an app and which stay managed.
 *
 * The rule, and these tests are its statement: a dependency is a sidecar when
 * losing it costs nothing that cannot be rebuilt AND it fits beside twenty-five
 * other apps on one machine. Otherwise it is managed, or refused.
 */

test("a cache runs beside the app", () => {
  const s = sidecarFor("redis");
  assert.ok(s, "redis should be a sidecar");
  assert.match(s.image, /redis/);
  assert.equal(s.port, 6379);
});

test("the cache is started with persistence off, explicitly", () => {
  // Not left to the image's default. A cache that is SOMETIMES durable is worse
  // than one that never is: the first time it survives a restart, somebody
  // starts relying on it — and `/srv/apps` only survives a reboot where a data
  // disk has been attached.
  const s = sidecarFor("redis");
  assert.deepEqual(s?.command, ["redis-server", "--save", "", "--appendonly", "no"]);
});

test("the cache is small enough for a node full of apps", () => {
  // 25 apps × this must be a rounding error on a 64 GiB machine, or the sidecar
  // model costs more than it gives.
  const s = sidecarFor("redis");
  assert.ok(s && s.memoryBytes <= 512 * 1024 * 1024, `${s?.memoryBytes} is too much to give every app`);
});

test("the database and the bucket stay managed", () => {
  // They are the app's DATA. It has to survive the node, and both already work
  // — a sidecar version would be a downgrade wearing a feature's name.
  assert.equal(sidecarFor("database"), null);
  assert.equal(sidecarFor("bucket"), null);
});

test("elasticsearch is refused, with the reason", () => {
  const why = dependencyRefusal("elasticsearch");
  assert.ok(why, "it should be refused rather than silently ignored");
  assert.match(why, /heap|isolation/);
});

test("nothing else is refused", () => {
  // The refusal list is a list, not a default. A dependency that is merely
  // unimplemented must not read as one we have decided against.
  for (const k of ["database", "bucket", "redis", "postgres", "whatever"]) {
    assert.equal(dependencyRefusal(k), null, `${k} should not be refused`);
  }
});

test("the app is told where its cache is, in every spelling it might read", () => {
  // Same reason `databaseEnv` writes seventeen names: plenty of apps never read
  // REDIS_URL and want REDIS_HOST.
  const env = sidecarEnv(sidecarFor("redis")!);
  const keys = env.map((e) => e.slice(0, e.indexOf("=")));
  for (const k of ["REDIS_URL", "REDIS_HOST", "REDIS_PORT"]) {
    assert.ok(keys.includes(k), `${k} is missing`);
  }
});

test("the address is a placeholder, not a number", () => {
  // A placement is written before anything is placed, so no IP exists yet. A
  // literal here would be a guess that outlives the slot it was guessed from.
  const env = sidecarEnv(sidecarFor("redis")!);
  for (const e of env) {
    assert.ok(
      !/\d+\.\d+\.\d+\.\d+/.test(e),
      `${e} carries a literal address, which cannot be known when the spec is written`,
    );
  }
  assert.ok(env.some((e) => e.includes(addressPlaceholder("redis"))));
});
