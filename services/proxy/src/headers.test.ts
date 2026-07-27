import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamHeaders, scrubSetCookie, stripHopByHop } from "./headers";

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

// --- hop-by-hop headers on the response

test("transfer-encoding is never copied from upstream", () => {
  // An upstream that streams HTML sends chunked. We buffer that response to
  // inject the overlay and set our own content-length; forwarding both makes a
  // response the load balancer rejects as a protocol error — a 502 the app never
  // sees and cannot explain. Cost a debugging round on a live deploy.
  const out = stripHopByHop({
    "content-type": "text/html",
    "transfer-encoding": "chunked",
    "x-supersonic-release": "r1",
  });
  assert.equal(out["transfer-encoding"], undefined);
  assert.equal(out["content-type"], "text/html");
  assert.equal(out["x-supersonic-release"], "r1");
});

test("every hop-by-hop header is dropped, whatever its case", () => {
  const out = stripHopByHop({
    "Transfer-Encoding": "chunked",
    Connection: "keep-alive",
    "Keep-Alive": "timeout=5",
    TE: "trailers",
    Trailer: "Expires",
    Upgrade: "websocket",
    "proxy-authenticate": "Basic",
    "proxy-authorization": "Basic x",
    "content-length": "12",
  });
  assert.deepEqual(Object.keys(out), ["content-length"]);
});

test("stripping leaves an ordinary response untouched", () => {
  const headers = { "content-type": "application/json", etag: "W/\"abc\"", "cache-control": "no-cache" };
  assert.deepEqual(stripHopByHop({ ...headers }), headers);
});
