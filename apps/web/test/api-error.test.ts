import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { authConfig } from "../auth.config";
import { apiError, notAuthenticated, notAuthenticatedBody, forbiddenBody } from "../lib/api-error";

/**
 * What a program gets when it calls the API without a credential.
 *
 * It used to get a 307 to /login and a page of HTML. That is the failure this
 * covers, and it is worth stating why it was worse than an error: a client
 * parsing JSON sees a 2xx after following the redirect, with a body it cannot
 * read, and has no way to tell "you need a token" from "the call worked". The
 * CLI papered over it; an agent calling the API directly could not.
 */

const authorized = authConfig.callbacks!.authorized!;

function ask(path: string, init?: { method?: string; bearer?: string }) {
  const headers = new Headers();
  if (init?.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  const request = new NextRequest(new URL(`https://app.thebay.cloud${path}`), {
    method: init?.method ?? "GET",
    headers,
  });
  return authorized({ request, auth: null } as never);
}

test("an unauthenticated API call is answered, not redirected", async () => {
  const res = await ask("/api/apps");
  assert.ok(res instanceof Response, "the gate returned a boolean, so next-auth will 307 to /login");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="thebay.cloud"');

  const body = await res.json();
  assert.equal(body.error, "not signed in");
  assert.equal(body.code, "not_authenticated");
  assert.match(body.resolution, /Authorization: Bearer/);
  assert.match(body.documentation_url, /^https:\/\/thebay\.cloud\//);
});

test("a page still redirects, because a person can read a sign-in page", async () => {
  assert.equal(await ask("/apps"), false);
});

test("a bearer token is let through for the route to judge", async () => {
  // The gate runs at the edge and cannot reach Postgres, so it cannot tell a
  // valid token from a revoked one. The route does that, and answers 401 in the
  // same shape when the token is no good.
  assert.equal(await ask("/api/apps", { bearer: "whatever" }), true);
});

test("the description is readable without a credential", async () => {
  assert.equal(await ask("/openapi.json"), true);
});

test("the public paths stay public", async () => {
  for (const p of ["/login", "/signup", "/forgot", "/reset", "/verify", "/api/auth/session", "/api/billing/webhook", "/api/github/webhook"]) {
    assert.notEqual(await ask(p), false, `${p} stopped being public`);
  }
});

test("a preflight is never redirected", async () => {
  assert.equal(await ask("/api/apps", { method: "OPTIONS" }), true);
});

test("the error body keeps the key every existing caller reads", () => {
  // `error` is what packages/cli prints. The structured half is added beside it,
  // never instead of it — changing the key would break every installed copy.
  for (const body of [notAuthenticatedBody(), forbiddenBody()]) {
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.code, "string");
    assert.equal(typeof body.resolution, "string");
    assert.equal(typeof body.documentation_url, "string");
  }
  assert.equal(forbiddenBody().code, "forbidden");
});

test("apiError sets the status and refuses to be cached", async () => {
  const res = apiError({ status: 409, code: "deploy_in_flight", error: "a deploy is running" });
  assert.equal(res.status, 409);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).code, "deploy_in_flight");
});

test("notAuthenticated and the body helper agree", async () => {
  const fromResponse = await notAuthenticated().json();
  assert.deepEqual(fromResponse, notAuthenticatedBody());
});
