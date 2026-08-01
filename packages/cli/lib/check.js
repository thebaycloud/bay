"use strict";
/**
 * The local dry run: resolve, validate, and say what each phase would run.
 *
 * It fixes zero deploys directly, and it is the highest-leverage thing in this
 * package, because the author of a supersonic.json is always an agent and its loop
 * today is eleven minutes long — upload, provision, build, fail, read a log,
 * guess. Eleven attempts is two hours of wall clock and a Cloud Build bill for
 * every one. The same eleven attempts against this is twenty seconds, on the
 * user's machine, on the user's tokens.
 *
 * That only holds if this answers the question the server will answer, so nothing
 * here decides anything. It calls resolve() and validate() out of
 * vendor/resolve.js — the control plane's own, compiled — and formats the result.
 * A check that agreed with the server most of the time would be worse than no
 * check at all: it would move the surprise from the first deploy to the tenth.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Read a manifest for the runtime gate; absent is not an error, it is silence. */
function readOr(file, fallback) {
  try { return fs.readFileSync(file, "utf8"); } catch { return fallback; }
}

function jsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/**
 * Resolve and validate a directory, collecting every problem rather than the first.
 *
 * `validate` already batches its own — a config with four mistakes should cost one
 * round trip, not four — so the only thing added here is the runtime gate, which
 * lives in plan-deps and is checked by the pipeline at deploy-pipeline.ts:1026.
 * Left out, `check` would pass a repo the deploy refuses, which is the one outcome
 * that makes a dry run worth less than nothing.
 */
/**
 * One thrown message back into the several problems it reports.
 *
 * `validate` batches deliberately — a config with four mistakes should cost one
 * round trip — and joins them with newlines. But assert-consumed's message is
 * itself three lines, so splitting on every newline turns one problem into three
 * and makes the count a lie. The ✕ is the boundary; a continuation line never
 * carries one.
 */
function splitProblems(e) {
  return String(e && e.message ? e.message : e).split(/\n(?=✕)/);
}

async function checkApp(dir, { resolver: r, detect }) {
  const problems = [];
  const warnings = [];
  let app = null;

  try {
    app = await r.resolve(dir, detect);
  } catch (e) {
    return { app: null, problems: splitProblems(e), warnings };
  }

  try {
    r.validate(app, dir);
  } catch (e) {
    problems.push(...splitProblems(e));
  }

  for (const s of app.services) {
    const abs = path.join(dir, s.dir);
    const mismatch = r.runtimeMismatch({
      pyproject: readOr(path.join(abs, "pyproject.toml"), null),
      packageJson: jsonOr(path.join(abs, "package.json"), null),
    });
    if (mismatch) problems.push(`✕ service "${s.name}": ${mismatch}`);
  }

  return { app, problems, warnings };
}

/**
 * Secrets named in the config that nothing local can supply.
 *
 * A warning, not an error, and the distinction is real: a value already set on the
 * deployed app is invisible from here, so failing on it would refuse a correct
 * config. `envNeeded` had the opposite bug — the platform knew the name was
 * required, logged it to nobody, and deployed anyway, so the first anyone heard was
 * a crash inside the customer's app.
 */
function secretWarnings(r, app, available) {
  const missing = r.missingSecrets(app, available);
  if (!missing.length) return [];
  return [`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} declared under \`secrets\` and set nowhere here — supersonic env <app> set, or a .env`];
}

const PHASE_WIDTH = 10;

function phase(name, value) {
  return `    ${name.padEnd(PHASE_WIDTH)}${value}`;
}

/**
 * Per service, exactly what each phase would run.
 *
 * The commands are printed as resolved — subshell-wrapped, `$PORT` already
 * substituted — because the wrapping is where a real bug lived: each command was
 * prefixed independently and the lanes disagreed about how they ran them, so a
 * bare `cd frontend && …` installed correctly and then failed with `cd: frontend:
 * No such file or directory`. Printing the pretty version would hide the only
 * detail worth checking.
 */
function renderService(s) {
  const lines = [`  ${s.name}  ·  ${s.lane} lane  ·  ${s.path}`];
  if (s.runtime) lines.push(phase("runtime", s.runtime));
  if (s.dockerfile) lines.push(phase("image", `${s.dockerfile}  (context ${s.context})`));
  if (s.install) lines.push(phase("install", s.install));
  if (s.build) lines.push(phase("build", s.build));

  if (s.lane === "static") {
    lines.push(phase("publish", `${s.outputDir}${s.spaFallback ? "  ·  unknown paths → index.html" : ""}`));
  } else {
    // Printed even when empty: the release phase is the difference between a
    // migration running once before traffic and running on every cold start and
    // every scale-out instance, concurrently. A blank line here is a fact about
    // this deploy, not a missing one.
    lines.push(phase("release", s.release || "—  (nothing runs before traffic)"));
    lines.push(phase("start", s.lane === "container"
      ? "the Dockerfile's own CMD"
      : s.start || "—  (nothing to run: this lane needs one)"));
    lines.push(phase("health", `GET ${s.health.path} → ${s.health.expect}`));
    lines.push(phase("scale", `${s.scale.memory} · ${s.scale.cpu} cpu · max ${s.scale.maxInstances} · ${s.scale.timeout}s`));
  }

  if (s.uses.length) lines.push(phase("uses", s.uses.join(", ")));
  if (Object.keys(s.env).length) lines.push(phase("env", Object.keys(s.env).join(", ")));
  if (Object.keys(s.buildEnv).length) lines.push(phase("buildEnv", Object.keys(s.buildEnv).join(", ")));
  if (s.secrets.length) lines.push(phase("secrets", s.secrets.join(", ")));
  if (s.framework) lines.push(phase("framework", s.framework));
  return lines;
}

function renderCheck(configFilename, app, problems, warnings) {
  const lines = [];

  if (app) {
    const n = app.services.length;
    const provisioned = [
      app.resources.database ? "postgres" : null,
      app.resources.bucket ? "bucket" : null,
    ].filter(Boolean);
    // Which of the two sources this came from, always. "Plan ready:
    // supersonic.json" printed for an inferred app sends someone looking for a
    // file that is not there.
    const from = app.source === "config"
      ? configFilename
      : `inferred — there is no ${configFilename} (\`supersonic init\` writes one)`;
    lines.push(`${from} — ${n} service${n === 1 ? "" : "s"}${provisioned.length ? `, provisions ${provisioned.join(" + ")}` : ""}`);
    lines.push("");
    for (const s of app.services) lines.push(...renderService(s), "");
  }

  for (const w of warnings) lines.push(`! ${w}`);
  if (warnings.length) lines.push("");

  if (problems.length) {
    for (const p of problems) {
      const [head, ...rest] = p.split("\n");
      lines.push(head.startsWith("✕") ? head : `✕ ${head}`, ...rest);
    }
    lines.push("");
    lines.push(`${problems.length} problem${problems.length === 1 ? "" : "s"} — nothing was deployed, and nothing would be.`);
  } else {
    lines.push("✓ nothing here fails before the build. No GCP was touched.");
  }
  return lines;
}

module.exports = { checkApp, renderCheck, renderService, secretWarnings };
