/**
 * Does the plan's run command name a program that will actually exist?
 *
 * The planner reads a repo and writes the production run command. It is good at
 * this — across eight varied stacks it got the command right seven times. The one
 * miss was not a misunderstanding of the app: for a Flask project it wrote
 * `gunicorn app:app --bind 0.0.0.0:$PORT`, which is the correct way to serve
 * Flask in production and what every tutorial says — except gunicorn was not in
 * that project's requirements.txt. The container came up, exec'd the command, and
 * died with `gunicorn: not found`, exit 127.
 *
 * That failure is invisible to the model (nothing in the repo is wrong) and
 * invisible to the build (install and build both succeed). It only appears at
 * container start, as a startup-probe failure, which is then handed to the repair
 * agent as "the app didn't listen on $PORT" — and the last time that happened the
 * agent went looking for a port bug that did not exist.
 *
 * So it is checked mechanically here instead. The check is deliberately narrow:
 * it only claims a miss when it is sure.
 */

/** Programs the runner images always carry, so naming one is never a miss. */
const BASE_IMAGE_BINS = new Set([
  "node", "npm", "npx", "yarn", "pnpm", "corepack",
  "python", "python3", "pip", "pip3", "uv", "uvx",
  "sh", "bash", "env", "cd", "echo", "true", "exec", "set", "export", "wait", "sleep",
]);

/**
 * Python servers a plan may name. The list is the point: these are the programs a
 * model reaches for when asked "how is this served in production", and each one is
 * a separate pip package that a project written with `flask run` in mind will not
 * have. Anything outside this list is only warned about, never installed — the
 * cost of installing a package we guessed the name of is worse than a clear
 * warning in the log.
 */
const PYTHON_SERVERS = new Set([
  "gunicorn", "uvicorn", "hypercorn", "waitress", "daphne", "granian", "streamlit",
]);

/** `FOO=bar`, as it appears prefixed to a command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The programs a shell command line invokes.
 *
 * Split on the shell operators, then read the first real word of each piece —
 * skipping `VAR=value` prefixes, unwrapping `npx`/`uvx`, and reading the module
 * out of `python -m <mod>` (which is how the same server is often named). A piece
 * that hides its command inside `sh -c` is skipped rather than guessed at.
 */
export function commandBinaries(cmd: string): string[] {
  if (!cmd || !cmd.trim()) return [];
  const found: string[] = [];
  for (const piece of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = piece.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++;
    let bin = words[i];
    if (!bin) continue;
    // `npx --no-install prisma` → prisma. Flags first, then the real program.
    if (bin === "npx" || bin === "uvx" || bin === "pnpx") {
      i++;
      while (i < words.length && words[i].startsWith("-")) i++;
      bin = words[i];
      if (!bin) continue;
    }
    // `python -m uvicorn main:app` names uvicorn just as surely as `uvicorn` does.
    if ((bin === "python" || bin === "python3") && words[i + 1] === "-m" && words[i + 2]) {
      bin = words[i + 2];
    }
    // A command wrapped in `sh -c "…"` is a quoted string we would have to parse a
    // shell to read. Not guessed at.
    if ((bin === "sh" || bin === "bash") && words.slice(i).includes("-c")) continue;
    bin = bin.replace(/^["']|["']$/g, "");
    if (bin && !bin.startsWith("-")) found.push(bin);
  }
  return [...new Set(found)];
}

/** Package names declared in a requirements.txt, normalised the way pip compares them. */
export function requirementNames(requirements: string): Set<string> {
  const names = new Set<string>();
  for (const raw of requirements.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line || line.startsWith("-")) continue;      // -r other.txt, --index-url, …
    // Strip extras, markers and version specifiers: `uvicorn[standard]>=0.30 ; python_version<"3.12"`
    const name = line.split(/[;\[<>=!~ ]/)[0].trim().toLowerCase().replace(/_/g, "-");
    if (name) names.add(name);
  }
  return names;
}

/** Names declared in a package.json's dependencies and devDependencies. */
function packageJsonNames(pkg: unknown): Set<string> {
  const p = (pkg ?? {}) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  return new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
}

export interface PlanCommands {
  run?: string;
  preRun?: string[];
  build?: string;
}

export interface DepCheck {
  /** Python packages that must be installed for the run command to exist at all. */
  install: string[];
  /** Programs we could not account for — logged, never acted on. */
  unknown: string[];
}

/**
 * Check a plan's commands against what the project declares it installs.
 *
 * `language` decides which manifest is authoritative, because the two cases are
 * not symmetric. A Python project's requirements.txt is the complete list of what
 * pip will install, so a named server missing from it is definitely missing. A
 * Node project's package.json is NOT: `node_modules/.bin` is populated by
 * transitive dependencies and workspace packages, so a binary absent from the root
 * manifest is routinely present anyway (`nest` comes from `@nestjs/cli`, a
 * monorepo's tools live in a sub-package). Claiming a miss there would break
 * working deploys, so Node findings only ever become warnings.
 */
export function checkPlanDeps(
  plan: PlanCommands,
  ctx: { language?: string; requirements?: string | null; packageJson?: unknown },
): DepCheck {
  const cmds = [plan.run ?? "", ...(plan.preRun ?? [])].filter(Boolean);
  const bins = [...new Set(cmds.flatMap(commandBinaries))]
    .filter((b) => !BASE_IMAGE_BINS.has(b))
    // A path, not a program name: ./manage.py, /app/bin/serve, dist/main.js.
    .filter((b) => !b.includes("/"));

  const install: string[] = [];
  const unknown: string[] = [];

  if (ctx.language === "python") {
    const declared = ctx.requirements !== null && ctx.requirements !== undefined
      ? requirementNames(ctx.requirements)
      : null;
    for (const bin of bins) {
      const name = bin.toLowerCase().replace(/_/g, "-");
      // Only with a requirements.txt in hand — without one there is nothing to be
      // sure about, and appending to a file that does not exist would change how
      // the project is installed (prepare.sh prefers requirements.txt over
      // pyproject.toml, so creating one would silently drop the real dependencies).
      if (declared && !declared.has(name)) {
        if (PYTHON_SERVERS.has(name)) install.push(name);
        else unknown.push(bin);
      } else if (!declared && PYTHON_SERVERS.has(name)) {
        unknown.push(bin);
      }
    }
    return { install, unknown };
  }

  const declared = packageJsonNames(ctx.packageJson);
  for (const bin of bins) if (!declared.has(bin)) unknown.push(bin);
  return { install: [], unknown };
}


/* -------------------------------------------------------------------------- */
/* Runtime versions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the runner images actually provide — the one place any code states it.
 *
 * There were four, and they disagreed: the two runner Dockerfiles said 3.14 and
 * 24, this said 3.14 and 24, and packages/detector said `python:3.12`, which
 * is the number that ends up in the generated `FROM python:…-slim`. So a repo
 * declaring `requires-python = ">=3.14"` was built on 3.12 and failed at pip with
 * "requires a different Python: 3.12.13 not in '<4.0,>=3.14'" — a build log that
 * blames the app for a version this file already knew was wrong.
 *
 * NOT parsed from the Dockerfiles at module load, which was the first instinct.
 * The control-plane image copies exactly two directories (root Dockerfile:
 * `COPY --from=webbuild /app/apps/web` and `COPY --from=agentdeps
 * /app/packages/detector`); infra/runner is not in it. A read of
 * ../../infra/runner at import would work on every laptop and throw in
 * production — the same bug in a shape that is harder to see. Next also traces
 * lib/ into the server bundle and would not carry a file outside apps/web.
 *
 * So the constant stays and is pinned two ways instead: plan-deps.test.ts parses
 * both runner Dockerfiles and fails if either moves without this line moving, and
 * packages/detector imports this rather than repeating it. Drift now has to
 * break a test to land.
 */
export const RUNTIME_VERSIONS = { python: "3.14", node: "24" } as const;

/**
 * Marks a deploy refused because the platform does not have the runtime asked for.
 *
 * Same family as IAM_FAILURE and AMBIGUOUS_STACK in deploy-pipeline.ts, and it
 * exists for the same reason: there is no bug in the repository, so handing it to
 * the repair agent buys nothing but tokens and a wrong-headed patch. This one used
 * to be logged as "the build will probably fail on it — this is a platform limit,
 * not your app" and then built anyway, so the platform paid for the failed build
 * AND for an agent rediscovering, from the pip output, the sentence we had already
 * written before the build started.
 */
export const RUNTIME_UNSUPPORTED = "Runtime not available";

/** `>=3.14,<4.0` → the lowest version it will accept, as [major, minor]. */
function lowestAccepted(spec: string): [number, number] | null {
  // Only the lower bound matters here: an app asking for MORE than we have is
  // the case that fails, and it fails at install with a message nobody reads.
  const m = spec.match(/>=\s*(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

function below(have: string, need: [number, number]): boolean {
  const [hMaj, hMin] = have.split(".").map(Number);
  return hMaj < need[0] || (hMaj === need[0] && (hMin ?? 0) < need[1]);
}

/**
 * A plain sentence when the repo asks for a runtime the platform does not have.
 *
 * The failure without it is a pip line forty lines into a build log — "Package
 * 'app' requires a different Python: 3.12.13 not in '<4.0,>=3.14'" — which reads
 * as the app being broken rather than the platform being behind. Both manifests
 * state the requirement plainly and neither was ever read.
 *
 * Names both numbers and which file to edit, because the person reading it has
 * two options and only one of them is theirs: the sentence is also what the repair
 * agent would have been asked to work out, and it cannot edit our runner.
 */
export function runtimeMismatch(manifests: { pyproject?: string | null; packageJson?: unknown }): string | null {
  const py = manifests.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (py) {
    const need = lowestAccepted(py);
    if (need && below(RUNTIME_VERSIONS.python, need)) {
      return `this app needs Python ${py} and the runner has ${RUNTIME_VERSIONS.python}`
        + ` — widen requires-python in pyproject.toml to accept ${RUNTIME_VERSIONS.python}, or wait for the runner to move.`
        + ` Nothing in the code can fix this one.`;
    }
  }
  const engines = (manifests.packageJson as { engines?: { node?: string } } | null)?.engines?.node;
  if (engines) {
    const need = lowestAccepted(engines);
    if (need && below(RUNTIME_VERSIONS.node, need)) {
      return `this app needs Node ${engines} and the runner has ${RUNTIME_VERSIONS.node}`
        + ` — widen engines.node in package.json to accept ${RUNTIME_VERSIONS.node}, or wait for the runner to move.`
        + ` Nothing in the code can fix this one.`;
    }
  }
  return null;
}

/**
 * The gate. Called before anything is installed, built or pushed.
 *
 * A throw rather than a return because every caller that had this as advice
 * ignored it — the pipeline logged the mismatch, built, failed, and then spent a
 * repair-agent run on a pip error whose cause was in the log two minutes earlier.
 * The prefix is what keeps the agent out of it: deploy-pipeline.ts routes an error
 * carrying one of these markers straight to the user instead of to the repair
 * loop, the same way it already does for IAM and for a stack it refused to guess.
 */
export function assertRuntimeSupported(manifests: { pyproject?: string | null; packageJson?: unknown }): void {
  const mismatch = runtimeMismatch(manifests);
  if (mismatch) throw new Error(`${RUNTIME_UNSUPPORTED}: ${mismatch}`);
}
