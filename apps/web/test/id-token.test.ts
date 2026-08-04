import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtExpiry } from "../lib/gcp-rest";

/** A JWT with the given payload. Signature is irrelevant — nothing verifies it here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

test("an identity token is cached until its own exp, not a guessed lifetime", () => {
  // The access-token path can assume 3600s because that is what the metadata
  // server reports alongside it. An identity token arrives as a bare JWT with no
  // envelope, so the only honest source for its lifetime is the token itself.
  const exp = Math.floor(Date.now() / 1000) + 1800;
  assert.equal(jwtExpiry(jwt({ aud: "https://app", exp })), exp * 1000);
});

test("a token whose lifetime cannot be read is not given an invented one", () => {
  // Null sends the caller to `tokenExpiresAt`'s default rather than letting a
  // token be cached past the point it stops working — a cached dead token is a
  // 401 the caller mostly does not recover from, which is the failure the
  // access-token path already carries a comment about.
  assert.equal(jwtExpiry("not-a-jwt"), null);
  assert.equal(jwtExpiry(""), null);
  assert.equal(jwtExpiry(jwt({ aud: "https://app" })), null);
  assert.equal(jwtExpiry("a.!!!not-base64!!!.c"), null);
});
