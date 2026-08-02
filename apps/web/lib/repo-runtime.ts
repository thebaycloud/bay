import { RUNTIME_VERSIONS } from "./plan-deps";

/**
 * What version the REPOSITORY asks for, and whether the runner can serve it.
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
