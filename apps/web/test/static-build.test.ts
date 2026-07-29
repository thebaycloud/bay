import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  staticBuildConfig, escapeForCloudBuild, shellQuote, depsCacheScope,
  warmInstall, installScript, depsRestoreScript, depsSaveScript, publishScript,
  lockfilePreference,
} from "../lib/static-build";

const BUCKET = "supersonic-static-assets";
const BUILDER = "node:22-slim";
const CLOUD_SDK = "gcr.io/google.com/cloudsdktool/google-cloud-cli:slim";
const DEST = "gs://supersonic-static-assets/demo/r/20260729t120000z-abcd1234/";
/** The dependency cache's scratch files, cleared before the assets go up. */
const SCRATCH_RM = "rm -f /workspace/.deps.tgz /workspace/.deps-restored /workspace/.deps-key /workspace/.deps-skip";

/** A stock Vite deploy — the exact shape that broke in production. */
function vite(over: Partial<Parameters<typeof staticBuildConfig>[0]> = {}) {
  return staticBuildConfig({
    installCommand: "npm ci --prefer-offline --no-audit --no-fund",
    buildCommand: "npm run build",
    outputDir: "dist",
    destination: DEST,
    namespace: "ws_demo",
    builder: BUILDER,
    bucket: BUCKET,
    ...over,
  });
}

/**
 * The steps as Cloud Build will actually run them.
 *
 * Reading them back through JSON.parse is itself the check that the args line is
 * a legal double-quoted scalar, and `$$` → `$` is precisely the substitution
 * Cloud Build performs on the YAML before the step's shell ever sees it.
 */
function steps(yaml: string): { image: string; script: string }[] {
  const lines = yaml.split("\n");
  const out: { image: string; script: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^ {2}- name: (.+)$/);
    if (!name) continue;
    const argsLine = lines[i + 2];
    const json = argsLine.match(/^ {4}args: (\[.*\])$/);
    assert.ok(json, `step ${out.length} has no JSON args line, got: ${argsLine}`);
    const args = JSON.parse(json[1]) as string[];
    assert.deepEqual(args.slice(0, 1), ["-lc"]);
    out.push({ image: name[1], script: args[1].replace(/\$\$/g, "$") });
  }
  return out;
}

/**
 * Cloud Build expands `$FOO` and `$(...)` as its own substitutions before a step
 * runs, so a bare single `$` in the YAML fails validation with "key FOO is not a
 * valid built-in substitution". `$$` is the literal-dollar escape. This has
 * shipped broken once; this assertion is the automated defence.
 */
function assertNoBareDollar(yaml: string, what: string) {
  assert.equal(/(?<!\$)\$(?!\$)/.test(yaml), false, `${what} contains a bare single "$" — Cloud Build will reject it`);
}

// ── the escaping layer ──────────────────────────────────────────────────────

test("escapeForCloudBuild doubles every dollar and nothing else", () => {
  assert.equal(escapeForCloudBuild("L=$(ls)"), "L=$$(ls)");
  assert.equal(escapeForCloudBuild(`[ -n "$L" ]`), `[ -n "$$L" ]`);
  assert.equal(escapeForCloudBuild("$H.tgz"), "$$H.tgz");
  assert.equal(escapeForCloudBuild("$$"), "$$$$", "an already-doubled dollar is data, not an escape");
  assert.equal(escapeForCloudBuild("a $ b $ c"), "a $$ b $$ c");
  assert.equal(escapeForCloudBuild("no dollars here"), "no dollars here");
});

test("shellQuote survives spaces, dollars and quotes", () => {
  assert.equal(shellQuote("dist"), "'dist'");
  assert.equal(shellQuote("dist out"), "'dist out'");
  assert.equal(shellQuote("$BUILD_ID"), "'$BUILD_ID'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  // What the quoting is for: bash must see one word with the text unchanged.
  for (const hostile of ["dist out", "$BUILD_ID", "it's", "a;rm -rf /", "a\nb"]) {
    const r = spawnSync("bash", ["-c", `printf '%s' ${shellQuote(hostile)}`], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, hostile, `bash mangled ${JSON.stringify(hostile)}`);
  }
});

test("a hostile outputDir cannot reach Cloud Build unescaped", () => {
  // s.serve.outputDir comes from the detector reading the customer's repo, and the
  // previous version interpolated it raw. A `$` in it either failed the config or,
  // worse, silently expanded as a Cloud Build substitution.
  const yaml = vite({ outputDir: "dist/$BUILD_ID out" });
  assertNoBareDollar(yaml, "staticBuildConfig with a $ in outputDir");
  const publish = steps(yaml).at(-1)!.script;
  assert.equal(publish, `${SCRATCH_RM}; gcloud storage rsync -r 'dist/$BUILD_ID out' '${DEST}'`);
});

// ── the outage ──────────────────────────────────────────────────────────────

test("the step that uploads the assets can never be short-circuited", () => {
  // THE REGRESSION. The save script is a chain of `exit 0` guards and the rsync
  // used to be appended to it with a `;`. `exit` ends the shell, so a cache hit —
  // the feature working — stopped the upload, the step still exited 0, Cloud Build
  // reported SUCCESS and the pointer moved to a release that was never uploaded.
  const publish = steps(vite()).at(-1)!;
  assert.equal(publish.script, `${SCRATCH_RM}; gcloud storage rsync -r 'dist' '${DEST}'`);
  assert.doesNotMatch(publish.script, /\bexit\b/, "nothing that can exit may share a shell with the upload");
  // The rule is "nothing that can end the shell", not "one command". `rm -f`
  // cannot exit and cannot fail; a guard, a pipeline or a `&&` chain could.
  assert.doesNotMatch(publish.script, /\|\||&&|\bif\b|\bcase\b/, "no conditional may stand between the step and the upload");
  assert.doesNotMatch(publish.script, /tar |sha256sum|storage cp/, "the upload step does dependency-cache work again");
  assert.equal(publish.script.split(";").at(-1)!.trim().startsWith("gcloud storage rsync"), true,
    "the upload is the last thing in the shell");
});

test("the dependency cache's own scratch files never reach the release", () => {
  // /workspace is a legal outputDir (`s.serve.outputDir || "."`), and the publish
  // step is now unconditional — so on a cache hit the 30-130MB .deps.tgz and the
  // markers would be rsynced into a public release prefix. Before the publish was
  // unconditional, the tarball's presence was the very thing that suppressed the
  // upload, so this could not happen.
  const publish = steps(vite({ outputDir: "." })).at(-1)!.script;
  for (const f of [".deps.tgz", ".deps-restored", ".deps-key", ".deps-skip"]) {
    assert.ok(publish.includes(`/workspace/${f}`), `${f} is still there when the assets go up`);
  }
  assert.ok(publish.indexOf("rm -f") < publish.indexOf("rsync"), "cleared before the upload, not after");
});

test("every step that can exit early does nothing but the cache", () => {
  for (const s of steps(vite())) {
    if (!/\bexit\b/.test(s.script)) continue;
    assert.doesNotMatch(s.script, /storage rsync/, `a step with an early exit also uploads: ${s.script}`);
  }
});

// ── exact emitted bytes ─────────────────────────────────────────────────────

const SCOPE = "946b6725aa452bece839a58255c01549";

test("the emitted YAML is pinned byte for byte", () => {
  assert.equal(vite(), [
    "steps:",
    `  - name: ${CLOUD_SDK}`,
    "    entrypoint: bash",
    '    args: ["-lc", "L=\\"\\"; for f in package-lock.json yarn.lock pnpm-lock.yaml; do [ -f \\"$$f\\" ] && { L=\\"$$f\\"; break; }; done; '
      + '[ -n \\"$$L\\" ] || exit 0; '
      + '[ -d node_modules ] && { echo \\"node_modules is committed - skipping the dependency cache\\"; : > /workspace/.deps-skip; exit 0; }; '
      + 'H=$$(sha256sum \\"$$L\\" | cut -c1-64); '
      + 'K=\\"$$L-$$H\\"; '
      + `printf '%s' \\"$$K\\" > /workspace/.deps-key; `
      + 'echo \\"deps cache key $$H\\"; '
      + `gcloud storage cp \\"gs://${BUCKET}/_deps/v2/${SCOPE}/$$K.tgz\\" /workspace/.deps.tgz 2>/dev/null || exit 0; `
      + 'tar -xzf /workspace/.deps.tgz -C /workspace 2>/dev/null && : > /workspace/.deps-restored && echo \\"deps restored from cache\\" '
      + '|| { rm -f /workspace/.deps.tgz; echo \\"deps cache entry unusable - ignoring it\\"; }"]',
    `  - name: ${BUILDER}`,
    "    entrypoint: bash",
    '    args: ["-lc", "if [ -f /workspace/.deps-restored ]; then npm install --prefer-offline --no-audit --no-fund; '
      + 'else npm ci --prefer-offline --no-audit --no-fund || npm install --prefer-offline --no-audit --no-fund; fi '
      + '&& npm run build"]',
    `  - name: ${CLOUD_SDK}`,
    "    entrypoint: bash",
    '    args: ["-lc", "[ -f /workspace/.deps-skip ] && exit 0; '
      + '[ -f /workspace/.deps-restored ] && exit 0; '
      + 'K=$$(cat /workspace/.deps-key 2>/dev/null); '
      + '[ -n \\"$$K\\" ] || exit 0; '
      + '[ -d node_modules ] || exit 0; '
      + 'tar -czf /tmp/deps.tgz node_modules 2>/dev/null || exit 0; '
      + `gcloud storage cp /tmp/deps.tgz \\"gs://${BUCKET}/_deps/v2/${SCOPE}/$$K.tgz\\" 2>/dev/null && echo \\"deps cached\\" || true"]`,
    `  - name: ${CLOUD_SDK}`,
    "    entrypoint: bash",
    `    args: ["-lc", "${SCRATCH_RM}; gcloud storage rsync -r 'dist' '${DEST}'"]`,
    "options:",
    "  logging: CLOUD_LOGGING_ONLY",
    "",
  ].join("\n"));
});

test("no bare dollar survives anywhere in the config", () => {
  assertNoBareDollar(vite(), "staticBuildConfig");
  assertNoBareDollar(vite({ installCommand: "yarn --frozen-lockfile", buildCommand: "yarn build" }), "yarn config");
  assertNoBareDollar(vite({ installCommand: null, buildCommand: null }), "no-command config");
  assertNoBareDollar(vite({ outputDir: "$OUT", destination: "gs://b/$X/" }), "config with dollars in both interpolations");
});

test("the shell the cache scripts emit really is the doubled form", () => {
  // Belt and braces on the one rule that has already shipped broken: the raw
  // scripts hold single dollars, the YAML holds doubled ones, and nothing else moves.
  const raw = depsRestoreScript(BUCKET, SCOPE, "npm ci --prefer-offline --no-audit --no-fund");
  assert.ok(raw.includes(`L=""; for f in package-lock.json yarn.lock pnpm-lock.yaml; do [ -f "$f" ] && { L="$f"; break; }; done`));
  assert.equal(escapeForCloudBuild(raw), steps(vite())[0].script.replace(/\$/g, "$$$$"));
  assert.ok(depsSaveScript(BUCKET, SCOPE).includes('K=$(cat /workspace/.deps-key 2>/dev/null)'));
  assert.equal(publishScript("dist", DEST), `${SCRATCH_RM}; gcloud storage rsync -r 'dist' '${DEST}'`);
});

test("every step's args line is legal JSON, so the YAML scalar is legal too", () => {
  const all = steps(vite({ outputDir: `weird "dir" with 'quotes' and \\ backslash` }));
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((s) => s.image), [CLOUD_SDK, BUILDER, CLOUD_SDK, CLOUD_SDK]);
});

// ── the cache key ───────────────────────────────────────────────────────────

test("the cache key covers everything that changes the tree", () => {
  const base = { builder: BUILDER, installCommand: "npm ci", namespace: "ws_a" };
  assert.equal(depsCacheScope(base), depsCacheScope({ ...base }), "the key is deterministic");
  assert.notEqual(depsCacheScope(base), depsCacheScope({ ...base, builder: "node:20-slim" }),
    "native modules are compiled against the base image's ABI");
  assert.notEqual(depsCacheScope(base), depsCacheScope({ ...base, installCommand: "npm install --omit=dev" }),
    "the same lockfile installed differently is a different tree");
  assert.notEqual(depsCacheScope(base), depsCacheScope({ ...base, namespace: "ws_b" }),
    "a tarball carries the producing tenant's postinstall output and must not cross tenants");
  assert.equal(depsCacheScope(base), SCOPE.length && depsCacheScope(base));
  assert.match(depsCacheScope(base), /^[0-9a-f]{32}$/);
});

test("two tenants with an identical project do not share a cache object", () => {
  const a = steps(vite({ namespace: "ws_a" }))[0].script;
  const b = steps(vite({ namespace: "ws_b" }))[0].script;
  const path = (s: string) => s.match(/_deps\/v2\/([0-9a-f]+)\//)![1];
  assert.notEqual(path(a), path(b));
});

test("the object name carries the lockfile's own name, not just its hash", () => {
  // A repo carrying a stale package-lock.json next to the yarn.lock it actually
  // uses must not key one manager's tree under the other's name.
  assert.ok(steps(vite())[0].script.includes(`K="$L-$H"`));
  assert.ok(steps(vite())[0].script.includes("/$K.tgz"));
  assert.ok(steps(vite())[2].script.includes("/$K.tgz"));
});

test("the package manager in charge decides which lockfile is authoritative", () => {
  // `ls a b c` sorts its output regardless of argument order, so `ls <lockfiles>
  // | head -1` always picked package-lock.json when several were present. A yarn
  // repo carrying a stale npm lock then keyed on a file yarn never updates: a
  // real dependency change did not move the key, and a stale tree came back.
  assert.deepEqual(lockfilePreference("npm ci"), ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
  assert.deepEqual(lockfilePreference(null), ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
  assert.equal(lockfilePreference("yarn --frozen-lockfile")[0], "yarn.lock");
  assert.equal(lockfilePreference("pnpm i --frozen-lockfile")[0], "pnpm-lock.yaml");

  const yarnRestore = steps(vite({ installCommand: "yarn --frozen-lockfile" }))[0].script;
  assert.ok(yarnRestore.includes("for f in yarn.lock pnpm-lock.yaml package-lock.json;"),
    `yarn's lockfile must be looked at first, got: ${yarnRestore.slice(0, 90)}`);
  assert.doesNotMatch(yarnRestore, /\bls .*head -1/, "ls sorts; that is the whole bug");
});

test("the save writes to the object the restore looked up, not a recomputed one", () => {
  // `npm ci || npm install` (lib/install.ts) rewrites package-lock.json when the
  // two files disagree — the exact case that fallback exists for. Recomputing the
  // hash after the build stored the tarball under a key no restore would ever
  // ask for, so those projects paid tar+upload every build and never got a hit.
  const restore = steps(vite())[0].script;
  const save = steps(vite())[2].script;
  assert.ok(restore.includes(`printf '%s' "$K" > /workspace/.deps-key`), "the key is frozen before the build");
  assert.ok(save.includes("K=$(cat /workspace/.deps-key 2>/dev/null)"), "and read back, not recomputed");
  assert.doesNotMatch(save, /sha256sum/, "any sha256sum in the save step is a recomputed key");
});

// ── the install ─────────────────────────────────────────────────────────────

test("a cache hit installs incrementally because npm ci deletes node_modules", () => {
  assert.equal(warmInstall("npm ci"), "npm install");
  assert.equal(warmInstall("npm ci --prefer-offline --no-audit --no-fund"),
    "npm install --prefer-offline --no-audit --no-fund");
  assert.equal(warmInstall("yarn --frozen-lockfile"), "yarn --frozen-lockfile", "yarn does not wipe node_modules");
  assert.equal(warmInstall("pnpm i --frozen-lockfile"), "pnpm i --frozen-lockfile");
  assert.equal(warmInstall("npm cimport"), "npm cimport", "the prefix match is on the word");

  assert.equal(installScript("npm ci"),
    "if [ -f /workspace/.deps-restored ]; then npm install; else npm ci || npm install; fi");
  assert.equal(installScript("yarn --frozen-lockfile"), "yarn --frozen-lockfile",
    "no branch is emitted when both sides are the same command");
  assert.equal(installScript(null), null);
});

test("a project with no commands still gets a config that uploads", () => {
  const all = steps(vite({ installCommand: null, buildCommand: null }));
  assert.equal(all[1].script, "true");
  assert.equal(all.at(-1)!.script, `${SCRATCH_RM}; gcloud storage rsync -r 'dist' '${DEST}'`);
});

test("a set-but-empty base-image env var does not emit a nameless step", () => {
  // Cloud Run environment variables are routinely set-but-empty, and `??` only
  // falls through null/undefined — so `NEXT_BASE_IMAGE=""` selected the empty
  // string and the config went out with `  - name: `, which Cloud Build rejects
  // at submit. Every static build with a build command would have died there,
  // and only on Cloud Run, so nothing local could see it.
  const saved = { next: process.env.NEXT_BASE_IMAGE, node: process.env.NODE_BASE_IMAGE };
  try {
    process.env.NEXT_BASE_IMAGE = "";
    process.env.NODE_BASE_IMAGE = "us-central1-docker.pkg.dev/p/r/node:22-slim";
    const yaml = staticBuildConfig({
      installCommand: "npm ci", buildCommand: "npm run build", outputDir: "dist",
      destination: DEST, namespace: "ws_demo", bucket: BUCKET,
    });
    assert.doesNotMatch(yaml, /^ {2}- name: *$/m, "a step with no image at all");
    assert.match(yaml, /^ {2}- name: us-central1-docker\.pkg\.dev\/p\/r\/node:22-slim$/m);

    process.env.NODE_BASE_IMAGE = "";
    assert.match(staticBuildConfig({
      installCommand: "npm ci", buildCommand: "npm run build", outputDir: "dist",
      destination: DEST, namespace: "ws_demo", bucket: BUCKET,
    }), /^ {2}- name: node:22-slim$/m, "both empty falls all the way to the default");
  } finally {
    if (saved.next === undefined) delete process.env.NEXT_BASE_IMAGE; else process.env.NEXT_BASE_IMAGE = saved.next;
    if (saved.node === undefined) delete process.env.NODE_BASE_IMAGE; else process.env.NODE_BASE_IMAGE = saved.node;
  }
});

// ── it actually runs ────────────────────────────────────────────────────────

/**
 * Run the emitted steps for real, under bash, with a stubbed gcloud.
 *
 * This is the test that would have caught the outage: string assertions prove the
 * shape, but the bug was behavioural — a guard firing in the same shell as the
 * upload. `/workspace` and `/tmp/deps.tgz` are rewritten to a scratch directory
 * because those paths only exist inside the builder; nothing else is altered.
 */
function runLane(opts: {
  cache: "hit" | "miss" | "corrupt";
  lockfile?: boolean;
  nodeModules?: boolean;
  vendored?: boolean;
  /** Extra lockfiles to drop in the workspace beside package-lock.json. */
  alsoLockfiles?: string[];
  /** The install command, which decides which lockfile is authoritative. */
  installCommand?: string;
  /** Rewrite the lockfile between the build and the save, as `npm install` does. */
  rewriteLock?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "static-build-"));
  const ws = join(root, "workspace");
  const bin = join(root, "bin");
  mkdirSync(ws); mkdirSync(bin);
  const log = join(root, "calls.log");

  writeFileSync(join(bin, "gcloud"), [
    "#!/bin/sh",
    'echo "gcloud $*" >> "$STUB_LOG"',
    'if [ "$1 $2" = "storage cp" ]; then',
    '  case "$3" in',
    "    gs://*)",
    '      [ "$CACHE_STATE" = miss ] && exit 1',
    '      [ "$CACHE_STATE" = corrupt ] && { echo "not a tarball" > "$4"; exit 0; }',
    '      cp "$CACHE_OBJECT" "$4"; exit 0 ;;',
    "  esac",
    "fi",
    "exit 0",
  ].join("\n"));
  // The builder image has sha256sum; macOS does not.
  writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\nshasum -a 256 "$@"\n');
  chmodSync(join(bin, "gcloud"), 0o755);
  chmodSync(join(bin, "sha256sum"), 0o755);

  // A genuine cached tarball, as an earlier build would have written it.
  const src = join(root, "src");
  mkdirSync(join(src, "node_modules", "ms"), { recursive: true });
  writeFileSync(join(src, "node_modules", "RESTORED_MARKER"), "from the cache\n");
  const object = join(root, "cached.tgz");
  assert.equal(spawnSync("tar", ["-czf", object, "-C", src, "node_modules"]).status, 0);

  if (opts.lockfile !== false) writeFileSync(join(ws, "package-lock.json"), '{"lockfileVersion":3}');
  for (const extra of opts.alsoLockfiles ?? []) writeFileSync(join(ws, extra), `# ${extra}\n`);
  if (opts.vendored) mkdirSync(join(ws, "node_modules"));
  mkdirSync(join(ws, "dist"));
  writeFileSync(join(ws, "dist", "index.html"), "<!doctype html>");

  const local = (script: string) =>
    script.replace(/\/workspace/g, ws).replace(/\/tmp\/deps\.tgz/g, join(root, "deps.tgz"));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
    CACHE_STATE: opts.cache,
    CACHE_OBJECT: object,
  };
  const sh = (script: string) => spawnSync("bash", ["-lc", local(script)], { cwd: ws, env, encoding: "utf8" });

  const all = steps(vite(opts.installCommand ? { installCommand: opts.installCommand } : {}));
  const restore = sh(all[0].script);
  // The build step is the real npm install, which is not this test's business —
  // what matters downstream is only whether it left a node_modules behind.
  if (opts.nodeModules !== false && !existsSync(join(ws, "node_modules"))) mkdirSync(join(ws, "node_modules"));
  // `npm ci || npm install` rewrites package-lock.json when the two files
  // disagree, which moves its hash after the restore already chose a key.
  if (opts.rewriteLock) writeFileSync(join(ws, "package-lock.json"), '{"lockfileVersion":3,"rewritten":true}');
  const save = sh(all[2].script);
  const publish = sh(all[3].script);

  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  /** The gs:// object the restore asked for, and the one the save wrote. */
  const objectRead = calls.match(/storage cp (gs:\/\/\S+) /)?.[1] ?? null;
  const objectWritten = calls.match(/storage cp \S*deps\.tgz (gs:\/\/\S+)/)?.[1] ?? null;
  const result = {
    restoreOut: restore.stdout + restore.stderr, restoreCode: restore.status,
    saveOut: save.stdout + save.stderr, saveCode: save.status,
    publishCode: publish.status,
    calls,
    objectRead,
    objectWritten,
    uploaded: /storage rsync -r .*dist/.test(calls),
    cached: /storage cp .*deps\.tgz gs:\/\//.test(calls),
    restoredMarker: existsSync(join(ws, "node_modules", "RESTORED_MARKER")),
    scratchLeft: [".deps.tgz", ".deps-restored", ".deps-key", ".deps-skip"].filter((f) => existsSync(join(ws, f))),
  };
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("the assets are uploaded on a cache HIT — the case that was silently dead", () => {
  const r = runLane({ cache: "hit" });
  assert.match(r.restoreOut, /deps cache key [0-9a-f]{64}/);
  assert.match(r.restoreOut, /deps restored from cache/);
  assert.equal(r.restoredMarker, true, "the cached tree really was unpacked");
  assert.equal(r.cached, false, "a warm key is not re-uploaded for no benefit");
  assert.equal(r.uploaded, true, "THE BUG: a cache hit used to stop the upload");
  assert.equal(r.publishCode, 0);
});

test("the assets are uploaded on a cache MISS, and the tree is saved", () => {
  const r = runLane({ cache: "miss" });
  assert.doesNotMatch(r.restoreOut, /deps restored from cache/);
  assert.equal(r.cached, true);
  assert.match(r.saveOut, /deps cached/);
  assert.equal(r.uploaded, true);
});

test("the assets are uploaded when there is no lockfile at all", () => {
  // A vendored-deps or Yarn-PnP site has no lockfile to key on. It gets no cache;
  // it must still get a deploy.
  const r = runLane({ cache: "miss", lockfile: false });
  assert.equal(r.cached, false);
  assert.equal(r.uploaded, true);
  assert.equal(r.publishCode, 0);
});

test("the assets are uploaded when the build produced no node_modules", () => {
  const r = runLane({ cache: "miss", nodeModules: false });
  assert.equal(r.cached, false);
  assert.equal(r.uploaded, true);
});

test("a corrupt cache entry is discarded rather than poisoning the project forever", () => {
  // The old guard tested for the downloaded file, so an entry that would not
  // extract still counted as a hit: the save was skipped, the entry was never
  // replaced, and every future deploy of that lockfile hit the same bad object.
  const r = runLane({ cache: "corrupt" });
  assert.match(r.restoreOut, /deps cache entry unusable/);
  assert.equal(r.restoredMarker, false);
  assert.equal(r.cached, true, "the bad object is overwritten with a good one");
  assert.equal(r.uploaded, true);
});

test("a repo that commits node_modules keeps its own and still deploys", () => {
  const r = runLane({ cache: "hit", vendored: true });
  assert.match(r.restoreOut, /node_modules is committed/);
  assert.equal(r.restoredMarker, false, "the cache must not be merged over a committed tree");
  assert.equal(r.uploaded, true);
  // The half that was missing. The restore refused to *use* the cache for this
  // repo, then the save uploaded the repo's own vendored tree as the shared
  // cache entry — keyed only on (tenant, builder, install command, lockfile), so
  // any sibling project of that tenant with the same lockfile restored somebody
  // else's committed node_modules into its build.
  assert.equal(r.cached, false, "a committed tree is not ours to publish to a shared cache");
  assert.doesNotMatch(r.saveOut, /deps cached/, "and it must not claim it cached one");
});

test("the save addresses the same object the restore did, even if the lockfile moved", () => {
  // End-to-end version of the key-skew defect: the restore looks up key A, the
  // install rewrites package-lock.json, and the save used to store under key B.
  const r = runLane({ cache: "miss", rewriteLock: true });
  assert.equal(r.cached, true);
  assert.ok(r.objectRead, "the restore did look something up");
  assert.equal(r.objectWritten, r.objectRead,
    "the tarball must land where the next restore will look for it");
});

test("a yarn repo carrying a stale npm lock keys on yarn.lock", () => {
  const r = runLane({
    cache: "miss",
    installCommand: "yarn --frozen-lockfile",
    alsoLockfiles: ["yarn.lock"],
  });
  assert.match(r.objectRead ?? "", /\/yarn\.lock-[0-9a-f]{64}\.tgz$/,
    `keyed on the wrong lockfile: ${r.objectRead}`);
});

test("the cache's scratch files are gone before the assets are uploaded", () => {
  const r = runLane({ cache: "hit" });
  assert.deepEqual(r.scratchLeft, [], "these would be rsynced into a public release prefix");
  assert.equal(r.uploaded, true);
});
