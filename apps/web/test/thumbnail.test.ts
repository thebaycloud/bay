import { test } from "node:test";
import assert from "node:assert/strict";
import { isCloudRunUrl } from "../lib/thumbnail";

// What this predicate guards is a Google-signed identity token, minted in the
// control plane's own service account name and handed to another service. It
// is the same class of defect phase 0 closed in forward.ts, and it is worth its
// own test for the same reason that one has one.

test("a Cloud Run app is the only thing an app token is minted for", () => {
  assert.equal(isCloudRunUrl("https://svc-abc123-uc.a.run.app"), true);
  // The bare apex, and a trailing dot: `a.run.app.` is a valid absolute FQDN
  // naming the same host, and WHATWG URL preserves the dot rather than
  // stripping it.
  assert.equal(isCloudRunUrl("https://run.app"), true);
  assert.equal(isCloudRunUrl("https://svc-abc123-uc.a.run.app./"), true);
});

test("the fleet load balancer is not an audience and gets no token", () => {
  // This is the defect. placeOnFleet returns `http://<lb-ip>` as the run url,
  // so every fleet app took the branch that mints an identity token for a bare
  // IP — an audience nothing will ever verify.
  assert.equal(isCloudRunUrl("http://8.232.255.172"), false);
  assert.equal(isCloudRunUrl("http://8.232.255.172/"), false);
});

test("a lookalike host does not pass", () => {
  // Suffix matching on ".run.app" without the dot would accept these, and each
  // is a domain anybody can register.
  assert.equal(isCloudRunUrl("https://notrun.app"), false);
  assert.equal(isCloudRunUrl("https://run.app.evil.com"), false);
  assert.equal(isCloudRunUrl("https://myrun.app"), false);
});

test("anything unparseable mints nothing", () => {
  // The direction matters and it is the opposite of the proxy's copy of this
  // predicate: there `false` selects the fleet's edge secret, so an
  // unparseable base would send the wrong credential to a tenant. Here `false`
  // means "mint nothing", so failing to parse is the safe answer.
  assert.equal(isCloudRunUrl(""), false);
  assert.equal(isCloudRunUrl("not a url"), false);
});
