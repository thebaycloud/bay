import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentEnv, frameworkEnv, frameworkBuildEnv, universalFacts } from "../lib/framework-env";
import type { DeploymentFacts } from "../lib/resolve";

const root: DeploymentFacts = {
  hostname: "demo.supersonic.cv", scheme: "https", pathPrefix: "/", siblingUrls: {},
};
const mounted: DeploymentFacts = { ...root, pathPrefix: "/api" };

test("every app learns its own address, whatever it is written in", () => {
  const e = universalFacts(root);
  assert.equal(e.SUPERSONIC_URL, "https://demo.supersonic.cv");
  assert.equal(e.SUPERSONIC_HOSTNAME, "demo.supersonic.cv");
  assert.equal(e.SUPERSONIC_SCHEME, "https");
  assert.equal(e.SUPERSONIC_PATH_PREFIX, "/");
});

test("a mounted service's URL includes the prefix it is mounted under", () => {
  assert.equal(universalFacts(mounted).SUPERSONIC_URL, "https://demo.supersonic.cv/api");
});

test("Django is told the host it will otherwise 400 every request over", () => {
  const e = frameworkEnv("django", root);
  assert.equal(e.ALLOWED_HOSTS, "demo.supersonic.cv");
  // Scheme-qualified: Django requires it, and a bare host is silently useless.
  assert.equal(e.CSRF_TRUSTED_ORIGINS, "https://demo.supersonic.cv");
});

test("FORCE_SCRIPT_NAME is set only when there is actually a prefix", () => {
  // At "/" it would prepend nothing; set wrongly it breaks every URL Django
  // emits at once, so the safe default is absence.
  assert.equal(frameworkEnv("django", root).FORCE_SCRIPT_NAME, undefined);
  assert.equal(frameworkEnv("django", mounted).FORCE_SCRIPT_NAME, "/api");
});

test("NextAuth is pointed at the app rather than at the Cloud Run URL", () => {
  // It defaults to the request host, which is the Cloud Run hostname, so OAuth
  // returns the user to an address that is not the app.
  assert.equal(frameworkEnv("next", root).NEXTAUTH_URL, "https://demo.supersonic.cv");
  assert.equal(frameworkEnv("next", mounted).NEXTAUTH_URL, "https://demo.supersonic.cv/api");
});

test("a prefixed Next app gets its basePath at BUILD time, where it is baked", () => {
  // Next resolves basePath into every emitted asset URL during the build. A
  // bundle built without it requests its JavaScript from the wrong path and
  // renders blank.
  assert.equal(frameworkBuildEnv("next", mounted).NEXT_PUBLIC_BASE_PATH, "/api");
  assert.equal(frameworkBuildEnv("next", root).NEXT_PUBLIC_BASE_PATH, undefined);
});

test("ASGI frameworks are told their root path, and only when mounted", () => {
  assert.equal(frameworkEnv("fastapi", mounted).ROOT_PATH, "/api");
  assert.equal(frameworkEnv("flask", mounted).APPLICATION_ROOT, "/api");
  assert.deepEqual(frameworkEnv("fastapi", root), {});
});

test("Rails force_ssl is only safe because the proxy now sends X-Forwarded-Proto", () => {
  // Without that header this is an infinite redirect loop.
  assert.equal(frameworkEnv("rails", root).FORCE_SSL, "true");
  assert.equal(frameworkEnv("rails", root).RAILS_HOSTS, "demo.supersonic.cv");
});

test("an unknown or absent framework still gets the universal facts and nothing invented", () => {
  assert.deepEqual(frameworkEnv("cobol-on-cogs", root), {});
  assert.deepEqual(frameworkEnv(undefined, root), {});
  const e = deploymentEnv(undefined, root);
  assert.equal(e.SUPERSONIC_URL, "https://demo.supersonic.cv");
  assert.equal(Object.keys(e).length, 4);
});

test("framework matching is case-insensitive and tolerates the detector's spellings", () => {
  assert.ok(frameworkEnv("Django", root).ALLOWED_HOSTS);
  assert.ok(frameworkEnv("Next.js", root).NEXTAUTH_URL);
  assert.ok(frameworkEnv("FastAPI", mounted).ROOT_PATH);
});
