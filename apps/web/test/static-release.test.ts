import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseId, releasePrefix, pointerPath, publishRelease, type ReleaseStore,
} from "../lib/static-release";

function recordingStore(opts: { failUpload?: boolean } = {}) {
  const calls: string[] = [];
  const store: ReleaseStore = {
    async uploadDir(_dir, prefix) {
      calls.push(`upload:${prefix}`);
      if (opts.failUpload) throw new Error("upload died halfway");
    },
    async writePointer(path, release) {
      calls.push(`pointer:${path}=${release}`);
    },
  };
  return { store, calls };
}

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

test("the pointer is written only after the upload finishes", () => {
  // The ordering IS the safety property, so it is asserted directly.
  const { store, calls } = recordingStore();

  return publishRelease(store, "myapp", "/tmp/dist", new Date("2026-07-27T12:00:00Z"))
    .then((res) => {
      assert.equal(calls.length, 2);
      assert.ok(calls[0].startsWith("upload:"), "upload first");
      assert.ok(calls[1].startsWith("pointer:"), "pointer second");
      assert.equal(calls[0], `upload:${res.prefix}`);
      assert.equal(calls[1], `pointer:myapp/current=${res.release}`);
    });
});

test("a failed upload never moves the pointer", async () => {
  const { store, calls } = recordingStore({ failUpload: true });

  await assert.rejects(
    () => publishRelease(store, "myapp", "/tmp/dist", new Date()),
    /upload died halfway/,
  );

  assert.deepEqual(
    calls.filter((c) => c.startsWith("pointer:")),
    [],
    "the live site still points at the previous release",
  );
});

test("each publish gets its own prefix, so releases never overwrite each other", async () => {
  const { store } = recordingStore();
  const at = new Date("2026-07-27T12:00:00Z");

  const first = await publishRelease(store, "myapp", "/tmp/dist", at);
  const second = await publishRelease(store, "myapp", "/tmp/dist", at);

  assert.notEqual(first.prefix, second.prefix);
});
