import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishStatic, type StaticApp, type StaticSource, type PublishDeps } from "../lib/publish-static";

/**
 * Publishing a static site.
 *
 * The assertions worth having are all about ORDER, because order is the only
 * thing here that has ever gone wrong: a pointer named a release that did not
 * exist, and it did so from code that uploaded and then named with nothing in
 * between. None of these could be written while this was a closure reading
 * thirteen values out of a 2900-line function.
 */

const app: StaticApp = { slug: "demo", ownerId: "u1", workspaceId: "w1" };

function siteAt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "static-"));
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

function deps(over: Partial<PublishDeps> = {}) {
  const order: string[] = [];
  const base: PublishDeps = {
    log: () => {},
    around: async (stage, fn) => { order.push(`stage:${stage}`); return fn(); },
    submitBuild: async () => { order.push("build"); },
    uploadDir: async () => { order.push("upload"); },
    assertUploaded: async () => { order.push("verify"); },
    writePointer: async () => { order.push("pointer"); },
    buildError: async () => "",
    upstreamUrl: async () => "https://static.example",
    failureSentence: (h, r) => `${h}: ${r}`,
    ...over,
  };
  return { deps: base, order };
}

test("the pointer is written only after the release has been read back", async () => {
  // The bug this order exists for: a green Cloud Build is not evidence that
  // anything was uploaded — the copy step can exit 0 having copied nothing —
  // and a pointer written on that evidence names a release that is not there.
  const { deps: d, order } = deps();
  const source: StaticSource = {
    dir: siteAt({ "index.html": "<h1>hi</h1>" }), outputDir: "dist",
    installCommand: "npm ci", buildCommand: "npm run build", installVerbatim: false,
  };

  const got = await publishStatic(app, source, d);

  assert.deepEqual(got, { ok: true, url: "https://static.example" });
  assert.ok(order.indexOf("verify") < order.indexOf("pointer"),
    `verification must precede naming — got ${order.join(" → ")}`);
});

test("a failed verification leaves the previous release live", async () => {
  // What makes a failed static deploy harmless: nothing public has moved,
  // because the only thing that moves it is the pointer.
  const { deps: d, order } = deps({
    assertUploaded: async () => { throw new Error("release is empty at that prefix"); },
  });
  const source: StaticSource = {
    dir: siteAt({ "index.html": "x" }), outputDir: "dist",
    installCommand: null, buildCommand: null, installVerbatim: false,
  };

  const got = await publishStatic(app, source, d);

  assert.equal(got.ok, false);
  assert.ok(!order.includes("pointer"), "a release that failed verification must never be named");
});

test("a site that needs no build skips Cloud Build entirely", async () => {
  const { deps: d, order } = deps();
  const source: StaticSource = {
    dir: siteAt({ "dist/index.html": "x" }), outputDir: "dist",
    installCommand: null, buildCommand: null, installVerbatim: false,
  };

  await publishStatic(app, source, d);

  assert.ok(!order.includes("build"), "there is nothing to build — the directory is the site");
  assert.ok(order.includes("upload"));
});

test("a missing output directory is named, because nothing downstream could explain it", async () => {
  // This lane runs no Cloud Build when there is nothing to build, so there is no
  // build log to fall back on: `gcloud exited 1` with no cause anywhere is what
  // the user got. Saying which directory was expected is the whole diagnosis.
  const { deps: d } = deps();
  const source: StaticSource = {
    dir: siteAt({ "index.html": "x" }), outputDir: "dist",   // no dist/
    installCommand: null, buildCommand: null, installVerbatim: false,
  };

  const got = await publishStatic(app, source, d);

  assert.equal(got.ok, false);
  assert.match((got as { error: string }).error, /no `dist` directory to publish/);
});

test("an install command from a plan is run exactly as written", async () => {
  // `(cd frontend && npm ci) --prefer-offline` is a syntax error: a subdirectory
  // command is a subshell and nothing can follow its closing paren. So is
  // `pip install -r requirements.txt --no-audit`. Both came from appending npm
  // flags to a string the platform did not write.
  const configs: string[] = [];
  const { deps: d } = deps({
    submitBuild: async (_dir, configPath) => {
      const { readFileSync } = await import("node:fs");
      configs.push(readFileSync(configPath, "utf8"));
    },
  });
  const base = { dir: siteAt({ "index.html": "x" }), outputDir: "dist", buildCommand: "npm run build" };

  await publishStatic(app, { ...base, installCommand: "(cd web && npm ci)", installVerbatim: true }, d);
  assert.ok(!configs[0].includes("--prefer-offline"), "a plan's command must not be decorated");

  await publishStatic(app, { ...base, installCommand: "npm ci", installVerbatim: false }, d);
  assert.ok(configs[1].includes("--prefer-offline"), "the detector's own command still gets the flags");
});

test("a build failure reports the build log rather than the exit code", async () => {
  // `gcloud exited 1` is not a diagnosis. The reason is in the build's own log,
  // and the caller has no other way to reach it once this returns.
  const { deps: d } = deps({
    submitBuild: async () => { throw new Error("gcloud exited 1"); },
    buildError: async () => "sh: vite: not found",
  });
  const source: StaticSource = {
    dir: siteAt({ "index.html": "x" }), outputDir: "dist",
    installCommand: "npm ci", buildCommand: "npm run build", installVerbatim: false,
  };

  const got = await publishStatic(app, source, d);

  assert.equal(got.ok, false);
  assert.match((got as { error: string }).error, /vite: not found/);
});
