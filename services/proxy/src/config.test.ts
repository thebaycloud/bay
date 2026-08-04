import { test } from "node:test";
import assert from "node:assert/strict";
import { validateHeaderValue } from "node:http";

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
  // The property that actually matters, asserted against the API that
  // node:http itself uses to validate an outgoing header value — not the
  // WHATWG Headers API, which per spec normalizes (strips) a leading or
  // trailing newline rather than throwing, and so would pass this test even
  // with the .trim() in config.ts removed.
  assert.doesNotThrow(() => {
    validateHeaderValue("x-supersonic-edge", config.edgeSecret);
  });
});
