import { test } from "node:test";
import assert from "node:assert/strict";
import { slugFromHost, objectKey, looksLikeFile } from "./paths.ts";
import { contentType, cacheControl, isFingerprinted } from "./headers.ts";

const ROOT = "supersonic.cv";

// --- slug extraction

test("a single label under the root is the slug", () => {
  assert.equal(slugFromHost("myapp.supersonic.cv", ROOT), "myapp");
  assert.equal(slugFromHost("MyApp.SuperSonic.CV", ROOT), "myapp");
  assert.equal(slugFromHost("myapp.supersonic.cv:8080", ROOT), "myapp");
});

test("the apex and deeper names have no slug", () => {
  assert.equal(slugFromHost("supersonic.cv", ROOT), null);
  assert.equal(slugFromHost("a.b.supersonic.cv", ROOT), null);
});

test("a lookalike domain has no slug", () => {
  // Suffix matching without the dot would make evil-supersonic.cv a valid host.
  assert.equal(slugFromHost("evilsupersonic.cv", ROOT), null);
  assert.equal(slugFromHost("myapp.supersonic.cv.evil.com", ROOT), null);
  assert.equal(slugFromHost("", ROOT), null);
  assert.equal(slugFromHost(undefined, ROOT), null);
});

test("a slug that is not a valid label is rejected", () => {
  assert.equal(slugFromHost("-bad.supersonic.cv", ROOT), null);
  assert.equal(slugFromHost("bad_.supersonic.cv", ROOT), null);
  assert.equal(slugFromHost("../etc.supersonic.cv", ROOT), null);
});

// --- path normalisation

test("ordinary paths normalise to a relative key", () => {
  assert.equal(objectKey("/"), "");
  assert.equal(objectKey("/index.html"), "index.html");
  assert.equal(objectKey("/assets/app.js"), "assets/app.js");
  assert.equal(objectKey("/assets//app.js"), "assets/app.js");
  assert.equal(objectKey("/./assets/app.js"), "assets/app.js");
  assert.equal(objectKey("/app.js?v=2"), "app.js");
});

test("traversal is rejected in every encoding", () => {
  assert.equal(objectKey("/../secret"), null);
  assert.equal(objectKey("/assets/../../secret"), null);
  // Decoding has to happen before the check, or this walks straight through.
  assert.equal(objectKey("/%2e%2e/secret"), null);
  assert.equal(objectKey("/%2E%2E%2Fsecret"), null);
  assert.equal(objectKey("/assets/%2e%2e%2f%2e%2e%2fsecret"), null);
});

test("malformed and hostile input is rejected", () => {
  assert.equal(objectKey("/%"), null);
  assert.equal(objectKey("/a%00b"), null);
  assert.equal(objectKey("relative"), null);
  assert.equal(objectKey("/a\\b"), null);
});

test("traversal that would land back in bounds is still rejected", () => {
  // a/../b resolves to b, which is harmless — but allowing it means trusting the
  // resolver, and there is no reason to.
  assert.equal(objectKey("/a/../b"), null);
});

// --- route vs file

test("a path with an extension looks like a file", () => {
  assert.equal(looksLikeFile("app.js"), true);
  assert.equal(looksLikeFile("assets/logo.svg"), true);
  assert.equal(looksLikeFile("about"), false);
  assert.equal(looksLikeFile("users/42"), false);
  assert.equal(looksLikeFile(""), false);
  assert.equal(looksLikeFile(".gitignore"), false); // leading dot is not an extension
});

// --- content types

test("content types cover what a bundler emits", () => {
  assert.equal(contentType("index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("app.js"), "text/javascript; charset=utf-8");
  assert.equal(contentType("app.css"), "text/css; charset=utf-8");
  assert.equal(contentType("logo.svg"), "image/svg+xml");
  assert.equal(contentType("font.woff2"), "font/woff2");
  assert.equal(contentType("mystery"), "application/octet-stream");
});

// --- caching

test("index.html is never cached", () => {
  assert.equal(cacheControl("index.html"), "no-cache");
  assert.equal(cacheControl("nested/index.html"), "no-cache");
});

test("fingerprinted assets are immutable", () => {
  assert.equal(isFingerprinted("main.4f3a91c2.js"), true);
  assert.equal(isFingerprinted("index-BQq1nR7x.css"), true);
  assert.equal(cacheControl("assets/index-BQq1nR7x.css"), "public, max-age=31536000, immutable");
});

test("un-fingerprinted assets get a short cache, never immutable", () => {
  assert.equal(isFingerprinted("app.js"), false);
  assert.equal(isFingerprinted("logo.svg"), false);
  assert.equal(cacheControl("logo.svg"), "public, max-age=300");
});
