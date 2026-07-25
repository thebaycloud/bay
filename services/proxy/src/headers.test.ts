import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamHeaders, scrubSetCookie } from "./headers";

const visitor = { userId: "usr_1", email: "boris@acme.com", name: "Boris" };
const COOKIE = "authjs.session-token";

test("spoofed identity headers are replaced, not trusted", () => {
  const out = buildUpstreamHeaders(
    { "x-supersonic-email": "ceo@acme.com", "x-supersonic-user-id": "usr_boss" },
    visitor, COOKIE
  );
  assert.equal(out["x-supersonic-email"], "boris@acme.com");
  assert.equal(out["x-supersonic-user-id"], "usr_1");
});

test("spoofed headers in any casing are dropped", () => {
  const out = buildUpstreamHeaders({ "X-SuperSonic-Workspace": "evil.com" }, visitor, COOKIE);
  assert.equal(out["x-supersonic-workspace"], undefined);
});

test("the session cookie never reaches the app", () => {
  const out = buildUpstreamHeaders(
    { cookie: `${COOKIE}=secret-jwt; theme=dark` }, visitor, COOKIE
  );
  assert.equal(out.cookie, "theme=dark");
  assert.ok(!String(out.cookie).includes("secret-jwt"));
});

test("a cookie header containing only the session is removed entirely", () => {
  const out = buildUpstreamHeaders({ cookie: `${COOKIE}=secret-jwt` }, visitor, COOKIE);
  assert.equal(out.cookie, undefined);
});

test("identity headers are injected", () => {
  const out = buildUpstreamHeaders({}, visitor, COOKIE);
  assert.equal(out["x-supersonic-email"], "boris@acme.com");
  assert.equal(out["x-supersonic-name"], "Boris");
  assert.equal(out["x-supersonic-user-id"], "usr_1");
});

test("upstream Set-Cookie is re-scoped host-only", () => {
  const out = scrubSetCookie({
    "set-cookie": ["sid=1; Path=/; Domain=.supersonic.cv; HttpOnly", "theme=dark; Path=/"],
  });
  assert.deepEqual(out["set-cookie"], ["sid=1; Path=/; HttpOnly", "theme=dark; Path=/"]);
});

test("hop-by-hop headers are not forwarded", () => {
  const out = buildUpstreamHeaders({ connection: "keep-alive", host: "hello.supersonic.cv" }, visitor, COOKIE);
  assert.equal(out.connection, undefined);
  assert.equal(out.host, undefined);
});

// A cookie whose own name is "domain" must survive — only attribute positions
// carry Domain=, and stripping the name=value pair silently breaks the cookie.
test("a cookie named domain is not mistaken for the Domain attribute", () => {
  const out = scrubSetCookie({ "set-cookie": ["domain=acme; Path=/; Domain=.supersonic.cv"] });
  assert.deepEqual(out["set-cookie"], ["domain=acme; Path=/"]);
});
