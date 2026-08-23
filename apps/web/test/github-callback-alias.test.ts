import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/github/callback/route";

/**
 * A person who finishes installing lands wherever the App's *Setup URL* says,
 * and that field is readable through no API and editable only by an owner of
 * the account that owns the App. Ours names `/api/github/callback`; the shipped
 * route is `/api/github/setup`. Until this alias existed the install finished on
 * a 404, with an installation that existed and was bound to nothing.
 */

test("the callback carries the installation across to the route that binds it", async () => {
  const res = await GET(new Request("https://app.supersonic.cv/api/github/callback?installation_id=156002778&setup_action=install"));
  assert.equal(res.status, 307);
  const to = new URL(res.headers.get("location") ?? "");
  assert.equal(to.pathname, "/api/github/setup");
  // Every parameter, untouched. `setup_action` is not read today and is carried
  // anyway: dropping a field here would be a decision made in the wrong module.
  assert.equal(to.searchParams.get("installation_id"), "156002778");
  assert.equal(to.searchParams.get("setup_action"), "install");
});

test("it stays on the origin it was called on", async () => {
  // Local development and the preview hosts are not app.supersonic.cv, and a
  // redirect to a hardcoded host would send a developer's session to production.
  const res = await GET(new Request("http://localhost:3000/api/github/callback?installation_id=1"));
  assert.equal(new URL(res.headers.get("location") ?? "").origin, "http://localhost:3000");
});

test("no query at all is still a redirect, not a crash", async () => {
  const res = await GET(new Request("https://app.supersonic.cv/api/github/callback"));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location") ?? "").pathname, "/api/github/setup");
});
