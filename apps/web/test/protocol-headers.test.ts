import { test } from "node:test";
import assert from "node:assert/strict";
import { protocolHeader, PROTOCOL_PREFIX, LEGACY_PROTOCOL_PREFIX } from "../lib/protocol-headers";

/**
 * The header names the CLI sends, read under either spelling.
 *
 * This is a contract with software we do not control. A CLI installed last
 * month sends `x-supersonic-app`; one installed after the rename sends
 * `x-bay-app`; both are in use at the same time for as long as it takes people
 * to upgrade, which for a global npm install is "indefinitely".
 *
 * So the server reads either and prefers the new one. The old prefix is removed
 * when the logs show nobody sending it — a decision made from evidence, months
 * from now, and not part of this change.
 */

function req(headers: Record<string, string>): Request {
  return new Request("https://app.example/x", { headers });
}

test("the new name is read", () => {
  assert.equal(protocolHeader(req({ "x-bay-app": "myapp" }), "app"), "myapp");
});

test("the old name is still read, or every installed CLI breaks at once", () => {
  assert.equal(protocolHeader(req({ "x-supersonic-app": "myapp" }), "app"), "myapp");
});

test("the new name wins when both arrive", () => {
  // A CLI mid-upgrade, or a proxy that copies headers forward. Preferring the
  // new one means upgrading actually changes behaviour.
  assert.equal(
    protocolHeader(req({ "x-bay-app": "new", "x-supersonic-app": "old" }), "app"),
    "new",
  );
});

test("a missing header is null under both names, not an empty string", () => {
  // `""` and "absent" mean different things to the deploy route: an empty
  // x-bay-slug is a caller asking for a generated slug, and a missing one is a
  // caller that does not know about slugs at all.
  assert.equal(protocolHeader(req({}), "slug"), null);
});

test("an empty value is a value, and is not confused with absence", () => {
  assert.equal(protocolHeader(req({ "x-bay-slug": "" }), "slug"), "");
});

test("an empty new name does not shadow a real old one", () => {
  // A CLI that sets the header unconditionally sends "" when it has nothing to
  // say. Letting that beat a populated legacy header would lose the value.
  assert.equal(
    protocolHeader(req({ "x-bay-slug": "", "x-supersonic-slug": "chosen" }), "slug"),
    "chosen",
  );
});

test("the prefixes are what the rest of the codebase builds names from", () => {
  assert.equal(PROTOCOL_PREFIX, "x-bay-");
  assert.equal(LEGACY_PROTOCOL_PREFIX, "x-supersonic-");
});

test("every header the deploy route reads is reachable under both names", () => {
  // The list that matters. Missing one here is a CLI feature that silently
  // stops working for everybody who has not upgraded — and it would look like
  // the feature was removed, not like a header was renamed.
  const names = [
    "upload", "prebuilt", "hash", "source-object", "source-key",
    "app", "slug", "run", "env", "who",
  ] as const;
  for (const n of names) {
    assert.equal(protocolHeader(req({ [`x-bay-${n}`]: "v" }), n), "v", `new: ${n}`);
    assert.equal(protocolHeader(req({ [`x-supersonic-${n}`]: "v" }), n), "v", `old: ${n}`);
  }
});
