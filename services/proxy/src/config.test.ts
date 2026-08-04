import { test } from "node:test";
import assert from "node:assert/strict";

// config.ts reads the environment once, at module evaluation, so the env has to
// be set before the import — which means a dynamic one, exactly as
// forward.test.ts does for AUTH_SECRET. `node --test` runs each test file in
// its own process, so these values are this file's alone.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
process.env.FLEET_EDGE_SECRET = " \t test-only-edge-secret-do-not-log \n";
const { config } = await import("./config");

test("the edge secret is trimmed at the one place it is read", () => {
  // `openssl rand -hex 32` ends in a newline, and Node refuses to put a newline
  // in a header value: untrimmed, this throws on every fleet-bound request and
  // serves 502 for all nineteen fleet apps, from the proxy, before the node is
  // ever contacted. The node trims its own copy for the mirror-image reason.
  assert.equal(config.edgeSecret, "test-only-edge-secret-do-not-log");
});

test("a header value built from it carries no newline", () => {
  // The property that actually matters, asserted directly rather than inferred
  // from the string comparison above.
  assert.doesNotThrow(() => {
    const h = new Headers();
    h.set("x-supersonic-edge", config.edgeSecret);
  });
});
