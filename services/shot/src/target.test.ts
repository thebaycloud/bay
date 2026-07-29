import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTarget, isStaticUpstream, objectPath } from "./target.ts";

const TOKEN = "tok123";

test("a container app is navigated with an ID token and nothing else", () => {
  const t = buildTarget("myapp", "https://myapp-abc123-uc.a.run.app", TOKEN);
  assert.equal(t?.url, "https://myapp-abc123-uc.a.run.app");
  assert.deepEqual(t?.headers, { Authorization: "Bearer tok123" });
});

test("a static app also carries the slug, or the shared server cannot place it", () => {
  const t = buildTarget("myapp", "https://supersonic-static-abc-uc.a.run.app", TOKEN);
  assert.equal(t?.headers["x-supersonic-slug"], "myapp");
  assert.equal(t?.headers.Authorization, "Bearer tok123");
});

test("the static server is recognised by host, not by guesswork", () => {
  assert.equal(isStaticUpstream("https://supersonic-static-abc-uc.a.run.app"), true);
  assert.equal(isStaticUpstream("https://supersonic-static.supersonic.cv"), true);
  assert.equal(isStaticUpstream("https://myapp-abc-uc.a.run.app"), false);
  // A host merely starting with the same letters is not the static server.
  assert.equal(isStaticUpstream("https://supersonic-staticky-abc-uc.a.run.app"), false);
});

test("a public app needs no token", () => {
  const t = buildTarget("myapp", "https://myapp-abc-uc.a.run.app", null);
  assert.deepEqual(t?.headers, {});
});

// --- refusals: this drives a real browser, so a loose target is SSRF with a
// rendering engine attached.

test("a host that is not ours is refused", () => {
  assert.equal(buildTarget("myapp", "https://evil.example.com", TOKEN), null);
  assert.equal(buildTarget("myapp", "https://run.app.evil.com", TOKEN), null);
  assert.equal(buildTarget("myapp", "https://supersonic.cv.evil.com", TOKEN), null);
});

test("non-https is refused", () => {
  assert.equal(buildTarget("myapp", "http://myapp-abc-uc.a.run.app", TOKEN), null);
  assert.equal(buildTarget("myapp", "file:///etc/passwd", TOKEN), null);
  assert.equal(buildTarget("myapp", "http://169.254.169.254/", TOKEN), null);
});

test("a malformed slug is refused before anything else happens", () => {
  for (const bad of ["../etc", "a/b", "UPPER", "-lead", "", "a".repeat(70)]) {
    assert.equal(buildTarget(bad, "https://x-abc-uc.a.run.app", TOKEN), null, bad);
  }
});

test("garbage instead of a URL is refused", () => {
  assert.equal(buildTarget("myapp", "not a url", TOKEN), null);
  assert.equal(buildTarget("myapp", "", TOKEN), null);
});

test("only the path is dropped — we always shoot the root", () => {
  const t = buildTarget("myapp", "https://myapp-abc-uc.a.run.app/deep/path?x=1", TOKEN);
  assert.equal(t?.url, "https://myapp-abc-uc.a.run.app");
});

test("the object path is one per app", () => {
  assert.equal(objectPath("myapp"), "_thumbs/myapp.webp");
});
