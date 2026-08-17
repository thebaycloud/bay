import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseId, releasePrefix, pointerPath,
} from "../lib/static-release";


test("a release id sorts chronologically and is unique", () => {
  const at = new Date("2026-07-27T12:34:56.789Z");
  const a = releaseId(at);
  const b = releaseId(at);

  assert.match(a, /^20260727t123456z-[a-f0-9]{8}$/);
  assert.notEqual(a, b, "two deploys in the same second must not collide");

  const earlier = releaseId(new Date("2026-07-26T00:00:00Z"));
  assert.ok(earlier < a, "ids sort in time order");
});

test("a release id is safe to splice into an object path", () => {
  const id = releaseId(new Date("2026-07-27T12:00:00Z"));
  assert.ok(!id.includes("/"));
  assert.ok(!id.includes(".."));
  assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
});

test("paths are built where the static server looks for them", () => {
  assert.equal(releasePrefix("myapp", "r1"), "myapp/r/r1/");
  assert.equal(pointerPath("myapp"), "myapp/current");
});


