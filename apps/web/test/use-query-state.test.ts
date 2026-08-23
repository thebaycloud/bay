import test from "node:test";
import assert from "node:assert/strict";

/**
 * The URL-writing half of useQueryState, tested as the pure thing it is.
 *
 * Extracted here rather than mocked through React, because what can be wrong is
 * the URL it builds: dropping the default so a shared link is not full of
 * `?tab=chat`, and keeping every OTHER parameter — the workbench writes three of
 * them independently, and a set that rebuilt the query from scratch would erase
 * the other two.
 */
function nextUrl(search: string, key: string, next: string | null, fallback: string | null) {
  const p = new URLSearchParams(search);
  if (next === null || next === fallback) p.delete(key);
  else p.set(key, next);
  const q = p.toString();
  return "/apps/l3sgp" + (q ? `?${q}` : "");
}

test("the default writes no parameter", () => {
  assert.equal(nextUrl("?tab=dev", "tab", "chat", "chat"), "/apps/l3sgp");
  assert.equal(nextUrl("", "view", null, null), "/apps/l3sgp");
});

test("a non-default is written", () => {
  assert.equal(nextUrl("", "tab", "dev", "chat"), "/apps/l3sgp?tab=dev");
});

test("the other parameters survive", () => {
  // Three pieces of state write independently; one that rebuilt the query would
  // drop the other two, and closing a disclosure would kick you out of Analytics.
  assert.equal(
    nextUrl("?tab=dev&addr=shut", "view", "analytics", null),
    "/apps/l3sgp?tab=dev&addr=shut&view=analytics",
  );
  assert.equal(nextUrl("?tab=dev&view=analytics", "addr", "shut", "open"), "/apps/l3sgp?tab=dev&view=analytics&addr=shut");
  // And clearing one leaves the rest.
  assert.equal(nextUrl("?tab=dev&view=analytics", "view", null, null), "/apps/l3sgp?tab=dev");
});
