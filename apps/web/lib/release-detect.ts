/**
 * Finding the one-shot step an app must run before it serves.
 *
 * A release is where migrations live, and an app whose migrations never ran is
 * an app that serves its homepage and 500s everything else. That is not
 * hypothetical: the full-stack FastAPI template deployed here with an empty
 * schema and answered every form with
 *
 *   sqlalchemy.exc.ProgrammingError: relation "user" does not exist
 *
 * while the platform reported the deploy live. Its migrations are declared in
 * `compose.yml`, as a service the app waits for — a third spelling, beside the
 * Procfile line and `supersonic.json` that the pipeline already reads.
 *
 * ## Every function here takes TEXT
 *
 * No disk, no YAML dependency, and no network — so the shapes can be checked
 * against real files from real repositories in a unit test, which is the only
 * way this stays honest as more spellings are added.
 *
 * ## Not understanding is the safe answer
 *
 * Every reader returns null when the file is not the shape it knows. Null means
 * "no release found", which is exactly today's behaviour; a WRONG command is a
 * blocked deploy, because a failed release stops the app coming up at all. That
 * asymmetry is why none of these guess.
 */

export interface FoundRelease {
  command: string;
  /** Where it came from, for a log line that lets a person disagree with us. */
  from: string;
}

/* -------------------------------------------------------------------------- */
/* compose                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Split a YAML block into its immediate children, by indentation.
 *
 * Deliberately not a YAML parser. It reads `key:` at one indentation level and
 * hands back the raw text beneath each, which is all the two lookups below need.
 * Anchors, flow mappings and block scalars are not understood and produce
 * nothing, which is the safe answer.
 */
function childBlocks(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const out = new Map<string, string>();
  let indent: number | null = null;
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n"));
    current = null;
    buf = [];
  };

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) {
      if (current !== null) buf.push(line);
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (indent === null) indent = lead;
    if (lead === indent) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*:\s*(.*)$/.exec(line);
      if (m) {
        flush();
        current = m[1];
        continue;
      }
      // Not a `key:` at this level — a list item, or something we do not read.
      flush();
      continue;
    }
    if (lead > indent && current !== null) buf.push(line);
    else if (lead < indent) flush();
  }
  flush();
  return out;
}

/** The value of `key:` directly inside a block, unquoted. Null when absent. */
function scalar(block: string, key: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`).exec(line);
    if (!m) continue;
    const v = m[1].replace(/\s+#.*$/, "").trim();
    if (!v || v === "|" || v === ">") return null;
    return v.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * The release a compose file declares.
 *
 * The evidence is `depends_on: { <name>: { condition:
 * service_completed_successfully } }` — one service waiting for another to FINISH
 * is compose's only way of saying "this runs once, first", and it is exactly how
 * the FastAPI template expresses its migrations:
 *
 *   prestart:
 *     command: bash scripts/prestart.sh
 *   backend:
 *     depends_on:
 *       prestart: { condition: service_completed_successfully }
 *
 * The named service must also have a `command`, and must be built from this
 * repository rather than pulled — a `postgres` image nobody waits on is not a
 * migration, and running someone else's entrypoint as this app's release is the
 * mistake this check exists to avoid.
 */
export function releaseFromCompose(text: string): FoundRelease | null {
  const top = childBlocks(text);
  const servicesBlock = top.get("services");
  if (!servicesBlock) return null;
  const services = childBlocks(servicesBlock);

  const awaited = new Set<string>();
  for (const [, block] of services) {
    const deps = childBlocks(block).get("depends_on");
    if (!deps) continue;
    for (const [name, depBlock] of childBlocks(deps)) {
      if (/service_completed_successfully/.test(depBlock)) awaited.add(name);
    }
  }

  for (const name of awaited) {
    const block = services.get(name);
    if (!block) continue;
    const command = scalar(block, "command");
    if (!command) continue;
    // Built here, not pulled. `build:` names a context; an `image:` with no
    // build is somebody else's container and its command is not our release.
    const own = /^\s*build\s*:/m.test(block);
    if (!own) continue;
    return { command, from: `compose (${name})` };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* PaaS manifests — each names the command outright                            */
/* -------------------------------------------------------------------------- */

/** `fly.toml`: `[deploy]` / `release_command = "..."`. */
export function releaseFromFlyToml(text: string): FoundRelease | null {
  let inDeploy = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inDeploy = section[1].trim() === "deploy";
      continue;
    }
    if (!inDeploy) continue;
    const m = /^\s*release_command\s*=\s*(.+?)\s*$/.exec(line);
    if (m) {
      const v = m[1].replace(/^["']|["']$/g, "").trim();
      if (v) return { command: v, from: "fly.toml" };
    }
  }
  return null;
}

/** `render.yaml`: `preDeployCommand:` on a service. */
export function releaseFromRenderYaml(text: string): FoundRelease | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*preDeployCommand\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
    if (v && v !== "|" && v !== ">") return { command: v, from: "render.yaml" };
  }
  return null;
}

/** `railway.json` / `railway.toml`, and Heroku's `app.json` postdeploy. */
export function releaseFromJsonManifest(text: string, file: string): FoundRelease | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const at = (path: string[]): unknown =>
    path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), doc);

  for (const path of [
    ["deploy", "preDeployCommand"],
    ["deploy", "releaseCommand"],
    ["scripts", "postdeploy"],
    ["scripts", "dokku", "predeploy"],
  ]) {
    const v = at(path);
    if (typeof v === "string" && v.trim()) return { command: v.trim(), from: `${file} (${path.join(".")})` };
  }
  return null;
}

/**
 * `package.json`, and only the scripts that MEAN a pre-serve step.
 *
 * `prestart` is npm's own: it runs before `start`, automatically, which is the
 * author saying "this happens first" in the one place node already listens.
 * `release` is Heroku's word. `migrate` and `db:migrate` are not read here —
 * they are things a person runs, not things a deploy was told to run, and
 * promoting one to a blocking step would fail deploys for repos that have always
 * worked.
 */
export function releaseFromPackageJson(text: string): FoundRelease | null {
  let doc: { scripts?: Record<string, string> };
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  for (const name of ["release", "prestart"]) {
    const v = doc.scripts?.[name];
    if (typeof v === "string" && v.trim()) return { command: `npm run ${name}`, from: `package.json (${name})` };
  }
  return null;
}

/* -------------------------------------------------------------------------- */

/** The files this looks at, in the order their answers are trusted. */
export const RELEASE_FILES = [
  "fly.toml",
  "render.yaml",
  "render.yml",
  "railway.json",
  "app.json",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "package.json",
] as const;

/**
 * The release step this repository declares, or null.
 *
 * `files` maps a name from RELEASE_FILES to its contents; anything missing is
 * simply absent. Order is authority: a manifest written for a platform names the
 * command on purpose, compose names it structurally, and package.json's
 * `prestart` is the weakest because it is also the most incidental.
 */
export function detectRelease(files: Record<string, string | undefined>): FoundRelease | null {
  const read = (n: string) => files[n];
  const tries: [string | undefined, (t: string) => FoundRelease | null][] = [
    [read("fly.toml"), releaseFromFlyToml],
    [read("render.yaml") ?? read("render.yml"), releaseFromRenderYaml],
    [read("railway.json"), (t) => releaseFromJsonManifest(t, "railway.json")],
    [read("app.json"), (t) => releaseFromJsonManifest(t, "app.json")],
    [
      read("compose.yml") ?? read("compose.yaml") ?? read("docker-compose.yml") ?? read("docker-compose.yaml"),
      releaseFromCompose,
    ],
    [read("package.json"), releaseFromPackageJson],
  ];
  for (const [text, reader] of tries) {
    if (!text) continue;
    const found = reader(text);
    if (found) return found;
  }
  return null;
}
