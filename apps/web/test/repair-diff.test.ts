import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotSources, repairPatch } from "../lib/repair-diff";

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repair-diff-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test("what the agent changed comes back as a patch git itself can apply", async () => {
  // The point of the whole module: a fix that exists only in a scratch copy on
  // the server is a fix the user never receives, and their next deploy ships the
  // broken code again.
  const dir = scratch({ "server.js": "const port = 5000;\napp.listen(port);\n" });
  try {
    assert.equal(await snapshotSources(dir), true);

    // Stand in for the repair agent.
    writeFileSync(join(dir, "server.js"), "const port = process.env.PORT || 5000;\napp.listen(port);\n");

    const patch = await repairPatch(dir);
    assert.ok(patch, "a change must produce a patch");
    assert.match(patch!, /^--- a\/server\.js$/m);
    assert.match(patch!, /\+const port = process\.env\.PORT \|\| 5000;/);

    // The real test: git must accept its own output. A patch that does not apply
    // is worse than no patch, because it is advice that fails at the keyboard.
    const target = scratch({ "server.js": "const port = 5000;\napp.listen(port);\n" });
    try {
      writeFileSync(join(target, "fix.patch"), patch! + "\n");
      execFileSync("git", ["-C", target, "init", "-q"]);
      execFileSync("git", ["-C", target, "apply", "fix.patch"]);
      assert.match(readFileSync(join(target, "server.js"), "utf8"), /process\.env\.PORT/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent that changed nothing produces no patch", async () => {
  // Rather than an empty block under a heading promising one.
  const dir = scratch({ "index.js": "console.log(1)\n" });
  try {
    await snapshotSources(dir);
    assert.equal(await repairPatch(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a huge patch is truncated rather than dumped into somebody's terminal", async () => {
  const dir = scratch({ "data.txt": "x\n".repeat(200) });
  try {
    await snapshotSources(dir);
    writeFileSync(join(dir, "data.txt"), "y\n".repeat(200));
    const patch = await repairPatch(dir, 200);
    assert.ok(patch);
    assert.ok(patch!.length < 400, "capped");
    assert.match(patch!, /truncated \(\d+ more bytes\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored files stay out of the patch", async () => {
  // .gitignore is what keeps node_modules and .venv out without a list of
  // exclusions somebody has to maintain.
  const dir = scratch({
    ".gitignore": "node_modules/\n",
    "app.js": "1\n",
    "node_modules/dep/index.js": "module.exports = 1\n",
  });
  try {
    await snapshotSources(dir);
    writeFileSync(join(dir, "node_modules/dep/index.js"), "module.exports = 2\n");
    writeFileSync(join(dir, "app.js"), "2\n");
    const patch = await repairPatch(dir);
    assert.ok(patch);
    assert.match(patch!, /app\.js/);
    assert.ok(!patch!.includes("node_modules"), "an ignored file must not appear");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory git cannot touch reports failure instead of throwing", async () => {
  // Telemetry must never be the reason a rescued deploy fails.
  const missing = join(tmpdir(), "definitely-not-here-4b21");
  assert.equal(await snapshotSources(missing), false);
  assert.equal(await repairPatch(missing), null);
});

test("the patch carries the author's files and not the platform's", async () => {
  // The bug this closes was invisible and total. `snapshotSources` commits the
  // scratch directory AFTER the pipeline has written Dockerfile, .dockerignore
  // and cloudbuild.yaml into it, so an agent that edited the Dockerfile produced
  // a normal `--- a/Dockerfile` hunk — against a repository that has no
  // Dockerfile, because ours is written into OUR copy and never the author's.
  // `git apply` validates every hunk before applying any, so the whole patch
  // aborted and took the real one-line fix with it, at the command the failure
  // email advertises by name.
  const dir = mkdtempSync(join(tmpdir(), "repair-platform-"));
  writeFileSync(join(dir, "requirements.txt"), "flask\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.12\n");
  writeFileSync(join(dir, "cloudbuild.yaml"), "steps: []\n");
  mkdirSync(join(dir, "api"), { recursive: true });
  writeFileSync(join(dir, "api", "Dockerfile"), "FROM golang:1.23\n");

  assert.equal(await snapshotSources(dir), true);

  // The agent fixes the app AND edits the platform's files, which is what it does.
  writeFileSync(join(dir, "requirements.txt"), "flask\ngunicorn\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.12\nRUN apt-get install -y libpq-dev\n");
  writeFileSync(join(dir, "cloudbuild.yaml"), "steps: [changed]\n");
  writeFileSync(join(dir, "api", "Dockerfile"), "FROM golang:1.24\n");

  const patch = await repairPatch(dir);
  assert.ok(patch, "the app fix must still be in the patch");
  assert.match(patch!, /requirements\.txt/);
  assert.match(patch!, /\+gunicorn/);
  // …and nothing the platform owns, at any depth.
  assert.doesNotMatch(patch!, /Dockerfile/);
  assert.doesNotMatch(patch!, /cloudbuild\.yaml/);
});

test("a run that changed only platform files produces no patch at all", async () => {
  // Rather than a patch that is guaranteed to abort. "Nothing to apply" is a
  // truthful answer; a patch the advertised command rejects is not.
  const dir = mkdtempSync(join(tmpdir(), "repair-only-platform-"));
  writeFileSync(join(dir, "app.py"), "x = 1\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.12\n");
  assert.equal(await snapshotSources(dir), true);

  writeFileSync(join(dir, "Dockerfile"), "FROM python:3.13\n");
  assert.equal(await repairPatch(dir), null);
});
