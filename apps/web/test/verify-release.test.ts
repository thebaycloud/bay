import { test } from "node:test";
import assert from "node:assert/strict";
import { localReferences, missingFiles, verifyRelease, referenceKey } from "../lib/verify-release";

test("script and stylesheet references are found", () => {
  const html = `<!doctype html><link rel=stylesheet href="/assets/a.css"><script src="/assets/a.js"></script>`;
  assert.deepEqual(localReferences(html), ["assets/a.css", "assets/a.js"]);
});

test("every attribute quoting style is handled", () => {
  const html = `<script src="a.js"></script><script src='b.js'></script><script src=c.js></script>`;
  assert.deepEqual(localReferences(html), ["a.js", "b.js", "c.js"]);
});

test("self-closing and spaced attributes are handled", () => {
  const html = `<link rel="icon" href = "/favicon.png" /><img src="/logo.svg"/>`;
  assert.deepEqual(localReferences(html), ["favicon.png", "logo.svg"]);
});

test("somebody else's host is not our problem", () => {
  const html = [
    `<script src="https://cdn.example.com/x.js"></script>`,
    `<script src="http://cdn.example.com/y.js"></script>`,
    `<script src="//cdn.example.com/z.js"></script>`,
    `<img src="data:image/png;base64,AAAA">`,
    `<a href="mailto:hi@example.com">mail</a>`,
    `<a href="tel:+123">call</a>`,
  ].join("");
  assert.deepEqual(localReferences(html), []);
});

test("query strings and fragments are stripped", () => {
  const html = `<script src="/app.js?v=2"></script><link href="/a.css#top">`;
  assert.deepEqual(localReferences(html), ["a.css", "app.js"]);
});

test("leading ./ and / address the same file", () => {
  assert.equal(referenceKey("./assets/a.js"), "assets/a.js");
  assert.equal(referenceKey("/assets/a.js"), "assets/a.js");
  assert.equal(referenceKey("assets/a.js"), "assets/a.js");
});

test("an empty href is ignored rather than reported missing", () => {
  assert.deepEqual(localReferences(`<a href="">x</a><a href="#top">y</a>`), []);
});

// --- the decision

test("a coherent release passes", () => {
  const html = `<script src="/assets/app-a1.js"></script><link href="/assets/app-a1.css">`;
  const verdict = verifyRelease(["index.html", "assets/app-a1.js", "assets/app-a1.css"], html);
  assert.equal(verdict.ok, true);
});

test("an empty build output is refused", () => {
  const v = verifyRelease([], null);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /no files/);
});

test("a release with no index.html is refused", () => {
  const v = verifyRelease(["assets/app.js"], null);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /index\.html/);
});

test("an index pointing at files the build never wrote is refused", () => {
  // The failure this whole check exists for: the build half-succeeded and the site
  // would render blank.
  const html = `<script src="/assets/app-a1.js"></script>`;
  const v = verifyRelease(["index.html"], html);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /assets\/app-a1\.js/);
});

test("the reason names a few missing files and counts the rest", () => {
  const html = Array.from({ length: 8 }, (_, i) => `<script src="/m${i}.js"></script>`).join("");
  const v = verifyRelease(["index.html"], html);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /and 3 more/);
});

test("a release referencing only external assets passes", () => {
  const html = `<script src="https://cdn.example.com/react.js"></script>`;
  assert.equal(verifyRelease(["index.html"], html).ok, true);
});

test("missingFiles compares by normalised key, not raw string", () => {
  const html = `<script src="./assets/a.js"></script>`;
  assert.deepEqual(missingFiles(html, ["assets/a.js"]), []);
});

// --- navigation is not a file
//
// These are the shapes that made this check refuse ordinary sites once it was
// applied to the static lane. Every one of them published correctly before.

test("a nav link is a route, not a file the build must have written", () => {
  const html = `<nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav>`;
  assert.deepEqual(localReferences(html), []);
});

test("a multi-page static site passes", () => {
  // Next.js `output: export`, Hugo, Eleventy, Jekyll — an index full of links to
  // routes that are served from about/index.html, never from an object named "about".
  const html = [
    `<link rel="stylesheet" href="/_next/static/css/abc.css">`,
    `<script src="/_next/static/chunks/main-def.js"></script>`,
    `<a href="/about">About</a><a href="/blog/">Blog</a>`,
  ].join("");
  const present = [
    "index.html", "about.html", "blog/index.html",
    "_next/static/css/abc.css", "_next/static/chunks/main-def.js",
  ];
  assert.deepEqual(verifyRelease(present, html), { ok: true });
});

test("an SPA whose index.html links to a client route passes", () => {
  const html = `<script type="module" src="/assets/index-a1.js"></script><a href="/pricing">Pricing</a>`;
  assert.deepEqual(verifyRelease(["index.html", "assets/index-a1.js"], html), { ok: true });
});

test("a trailing-slash directory link is not a missing file", () => {
  assert.deepEqual(localReferences(`<a href="/about/">About</a>`), []);
});

test("<area> and <form action> are navigation too", () => {
  const html = `<map><area href="/section"></map><form action="/submit"></form>`;
  assert.deepEqual(localReferences(html), []);
});

test("rel=canonical points at a route, not at a file", () => {
  // Emitted by every generator with SEO defaults on.
  const html = `<link rel="canonical" href="/about/"><link rel="alternate" href="/fr/">`;
  assert.deepEqual(localReferences(html), []);
});

test("a link with no rel is still a required file", () => {
  // The 1990s stylesheet spelling, and the case this verifier exists for.
  assert.deepEqual(localReferences(`<link href="/a.css">`), ["a.css"]);
});

test("rel=stylesheet and rel=icon stay required even beside a canonical", () => {
  const html = `<link rel="canonical" href="/x"><link rel="stylesheet" href="/s.css"><link rel="icon" href="/f.png">`;
  assert.deepEqual(localReferences(html), ["f.png", "s.css"]);
});

test("a genuinely missing asset is still caught next to nav links", () => {
  // The regression guard: narrowing the rule must not have disarmed it.
  const html = `<a href="/about">About</a><script src="/assets/app-a1.js"></script>`;
  const v = verifyRelease(["index.html"], html);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /assets\/app-a1\.js/);
  assert.doesNotMatch(v.reason ?? "", /about/);
});

test("an anchor inside a script-ish soup does not invent references", () => {
  const html = `<script>if (a<b && c>d) { }</script><script src="/ok.js"></script>`;
  assert.deepEqual(localReferences(html), ["ok.js"]);
});
