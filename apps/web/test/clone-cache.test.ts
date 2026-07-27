import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put, take, reserve, discard, sweep, cacheRoot, CLONE_TTL_MS, _reset } from "../lib/clone-cache";

beforeEach(() => _reset());

test("a clone is handed over exactly once", () => {
  const dir = reserve();
  const token = put(dir);

  assert.equal(take(token), dir);
  assert.equal(take(token), null, "a token is single-use");
  discard(dir);
});

test("an unknown or malformed token is a miss, not an error", () => {
  // Every one of these is the normal path when the second request lands on a
  // different control-plane instance.
  assert.equal(take("f".repeat(32)), null);
  assert.equal(take(""), null);
  assert.equal(take(undefined), null);
  assert.equal(take(null), null);
  assert.equal(take(42), null);
  assert.equal(take({}), null);
});

test("a token is never treated as a path", () => {
  assert.equal(take("../../etc/passwd"), null);
  assert.equal(take("/etc/passwd"), null);
  assert.equal(take("..%2f..%2fetc"), null);
});

test("an expired entry is a miss and its clone is removed", () => {
  const dir = reserve();
  writeFileSync(join(dir, "file.txt"), "x");
  const token = put(dir, 1_000);

  assert.equal(take(token, 1_000 + CLONE_TTL_MS + 1), null);
  assert.equal(existsSync(dir), false, "the expired clone is cleaned up");
});

test("an entry whose directory vanished is a miss", () => {
  const dir = reserve();
  const token = put(dir);
  discard(dir);

  assert.equal(take(token), null);
});

test("discard refuses to delete outside the cache root", () => {
  // A bug here is a recursive delete running as the control plane.
  const outside = mkdtempSync(join(tmpdir(), "not-the-cache-"));
  writeFileSync(join(outside, "precious.txt"), "keep me");

  discard(outside);

  assert.equal(existsSync(join(outside, "precious.txt")), true);
});

test("discard refuses a path that merely starts with the root's name", () => {
  const sibling = cacheRoot() + "-evil";
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "precious.txt"), "keep me");

  discard(sibling);

  assert.equal(existsSync(join(sibling, "precious.txt")), true);
});

test("reserve makes distinct directories inside the root", () => {
  const a = reserve();
  const b = reserve();

  assert.notEqual(a, b);
  assert.ok(a.startsWith(cacheRoot()));
  assert.ok(existsSync(a) && existsSync(b));
  discard(a); discard(b);
});

test("sweep removes clones whose token was never redeemed", () => {
  // The common case: someone starts a deploy and closes the tab.
  const dir = reserve();
  put(dir, 1_000);

  const removed = sweep(1_000 + CLONE_TTL_MS + 1);

  assert.ok(removed >= 1);
  assert.equal(existsSync(dir), false);
});

test("sweep leaves fresh clones alone", () => {
  const dir = reserve();
  const token = put(dir, 10_000);

  sweep(10_000 + 1_000);

  assert.equal(existsSync(dir), true);
  assert.equal(take(token, 10_000 + 1_000), dir);
  discard(dir);
});
