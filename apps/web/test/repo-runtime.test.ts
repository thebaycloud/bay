import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLATFORM_DEFAULT_VERSION, RUNTIME_LANGUAGES, RuntimeVersionError,
  assertValidTag, pinFor, readRuntimeFiles, repoRuntime, resolveRuntime,
  runnerServes, runtimePins, runtimeRouting,
  type RuntimeFiles, type RuntimeLanguage,
} from "../lib/repo-runtime";
import { RUNTIME_VERSIONS } from "../lib/plan-deps";

const serves = (spec: string, language: "python" | "node" = "python") =>
  runnerServes({ language, spec, from: "test" });

test("the runtime comes from the repo's own file, and is carried verbatim", () => {
  // The platform never picks a version, never stores one, and never rewrites one.
  // It reads what the repo said so it can ask one yes/no question, and the string
  // it passes on is the string the author wrote — a normalisation here would be
  // the platform having an opinion about versions again, one lossy step later.
  assert.deepEqual(repoRuntime({ pythonVersion: "3.12\n" }), { language: "python", spec: "3.12", from: ".python-version" });
  assert.deepEqual(repoRuntime({ runtimeTxt: "python-3.11.9" }), { language: "python", spec: "3.11.9", from: "runtime.txt" });
  assert.deepEqual(repoRuntime({ nvmrc: "v20.11.0" }), { language: "node", spec: "20.11.0", from: ".nvmrc" });
  assert.deepEqual(repoRuntime({ pyproject: 'requires-python = ">=3.10"' }), { language: "python", spec: ">=3.10", from: "pyproject.toml" });
  assert.deepEqual(repoRuntime({ packageJson: { engines: { node: ">=20" } } }), { language: "node", spec: ">=20", from: "package.json" });

  assert.equal(repoRuntime({}), null);
  assert.equal(repoRuntime({ pyproject: "[project]\nname = 'x'" }), null);
});

test("a file whose only job is pinning the runtime outranks a compatibility range", () => {
  // Someone who wrote `.python-version` meant that number. `requires-python` is
  // usually a compatibility range and often far wider than what they actually run.
  const both = repoRuntime({ pythonVersion: "3.12", pyproject: 'requires-python = ">=3.8"' });
  assert.equal(both!.from, ".python-version");
  assert.equal(both!.spec, "3.12");
});

test("an exact pin is served only when it IS the version the runner has", () => {
  assert.equal(RUNTIME_VERSIONS.python, "3.14", "this test is written against the pinned runner");

  assert.equal(serves("3.14"), true);
  assert.equal(serves("3.12"), false);   // tonight's bot
  assert.equal(serves("3.11.9"), false);
  assert.equal(serves("3.14.1"), true);  // patch is below the runner's granularity
  assert.equal(serves("24", "node"), true);
  assert.equal(serves("20", "node"), false);
});

test("an UPPER bound is honoured — the case the old check could not see", () => {
  // `runtimeMismatch` only ever read a lower bound, so "not the newest one" —
  // which is how a real app says it depends on a library that has not caught up —
  // sailed through, installed, and died at start inside the customer's own code.
  // That is exactly what happened to python-telegram-bot on 3.14 tonight.
  assert.equal(serves("<3.13"), false);
  assert.equal(serves("<=3.12"), false);
  assert.equal(serves(">=3.10,<3.13"), false);

  // And a range the runner genuinely satisfies still takes the fast path.
  assert.equal(serves(">=3.10"), true);
  assert.equal(serves(">=3.10,<4.0"), true);
  assert.equal(serves(">=18", "node"), true);
});

test("a caret or tilde pin means that minor, so the runner only serves its own", () => {
  assert.equal(serves("~=3.14"), true);
  assert.equal(serves("~=3.11"), false);
  assert.equal(serves("^3.14"), true);
  assert.equal(serves("^20", "node"), false);
});

test("anything unrecognised is a NO, and that direction is the whole design", () => {
  // Being wrong toward the builder costs a slower build. Being wrong toward the
  // runner puts an app on an interpreter its author did not choose, which is a
  // traceback in the customer's own code with nothing in our logs to explain it.
  // No attempt is made to be a full PEP 440 implementation — the builder has a
  // real one, and is the right place for it.
  for (const weird of ["*", "latest", "pypy3.10", ">=3.10 || <4", "3.x", "", "  ", "lts/hydrogen"]) {
    assert.equal(serves(weird), false, `"${weird}" was optimistically served`);
  }
});

/* ========================================================================== */
/* The universal half: read → resolve → validate                              */
/* ========================================================================== */

const resolved = (files: RuntimeFiles, language: RuntimeLanguage) =>
  resolveRuntime(language, pinFor(runtimePins(files), language));

const tag = (files: RuntimeFiles, language: RuntimeLanguage) => resolved(files, language).version;

/**
 * Every row of the table in docs/MAKE-DEPLOYS-WORK.md Part 2a, as (file content →
 * expected tag).
 *
 * The cheapest test in the plan and the one covering the four languages that have
 * no fallback path: today `repoRuntime` returns null for Go, Rust, Ruby, PHP and
 * Java, so the generated Dockerfile is unreachable for them and nothing here can
 * be wrong. The moment it becomes the only build path, a missed normalisation is
 * `FROM golang:go1.23.4` — a tag that does not exist — for every Go repo on the
 * platform.
 */
const ROWS: Array<[string, RuntimeFiles, RuntimeLanguage, string]> = [
  // .tool-versions — one parser, all seven languages, and `nodejs` is what asdf
  // calls Node.
  [".tool-versions python", { toolVersions: "python 3.12\n" }, "python", "3.12"],
  [".tool-versions nodejs", { toolVersions: "nodejs 20.11.0\n" }, "node", "20.11.0"],
  [".tool-versions golang", { toolVersions: "golang 1.23\n" }, "go", "1.23"],
  [".tool-versions ruby", { toolVersions: "ruby 3.3.0\n" }, "ruby", "3.3.0"],
  [".tool-versions php", { toolVersions: "php 8.3\n" }, "php", "8.3"],
  [".tool-versions rust", { toolVersions: "rust 1.83.0\n" }, "rust", "1.83.0"],
  [".tool-versions java vendor suffix", { toolVersions: "java temurin-21.0.2\n" }, "java", "21"],
  [".tool-versions comments and extra versions",
    { toolVersions: "# pinned\npython 3.11 3.10\n" }, "python", "3.11"],

  // mise.toml — the [tools] table, and only that table.
  ["mise.toml", { miseToml: '[tools]\nnode = "22"\npython = "3.13"\n' }, "node", "22"],
  ["mise.toml stops at the next table",
    { miseToml: '[tools]\nnode = "22"\n\n[env]\nnode = "nonsense"\n' }, "node", "22"],

  // Python.
  [".python-version", { pythonVersion: "3.12\n" }, "python", "3.12"],
  ["runtime.txt strips the python- prefix", { runtimeTxt: "python-3.11.9" }, "python", "3.11.9"],
  ["requires-python is a RANGE and must be resolved",
    { pyproject: 'requires-python = ">=3.11,<3.13"' }, "python", "3.12"],
  ["requires-python open upper bound", { pyproject: 'requires-python = ">=3.10"' }, "python", "3.14"],
  ["requires-python compatible-release", { pyproject: 'requires-python = "~=3.11"' }, "python", "3.14"],

  // Node.
  [".nvmrc strips the v", { nvmrc: "v20.11.0" }, "node", "20.11.0"],
  [".nvmrc lts/* is not a tag", { nvmrc: "lts/*" }, "node", "24"],
  [".nvmrc lts/iron is not a tag", { nvmrc: "lts/iron" }, "node", "20"],
  [".node-version", { nodeVersion: "v22.3.0" }, "node", "22.3.0"],
  ["volta.node is exact", { packageJson: { volta: { node: "20.11.1" } } }, "node", "20.11.1"],
  ["engines.node is a RANGE", { packageJson: { engines: { node: ">=20" } } }, "node", "24"],
  ["engines.node caret", { packageJson: { engines: { node: "^22.1.0" } } }, "node", "22"],
  ["engines.node alternatives", { packageJson: { engines: { node: "^18 || ^20" } } }, "node", "20"],
  ["engines.node with a patch floor still picks the tag that carries it",
    // node:20 IS 20.11-and-up. Comparing the tag as 20.0.0 rejects it and builds
    // on 24 for a reason no author would recognise.
    { packageJson: { engines: { node: ">=20.11" } } }, "node", "24"],

  // Go — the `go` prefix is not part of any tag.
  ["go.mod go line", { goMod: "module x\n\ngo 1.23\n" }, "go", "1.23"],
  ["go.mod toolchain strips the go prefix and outranks the go line",
    { goMod: "module x\n\ngo 1.22\ntoolchain go1.23.4\n" }, "go", "1.23.4"],

  // Rust — a channel is not a tag, so it declares nothing.
  ["rust-toolchain.toml channel stable falls back",
    { rustToolchainToml: '[toolchain]\nchannel = "stable"\n' }, "rust", PLATFORM_DEFAULT_VERSION.rust],
  ["rust-toolchain.toml nightly-DATE falls back",
    { rustToolchainToml: '[toolchain]\nchannel = "nightly-2025-03-01"\n' }, "rust", PLATFORM_DEFAULT_VERSION.rust],
  ["rust-toolchain.toml concrete channel", { rustToolchainToml: '[toolchain]\nchannel = "1.83.0"\n' }, "rust", "1.83.0"],
  ["rust-toolchain bare file", { rustToolchain: "1.82.0\n" }, "rust", "1.82.0"],
  ["rust-toolchain bare channel falls back", { rustToolchain: "nightly\n" }, "rust", PLATFORM_DEFAULT_VERSION.rust],

  // Ruby.
  [".ruby-version", { rubyVersion: "3.3.0\n" }, "ruby", "3.3.0"],
  [".ruby-version rbenv spelling", { rubyVersion: "ruby-3.2.2\n" }, "ruby", "3.2.2"],
  ["Gemfile exact", { gemfile: 'source "x"\nruby "3.3.0"\n' }, "ruby", "3.3.0"],
  ["Gemfile pessimistic operator is a RANGE", { gemfile: 'ruby "~> 3.2"\n' }, "ruby", "3.4"],

  // PHP — the concrete platform pin outranks the require range.
  ["composer config.platform.php wins over require.php",
    { composerJson: { config: { platform: { php: "8.2.0" } }, require: { php: "^8.1" } } }, "php", "8.2.0"],
  ["composer require.php is a RANGE", { composerJson: { require: { php: "^8.2" } } }, "php", "8.4"],

  // Java — every route reduces to a major, because that is what Temurin publishes
  // under a stable name.
  [".sdkmanrc strips the vendor suffix", { sdkmanrc: "java=21.0.2-tem\n" }, "java", "21"],
  ["pom.xml maven.compiler.release", { pomXml: "<maven.compiler.release>17</maven.compiler.release>" }, "java", "17"],
  ["pom.xml java.version 1.8 is Java 8", { pomXml: "<java.version>1.8</java.version>" }, "java", "8"],
  ["build.gradle JavaVersion.VERSION_17",
    { buildGradle: "sourceCompatibility = JavaVersion.VERSION_17\n" }, "java", "17"],
  ["build.gradle quoted", { buildGradle: "sourceCompatibility = '11'\n" }, "java", "11"],
  ["build.gradle toolchain", { buildGradle: "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }" }, "java", "21"],
];

test("every row of the version table produces a tag that exists", () => {
  for (const [name, files, language, expected] of ROWS) {
    assert.equal(tag(files, language), expected, name);
  }
});

test("the four normalisations that would each ship a tag nobody publishes", () => {
  // Named individually because each one is a whole language failing on its first
  // deploy, and the generic row above would still pass if one of them regressed
  // into a different-but-also-wrong answer.
  assert.notEqual(tag({ goMod: "toolchain go1.23.4" }, "go"), "go1.23.4", "golang:go1.23.4 does not exist");
  assert.notEqual(tag({ rustToolchainToml: 'channel = "stable"' }, "rust"), "stable", "rust:stable does not exist");
  assert.notEqual(tag({ pomXml: "<java.version>1.8</java.version>" }, "java"), "1.8", "eclipse-temurin:1.8 does not exist");
  assert.notEqual(tag({ sdkmanrc: "java=21.0.2-tem" }, "java"), "21.0.2-tem", "eclipse-temurin:21.0.2-tem does not exist");
});

test("a range never reaches FROM, which is what makes this the only build path", () => {
  // `deploy-pipeline.ts` interpolates the spec straight into `FROM`, so today
  // `requires-python = ">=3.11,<3.13"` emits `FROM python:>=3.11,<3.13`. It is
  // invisible behind the runtimePinned gate and a hard failure without it.
  for (const [, files, language] of ROWS) {
    const v = tag(files, language);
    assert.doesNotThrow(() => assertValidTag(v, "table row"), `"${v}" is not a legal tag`);
  }
});

test("silence gets an explicit version, never a bare repository name", () => {
  // A bare `FROM ruby` resolves to :latest — a runtime that moves under the
  // customer with no deploy, which is the defect the runner's shared interpreter
  // was criticised for, one level up and with nobody's name on it.
  for (const language of RUNTIME_LANGUAGES) {
    const r = resolved({}, language);
    assert.ok(r.version, `${language} has no default`);
    assert.equal(r.versionFrom, "platform default");
    assert.doesNotThrow(() => assertValidTag(r.version, language));
  }
});

test("the Python and Node defaults are the runner's, so nothing moves under a live app", () => {
  // Making the generated Dockerfile universal must not silently re-interpret every
  // app that deploys today. When the runner goes, this row goes with it and
  // PLATFORM_DEFAULT_VERSION becomes the only answer.
  assert.equal(PLATFORM_DEFAULT_VERSION.python, RUNTIME_VERSIONS.python);
  assert.equal(PLATFORM_DEFAULT_VERSION.node, RUNTIME_VERSIONS.node);
});

test("versionFrom names the file, what it said, and what it became", () => {
  // The write-back records this, so an app that never chose a version can see the
  // one it got and take it over. A default nobody can see is a surprise.
  assert.equal(resolved({ pythonVersion: "3.12" }, "python").versionFrom, ".python-version");
  assert.equal(
    resolved({ pyproject: 'requires-python = ">=3.11,<3.13"' }, "python").versionFrom,
    "pyproject.toml requires-python >=3.11,<3.13 → 3.12",
  );
  assert.equal(resolved({ goMod: "toolchain go1.23.4" }, "go").versionFrom, "go.mod toolchain go1.23.4 → 1.23.4");
  assert.equal(resolved({ sdkmanrc: "java=21.0.2-tem" }, "java").versionFrom, ".sdkmanrc 21.0.2-tem → 21");
});

test("a RANGE we cannot read takes the default and SAYS so", () => {
  // Refusing a deploy over a range our parser does not understand would be the
  // platform's grammar deciding what an app may run. The sentence is what the
  // owner needs and what the repair loop can act on.
  const r = resolved({ pyproject: 'requires-python = ">=3.10 <4 || ~3.9.x-rc"' }, "python");
  assert.equal(r.version, PLATFORM_DEFAULT_VERSION.python);
  assert.match(r.versionFrom, /platform default/);
  assert.match(r.versionFrom, /pyproject\.toml requires-python/);
  assert.match(r.versionFrom, /not a version range we read/);
});

test("the PEP 440 exclusion that a naive range reader drops on the floor", () => {
  // `!= 3.11.*` is ordinary in requires-python. Failing to parse it would push a
  // large slice of real Python onto the platform default, in silence.
  assert.equal(tag({ pyproject: 'requires-python = ">=3.10,!=3.11.*,<3.13"' }, "python"), "3.12");
  assert.equal(tag({ packageJson: { engines: { node: "20.x" } } }, "node"), "20");
});

test("alternatives are a union, not an intersection", () => {
  // `>=3.10 || <4` reads as "either", which is every version — the old runner
  // check called this unrecognised grammar and refused it, because refusing was
  // free there. It is not free here: this IS the only build path.
  assert.equal(tag({ pyproject: 'requires-python = ">=3.10 || <4"' }, "python"), "3.14");
});

test("a range nothing satisfies takes the default rather than emitting nothing", () => {
  const r = resolved({ pyproject: 'requires-python = ">=99"' }, "python");
  assert.equal(r.version, PLATFORM_DEFAULT_VERSION.python);
  assert.match(r.versionFrom, /no python we know of satisfies it/);
});

test("an exact pin is never checked against a list of ours", () => {
  // The repository already answered. A catalogue that refused `python 3.7` — a tag
  // Docker Hub has — would be the platform having an opinion about versions again,
  // which is the thing this path exists to stop.
  assert.equal(tag({ pythonVersion: "3.7.9" }, "python"), "3.7.9");
  assert.equal(tag({ nodeVersion: "16.20.2" }, "node"), "16.20.2");
});

test("a typo in a file whose only job is the version fails here, naming the file", () => {
  // The distinction that matters: an unreadable RANGE is legal in somebody's
  // ecosystem and takes the default. A `.python-version` holding something that is
  // not a version is a typo in the one place the author wrote to be obeyed, and
  // building on the default instead is how they never find out.
  assert.throws(
    () => resolved({ pythonVersion: "3.12 <-- edit me" }, "python"),
    // Both halves, together: the type routes it, and the message has to name the
    // file and quote what was in it or the author cannot act on it.
    (e: unknown) => e instanceof RuntimeVersionError
      && /\.python-version/.test(e.message)
      && /3\.12 <-- edit me/.test(e.message),
  );

  assert.throws(() => resolved({ nvmrc: "twenty" }, "node"), RuntimeVersionError);
  assert.throws(() => resolved({ rubyVersion: "3.3 (with jemalloc)" }, "ruby"), RuntimeVersionError);

  // A STRUCTURED file is different, and the difference is not a special case: a
  // `go` directive that is not a number is not a `go` directive, so go.mod has
  // declared nothing rather than declared something wrong. The whole content of
  // `.nvmrc` is the version; a line of go.mod is not.
  assert.equal(resolved({ goMod: "module x\ngo tip\n" }, "go").versionFrom, "platform default");

  assert.throws(() => assertValidTag("", "x"), RuntimeVersionError);
  assert.throws(() => assertValidTag("-3.12", "x"), RuntimeVersionError);
  assert.throws(() => assertValidTag(">=3.11,<3.13", "x"), RuntimeVersionError);
  assert.doesNotThrow(() => assertValidTag("3.12-slim", "x"));
});

test("a version manager's own not-a-version words are silence, not a typo", () => {
  // asdf and pyenv both accept these, and `.python-version` holding a PyPy name is
  // ordinary. Throwing on them would refuse deploys that work today; taking them
  // as a tag would emit `python:system`.
  for (const value of ["system", "latest", "ref:v1.2.3", "pypy3.10-7.3.15"]) {
    const r = resolved({ pythonVersion: value }, "python");
    assert.equal(r.version, PLATFORM_DEFAULT_VERSION.python, value);
    assert.equal(r.versionFrom, "platform default", value);
  }
  // …and the next file down still gets its turn.
  assert.equal(tag({ pythonVersion: "system", pyproject: 'requires-python = ">=3.12"' }, "python"), "3.14");
});

test("specificity, not preference: a dedicated file outranks a field in a manifest", () => {
  const pins = runtimePins({
    toolVersions: "python 3.11\n",
    pythonVersion: "3.12",
    pyproject: 'requires-python = ">=3.8"',
  });
  assert.equal(pinFor(pins, "python")!.from, ".tool-versions");

  assert.equal(pinFor(runtimePins({ pythonVersion: "3.12", pyproject: 'requires-python = ">=3.8"' }), "python")!.from, ".python-version");
  assert.equal(pinFor(runtimePins({
    packageJson: { volta: { node: "20.11.1" }, engines: { node: ">=18" } },
  }), "node")!.from, "package.json volta.node");
});

test("one repository can pin several languages at once", () => {
  // The FastAPI+React shape. A flat one-language answer picks a winner and the
  // other toolchain is never installed.
  const pins = runtimePins({
    pyproject: 'requires-python = ">=3.12"',
    packageJson: { engines: { node: "22" } },
  });
  assert.equal(pinFor(pins, "python")!.from, "pyproject.toml requires-python");
  assert.equal(pinFor(pins, "node")!.from, "package.json engines.node");
  assert.equal(pinFor(pins, "go"), null);
});

test("readRuntimeFiles is the one place that touches disk, so there is one answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-files-"));
  writeFileSync(join(dir, ".python-version"), "3.11\n");
  writeFileSync(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: ">=20" } }));
  writeFileSync(join(dir, "composer.json"), "{ this is not json");

  const files = readRuntimeFiles(dir);
  assert.equal(tag(files, "python"), "3.11");
  assert.equal(tag(files, "go"), "1.22");
  assert.equal(tag(files, "node"), "24");
  // An unparseable manifest is silence, not a failed deploy.
  assert.equal(tag(files, "php"), PLATFORM_DEFAULT_VERSION.php);
});

test("the log line says what was asked, where, and what happens next", () => {
  // The visible consequence is a build that takes minutes instead of seconds. An
  // owner who is not told why reads that as the platform being slow.
  const msg = runtimeRouting({ language: "python", spec: "3.12", from: ".python-version" });

  assert.match(msg, /\.python-version/);
  assert.match(msg, /python 3\.12/);
  assert.match(msg, new RegExp(RUNTIME_VERSIONS.python.replace(".", "\\.")));
  assert.match(msg, /building this one from source/);
});

test("a semver hyphen range is a range, not three unreadable clauses", () => {
  // npm's only range syntax written with spaces around an infix operator, which
  // is what made it the one the clause splitter could not survive: splitting
  // `18.0.0 - 22.x.x` on whitespace yields ["18.0.0", "-", "22.x.x"], "-" is
  // ungrammatical, and the WHOLE spec became unreadable. So an app that pinned
  // its runtime precisely got the platform default — Excalidraw's
  // `"node": "18.0.0 - 22.x.x"` built on Node 24, which is the exact failure
  // this resolver exists to prevent, arrived at from inside the resolver.
  const files = (node: string) => ({ packageJson: { engines: { node } } });

  assert.equal(tag(files("18.0.0 - 22.x.x"), "node"), "22");
  // The upper bound is inclusive of the family, whichever way it is spelled.
  assert.equal(tag(files("18 - 20"), "node"), "20");
  assert.equal(tag(files("18.0.0 - 20.11.1"), "node"), "20");
  // And it is recorded as a resolution rather than as a default.
  assert.match(resolved(files("18.0.0 - 22.x.x"), "node").versionFrom!, /18\.0\.0 - 22\.x\.x → 22/);

  // A hyphen that is not a range still declares nothing, rather than half of one
  // — and says so, naming the file, which is the whole contract of a fallback.
  assert.match(resolved(files("- 20"), "node").versionFrom!, /^platform default — .*not a version range we read/);
  assert.equal(tag(files("- 20"), "node"), "24");
});

test("poetry declares the interpreter as a dependency, and it is still a pin", () => {
  // A poetry project is a pyproject.toml WITHOUT the PEP 621 `requires-python`
  // key, so reading only that key meant every one of them reported "platform
  // default" while its own file said so two lines away.
  const poetry = (python: string) => ({
    pyproject: `[tool.poetry]\nname = "api"\n\n[tool.poetry.dependencies]\npython = "${python}"\nfastapi = "^0.110"\n`,
  });

  assert.equal(tag(poetry(">=3.10,<3.12"), "python"), "3.11");
  assert.equal(tag(poetry("~3.10"), "python"), "3.10");
  assert.match(resolved(poetry("~3.10"), "python").versionFrom!, /\[tool\.poetry\.dependencies\]/);

  // The table may be the LAST thing in the file — the common shape, and the one
  // an end-of-input lookahead written as `\z` (which JavaScript does not have)
  // silently failed to match.
  assert.equal(tag({ pyproject: '[tool.poetry.dependencies]\npython = "3.10"\n' }, "python"), "3.10");

  // PEP 621 still wins where a project states both: it is the standard key.
  assert.equal(
    tag({ pyproject: '[project]\nrequires-python = ">=3.12"\n\n[tool.poetry.dependencies]\npython = "3.9"\n' }, "python"),
    "3.14",
  );

  // A package named `python` in some other table is not the interpreter.
  assert.equal(
    resolved({ pyproject: '[tool.poetry.group.dev.dependencies]\npython = "3.9"\n' }, "python").versionFrom,
    "platform default",
  );
});
