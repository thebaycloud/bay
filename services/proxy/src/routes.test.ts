import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRoute, parseRoutes, type Route } from "./routes";

const WEB = "https://web-xyz.a.run.app";
const API = "https://api-xyz.a.run.app";
const twoService: Route[] = [{ path: "/", url: WEB }, { path: "/api", url: API }];

test("an app with no routes behaves exactly as it always has", () => {
  // Every app deployed before multi-service existed has no routes, and must be
  // completely unaffected.
  assert.equal(pickRoute(null, "/anything", WEB), WEB);
  assert.equal(pickRoute([], "/anything", WEB), WEB);
  assert.equal(pickRoute(undefined, "/", null), null);
});

test("the longest matching prefix wins, whatever order they are stored in", () => {
  // Not first-match: with "/" listed first, first-match would send every API call
  // to the frontend, and it would look like the backend was down.
  assert.equal(pickRoute(twoService, "/api/items", WEB), API);
  assert.equal(pickRoute(twoService, "/api", WEB), API);
  assert.equal(pickRoute(twoService, "/", WEB), WEB);
  assert.equal(pickRoute(twoService, "/about", WEB), WEB);
  assert.equal(pickRoute([...twoService].reverse(), "/api/items", WEB), API);
});

test("a prefix only matches at a path boundary", () => {
  // `/api` must not capture `/apiary`. Getting this wrong routes a real URL to
  // the wrong service and is near-impossible to spot from outside.
  assert.equal(pickRoute(twoService, "/apiary", WEB), WEB);
  assert.equal(pickRoute(twoService, "/api-docs", WEB), WEB);
  assert.equal(pickRoute(twoService, "/apis", WEB), WEB);
});

test("query strings and fragments are not part of the path", () => {
  assert.equal(pickRoute(twoService, "/api/items?page=2", WEB), API);
  assert.equal(pickRoute(twoService, "/about?x=/api", WEB), WEB);
});

test("a trailing slash on a prefix means the same prefix", () => {
  assert.equal(pickRoute([{ path: "/api/", url: API }, { path: "/", url: WEB }], "/api/items", WEB), API);
});

test("deeper prefixes beat shallower ones", () => {
  const three: Route[] = [
    { path: "/", url: WEB },
    { path: "/api", url: API },
    { path: "/api/admin", url: "https://admin-xyz.a.run.app" },
  ];
  assert.equal(pickRoute(three, "/api/admin/users", WEB), "https://admin-xyz.a.run.app");
  assert.equal(pickRoute(three, "/api/users", WEB), API);
});

test("a request with nothing to serve it falls back rather than 500ing", () => {
  // Routes that cover only /api, on a request for /: the app's own run_url is
  // still the honest answer, and dropping the request would be worse.
  assert.equal(pickRoute([{ path: "/api", url: API }], "/", WEB), WEB);
  assert.equal(pickRoute([{ path: "/api", url: API }], "/", null), null);
});

test("unusable route data cannot swallow an app's traffic", () => {
  assert.equal(parseRoutes(null), null);
  assert.equal(parseRoutes("not json"), null);
  assert.equal(parseRoutes('{"path":"/"}'), null, "an object is not a list of routes");
  assert.equal(parseRoutes('[{"path":"api","url":"x"}]'), null, "a prefix must start with /");
  assert.equal(parseRoutes('[{"path":"/","url":""}]'), null, "a route with no target is not a route");
  assert.deepEqual(parseRoutes(`[{"path":"/","url":"${WEB}"}]`), [{ path: "/", url: WEB }]);
  // Already-parsed JSONB from the driver.
  assert.deepEqual(parseRoutes([{ path: "/", url: WEB }]), [{ path: "/", url: WEB }]);
  // One bad entry does not discard the good ones.
  assert.deepEqual(parseRoutes([{ path: "bad", url: "x" }, { path: "/api", url: API }]), [{ path: "/api", url: API }]);
});
