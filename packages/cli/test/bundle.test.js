"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  caseCollisions, describeBundle, findLfsPointers, heldBack, isLfsPointer,
  lostExecBits, packageFolder, planBundle, wantsGitMetadata,
} = require("../lib/bundle.js");

/** A real directory on disk. Values are file bodies; `{ mode }` sets the bit. */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cli-bundle-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === "string" ? body : body.body, { mode: (body && body.mode) || 0o644 });
  }
  return dir;
}

/**
 * A real git repository. Everything is committed unless `untracked` lists it;
 * `force` names files added past .gitignore, the way a real `git add -f` puts a
 * committed `dist/` into the index of a repo that also ignores it.
 */
function repo(files, { commit = true, untracked = [], force = [] } = {}) {
  const dir = tree(files);
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "commit.gpgsign", "false");
  if (commit) {
    for (const name of Object.keys(files)) {
      if (untracked.includes(name)) continue;
      const add = force.includes(name) ? ["add", "-f", "--", name] : ["add", "--", name];
      spawnSync("git", add, { cwd: dir, encoding: "utf8" });
    }
    g("commit", "-q", "-m", "init", "--allow-empty");
  }
  return { dir, g };
}

function names(plan) { return plan.files.slice().sort(); }

// --- the whole point: git computes the list, not tar

test("a .gitignore negation is honoured", () => {
  // tar reads `!keep.js` as a literal filename pattern and excludes nothing, so the
  // file the author explicitly rescued was the one that went missing.
  const { dir } = repo({
    ".gitignore": "*.js\n!keep.js\n",
    "keep.js": "kept",
    "drop.js": "dropped",
    "index.html": "<p>",
  });
  const plan = planBundle(dir);
  assert.equal(plan.source, "git");
  assert.ok(names(plan).includes("keep.js"), "keep.js was rescued by the negation");
  assert.ok(!names(plan).includes("drop.js"), "drop.js is ignored");
});

test("an anchored /dist is honoured, and a nested dist/ is not touched", () => {
  // `--exclude-from=.gitignore` never matches `/dist` at all, and `--exclude=dist`
  // matches at every depth. Both are wrong; git gets it exactly right.
  const { dir } = repo({
    ".gitignore": "/dist\n",
    "dist/bundle.js": "root build output, ignored",
    "packages/dist/real.js": "a directory that happens to be named dist",
    "index.js": "x",
  });
  const plan = planBundle(dir);
  assert.ok(!names(plan).includes("dist/bundle.js"));
  assert.ok(names(plan).includes("packages/dist/real.js"));
});

test("a source directory named src/build/ survives", () => {
  // The old denylist matched `build` on basename at any depth, so a module named
  // build/ was stripped and the app failed later with "module not found".
  const { dir } = repo({
    "src/build/index.ts": "export const build = 1",
    "src/vendor/lib.php": "<?php",
    "app/target/main.rs": "fn main() {}",
    "out/page.tsx": "committed output that IS the deliverable",
  });
  const plan = planBundle(dir);
  const got = names(plan);
  for (const f of ["src/build/index.ts", "src/vendor/lib.php", "app/target/main.rs", "out/page.tsx"]) {
    assert.ok(got.includes(f), `${f} should ship`);
  }
});

test("an untracked file that is not ignored still ships", () => {
  // The git path used to ship only what was committed, so a file the author had just
  // created — and had not committed yet — was missing from their own deploy.
  const { dir } = repo({ "index.js": "x", "scratch.js": "brand new" }, { untracked: ["scratch.js"] });
  assert.ok(names(planBundle(dir)).includes("scratch.js"));
});

test("an ignored file is excluded and counted", () => {
  const { dir } = repo({
    ".gitignore": "node_modules/\nsecret.txt\n",
    "node_modules/left-pad/index.js": "x",
    "secret.txt": "x",
    "index.js": "x",
  });
  const plan = planBundle(dir);
  assert.deepEqual(names(plan), [".gitignore", "index.js"]);
  assert.ok(plan.ignored.count >= 2, "ignored paths are counted");
  assert.ok(plan.ignored.top.includes("node_modules"));
});

test("a tracked file that is also ignored still ships", () => {
  // gitignore does not apply to files already in the index. tar had no idea.
  const { dir } = repo(
    { ".gitignore": "dist/\n", "dist/app.js": "the deliverable", "index.js": "x" },
    { force: ["dist/app.js"] },
  );
  assert.ok(names(planBundle(dir)).includes("dist/app.js"));
});

test("a file deleted from the working tree does not abort the archive", async () => {
  const { dir } = repo({ "index.js": "x", "gone.js": "x" });
  fs.unlinkSync(path.join(dir, "gone.js"));
  const plan = planBundle(dir);
  assert.equal(plan.missing, 1);
  assert.ok(!names(plan).includes("gone.js"));
  const tgz = await packageFolder(dir);
  assert.ok(fs.existsSync(tgz));
  fs.unlinkSync(tgz);
});

// --- credentials never ride along

test(".env and every variant of it is held back", () => {
  const { dir } = repo({
    ".env": "A=1",
    ".env.production": "B=2",
    ".env.local": "C=3",
    "index.js": "x",
  });
  const plan = planBundle(dir);
  assert.deepEqual(names(plan), ["index.js"]);
  assert.equal(plan.held.env.length, 3);
});

test("heldBack names the reason", () => {
  assert.equal(heldBack(".env.production"), "env");
  assert.equal(heldBack("config/.env.staging"), "env");
  assert.equal(heldBack("src/._page.js"), "macos");
  assert.equal(heldBack("src/.DS_Store"), "macos");
  assert.equal(heldBack("src/environment.ts"), null);
  assert.equal(heldBack("src/.environment"), null);
});

// --- no repository at all

test("a folder with no .git falls back to the denylist and says so", async () => {
  const dir = tree({ "index.html": "<p>", "node_modules/x/i.js": "dep", ".env": "A=1" });
  const plan = planBundle(dir);
  assert.equal(plan.source, "denylist");
  assert.equal(plan.files, null);
  assert.match(describeBundle(plan)[0].text, /no git repository/);

  const tgz = await packageFolder(dir);
  const listing = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout;
  assert.ok(listing.includes("./index.html"));
  assert.ok(!listing.includes("node_modules"));
  assert.ok(!listing.includes(".env"));
  fs.unlinkSync(tgz);
});

// --- the executable bit

test("the executable bit survives the round trip", async () => {
  const { dir } = repo({ "start.sh": { body: "#!/bin/sh\nexec node .\n", mode: 0o755 }, "index.js": "x" });
  const tgz = await packageFolder(dir);
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cli-bundle-x-"));
  assert.equal(spawnSync("tar", ["-xzf", tgz, "-C", out]).status, 0);
  assert.ok(fs.statSync(path.join(out, "start.sh")).mode & 0o100, "start.sh is still executable");
  fs.unlinkSync(tgz);
  fs.rmSync(out, { recursive: true, force: true });
});

test("a file git calls executable but the working copy does not is reported", () => {
  const { dir, g } = repo({ "start.sh": { body: "#!/bin/sh\n", mode: 0o755 }, "index.js": "x" });
  assert.deepEqual(lostExecBits(dir), []);
  // Exactly what core.fileMode=false or an exFAT checkout leaves behind: 100755 in
  // the index, 0644 on disk, and a container that exits "permission denied".
  fs.chmodSync(path.join(dir, "start.sh"), 0o644);
  g("config", "core.fileMode", "false");
  assert.deepEqual(lostExecBits(dir), ["start.sh"]);
  assert.match(describeBundle(planBundle(dir)).find((l) => l.level === "warn").text, /start\.sh/);
});

// --- case collisions

test("paths that differ only by case are found", () => {
  assert.deepEqual(caseCollisions(["src/Button.tsx", "src/button.tsx", "src/App.tsx"]),
    [["src/Button.tsx", "src/button.tsx"]]);
  assert.deepEqual(caseCollisions(["a/b.ts", "a/c.ts"]), []);
});

/** True when this volume cannot tell `Button.tsx` from `button.tsx` — i.e. a dev Mac. */
const CASE_INSENSITIVE = (() => {
  const d = tree({ "A": "x" });
  return fs.existsSync(path.join(d, "a"));
})();

// Only reproducible where the collision is real. On a case-sensitive volume the two
// names are two files and there is nothing to warn about; `caseCollisions` above
// pins the logic itself on every platform.
test("a case collision is warned about by name", { skip: !CASE_INSENSITIVE }, () => {
  const { dir, g } = repo({ "src/Button.tsx": "x", "src/app.tsx": "x" });
  // A case-insensitive volume cannot hold both files at once — that *is* the bug — so
  // the colliding name goes straight into the index, which is exactly how it arrives
  // from a colleague on Linux and what the Mac then cannot represent on disk.
  const blob = g("hash-object", "-w", path.join(dir, "src", "Button.tsx")).trim();
  g("update-index", "--add", "--cacheinfo", `100644,${blob},src/button.tsx`);
  const plan = planBundle(dir);
  assert.deepEqual(plan.collisions, [["src/Button.tsx", "src/button.tsx"]]);
  const warn = describeBundle(plan).find((l) => l.level === "warn");
  assert.match(warn.text, /differ only by case/);
  assert.match(warn.text, /src\/button\.tsx/);
});

// --- git lfs

const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12345\n";

test("an lfs pointer is recognised and real media is not", () => {
  assert.ok(isLfsPointer(Buffer.from(POINTER)));
  assert.ok(!isLfsPointer(Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])));
  const dir = tree({ "video.mp4": POINTER, "logo.png": "\x89PNG\r\n\x1a\n" + "x".repeat(400) });
  assert.deepEqual(findLfsPointers(dir, ["video.mp4", "logo.png"]), ["video.mp4"]);
});

test("a pointer that cannot be fetched fails loudly and names the file", async () => {
  const { dir } = repo({ "video.mp4": POINTER, "index.js": "x" });
  await assert.rejects(() => packageFolder(dir), (e) => {
    assert.match(e.message, /git-lfs pointer/);
    assert.match(e.message, /video\.mp4/);
    assert.match(e.message, /git lfs pull/);
    return true;
  });
});

// --- .git metadata for scm-versioned builds

test("a setuptools-scm project asks for .git; a plain one does not", () => {
  const scm = tree({ "pyproject.toml": '[build-system]\nrequires = ["setuptools>=64", "setuptools_scm>=8"]\n' });
  assert.equal(wantsGitMetadata(scm).backend, "setuptools-scm");
  assert.equal(wantsGitMetadata(tree({ "setup.py": "setup(use_scm_version=True)" })).backend, "setuptools-scm");
  assert.equal(wantsGitMetadata(tree({ "pyproject.toml": '[tool.hatch.version]\nsource = "vcs"\n' })).backend, "hatch-vcs");
  assert.equal(wantsGitMetadata(tree({ "pyproject.toml": '[project]\nname = "x"\nversion = "1.0"\n' })), null);
  assert.equal(wantsGitMetadata(tree({ "package.json": "{}" })), null);
});

test("the tarball carries .git only when a build reads the history from it", async () => {
  const plain = repo({ "pyproject.toml": '[project]\nname = "x"\nversion = "1"\n' });
  let tgz = await packageFolder(plain.dir);
  assert.ok(!spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout.includes(".git/"));
  fs.unlinkSync(tgz);

  const scm = repo({ "pyproject.toml": '[build-system]\nrequires = ["setuptools_scm"]\n', "pkg/__init__.py": "" });
  const plan = planBundle(scm.dir);
  assert.equal(plan.gitMeta.include, true);
  assert.match(describeBundle(plan).find((l) => l.text.includes(".git")).text, /setuptools-scm/);
  tgz = await packageFolder(scm.dir);
  const listing = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout;
  assert.ok(listing.includes(".git/HEAD"), "HEAD ships so `git describe` has something to answer");
  assert.ok(!listing.includes(".git/hooks/"), "hooks do not");
  fs.unlinkSync(tgz);
});

// --- what the person actually sees

test("the log reports counts and categories, not a file dump", () => {
  const { dir } = repo({
    ".gitignore": "node_modules/\n",
    "node_modules/a/i.js": "x",
    "node_modules/b/i.js": "x",
    ".env": "A=1",
    "index.js": "x",
  });
  const lines = describeBundle(planBundle(dir)).map((l) => l.text);
  assert.match(lines[0], /^2 files from git$/);
  assert.ok(lines.some((t) => /skipped \d+ ignored path/.test(t) && t.includes("node_modules")));
  assert.ok(lines.some((t) => /held back 1 .env file/.test(t)));
  assert.ok(!lines.some((t) => t.includes("node_modules/a/i.js")), "no file dump");
});
