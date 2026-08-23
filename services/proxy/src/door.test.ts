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

/* --------------------------------------------- two roots, during a rename */

const ROOTS = ["thebay.cloud", "supersonic.cv"];

test("both roots issue the same app while the platform is being renamed", () => {
  // The whole point of the overlap: nobody's bookmark breaks on cutover day,
  // and nobody has to be told a new address before the old one stops working.
  assert.deepEqual(doorFor("lilna.thebay.cloud", ROOTS), { kind: "issued", slug: "lilna" });
  assert.deepEqual(doorFor("lilna.supersonic.cv", ROOTS), { kind: "issued", slug: "lilna" });
});

test("a name under neither root is still somebody's own domain", () => {
  assert.deepEqual(doorFor("acme.com", ROOTS), { kind: "attached", hostname: "acme.com" });
});

test("the guard against a fake slug holds on every root, not just the first", () => {
  // `evil.lilna.thebay.cloud` must not fall through to the attached-domain
  // lookup, or it becomes a hostname somebody can attach inside the namespace
  // we issue. The original check only ever ran against one root; adding a
  // second is exactly how that kind of guard gets left behind.
  assert.deepEqual(doorFor("evil.lilna.thebay.cloud", ROOTS), { kind: "nowhere" });
  assert.deepEqual(doorFor("evil.lilna.supersonic.cv", ROOTS), { kind: "nowhere" });
});

test("one root passed as a plain string still works", () => {
  // Every existing caller passes a string. A signature that quietly required an
  // array would break them at runtime rather than at the type checker.
  assert.deepEqual(doorFor("lilna.supersonic.cv", "supersonic.cv"), { kind: "issued", slug: "lilna" });
});

test("the longest matching root wins, so a root inside a root cannot shadow one", () => {
  // Contrived today and free to defend: with roots ["cloud", "thebay.cloud"],
  // matching the short one first turns lilna.thebay.cloud into the slug
  // "lilna.thebay", which is not a slug, which is a 404 at a working address.
  assert.deepEqual(doorFor("lilna.thebay.cloud", ["cloud", "thebay.cloud"]), { kind: "issued", slug: "lilna" });
});

test("a redirect is built from the canonical root, never from the one asked for", () => {
  // platformUrl is where a private app on an attached domain sends a visitor.
  // Sending them to the legacy root would be building new traffic for a domain
  // being retired.
  assert.equal(platformUrl("lilna", "thebay.cloud", "/x"), "https://lilna.thebay.cloud/x");
});
