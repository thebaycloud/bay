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

test("a malformed base is not a Cloud Run target", () => {
  // Refusing to parse must not mean "send the tenant our secret".
  assert.equal(isCloudRunTarget("not a url"), false);
});
