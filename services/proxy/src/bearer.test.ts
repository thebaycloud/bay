import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

// session.ts imports ./config, which throws at module-evaluation time if
// AUTH_SECRET is unset — a real requirement for the running proxy, unrelated
// to anything bearerFrom checks. `node --test` runs each test file in its own
// process, so the env has to be set before the import, which means a dynamic
// one, exactly as forward.test.ts and config.test.ts do.
process.env.AUTH_SECRET ??= "test-only-config-secret-do-not-log";
const { bearerFrom, platformTokenFrom, hashToken, readVisitor, setPlatformTokenResolver } = await import("./session");
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

test("this file's token hash agrees with apps/web/lib/cli-tokens.ts's", async () => {
  // The one failure mode that fails closed and silently: if the two hash
  // functions ever drift, no CLI token resolves anywhere, and nothing says why.
  const { hash: hashFromWeb } = await import("../../../apps/web/lib/cli-tokens");
  assert.equal(hashToken("fixed-test-token"), hashFromWeb("fixed-test-token"));
});
