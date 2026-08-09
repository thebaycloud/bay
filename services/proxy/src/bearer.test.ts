import { test } from "node:test";
import assert from "node:assert/strict";

// session.ts imports ./config, which throws at module-evaluation time if
// AUTH_SECRET is unset — a real requirement for the running proxy, unrelated
// to anything bearerFrom checks. `node --test` runs each test file in its own
// process, so the env has to be set before the import, which means a dynamic
// one, exactly as forward.test.ts and config.test.ts do.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
const { bearerFrom } = await import("./session");

test("a bearer token is read, and nothing else is", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("bearer abc123"), "abc123");
  assert.equal(bearerFrom("Basic abc123"), null);
  assert.equal(bearerFrom(undefined), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom("Bearer   "), null);
});
