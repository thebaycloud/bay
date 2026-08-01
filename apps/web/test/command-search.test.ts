import { test } from "node:test";
import assert from "node:assert/strict";

import { filterCommands, type CommandItem } from "../lib/command-search";

const items: CommandItem[] = [
  { id: "new", label: "New app", href: "/new" },
  { id: "settings", label: "Settings", href: "/settings" },
  { id: "a", label: "django", hint: "epvmx.supersonic.cv", href: "/apps/epvmx" },
  { id: "b", label: "fastapi", hint: "trml6.supersonic.cv", href: "/apps/trml6" },
  { id: "c", label: "fastapi-tpl", hint: "um2b6.supersonic.cv", href: "/apps/um2b6" },
  { id: "d", label: "Deploy mail test", hint: "fu1cb.supersonic.cv", href: "/apps/fu1cb" },
];

function ids(query: string): string[] {
  return filterCommands(items, query).map((i) => i.id);
}

test("an empty query offers everything, in the order given", () => {
  assert.deepEqual(ids(""), ["new", "settings", "a", "b", "c", "d"]);
  assert.deepEqual(ids("   "), ["new", "settings", "a", "b", "c", "d"]);
});

test("matching is case-insensitive", () => {
  assert.deepEqual(ids("DJANGO"), ["a"]);
  assert.deepEqual(ids("django"), ["a"]);
});

test("an app is findable by its slug, not only its name", () => {
  assert.deepEqual(ids("um2b6"), ["c"]);
});

test("a name that starts with the query beats one that merely contains it", () => {
  // "Deploy mail test" contains "mail"; nothing starts with it.
  assert.deepEqual(ids("mail"), ["d"]);
  // Both fastapi entries start with the query, so the original order holds.
  assert.deepEqual(ids("fastapi"), ["b", "c"]);
  // "test" starts nothing and is interior to "Deploy mail test".
  assert.deepEqual(ids("test"), ["d"]);
});

test("a prefix hit sorts above an interior hit", () => {
  const ranked = filterCommands(
    [
      { id: "interior", label: "my-api-thing", href: "/a" },
      { id: "prefix", label: "api-gateway", href: "/b" },
    ],
    "api",
  );
  assert.deepEqual(ranked.map((i) => i.id), ["prefix", "interior"]);
});

test("no match is an empty list, not everything", () => {
  assert.deepEqual(ids("zzzzz"), []);
});

test("surrounding whitespace in the query is ignored", () => {
  assert.deepEqual(ids("  django  "), ["a"]);
});
