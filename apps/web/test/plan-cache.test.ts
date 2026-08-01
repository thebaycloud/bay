import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planKey, planInputs } from "../lib/plan-cache";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-cache-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test("editing application code does not change the plan key", () => {
  // The whole point. Hashing the tree would mean the cache never hits on a
  // repository anyone is working on — and an edit to a React component cannot
  // change how the app is installed, built or started.
  const a = repo({ "package.json": '{"name":"x"}', "src/App.tsx": "export default () => <a/>" });
  const b = repo({ "package.json": '{"name":"x"}', "src/App.tsx": "export default () => <b/>" });
  try {
    assert.equal(planKey(a), planKey(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a changed manifest changes the key", () => {
  const a = repo({ "package.json": '{"scripts":{"start":"node a.js"}}' });
  const b = repo({ "package.json": '{"scripts":{"start":"node b.js"}}' });
  try {
    assert.notEqual(planKey(a), planKey(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("the same bytes in a different place is a different repository", () => {
  // pyproject.toml moving from the root into backend/ is a different shape even
  // when no byte of it changed, and it plans differently.
  const a = repo({ "pyproject.toml": "[project]\nname='x'\n" });
  const b = repo({ "backend/pyproject.toml": "[project]\nname='x'\n" });
  try {
    assert.notEqual(planKey(a), planKey(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("adding a Dockerfile changes the key", () => {
  const a = repo({ "package.json": "{}" });
  const b = repo({ "package.json": "{}", "Dockerfile": "FROM node:24\n" });
  try {
    assert.notEqual(planKey(a), planKey(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a lockfile change changes the key", () => {
  const a = repo({ "package.json": "{}", "package-lock.json": '{"v":1}' });
  const b = repo({ "package.json": "{}", "package-lock.json": '{"v":2}' });
  try {
    assert.notEqual(planKey(a), planKey(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a repository with nothing to key on gets no key", () => {
  // Hashing the empty set would give every bare folder of HTML the same key, and
  // they would serve each other's plans.
  const dir = repo({ "index.html": "<h1>hi</h1>" });
  try {
    assert.equal(planKey(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inputs are the files a planner is asked to read", () => {
  const dir = repo({
    "package.json": "{}",
    "pyproject.toml": "",
    "backend/Dockerfile": "FROM python:3.12\n",
    "supersonic.json": '{"services":[]}',
    "src/index.ts": "console.log(1)",
    "README.md": "# hi",
  });
  try {
    const paths = planInputs(dir).map((e) => e.path).sort();
    assert.deepEqual(paths, ["backend/Dockerfile", "package.json", "pyproject.toml", "supersonic.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
