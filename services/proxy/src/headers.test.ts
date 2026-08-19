import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamHeaders, scrubSetCookie, stripHopByHop, allowWorkbenchFraming } from "./headers";

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

// --- what the app is told about the request it is actually serving

test("the app is told the host and scheme the browser used", () => {
  // Without these it sees plain http from a Cloud Run hostname, and every
  // absolute URL it builds — OAuth redirect_uri, password-reset links, canonical
  // tags — points somewhere the visitor cannot reach.
  const out = buildUpstreamHeaders({ host: "hello.supersonic.cv" }, visitor, COOKIE);
  assert.equal(out["x-forwarded-host"], "hello.supersonic.cv");
  assert.equal(out["x-forwarded-proto"], "https");
  assert.equal(out.forwarded, "host=hello.supersonic.cv;proto=https");
});

test("a spoofed x-forwarded-proto from the client is overwritten, not honoured", () => {
  // The visitor is on the far side of the trust boundary. Honouring this would
  // let a browser downgrade an app's own password-reset links to http, or point
  // its OAuth redirect_uri at evil.com.
  const out = buildUpstreamHeaders(
    {
      host: "hello.supersonic.cv",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "evil.com",
      "x-forwarded-prefix": "/admin",
      forwarded: "host=evil.com;proto=http",
    },
    visitor, COOKIE
  );
  assert.equal(out["x-forwarded-proto"], "https");
  assert.equal(out["x-forwarded-host"], "hello.supersonic.cv");
  assert.equal(out["x-forwarded-prefix"], undefined);
  assert.equal(out.forwarded, "host=hello.supersonic.cv;proto=https");
  // Overwritten, never appended to: an app reading the leftmost element must not
  // find a value the visitor chose.
  assert.ok(!JSON.stringify(out).includes("evil.com"));
});

test("the client IP the load balancer observed is passed on", () => {
  // The one field we cannot observe ourselves — our socket peer is the LB — and
  // the one an app cannot recover if we drop it: rate limiting, abuse blocking,
  // geo and audit logs all need it.
  const out = buildUpstreamHeaders(
    { host: "hello.supersonic.cv", "x-forwarded-for": "203.0.113.7" }, visitor, COOKIE
  );
  assert.equal(out["x-forwarded-for"], "203.0.113.7");
  assert.equal(out.forwarded, "for=203.0.113.7;host=hello.supersonic.cv;proto=https");
});

test("only the LB's own entry survives a chain a client tried to seed", () => {
  // The LB rewrites the chain and APPENDS the address it saw, so the last element
  // is the one Google wrote and the only one a client could not have. Anything
  // the client prepended sits to its left and is dropped, rather than being
  // handed to an app that reads the chain leftmost-first.
  const out = buildUpstreamHeaders(
    { host: "hello.supersonic.cv", "x-forwarded-for": "1.1.1.1, 9.9.9.9, 203.0.113.7" },
    visitor, COOKIE
  );
  assert.equal(out["x-forwarded-for"], "203.0.113.7");
  assert.ok(!String(out.forwarded).includes("1.1.1.1"));
});

test("an IPv6 client is bracketed and quoted in the forwarded header", () => {
  // RFC 7239 §6 spells it for="[2001:db8::1]"; bare, it is a parse error.
  const out = buildUpstreamHeaders(
    { host: "hello.supersonic.cv", "x-forwarded-for": "2001:db8::1" }, visitor, COOKIE
  );
  assert.equal(out["x-forwarded-for"], "2001:db8::1");
  assert.equal(out.forwarded, 'for="[2001:db8::1]";host=hello.supersonic.cv;proto=https');
});

test("a client IP that is not an address is dropped rather than relayed", () => {
  for (const chain of ["1.1.1.1, unknown", "1.1.1.1, evil;proto=http", "1.1.1.1, "]) {
    const out = buildUpstreamHeaders({ host: "hello.supersonic.cv", "x-forwarded-for": chain }, visitor, COOKIE);
    assert.equal(out["x-forwarded-for"], undefined, `${chain} should not be relayed`);
    assert.equal(out.forwarded, "host=hello.supersonic.cv;proto=https");
  }
});

test("a spoofed forwarded header in any casing is dropped", () => {
  const out = buildUpstreamHeaders(
    { host: "hello.supersonic.cv", "X-Forwarded-Proto": "http", Forwarded: "proto=http" },
    visitor, COOKIE
  );
  assert.equal(out["x-forwarded-proto"], "https");
  assert.equal(out.forwarded, "host=hello.supersonic.cv;proto=https");
});

test("the prefix is set only for a service mounted under one", () => {
  const at = (prefix?: string | null) =>
    buildUpstreamHeaders({ host: "hello.supersonic.cv" }, visitor, COOKIE, "hello", prefix)["x-forwarded-prefix"];
  assert.equal(at("/api"), "/api");
  assert.equal(at("/api/"), "/api", "a trailing slash is the same mount point");
  // A service that owns "/" must get nothing: told "/", Django's
  // FORCE_SCRIPT_NAME emits "//about" and Next refuses to build a basePath.
  assert.equal(at("/"), undefined);
  assert.equal(at(null), undefined);
  assert.equal(at(undefined), undefined);
});

test("a host that is not a host does not reach the upstream", () => {
  // The host is spliced into `forwarded`, where a ";" would add parameters we
  // never wrote. Dropped rather than repaired.
  for (const host of ["evil.com;proto=http", "hello.supersonic.cv, evil.com", 'a"b'])  {
    const out = buildUpstreamHeaders({ host }, visitor, COOKIE);
    assert.equal(out["x-forwarded-host"], undefined, `${host} should not be forwarded`);
    assert.equal(out.forwarded, "proto=https");
  }
});

test("a host carrying a port is quoted in the forwarded header", () => {
  // ":" is not a token character, so an unquoted host=app.local:8080 is a parse
  // error rather than a value the app quietly ignores.
  const out = buildUpstreamHeaders({ host: "app.local:8080" }, visitor, COOKIE);
  assert.equal(out["x-forwarded-host"], "app.local:8080");
  assert.equal(out.forwarded, 'host="app.local:8080";proto=https');
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

test("the visitor's own Authorization reaches the app", () => {
  // It did not, and that is what "it keeps logging me out" was: the invoker
  // token for Cloud Run was written into the same header, so an app using
  // OAuth2PasswordBearer got a token minted for Google instead of its user's.
  const out = buildUpstreamHeaders(
    { authorization: "Bearer app-users-own-jwt", cookie: "x=1" },
    { userId: "u1", email: "a@b.c", name: "A" },
    "__Secure-authjs.session-token",
  );
  assert.equal(out.authorization, "Bearer app-users-own-jwt");
});

test("a platform CLI token is stripped before it reaches the upstream", () => {
  // The complement of "the visitor's own Authorization reaches the app" above:
  // an ss_ token is a full platform identity (apps/web/lib/session.ts accepts
  // it as currentUserId), so forwarding it verbatim would hand an agent's
  // platform credential to whichever tenant app it was addressed to — including
  // one it does not own — in that app's own request logs.
  const out = buildUpstreamHeaders(
    { authorization: "Bearer ss_abc123", cookie: "x=1" },
    { userId: "u1", email: "a@b.c", name: "A" },
    "__Secure-authjs.session-token",
  );
  assert.equal(out.authorization, undefined);
});

test("what counts as ours is the scheme's case, never the prefix's", () => {
  const strip = (authorization: string) => buildUpstreamHeaders(
    { authorization },
    { userId: "u1", email: "a@b.c", name: "A" },
    "__Secure-authjs.session-token",
  ).authorization;

  // The scheme is case-insensitive, per RFC 9110 §11.1 — a client that sends
  // `bearer` is sending the same credential we would strip as `Bearer`.
  assert.equal(strip("bearer ss_abc123"), undefined);
  assert.equal(strip("BEARER ss_abc123"), undefined);

  // The prefix is not. session.ts and apps/web/lib/cli-tokens.ts both test it
  // with startsWith("ss_"), so `SS_` is NOT a platform token to either of them
  // — and a hosted app that issues its own uppercase SS_ bearers would have had
  // its users' credentials removed at the edge while it went on being handed
  // every other shape untouched.
  assert.equal(strip("Bearer SS_abc123"), "Bearer SS_abc123");
  assert.equal(strip("Bearer Ss_abc123"), "Bearer Ss_abc123");
});

test("an inbound x-serverless-authorization is never trusted through", () => {
  // The slot the invoker token now lives in. A visitor who could set it would be
  // choosing what we present to Cloud Run.
  const out = buildUpstreamHeaders(
    { "x-serverless-authorization": "Bearer forged" },
    { userId: "u1", email: "a@b.c", name: "A" },
    "__Secure-authjs.session-token",
  );
  assert.equal(out["x-serverless-authorization"], undefined);
});

test("the workbench may frame a tenant document, and nobody else", () => {
  const h = allowWorkbenchFraming({ "content-type": "text/html" });
  assert.equal(h["content-security-policy"], "frame-ancestors https://app.supersonic.cv");
});

test("X-Frame-Options is dropped whatever case it arrived in", () => {
  // It has no allowlist form, so DENY and SAMEORIGIN both refuse the workbench and
  // neither can be narrowed. Dropping it and answering with frame-ancestors is
  // strictly narrower than SAMEORIGIN would have been.
  for (const key of ["X-Frame-Options", "x-frame-options", "X-FRAME-OPTIONS"]) {
    const h = allowWorkbenchFraming({ [key]: "DENY" });
    assert.equal(Object.keys(h).some((k) => k.toLowerCase() === "x-frame-options"), false);
  }
});

test("an app's own frame-ancestors is replaced, not appended to", () => {
  // A browser enforces the INTERSECTION of every CSP header it receives, so a
  // second header could never widen 'none'. The directive has to be rewritten.
  const h = allowWorkbenchFraming({
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src *",
  });
  assert.equal(
    h["content-security-policy"],
    "default-src 'self'; img-src *; frame-ancestors https://app.supersonic.cv",
  );
});

test("the rest of an app's policy survives untouched", () => {
  const h = allowWorkbenchFraming({
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'",
  });
  assert.equal(
    h["content-security-policy"],
    "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors https://app.supersonic.cv",
  );
});

test("only one CSP header goes out, whatever case the app used", () => {
  const h = allowWorkbenchFraming({ "Content-Security-Policy": "frame-ancestors 'self'" });
  const names = Object.keys(h).filter((k) => k.toLowerCase() === "content-security-policy");
  assert.equal(names.length, 1);
  assert.equal(h[names[0]], "frame-ancestors https://app.supersonic.cv");
});

test("report-only policies are left alone — they enforce nothing", () => {
  const h = allowWorkbenchFraming({
    "content-security-policy-report-only": "frame-ancestors 'none'",
  });
  assert.equal(h["content-security-policy-report-only"], "frame-ancestors 'none'");
});
