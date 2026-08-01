"use strict";
/**
 * Choosing what goes into a source bundle, and saying so out loud.
 *
 * This was nineteen `--exclude=` patterns plus `--exclude-from=.gitignore` handed to
 * `tar`, and it was wrong three ways at once:
 *
 *   - tar's patterns match a *basename at any depth*, so `dist`, `build`, `out`,
 *     `vendor`, `target` and `.cache` also matched a module named `src/build/`, a
 *     Composer or `go mod vendor` `app/vendor/`, and a committed `dist/` that *is*
 *     the deliverable. Nothing logged it, so the tree arrived incomplete and the
 *     first anyone heard of it was "module not found" three stages later.
 *   - tar does not speak gitignore. Given a .gitignore it treats `!keep.js` as a
 *     literal pattern rather than a negation, never matches an anchored `/dist`,
 *     and reads `**\/` differently from git. Tracked files were dropped.
 *   - the folder path and the git path shipped different trees for the same repo.
 *
 * git already answers this question, correctly, in one command:
 *
 *     git ls-files -z --cached --others --exclude-standard
 *
 * Tracked files plus untracked-and-not-ignored files, with the real semantics —
 * negations, anchors, nested .gitignore files, .git/info/exclude, the user's global
 * excludes. The denylist survives only as the fallback for a folder that is not a
 * git repository at all, where there is no gitignore to honour and imitating one is
 * the bug rather than the fix.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

/**
 * The fallback list, used only when there is no `.git`.
 *
 * Note what is *not* here any more: `--exclude-from=.gitignore`. A folder with no
 * repository has no gitignore semantics anyone can evaluate, and tar pretending to
 * is what dropped tracked files in the first place.
 */
const DENYLIST = ["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "target", ".venv", "venv", "__pycache__", "vendor", ".DS_Store", "._*", ".env", ".env.*",
  "*.pyc", ".turbo", ".cache", "out"];

/**
 * Paths that never ship, whatever git says about them.
 *
 * `.env` and every variant of it: the values are not lost by holding them back —
 * readEnvFiles carries them up separately and they land as env vars on the service,
 * which is the entire point of sending them out of band. A value baked into a build
 * bundle cannot be rotated. `.env.production` is the file most likely to hold real
 * credentials and is exactly the one a per-name list keeps missing, so this matches
 * the prefix instead of naming variants.
 *
 * `._*` and `.DS_Store` are macOS AppleDouble litter; `._page.js` extracts on the
 * Linux build side and Next tries to compile it.
 */
function heldBack(rel) {
  const base = rel.split("/").pop();
  if (base === ".env" || base.startsWith(".env.")) return "env";
  if (base === ".DS_Store" || base.startsWith("._")) return "macos";
  return null;
}

function splitNul(s) {
  return s.split("\0").filter(Boolean);
}

/** True when `dir` is inside a git working tree we can ask questions of. */
function isGitRepo(dir) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 && String(r.stdout).trim() === "true";
}

function git(dir, args) {
  // 256 MB: `ls-files --others --ignored` over a fat node_modules is genuinely large,
  // and the default 1 MB buffer truncates it into a wrong answer rather than an error.
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
}

/**
 * What git would ship: tracked plus untracked-and-not-ignored, relative to `dir`.
 * Null when this is not a repository, which is the caller's signal to fall back.
 */
function gitFileList(dir) {
  if (!isGitRepo(dir)) return null;
  const r = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (r.status !== 0) return null;
  return splitNul(r.stdout);
}

/**
 * What git ignored, as a count and the few top-level directories responsible.
 *
 * A file dump helps nobody — the answer is usually forty thousand paths under
 * node_modules. The categories are the part a person can act on when something they
 * expected to ship did not.
 */
function ignoredSummary(dir) {
  const r = git(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  if (r.status !== 0) return { count: 0, top: [] };
  const paths = splitNul(r.stdout);
  const byTop = new Map();
  for (const p of paths) {
    const top = p.split("/")[0] || p;
    byTop.set(top, (byTop.get(top) || 0) + 1);
  }
  const top = [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name);
  return { count: paths.length, top };
}

/**
 * Paths that are one file on this Mac and two files on Linux.
 *
 * `src/Button.tsx` and `src/button.tsx` are the same file on a case-insensitive
 * volume, so whichever the editor wrote last is the content both entries carry into
 * the archive. It builds here and breaks there, and the error names an import that
 * looks perfectly correct in the editor.
 */
function caseCollisions(paths) {
  const byLower = new Map();
  for (const p of paths) {
    const k = p.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k).push(p);
  }
  return [...byLower.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

const LFS_MAGIC = "version https://git-lfs.github.com/spec/v1";

/** True for the ~130-byte text stub git-lfs leaves in place of the real bytes. */
function isLfsPointer(buf) {
  return buf.slice(0, LFS_MAGIC.length).toString("latin1") === LFS_MAGIC;
}

/**
 * Files that are LFS pointers rather than content.
 *
 * A repo storing video in LFS without a smudge filter having run ships 130-byte text
 * files with the right names and extensions. They upload fast, extract cleanly, and
 * serve as a corrupt MP4 — the whole pipeline reports success and the app is broken
 * in a way no build log mentions. Pointers are always tiny, so the size check keeps
 * this from being a read of every file in the tree.
 */
function findLfsPointers(dir, files) {
  const hits = [];
  for (const rel of files) {
    let st;
    try { st = fs.statSync(path.join(dir, rel)); } catch { continue; }
    if (!st.isFile() || st.size < LFS_MAGIC.length || st.size > 1024) continue;
    let fd;
    try {
      fd = fs.openSync(path.join(dir, rel), "r");
      const buf = Buffer.alloc(LFS_MAGIC.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (isLfsPointer(buf)) hits.push(rel);
    } catch { /* unreadable — not our problem here */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return hits;
}

/**
 * Files git records as executable whose working copy is not.
 *
 * `core.fileMode=false`, a checkout onto an exFAT volume or a Docker bind mount all
 * produce this, and tar archives the mode it finds on disk. The result is an
 * entrypoint that arrives 0644 and a container that exits with "permission denied"
 * against a script that is plainly present and plainly correct.
 */
function lostExecBits(dir) {
  const r = git(dir, ["ls-files", "-z", "--stage"]);
  if (r.status !== 0) return [];
  const lost = [];
  for (const line of splitNul(r.stdout)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    if (!line.startsWith("100755 ")) continue;
    const rel = line.slice(tab + 1);
    try {
      if (!(fs.statSync(path.join(dir, rel)).mode & 0o100)) lost.push(rel);
    } catch { /* deleted in the worktree; handled elsewhere */ }
  }
  return lost;
}

/**
 * Build backends that read the git history for the version number.
 *
 * setuptools-scm, hatch-vcs, versioneer and pdm/poetry's scm plugins all derive the
 * version from `git describe`. Without `.git` they do not warn — setuptools-scm
 * produces `0.0.0`, versioneer produces `0+unknown`, and hatch-vcs fails the build
 * outright — so the package that gets installed is silently the wrong version, or
 * there is no package at all. These are the only builds worth paying for `.git`.
 */
const VCS_VERSIONING = [
  [/setuptools[-_]scm|use_scm_version/, "setuptools-scm"],
  [/hatch-vcs|source\s*=\s*["']vcs["']/, "hatch-vcs"],
  [/versioneer/, "versioneer"],
  [/pdm-backend|poetry-dynamic-versioning/, "an scm version plugin"],
];

/** Which VCS-versioning backend this project declares, if any. */
function wantsGitMetadata(dir) {
  for (const name of ["pyproject.toml", "setup.py", "setup.cfg"]) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
    for (const [re, label] of VCS_VERSIONING) {
      if (re.test(text)) return { file: name, backend: label };
    }
  }
  return null;
}

/** Roughly how many bytes `.git` will add, from git's own accounting. */
function gitDirBytes(dir) {
  const r = git(dir, ["count-objects", "-v"]);
  if (r.status !== 0) return Infinity;
  let kib = 0;
  for (const line of String(r.stdout).split("\n")) {
    const m = line.match(/^(?:size|size-pack):\s*(\d+)/);
    if (m) kib += Number(m[1]);
  }
  return kib * 1024;
}

// `.git` is worth carrying for a version string; it is not worth carrying a decade of
// history through a 32 MiB upload ceiling. Past this we say so and let the build take
// 0.0.0, which is at least a visible outcome.
const GIT_META_LIMIT = 64 * 1024 * 1024;

/**
 * Decide the contents of the bundle for `dir`.
 *
 * Returns the file list tar will be given plus everything worth reporting about how
 * it was arrived at. Split out from the packing so the decision can be tested against
 * real repositories without producing a tarball.
 */
function planBundle(dir) {
  const listed = gitFileList(dir);
  if (listed === null) {
    return { source: "denylist", files: null, held: {}, ignored: null, missing: 0, collisions: [], lostExec: [], gitMeta: null };
  }

  const files = [];
  const held = {};
  let missing = 0;
  for (const rel of listed) {
    const why = heldBack(rel);
    if (why) { (held[why] = held[why] || []).push(rel); continue; }
    // `--cached` lists files deleted from the working tree; handing one to tar aborts
    // the whole archive over a file the deploy never needed.
    if (!fs.existsSync(path.join(dir, rel))) { missing++; continue; }
    files.push(rel);
  }

  const gitMeta = wantsGitMetadata(dir);
  if (gitMeta) {
    gitMeta.bytes = gitDirBytes(dir);
    gitMeta.include = gitMeta.bytes <= GIT_META_LIMIT;
  }

  return {
    source: "git",
    files,
    held,
    ignored: ignoredSummary(dir),
    missing,
    collisions: caseCollisions(files),
    lostExec: lostExecBits(dir),
    gitMeta,
  };
}

function plural(n, one, many) { return n === 1 ? one : (many || one + "s"); }
function mb(bytes) { return (bytes / 1048576).toFixed(1) + " MB"; }

/**
 * The lines a person sees about what is and is not in their upload.
 *
 * Returned rather than printed so the wording is testable, and so index.js keeps
 * ownership of colour and of the deploy log.
 */
function describeBundle(plan) {
  const out = [];
  if (plan.source === "denylist") {
    out.push({ level: "info", text: "no git repository here — packing the folder minus the usual build junk" });
    return out;
  }
  out.push({ level: "info", text: `${plan.files.length} ${plural(plan.files.length, "file")} from git` });

  if (plan.ignored && plan.ignored.count) {
    const cats = plan.ignored.top.length ? ` (${plan.ignored.top.join(" · ")})` : "";
    out.push({ level: "detail", text: `skipped ${plan.ignored.count} ignored ${plural(plan.ignored.count, "path")}${cats}` });
  }
  const env = (plan.held.env || []).length;
  if (env) out.push({ level: "detail", text: `held back ${env} .env ${plural(env, "file")} — sent as env vars instead, so the values stay rotatable` });
  const mac = (plan.held.macos || []).length;
  if (mac) out.push({ level: "detail", text: `dropped ${mac} macOS metadata ${plural(mac, "file")}` });
  if (plan.missing) out.push({ level: "detail", text: `skipped ${plan.missing} tracked ${plural(plan.missing, "file")} deleted from the working tree` });

  if (plan.gitMeta && plan.gitMeta.include) {
    out.push({ level: "detail", text: `+ .git (${mb(plan.gitMeta.bytes)}) — ${plan.gitMeta.file} uses ${plan.gitMeta.backend}, which reads the version out of the history` });
  } else if (plan.gitMeta) {
    out.push({ level: "warn", text: `${plan.gitMeta.file} uses ${plan.gitMeta.backend} but .git is ${mb(plan.gitMeta.bytes)} — leaving it out. The build will version this 0.0.0; set the version explicitly if that matters.` });
  }

  for (const group of plan.collisions) {
    out.push({ level: "warn", text: `these differ only by case — one file here, two on Linux: ${group.join("  ·  ")}` });
  }
  if (plan.lostExec.length) {
    out.push({ level: "warn", text: `git records ${plural(plan.lostExec.length, "this", "these")} as executable but the working copy is not — the build will get 0644: ${plan.lostExec.slice(0, 5).join(", ")}` });
  }
  return out;
}

/**
 * Resolve LFS pointers, or refuse to ship them.
 *
 * Fetching is the fix when git-lfs is installed. When it is not, failing here is the
 * only honest outcome: every stage after this one will report success over files that
 * are text stubs wearing an .mp4 extension.
 */
function resolveLfs(dir, files, log) {
  let hits = findLfsPointers(dir, files);
  if (!hits.length) return;
  log({ level: "warn", text: `${hits.length} ${plural(hits.length, "file")} ${plural(hits.length, "is", "are")} a git-lfs pointer, not content — fetching` });
  const r = spawnSync("git", ["lfs", "pull"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  if (r.status === 0) hits = findLfsPointers(dir, files);
  if (!hits.length) return;
  const shown = hits.slice(0, 8).join("\n    ");
  const more = hits.length > 8 ? `\n    …and ${hits.length - 8} more` : "";
  throw new Error(
    `${hits.length} ${plural(hits.length, "file")} in this project ${plural(hits.length, "is", "are")} a git-lfs pointer and not the real content:\n    ${shown}${more}\n` +
    `Deploying them would ship 130-byte text files with media names. Install git-lfs and run \`git lfs pull\`, then deploy again.`
  );
}

/**
 * Pack `dir` into a temp .tgz and return its path.
 *
 * `log` receives {level, text} records; the caller decides how they look.
 */
// `async` on purpose: planning throws (LFS pointers with no way to fetch them), and a
// synchronous throw out of a function everything else awaits escapes the caller's
// error handling entirely.
async function packageFolder(dir, log = () => {}) {
  const plan = planBundle(dir);
  for (const line of describeBundle(plan)) log(line);
  if (plan.files) resolveLfs(dir, plan.files, log);

  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), "ss-deploy-" + process.pid + ".tgz");
    // COPYFILE_DISABLE=1 stops macOS `tar` from synthesizing AppleDouble `._*`
    // entries, which otherwise extract on the Linux build side and break framework
    // builds (Next tries to compile `._page.js`). No-op off macOS.
    const env = { ...process.env, COPYFILE_DISABLE: "1" };
    const args = ["--exclude=._*", "-czf", out];

    if (plan.files) {
      // `.git/lfs` is content we already resolved into the tree, and `.git/hooks` is a
      // pile of executable shell nobody asked to run on a build server.
      if (plan.gitMeta && plan.gitMeta.include) args.push("--exclude=.git/lfs", "--exclude=.git/hooks");
      // No `-C`: tar runs in `dir`, so the paths git printed are already correct, and
      // the mode bits tar reads off disk are the ones the archive carries.
      args.push("--null", "-T", "-");
    } else {
      for (const e of DENYLIST) args.push("--exclude=" + e);
      args.push(".");
    }

    const p = spawn("tar", args, { cwd: dir, env, stdio: [plan.files ? "pipe" : "ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("could not run `tar` — is it installed?")));
    p.on("close", () => (fs.existsSync(out) ? resolve(out) : reject(new Error("packaging failed: " + err.trim()))));

    if (plan.files) {
      const names = plan.files.slice();
      if (plan.gitMeta && plan.gitMeta.include) names.push(".git");
      p.stdin.on("error", () => { /* tar died; `close` reports it */ });
      p.stdin.end(names.join("\0") + "\0");
    }
  });
}

module.exports = {
  DENYLIST,
  caseCollisions,
  describeBundle,
  findLfsPointers,
  gitFileList,
  heldBack,
  isLfsPointer,
  lostExecBits,
  packageFolder,
  planBundle,
  wantsGitMetadata,
};
