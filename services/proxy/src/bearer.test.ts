import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

// session.ts imports ./config, which throws at module-evaluation time if
// AUTH_SECRET is unset — a real requirement for the running proxy, unrelated
// to anything bearerFrom checks. `node --test` runs each test file in its own
// process, so the env has to be set before the import, which means a dynamic
// one, exactly as forward.test.ts and config.test.ts do.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
const { bearerFrom, platformTokenFrom, hashToken, readVisitor, viewerOnce, oneVisitor, setPlatformTokenResolver } = await import("./session");
const { config } = await import("./config");
const { encode } = await import("@auth/core/jwt");

test("a bearer token is read, and nothing else is", () => {
  assert.equal(bearerFrom("Bearer abc123"), "abc123");
  assert.equal(bearerFrom("bearer abc123"), "abc123");
  assert.equal(bearerFrom("Basic abc123"), null);
  assert.equal(bearerFrom(undefined), null);
  assert.equal(bearerFrom("Bearer"), null);
  assert.equal(bearerFrom("Bearer   "), null);
});

test("a bearer that is not shaped like a platform token never enters the platform path", () => {
  // The case that would have caught the Critical: an app's own bearer
  // credential — a visitor's JWT, an API key, whatever the app issues its own
  // users — is not "ss_"-shaped, and must never be mistaken for a platform
  // credential. Only the platform's own prefix opens that door.
  assert.equal(platformTokenFrom("Bearer app-users-own-jwt"), null);
  assert.equal(platformTokenFrom("Bearer ss_abc123"), "ss_abc123");
  assert.equal(platformTokenFrom(undefined), null);
});

test("an ss_ token that fails to resolve returns null and never falls through to a valid cookie", async () => {
  // A platform credential that does not resolve is a failed authentication,
  // not an invitation to fall back to whatever cookie the browser happened to
  // send — so this cookie is built to actually decode, on purpose: if
  // readVisitor ever fell through to it, this assertion would see a real
  // Visitor instead of null and fail.
  //
  // The resolver is swapped out rather than left pointed at the real
  // database: this dev box commonly has a live cloud-sql-proxy tunnel to the
  // shared production Postgres on 127.0.0.1:5433 (see db.ts), and a test that
  // wants "the token does not resolve" should not depend on what a real
  // lookup against that database happens to return, or take however long a
  // real network round trip takes.
  const cookieToken = await encode({
    token: { sub: "user-1", email: "person@example.com", name: "Person" },
    secret: config.authSecret,
    salt: config.sessionCookieName,
  });
  const restore = setPlatformTokenResolver(async () => null);
  try {
    const req = {
      headers: {
        authorization: "Bearer ss_this-token-does-not-exist-anywhere",
        cookie: `${config.sessionCookieName}=${encodeURIComponent(cookieToken)}`,
      },
    } as unknown as IncomingMessage;
    assert.equal(await readVisitor(req), null);
  } finally {
    restore();
  }
});

test("the same person is one identity, whichever door they came through", async () => {
  // The email does not stay in the proxy: forward.ts hands it to the tenant app
  // as x-supersonic-email. While the bearer path returned users.email raw and
  // the cookie path lowercased it, an app keying accounts on that header made
  // two accounts for one human — one for their agent, one for their browser.
  //
  // Both paths build their Visitor with this one call, so they cannot disagree.
  assert.deepEqual(
    oneVisitor("user-1", "Ada@Example.com", "Ada"),
    { userId: "user-1", email: "ada@example.com", name: "Ada" },
  );
  // A users row with no name is a Visitor with no name, not the string "null".
  assert.deepEqual(oneVisitor("user-1", "ADA@EXAMPLE.COM", null),
    { userId: "user-1", email: "ada@example.com", name: "" });

  // And the cookie path really is built from it, end to end.
  const cookieToken = await encode({
    token: { sub: "user-1", email: "Ada@Example.com", name: "Ada" },
    secret: config.authSecret,
    salt: config.sessionCookieName,
  });
  const req = {
    headers: { cookie: `${config.sessionCookieName}=${encodeURIComponent(cookieToken)}` },
  } as unknown as IncomingMessage;
  assert.deepEqual(await readVisitor(req), oneVisitor("user-1", "Ada@Example.com", "Ada"));
});

test("one request asks who is here once, however many branches want to know", async () => {
  // The edge has three places that need the viewer and a path that reached two
  // of them — /_xray from someone who is not the owner. With a bearer token
  // each resolution is an UPDATE plus a SELECT, so that request cost four
  // queries and two writes to learn one thing.
  let calls = 0;
  const restore = setPlatformTokenResolver(async () => {
    calls += 1;
    return { userId: "user-1", email: "ada@example.com", name: "Ada" };
  });
  try {
    const req = { headers: { authorization: "Bearer ss_a-token" } } as unknown as IncomingMessage;
    const viewer = viewerOnce(req);
    const first = await viewer();
    const second = await viewer();
    assert.equal(calls, 1);
    // The same answer, not merely an equal one: two branches must never be able
    // to disagree about who is asking.
    assert.equal(first, second);
    assert.equal(first?.userId, "user-1");

    // A second request resolves for itself — this is scoped to one request and
    // remembers nobody between them — and its concurrent askers still share one
    // resolution, because the promise is held rather than its result.
    const other = viewerOnce(req);
    const [a, b] = await Promise.all([other(), other()]);
    assert.equal(calls, 2);
    assert.equal(a, b);
  } finally {
    restore();
  }
});

test("this file's token hash agrees with apps/web/lib/cli-tokens.ts's", async () => {
  // The one failure mode that fails closed and silently: if the two hash
  // functions ever drift, no CLI token resolves anywhere, and nothing says why.
  const { hash: hashFromWeb } = await import("../../../apps/web/lib/cli-tokens");
  assert.equal(hashToken("fixed-test-token"), hashFromWeb("fixed-test-token"));
});
