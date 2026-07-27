import { test } from "node:test";
import assert from "node:assert/strict";
import { PointerCache, isReleaseId } from "./pointer.ts";

function store(map: Record<string, string | null>) {
  let reads = 0;
  return {
    read: async (slug: string) => { reads++; return map[slug] ?? null; },
    get reads() { return reads; },
  };
}

test("a pointer is read once and then served from cache", async () => {
  const s = store({ app: "r1" });
  let clock = 1000;
  const c = new PointerCache(s, 10_000, () => clock);

  assert.equal(await c.get("app"), "r1");
  assert.equal(await c.get("app"), "r1");
  assert.equal(await c.get("app"), "r1");
  assert.equal(s.reads, 1);
});

test("the cache expires and re-reads", async () => {
  const map: Record<string, string | null> = { app: "r1" };
  const s = store(map);
  let clock = 1000;
  const c = new PointerCache(s, 10_000, () => clock);

  assert.equal(await c.get("app"), "r1");
  map.app = "r2";
  assert.equal(await c.get("app"), "r1", "still cached");

  clock += 10_001;
  assert.equal(await c.get("app"), "r2", "re-read after the ttl");
  assert.equal(s.reads, 2);
});

test("a missing pointer is cached too", async () => {
  // Otherwise a scanner walking subdomains turns into one GCS read per request.
  const s = store({});
  let clock = 0;
  const c = new PointerCache(s, 10_000, () => clock);

  assert.equal(await c.get("nope"), null);
  assert.equal(await c.get("nope"), null);
  assert.equal(s.reads, 1);
});

test("forget drops an entry so a rollback shows up immediately", async () => {
  const map: Record<string, string | null> = { app: "r1" };
  const s = store(map);
  const c = new PointerCache(s, 10_000, () => 0);

  assert.equal(await c.get("app"), "r1");
  map.app = "r2";
  c.forget("app");
  assert.equal(await c.get("app"), "r2");
});

test("entries are kept per slug", async () => {
  const s = store({ a: "r1", b: "r2" });
  const c = new PointerCache(s, 10_000, () => 0);
  assert.equal(await c.get("a"), "r1");
  assert.equal(await c.get("b"), "r2");
  assert.equal(c.size, 2);
});

test("release ids that could escape the path are rejected", () => {
  assert.equal(isReleaseId("20260727t120000z-a1b2c3"), true);
  assert.equal(isReleaseId("r1"), true);
  assert.equal(isReleaseId(".."), false);
  assert.equal(isReleaseId("a/b"), false);
  assert.equal(isReleaseId("-lead"), false);
  assert.equal(isReleaseId(""), false);
  assert.equal(isReleaseId("a".repeat(65)), false);
});
