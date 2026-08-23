import { test } from "node:test";
import assert from "node:assert/strict";
import { publicOrigin } from "../lib/public-origin";

/**
 * Where a redirect is allowed to send somebody.
 *
 * This is one line of logic guarding a `Location` header, which makes it worth
 * more tests than its size suggests: it has already failed once in production
 * in a way no local run could reproduce — every test and every `next dev` is on
 * localhost, so the broken answer looks correct everywhere except the one place
 * it matters.
 */

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

/** Run `fn` with `APP_URL` set (or unset, for `undefined`), then put it back. */
function withAppUrl<T>(value: string | undefined, fn: () => T): T {
  const had = Object.hasOwn(process.env, "APP_URL");
  const prev = process.env.APP_URL;
  if (value === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = value;
  try {
    return fn();
  } finally {
    if (had) process.env.APP_URL = prev;
    else delete process.env.APP_URL;
  }
}

test("the container's own address never reaches a redirect", () => {
  // The exact production shape: Next builds req.url from the port the
  // container listens on, and the proxy passes the real host alongside.
  const r = req("http://localhost:8080/api/github/callback?installation_id=1", {
    "x-forwarded-host": "app.supersonic.cv",
    "x-forwarded-proto": "https",
  });
  withAppUrl("https://app.supersonic.cv", () => {
    assert.equal(publicOrigin(r), "https://app.supersonic.cv");
  });
});

test("the environment outranks the headers, so a spoofed host is not an open redirect", () => {
  // `x-forwarded-host` is set by our proxy and by anybody else who wants to.
  // Believing it over the service's own configuration would hand out redirects
  // to an attacker's origin, mid-way through connecting somebody's source code.
  const r = req("http://localhost:8080/api/github/setup", {
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  });
  withAppUrl("https://app.supersonic.cv", () => {
    assert.equal(publicOrigin(r), "https://app.supersonic.cv");
  });
});

test("a deployment that forgot APP_URL still redirects to the forwarded host", () => {
  const r = req("http://localhost:8080/api/github/setup", {
    "x-forwarded-host": "app.thebay.cloud",
    "x-forwarded-proto": "https",
  });
  withAppUrl(undefined, () => {
    assert.equal(publicOrigin(r), "https://app.thebay.cloud");
  });
});

test("the forwarded scheme is not echoed back when it is the proxy's inside leg", () => {
  // The hop we terminate is plain http inside the container. Defaulting to the
  // request's own scheme would downgrade every production redirect to http.
  const r = req("http://localhost:8080/api/github/setup", { host: "app.supersonic.cv" });
  withAppUrl(undefined, () => {
    assert.equal(publicOrigin(r), "https://app.supersonic.cv");
  });
});

test("a comma-joined forwarding header uses the first hop, not the string", () => {
  // Two proxies in front produce "a, b". `https://a, b` is not a URL, and the
  // whole string in a Location header is a redirect to nowhere.
  const r = req("http://localhost:8080/api/github/setup", {
    "x-forwarded-host": "app.supersonic.cv, internal.lb",
    "x-forwarded-proto": "https, http",
  });
  withAppUrl(undefined, () => {
    assert.equal(publicOrigin(r), "https://app.supersonic.cv");
  });
});

test("a malformed APP_URL falls through rather than taking the redirect down", () => {
  const r = req("http://localhost:8080/api/github/setup", {
    "x-forwarded-host": "app.supersonic.cv",
    "x-forwarded-proto": "https",
  });
  withAppUrl("not a url", () => {
    assert.equal(publicOrigin(r), "https://app.supersonic.cv");
  });
});

test("with nothing configured and nothing forwarded, the request's own origin stands", () => {
  // `next dev` — and only that. Keeping this case is what lets the fix be
  // invisible locally instead of breaking the loop everybody develops in.
  const r = req("http://localhost:3000/api/github/setup");
  withAppUrl(undefined, () => {
    assert.equal(publicOrigin(r), "http://localhost:3000");
  });
});
