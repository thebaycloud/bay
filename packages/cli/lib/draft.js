"use strict";
/**
 * Writing the first draft of `supersonic.json` from the repository alone.
 *
 * The measurement this exists for: on 1 Aug the detector read the root of a
 * `frontend/` + `backend/` repo as "Static site, 80% confidence" — its highest
 * confidence answer, and completely wrong. Nothing here makes that detector
 * better. What changes is WHERE its answer lands. Today it selects a lane on a
 * server, silently, 200 seconds into a deploy nobody is watching; here it lands in
 * a file, in front of the agent that wrote the app, before anything is
 * provisioned. Same code, radically better position — a wrong answer you can read
 * is not the same defect as a wrong answer you cannot.
 *
 * So the rules are: infer only what the files actually say, never invent a
 * declaration to fill a field, and print the questions this cannot answer instead
 * of guessing them. A draft that quietly guesses `spaFallback` is worse than one
 * that asks, because the guess is indistinguishable from a decision.
 *
 * Everything that turns a detected stack into a service — the `$PORT` rewrite, the
 * `app.main:app` module path, uv-without-requirements.txt — comes from
 * infer-services.ts through vendor/resolve.js. This file adds only what that
 * module has no reason to know: the declared runtime version, a framework token,
 * and the env var names a grep can see.
 */
const fs = require("node:fs");
const path = require("node:path");

/* -------------------------------------------------------------------------- */
/* Locally determinable facts                                                  */
/* -------------------------------------------------------------------------- */

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The runtime the repository ASKS FOR, or null when it asks for nothing.
 *
 * Null is the important return. `runtime` is a hard gate — a service declaring
 * python3.15 is refused before the build, because the runner has 3.14 and pip
 * fails forty lines into a log that blames the app. Defaulting the field to
 * whatever the platform happens to ship today would turn that gate into a
 * tautology, and would also pin the app to a version its author never chose: the
 * next time the runner moves, a draft written months ago silently holds it back.
 * Absent means "whatever the runner has", which is the truthful answer for a repo
 * that never said.
 *
 * Both directories are consulted because a monorepo puts `.nvmrc` at the root and
 * its app in `frontend/`, and the root file is still the version the author means.
 */
function declaredRuntime(serviceDir, repoDir, language) {
  const at = (name) => readText(path.join(serviceDir, name)) ?? (serviceDir === repoDir ? null : readText(path.join(repoDir, name)));

  if (language === "node") {
    const pkg = readJson(path.join(serviceDir, "package.json")) ?? {};
    const engines = pkg.engines && typeof pkg.engines.node === "string" ? pkg.engines.node : null;
    // `>=20`, `^20.11.0`, `20.x`, `20` all mean major 20. A range with no number
    // in it at all (`*`, `latest`) is not a declaration.
    const major = (engines ?? at(".nvmrc") ?? "").match(/(\d+)/);
    return major ? `node${major[1]}` : null;
  }
  if (language === "python") {
    const py = at("pyproject.toml") ?? "";
    const requires = py.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
    const version = (requires ? requires[1] : at(".python-version") ?? "").match(/(\d+)\.(\d+)/);
    return version ? `python${version[1]}.${version[2]}` : null;
  }
  return null;
}

/**
 * The detector's display name for a framework, as the token the platform routes on.
 *
 * Mapped rather than re-detected: the detector already reads the dependency names,
 * and a second scan here would be a second answer to "is this Django". Anything
 * generic — "Node", "Python", "Static site" — maps to null, because `framework` is
 * not a label. It selects the proxy-awareness injection in Phase 7b
 * (ALLOWED_HOSTS, basePath, ROOT_PATH), and a token nothing has a mapping for is a
 * field that reads as configured and does nothing.
 */
const FRAMEWORK_TOKENS = {
  "Next.js": "next",
  "Nuxt": "nuxt",
  "Remix": "remix",
  "SvelteKit": "sveltekit",
  "Astro": "astro",
  "NestJS": "nest",
  "Vite (SPA)": "vite",
  "Create React App": "cra",
  "Express": "express",
  "Fastify": "fastify",
  "Koa": "koa",
  "Django": "django",
  "FastAPI": "fastapi",
  "Flask": "flask",
  "Rails": "rails",
  "Laravel": "laravel",
};

function frameworkToken(detected) {
  return FRAMEWORK_TOKENS[detected] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Env var names                                                               */
/* -------------------------------------------------------------------------- */

/** Directories that hold somebody else's code, or this app's output. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "vendor",
  "dist", "build", "target", ".next", ".nuxt", ".output", "coverage",
  ".terraform", "site-packages", ".pytest_cache", ".mypy_cache",
]);

const SOURCE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py"]);

/**
 * Names that appear in a `process.env` grep and are never a secret to be asked for.
 *
 * NODE_ENV in particular: it is read by almost every Node file that reads anything,
 * and putting it at the top of "which of these are secrets?" is how a list stops
 * being read at all.
 */
const NOT_A_SECRET = new Set([
  "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "PATH", "HOME", "PWD", "USER", "SHELL",
  "TZ", "LANG", "CI", "DEBUG", "LOG_LEVEL", "HOSTNAME", "HOST", "TMPDIR",
  "PYTHONPATH", "PYTHONUNBUFFERED", "VIRTUAL_ENV",
]);

/**
 * Prefixes whose values are baked into the bundle at BUILD time.
 *
 * Kept apart from secrets because they are set at a different moment and the
 * mistake is silent: set after the build — which is what a plain env var does —
 * the build ran without them and the value never reached the shipped JavaScript.
 * The page loads, calls `undefined/api`, and nothing in any log mentions the
 * variable.
 */
const BUILD_TIME = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|GATSBY_|NUXT_PUBLIC_|EXPO_PUBLIC_|STORYBOOK_)/;

const PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /(?:os\.environ(?:\.get)?|os\.getenv|getenv)\s*[[(]\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];

/**
 * Every env var name the source reads, split into build-time and runtime.
 *
 * A grep, and honest about being one: it finds names, never values, never whether
 * a name is required. That is the whole of what static analysis can say here —
 * which of these are secrets is a judgement the author makes and the file records.
 *
 * Bounded because `init` promises about two seconds and a repository can contain
 * anything. Hitting a bound truncates the QUESTION, never the config, so the worst
 * case is an unlisted candidate rather than a wrong draft.
 */
function envNames(serviceDir, { maxFiles = 800, maxBytes = 512 * 1024, platformOwned = () => false } = {}) {
  const found = new Set();
  let budget = maxFiles;

  const walk = (dir, depth) => {
    if (budget <= 0 || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile() || !SOURCE_EXT.has(path.extname(e.name))) continue;
      budget--;
      let text;
      try {
        if (fs.statSync(path.join(dir, e.name)).size > maxBytes) continue;
        text = fs.readFileSync(path.join(dir, e.name), "utf8");
      } catch { continue; }
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) found.add(m[1]);
      }
    }
  };
  walk(serviceDir, 0);

  const buildEnv = [];
  const secrets = [];
  for (const name of [...found].sort()) {
    // PORT, DATABASE_URL and the sixteen other spellings of it are written by the
    // platform. Offering one as a secret would produce a config that
    // parseAppConfig refuses outright — a draft that cannot be parsed is worse
    // than no draft.
    if (platformOwned(name) || NOT_A_SECRET.has(name)) continue;
    (BUILD_TIME.test(name) ? buildEnv : secrets).push(name);
  }
  return { buildEnv, secrets };
}

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The repository's services, drawn entirely from the shared inference path.
 *
 * Three shapes, one of which the control plane's inferAppConfig already handles
 * and two of which it deliberately declines:
 *
 *   root Dockerfile  — inferAppConfig returns null so that an inference can never
 *     outrank an instruction. `init` is not inferring here; it is writing down the
 *     instruction, which is the one thing that makes a nested build context
 *     ("context") expressible at all.
 *   two or more apps — inferAppConfig, unchanged.
 *   one app          — inferAppConfig declines below two parts because splitting a
 *     single-app repo is the thing it exists not to do. init still has to write a
 *     file, so it asks deployableParts where the one app is and runs the same
 *     serviceFor mapping on it. Note the case this fixes: a repo whose only app is
 *     `backend/` used to leave the CLI with nothing but the root to detect, which
 *     is the "Static site, 80%" answer again.
 */
async function draftServices(repoDir, r, detect) {
  const facts = r.readRepoFacts(repoDir);

  if (facts.dockerfiles.includes("Dockerfile")) {
    const stack = await detect(repoDir);
    // No `language`: deriveLane checks `language === "static"` before it checks
    // the Dockerfile, so calling a Vite repo with a hand-written Dockerfile
    // "static" would route it away from the file its author committed.
    return {
      config: { version: 1, services: [{ name: "app", dir: ".", dockerfile: "Dockerfile", context: ".", path: "/" }] },
      stacks: new Map([[".", stack]]),
    };
  }

  const parts = r.deployableParts(repoDir, facts);
  const stacks = new Map();
  const abs = (rel) => (rel === "." ? repoDir : path.join(repoDir, rel));

  if (parts.length >= 2) {
    const config = await r.inferAppConfig(repoDir, detect);
    // inferAppConfig swallows a failed detect and returns null rather than break a
    // deploy that works today. Here there is no deploy to protect, so fall through
    // to the single-service shape instead of writing nothing.
    if (config) {
      for (const s of config.services) stacks.set(s.dir ?? ".", await detect(abs(s.dir ?? ".")));
      return { config, stacks };
    }
  }

  const rel = parts[0] ?? ".";
  const stack = await detect(abs(rel));
  stacks.set(rel, stack);
  return {
    config: { version: 1, services: [{ ...r.serviceFor(rel, stack, abs(rel)), path: "/" }] },
    stacks,
  };
}

/** `needsDB` is the v1 spelling; a draft written today should use the one that replaced it. */
function usesFor(service) {
  return service.needsDB || (service.uses ?? []).includes("database") ? ["database"] : [];
}

/**
 * Build the draft config and the list of questions it cannot answer.
 *
 * Placeholders are deliberate and deliberately inert. `release: ""`,
 * `spaFallback: false`, `secrets: []` and `buildEnv: {}` are all read by
 * declaredFields as NOT declared, so none of them can trip assert-consumed — a
 * static service carrying an empty `release` is not a static service that declared
 * a migration. What they buy is that the field name is in the file, next to the
 * service it belongs to, where the agent correcting the draft will see it. A
 * question printed to a terminal is gone the moment the terminal scrolls.
 */
async function buildDraft(repoDir, { resolver: r, detect }) {
  const { config, stacks } = await draftServices(repoDir, r, detect);
  const candidates = new Map();
  // Decided over ALL services before any one of them is scanned, because whether
  // DATABASE_URL is a secret the author must supply or a value the platform writes
  // depends on it — and a draft that offers DATABASE_URL as a secret for an app
  // about to be handed a provisioned Postgres is asking the author for something
  // they must not answer. Same ordering the parser needs, for the same reason.
  const draftDatabase = config.services.some((s) => usesFor(s).length > 0)
    ? { provider: "managed", engine: "postgres" }
    : undefined;
  const ownedInDraft = (name) => r.platformOwned(name, draftDatabase);
  let wantsDatabase = false;

  const services = config.services.map((s) => {
    const dir = s.dir ?? ".";
    const absDir = dir === "." ? repoDir : path.join(repoDir, dir);
    const stack = stacks.get(dir);
    const isStatic = s.language === "static";
    const env = envNames(absDir, { platformOwned: ownedInDraft });
    candidates.set(s.name, env);
    wantsDatabase = wantsDatabase || usesFor(s).length > 0;

    const out = { ...s };
    delete out.needsDB;

    // Every field below is gated on the lane that will read it, because a draft
    // that trips assert-consumed is a draft whose first act is to fail — and the
    // failure names a field the AUTHOR never wrote. The static lane builds a
    // directory and hands it to a CDN: it has no runtime to pin, no proxy to make
    // a framework aware of, and no credentials to receive. Those still get
    // ANSWERED, one level up, in `resources`.
    if (!isStatic) {
      const runtime = declaredRuntime(absDir, repoDir, s.language);
      if (runtime) out.runtime = runtime;

      const framework = stack ? frameworkToken(stack.framework) : null;
      if (framework) out.framework = framework;

      const uses = usesFor(s);
      if (uses.length) out.uses = uses;

      out.release = "";
    } else {
      delete out.needsDB;
      out.spaFallback = false;
    }

    if (env.buildEnv.length) out.buildEnv = {};
    out.secrets = [];
    return out;
  });

  // Stated at app level even when a service also declares `uses`, because they are
  // different claims: `resources` is what gets provisioned, once, and `uses` is
  // which service receives the credentials. Provisioning driven by the primary
  // service alone is how a static frontend on "/" with a Django API on "/api"
  // provisioned nothing at all.
  const resources = config.resources ?? (wantsDatabase ? { database: { engine: "postgres" } } : null);

  return {
    config: { version: 1, ...(resources ? { resources } : {}), services },
    candidates,
    stacks,
  };
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** What this service does, in one line: the commands, not the configuration. */
function summaryOf(s) {
  if (s.dockerfile) return `${s.dockerfile}${s.context && s.context !== "." ? ` (context ${s.context})` : ""}`;
  if (s.language === "static") {
    const steps = [s.install, s.build].filter(Boolean).join(" && ");
    const out = s.outputDir && s.outputDir !== "." ? ` → ${s.outputDir}` : " → this folder";
    return steps ? `${steps}${out}` : `publish${out}`;
  }
  return s.start || "(no start command)";
}

function kindOf(s) {
  if (s.dockerfile) return "docker";
  return s.language ?? "other";
}

/**
 * The questions static analysis cannot answer, and which are live for THIS repo.
 *
 * Conditional on purpose. A block that asks about `spaFallback` on a repo with no
 * static service, or about migrations on one with no database, is a block that
 * gets skipped — and the one question that mattered gets skipped with it.
 */
function unknownsFor(repoDir, config, candidates) {
  const out = [];
  const servers = config.services.filter((s) => s.language !== "static");

  // Only when it is genuinely a coin flip. With a frontend and an API, whatever
  // answers a browser owns `/` and that is not a guess; with two servers the
  // detector has no signal at all and picked the first one declared.
  if (config.services.length >= 2 && servers.length === config.services.length) {
    const [first, ...rest] = config.services;
    out.push([
      `is \`${first.name}\` the one on / ?`,
      `(path — ${rest.map((s) => `${s.name} is on ${s.path}`).join(", ")})`,
    ]);
  }

  for (const s of servers) {
    // The detector hands back `gunicorn ${MODULE}.wsgi` for every Django project
    // and prints "Set ${MODULE} to your Django project package." as a note nobody
    // reads. Unset, the shell expands it to nothing and the container dies on
    // `gunicorn .wsgi` — a placeholder that looks like a command right up until it
    // runs. Not an error here: MODULE is a name the author may yet set. It is a
    // question, which is what this block is for.
    const placeholder = String(s.start ?? "").match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    if (placeholder) {
      out.push([
        `what is \${${placeholder[1]}} in \`${s.name}\`'s start command?`,
        "(start — the shell expands it to nothing until something sets it)",
      ]);
    }

    // Asked where a migration is plausible: a service that reaches the database.
    // "Alembic is installed" and "alembic upgrade head SHOULD run before traffic"
    // are different claims and only the author holds the second one.
    if ((s.uses ?? []).includes("database")) {
      out.push([`does \`${s.name}\` need a migration before traffic?`, "(release: …)"]);
    }
  }

  for (const s of config.services) {
    if (s.language !== "static") continue;
    out.push(["should unknown paths serve index.html?", "(spaFallback)"]);
    // A committed output directory is either the deliverable or last month's
    // build, and the two are the same bytes on disk. Publishing a stale one is a
    // silent wrong SUCCESS, which is worse than a failure.
    const built = s.outputDir && s.outputDir !== "." ? path.join(repoDir, s.dir === "." ? "" : s.dir, s.outputDir) : null;
    if (s.build && built && fs.existsSync(built)) {
      out.push([`is the committed \`${path.relative(repoDir, built)}\` the deliverable, or stale?`, "(it is in the repo already)"]);
    }
  }

  const build = [...new Set([...candidates.values()].flatMap((c) => c.buildEnv))].sort();
  if (build.length) {
    out.push([
      `what ${build.length === 1 ? "is" : "are"} ${listOf(build, 4)} at BUILD time?`,
      "(buildEnv — a value set after the build never reaches the bundle)",
    ]);
  }

  const secrets = [...new Set([...candidates.values()].flatMap((c) => c.secrets))].sort();
  if (!secrets.length) out.push(["which secrets does it read?", "(secrets: [])"]);
  else if (secrets.length === 1) out.push([`is ${secrets[0]} a secret?`, "(secrets: [])"]);
  else out.push([`which of ${listOf(secrets, 6)} are secrets?`, "(secrets: [])"]);

  return out;
}

function pad(s, n) { return s + " ".repeat(Math.max(0, n - s.length)); }

/** Names, truncated. A question listing forty variables is a question nobody answers. */
function listOf(names, limit) {
  return names.slice(0, limit).join(", ") + (names.length > limit ? `, +${names.length - limit} more` : "");
}

/** The whole of what `init` says, as lines. Separated from printing so it can be tested. */
function renderDraft(configFilename, config, unknowns) {
  const lines = [];
  const n = config.services.length;
  lines.push(`Wrote ${configFilename} — ${n} service${n === 1 ? "" : "s"} detected.`);
  lines.push("");

  const pathW = Math.max(...config.services.map((s) => (s.path ?? "/").length));
  const nameW = Math.max(...config.services.map((s) => String(s.name ?? "app").length));
  const kindW = Math.max(...config.services.map((s) => kindOf(s).length));
  for (const s of config.services) {
    lines.push(`  ${pad(s.path ?? "/", pathW)}   ${pad(String(s.name ?? "app"), nameW)}   ${pad(kindOf(s), kindW)}   ${summaryOf(s)}`);
  }

  if (unknowns.length) {
    const word = COUNT_WORDS[unknowns.length] ?? String(unknowns.length);
    const askW = Math.max(...unknowns.map(([ask]) => ask.length));
    lines.push("");
    lines.push(`${word} thing${unknowns.length === 1 ? "" : "s"} I could not determine — check ${unknowns.length === 1 ? "it" : "them"}:`);
    for (const [ask, where] of unknowns) lines.push(`  · ${pad(ask, askW)}  ${where}`);
  }

  lines.push("");
  // Said last, where it is read. The detector that wrote this is the one that read
  // a frontend/+backend/ root as "Static site, 80% confidence" — its own highest
  // confidence answer. Presenting its output as a finding rather than a draft is
  // how that answer became a deploy.
  lines.push("This is a draft, from a detector that has been confidently wrong before.");
  lines.push(`Read it, fix what is wrong, then: bay check`);
  return lines;
}

module.exports = {
  buildDraft, renderDraft, unknownsFor,
  declaredRuntime, frameworkToken, envNames, summaryOf,
};
