"use strict";
/**
 * Production rows are not a shape this CLI controls, and the renderer's job is
 * to stay readable when they are hostile: a JSON blob in one column, a newline
 * inside a value, a null beside a number.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderTable, cell } = require("../lib/rows");

test("columns line up under their headers", () => {
  const out = renderTable(["id", "email"], [
    { id: 1, email: "ada@acme.com" },
    { id: 22, email: "b@c.io" },
  ]);
  assert.equal(out[0], "id  email");
  // The rule spans the COLUMN, which is as wide as its widest cell — not as
  // wide as the header word.
  assert.equal(out[1], "──  " + "─".repeat("ada@acme.com".length));
  assert.equal(out[2], "1   ada@acme.com");
  assert.equal(out[3], "22  b@c.io");
});

test("null is an empty cell, not the word null", () => {
  assert.equal(cell(null, 40), "");
  assert.equal(cell(undefined, 40), "");
  assert.equal(cell(0, 40), "0");
  assert.equal(cell(false, 40), "false");
});

test("a newline inside a value cannot break the row below it", () => {
  const out = renderTable(["note"], [{ note: "line one\nline two" }]);
  assert.equal(out.length, 3);
  assert.equal(out[2], "line one line two");
});

test("a long value is clipped, and says so", () => {
  const out = renderTable(["blob"], [{ blob: "x".repeat(100) }], { max: 10 });
  assert.equal(out[2], "x".repeat(9) + "…");
});

test("objects are JSON, not [object Object]", () => {
  assert.equal(cell({ a: 1 }, 40), '{"a":1}');
});

test("no trailing whitespace on any line", () => {
  for (const l of renderTable(["a", "bbbb"], [{ a: "xxxx", bbbb: "y" }])) {
    assert.equal(l, l.trimEnd(), JSON.stringify(l));
  }
});

test("tuples are accepted as well as keyed rows", () => {
  const out = renderTable(["a", "b"], [[1, 2]]);
  assert.equal(out[2], "1  2");
});

test("no columns is no output, not a crash", () => {
  assert.deepEqual(renderTable([], [{ a: 1 }]), []);
  assert.deepEqual(renderTable(undefined, undefined), []);
});
