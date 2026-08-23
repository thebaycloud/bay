import { test } from "node:test";
import assert from "node:assert/strict";
import { doorFor, hostnameOf, mustReturnToPlatform, platformUrl } from "./door";

const ROOT = "supersonic.cv";

test("an address we issued carries its own slug", () => {
  assert.deepEqual(doorFor("lilna.supersonic.cv", ROOT), { kind: "issued", slug: "lilna" });
  assert.deepEqual(doorFor("lilna.supersonic.cv:443", ROOT), { kind: "issued", slug: "lilna" });
  assert.deepEqual(doorFor("LILNA.supersonic.cv", ROOT), { kind: "issued", slug: "lilna" });
});

test("a name we did not issue is a lookup, not a slug", () => {
  assert.deepEqual(doorFor("acme.com", ROOT), { kind: "attached", hostname: "acme.com" });
  assert.deepEqual(doorFor("shop.acme.com", ROOT), { kind: "attached", hostname: "shop.acme.com" });
});

// The spelling that would otherwise miss a table keyed by hostname, and 404 an
// app at an address that works everywhere else.
test("the fully-qualified spelling is the same name", () => {
  assert.equal(hostnameOf("acme.com."), "acme.com");
  assert.deepEqual(doorFor("acme.com.", ROOT), { kind: "attached", hostname: "acme.com" });
  assert.deepEqual(doorFor("lilna.supersonic.cv.", ROOT), { kind: "issued", slug: "lilna" });
});

// The one that matters: a deeper name inside the namespace we issue must not
// become a hostname somebody can attach.
test("a name inside our own domain is never an attachable hostname", () => {
  assert.deepEqual(doorFor("evil.lilna.supersonic.cv", ROOT), { kind: "nowhere" });
  assert.deepEqual(doorFor("supersonic.cv", ROOT), { kind: "attached", hostname: "supersonic.cv" });
});

test("no Host at all is nowhere", () => {
  assert.deepEqual(doorFor(undefined, ROOT), { kind: "nowhere" });
  assert.deepEqual(doorFor("", ROOT), { kind: "nowhere" });
});

test("only a non-public app on an attached domain goes back to the platform", () => {
  const attached = doorFor("acme.com", ROOT);
  const issued = doorFor("lilna.supersonic.cv", ROOT);
  assert.equal(mustReturnToPlatform(attached, "public"), false);
  assert.equal(mustReturnToPlatform(attached, "private"), true);
  assert.equal(mustReturnToPlatform(attached, "shared"), true);
  assert.equal(mustReturnToPlatform(attached, "workspace"), true);
  // Never on the address the cookie is scoped to — that is where the gate works.
  assert.equal(mustReturnToPlatform(issued, "private"), false);
});

test("the return keeps the path and query the visitor asked for", () => {
  assert.equal(platformUrl("lilna", ROOT, "/orders?page=2"), "https://lilna.supersonic.cv/orders?page=2");
  assert.equal(platformUrl("lilna", ROOT, undefined), "https://lilna.supersonic.cv/");
  // A request line that is not a path (an absolute-form URI, or junk) must not
  // be pasted into a Location header.
  assert.equal(platformUrl("lilna", ROOT, "http://evil.example/x"), "https://lilna.supersonic.cv/");
});

/* ------------------------------------------------------------ two roots */

// The cutover: thebay.cloud is canonical and supersonic.cv still answers. With
// one root the new address is not recognised as a platform host at all — it
// falls through to the attached-domain lookup, finds no row, and the app is
// unreachable at its own new name.
const ROOTS = ["thebay.cloud", "supersonic.cv"];

test("an app answers on every root, not only the canonical one", () => {
  assert.deepEqual(doorFor("lilna.thebay.cloud", ROOTS), { kind: "issued", slug: "lilna" });
  assert.deepEqual(doorFor("lilna.supersonic.cv", ROOTS), { kind: "issued", slug: "lilna" });
});

test("a bad label under ANY root is ours and malformed, never attachable", () => {
  // The trap the loop has to avoid: `continue` here would carry
  // `evil.lilna.thebay.cloud` past the root it belongs to and hand it back as a
  // hostname somebody could attach, inside the namespace we issue.
  assert.deepEqual(doorFor("evil.lilna.thebay.cloud", ROOTS), { kind: "nowhere" });
  assert.deepEqual(doorFor("evil.lilna.supersonic.cv", ROOTS), { kind: "nowhere" });
});

test("somebody else's domain is still theirs", () => {
  assert.deepEqual(doorFor("acme.com", ROOTS), { kind: "attached", hostname: "acme.com" });
  // Ends with our name, is not under it.
  assert.deepEqual(doorFor("notthebay.cloud", ROOTS), { kind: "attached", hostname: "notthebay.cloud" });
});

test("a visitor is sent back to the canonical root, where the cookie is", () => {
  assert.equal(platformUrl("lilna", ROOTS[0], "/orders"), "https://lilna.thebay.cloud/orders");
});
