import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_VERSIONS } from "./plan-deps";

/**
 * What version the REPOSITORY asks for — and, until the runner is decommissioned,
 * whether the runner can serve it.
 *
 * TWO HALVES, AND THE SECOND ONE IS REPLACING THE FIRST
 *
 * The bottom half of this file (`repoRuntime`, `runnerServes`, `runtimeRouting`)
 * answers one yes/no question for the runner lane: can a prebuilt image serve
 * exactly what this repo asked for? It reads five files and knows two languages,
 * because that is all the runner has.
 *
 * The top half — `readRuntimeFiles`, `runtimePins`, `resolveRuntime` — answers a
 * different question, the one a generated Dockerfile needs: what concrete image
 * tag should this app be built on? It reads eighteen files across seven languages
 * and always returns an answer, because `FROM` cannot be handed a maybe.
 *
 * Both are here on purpose. Nothing is deleted before its replacement is green,
 * and every live runner revision still depends on the bottom half. It goes when
 * the decommission query returns empty, not before.
 *
 * WHY THE NEW HALF IS NOT JUST "READ THE FILE"
 *
 * The old contract was `spec` carried verbatim, never normalised, because the
 * BUILDER interpreted it — Google's buildpacks read `.python-version` themselves.
 * A generated Dockerfile has no such reader. `deploy-pipeline.ts` interpolates the
 * spec straight into `FROM`, so a repo with `requires-python = ">=3.11,<3.13"`
 * emits `FROM python:>=3.11,<3.13`, which is not a tag and never was. Today that
 * is invisible, because the generated Dockerfile only fires for the handful of
 * repos the runner cannot serve. As the only build path it is a hard failure for
 * the majority of `requires-python`, `engines.node`, `composer require.php` and
 * `ruby "~> 3.3"` repositories.
 *
 * So: READ, then RESOLVE, then VALIDATE. Read is what the file said. Resolve turns
 * a range into the highest tag we know of that satisfies it. Validate refuses
 * anything that is not a legal tag, in `detect()`, with a sentence naming the
 * file — rather than at `docker build` with `invalid reference format`, where the
 * repair classifier has no log to work with.
 *
 * The platform holds exactly one Python and one Node — `RUNTIME_VERSIONS`, a
 * constant — and the runner lane owns Node and Python, which are most of the
 * market. So every customer shares one interpreter, moved on our schedule rather
 * than theirs. For a hobby deploy that is an annoyance. For the small software
 * business this platform is for, which pins its dependencies and does not upgrade
 * for years, it means we can break their product by editing a constant.
 *
 * What used to happen when a repo asked for something else is worse than
 * ignoring it: `assertRuntimeSupported` REFUSED THE DEPLOY, with
 *
 *   this app needs Python >=3.14 and the runner has 3.14 — widen requires-python
 *   in pyproject.toml to accept it, or wait for the runner to move. Nothing in
 *   the code can fix this one.
 *
 * "Wait for the runner to move" is a platform telling a business to change its
 * software to fit the platform's single opinion. And it only ever caught a LOWER
 * bound, so the case that actually bit — an app pinned to a library that does not
 * work on the newest Python — sailed through, installed, and died at start with a
 * traceback inside the customer's own code.
 *
 * The answer is not a second constant or a version matrix. It is that a repo
 * asking for a specific version is routed to a build path that READS THE FILE
 * ITSELF: Google buildpacks already honour `.python-version`, `runtime.txt`,
 * `requires-python`, `.nvmrc` and `engines.node`. So the platform never picks a
 * version, never stores one, and never parses one to pass along — it only asks a
 * single yes/no question: can the prebuilt runner serve exactly what this repo
 * asked for? A "no", or an "I am not sure", hands the repo to the builder.
 *
 * That is the runner lane demoting from "the default for the two biggest
 * languages" to a cache used only where it is genuinely equivalent, which is what
 * it should always have been.
 */

/* ========================================================================== */
/* The universal half: every language, read → resolve → validate              */
/* ========================================================================== */

/** The languages a generated Dockerfile can pin a version for. */
export type RuntimeLanguage = "python" | "node" | "go" | "rust" | "ruby" | "php" | "java";

export const RUNTIME_LANGUAGES: RuntimeLanguage[] =
  ["python", "node", "go", "rust", "ruby", "php", "java"];

/** One declaration found in one file, before anything is done to it. */
export interface RuntimePin {
  language: RuntimeLanguage;
  /** Exactly the characters the file held. Kept so the log can quote the author. */
  raw: string;
  /** After that file's own normalisation — `python-3.11.9` → `3.11.9`. Still may be a range. */
  spec: string;
  /** Repo-relative filename, plus the field inside it when that matters. */
  from: string;
  /**
   * Whether this source can legally hold a range.
   *
   * The distinction decides what happens to something we cannot parse, and the two
   * answers have to be different. `requires-python = ">=3.10 || <4"` is legal in
   * its own ecosystem and unreadable in ours — refusing the deploy over it would
   * be our grammar deciding what an app may run, so it takes the default and says
   * so. A `.python-version` containing `3.12 <-- edit me` is not a range we failed
   * to read; it is a typo in a file whose only job is that one number, and
   * silently building on something else is how the author never finds out.
   */
  kind: "exact" | "range";
}

/**
 * Values that mean "no opinion", in files that otherwise hold an exact version.
 *
 * asdf and pyenv both accept `system`, `latest` and `ref:`/`path:` forms, and
 * `.python-version` is routinely a PyPy or a Conda name. None of them is a tag on
 * the official image, and none of them is a mistake either — so they declare
 * nothing and whatever else the repo says gets its turn.
 */
const NO_PIN = /^(system|latest|current|lts|stable|nightly|beta|node|default|\*)$|^(ref|path|pypy|graalvm|truffleruby|jruby|conda|miniconda|anaconda|mamba)[:@-]?/i;

/** A concrete tag, safe to interpolate into `FROM`, with the story of how it got there. */
export interface ResolvedRuntime {
  language: RuntimeLanguage;
  version: string;
  /**
   * Which file said so, what it said, and what it became.
   *
   * `"platform default"` when nothing declared one. Written into the config
   * write-back, so an app that never chose a version can see the one it got and
   * take it over — which is the difference between a default and a surprise.
   */
  versionFrom: string;
}

/**
 * The version the platform picks when the repository says nothing.
 *
 * `FROM ruby` must never ship. Docker resolves a bare repository name to
 * `:latest`, which is a runtime that moves under a customer with no deploy — the
 * exact defect the runner's single shared interpreter was criticised for, one
 * level up and with nobody's name on it.
 *
 * Python and Node deliberately repeat what the runner already runs, so making the
 * generated Dockerfile universal does not silently move any app that deploys
 * today onto a different interpreter. `repo-runtime.test.ts` fails if these two
 * drift from RUNTIME_VERSIONS while the runner still exists; when the runner goes,
 * this constant is the only one left and the test row goes with it.
 */
export const PLATFORM_DEFAULT_VERSION: Record<RuntimeLanguage, string> = {
  python: "3.14",
  node: "24",
  go: "1.24",
  rust: "1.85",
  ruby: "3.4",
  php: "8.4",
  java: "21",
};

/**
 * Tags this platform knows exist, newest last. Consulted ONLY to resolve a range.
 *
 * An exact pin never comes near this list. A repo asking for `python 3.7` gets
 * `python:3.7`, because Docker Hub has it and the repository already answered the
 * question — a catalogue that refused it would be the platform having an opinion
 * about versions again, which is the thing this whole path exists to stop.
 *
 * So the cost of this list going stale is bounded to one case: a range whose only
 * satisfying versions are newer than anything here resolves to the newest one here
 * instead. That is a version older than the app could have had, recorded in
 * `versionFrom`, and never a build failure. Adding a version is one entry.
 */
const KNOWN_VERSIONS: Record<RuntimeLanguage, string[]> = {
  python: ["3.8", "3.9", "3.10", "3.11", "3.12", "3.13", "3.14"],
  // Even majors are the LTS lines, which is what `lts/*` and `lts/<codename>` mean.
  node: ["18", "20", "22", "24"],
  go: ["1.21", "1.22", "1.23", "1.24"],
  rust: ["1.78", "1.79", "1.80", "1.81", "1.82", "1.83", "1.84", "1.85"],
  ruby: ["3.0", "3.1", "3.2", "3.3", "3.4"],
  php: ["8.0", "8.1", "8.2", "8.3", "8.4"],
  // eclipse-temurin publishes majors and full builds; only the majors are stable
  // names. See `javaTag` for why every Java answer is reduced to one.
  java: ["8", "11", "17", "21", "24", "25"],
};

/** `.nvmrc` codenames. A lookup of published facts, not a version of ours. */
const NODE_LTS_CODENAMES: Record<string, string> = {
  argon: "4", boron: "6", carbon: "8", dubnium: "10", erbium: "12",
  fermium: "14", gallium: "16", hydrogen: "18", iron: "20", jod: "22", krypton: "24",
};

/** What `lts/*` means: the newest even major, which is how Node numbers its LTS lines. */
const NEWEST_NODE_LTS = KNOWN_VERSIONS.node.filter((v) => Number(v) % 2 === 0).at(-1)!;

/**
 * Tool names as the version managers spell them, mapped onto ours.
 *
 * `.tool-versions` and `mise.toml` are the only two files in the table that pin
 * every language at once, which is why they are read first: one parser covers all
 * seven, and a repo that uses asdf or mise has already answered for the four
 * languages that have no other dedicated file worth trusting.
 */
const TOOL_ALIASES: Record<string, RuntimeLanguage> = {
  python: "python",
  nodejs: "node", node: "node",
  golang: "go", go: "go",
  rust: "rust",
  ruby: "ruby",
  php: "php",
  java: "java",
};

export class RuntimeVersionError extends Error {}

/* -------------------------------------------------------------------------- */
/* Version arithmetic                                                         */
/* -------------------------------------------------------------------------- */

type Ver = [number, number, number];

/** A half-open span of versions. Every pin and every catalogue entry becomes one. */
interface Span {
  lo: Ver; loInc: boolean;
  hi: Ver | null; hiInc: boolean;
}

const ZERO: Ver = [0, 0, 0];

function parts(v: string): number[] | null {
  const m = v.trim().match(/^v?(\d+(?:\.\d+)*)$/);
  return m ? m[1].split(".").map(Number) : null;
}

function ver(p: number[]): Ver {
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function bump(p: number[], at: number): Ver {
  const next = p.slice(0, at + 1);
  next[at] = (next[at] ?? 0) + 1;
  return ver(next);
}

/**
 * The span a tag covers.
 *
 * `python:3.12` is not the single version 3.12.0 — it is whatever 3.12.x is
 * current, which is the entire 3.12 series. Getting this wrong is not academic:
 * treating the tag as 20.0.0 makes `engines.node: ">=20.11"` reject `node:20`,
 * and the app is built on 22 for no reason its author would recognise.
 */
function familySpan(v: string): Span | null {
  const p = parts(v);
  if (!p) return null;
  return { lo: ver(p), loInc: true, hi: bump(p, p.length - 1), hiInc: false };
}

function overlaps(a: Span, b: Span): boolean {
  if (b.hi) {
    const c = cmp(a.lo, b.hi);
    if (c > 0 || (c === 0 && !(a.loInc && b.hiInc))) return false;
  }
  if (a.hi) {
    const c = cmp(b.lo, a.hi);
    if (c > 0 || (c === 0 && !(b.loInc && a.hiInc))) return false;
  }
  return true;
}

/**
 * One clause of a range — `>=3.11`, `^20`, `~> 3.3`, `8.2.*` — as a span.
 *
 * Deliberately not a full PEP 440 or semver implementation, and the shape of the
 * approximation is chosen: an unparseable clause returns null, which makes the
 * whole spec unresolvable, which falls back to the platform default WITH the
 * reason recorded. Guessing a span for a grammar we do not understand would put an
 * app on a version nobody chose and say nothing.
 */
function clauseSpan(clause: string): Span | { exclude: Span } | null {
  const c = clause.trim();
  if (!c) return null;

  // `3.12.*` and `20.x` mean the family. `!= 3.11.*` is how PEP 440 spells "not
  // that series" and is common enough in `requires-python` that failing to read it
  // would push a large slice of real Python onto the platform default in silence.
  const wild = c.match(/^(>=|<=|==|!=|~=|~>|\^|~|=|>|<)?\s*v?(\d+(?:\.\d+)*)\.(?:\*|x)$/i);
  if (wild) {
    const span = familySpan(wild[2]);
    if (!span) return null;
    return wild[1] === "!=" ? { exclude: span } : span;
  }

  const m = c.match(/^(>=|<=|==|!=|~=|~>|\^|~|=|>|<)?\s*v?(\d+(?:\.\d+)*)$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const p = parts(m[2])!;
  const lo = ver(p);

  switch (op) {
    case ">=": return { lo, loInc: true, hi: null, hiInc: false };
    case ">":  return { lo, loInc: false, hi: null, hiInc: false };
    case "<":  return { lo: ZERO, loInc: true, hi: lo, hiInc: false };
    case "<=": return { lo: ZERO, loInc: true, hi: lo, hiInc: true };
    case "=": case "==": return familySpan(m[2]);
    case "!=": {
      const span = familySpan(m[2]);
      return span ? { exclude: span } : null;
    }
    // npm: `^1.2.3` → <2.0.0, but `^0.2.3` → <0.3.0. Nobody pins a runtime below
    // 1.0, and the rule is cheap enough to get right rather than to assume.
    case "^": {
      const at = p[0] === 0 ? (p[1] === 0 ? 2 : 1) : 0;
      return { lo, loInc: true, hi: bump(p, Math.min(at, p.length - 1)), hiInc: false };
    }
    // npm tilde: `~1.2.3` and `~1.2` both stop at 1.3.0; `~1` stops at 2.0.0.
    case "~":  return { lo, loInc: true, hi: bump(p, p.length >= 2 ? 1 : 0), hiInc: false };
    // PEP 440 `~=` and Ruby's pessimistic `~>` are the same rule: drop the last
    // component that was written, and bump the one before it.
    case "~=": case "~>":
      return { lo, loInc: true, hi: bump(p, Math.max(0, p.length - 2)), hiInc: false };
    default: return null;
  }
}

/**
 * A semver HYPHEN range — `18.0.0 - 22.x.x` — as one span.
 *
 * npm's only range syntax that is written with spaces around an infix operator,
 * which is what makes it the one the clause splitter cannot survive: splitting
 * `18.0.0 - 22.x.x` on whitespace yields `["18.0.0", "-", "22.x.x"]`, `"-"` is
 * ungrammatical, and the WHOLE spec becomes unreadable. So an app that pinned its
 * runtime precisely got the platform default instead — Excalidraw's
 * `"engines": { "node": "18.0.0 - 22.x.x" }` built on Node 24, which is the exact
 * failure the version resolver exists to prevent, arrived at from inside the
 * resolver.
 *
 * The upper bound is inclusive of the FAMILY: `- 22.x.x` and `- 22` both admit
 * every 22.x, which is what `familySpan` already means everywhere else here.
 */
function hyphenSpan(alt: string): Span | null {
  // `(?:\.(?:\*|x))*` and not `?`: `22.x.x` carries two wildcard segments, and
  // matching only one leaves a trailing `.x` that fails the anchor — which is the
  // exact spelling npm's own docs use for a hyphen range's upper bound.
  const m = alt.match(/^v?(\d+(?:\.\d+)*)(?:\.(?:\*|x))*\s+-\s+v?(\d+(?:\.\d+)*)(?:\.(?:\*|x))*$/i);
  if (!m) return null;
  const lo = parts(m[1]);
  const hi = familySpan(m[2]);
  if (!lo || !hi) return null;
  return { lo: ver(lo), loInc: true, hi: hi.hi, hiInc: false };
}

/**
 * Every version in `KNOWN_VERSIONS[language]` the spec accepts, newest last.
 *
 * `||` is a union of alternatives (npm, Composer); commas and spaces are an
 * intersection (PEP 440, Composer, Bundler). Returns null when any clause is
 * grammar we do not read, so the caller can say "we did not understand this"
 * rather than quietly narrowing the answer.
 */
function satisfying(language: RuntimeLanguage, spec: string): string[] | null {
  const alternatives = spec.split("||").map((s) => s.trim()).filter(Boolean);
  if (!alternatives.length) return null;

  const accepted = new Set<string>();
  for (const alt of alternatives) {
    // Before the splitter, because a hyphen range is the one npm spelling whose
    // separator IS whitespace — splitting it first destroys it.
    const hyphen = hyphenSpan(alt);
    if (hyphen) {
      for (const known of KNOWN_VERSIONS[language]) {
        if (overlaps(familySpan(known)!, hyphen)) accepted.add(known);
      }
      continue;
    }
    const clauses = alt.split(/\s*,\s*|\s+/).filter(Boolean);
    const spans: Span[] = [];
    const excluded: Span[] = [];
    for (const clause of clauses) {
      const parsed = clauseSpan(clause);
      if (!parsed) return null;
      if ("exclude" in parsed) excluded.push(parsed.exclude);
      else spans.push(parsed);
    }
    if (!spans.length && !excluded.length) return null;

    for (const known of KNOWN_VERSIONS[language]) {
      const fam = familySpan(known)!;
      if (!spans.every((s) => overlaps(fam, s))) continue;
      // `!=3.12` removes the 3.12 series; `!=3.12.1` does not, because the tag
      // `python:3.12` can still serve 3.12.2.
      if (excluded.some((e) => cmp(e.lo, fam.lo) <= 0 && e.hi && fam.hi && cmp(fam.hi, e.hi) <= 0)) continue;
      accepted.add(known);
    }
  }
  return KNOWN_VERSIONS[language].filter((v) => accepted.has(v));
}

/** Is this a single version rather than a range — something to pass through untouched? */
function isExact(spec: string): boolean {
  return /^v?\d+(\.\d+)*$/.test(spec.trim());
}

/* -------------------------------------------------------------------------- */
/* Reading — the eighteen files                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every file the reader looks at, as text. Null for absent.
 *
 * Passed in rather than read here so the parsing is testable without a temp
 * directory per case — `readRuntimeFiles` below is the one place that touches
 * disk, and both the pipeline and `detect()` go through it so there is one answer
 * to "which files count".
 */
export interface RuntimeFiles {
  toolVersions?: string | null;      // .tool-versions
  miseToml?: string | null;          // mise.toml / .mise.toml
  pythonVersion?: string | null;     // .python-version
  runtimeTxt?: string | null;        // runtime.txt
  pyproject?: string | null;         // pyproject.toml — requires-python
  nvmrc?: string | null;             // .nvmrc
  nodeVersion?: string | null;       // .node-version
  packageJson?: unknown;             // volta.node, then engines.node
  goMod?: string | null;             // go.mod — toolchain, then go
  rustToolchainToml?: string | null; // rust-toolchain.toml
  rustToolchain?: string | null;     // rust-toolchain (bare)
  rubyVersion?: string | null;       // .ruby-version
  gemfile?: string | null;           // Gemfile — ruby "3.3.0"
  composerJson?: unknown;            // config.platform.php, then require.php
  sdkmanrc?: string | null;          // .sdkmanrc — java=21.0.2-tem
  pomXml?: string | null;            // pom.xml
  buildGradle?: string | null;       // build.gradle / build.gradle.kts
}

const FILE_READS: Array<[keyof RuntimeFiles, string[]]> = [
  ["toolVersions", [".tool-versions"]],
  ["miseToml", ["mise.toml", ".mise.toml"]],
  ["pythonVersion", [".python-version"]],
  ["runtimeTxt", ["runtime.txt"]],
  ["pyproject", ["pyproject.toml"]],
  ["nvmrc", [".nvmrc"]],
  ["nodeVersion", [".node-version"]],
  ["goMod", ["go.mod"]],
  ["rustToolchainToml", ["rust-toolchain.toml"]],
  ["rustToolchain", ["rust-toolchain"]],
  ["rubyVersion", [".ruby-version"]],
  ["gemfile", ["Gemfile"]],
  ["sdkmanrc", [".sdkmanrc"]],
  ["pomXml", ["pom.xml"]],
  ["buildGradle", ["build.gradle", "build.gradle.kts"]],
];

/** Read every version file in one directory. Never throws; absent is not an error. */
export function readRuntimeFiles(dir: string): RuntimeFiles {
  const text = (names: string[]) => {
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p)) return readFileSync(p, "utf8");
      } catch { /* unreadable is the same as absent */ }
    }
    return null;
  };
  const json = (name: string) => {
    try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; }
  };

  const files: RuntimeFiles = {};
  for (const [key, names] of FILE_READS) (files as Record<string, unknown>)[key] = text(names);
  files.packageJson = json("package.json");
  files.composerJson = json("composer.json");
  return files;
}

const firstLine = (v: string | null | undefined) => (v ?? "").trim().split("\n")[0].trim();

/** `python 3.12 3.11` → the first version, which is the one asdf and mise activate. */
function parseToolVersions(text: string | null | undefined): Map<RuntimeLanguage, string> {
  const out = new Map<RuntimeLanguage, string>();
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [tool, ...rest] = line.split(/\s+/);
    const language = TOOL_ALIASES[tool?.toLowerCase()];
    const value = rest[0];
    if (language && value && !out.has(language)) out.set(language, value);
  }
  return out;
}

/** The `[tools]` table of a mise config, as `language → version`. */
function parseMiseTools(text: string | null | undefined): Map<RuntimeLanguage, string> {
  const out = new Map<RuntimeLanguage, string>();
  const body = (text ?? "");
  const start = body.search(/^\s*\[tools\]\s*$/m);
  if (start === -1) return out;
  const rest = body.slice(start).split("\n").slice(1);
  for (const raw of rest) {
    const line = raw.split("#")[0].trim();
    if (/^\[/.test(line)) break;                    // the next table ends [tools]
    if (!line) continue;
    // `node = "20"`, `python = ['3.12']`, `java = { version = "21" }`
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const language = TOOL_ALIASES[m[1].toLowerCase()];
    if (!language || out.has(language)) continue;
    const value = m[2].match(/["']([^"']+)["']/)?.[1];
    if (value) out.set(language, value);
  }
  return out;
}

/**
 * Java, reduced to a major version.
 *
 * `.sdkmanrc` says `java=21.0.2-tem` and `eclipse-temurin` publishes
 * `21.0.2_13-jdk` — the vendor's own patch numbering, which nothing in a repo
 * ever names. `pom.xml` says `1.8`, and the tag is `8`. Gradle says
 * `JavaVersion.VERSION_17`. Every one of those is a different spelling of a major,
 * and the major is the only thing Temurin publishes under a stable name, so that
 * is what every Java row resolves to. Recording the reduction in `versionFrom` is
 * the honest half: the app asked for 21.0.2 and got 21.
 */
function javaMajor(raw: string): string | null {
  let v = raw.trim();
  v = v.replace(/^(?:temurin|openjdk|adoptopenjdk|graalvm|corretto|zulu|liberica|oracle|sapmachine|semeru)[-@]/i, "");
  v = v.replace(/-(?:tem|open|amzn|zulu|librca|ms|sem|graal|oracle|sapmchn)$/i, "");
  v = v.replace(/^JavaVersion\.VERSION_/i, "").replace(/^VERSION_/i, "");
  v = v.replace(/_/g, ".");
  const p = parts(v);
  if (!p) return null;
  // `1.8` is Java 8. The `1.` prefix was dropped from the version scheme at 9 and
  // survives only in build files.
  const major = p[0] === 1 && p.length > 1 ? p[1] : p[0];
  return String(major);
}

/** Rust channels that are not tags. `rust:stable` is not a thing the image publishes. */
const RUST_CHANNEL = /^(stable|beta|nightly)(-\d{4}-\d{2}-\d{2})?$/i;

/**
 * Every runtime declaration in the repository, most specific first per language.
 *
 * Order is specificity, not preference, and it is the same rule the runner half
 * states: a file whose ONLY job is pinning the runtime outranks a field inside a
 * manifest that is mostly about other things. Someone who wrote `.python-version`
 * meant that number; `requires-python` is a compatibility range and is usually far
 * wider than what they run.
 */
export function runtimePins(f: RuntimeFiles): RuntimePin[] {
  const pins: RuntimePin[] = [];
  const add = (
    language: RuntimeLanguage, raw: string, spec: string, from: string,
    kind: RuntimePin["kind"] = "exact",
  ) => {
    const trimmed = spec.trim();
    if (!trimmed || NO_PIN.test(trimmed)) return;
    pins.push({ language, raw, spec: trimmed, from, kind });
  };

  // 1. The two files that answer for every language at once.
  const addFromVersionManager = (tools: Map<RuntimeLanguage, string>, from: string) => {
    for (const [language, value] of tools) {
      // A Rust channel is not a version — `rust:stable` is not published — so it
      // declares nothing and whatever else the repo says gets its turn.
      if (language === "rust" && RUST_CHANNEL.test(value)) continue;
      const spec = language === "java" ? javaMajor(value) : value.replace(/^v/, "");
      if (spec) add(language, value, spec, from);
    }
  };
  addFromVersionManager(parseToolVersions(f.toolVersions), ".tool-versions");
  addFromVersionManager(parseMiseTools(f.miseToml), "mise.toml");

  // 2. Python.
  const pv = firstLine(f.pythonVersion);
  if (pv) add("python", pv, pv, ".python-version");
  const rt = firstLine(f.runtimeTxt);
  if (/^python-/i.test(rt)) add("python", rt, rt.replace(/^python-/i, ""), "runtime.txt");
  const requiresPython = f.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (requiresPython) add("python", requiresPython, requiresPython, "pyproject.toml requires-python", "range");
  // Poetry declares the interpreter as a DEPENDENCY, not as `requires-python`.
  //
  // A poetry project is a pyproject.toml without the PEP 621 key, so reading only
  // that key meant every one of them reported "platform default" while its own
  // file said `python = "^3.11"` two lines away. Scoped to the
  // `[tool.poetry.dependencies]` table so a package literally named `python` in
  // some other table cannot be mistaken for the interpreter.
  // `$(?![\s\S])` and not `\z`: JavaScript has no `\z`, so writing one matches a
  // literal "z" and the table-to-end-of-file case — a pyproject.toml whose LAST
  // section is the dependency table, which is the common shape — never matched.
  const poetryTable = f.pyproject
    ?.match(/^[ \t]*\[tool\.poetry\.dependencies\][ \t]*\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/m)?.[1];
  const poetryPython = poetryTable?.match(/^\s*python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (poetryPython) {
    add("python", poetryPython, poetryPython, "pyproject.toml [tool.poetry.dependencies] python", "range");
  }

  // 3. Node.
  const nvm = firstLine(f.nvmrc);
  if (nvm) {
    // `lts/*` and `lts/iron` are what nvm calls a version, and neither is a tag.
    // An unrecognised codename declares nothing rather than becoming
    // `node:lts/argon`, which is not a reference Docker can parse.
    const codename = nvm.toLowerCase().match(/^lts\/(.+)$/)?.[1];
    const lts = codename === "*"
      ? NEWEST_NODE_LTS
      : codename ? NODE_LTS_CODENAMES[codename] : null;
    if (codename) { if (lts) add("node", nvm, lts, ".nvmrc"); }
    else add("node", nvm, nvm.replace(/^v/, ""), ".nvmrc");
  }
  const nodeVersion = firstLine(f.nodeVersion);
  if (nodeVersion) add("node", nodeVersion, nodeVersion.replace(/^v/, ""), ".node-version");
  const pkg = (f.packageJson ?? null) as { volta?: { node?: string }; engines?: { node?: string } } | null;
  if (pkg?.volta?.node) add("node", pkg.volta.node, pkg.volta.node.replace(/^v/, ""), "package.json volta.node");
  if (pkg?.engines?.node) add("node", pkg.engines.node, pkg.engines.node, "package.json engines.node", "range");

  // 4. Go. `toolchain go1.23.4` names the exact toolchain to build with and
  //    outranks `go 1.23`, which is a language-version floor. Both carry a `go`
  //    prefix that is not part of any tag: `golang:go1.23.4` does not exist.
  const toolchain = f.goMod?.match(/^\s*toolchain\s+go?([0-9][^\s]*)/m)?.[1];
  if (toolchain) add("go", `go${toolchain}`, toolchain, "go.mod toolchain");
  const goLine = f.goMod?.match(/^\s*go\s+([0-9][^\s]*)/m)?.[1];
  if (goLine) add("go", goLine, goLine, "go.mod");

  // 5. Rust. `channel = "stable"` is the common case and is NOT a tag — the
  //    official image publishes numbers, not channels — so it declares nothing
  //    and the platform default applies, recorded as such.
  const channel = f.rustToolchainToml?.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1];
  if (channel && !RUST_CHANNEL.test(channel.trim())) add("rust", channel, channel, "rust-toolchain.toml");
  const bare = firstLine(f.rustToolchain);
  if (bare && !RUST_CHANNEL.test(bare)) add("rust", bare, bare, "rust-toolchain");

  // 6. Ruby.
  const rubyVersion = firstLine(f.rubyVersion);
  // `.ruby-version` is sometimes written `ruby-3.3.0` by rbenv tooling.
  if (rubyVersion) add("ruby", rubyVersion, rubyVersion.replace(/^ruby-/i, ""), ".ruby-version");
  // `ruby file: ".ruby-version"` is the other Gemfile idiom, and it points at a
  // file this reader already read — so there is nothing extra to take from it.
  const gemfileRuby = f.gemfile?.match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1];
  if (gemfileRuby) add("ruby", gemfileRuby, gemfileRuby, "Gemfile", "range");

  // 7. PHP. `config.platform.php` is what Composer resolves against and is always
  //    concrete; `require.php` is a range. Concrete first.
  const composer = (f.composerJson ?? null) as
    { config?: { platform?: { php?: string } }; require?: Record<string, string> } | null;
  const platformPhp = composer?.config?.platform?.php;
  if (platformPhp) add("php", platformPhp, platformPhp, "composer.json config.platform.php");
  const requirePhp = composer?.require?.php;
  if (requirePhp) add("php", requirePhp, requirePhp, "composer.json require.php", "range");

  // 8. Java — every route reduced to a major; see javaMajor.
  const sdkman = f.sdkmanrc?.match(/^\s*java\s*=\s*(.+)$/m)?.[1];
  if (sdkman) {
    const major = javaMajor(sdkman);
    if (major) add("java", sdkman.trim(), major, ".sdkmanrc");
  }
  for (const field of ["maven.compiler.release", "java.version", "maven.compiler.source", "maven.compiler.target"]) {
    const found = f.pomXml?.match(new RegExp(`<${field.replace(/\./g, "\\.")}>([^<]+)<`))?.[1];
    if (!found) continue;
    const major = javaMajor(found);
    if (major) { add("java", found.trim(), major, `pom.xml ${field}`); break; }
  }
  const gradle = f.buildGradle?.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1]
    ?? f.buildGradle?.match(/jvmToolchain\((\d+)\)/)?.[1]
    ?? f.buildGradle?.match(/(?:source|target)Compatibility\s*=?\s*["']?([A-Za-z0-9_.]+)["']?/)?.[1];
  if (gradle) {
    const major = javaMajor(gradle);
    if (major) add("java", gradle.trim(), major, "build.gradle");
  }

  return pins;
}

/** The winning declaration for one language, or null when the repo is silent about it. */
export function pinFor(pins: RuntimePin[], language: RuntimeLanguage): RuntimePin | null {
  return pins.find((p) => p.language === language) ?? null;
}

/**
 * A tag Docker will accept.
 *
 * Docker's own grammar, applied here rather than at `docker build`. A malformed
 * tag has to fail in `detect()` with a sentence naming the file that produced it:
 * by the time it is `invalid reference format` in a build log there is no source
 * file in the message, and the repair classifier has nothing to act on.
 */
export function assertValidTag(tag: string, where: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new RuntimeVersionError(
      `${where} asks for "${tag}", which is not a version an image can be pulled by.\n` +
      `  Write a concrete version there (like "3.12"), or set "build": { "image": "…" } ` +
      `in supersonic.json to choose the base image yourself.`,
    );
  }
}

/**
 * The concrete tag one language is built on, and the sentence explaining it.
 *
 * Three cases, in order:
 *   silence   → the platform default, recorded as `platform default`
 *   exact     → straight through, untouched and unchecked against any list of ours
 *   a range   → the newest version we know of that satisfies it, recorded as a
 *               resolution so the choice is visible rather than inferred
 *
 * A range we cannot parse is the fourth case and it is deliberately not an error:
 * `>=3.10 || <4` is legal in somebody's ecosystem and unreadable in ours, and
 * refusing the deploy over it would be the platform's grammar deciding what an app
 * may run. It takes the default, and `versionFrom` says the spec was not understood
 * — which is the line the owner needs and the repair loop can act on.
 */
export function resolveRuntime(language: RuntimeLanguage, pin: RuntimePin | null): ResolvedRuntime {
  const fallback = (why: string): ResolvedRuntime => ({
    language,
    version: PLATFORM_DEFAULT_VERSION[language],
    versionFrom: why,
  });

  if (!pin) return fallback("platform default");

  const spec = pin.spec.trim();

  // A file whose only job is holding one version, holding something that is not
  // one. Not a range we failed to parse — a typo, in the one place the author
  // wrote to be obeyed. Silently building on the platform default is how they
  // never find out, and `invalid reference format` forty lines into a build log
  // names no file at all.
  if (pin.kind === "exact" && !isExact(spec)) {
    throw new RuntimeVersionError(
      `${pin.from} says "${pin.raw.trim()}", which is not a version.\n` +
      `  Write a plain version there (like "${PLATFORM_DEFAULT_VERSION[language]}"), ` +
      `or set "build": { "image": "…" } in supersonic.json to choose the base image yourself.`,
    );
  }

  if (isExact(spec)) {
    const version = spec.replace(/^v/, "");
    assertValidTag(version, pin.from);
    return {
      language,
      version,
      versionFrom: version === pin.raw.trim() ? pin.from : `${pin.from} ${pin.raw.trim()} → ${version}`,
    };
  }

  const options = satisfying(language, spec);
  if (!options) {
    return fallback(`platform default — ${pin.from} says "${pin.raw.trim()}", which is not a version range we read`);
  }
  const chosen = options.at(-1);
  if (!chosen) {
    return fallback(
      `platform default — ${pin.from} asks for "${pin.raw.trim()}" and no ${language} we know of satisfies it`,
    );
  }
  assertValidTag(chosen, pin.from);
  return { language, version: chosen, versionFrom: `${pin.from} ${pin.raw.trim()} → ${chosen}` };
}

/** Read one directory and answer for one language, in a single call. */
export function runtimeFor(dir: string, language: RuntimeLanguage): ResolvedRuntime {
  return resolveRuntime(language, pinFor(runtimePins(readRuntimeFiles(dir)), language));
}

/* ========================================================================== */
/* The runner half — deleted when the decommission query returns empty         */
/* ========================================================================== */

export interface RepoRuntime {
  language: "python" | "node";
  /**
   * Verbatim, exactly as the repo wrote it.
   *
   * Never normalised and never rewritten. The builder is what interprets this;
   * carrying it around in our own format would be the platform having an opinion
   * about versions again, one lossy conversion later.
   */
  spec: string;
  /** Which file said so — the only useful half of a log line about this. */
  from: string;
}

/** The files an ecosystem uses to pin its own runtime. None of them are ours. */
export interface RepoFiles {
  pythonVersion?: string | null;   // .python-version
  runtimeTxt?: string | null;      // runtime.txt   — "python-3.11.9"
  pyproject?: string | null;       // requires-python
  nvmrc?: string | null;           // .nvmrc
  packageJson?: unknown;           // engines.node
}

const trim = (v: string | null | undefined) => (v ?? "").trim().split("\n")[0].trim();

/**
 * The runtime this repository declares, from whichever file declares it.
 *
 * Order is specificity, not preference: a file whose ONLY job is to pin the
 * runtime outranks a field inside a manifest that is mostly about other things.
 * Someone who wrote `.python-version` meant that number; `requires-python` is
 * usually a compatibility range and often much wider than what they run.
 */
export function repoRuntime(f: RepoFiles): RepoRuntime | null {
  const pv = trim(f.pythonVersion);
  if (pv) return { language: "python", spec: pv, from: ".python-version" };

  const rt = trim(f.runtimeTxt);
  if (/^python-/i.test(rt)) return { language: "python", spec: rt.replace(/^python-/i, ""), from: "runtime.txt" };

  const nvm = trim(f.nvmrc);
  if (nvm) return { language: "node", spec: nvm.replace(/^v/, ""), from: ".nvmrc" };

  const requires = f.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (requires) return { language: "python", spec: requires.trim(), from: "pyproject.toml" };

  const engines = (f.packageJson as { engines?: { node?: string } } | null)?.engines?.node;
  if (engines) return { language: "node", spec: engines.trim(), from: "package.json" };

  return null;
}

/** `3.14` → [3, 14]. Trailing patch is dropped: the runner is pinned to a minor. */
function pair(v: string): [number, number] | null {
  const m = v.match(/^(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

function ge(have: [number, number], need: [number, number]): boolean {
  return have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]);
}

/**
 * Can the prebuilt runner serve exactly what this repo asked for?
 *
 * Deliberately conservative, and the direction of the conservatism is the whole
 * design: **anything this cannot confidently answer YES to is a NO**, and a no
 * routes the app to a builder that reads the file itself. Being wrong in that
 * direction costs a slower build. Being wrong the other way puts an app on an
 * interpreter its author did not choose, which is what produced a traceback
 * inside a customer's own code with nothing in our logs to explain it.
 *
 * So no attempt is made to be a full PEP 440 or semver implementation. The
 * grammar understood here is the grammar people actually pin runtimes with, and
 * everything else falls through to the builder — which has a real implementation
 * and is the correct place for one.
 */
export function runnerServes(r: RepoRuntime): boolean {
  const have = pair(RUNTIME_VERSIONS[r.language]);
  if (!have) return false;
  const spec = r.spec.trim();

  // An exact pin — "3.12", "3.12.1", "22". Matched on major.minor, because that
  // is the granularity the runner images are pinned to; a patch difference is not
  // something we can honour either way and pretending otherwise would be a lie in
  // the safe-looking direction.
  if (/^\d+(\.\d+)*$/.test(spec)) {
    const want = pair(spec)!;
    return spec.includes(".") ? have[0] === want[0] && have[1] === want[1] : have[0] === want[0];
  }

  // A range. Every clause has to hold, and an upper bound is the clause that
  // matters most — it is how an app says "not the newest one", which is exactly
  // the case the old lower-bound-only check missed.
  const clauses = spec.split(/\s*,\s*|\s+/).filter(Boolean);
  if (!clauses.length) return false;

  for (const c of clauses) {
    const m = c.match(/^(>=|<=|==|!=|~=|\^|>|<)?\s*v?(\d+(?:\.\d+)*)$/);
    if (!m) return false;                      // unrecognised grammar — hand it over
    const [, op = ">=", v] = m;
    const want = pair(v)!;
    const exact = have[0] === want[0] && have[1] === want[1];
    switch (op) {
      case ">=": if (!ge(have, want)) return false; break;
      case ">":  if (ge(want, have)) return false; break;
      case "<":  if (ge(have, want)) return false; break;
      case "<=": if (!ge(want, have) && !exact) return false; break;
      case "==": if (!exact) return false; break;
      case "!=": if (exact) return false; break;
      // `~=3.11` and `^3.11` both mean "this minor, or compatible with it", and
      // the honest answer for a runner pinned to one minor is only yes when it IS
      // that minor.
      case "~=": case "^": if (!exact) return false; break;
      default: return false;
    }
  }
  return true;
}

/**
 * The sentence for the deploy log when a repo's runtime sends it off the runner.
 *
 * Says what the repo asked for, where it said it, and what happens next — because
 * the visible consequence is a build that takes minutes instead of seconds, and
 * an owner who is not told why will read that as the platform being slow.
 */
export function runtimeRouting(r: RepoRuntime): string {
  return `${r.from} asks for ${r.language} ${r.spec} and the fast runner only has `
    + `${RUNTIME_VERSIONS[r.language]} — building this one from source so it gets the version it asked for.`;
}

/**
 * The schema's own `runtime` field — "python3.12", "node22" — as a pin.
 *
 * The same question asked of a different source. A config saying
 * `runtime: "python3.12"` is the author pinning a version exactly as
 * `.python-version` would, and it has to reach the same answer or `supersonic
 * check` refuses a config the deploy would happily run — the one-rule-two-readers
 * failure this codebase is named after, which is precisely how it was caught.
 */
export function declaredRuntime(runtime: string | undefined): RepoRuntime | null {
  const m = (runtime ?? "").trim().match(/^(python|node)\s*v?(\d+(?:\.\d+)*)$/i);
  if (!m) return null;
  return { language: m[1].toLowerCase() as "python" | "node", spec: m[2], from: "supersonic.json" };
}
