import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, astroServe, nextServe } from "../src/index.ts";

/** Build a throwaway project directory from a map of file → contents. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "serve-test-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
function pkg(deps: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ dependencies: deps, scripts: { build: "build", start: "start" }, ...extra });
}

test("Vite is static and builds to dist", () => {
  const dir = project({ "package.json": pkg({ vite: "^5" }) });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "static", outputDir: "dist" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Create React App is static and builds to build", () => {
  const dir = project({ "package.json": pkg({ "react-scripts": "^5" }) });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "static", outputDir: "build" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bare index.html with no manifest is static, served from the directory itself", () => {
  const dir = project({ "index.html": "<!doctype html>" });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "static", outputDir: "." });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SvelteKit, Nuxt, Remix and NestJS all need a server", () => {
  for (const dep of ["@sveltejs/kit", "nuxt", "@remix-run/node", "@nestjs/core"]) {
    const dir = project({ "package.json": pkg({ [dep]: "^1" }) });
    try {
      assert.deepEqual(detectStack(dir).serve, { mode: "container" }, dep);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Express needs a server", () => {
  const dir = project({ "package.json": pkg({ express: "^4" }) });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "container" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Astro: the adapter decides, and getting this backwards deploys a broken site

test("Astro without an adapter is static", () => {
  assert.deepEqual(astroServe(null), { mode: "static", outputDir: "dist" });
  assert.deepEqual(
    astroServe(`import { defineConfig } from "astro/config";\nexport default defineConfig({});`),
    { mode: "static", outputDir: "dist" },
  );
});

test("Astro with an adapter needs a server", () => {
  assert.deepEqual(
    astroServe(`import node from "@astrojs/node";\nexport default defineConfig({ adapter: node() });`),
    { mode: "container" },
  );
});

test("Astro detection reads the real config file", () => {
  const dir = project({
    "package.json": pkg({ astro: "^4" }),
    "astro.config.mjs": `import node from "@astrojs/node";\nexport default { adapter: node() };`,
  });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "container" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Next.js: only `output: 'export'` produces a directory

test("Next.js defaults to a container", () => {
  assert.deepEqual(nextServe(null), { mode: "container" });
  assert.deepEqual(nextServe(`module.exports = { reactStrictMode: true };`), { mode: "container" });
});

test("Next.js with output export is static and builds to out", () => {
  for (const q of [`"export"`, `'export'`, "`export`"]) {
    assert.deepEqual(
      nextServe(`module.exports = { output: ${q} };`),
      { mode: "static", outputDir: "out" },
      q,
    );
  }
});

test("Next.js detection reads the real config file", () => {
  const dir = project({
    "package.json": pkg({ next: "^14" }),
    "next.config.js": `module.exports = { output: "export" };`,
  });
  try {
    assert.deepEqual(detectStack(dir).serve, { mode: "static", outputDir: "out" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a static-output config in a comment does not fool the container default", () => {
  // Regression guard: matching on the word "export" alone would call every
  // ES-module config static.
  assert.deepEqual(nextServe(`export default { reactStrictMode: true };`), { mode: "container" });
});
