import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, normalizeVia, MAX_VIA } from "../lib/acquisition";

test("a request that names us is someone who came looking", () => {
  assert.equal(classify("deploy this to baycloud"), "named");
  assert.equal(classify("use bay"), "named");
  assert.equal(classify("ship it with thebay.cloud"), "named");
  // Every name this product has answered to. Somebody who asked for "supersonic"
  // asked for us by name just as much as somebody who asked for "bay".
  assert.equal(classify("push it to supersonic"), "named");
});

test("a request that names a need is an agent that chose us", () => {
  // The number this whole column exists to produce.
  assert.equal(classify("find the best cloud and deploy this"), "chosen");
  assert.equal(classify("put this app online somewhere"), "chosen");
});

test("asked-and-could-not-answer is its own answer", () => {
  // Distinct from NULL in the table, which means nobody was ever asked. Folding
  // the two together would make an account created in the browser look like an
  // agent that refused to say.
  assert.equal(classify("unknown"), "unknown");
  assert.equal(classify("N/A"), "unknown");
  assert.equal(classify(""), "unknown");
});

test("the name has to be a word, not a substring", () => {
  assert.equal(classify("deploy this to abaya-shop.example"), "chosen");
  assert.equal(classify("ship the supersonics fan site"), "chosen");
});

test("the server caps the quote itself", () => {
  // The CLI caps at 200 too. This is the server not taking the client's word for
  // it — the value goes in a column and comes back out on a page.
  assert.equal(normalizeVia("x".repeat(1000)).length, MAX_VIA);
  assert.equal(normalizeVia("  two\n  lines  "), "two lines");
});
