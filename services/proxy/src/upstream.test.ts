import { test } from "node:test";
import assert from "node:assert/strict";
import { isCloudRunTarget } from "./upstream";

test("a Cloud Run service URL is a Cloud Run target", () => {
  assert.equal(isCloudRunTarget("https://a8ebb-uyuwsbguuq-uc.a.run.app"), true);
});

test("the fleet load balancer is not", () => {
  assert.equal(isCloudRunTarget("http://8.232.255.172"), false);
});

test("a hostname that merely contains run.app is not", () => {
  // The check is on the hostname's suffix, not on the string anywhere in the URL.
  assert.equal(isCloudRunTarget("https://evil.run.app.attacker.com"), false);
});

test("a path containing run.app is not", () => {
  assert.equal(isCloudRunTarget("http://8.232.255.172/x.run.app"), false);
});

test("a trailing dot on an otherwise valid Cloud Run host is still one", () => {
  // "a8ebb-uyuwsbguuq-uc.a.run.app." is a valid absolute FQDN for the same
  // service "a8ebb-uyuwsbguuq-uc.a.run.app" names. Missing this sends
  // x-supersonic-edge — the fleet's shared secret — to a tenant's app,
  // because false is the branch that sends it at the forward.ts call site.
  assert.equal(isCloudRunTarget("https://a8ebb-uyuwsbguuq-uc.a.run.app."), true);
});

test("the bare run.app apex, with no subdomain, is a Cloud Run target", () => {
  assert.equal(isCloudRunTarget("https://run.app"), true);
});

test("a malformed base is not a Cloud Run target", () => {
  // False here is the same value as "this is a fleet node" — at the
  // forward.ts call site, false is the branch that sends the edge secret.
  // This predicate does not make an unparseable base safe by itself: what
  // does is that forward.ts already throws on one (building
  // `new URL(req.url, targetBase)`) before this function is ever called with
  // it. This test only pins isCloudRunTarget's own behavior in isolation.
  assert.equal(isCloudRunTarget("not a url"), false);
});
